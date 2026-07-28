/**
 * The engine's public surface. **The React layer imports only from here** (§3.1).
 *
 * Everything below this barrel is pure TypeScript: no React, no zustand, no immer, no DOM — a
 * boundary that is lint-enforced rather than conventional (§3.2). That is what lets every
 * acceptance criterion about rules, state transitions and history be proved headless, before a
 * component exists.
 *
 * Two things are deliberately NOT re-exported:
 *   - `schema.ts`'s individual Zod schemas. The stores need `validateDefinition` / `importJson` /
 *     `exportJson`; handing the UI the raw schemas invites a second validation path, and §7.2's
 *     whole point is that the authoring forms and the importer run the SAME gate.
 *   - `rng.ts`'s `randomInt` / `shuffleWith`. They exist as seams for the algorithm-shape tests;
 *     the app has no business drawing its own randomness — every draw must go through state so it
 *     survives rewind (§3.6).
 */

// ---------------------------------------------------------------------------
// Types — the whole data model (§4)
// ---------------------------------------------------------------------------

export type {
  Id,
  IconId,
  GameValue,
  PoolScope,
  PointPool,
  SeatRef,
  ZoneRef,
  CardRef,
  ValueRef,
  ComparisonOp,
  GameCriteria,
  CriteriaGroup,
  CriteriaNode,
  IndexPosition,
  CardIndex,
  CardTemplate,
  CardInstance,
  PlayZone,
  ZoneInstance,
  ZoneKey,
  Deck,
  BuiltinEvent,
  EventName,
  InsertPosition,
  NumericOp,
  TargetSelector,
  Effect,
  RuleSet,
  MachineState,
  StateMachine,
  GameDefinition,
  TriggerContext,
  Frame,
  FrameBase,
  RuleBinding,
  Interaction,
  PlayState,
  LogLevel,
  LogLine,
  LogEntry,
  PlayAction,
  EngineInput,
  RejectReason,
  EffectResult,
  StepResult,
} from './types';

export {
  ACTIVE_PLAYER_POOL_ID,
  ACTIVE_PLAYER_POOL,
  BUILTIN_EVENTS,
  CARD_BINDING_EVENTS,
  START_STATE_ID,
  END_STATE_ID,
  SCHEMA_VERSION,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  CONTINUE,
} from './types';

// ---------------------------------------------------------------------------
// Validation, import and export (§7)
// ---------------------------------------------------------------------------

export { validateDefinition, importJson, exportJson, type ImportResult } from './schema';

// ---------------------------------------------------------------------------
// Determinism (§3.6). `random`/`shuffle` are counter-based: pure functions of
// (seedHash, cursor), so the cursor lives in PlayState and rewind restores it.
// ---------------------------------------------------------------------------

export { hashSeed, random, shuffle } from './rng';

// ---------------------------------------------------------------------------
// Reference resolution and evaluation (§5.7)
// ---------------------------------------------------------------------------

export {
  zoneKey,
  parseZoneKey,
  resolvePoolDef,
  resolveValueRef,
  type ValueResolution,
  type ValueResolutionOk,
} from './valueRef';

// The seat ring — §3.5. `valueRef.ts` re-exports these too, for call sites older than the split.
export {
  resolveSeat,
  type SeatResolution,
  type SeatResolutionOk,
  type ResolutionFail,
} from './seats';

export {
  evalCriteria,
  evalCriteriaBool,
  type CriteriaResult,
  type CriteriaLeaf,
  type CriteriaSide,
} from './criteria';

export {
  resolveTargets,
  CHOSEN_PROMPT_KEY,
  type TargetResult,
  type TargetsOk,
  type TargetsPrompt,
} from './targets';

// ---------------------------------------------------------------------------
// Session setup and the step machine (§3.3, §5.1)
// ---------------------------------------------------------------------------

export { createPlayState } from './setup';

/**
 * `step()` performs exactly ONE unit of work; all remaining work lives in `state.stack` (the LIFO
 * continuation stack) and `state.pending` (the FIFO of fired events) — §3.2.
 *
 * `appendPending` replaces v1's `enqueue` as the way to hand the engine an event from outside a
 * running chain. The rest of `frames.ts` stays internal: pushing or popping the stack from above
 * the engine boundary would mean the UI could interleave frames with a transaction in flight.
 */
export { step } from './dispatch';
export { appendPending } from './frames';

/**
 * `applyEffect` mutates a draft in place. `canMove` is exported because §6.4 requires the drag UI
 * to MIRROR this probe rather than reimplement capacity — one source of truth for legality.
 */
export { applyEffect, canMove, clampValue, type EffectContext } from './effects';

export {
  checkTransitionLegal,
  findAutoTransition,
  manualTransitions,
  applyTransition,
} from './stateMachine';

// ---------------------------------------------------------------------------
// Presentation helpers — pure, and shared so two renderers cannot disagree (§6.3)
// ---------------------------------------------------------------------------

/** Feeds BOTH the card's Rules layer and the rule editor's live preview. */
export {
  generateRulesProse,
  describeEffect,
  describeCriteria,
  describeValueRef,
  describeZoneRef,
  describeTargetSelector,
} from './prose';

/** Resolved ABOVE `<Card>`, in ZoneView, so the Catalog renders the identical component. */
export { resolveVisibility } from './visibility';
