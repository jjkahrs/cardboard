/**
 * Hand-written Zod mirrors of every type in TECHNICAL_DESIGN.md §4, plus the four import gates
 * (§7.2) as pure functions. Nothing here touches a store and nothing here throws except
 * `exportJson`, which is only ever handed an already-valid definition.
 *
 * KEY ORDER IS LOAD-BEARING. Zod builds its output by iterating its own shape keys, so the
 * declaration order below *is* the export key order (§7.1). Keys are declared in exactly the order
 * §4 lists them, `schemaVersion` first. Objects use zod's default `.strip()` so unknown keys are
 * dropped; `| null` fields use `.nullable()`, never `.optional()` — an `.optional()` there turns
 * `null` into an absent key and only fails on the *second* round trip (§9.3).
 */

import { z } from 'zod';
import { ACTIVE_PLAYER_POOL_ID, SCHEMA_VERSION } from './types';
import type {
  ActionSelector,
  CriteriaNode,
  Effect,
  GameDefinition,
  SeatRef,
  TargetSelector,
  ZoneRef,
} from './types';

// ---------------------------------------------------------------------------
// v2 §4.5 — every Effect kind, for RuleSet.replaces.effectKind (Effect['kind'], not narrowed to the
// five replaceable ones — §5.7's restriction is semantic and lives in the superRefine below).
// Kept in sync with the Effect union by SCHEMA_MATCHES_TYPES at the bottom of this file: an entry
// missing or extra here fails that assertion at compile time rather than drifting silently.
// ---------------------------------------------------------------------------

const EFFECT_KINDS = [
  'moveCards',
  'drawCards',
  'shuffleZone',
  'changePool',
  'setCardIndex',
  'flipCard',
  'rotateCard',
  'createCard',
  'destroyCards',
  'fireEvent',
  'forceTransition',
  'eliminateSeat',
  'setTag',
  'attach',
  'detach',
  'setController',
  'announceAction',
  'counterAction',
  'openPriority',
  'sealedChoice',
  'chooseMode',
  'chooseNumber',
] as const;

const EffectKindSchema = z.enum(EFFECT_KINDS);

/** §5.7 — only these five effect kinds can meaningfully be intercepted by a replacement rule. */
const REPLACEABLE_EFFECT_KINDS = new Set<Effect['kind']>([
  'drawCards',
  'changePool',
  'moveCards',
  'destroyCards',
  'setCardIndex',
]);

// ---------------------------------------------------------------------------
// §4.1 Primitives and values
// ---------------------------------------------------------------------------

const IdSchema = z.string();
const IconIdSchema = z.string();

/**
 * Discriminated on `type`. The min <= max rule lives in a `superRefine` on the union rather than on
 * the integer member, because zod v3's `discriminatedUnion` only accepts ZodObject members and
 * `.superRefine` would turn that member into a ZodEffects.
 */
export const GameValueSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('integer'),
      name: z.string(),
      defaultValue: z.number().int(),
      min: z.number().int().nullable(),
      max: z.number().int().nullable(),
    }),
    z.object({
      type: z.literal('boolean'),
      name: z.string(),
      defaultValue: z.boolean(),
    }),
  ])
  .superRefine((v, ctx) => {
    if (v.type === 'integer' && v.min !== null && v.max !== null && v.min > v.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min'],
        message: `min (${v.min}) must be less than or equal to max (${v.max})`,
      });
    }
  });

export const PointPoolSchema = z.object({
  id: IdSchema,
  scope: z.enum(['game', 'player']),
  value: GameValueSchema,
});

// ---------------------------------------------------------------------------
// §4.2 Seat and value references
// ---------------------------------------------------------------------------

/**
 * `relative.from` is a SeatRef, so this is recursive — same `z.lazy` + explicit annotation
 * rationale as CriteriaNode and TargetSelector. `offset` is `.int()`: a fractional offset can only
 * come from a hand-edited file, and `resolveSeat` re-checks it at runtime for exactly that path.
 *
 * `owner`/`controller` make the recursion MUTUAL as of §4.1: SeatRef -> CardRef -> ZoneRef ->
 * SeatRef. The explicit annotation here is what breaks the inference cycle for all three, so
 * `CardRefSchema` and `ZoneRefSchema` below still infer normally; the forward reference to
 * `CardRefSchema` is deferred with `z.lazy` because it is declared after this.
 */
export const SeatRefSchema: z.ZodType<SeatRef, z.ZodTypeDef, SeatRef> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('active') }),
  z.object({ kind: z.literal('next') }),
  z.object({ kind: z.literal('previous') }),
  z.object({ kind: z.literal('triggeringSeat') }),
  z.object({ kind: z.literal('seat'), index: z.number().int() }),
  z.object({
    kind: z.literal('relative'),
    from: z.lazy(() => SeatRefSchema),
    offset: z.number().int(),
  }),
  z.object({ kind: z.literal('owner'), card: z.lazy(() => CardRefSchema) }),
  z.object({ kind: z.literal('controller'), card: z.lazy(() => CardRefSchema) }),
  /** §4.1's `sum` is admitted by SHAPE here; `checkValueRef` below is what refuses it over a
   *  boolean pool, because only the referential-integrity pass knows a pool's declared type. */
  z.object({ kind: z.literal('all'), quantifier: z.enum(['every', 'some', 'sum']).optional() }),
]);

