/**
 * Every type in TECHNICAL_DESIGN.md §4. Types only — the only runtime values here are two
 * constants that are part of the data contract itself.
 *
 * Zod mirrors live in schema.ts and a type-level test asserts `z.infer` equals these types,
 * so drift is a compile error.
 *
 * NOTE (deviation from §4.10): `HistoryFrame` and `PlaySession` are NOT declared here. They
 * reference immer's `Patch`, and §3.2 forbids the engine importing immer at all. They live in
 * `src/stores/sessionStore.ts`, which is also where the log and history actually live (§3.5).
 */

// ---------------------------------------------------------------------------
// §4.1 Primitives and values
// ---------------------------------------------------------------------------

export type Id = string;
export type IconId = string; // sprite symbol id, e.g. "gi-broadsword"

/** Discriminated on `type` so min/max are unrepresentable on booleans. */
export type GameValue =
  | { type: 'integer'; name: string; defaultValue: number; min: number | null; max: number | null }
  | { type: 'boolean'; name: string; defaultValue: boolean };

export type PoolScope = 'game' | 'player';

export interface PointPool {
  id: Id;
  scope: PoolScope;
  value: GameValue;
}

/**
 * Reserved. The engine creates it if absent and NEVER writes it — only authored effects do.
 * A designer-defined pool with this id is an author-time name collision.
 */
export const ACTIVE_PLAYER_POOL_ID = 'activePlayer' as const;

/**
 * The implicit DEFINITION of that pool. `setup.ts` seeds the reserved pool's runtime value even
 * when the designer never authored one — but every lookup that resolves a pool id against
 * `GameDefinition.pools` would then fail `MISSING_REFERENT`, making the documented way to author
 * turn structure (a criterion on `activePlayer`) unusable. Lookups fall back to this instead.
 *
 * Deliberately NOT inserted into `GameDefinition.pools`: it must never appear in an export, or the
 * byte-identical round trip (§7.1) breaks the moment a definition passes through a play session.
 */
export const ACTIVE_PLAYER_POOL: PointPool = {
  id: ACTIVE_PLAYER_POOL_ID,
  scope: 'game',
  value: { type: 'integer', name: 'Active Player', defaultValue: 0, min: 0, max: null },
};

// ---------------------------------------------------------------------------
// §4.2 Seat and value references
// ---------------------------------------------------------------------------

/**
 * Stable seat identity — §3.5. Assigned 0..playerCount-1 at setup and NEVER reused or renumbered.
 * Seat identity and seat *position* are different things: position lives in `PlayState.seatOrder`.
 */
export type SeatId = number;

/**
 * §4.1. `every` and `some` fold the per-seat values into a boolean; `sum` does not fold at all — it
 * collapses them into one arithmetic TOTAL, which is why it is legal only where a `ValueRef` is
 * consumed as a number (effect amounts, comparison operands). `schema.ts` rejects it over a boolean
 * pool at author time and `valueRef.ts` re-checks at runtime; both are required, because imported
 * JSON never passed through the editor.
 */
export type SeatQuantifier = 'every' | 'some' | 'sum';

/**
 * `all` in an *effect* applies to every seat. In a *criteria* it quantifies.
 * `triggeringSeat` is the seat that owns the card or zone that fired the event — required because
 * `next`/`previous` are only correct when the acting player is `activePlayer`, which any
 * out-of-turn play violates silently.
 *
 * `relative` (§4.1) is the general form `next`/`previous` are sugar over: it takes ANY base seat,
 * which is what makes "my predator" correct for a card owned by a seat whose turn it is not. It
 * walks `seatOrder`, so an eliminated seat is skipped rather than counted.
 */
export type SeatRef =
  | { kind: 'active' }
  | { kind: 'next' } // === relative(active, +1)
  | { kind: 'previous' } // === relative(active, -1)
  | { kind: 'triggeringSeat' }
  | { kind: 'seat'; index: SeatId }
  | { kind: 'relative'; from: SeatRef; offset: number }
  /**
   * §4.1, §4.3. These make `SeatRef` hold a `CardRef`, which holds a `ZoneRef`, which holds a
   * `SeatRef` — the three unions are mutually recursive from here on, which is why their zod
   * mirrors need `z.lazy` and why their resolvers all live in `seats.ts`.
   */
  | { kind: 'owner'; card: CardRef }
  | { kind: 'controller'; card: CardRef }
  | { kind: 'all'; quantifier?: SeatQuantifier }; // default 'every' — §5.7

/** seat is null iff the referenced zone/pool is Game/Shared scoped. */
export interface ZoneRef {
  zoneId: Id;
  seat: SeatRef | null;
}

