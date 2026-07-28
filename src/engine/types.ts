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
 * `all` in an *effect* applies to every seat. In a *criteria* it quantifies.
 * `triggeringSeat` is the seat that owns the card or zone that fired the event — required because
 * `next`/`previous` are only correct when the acting player is `activePlayer`, which any
 * out-of-turn play violates silently.
 */
export type SeatRef =
  | { kind: 'active' }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'triggeringSeat' }
  | { kind: 'seat'; index: number }
  | { kind: 'all'; quantifier?: 'every' | 'some' }; // default 'every' — §5.7

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
  | { kind: 'zoneCount'; zone: ZoneRef };

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
  | { kind: 'forceTransition'; toStateId: Id };

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

export const SCHEMA_VERSION = 1 as const;

export const DEFAULT_MAX_DEPTH = 64;
export const DEFAULT_MAX_EFFECTS = 10_000;

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
  /** defaults 64 / 10_000 — §5.5 */
  limits: { maxDepth: number; maxEffects: number };
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
 * §5.5 requires every WorkItem to carry a parent frame id so the loop-guard chain is
 * reconstructed exactly rather than guessed. `id` is drawn from `PlayState.nextWorkId`,
 * so it is deterministic like every other id in the system.
 */
export interface WorkItemBase {
  id: number;
  parentId: number | null;
  depth: number;
}

export type WorkItem =
  // `stateId` is set only for `onStateExit`: the transition has already landed by the time the
  // queued event drains, so `state.currentStateId` is the DESTINATION and a `stateFilter` matched
  // against it would fire for the wrong state. Carries the state that was LEFT.
  | (WorkItemBase & { kind: 'event'; name: EventName; ctx: TriggerContext; stateId?: Id })
  | (WorkItemBase & { kind: 'rule'; ruleId: Id; sourceCardId: Id | null; ctx: TriggerContext })
  | (WorkItemBase & { kind: 'effect'; ruleId: Id; effectIndex: number; ctx: TriggerContext })
  | (WorkItemBase & { kind: 'transition'; toStateId: Id; forced: boolean });

export interface PendingPrompt {
  /** `${logSeq}:${ruleSetId}:${effectIndex}` — stable and reproducible */
  promptId: string;
  promptText: string;
  seat: number;
  /** FROZEN at prompt time, in zone order */
  candidates: Id[];
  min: number;
  max: number;
}

/** Everything rewindable, and NOTHING else. The single immer-produced object. */
export interface PlayState {
  definitionId: Id;
  seed: string;
  rngCursor: number;
  nextSeq: number;
  /** counter behind WorkItem.id — deterministic, part of the rewound domain */
  nextWorkId: number;
  /** the log seq this transaction will occupy; feeds PendingPrompt.promptId */
  logSeq: number;
  playerCount: number;
  /** game-scoped (incl. activePlayer) */
  pools: Record<Id, number | boolean>;
  /** per-seat, index === seat */
  playerPools: Record<Id, (number | boolean)[]>;
  cards: Record<Id, CardInstance>;
  zones: Record<ZoneKey, ZoneInstance>;
  currentStateId: Id;
  finished: boolean;
  queue: WorkItem[];
  pendingPrompt: PendingPrompt | null;
  budget: { causalDepth: number; effectsUsed: number };
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
  | 'SESSION_FINISHED';

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