export const ZoneRefSchema = z.object({
  zoneId: IdSchema,
  seat: SeatRefSchema.nullable(),
});

export const CardRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('triggering') }),
  z.object({ kind: z.literal('zoneTop'), zone: ZoneRefSchema }),
  z.object({ kind: z.literal('promptAnswer'), promptId: z.string(), ordinal: z.number().int() }),
  z.object({ kind: z.literal('instance'), id: IdSchema }),
  /** §4.2 — resolved off `TriggerContext.sourceCardId` at runtime; carries no authored id. */
  z.object({ kind: z.literal('host') }),
  /** §4.4 — bound per candidate inside a `matching` selector; carries no authored id either. That
   *  it is legal SHAPE anywhere a CardRef is legal is deliberate: nothing here knows whether a
   *  criterion is a `where`, and the runtime already refuses it as an unbound ref elsewhere. */
  z.object({ kind: z.literal('candidate') }),
  /** v2 §4.2, §5.7 — bound only inside a replacement rule's `replaces.match`; carries no id. */
  z.object({ kind: z.literal('replacedTarget') }),
]);

/**
 * v2 §4.2 — no self-reference (`{kind:'action', id}` names a runtime id, not a nested ActionRef),
 * so unlike SeatRef/CardRef/ZoneRef this needs no `z.lazy`.
 */
export const ActionRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('triggeringAction') }),
  z.object({ kind: z.literal('topOfStack') }),
  z.object({ kind: z.literal('action'), id: IdSchema }),
]);

export const ValueRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.union([z.number(), z.boolean()]) }),
  z.object({ kind: z.literal('pool'), poolId: IdSchema, seat: SeatRefSchema.nullable() }),
  z.object({ kind: z.literal('cardIndex'), card: CardRefSchema, indexId: IdSchema }),
  z.object({ kind: z.literal('zoneCount'), zone: ZoneRefSchema }),
  /** §4.2 — boolean. `tag` is free-form like `fireEvent.name`: tags are declared nowhere. */
  z.object({ kind: z.literal('cardTag'), card: CardRefSchema, tag: z.string() }),
  z.object({ kind: z.literal('activeSeatCount') }),
  /** v2 §4.2, §5.7 — bound only inside a replacement rule's `replaces.match`; carries no id. */
  z.object({ kind: z.literal('replacedAmount') }),
  z.object({
    kind: z.literal('actionField'),
    action: ActionRefSchema,
    field: z.enum(['controller', 'targetCount']),
  }),
  /** v2 §4.2, §8 step 28 — the `chooseNumber` design-slip closure; `key` names nothing declared. */
  z.object({ kind: z.literal('promptNumber'), key: z.string() }),
]);

// ---------------------------------------------------------------------------
// §4.3 Criteria
// ---------------------------------------------------------------------------

const ComparisonOpSchema = z.enum(['=', '!=', '>', '<', '>=', '<=']);

const GameCriteriaSchema = z.object({
  kind: z.literal('criteria'),
  left: ValueRefSchema,
  op: ComparisonOpSchema,
  right: ValueRefSchema,
});

const CriteriaGroupSchema = z.object({
  kind: z.literal('group'),
  combinator: z.enum(['and', 'or']),
  children: z.lazy(() => z.array(CriteriaNodeSchema)),
});

/**
 * Recursive, so the explicit `z.ZodType` annotation is mandatory — TypeScript cannot infer a type
 * that references itself. This is the one place `z.infer` equals the hand-written type by
 * declaration rather than by derivation; the annotation still checks that the schema below
 * produces something assignable to `CriteriaNode` in both directions.
 */
export const CriteriaNodeSchema: z.ZodType<CriteriaNode, z.ZodTypeDef, CriteriaNode> =
  z.discriminatedUnion('kind', [GameCriteriaSchema, CriteriaGroupSchema]);

// ---------------------------------------------------------------------------
// §4.4 Cards
// ---------------------------------------------------------------------------

export const CardIndexSchema = z.object({
  id: IdSchema,
  value: GameValueSchema,
  icon: IconIdSchema,
  position: z.enum(['topLeft', 'topRight', 'bottomLeft', 'bottomRight']),
});