export type CardRef =
  | { kind: 'triggering' }
  | { kind: 'zoneTop'; zone: ZoneRef }
  | { kind: 'promptAnswer'; promptId: string; ordinal: number }
  | { kind: 'instance'; id: Id }
  /**
   * §4.2 — the host of the card THIS RULE is attached to, i.e. of `TriggerContext.sourceCardId`.
   * Deliberately not `triggering`: an equipment's rule fires on events about other cards all the
   * time, and "the vampire I am equipping" must not become "whatever card set this off".
   */
  | { kind: 'host' }
  /**
   * §4.2, §4.4 — the card under test in a predicate selector, bound once per candidate while a
   * `matching` selector walks its wrapped set. Unbound anywhere else, and deliberately so: a
   * criterion that reads `candidate` outside a `matching` has no card to mean, and answering with
   * the triggering card (or with anything else) would make the predicate quietly test the wrong
   * thing. It fails UNBOUND_REF like every other ref with nothing behind it.
   */
  | { kind: 'candidate' }
  /**
   * v2 §4.2, §5.7 — bound only inside a replacement rule's `replaces.match`, to the target the
   * INTERCEPTED effect was about to touch. Unbound everywhere else, for the same reason
   * `candidate` is: a criterion that reads it outside a replacement has no card to mean.
   */
  | { kind: 'replacedTarget' };

/**
 * v2 §4.2 — addresses a pending action (§4.8) the way `CardRef` addresses a card. `{kind:'action'}`
 * names a runtime id no author can predict at edit time, so the editor offers only the first two
 * (§6.10) — the schema admits all three because a rule can still be authored to react to a
 * specific action once one exists, e.g. from a prior `announceAction` in the same effect list.
 */
export type ActionRef =
  | { kind: 'triggeringAction' }
  | { kind: 'topOfStack' }
  | { kind: 'action'; id: Id };

export type ValueRef =
  | { kind: 'literal'; value: number | boolean }
  | { kind: 'pool'; poolId: Id; seat: SeatRef | null }
  | { kind: 'cardIndex'; card: CardRef; indexId: Id }
  | { kind: 'zoneCount'; zone: ZoneRef }
  /**
   * §4.2 — resolves to a BOOLEAN, read through `effectiveTags()` and never `template.tags`. Tags
   * became per-instance in §4.3, so a criterion reading the template would be blind to every tag
   * `setTag` has added or removed on this particular copy.
   */
  | { kind: 'cardTag'; card: CardRef; tag: string }
  /**
   * §4.2 — `seatOrder.length`, NOT `playerCount`. Storage stays dense and full-length (§3.5), so
   * this is the only reading of "table size" that is still correct after an oust, and it needs no
   * per-game configuration to be so.
   */
  | { kind: 'activeSeatCount' }
  /**
   * v2 §4.2, §5.7 — bound only inside a replacement rule's `replaces.match`, to the AMOUNT the
   * intercepted effect was about to apply (a `drawCards.count`, a `changePool.amount`, …). Unbound
   * everywhere else — same discipline as `replacedTarget` above.
   */
  | { kind: 'replacedAmount' }
  /**
   * v2 §4.2 — reads a characteristic off a pending action (§4.8) rather than off a card. `field` is
   * closed to the two `PendingAction` properties a criterion plausibly needs; widening it to the
   * whole record is deferred until a third one is.
   */
  | { kind: 'actionField'; action: ActionRef; field: 'controller' | 'targetCount' };

// ---------------------------------------------------------------------------
// §4.3 Criteria
// ---------------------------------------------------------------------------

export type ComparisonOp = '=' | '!=' | '>' | '<' | '>=' | '<=';

export interface GameCriteria {
  kind: 'criteria';
  left: ValueRef;
  op: ComparisonOp;
  right: ValueRef;
}

export interface CriteriaGroup {
  kind: 'group';
  combinator: 'and' | 'or';
  children: CriteriaNode[];
}

/** Recursive union — arbitrary nesting for free, one recursive editor component. */
export type CriteriaNode = GameCriteria | CriteriaGroup;

// ---------------------------------------------------------------------------
// §4.4 Cards
// ---------------------------------------------------------------------------

export type IndexPosition = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export interface CardIndex {
  id: Id;
  value: GameValue;
  icon: IconId;
  position: IndexPosition;
}

export interface CardTemplate {
  id: Id;
  name: string;
  /** stored explicitly (defaults to name in the editor) so export is lossless */
  marquee: string;
  faceIcon: IconId;
  /** hex, picked from the theme palette */
  borderColor: string;
  tags: string[];
  indexes: CardIndex[];
  /** reference into GameDefinition.ruleSets — §4.7 */
  ruleSetIds: Id[];
  /** null => render prose.generate(); set => render verbatim, rules untouched */
  rulesTextOverride: string | null;
}

export interface CardInstance {
  /** `c${state.nextSeq++}` — deterministic, never a UUID */
  id: Id;
  templateId: Id;
  /** keyed by CardIndex.id; seeded from template defaults */
  indexValues: Record<Id, number | boolean>;
  faceDown: boolean;
  rotated: boolean;
  /**
   * §4.3. Seeded as a COPY of `template.tags` at creation and mutable per instance thereafter, so
   * one instance gaining a tag never edits the definition every other instance shares.
   */
  tags: string[];
  /** §4.3. Set once at creation — the seat whose zone it was dealt into. null for a shared zone. */
  owner: SeatId | null;
  /** §4.3. null => derive from the seat of the zone currently holding it. */
  controller: SeatId | null;
  /** §4.3. Host instance id. Attachment is a REFERENCE, not a zone, so a host moving changes nothing. */
  attachedTo: Id | null;
}

