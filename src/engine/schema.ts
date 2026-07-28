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
  CriteriaNode,
  Effect,
  GameDefinition,
  SeatRef,
  TargetSelector,
} from './types';

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
  z.object({ kind: z.literal('all'), quantifier: z.enum(['every', 'some']).optional() }),
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
]);

export const ValueRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.union([z.number(), z.boolean()]) }),
  z.object({ kind: z.literal('pool'), poolId: IdSchema, seat: SeatRefSchema.nullable() }),
  z.object({ kind: z.literal('cardIndex'), card: CardRefSchema, indexId: IdSchema }),
  z.object({ kind: z.literal('zoneCount'), zone: ZoneRefSchema }),
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
  ]);

export const EffectSchema = z.discriminatedUnion('kind', [
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
]);

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
  templates: Set<string>;
  /** Union of every template's index ids. Indexes are per-template, but an effect's `indexId` is
   *  not statically bound to a template, so a global set is the only check available here. */
  indexes: Set<string>;
  ruleSets: Set<string>;
  states: Set<string>;
}

function bad(r: Refs, path: Path, message: string): void {
  r.ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function known(r: Refs, set: Set<string>, id: string, path: Path, label: string): void {
  if (!set.has(id)) bad(r, path, `Unknown ${label} id "${id}"`);
}

function checkZoneRef(ref: { zoneId: string }, p: Path, r: Refs): void {
  known(r, r.zones, ref.zoneId, [...p, 'zoneId'], 'zone');
}

function checkCardRef(ref: z.infer<typeof CardRefSchema>, p: Path, r: Refs): void {
  if (ref.kind === 'zoneTop') checkZoneRef(ref.zone, [...p, 'zone'], r);
}

function checkValueRef(v: z.infer<typeof ValueRefSchema>, p: Path, r: Refs): void {
  switch (v.kind) {
    case 'pool':
      known(r, r.pools, v.poolId, [...p, 'poolId'], 'pool');
      break;
    case 'cardIndex':
      checkCardRef(v.card, [...p, 'card'], r);
      known(r, r.indexes, v.indexId, [...p, 'indexId'], 'card index');
      break;
    case 'zoneCount':
      checkZoneRef(v.zone, [...p, 'zone'], r);
      break;
    case 'literal':
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
      checkValueRef(e.amount, [...p, 'amount'], r);
      break;
    case 'setCardIndex':
      checkSelector(e.target, [...p, 'target'], r);
      known(r, r.indexes, e.indexId, [...p, 'indexId'], 'card index');
      checkValueRef(e.amount, [...p, 'amount'], r);
      break;
    case 'flipCard':
    case 'rotateCard':
    case 'destroyCards':
      checkSelector(e.target, [...p, 'target'], r);
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
  }
}

function checkReferences(d: GameDefinition, ctx: z.RefinementCtx): void {
  const r: Refs = {
    ctx,
    zones: new Set(d.zones.map((z) => z.id)),
    // The reserved `activePlayer` pool is never in `d.pools` (§4.1 — it must not appear in an
    // export), but setup.ts seeds it and authored effects are its only legal writers. Omitting it
    // here rejects every definition that authors turn structure the documented way.
    pools: new Set([ACTIVE_PLAYER_POOL_ID, ...d.pools.map((p) => p.id)]),
    templates: new Set(d.templates.map((t) => t.id)),
    indexes: new Set(d.templates.flatMap((t) => t.indexes.map((i) => i.id))),
    ruleSets: new Set(d.ruleSets.map((s) => s.id)),
    states: new Set(d.machine.states.map((s) => s.id)),
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