export const CardTemplateSchema = z.object({
  id: IdSchema,
  name: z.string(),
  marquee: z.string(),
  faceIcon: IconIdSchema,
  borderColor: z.string(),
  tags: z.array(z.string()),
  indexes: z.array(CardIndexSchema),
  ruleSetIds: z.array(IdSchema),
  rulesTextOverride: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// §4.5 Zones and decks
// ---------------------------------------------------------------------------

export const PlayZoneSchema = z.object({
  id: IdSchema,
  name: z.string(),
  scope: z.enum(['shared', 'player']),
  visibility: z.enum(['faceUp', 'faceDown', 'ownerOnly']),
  layout: z.enum(['stack', 'fan', 'row', 'grid']),
  ordered: z.boolean(),
  /** §9.4 item 15: 0 and negatives are an unusable zone, so they are rejected here. */
  maxCapacity: z.number().int().min(1).nullable(),
});

export const DeckSchema = z.object({
  id: IdSchema,
  name: z.string(),
  zoneId: IdSchema,
  entries: z.array(z.object({ templateId: IdSchema, quantity: z.number().int() })),
});

// ---------------------------------------------------------------------------
// §4.7 Effects, targeting, rules
// ---------------------------------------------------------------------------

const InsertPositionSchema = z.union([
  z.literal('top'),
  z.literal('bottom'),
  z.object({ kind: z.literal('index'), index: z.number().int() }),
]);

const NumericOpSchema = z.enum(['add', 'subtract', 'set']);

/** `prompt` wraps another selector, so this is recursive — same annotation rationale as CriteriaNode. */
export const TargetSelectorSchema: z.ZodType<TargetSelector, z.ZodTypeDef, TargetSelector> =
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('triggeringCard') }),
    z.object({ kind: z.literal('topOfZone'), zone: ZoneRefSchema, count: ValueRefSchema }),
    z.object({ kind: z.literal('bottomOfZone'), zone: ZoneRefSchema, count: ValueRefSchema }),
    z.object({ kind: z.literal('allInZone'), zone: ZoneRefSchema }),
    z.object({ kind: z.literal('taggedInZone'), zone: ZoneRefSchema, tag: z.string() }),
    z.object({
      kind: z.literal('prompt'),
      from: z.lazy(() => TargetSelectorSchema),
      count: ValueRefSchema,
      promptText: z.string(),
    }),
    /** §4.4 — the attachment relation, both directions. Neither names a zone. */
    z.object({ kind: z.literal('attachedTo'), host: CardRefSchema }),
    z.object({ kind: z.literal('hostOf'), card: CardRefSchema }),
    /** §4.4 — predicate targeting. Recursive through `from` exactly as `prompt` is, hence the
     *  second `z.lazy` the explicit annotation above exists to permit. */
    z.object({
      kind: z.literal('matching'),
      from: z.lazy(() => TargetSelectorSchema),
      where: CriteriaNodeSchema,
    }),
  ]);

export const ChoiceOptionSchema = z.object({ id: z.string(), label: z.string() });

/**
 * v2 §4.5 — `effects: Effect[]` makes this mutually recursive with `EffectSchema` (a `chooseMode`
 * effect holds `ChoiceMode[]`, each of which holds `Effect[]`). `EffectSchema` is declared AFTER
 * this, so the forward reference is deferred with `z.lazy` — same pattern `SeatRefSchema` already
 * uses for its forward reference to `CardRefSchema`.
 */
export const ChoiceModeSchema = z.object({
  label: z.string(),
  effects: z.lazy(() => z.array(EffectSchema)),
});

/** v2 §4.4 — pending actions are selected separately from cards; no self-reference, no `z.lazy`. */
export const ActionSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('action'), ref: ActionRefSchema }),
  z.object({ kind: z.literal('allOnStack'), where: CriteriaNodeSchema.nullable() }),
]);

/**
 * v2 §4.5 — `chooseMode` makes `Effect` self-referential through `ChoiceMode` above, so this now
 * needs the same explicit `z.ZodType` annotation `CriteriaNodeSchema`/`TargetSelectorSchema` use.
 */
export const EffectSchema: z.ZodType<Effect, z.ZodTypeDef, Effect> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('moveCards'),
    target: TargetSelectorSchema,
    to: ZoneRefSchema,
    position: InsertPositionSchema,
  }),
  z.object({
    kind: z.literal('drawCards'),
    from: ZoneRefSchema,
    to: ZoneRefSchema,
    count: ValueRefSchema,
  }),
  z.object({ kind: z.literal('shuffleZone'), zone: ZoneRefSchema }),
  z.object({
    kind: z.literal('changePool'),
    poolId: IdSchema,
    seat: SeatRefSchema.nullable(),
    op: NumericOpSchema,
    amount: ValueRefSchema,
  }),
  z.object({
    kind: z.literal('setCardIndex'),
    target: TargetSelectorSchema,
    indexId: IdSchema,
    op: NumericOpSchema,
    amount: ValueRefSchema,
  }),
  z.object({
    kind: z.literal('flipCard'),
    target: TargetSelectorSchema,
    to: z.enum(['faceUp', 'faceDown', 'toggle']),
  }),
  z.object({
    kind: z.literal('rotateCard'),
    target: TargetSelectorSchema,
    to: z.enum(['rotated', 'upright', 'toggle']),
  }),
  z.object({
    kind: z.literal('createCard'),
    templateId: IdSchema,
    zone: ZoneRefSchema,
    position: InsertPositionSchema,
    count: ValueRefSchema,
  }),
  z.object({ kind: z.literal('destroyCards'), target: TargetSelectorSchema }),
  z.object({ kind: z.literal('fireEvent'), name: z.string() }),
  z.object({ kind: z.literal('forceTransition'), toStateId: IdSchema }),
  z.object({ kind: z.literal('eliminateSeat'), seat: SeatRefSchema }),
  z.object({ kind: z.literal('attach'), target: TargetSelectorSchema, host: CardRefSchema }),
  z.object({ kind: z.literal('detach'), target: TargetSelectorSchema }),
  z.object({
    kind: z.literal('setTag'),
    target: TargetSelectorSchema,
    tag: z.string(),
    on: z.boolean(),
  }),
  z.object({
    kind: z.literal('setController'),
    target: TargetSelectorSchema,
    /** null clears the override back to zone-derived control (§4.3). */
    seat: SeatRefSchema.nullable(),
  }),
  z.object({ kind: z.literal('announceAction'), ruleId: IdSchema, window: IdSchema.nullable() }),
  z.object({ kind: z.literal('counterAction'), action: ActionSelectorSchema }),
  z.object({ kind: z.literal('openPriority'), window: IdSchema }),
  z.object({
    kind: z.literal('sealedChoice'),
    choiceId: z.string(),
    seats: SeatRefSchema,
    options: z.array(ChoiceOptionSchema),
  }),
  z.object({
    kind: z.literal('chooseMode'),
    promptText: z.string(),
    seat: SeatRefSchema,
    modes: z.array(ChoiceModeSchema),
  }),
  z.object({
    kind: z.literal('chooseNumber'),
    promptText: z.string(),
    seat: SeatRefSchema,
    min: ValueRefSchema,
    max: ValueRefSchema,
    key: z.string(),
  }),
]);