// ---------------------------------------------------------------------------
// §4.5 Zones and decks
// ---------------------------------------------------------------------------

export interface PlayZone {
  id: Id;
  /** unique across the definition (Zod superRefine) */
  name: string;
  scope: 'shared' | 'player';
  visibility: 'faceUp' | 'faceDown' | 'ownerOnly';
  layout: 'stack' | 'fan' | 'row' | 'grid';
  ordered: boolean;
  /** >= 1 when set; 0 is rejected by the schema */
  maxCapacity: number | null;
}

/** Runtime instance. seat === null for shared zones. */
export interface ZoneInstance {
  zoneId: Id;
  seat: number | null;
  cardIds: Id[];
}

/** zoneKey(z, null) === z; zoneKey(z, 1) === `${z}#1`. A flat Record beats a nested map for patch paths. */
export type ZoneKey = string;

/**
 * A deck targeting a player-scoped zone is instantiated once per seat — derived from the zone's
 * scope, so there is no perSeat flag to keep in sync.
 */
export interface Deck {
  id: Id;
  name: string;
  zoneId: Id;
  entries: { templateId: Id; quantity: number }[];
}

// ---------------------------------------------------------------------------
// §4.6 Events
// ---------------------------------------------------------------------------

export type BuiltinEvent =
  | 'onGameStart'
  | 'onGameEnd'
  | 'onCardPlayed'
  | 'onCardDrawn'
  | 'onZoneEnter'
  | 'onZoneExit'
  | 'onStateEnter'
  | 'onStateExit'
  | 'onPoolChanged';

/** `& {}` keeps autocomplete on the builtins while allowing any custom name. */
export type EventName = BuiltinEvent | (string & {});

export const BUILTIN_EVENTS: readonly BuiltinEvent[] = [
  'onGameStart',
  'onGameEnd',
  'onCardPlayed',
  'onCardDrawn',
  'onZoneEnter',
  'onZoneExit',
  'onStateEnter',
  'onStateExit',
  'onPoolChanged',
] as const;

/** Only these four bind a triggering card — §4.6, §5.7. */
export const CARD_BINDING_EVENTS: readonly BuiltinEvent[] = [
  'onCardPlayed',
  'onCardDrawn',
  'onZoneEnter',
  'onZoneExit',
] as const;

// ---------------------------------------------------------------------------
// §4.7 Effects, targeting, rules
// ---------------------------------------------------------------------------

export type InsertPosition = 'top' | 'bottom' | { kind: 'index'; index: number };
export type NumericOp = 'add' | 'subtract' | 'set';

/**
 * `prompt` WRAPS another selector: the wrapped selector defines the legal set to highlight.
 * No second targeting language for "what may I click".
 */
export type TargetSelector =
  | { kind: 'triggeringCard' }
  | { kind: 'topOfZone'; zone: ZoneRef; count: ValueRef }
  | { kind: 'bottomOfZone'; zone: ZoneRef; count: ValueRef }
  | { kind: 'allInZone'; zone: ZoneRef }
  | { kind: 'taggedInZone'; zone: ZoneRef; tag: string }
  | { kind: 'prompt'; from: TargetSelector; count: ValueRef; promptText: string }
  /**
   * §4.4 — the two halves of the attachment relation, read in either direction. Neither consults a
   * zone: attachment is a REFERENCE, so a host in the graveyard still has its attachments and an
   * attached card sitting in a completely different zone still resolves its host.
   */
  | { kind: 'attachedTo'; host: CardRef }
  | { kind: 'hostOf'; card: CardRef }
  /**
   * §4.4 — predicate targeting. `where` is evaluated ONCE PER CANDIDATE with `CardRef{kind:
   * 'candidate'}` bound to the card under test.
   *
   * It wraps like `prompt` does and the two compose in either order: `prompt(matching(…))` is
   * "choose a creature with power 3 or more", and `matching(prompt(…))` filters the set the
   * prompt highlights. Either way the wrapped selector still defines the legal set — there is no
   * second targeting language.
   */
  | { kind: 'matching'; from: TargetSelector; where: CriteriaNode };

/**
 * v2 §4.4 — pending actions (§4.8) are selected separately from cards; they are not `CardInstance`s
 * and have no zone, so nothing in `TargetSelector` above applies to them.
 */
export type ActionSelector =
  | { kind: 'action'; ref: ActionRef }
  | { kind: 'allOnStack'; where: CriteriaNode | null };

/** v2 §4.5 — one option in a `sealedChoice`. */
export interface ChoiceOption {
  id: string;
  label: string;
}

/** v2 §4.5 — one branch of a `chooseMode`. */
export interface ChoiceMode {
  label: string;
  effects: Effect[];
}

