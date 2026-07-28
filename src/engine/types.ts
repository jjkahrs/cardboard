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
  | { kind: 'instance'; id: Id };

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
  | { kind: 'activeSeatCount' };

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
  | { kind: 'prompt'; from: TargetSelector; count: ValueRef; promptText: string };

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
   * §4.3 — overrides the holding zone's seat for `controllerOf`. `null` clears the override, so
   * control reverts to being derived from wherever the card currently sits.
   */
  | { kind: 'setController'; target: TargetSelector; seat: SeatRef | null };

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
 * `resolve`, `priority` and `sealed` (§4.7) reference pending actions and priority windows, which
 * do not exist until phase 2; they land with the entities they address.
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
    })
  | (FrameBase & { kind: 'settle'; iteration: number });

/** One matched rule inside an `event` frame's `bindings`, in §5.1 order. */
export interface RuleBinding {
  ruleId: Id;
  sourceCardId: Id | null;
  ctx: TriggerContext;
}

/**
 * v2 §4.9 — replaces `PendingPrompt`. One suspension mechanism for every kind of pause.
 * Phase 0 produces only the `chooseCards` arm, which is v1's prompt behaviour verbatim under a
 * discriminant; the other five arms arrive with the primitives that raise them.
 */
export type Interaction = {
  kind: 'chooseCards';
  /** `${logSeq}:${ruleSetId}:${effectIndex}` — stable and reproducible */
  promptId: string;
  promptText: string;
  seat: number;
  /** FROZEN at prompt time, in zone order */
  candidates: Id[];
  min: number;
  max: number;
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
  budget: { causalDepth: number; effectsUsed: number; settleIterations: number };
}

export type LogLevel = 'info' | 'warn' | 'reject' | 'error' | 'override';

/** Display-only detail inside an entry. NOT a rewind target. */
export interface LogLine {
  level: LogLevel;
  kind: 'event' | 'rule' | 'effect' | 'change' | 'transition' | 'prompt' | 'skip';
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
  | { kind: 'cancelPrompt' };

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
  | 'SEAT_ELIMINATED';

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