/** §5.8's refinement — true (with a reason) if `selector` is, or wraps, a `prompt` at any depth. */
function selectorSuspends(s: TargetSelector): boolean {
  if (s.kind === 'prompt') return true;
  if (s.kind === 'matching') return selectorSuspends(s.from);
  return false;
}

/**
 * §5.8's refinement — the reason a cost effect would suspend the transaction, or `null` if it
 * cannot. The four listed kinds always suspend; every other kind suspends only via a `prompt`
 * TargetSelector reachable through its `target`.
 */
function costEffectSuspends(e: Effect): string | null {
  if (
    e.kind === 'chooseMode' ||
    e.kind === 'chooseNumber' ||
    e.kind === 'sealedChoice' ||
    e.kind === 'openPriority'
  ) {
    return `it is a "${e.kind}" effect`;
  }
  if ('target' in e && selectorSuspends(e.target)) {
    return 'its target selector contains a prompt';
  }
  return null;
}

export const RuleSetSchema = z.object({
  id: IdSchema,
  name: z.string(),
  /** `EventName` is `BuiltinEvent | (string & {})` — any string, autocomplete only. */
  trigger: z.string(),
  stateFilter: IdSchema.nullable(),
  condition: CriteriaNodeSchema.nullable(),
  effects: z.array(EffectSchema),
  priority: z.number(),
  onRejection: z.enum(['continue', 'abort']),
  /** §4.5, §5.4. `.nullable()` and PRESENT — see §7.2 and the note on `limits` below. */
  modifier: z
    .object({
      scope: TargetSelectorSchema,
      indexId: IdSchema,
      op: z.enum(['set', 'adjust']),
      amount: ValueRefSchema,
      activeZones: z.array(IdSchema),
    })
    .nullable(),
  /** v2 §4.5, §5.6. `.nullable()`-and-PRESENT siblings below share its §7.2 rationale. */
  continuous: z.boolean(),
  /** v2 §4.5, §5.7. */
  replaces: z
    .object({
      effectKind: EffectKindSchema,
      match: CriteriaNodeSchema.nullable(),
    })
    .nullable(),
  /** v2 §4.5, §5.8. */
  activation: z
    .object({
      costCheck: CriteriaNodeSchema.nullable(),
      cost: z.array(EffectSchema),
      window: IdSchema.nullable(),
      perInstance: z.boolean(),
      label: z.string(),
    })
    .nullable(),
}).superRefine((rs, ctx) => {
  // §4.5 — a rule may be at most one of: continuous, modifier, replaces, activation. Simultaneously
  // a trigger, a modifier and a replacement has no defensible evaluation order.
  const modeCount = [rs.continuous, rs.modifier !== null, rs.replaces !== null, rs.activation !== null]
    .filter(Boolean).length;
  if (modeCount > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['continuous'],
      message:
        'A RuleSet may be at most one of: continuous, modifier, replaces, activation — pick one.',
    });
  }

  // §5.7 — only these five kinds are meaningfully interceptable.
  if (rs.replaces !== null && !REPLACEABLE_EFFECT_KINDS.has(rs.replaces.effectKind)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['replaces', 'effectKind'],
      message: `"${rs.replaces.effectKind}" cannot be replaced; only ${[...REPLACEABLE_EFFECT_KINDS].join(', ')} are interceptable (§5.7).`,
    });
  }

  // §5.8 — a cost effect may not suspend: no chooseMode/chooseNumber/sealedChoice/openPriority, and
  // no `prompt` TargetSelector at any depth (a prompt nested inside a `matching`'s `from` counts).
  // Suspending commits the transaction, which publishes the half-applied cost, and the discard
  // model this activation relies on can then never discard it.
  if (rs.activation !== null) {
    rs.activation.cost.forEach((effect, i) => {
      const suspending = costEffectSuspends(effect);
      if (suspending) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['activation', 'cost', i],
          message: `Cost effect ${i} (${effect.kind}) may suspend (${suspending}) — a cost effect must not raise an Interaction (§5.8).`,
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// v2 §4.6 Priority windows
// ---------------------------------------------------------------------------

export const PriorityWindowSchema = z.object({
  id: IdSchema,
  name: z.string(),
  start: z.enum(['active', 'triggeringSeat', 'controllerOfAction']),
  direction: z.enum(['forward', 'backward']),
  includeStart: z.boolean(),
  passesToClose: z.number().int().nullable(),
  collapseEmptyOffers: z.literal(true),
});

// ---------------------------------------------------------------------------
// §4.8 State machine
// ---------------------------------------------------------------------------

export const MachineStateSchema = z.object({
  id: IdSchema,
  name: z.string(),
  enterableFrom: z.array(IdSchema),
  exitableTo: z.array(IdSchema),
  entryCriteria: CriteriaNodeSchema.nullable(),
  transitionLabel: z.string().nullable(),
  priority: z.number(),
  position: z.object({ x: z.number(), y: z.number() }),
});

export const StateMachineSchema = z.object({
  states: z.array(MachineStateSchema),
  startStateId: IdSchema,
  endStateId: IdSchema,
});

// ---------------------------------------------------------------------------
// §4.9 The export root — shape only. Referential integrity is gate 4, below.
// ---------------------------------------------------------------------------

const GameDefinitionShape = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: IdSchema,
  name: z.string(),
  playerCount: z.number().int().min(1),
  pools: z.array(PointPoolSchema),
  zones: z.array(PlayZoneSchema),
  templates: z.array(CardTemplateSchema),
  decks: z.array(DeckSchema),
  customEvents: z.array(z.string()),
  ruleSets: z.array(RuleSetSchema),
  globalRuleSetIds: z.array(IdSchema),
  /** v2 §4.6, §4.11 — key order is the export contract (§7.2): after globalRuleSetIds, before machine. */
  priorityWindows: z.array(PriorityWindowSchema),
  machine: StateMachineSchema,
  /** §7.2: all four keys are PRESENT, never `.optional()` — an absent key only fails on the
   *  second round trip. */
  limits: z.object({
    maxDepth: z.number().int(),
    maxEffects: z.number().int(),
    maxSettleIterations: z.number().int(),
    maxPriorityRounds: z.number().int(),
  }),
  /** ISO, but never re-derived here — import must not write it (§4.9). Plain string on purpose. */
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Gate 4 — referential integrity (§7.2)
// ---------------------------------------------------------------------------

type Path = (string | number)[];

interface Refs {
  ctx: z.RefinementCtx;
  zones: Set<string>;
  pools: Set<string>;
  /** The subset of `pools` declared `type: 'boolean'`. Only §4.1's `sum` refinement reads it. */
  booleanPools: Set<string>;
  templates: Set<string>;
  /** Union of every template's index ids. Indexes are per-template, but an effect's `indexId` is
   *  not statically bound to a template, so a global set is the only check available here. */
  indexes: Set<string>;
  ruleSets: Set<string>;
  states: Set<string>;
  priorityWindows: Set<string>;
}

function bad(r: Refs, path: Path, message: string): void {
  r.ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function known(r: Refs, set: Set<string>, id: string, path: Path, label: string): void {
  if (!set.has(id)) bad(r, path, `Unknown ${label} id "${id}"`);
}

/**
 * §4.1 made `SeatRef` the first ref that can carry an authored id: `owner`/`controller` hold a
 * `CardRef`, which can hold a `ZoneRef`. Gate 4 has to descend into it or a zone deleted from under
 * `SeatRef{kind:'owner'}.card.zone` imports cleanly and fails as a runtime MISSING_REFERENT later.
 */
function checkSeatRef(ref: SeatRef, p: Path, r: Refs): void {
  switch (ref.kind) {
    case 'owner':
    case 'controller':
      checkCardRef(ref.card, [...p, 'card'], r);
      break;
    case 'relative':
      checkSeatRef(ref.from, [...p, 'from'], r);
      break;
    default:
      // active / next / previous / triggeringSeat / seat / all carry no id.
      break;
  }
}

function checkZoneRef(ref: ZoneRef, p: Path, r: Refs): void {
  known(r, r.zones, ref.zoneId, [...p, 'zoneId'], 'zone');
  if (ref.seat !== null) checkSeatRef(ref.seat, [...p, 'seat'], r);
}

function checkCardRef(ref: z.infer<typeof CardRefSchema>, p: Path, r: Refs): void {
  if (ref.kind === 'zoneTop') checkZoneRef(ref.zone, [...p, 'zone'], r);
}

function checkValueRef(v: z.infer<typeof ValueRefSchema>, p: Path, r: Refs): void {
  switch (v.kind) {
    case 'pool':
      known(r, r.pools, v.poolId, [...p, 'poolId'], 'pool');
      // §4.1: `sum` is an arithmetic total, so it is legal only where the ref is consumed as a
      // number. A boolean pool has no total. This is the author-time half of the pair — the
      // runtime half lives in `resolveValueRef` and covers imported JSON that never met the editor.
      if (v.seat !== null) checkSeatRef(v.seat, [...p, 'seat'], r);
      if (v.seat?.kind === 'all' && v.seat.quantifier === 'sum' && r.booleanPools.has(v.poolId)) {
        bad(
          r,
          [...p, 'seat', 'quantifier'],
          `Pool "${v.poolId}" is a boolean; the "sum" quantifier needs a numeric pool`
        );
      }
      break;
    case 'cardIndex':
      checkCardRef(v.card, [...p, 'card'], r);
      known(r, r.indexes, v.indexId, [...p, 'indexId'], 'card index');
      break;
    case 'zoneCount':
      checkZoneRef(v.zone, [...p, 'zone'], r);
      break;
    // `tag` names nothing declared (§4.3 — tags are free-form strings), but the CardRef it reads
    // from can still carry a ZoneRef that was deleted from under it.
    case 'cardTag':
      checkCardRef(v.card, [...p, 'card'], r);
      break;
    case 'literal':
    case 'activeSeatCount':
      break;
  }
}

function checkCriteria(n: CriteriaNode, p: Path, r: Refs): void {
  if (n.kind === 'group') {
    n.children.forEach((c, i) => checkCriteria(c, [...p, 'children', i], r));
    return;
  }
  checkValueRef(n.left, [...p, 'left'], r);
  checkValueRef(n.right, [...p, 'right'], r);
}

function checkSelector(s: TargetSelector, p: Path, r: Refs): void {
  switch (s.kind) {
    case 'topOfZone':
    case 'bottomOfZone':
      checkZoneRef(s.zone, [...p, 'zone'], r);
      checkValueRef(s.count, [...p, 'count'], r);
      break;
    case 'allInZone':
    case 'taggedInZone':
      checkZoneRef(s.zone, [...p, 'zone'], r);
      break;
    case 'prompt':
      checkSelector(s.from, [...p, 'from'], r);
      checkValueRef(s.count, [...p, 'count'], r);
      break;
    // No zone of their own, but the CardRef inside can still carry one that was deleted.
    case 'attachedTo':
      checkCardRef(s.host, [...p, 'host'], r);
      break;
    case 'hostOf':
      checkCardRef(s.card, [...p, 'card'], r);
      break;
    // §4.4 — the `where` is a full CriteriaNode, so a card index deleted out from under it dangles
    // exactly like one in a rule's `condition` does. Descending costs one line and the importer
    // would otherwise pass a definition the resolver cannot evaluate.
    case 'matching':
      checkSelector(s.from, [...p, 'from'], r);
      checkCriteria(s.where, [...p, 'where'], r);
      break;
    case 'triggeringCard':
      break;
  }
}

function checkEffect(e: Effect, p: Path, r: Refs): void {
  switch (e.kind) {
    case 'moveCards':
      checkSelector(e.target, [...p, 'target'], r);
      checkZoneRef(e.to, [...p, 'to'], r);
      break;
    case 'drawCards':
      checkZoneRef(e.from, [...p, 'from'], r);
      checkZoneRef(e.to, [...p, 'to'], r);
      checkValueRef(e.count, [...p, 'count'], r);
      break;
    case 'shuffleZone':
      checkZoneRef(e.zone, [...p, 'zone'], r);
      break;
    case 'changePool':
      known(r, r.pools, e.poolId, [...p, 'poolId'], 'pool');
      if (e.seat !== null) checkSeatRef(e.seat, [...p, 'seat'], r);
      checkValueRef(e.amount, [...p, 'amount'], r);
      break;
    case 'setController':
      checkSelector(e.target, [...p, 'target'], r);
      if (e.seat !== null) checkSeatRef(e.seat, [...p, 'seat'], r);
      break;
    case 'setCardIndex':
      checkSelector(e.target, [...p, 'target'], r);
      known(r, r.indexes, e.indexId, [...p, 'indexId'], 'card index');
      checkValueRef(e.amount, [...p, 'amount'], r);
      break;
    case 'flipCard':
    case 'rotateCard':
    case 'destroyCards':
    case 'setTag':
    case 'detach':
      checkSelector(e.target, [...p, 'target'], r);
      break;
    case 'attach':
      checkSelector(e.target, [...p, 'target'], r);
      checkCardRef(e.host, [...p, 'host'], r);
      break;
    case 'createCard':
      known(r, r.templates, e.templateId, [...p, 'templateId'], 'template');
      checkZoneRef(e.zone, [...p, 'zone'], r);
      checkValueRef(e.count, [...p, 'count'], r);
      break;
    case 'forceTransition':
      known(r, r.states, e.toStateId, [...p, 'toStateId'], 'state');
      break;
    // `fireEvent.name` is free-form by design (§4.6) — custom events need no declaration.
    case 'fireEvent':
      break;
    case 'eliminateSeat':
      checkSeatRef(e.seat, [...p, 'seat'], r);
      break;
    // §4.5 — the only effect carrying two authored ids at once.
    case 'announceAction':
      known(r, r.ruleSets, e.ruleId, [...p, 'ruleId'], 'rule set');
      if (e.window !== null) {
        known(r, r.priorityWindows, e.window, [...p, 'window'], 'priority window');
      }
      break;
    case 'counterAction':
      checkActionSelector(e.action, [...p, 'action'], r);
      break;
    case 'openPriority':
      known(r, r.priorityWindows, e.window, [...p, 'window'], 'priority window');
      break;
    // `choiceId`/`key`/option ids and labels name nothing declared — they are free-form like
    // `fireEvent.name` (§4.6). Only the seat refs and the nested effects can dangle.
    case 'sealedChoice':
      checkSeatRef(e.seats, [...p, 'seats'], r);
      break;
    case 'chooseMode':
      checkSeatRef(e.seat, [...p, 'seat'], r);
      e.modes.forEach((m, i) =>
        m.effects.forEach((inner, j) => checkEffect(inner, [...p, 'modes', i, 'effects', j], r))
      );
      break;
    case 'chooseNumber':
      checkSeatRef(e.seat, [...p, 'seat'], r);
      checkValueRef(e.min, [...p, 'min'], r);
      checkValueRef(e.max, [...p, 'max'], r);
      break;
  }
}

/**
 * §4.4. An `ActionRef` addresses a PendingAction, whose ids are minted at runtime (`a${nextSeq}`)
 * and so name nothing in the definition — but `allOnStack.where` is a full CriteriaNode and dangles
 * exactly like a rule's `condition` does.
 */
function checkActionSelector(s: ActionSelector, p: Path, r: Refs): void {
  if (s.kind === 'allOnStack' && s.where !== null) checkCriteria(s.where, [...p, 'where'], r);
}

function checkReferences(d: GameDefinition, ctx: z.RefinementCtx): void {
  const r: Refs = {
    ctx,
    zones: new Set(d.zones.map((z) => z.id)),
    // The reserved `activePlayer` pool is never in `d.pools` (§4.1 — it must not appear in an
    // export), but setup.ts seeds it and authored effects are its only legal writers. Omitting it
    // here rejects every definition that authors turn structure the documented way.
    pools: new Set([ACTIVE_PLAYER_POOL_ID, ...d.pools.map((p) => p.id)]),
    booleanPools: new Set(d.pools.filter((p) => p.value.type === 'boolean').map((p) => p.id)),
    templates: new Set(d.templates.map((t) => t.id)),
    indexes: new Set(d.templates.flatMap((t) => t.indexes.map((i) => i.id))),
    ruleSets: new Set(d.ruleSets.map((s) => s.id)),
    states: new Set(d.machine.states.map((s) => s.id)),
    priorityWindows: new Set(d.priorityWindows.map((w) => w.id)),
  };

  const seenNames = new Set<string>();
  d.zones.forEach((z, i) => {
    if (seenNames.has(z.name)) {
      bad(r, ['zones', i, 'name'], `Zone names must be unique; "${z.name}" is used more than once`);
    }
    seenNames.add(z.name);
  });

  d.templates.forEach((t, i) => {
    t.ruleSetIds.forEach((id, j) => {
      known(r, r.ruleSets, id, ['templates', i, 'ruleSetIds', j], 'rule set');
    });
  });

  d.decks.forEach((deck, i) => {
    known(r, r.zones, deck.zoneId, ['decks', i, 'zoneId'], 'zone');
    deck.entries.forEach((e, j) => {
      known(r, r.templates, e.templateId, ['decks', i, 'entries', j, 'templateId'], 'template');
    });
  });

  d.ruleSets.forEach((rs, i) => {
    if (rs.stateFilter !== null) {
      known(r, r.states, rs.stateFilter, ['ruleSets', i, 'stateFilter'], 'state');
    }
    if (rs.condition !== null) checkCriteria(rs.condition, ['ruleSets', i, 'condition'], r);
    rs.effects.forEach((e, j) => checkEffect(e, ['ruleSets', i, 'effects', j], r));

    // §4.5's four sub-trees. `modifier` has been unchecked here since step 13 — the walker sees it
    // (delete-protection works), but gate 4 did not, so imported JSON could dangle a scope zone or a
    // deleted index and only fail later as a runtime MISSING_REFERENT.
    if (rs.modifier !== null) {
      const m: Path = ['ruleSets', i, 'modifier'];
      checkSelector(rs.modifier.scope, [...m, 'scope'], r);
      known(r, r.indexes, rs.modifier.indexId, [...m, 'indexId'], 'card index');
      checkValueRef(rs.modifier.amount, [...m, 'amount'], r);
      rs.modifier.activeZones.forEach((z, j) => known(r, r.zones, z, [...m, 'activeZones', j], 'zone'));
    }
    if (rs.replaces !== null && rs.replaces.match !== null) {
      checkCriteria(rs.replaces.match, ['ruleSets', i, 'replaces', 'match'], r);
    }
    if (rs.activation !== null) {
      const a: Path = ['ruleSets', i, 'activation'];
      if (rs.activation.costCheck !== null) checkCriteria(rs.activation.costCheck, [...a, 'costCheck'], r);
      rs.activation.cost.forEach((e, j) => checkEffect(e, [...a, 'cost', j], r));
      if (rs.activation.window !== null) {
        known(r, r.priorityWindows, rs.activation.window, [...a, 'window'], 'priority window');
      }
    }
  });

  d.globalRuleSetIds.forEach((id, i) => {
    known(r, r.ruleSets, id, ['globalRuleSetIds', i], 'rule set');
  });

  known(r, r.states, d.machine.startStateId, ['machine', 'startStateId'], 'state');
  known(r, r.states, d.machine.endStateId, ['machine', 'endStateId'], 'state');

  // §5.6 author-time: `Start` has empty `enterableFrom`; `End` has empty `exitableTo`. The second is
  // load-bearing at RUNTIME too — a non-empty End.exitableTo lets a queued transition leave a
  // finished session and fire `onGameEnd` twice.
  // §5.6's other two checks ("End unreachable", "no inbound edge other than Start") are WARNINGS,
  // and belong to the authoring panels: validateDefinition has no warning channel.
  const startIndex = d.machine.states.findIndex((s) => s.id === d.machine.startStateId);
  if (startIndex >= 0 && d.machine.states[startIndex].enterableFrom.length > 0) {
    bad(r, ['machine', 'states', startIndex, 'enterableFrom'], `Start state "${d.machine.startStateId}" must have an empty enterableFrom.`);
  }
  const endIndex = d.machine.states.findIndex((s) => s.id === d.machine.endStateId);
  if (endIndex >= 0 && d.machine.states[endIndex].exitableTo.length > 0) {
    bad(r, ['machine', 'states', endIndex, 'exitableTo'], `End state "${d.machine.endStateId}" must have an empty exitableTo.`);
  }

  const byId = new Map(d.machine.states.map((s) => [s.id, s]));
  d.machine.states.forEach((s, i) => {
    if (s.entryCriteria !== null) {
      checkCriteria(s.entryCriteria, ['machine', 'states', i, 'entryCriteria'], r);
    }
    // A→B is legal iff B.enterableFrom has A AND A.exitableTo has B (§4.8). Report each one-sided
    // edge from the side that declares it, naming both states and the side that is missing.
    s.enterableFrom.forEach((from, j) => {
      const other = byId.get(from);
      const p: Path = ['machine', 'states', i, 'enterableFrom', j];
      if (!other) return known(r, r.states, from, p, 'state');
      if (!other.exitableTo.includes(s.id)) {
        bad(r, p, `One-sided edge "${from}" -> "${s.id}": "${s.id}" lists "${from}" in enterableFrom, but "${from}" does not list "${s.id}" in exitableTo`);
      }
    });
    s.exitableTo.forEach((to, j) => {
      const other = byId.get(to);
      const p: Path = ['machine', 'states', i, 'exitableTo', j];
      if (!other) return known(r, r.states, to, p, 'state');
      if (!other.enterableFrom.includes(s.id)) {
        bad(r, p, `One-sided edge "${s.id}" -> "${to}": "${s.id}" lists "${to}" in exitableTo, but "${to}" does not list "${s.id}" in enterableFrom`);
      }
    });
  });
}

/**
 * The full root schema: shape + referential integrity. Zod skips a `superRefine` when the inner
 * object parse aborted, so gate 3 and gate 4 are naturally ordered by a single `safeParse` — a
 * shape-invalid file never produces confusing "unknown zone id" noise on top of its type errors.
 */
export const GameDefinitionSchema = GameDefinitionShape.superRefine(checkReferences);

// ---------------------------------------------------------------------------
// Drift guard — a compile error, not a runtime test
// ---------------------------------------------------------------------------

/** Bidirectional assignability. Tuple-wrapped so unions do not distribute. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * If any schema above drifts from `types.ts`, this stops being `true` and `tsc --noEmit` fails.
 * Exported only so `noUnusedLocals` does not flag it.
 */
export const SCHEMA_MATCHES_TYPES: Exact<z.infer<typeof GameDefinitionSchema>, GameDefinition> =
  true;

// ---------------------------------------------------------------------------
// §7.2 The four import gates — pure, nothing touches a store
// ---------------------------------------------------------------------------

export type ImportResult =
  | { ok: true; definition: GameDefinition }
  | { ok: false; errors: string[] };

const formatIssue = (issue: z.ZodIssue): string =>
  issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`;

/**
 * Gates 3 and 4 on an already-parsed value. The authoring store calls this on save, so
 * "zone names must be unique" is enforced by exactly the same code the importer runs.
 */
export function validateDefinition(d: unknown): string[] {
  const result = GameDefinitionSchema.safeParse(d);
  return result.success ? [] : result.error.issues.map(formatIssue);
}

export function importJson(text: string): ImportResult {
  // Gate 1 — JSON.parse
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`File is not valid JSON: ${(e as Error).message}`] };
  }

  // Gate 2 — version, read BEFORE the full parse. One clear message beats forty field errors
  // from a future format, and an absent version is this path too (§9.4 item 10).
  const version =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>).schemaVersion
      : undefined;
  if (version === undefined) {
    return { ok: false, errors: [`Missing schemaVersion. This build reads version ${SCHEMA_VERSION}.`] };
  }
  // v1 is a live input this build will actually receive, unlike an arbitrarily future version, so
  // it is named rather than lumped in with the generic message (§7.1). There is no migration
  // chain by decision — §2.3 item 6.
  if (version === 1) {
    return {
      ok: false,
      errors: [
        `Unsupported schema version 1. This build reads version ${SCHEMA_VERSION}. v1 definitions are not convertible — the schema changed before release.`,
      ],
    };
  }
  if (version !== SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [`Unsupported schema version ${String(version)}. This build reads version ${SCHEMA_VERSION}.`],
    };
  }

  // Gates 3 and 4 — shape, then referential integrity.
  const result = GameDefinitionSchema.safeParse(raw);
  if (!result.success) return { ok: false, errors: result.error.issues.map(formatIssue) };
  return { ok: true, definition: result.data };
}

/**
 * Zod iterates its own shape keys, so the output key order is this file's declaration order
 * regardless of the input's insertion order, and unknown keys are stripped. That is what makes
 * import -> export byte-identical (§7.1).
 */
export function exportJson(d: GameDefinition): string {
  return JSON.stringify(GameDefinitionSchema.parse(d), null, 2);
}