export type Effect =
  | { kind: 'moveCards'; target: TargetSelector; to: ZoneRef; position: InsertPosition }
  | { kind: 'drawCards'; from: ZoneRef; to: ZoneRef; count: ValueRef }
  | { kind: 'shuffleZone'; zone: ZoneRef }
  | { kind: 'changePool'; poolId: Id; seat: SeatRef | null; op: NumericOp; amount: ValueRef }
  | { kind: 'setCardIndex'; target: TargetSelector; indexId: Id; op: NumericOp; amount: ValueRef }
  | { kind: 'flipCard'; target: TargetSelector; to: 'faceUp' | 'faceDown' | 'toggle' }
  | { kind: 'rotateCard'; target: TargetSelector; to: 'rotated' | 'upright' | 'toggle' }
  | { kind: 'createCard'; templateId: Id; zone: ZoneRef; position: InsertPosition; count: ValueRef }
  | { kind: 'destroyCards'; target: TargetSelector }
  | { kind: 'fireEvent'; name: string }
  | { kind: 'forceTransition'; toStateId: Id }
  /**
   * §5.12 — drops the seat from `seatOrder` and appends it to `eliminated`. Deletes NOTHING: pools,
   * zone instances and cards all stay, and `finished` is untouched. Elimination is not session end.
   */
  | { kind: 'eliminateSeat'; seat: SeatRef }
  /**
   * §4.3 — adds or removes a tag on the INSTANCE. `template.tags` is only ever the seed, so this
   * never edits the definition that every other copy of the card shares.
   */
  | { kind: 'setTag'; target: TargetSelector; tag: string; on: boolean }
  /**
   * §4.3 — writes `attachedTo`. Moves nothing: attachment is a reference, not a zone, so an
   * equipment attaches from wherever it already is and stays there.
   */
  | { kind: 'attach'; target: TargetSelector; host: CardRef }
  | { kind: 'detach'; target: TargetSelector }
  /**
   * §4.3 — overrides the holding zone's seat for `controllerOf`. `null` clears the override, so
   * control reverts to being derived from wherever the card currently sits.
   */
  | { kind: 'setController'; target: TargetSelector; seat: SeatRef | null }
  /**
   * v2 §4.5, §4.8 — creates a `PendingAction` from `ruleId`, freezing its targets at announce time,
   * and pushes it onto `actionStack`. `window` opens a priority window over it immediately; `null`
   * announces with no response opportunity (e.g. an ability that cannot be countered).
   */
  | { kind: 'announceAction'; ruleId: Id; window: Id | null }
  /** v2 §4.5, §4.8 — removes the selected pending action(s) from the stack WITHOUT applying them. */
  | { kind: 'counterAction'; action: ActionSelector }
  /** v2 §4.5, §4.6 — opens a priority window with no pending action attached (e.g. "before combat"). */
  | { kind: 'openPriority'; window: Id }
  /**
   * v2 §4.5, §5.11 — every seat in `seats` submits one option, hidden from everyone (including the
   * log) until all have answered, then all resolve together in `seats` order. §5.11 covers why.
   */
  | { kind: 'sealedChoice'; choiceId: string; seats: SeatRef; options: ChoiceOption[] }
  /** v2 §4.5 — the chosen mode's `effects` run in place of this one; the other modes never run. */
  | { kind: 'chooseMode'; promptText: string; seat: SeatRef; modes: ChoiceMode[] }
  | {
      kind: 'chooseNumber';
      promptText: string;
      seat: SeatRef;
      min: ValueRef;
      max: ValueRef;
      /** The answer is readable elsewhere as `ValueRef{kind:'promptNumber'}` keyed by this. */
      key: string;
    };

export interface RuleSet {
  id: Id;
  name: string;
  trigger: EventName;
  /**
   * Narrows onStateEnter/onStateExit to one state. Ignored for every other trigger.
   * This is what makes authored turn structure practical.
   */
  stateFilter: Id | null;
  /** null always passes */
  condition: CriteriaNode | null;
  /** run in order */
  effects: Effect[];
  /** default 0, descending — §5.2 */
  priority: number;
  /** default 'continue' — §5.3 */
  onRejection: 'continue' | 'abort';

  /**
   * v2 §4.5 / §5.4 — a continuously-applying value modifier. NEVER materialized into state; it is
   * re-derived on every read by `modifiers.ts`, so there is no teardown path to forget when the
   * source leaves play by an unanticipated route.
   *
   * `.nullable()`-and-PRESENT in the zod mirror, not `.optional()` — §7.2's byte-identical round
   * trip needs the key written even when null, or the loss only shows up on the *second* trip.
   */
  modifier: {
    /** Which cards it applies to. Re-evaluated per read, bound to the SOURCE card as `triggering`. */
    scope: TargetSelector;
    indexId: Id;
    op: 'set' | 'adjust';
    amount: ValueRef;
    /** Applies only while the source card is in one of these zones. Empty => wherever the source is. */
    activeZones: Id[];
  } | null;

  /**
   * v2 §4.5, §5.6 — true => `trigger` is IGNORED and `condition` is instead scanned at every settle
   * point (§5.3 slot 1), firing on the false→true transition rather than while true.
   *
   * Mutually exclusive with `modifier`/`replaces`/`activation` — a zod refinement enforces it,
   * because a rule that is simultaneously a trigger, a modifier and a replacement has no defensible
   * evaluation order (§4.5).
   */
  continuous: boolean;

  /**
   * v2 §4.5, §5.7 — registers this rule against an effect about to apply, ahead of the mutation.
   * `.nullable()`-and-PRESENT — same §7.2 rationale as `modifier`.
   */
  replaces: {
    /** Restricted at authoring time and by a zod refinement to §5.7's five interceptable kinds. */
    effectKind: Effect['kind'];
    /** May read `ValueRef{kind:'replacedAmount'}` / `CardRef{kind:'replacedTarget'}`. */
    match: CriteriaNode | null;
  } | null;

  /**
   * v2 §4.5, §5.8 — cost-gated activation: a rule the tester triggers deliberately (an ability),
   * rather than one the engine fires off an event. `.nullable()`-and-PRESENT — same §7.2 rationale.
   */
  activation: {
    /** Evaluated before `cost` runs; false rejects COST_UNPAYABLE with nothing applied. */
    costCheck: CriteriaNode | null;
    /**
     * Applied in a nested produce that is discarded on any rejection (§5.8) — the one place effects
     * are all-or-nothing. May not raise an `Interaction` or contain `chooseMode` / `chooseNumber` /
     * `sealedChoice` / `openPriority`, nor a `TargetSelector` of kind `prompt` at any depth — a zod
     * refinement enforces both.
     */
    cost: Effect[];
    /** Which priority window this may be activated in. `null` => only outside a window. */
    window: Id | null;
    /** true => rendered as a button on each card instance the rule is attached to (§5.8, §6.7). */
    perInstance: boolean;
    label: string;
  } | null;
}

// ---------------------------------------------------------------------------
// v2 §4.6 Priority windows
// ---------------------------------------------------------------------------

/** NEW — a top-level authored entity, edited in its own screen (§6.9). */
export interface PriorityWindow {
  id: Id;
  name: string;
  /** Where polling starts. */
  start: 'active' | 'triggeringSeat' | 'controllerOfAction';
  /** Ring direction. */
  direction: 'forward' | 'backward';
  /** false => the starting seat is skipped (VTES: you do not block your own action). */
  includeStart: boolean;
  /** Closes after this many consecutive passes. `null` => `activeSeatCount` (poll the whole table). */
  passesToClose: number | null;
  /**
   * A seat with no legal response auto-passes and produces NO log entry — always true. Present as a
   * field, not a hard-coded rule, only so the editor can show it as an explained, disabled checkbox
   * (§6.9) rather than a behaviour with no visible authoring surface at all.
   */
  collapseEmptyOffers: true;
}

// ---------------------------------------------------------------------------
// §4.8 State machine
// ---------------------------------------------------------------------------

export const START_STATE_ID = 'start' as const;
export const END_STATE_ID = 'end' as const;

export interface MachineState {
  /** 'start' and 'end' are reserved */
  id: Id;
  name: string;
  enterableFrom: Id[];
  exitableTo: Id[];
  /** null => manual: renders as a labeled button */
  entryCriteria: CriteriaNode | null;
  /** button text when entryCriteria === null */
  transitionLabel: string | null;
  /** default 0, descending — §5.6 tiebreak */
  priority: number;
  /** node coords for the visual editor; part of the definition so layout survives export */
  position: { x: number; y: number };
}

/**
 * A transition A→B is legal iff B.enterableFrom includes A AND A.exitableTo includes B.
 * The editor writes both sides together; the engine checks both and names the failing one.
 */
export interface StateMachine {
  states: MachineState[];
  startStateId: Id;
  endStateId: Id;
}

// ---------------------------------------------------------------------------
// §4.9 The export root
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 2 as const;

export const DEFAULT_MAX_DEPTH = 256;
export const DEFAULT_MAX_EFFECTS = 50_000;
export const DEFAULT_MAX_SETTLE_ITERATIONS = 64;
export const DEFAULT_MAX_PRIORITY_ROUNDS = 256;

/** This IS the exported file. No envelope, no exportedAt — see §7. */
export interface GameDefinition {
  /** first key, so a bad file fails on version before field noise */
  schemaVersion: typeof SCHEMA_VERSION;
  id: Id;
  name: string;
  playerCount: number;
  pools: PointPool[];
  zones: PlayZone[];
  templates: CardTemplate[];
  decks: Deck[];
  /** authored names for the event picker */
  customEvents: string[];
  /** the library; cards reference by id */
  ruleSets: RuleSet[];
  /** game-level rules (onGameStart setup, win checks) */
  globalRuleSetIds: Id[];
  /** v2 §4.6, §4.11 — top-level authored entities; `openPriority` and `activation.window` address one by id. */
  priorityWindows: PriorityWindow[];
  machine: StateMachine;
  /** defaults from the DEFAULT_MAX_* constants above — v2 §4.11 */
  limits: {
    maxDepth: number;
    maxEffects: number;
    maxSettleIterations: number;
    maxPriorityRounds: number;
  };
  /** ISO. Bumped by edits only; import never writes it */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// §4.10 Play state and log
// ---------------------------------------------------------------------------

export interface TriggerContext {
  triggeringCardId: Id | null;
  zoneKey: ZoneKey | null;
  triggeringSeat: number | null;
  promptAnswers: Record<string, Id[]>;
  /**
   * §4.2 — the card instance whose template carries the RULE now executing, i.e. "self". NOT the
   * same thing as `triggeringCardId`, which is the card the EVENT is about: a global rule watching
   * `onZoneEnter` has a triggering card and no source card, while an equipment's rule reacting to
   * another creature entering play has both, and they are different cards.
   *
   * Mirrors the `rule` frame's `sourceCardId`. `dispatch.ts` stamps it per binding; every other
   * context — a fired event, a tester's direct action — has no rule and so carries null. Only
   * `CardRef{kind:'host'}` reads it today; `perInstance` activation (§5.8) is its second reader.
   */
  sourceCardId: Id | null;
  /**
   * §4.4 — the card `CardRef{kind:'candidate'}` names, set only while a `matching` selector is
   * testing that card. OPTIONAL because it is never authored, never stamped onto a frame and never
   * persisted: `targets.ts` derives `{...ctx, candidateCardId: id}` per candidate and hands the
   * copy to `evalCriteria`, so the binding lives exactly as long as the one predicate that needs
   * it. Threading it through a derived context rather than through module state is what makes
   * nested `matching` selectors re-entrant — each level reads its own object.
   */
  candidateCardId?: Id | null;
}

/**
 * §5.5 requires every frame to carry a parent frame id so the loop-guard chain is
 * reconstructed exactly rather than guessed. `id` is drawn from `PlayState.nextWorkId`,
 * so it is deterministic like every other id in the system.
 */
export interface FrameBase {
  id: number;
  parentId: number | null;
  depth: number;
}

/**
 * v2 §4.7 — replaces v1's `WorkItem`. Two v1 kinds have no arm here on purpose:
 *
 * - `effect`: a `rule` frame's own `cursor` plays that role now (§4.7, §9.2).
 * - `transition`: it was already dead code in v1 — `forceTransition` applies inline via
 *   `applyTransition` (`effects.ts:730`) and nothing ever enqueued it. It gets no replacement.
 *
 * `resolve`, `priority` and `sealed` land here in step 21/31 because the type has to exist for
 * every other §4 union to compile against, but nothing in this wave can PUSH one — step() throws
 * on all three (dispatch.ts), which is honest: they are genuinely unreachable until steps 22/24/29.
 */
export type Frame =
  // `stateId` is set only for `onStateExit`: the transition has already landed by the time the
  // queued event drains, so `state.currentStateId` is the DESTINATION and a `stateFilter` matched
  // against it would fire for the wrong state. Carries the state that was LEFT.
  | (FrameBase & {
      kind: 'event';
      name: EventName;
      ctx: TriggerContext;
      stateId?: Id;
      bindings: RuleBinding[];
      cursor: number;
    })
  | (FrameBase & {
      kind: 'rule';
      ruleId: Id;
      sourceCardId: Id | null;
      ctx: TriggerContext;
      cursor: number;
      aborted: boolean;
      /**
       * v2 §5.7 — effect-replacement rule ids that have already substituted somewhere in the
       * CURRENT top-level effect's replacement chain (`frame.cursor`'s effect, not the whole rule).
       * `replacement.ts` resets it to `{}` at the start of each top-level effect and accumulates
       * into it across the chain, so a rule cannot re-match its own substitutes ("draw two instead"
       * cannot recurse) while a SECOND, distinct replacement rule may still intercept once (§9.5
       * edge case 7 — a designed choice, not a spec-mandated one). Optional and absent on every
       * frame `replacement.ts` never touches, so every existing `push(state, {kind:'rule', ...})`
       * call site (dispatch.ts) stays valid unchanged.
       */
      replacedBy?: Record<Id, true>;
    })
  | (FrameBase & { kind: 'settle'; iteration: number })
  /** v2 §4.7, §4.8 — pops the top of `actionStack` and runs its rule's effects. Step 22. */
  | (FrameBase & { kind: 'resolve'; actionId: Id })
  /**
   * v2 §4.7, §4.6, §5.5 — polls `order` from `cursor`, closing after `passesToClose` consecutive
   * passes. `actionId` is `null` for a window opened with no pending action attached
   * (`openPriority`). Step 24.
   */
  | (FrameBase & {
      kind: 'priority';
      windowId: Id;
      actionId: Id | null;
      order: SeatId[];
      cursor: number;
      consecutivePasses: number;
    })
  /** v2 §4.7, §5.11 — one open `sealedChoice`, keyed by its authored `choiceId`. Step 29. */
  | (FrameBase & { kind: 'sealed'; choiceId: string });

/** One matched rule inside an `event` frame's `bindings`, in §5.1 order. */
export interface RuleBinding {
  ruleId: Id;
  sourceCardId: Id | null;
  ctx: TriggerContext;
}

/**
 * v2 §4.8 — game state, addressable by criteria and selectors (`ActionRef`, `ActionSelector`) the
 * way a `CardInstance` is addressable by `CardRef`/`TargetSelector`. Lands here in step 21/31
 * because `ActionRef`/`ActionSelector`/`PlayState.pendingActions` all need the shape to exist; the
 * primitives that actually create and consume one (`announceAction`, `resolve` frames,
 * `counterAction`) are step 22/23.
 */
export interface PendingAction {
  /** `a${state.nextSeq++}` — deterministic, never a UUID, same discipline as every other id here. */
  id: Id;
  ruleId: Id;
  sourceCardId: Id | null;
  controller: SeatId;
  ctx: TriggerContext;
  /**
   * Targets chosen at ANNOUNCE time and frozen, so a response that moves a card cannot silently
   * re-aim the original action. Keyed the way a rule's authored targets are addressed; the key
   * scheme itself is step 22's.
   */
  targets: Record<string, Id[]>;
  /** Mutable per-action characteristics, so "this action is a spell" is authorable and testable. */
  tags: string[];
  countered: boolean;
}

/**
 * v2 §4.9 — replaces `PendingPrompt`. One suspension mechanism for every kind of pause.
 * Phase 0 produced only the `chooseCards` arm, which is v1's prompt behaviour verbatim under a
 * discriminant. The five arms below land here in step 21/31 because `Interaction` has to be a
 * closed union for `interaction.ts`'s `validateAnswer` (and every other exhaustive switch over it)
 * to keep catching a forgotten arm at compile time — but nothing in this wave can RAISE one; that
 * arrives with the primitive that does (steps 24/28/29).
 */
export type Interaction =
  | {
      kind: 'chooseCards';
      /** `${logSeq}:${ruleSetId}:${effectIndex}` — stable and reproducible */
      promptId: string;
      promptText: string;
      seat: number;
      /** FROZEN at prompt time, in zone order */
      candidates: Id[];
      min: number;
      max: number;
    }
  | { kind: 'chooseOption'; promptId: string; promptText: string; seat: number; options: ChoiceOption[] }
  | { kind: 'chooseNumber'; promptId: string; promptText: string; seat: number; min: number; max: number }
  | { kind: 'chooseSeat'; promptId: string; promptText: string; seat: number; candidates: SeatId[] }
  | {
      kind: 'priority';
      promptId: string;
      windowId: Id;
      seat: number;
      /** Non-empty by construction — an empty set auto-passes without raising (§5.5). */
      legal: { ruleId: Id; cardId: Id | null; label: string }[];
    }
  | {
      kind: 'sealed';
      promptId: string;
      choiceId: string;
      seats: SeatId[];
      options: ChoiceOption[];
      /** Hidden from every seat and from the log until every seat in `seats` is present (§5.11). */
      submitted: Record<SeatId, string>;
    };

/** Everything rewindable, and NOTHING else. The single immer-produced object. */
export interface PlayState {
  definitionId: Id;
  seed: string;
  rngCursor: number;
  nextSeq: number;
  /** counter behind Frame.id — deterministic, part of the rewound domain */
  nextWorkId: number;
  /** the log seq this transaction will occupy; feeds Interaction.promptId */
  logSeq: number;
  /** §3.5: survives only as the INITIAL seat count and the bound on a valid `SeatId`. */
  playerCount: number;
  /** The live ring, in seating order. Elimination removes from here — §3.5, §5.12. */
  seatOrder: SeatId[];
  /** Ousted seats, in the order they were eliminated. Their storage is never deleted. */
  eliminated: SeatId[];
  /** game-scoped (incl. activePlayer) */
  pools: Record<Id, number | boolean>;
  /** per-seat, index === seat */
  playerPools: Record<Id, (number | boolean)[]>;
  cards: Record<Id, CardInstance>;
  zones: Record<ZoneKey, ZoneInstance>;
  /** v2 §4.8, §4.10 — game state for every announced action still awaiting resolution. */
  pendingActions: Record<Id, PendingAction>;
  /** v2 §4.10 — last placed resolves first (§8 step 22's AC). */
  actionStack: Id[];
  currentStateId: Id;
  finished: boolean;
  /** LIFO continuation stack — §3.2. `step()` advances the top frame and returns. */
  stack: Frame[];
  /**
   * FIFO, drained one frame at a time only once `stack` empties — §3.2. Fired events append here
   * rather than pushing onto the stack, which is what preserves v1 §5.1's breadth-first guarantee:
   * effect 4 sees the world effect 3 left behind, not a world mutated by a deep cascade.
   */
  pending: Frame[];
  interaction: Interaction | null;
  /**
   * v2 §4.10, §5.6 — continuous rules fire on false→true transitions, not while true. Keyed by
   * `` `${ruleId}:${bindingKey}` ``, set on false→true and cleared on false — `continuous.ts` (step
   * 26) owns the binding-key scheme this key is built from.
   */
  continuousFired: Record<string, true>;
  budget: { causalDepth: number; effectsUsed: number; settleIterations: number; priorityRounds: number };
}

export type LogLevel = 'info' | 'warn' | 'reject' | 'error' | 'override';

/** Display-only detail inside an entry. NOT a rewind target. */
export interface LogLine {
  level: LogLevel;
  /** `criteria` is §5.9 level 3's per-candidate include/exclude from a `matching` selector. */
  kind: 'event' | 'rule' | 'effect' | 'change' | 'transition' | 'prompt' | 'skip' | 'criteria';
  message: string;
  change: { path: string; before: unknown; after: unknown } | null;
  ruleId: Id | null;
  effectKind: Effect['kind'] | null;
  depth: number;
}

/** One entry = one user action plus its ENTIRE cascade. The rewind target. */
export interface LogEntry {
  /** === index in log[] === index in history[] */
  seq: number;
  cause: { kind: 'userAction' | 'engine'; description: string; seat: number | null };
  lines: LogLine[];
  flags: { override?: true; haltedByLoopGuard?: true; suspended?: true };
}

// ---------------------------------------------------------------------------
// Engine input and result surface (§3.3, §5.1, §5.9)
// ---------------------------------------------------------------------------

/**
 * Everything a tester can do at the table. `moveCard` covers both the drag and the
 * click-to-place path (§6.5) — one reducer entry point.
 */
export type PlayAction =
  | { kind: 'start' }
  | { kind: 'moveCard'; cardId: Id; to: ZoneRef; position: InsertPosition }
  | { kind: 'flipCard'; cardId: Id; to: 'faceUp' | 'faceDown' | 'toggle' }
  | { kind: 'rotateCard'; cardId: Id; to: 'rotated' | 'upright' | 'toggle' }
  | { kind: 'transition'; toStateId: Id }
  | { kind: 'fireEvent'; name: string; seat: number | null }
  | { kind: 'answerPrompt'; chosen: Id[] }
  | { kind: 'cancelPrompt' }
  /** v2 §4.12, §5.8 — `cardId` is set only for a `perInstance` activation. Step 25. */
  | { kind: 'activate'; ruleId: Id; cardId: Id | null; seat: number }
  /** v2 §4.12, §5.5 — the acting seat declines to respond in an open `priority` interaction. Step 24. */
  | { kind: 'passPriority' }
  /** v2 §4.12 — answers a `chooseOption` interaction. Step 28. */
  | { kind: 'answerOption'; optionId: string }
  /** v2 §4.12 — answers a `chooseNumber` interaction. Step 28. */
  | { kind: 'answerNumber'; value: number }
  /** v2 §4.12 — answers a `chooseSeat` interaction. Step 24/28. */
  | { kind: 'answerSeat'; seat: number }
  /** v2 §4.12, §5.11 — one seat's submission to an open `sealedChoice`. Step 29. */
  | { kind: 'submitSealed'; seat: number; optionId: string };

/** The store re-enters `step` with CONTINUE until it reports done (§3.3). */
export const CONTINUE = { kind: 'continue' } as const;

export type EngineInput =
  | { kind: 'action'; action: PlayAction; override: boolean }
  | typeof CONTINUE;

/**
 * Rejection reasons. A closed union so §9.4 item 8 can table every reason × override
 * and prove exactly which ones override bypasses.
 */
export type RejectReason =
  | 'ZONE_FULL'
  | 'TARGET_GONE'
  | 'NO_TARGETS'
  | 'ILLEGAL_TRANSITION'
  | 'ONE_SIDED_EDGE'
  | 'MISSING_REFERENT'
  | 'TYPE_MISMATCH'
  | 'INVALID_SEAT'
  | 'UNBOUND_REF'
  | 'RULE_LOOP'
  | 'AWAITING_PROMPT'
  | 'INVALID_ANSWER'
  | 'PROMPT_CANCELED'
  | 'SESSION_FINISHED'
  /** v2 §4.12 — the continuous/auto-transition fixpoint hit `limits.maxSettleIterations`. */
  | 'SETTLE_DIVERGED'
  /** v2 §4.12, §5.12 — a target or destination belongs to an ousted seat. */
  | 'SEAT_ELIMINATED'
  /** v2 §4.12, §5.8 — an activation's `costCheck` failed, or its `cost` could not be paid in full. */
  | 'COST_UNPAYABLE'
  /** v2 §4.12, §5.8 — `activation` is null, or the acting window does not match `activation.window`. */
  | 'NOT_ACTIVATABLE'
  /** v2 §4.12, §5.7 (via §8 step 23) — the targeted pending action was countered before resolving. */
  | 'ACTION_COUNTERED'
  /** v2 §4.12, §5.5 — the priority round cap (`limits.maxPriorityRounds`) was hit. */
  | 'PRIORITY_EXHAUSTED';

/** Uniform result for anything that can refuse. */
export type EffectResult =
  | { ok: true }
  | { ok: false; reason: RejectReason; detail?: string };

/** What one `step()` reports back to the driving loop (§3.3). */
export interface StepResult {
  /** true => queue empty, or paused on a prompt: the transaction settles here */
  done: boolean;
  suspended: boolean;
  haltedByLoopGuard: boolean;
}
