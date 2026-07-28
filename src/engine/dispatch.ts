/**
 * The continuation stack and `step()`. TECHNICAL_DESIGN_V2.md §3.2, §3.3, §5.1–§5.3.
 *
 * v1's semantics (`TECHNICAL_DESIGN.md` §5.1–§5.6, §5.9 rows 6/7/8/8b/8c/9/16/17) remain in force
 * unchanged — phase 0 replaces the *machine*, not the observable behaviour.
 *
 * `step()` performs exactly ONE unit of work and returns. Everything still owed lives in
 * `state.stack` and `state.pending`, both inside `PlayState` and therefore serializable, patchable
 * and rewindable. The store re-enters with CONTINUE until `done`. There is no recursion anywhere in
 * this file: with recursion the in-flight rule state would live on the JS call stack, which cannot
 * be serialized, snapshotted or unwound — and prompt suspension plus rewind both need exactly that.
 *
 * **Breadth-first event dispatch is preserved by construction** (§3.2). An `event` frame never
 * pushes a child `event` frame: fired events go to `state.pending`, a FIFO drained only once the
 * stack empties. And because the event frame STAYS on the stack while its rules run, "the rules of
 * THIS event run before any queued sibling event" (v1 §5.1) holds without v1's `enqueueFront` — the
 * property that makes `onZoneExit → onZoneEnter → onCardPlayed` read in the order the tester sees.
 */

import {
  ACTIVE_PLAYER_POOL_ID,
  CARD_BINDING_EVENTS,
  type CardTemplate,
  type Effect,
  type EngineInput,
  type EventName,
  type Frame,
  type GameDefinition,
  type Id,
  type LogLine,
  type PlayAction,
  type PlayState,
  type RejectReason,
  type RuleBinding,
  type RuleSet,
  type StepResult,
  type TargetSelector,
  type TriggerContext,
  type ZoneRef,
} from './types';
import { evalCriteria } from './criteria';
import { applyEffect, canMove, type EffectContext } from './effects';
import { appendPending, pop, promotePending, push, top } from './frames';
import { clear, isResuming, isSuspended, promptIdOf, raise, validateAnswer } from './interaction';
import { applyTransition, findAutoTransition } from './stateMachine';
import { CHOSEN_PROMPT_KEY, resolveTargets } from './targets';
import { resolveSeat, zoneKey } from './valueRef';

// ---------------------------------------------------------------------------
// Results and logging
// ---------------------------------------------------------------------------

const MORE: StepResult = { done: false, suspended: false, haltedByLoopGuard: false };
const DONE: StepResult = { done: true, suspended: false, haltedByLoopGuard: false };
const SUSPENDED: StepResult = { done: true, suspended: true, haltedByLoopGuard: false };
const HALTED: StepResult = { done: true, suspended: false, haltedByLoopGuard: true };

/** Authoring/data faults are ERROR; rule-legal refusals are REJECT (§5.9 preamble). */
const ERROR_REASONS: readonly RejectReason[] = [
  'MISSING_REFERENT',
  'TARGET_GONE',
  'TYPE_MISMATCH',
  'INVALID_SEAT',
  'UNBOUND_REF',
];
const levelFor = (reason: RejectReason) => (ERROR_REASONS.includes(reason) ? 'error' : 'reject');

type LogInput = Pick<LogLine, 'level' | 'kind' | 'message'> & Partial<LogLine>;

function log(lines: LogLine[], entry: LogInput): void {
  lines.push({ change: null, ruleId: null, effectKind: null, depth: 0, ...entry });
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

type EventFrame = Extract<Frame, { kind: 'event' }>;
type RuleFrame = Extract<Frame, { kind: 'rule' }>;
type SettleFrame = Extract<Frame, { kind: 'settle' }>;

/**
 * `cursor === -1` means "the once-per-frame header work has not run yet" on BOTH the `event` and
 * the `rule` frame — bindings are not resolved, the RuleSet's condition is not evaluated, and no
 * line has been logged for it.
 *
 * A sentinel rather than a separate boolean because `bindings: []` is otherwise indistinguishable
 * from an event that genuinely matched zero rules, and `cursor: 0` on a rule frame is
 * indistinguishable from one whose condition has already passed. Both confusions re-run the header
 * — duplicate log lines, or a condition re-evaluated against a world its own effects have changed.
 */
const UNRESOLVED = -1;

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

const activeSeat = (state: PlayState): number => Number(state.pools[ACTIVE_PLAYER_POOL_ID] ?? 0);

/**
 * `@chosen` is the answer to the prompt of the effect being applied RIGHT NOW. effects.ts forwards
 * `ctx.promptAnswers` by reference into every event it fires, so without this a rule bound to that
 * child event inherits the key, its own `prompt` selector short-circuits in targets.ts, and the
 * nested prompt is never raised — logged, misleadingly, as "0 legal targets. Prompt skipped."
 */
function stripChosen(ctx: TriggerContext): TriggerContext {
  if (!(CHOSEN_PROMPT_KEY in ctx.promptAnswers)) return ctx;
  const promptAnswers = { ...ctx.promptAnswers };
  delete promptAnswers[CHOSEN_PROMPT_KEY];
  return { ...ctx, promptAnswers };
}

function baseCtx(state: PlayState): TriggerContext {
  // `sourceCardId` null: a tester's action is not a rule, so it has no "self" for `host` to read.
  return { triggeringCardId: null, zoneKey: null, triggeringSeat: activeSeat(state), promptAnswers: {}, sourceCardId: null };
}

function makeEc(
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[],
  ctx: TriggerContext,
  depth: number,
  parentId: number | null,
  override: boolean,
  ruleId: Id | null,
  effectKind: Effect['kind'] | null
): EffectContext {
  return {
    state,
    def,
    ctx,
    depth,
    override,
    // Filling in a null ruleId/effectKind is this module's job — effects.ts does not know which
    // RuleSet is driving it, and H2 requires every change line to name one.
    log: (l) =>
      lines.push({ ...l, ruleId: l.ruleId ?? ruleId, effectKind: l.effectKind ?? effectKind }),
    // depth + 1 and PENDING placement are enforced HERE, not in effects.ts (§5.5, §3.2). A fired
    // event is the one thing that increments depth.
    fireEvent: (name, childCtx, stateId) =>
      appendPending(state, {
        kind: 'event',
        name,
        ctx: stripChosen(childCtx),
        ...(stateId !== undefined && { stateId }),
        bindings: [],
        cursor: UNRESOLVED,
        parentId,
        depth: depth + 1,
      }),
  };
}

// ---------------------------------------------------------------------------
// Bindings — §5.2. Resolved when the event frame begins advancing; sort is TOTAL.
// ---------------------------------------------------------------------------

interface Binding {
  rule: RuleSet;
  sourceCardId: Id | null;
  /** 0 game-level, 1 card-attached. */
  scope: number;
  zoneOrder: number;
  position: number;
  seat: number;
}

/**
 * §5.2's sort key in order: priority desc, scope, zone declaration order, position in zone
 * (top = 0), seat, then authored RuleSet id. The id tiebreak is what makes it TOTAL — without it a
 * stable-sort accident or object iteration order changes replay across export/import (§9.4 item 4).
 */
function compareBindings(a: Binding, b: Binding): number {
  return (
    b.rule.priority - a.rule.priority ||
    a.scope - b.scope ||
    a.zoneOrder - b.zoneOrder ||
    a.position - b.position ||
    a.seat - b.seat ||
    (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0) ||
    String(a.sourceCardId).localeCompare(String(b.sourceCardId))
  );
}

/**
 * Id lookups, derived purely from the (immutable) definition. Cached because a runaway chain
 * resolves bindings tens of thousands of times, and `ruleSets.find` per rule is what turns §9.3's
 * "under 100ms" into seconds on a large definition.
 */
const defIndex = new WeakMap<GameDefinition, { rules: Map<Id, RuleSet>; templates: Map<Id, CardTemplate> }>();

function indexOf(def: GameDefinition) {
  let index = defIndex.get(def);
  if (!index) {
    index = {
      rules: new Map(def.ruleSets.map((r) => [r.id, r] as const)),
      templates: new Map(def.templates.map((t) => [t.id, t] as const)),
    };
    defIndex.set(def, index);
  }
  return index;
}

function resolveBindings(
  name: EventName,
  ctx: TriggerContext,
  state: PlayState,
  def: GameDefinition,
  /** The state a pending `onStateExit` left, when the frame carries one. */
  eventStateId: Id | null
): Binding[] {
  const { rules: byId, templates } = indexOf(def);

  /**
   * Under the four CARD_BINDING_EVENTS a card-attached RuleSet fires ONLY for the card that
   * triggered the event. Otherwise a fourth Grunt entering the Battlefield fires all four copies of
   * "on enter, attackers +1", the generated prose ("when this card is played") is a lie, and a rule
   * runs with `triggeringCard` pointing at some other card. Board-wide reactions are expressed as
   * GLOBAL rules, which are never filtered here. Every other trigger has no triggering card, so
   * card rules bind board-wide and §5.2's zone/position/seat ordering still decides their order.
   */
  const selfScoped = (CARD_BINDING_EVENTS as readonly string[]).includes(name);

  // stateFilter matches currentStateId for onStateEnter. For onStateExit the transition has already
  // landed by the time the pending event is promoted, so currentStateId is the DESTINATION — the
  // frame carries the state that was left and that is what the filter is matched against instead.
  const filterState = name === 'onStateExit' ? (eventStateId ?? state.currentStateId) : state.currentStateId;
  const matches = (rule: RuleSet | undefined): rule is RuleSet =>
    rule !== undefined &&
    rule.trigger === name &&
    (rule.stateFilter === null ||
      (name !== 'onStateEnter' && name !== 'onStateExit') ||
      rule.stateFilter === filterState);

  const out: Binding[] = [];
  for (const id of def.globalRuleSetIds) {
    const rule = byId.get(id);
    if (matches(rule)) out.push({ rule, sourceCardId: null, scope: 0, zoneOrder: 0, position: 0, seat: -1 });
  }

  // Keys are built from the definition, never from Object.keys(state.zones) — §9.4 item 4.
  def.zones.forEach((zone, zoneOrder) => {
    const keys =
      zone.scope === 'shared'
        ? [zoneKey(zone.id, null)]
        : Array.from({ length: state.playerCount }, (_, s) => zoneKey(zone.id, s));
    keys.forEach((key, seat) => {
      const inst = state.zones[key];
      if (!inst) return;
      inst.cardIds.forEach((cardId, position) => {
        // Not a match, not a skip — logging every unbound copy would drown the log on a wide board.
        if (selfScoped && cardId !== ctx.triggeringCardId) return;
        const card = state.cards[cardId];
        const template = card && templates.get(card.templateId);
        if (!template) return;
        for (const ruleId of template.ruleSetIds) {
          const rule = byId.get(ruleId);
          if (matches(rule)) {
            out.push({
              rule,
              sourceCardId: cardId,
              scope: 1,
              zoneOrder,
              position,
              seat: zone.scope === 'shared' ? -1 : seat,
            });
          }
        }
      });
    });
  });

  return out.sort(compareBindings);
}

// ---------------------------------------------------------------------------
// Halting — §5.5 (loop guard) and §5.3 (settle divergence). BOTH counters; override never
// bypasses any of them.
// ---------------------------------------------------------------------------

/**
 * Discards the whole chain — `stack` AND `pending` — and clears any suspension, because a
 * suspension inside a runaway chain is not resumable.
 *
 * `headline` is the only difference between the two callers: `RULE_LOOP` (a cascade that will not
 * terminate) and `SETTLE_DIVERGED` (§5.3's fixpoint that will not converge) halt identically, so
 * they share one body rather than two that can drift.
 */
function haltChain(
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[],
  headline: string,
  tripped: string
): StepResult {
  const discarded = state.stack.length + state.pending.length;
  state.stack = [];
  state.pending = [];
  clear(state);
  // ponytail: the chain is rendered from the event lines already in this transaction's log rather
  // than by walking Frame.parentId — the ancestors have been popped, so an exact walk would need a
  // frame table living in PlayState (patched and rewound every step) to render one message.
  // parentId/id are threaded correctly on every frame, so that table can be added without changes here.
  const chain = lines
    .filter((l) => l.kind === 'event')
    .slice(-8)
    .map((l) => `      depth ${l.depth}  ${l.message}`)
    .join('\n');
  log(lines, {
    level: 'error',
    kind: 'rule',
    depth: state.budget.causalDepth,
    message:
      `${headline}\n` +
      `  Tripped: ${tripped}   (effects executed ${state.budget.effectsUsed} / ${def.limits.maxEffects})\n` +
      `  Chain (most recent 8 frames):\n${chain}\n` +
      `  Discarded ${discarded} queued events. State is at the last completed effect — use Rewind to back this out.`,
  });
  return HALTED;
}

const tripLoopGuard = (state: PlayState, def: GameDefinition, lines: LogLine[], tripped: string) =>
  haltChain(state, def, lines, 'Possible rule loop — chain halted.', tripped);

// ---------------------------------------------------------------------------
// Effects — §5.2, §5.3
// ---------------------------------------------------------------------------

/** The five effects that carry a target; only a `prompt` target suspends. */
function promptTarget(effect: Effect): Extract<TargetSelector, { kind: 'prompt' }> | null {
  return 'target' in effect && effect.target.kind === 'prompt' ? effect.target : null;
}

const promptSeat = (state: PlayState, ctx: TriggerContext) => ctx.triggeringSeat ?? activeSeat(state);

/**
 * ONE effect — the one at `frame.cursor` — then the cursor moves. v1 ran the whole remaining list
 * per `step()`; v2 runs one (§3.2). Observable state is identical, only the number of `step()`
 * calls changes, and the store loops until `done`.
 *
 * The cursor is advanced by exactly one of three exits: the effect completed, the effect was
 * skipped, or the frame was aborted. A SUSPENDED return advances nothing — see below.
 */
function runEffect(
  frame: RuleFrame,
  rule: RuleSet,
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[]
): StepResult {
  const i = frame.cursor;
  const effect = rule.effects[i];
  const selector = promptTarget(effect);
  const promptId = promptIdOf(state, rule.id, i);
  let chosen: Id[] | undefined;

  if (selector) {
    chosen = frame.ctx.promptAnswers[promptId];
    if (chosen === undefined) {
      // §3.3 hard rule: raise BEFORE any mutation. This effect executes twice — once to raise, once
      // to complete — so it must be re-entrant by construction.
      const candidates = resolveTargets(selector, state, frame.ctx, def);
      if (!candidates.ok || candidates.kind !== 'prompt') {
        // Zero legal targets → the prompt is NOT raised (§5.9 row 8). A modal with nothing
        // clickable is a dead end; this holds even when min is 0.
        const reason = candidates.ok ? 'NO_TARGETS' : candidates.reason;
        log(lines, {
          level: levelFor(reason),
          kind: 'prompt',
          depth: frame.depth,
          ruleId: rule.id,
          effectKind: effect.kind,
          message: `Prompt "${selector.promptText}" (seat ${promptSeat(state, frame.ctx)}): ${
            candidates.ok ? '0 legal targets' : candidates.message
          } Prompt skipped.`,
        });
        if (rule.onRejection === 'abort') frame.aborted = true;
        else frame.cursor += 1;
        return MORE;
      }
      raise(state, {
        kind: 'chooseCards',
        promptId,
        promptText: candidates.promptText,
        seat: promptSeat(state, frame.ctx),
        candidates: [...candidates.candidates],
        min: candidates.min,
        max: candidates.max,
      });
      log(lines, {
        level: 'info',
        kind: 'prompt',
        depth: frame.depth,
        ruleId: rule.id,
        effectKind: effect.kind,
        message: `Prompt "${candidates.promptText}" (seat ${promptSeat(state, frame.ctx)}): ${candidates.candidates.length} legal targets.`,
      });
      // The cursor does NOT advance (§3.3). v1 re-enqueued an `effect` work item at the same index;
      // v2's equivalent is simply leaving the cursor where it is — this very frame is the top of the
      // stack, so resuming re-enters the same effect with the answer now in `ctx.promptAnswers`.
      return SUSPENDED;
    }
  }

  // Counted only when an effect actually applies — the prompt-raising pass mutates nothing.
  state.budget.effectsUsed += 1;
  if (state.budget.effectsUsed > def.limits.maxEffects) {
    return tripLoopGuard(
      state,
      def,
      lines,
      `effectsUsed ${state.budget.effectsUsed} > limit ${def.limits.maxEffects}   (causalDepth ${state.budget.causalDepth})`
    );
  }

  const effectCtx = chosen
    ? { ...frame.ctx, promptAnswers: { ...frame.ctx.promptAnswers, [CHOSEN_PROMPT_KEY]: chosen } }
    : frame.ctx;
  const result = applyEffect(
    effect,
    // Override is ACTION-scoped (§5.9 rows 1b/5c): it is a property of the tester's own move,
    // never of rule execution, so a rule-driven effect is always evaluated without it.
    makeEc(state, def, lines, effectCtx, frame.depth, frame.id, false, rule.id, effect.kind)
  );
  if (!result.ok) {
    log(lines, {
      level: levelFor(result.reason),
      kind: 'effect',
      depth: frame.depth,
      ruleId: rule.id,
      effectKind: effect.kind,
      message: `${effect.kind}: ${result.detail ?? result.reason}`,
    });
    // abort stops the REMAINING effects. Already-applied effects stay — abort is not rollback (§5.3).
    if (rule.onRejection === 'abort') {
      log(lines, {
        level: 'info',
        kind: 'skip',
        depth: frame.depth,
        ruleId: rule.id,
        message: `RuleSet "${rule.name}" aborted after effect ${i + 1} of ${rule.effects.length}.`,
      });
      frame.aborted = true;
      return MORE;
    }
  }
  frame.cursor += 1;
  return MORE;
}

// ---------------------------------------------------------------------------
// One frame
// ---------------------------------------------------------------------------

function advanceEvent(
  frame: EventFrame,
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[]
): StepResult {
  if (frame.cursor === UNRESOLVED) {
    // Bindings resolve HERE — when the frame begins advancing — and not when the event was fired.
    // A card that entered a zone between the two must still bind (v1 resolved at dequeue time).
    frame.bindings = resolveBindings(frame.name, frame.ctx, state, def, frame.stateId ?? null).map(
      (b): RuleBinding => ({
        ruleId: b.rule.id,
        sourceCardId: b.sourceCardId,
        // promptAnswers is copied, not aliased: promptIds are `logSeq:ruleId:effectIndex`, so two
        // bindings of the SAME rule under one event compute the same id. Sharing the map would let
        // the first binding's answer satisfy the second's prompt, which then never raises.
        //
        // `sourceCardId` is stamped HERE, and this is the only place it is ever set to a card: the
        // event frame's ctx says which card the event is ABOUT, the binding says which card's rule
        // is running. Two copies of one equipment bind twice and each reads its own host (§4.2).
        ctx: { ...frame.ctx, promptAnswers: { ...frame.ctx.promptAnswers }, sourceCardId: b.sourceCardId },
      })
    );
    // Row 6: a custom event with no bound RuleSet is NOT an error.
    log(lines, {
      level: 'info',
      kind: 'event',
      depth: frame.depth,
      message: `Event "${frame.name}" fired — ${frame.bindings.length} rules bound.`,
    });
    frame.cursor = 0;
    return MORE;
  }

  if (frame.cursor >= frame.bindings.length) {
    pop(state);
    return MORE;
  }

  const binding = frame.bindings[frame.cursor];
  frame.cursor += 1;
  push(state, {
    kind: 'rule',
    ruleId: binding.ruleId,
    sourceCardId: binding.sourceCardId,
    ctx: binding.ctx,
    cursor: UNRESOLVED,
    aborted: false,
    parentId: frame.id,
    // The SAME depth, not depth + 1: only a fired event is a new causal level (v1 threaded
    // `depth: item.depth` onto every rule item it enqueued).
    depth: frame.depth,
  });
  return MORE;
}

function advanceRule(
  frame: RuleFrame,
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[]
): StepResult {
  const rule = indexOf(def).rules.get(frame.ruleId);
  if (!rule) {
    pop(state);
    return MORE;
  }

  if (frame.cursor === UNRESOLVED) {
    // Bindings were resolved when the event frame began — re-validate existence now (§5.9 row 16).
    if (frame.sourceCardId !== null && !state.cards[frame.sourceCardId]) {
      log(lines, {
        level: 'info',
        kind: 'skip',
        depth: frame.depth,
        ruleId: rule.id,
        message: `Skipped RuleSet "${rule.name}" on ${frame.sourceCardId}: card destroyed earlier this event.`,
      });
      pop(state);
      return MORE;
    }
    // Conditions are evaluated NOW, not snapshotted — earlier rules on the same event gate later
    // ones (§5.2).
    if (rule.condition) {
      const verdict = evalCriteria(rule.condition, state, frame.ctx, def);
      if (!verdict.value) {
        const failing = verdict.leaves.find((l) => !l.value) ?? verdict.leaves[0];
        log(lines, {
          level: 'info',
          kind: 'skip',
          depth: frame.depth,
          ruleId: rule.id,
          message: `Skipped RuleSet "${rule.name}" — condition false: ${failing?.description ?? 'no leaves'}.`,
        });
        pop(state);
        return MORE;
      }
    }
    log(lines, {
      level: 'info',
      kind: 'rule',
      depth: frame.depth,
      ruleId: rule.id,
      message: `RuleSet "${rule.name}"${frame.sourceCardId ? ` on ${frame.sourceCardId}` : ''}.`,
    });
    frame.cursor = 0;
    return MORE;
  }

  // The ONE exit from a running RuleSet, and deliberately the only source-card check: re-validating
  // per effect would mean destroying the card whose RuleSet is executing aborts its remaining
  // effects, and every "when this dies" combo depends on it NOT doing that (§9.4 item 14).
  if (frame.aborted || frame.cursor >= rule.effects.length) {
    pop(state);
    return MORE;
  }

  return runEffect(frame, rule, state, def, lines);
}

/**
 * §5.3's settle point, in its fixed order. Popped first: the slots either finish the transaction or
 * append work whose completion pushes a fresh settle frame, so termination is natural and re-entry
 * is bounded by `budget.settleIterations`.
 */
function advanceSettle(
  _frame: SettleFrame,
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[]
): StepResult {
  pop(state);

  // ---- Slot 1: continuous-condition fixpoint scan (§5.6). ----
  // DELIBERATE NO-OP until step 26, which drops `continuous.ts`'s scan in HERE, ahead of slot 2.
  // The ordering exists now precisely so that step lands as an insertion and nothing around it has
  // to be re-plumbed: "a creature with lethal damage dies" and "a player at zero pool is ousted"
  // must both land before the state machine decides whether the phase is over.

  // ---- Slot 2: auto-transition scan (v1 §5.6, unchanged). ----
  const auto = findAutoTransition(state, def, baseCtx(state));

  // ---- Slot 3: nothing fired, so the world is settled and the transaction commits. ----
  if (!auto) return DONE;

  state.budget.settleIterations += 1;
  if (state.budget.settleIterations > def.limits.maxSettleIterations) {
    return haltChain(
      state,
      def,
      lines,
      'Settle did not converge — chain halted.',
      `SETTLE_DIVERGED: settleIterations ${state.budget.settleIterations} > limit ${def.limits.maxSettleIterations}`
    );
  }

  state.budget.causalDepth += 1;
  if (state.budget.causalDepth > def.limits.maxDepth) {
    return tripLoopGuard(state, def, lines, `causalDepth ${state.budget.causalDepth} > limit ${def.limits.maxDepth}`);
  }
  if (auto.eligible.length > 1) {
    log(lines, {
      level: 'warn',
      kind: 'transition',
      depth: state.budget.causalDepth,
      message: `${auto.eligible.length} transitions eligible from "${state.currentStateId}": ${auto.eligible.join(', ')}. Took "${auto.toStateId}" (exitableTo order).`,
    });
  }
  // Appends onStateExit/onStateEnter to `pending`; the stack is empty, so the next advance promotes
  // them, and once they drain a fresh settle frame re-enters this scan.
  applyTransition(
    makeEc(state, def, lines, baseCtx(state), state.budget.causalDepth, null, false, null, null),
    auto.toStateId,
    { forced: false }
  );
  return MORE;
}

// ---------------------------------------------------------------------------
// advance — §3.2's step skeleton
// ---------------------------------------------------------------------------

function advance(state: PlayState, def: GameDefinition, lines: LogLine[]): StepResult {
  if (isSuspended(state)) return SUSPENDED;

  const frame = top(state);
  if (!frame) {
    // The pending FIFO, one frame per step. Promotion keeps the frame's id (§3.2): it was assigned
    // when the event was fired, and renumbering it would break the loop-guard parent chain and make
    // ids non-deterministic in creation order.
    if (promotePending(state)) return MORE;
    // v1 short-circuited `finished` at quiescence, before scanning; the same check, one step
    // earlier, so a finished session does not push and pop a settle frame it cannot act on.
    if (state.finished) return DONE;
    push(state, { kind: 'settle', iteration: state.budget.settleIterations, parentId: null, depth: 0 });
    return MORE;
  }

  // Idempotent by construction — it reads `frame.depth`, which never changes — so advancing one
  // `rule` frame a hundred times checks the same value a hundred times and cannot drift.
  if (frame.depth > def.limits.maxDepth) {
    state.budget.causalDepth = frame.depth;
    return tripLoopGuard(state, def, lines, `causalDepth ${frame.depth} > limit ${def.limits.maxDepth}`);
  }
  state.budget.causalDepth = Math.max(state.budget.causalDepth, frame.depth);

  switch (frame.kind) {
    case 'event':
      return advanceEvent(frame, state, def, lines);
    case 'rule':
      return advanceRule(frame, state, def, lines);
    case 'settle':
      return advanceSettle(frame, state, def, lines);
  }
}

// ---------------------------------------------------------------------------
// Actions — §5.1, §5.9 rows 9/10/15
// ---------------------------------------------------------------------------

function zoneKeyOf(ref: ZoneRef, state: PlayState, ctx: TriggerContext): string | null {
  if (ref.seat === null) return zoneKey(ref.zoneId, null);
  const seats = resolveSeat(ref.seat, state, ctx);
  return seats.ok && seats.seats.length === 1 ? zoneKey(ref.zoneId, seats.seats[0]) : null;
}

function zoneKeyHolding(state: PlayState, cardId: Id): string | null {
  for (const [key, inst] of Object.entries(state.zones)) {
    if (inst.cardIds.includes(cardId)) return key;
  }
  return null;
}

/** A top-level event fired by a tester action: depth 1, no parent, bindings unresolved. */
function fireRoot(state: PlayState, name: EventName, ctx: TriggerContext, stateId?: Id): void {
  appendPending(state, {
    kind: 'event',
    name,
    ctx,
    ...(stateId !== undefined && { stateId }),
    bindings: [],
    cursor: UNRESOLVED,
    parentId: null,
    depth: 1,
  });
}

function applyAction(
  state: PlayState,
  action: PlayAction,
  override: boolean,
  def: GameDefinition,
  lines: LogLine[]
): StepResult {
  const reject = (reason: RejectReason, message: string, result = DONE): StepResult => {
    log(lines, { level: levelFor(reason), kind: 'skip', message });
    return result;
  };

  if (state.finished) {
    return reject('SESSION_FINISHED', 'Session finished at "End". Only Rewind is accepted.');
  }
  const resuming = isResuming(action);
  if (state.interaction && !resuming) {
    // Row 9, widened from "a card prompt" to ANY interaction. Rewind is the store's job and never
    // reaches step().
    return reject(
      'AWAITING_PROMPT',
      `Input ignored: awaiting response to prompt "${state.interaction.promptText}".`,
      SUSPENDED
    );
  }
  // A user action opens a transaction (§5.1). A resume CONTINUES the open one, budget included.
  // Field-by-field, and only when non-zero: assigning a fresh object literal makes immer record a
  // whole-object `replace` on every action even when nothing changed, doubling the patches in each
  // history frame for no gain.
  if (!resuming) {
    if (state.budget.causalDepth !== 0) state.budget.causalDepth = 0;
    if (state.budget.effectsUsed !== 0) state.budget.effectsUsed = 0;
    if (state.budget.settleIterations !== 0) state.budget.settleIterations = 0;
  }

  const ctx = baseCtx(state);

  switch (action.kind) {
    case 'start': {
      fireRoot(state, 'onGameStart', ctx);
      return MORE;
    }

    case 'moveCard': {
      const card = state.cards[action.cardId];
      if (!card) return reject('TARGET_GONE', `Move ${action.cardId}: card no longer exists.`);
      const to = zoneKeyOf(action.to, state, ctx);
      if (to === null || !state.zones[to]) {
        return reject('MISSING_REFERENT', `Move ${action.cardId} → "${action.to.zoneId}": zone does not exist.`);
      }
      const from = zoneKeyHolding(state, action.cardId);
      if (from === to) {
        // Row 15 — no-op, and no zone events. The largest source of accidental loops (§5.1).
        log(lines, {
          level: 'info',
          kind: 'change',
          message: `Move ${action.cardId} → ${to}: already in that zone. No-op, no events fired.`,
        });
        return DONE;
      }
      const allowed = canMove(state, def, [action.cardId], to);
      if (!allowed.ok && !override) {
        return reject(allowed.reason, `Move ${action.cardId} → ${to}: ${allowed.detail ?? allowed.reason}`);
      }
      if (!allowed.ok) {
        log(lines, {
          level: 'override',
          kind: 'change',
          message: `Move ${action.cardId} → ${to}: ${allowed.detail ?? allowed.reason} Performed anyway.`,
        });
      }

      if (from) {
        const src = state.zones[from].cardIds;
        src.splice(src.indexOf(action.cardId), 1);
      }
      const dst = state.zones[to].cardIds;
      if (action.position === 'top') dst.unshift(action.cardId);
      else if (action.position === 'bottom') dst.push(action.cardId);
      else dst.splice(Math.max(0, Math.min(dst.length, action.position.index)), 0, action.cardId);

      log(lines, {
        level: 'info',
        kind: 'change',
        message: `Move ${action.cardId}: ${from ?? '(nowhere)'} → ${to}.`,
        change: { path: `zones/${to}/cardIds`, before: from, after: to },
      });

      // §5.1 compound order: the card is physically settled before the semantic event runs.
      const cardCtx = (key: string | null): TriggerContext => ({
        triggeringCardId: action.cardId,
        zoneKey: key,
        triggeringSeat: key === null ? ctx.triggeringSeat : (state.zones[key]?.seat ?? ctx.triggeringSeat),
        promptAnswers: {},
        sourceCardId: null, // a tester's move is not a rule; each binding stamps its own below
      });
      if (from) fireRoot(state, 'onZoneExit', cardCtx(from));
      fireRoot(state, 'onZoneEnter', cardCtx(to));
      // onCardDrawn belongs to the drawCards effect alone (§4.7) — a tester's move is a play.
      fireRoot(state, 'onCardPlayed', cardCtx(to));
      return MORE;
    }

    case 'flipCard':
    case 'rotateCard': {
      const card = state.cards[action.cardId];
      if (!card) return reject('TARGET_GONE', `${action.kind} ${action.cardId}: card no longer exists.`);
      const field = action.kind === 'flipCard' ? 'faceDown' : 'rotated';
      const before = card[field];
      const after =
        action.to === 'toggle' ? !before : action.to === 'faceDown' || action.to === 'rotated';
      card[field] = after;
      log(lines, {
        level: 'info',
        kind: 'change',
        message: `${action.kind} ${action.cardId}: ${before} → ${after}.`,
        change: { path: `cards/${action.cardId}/${field}`, before, after },
      });
      return MORE;
    }

    case 'transition': {
      // applyTransition checks both sides of the edge, honours override and logs the outcome.
      const done = applyTransition(
        makeEc(state, def, lines, ctx, 0, null, override, null, null),
        action.toStateId,
        { forced: false }
      );
      return done.ok ? MORE : DONE;
    }

    case 'fireEvent': {
      fireRoot(state, action.name, { ...ctx, triggeringSeat: action.seat ?? ctx.triggeringSeat });
      return MORE;
    }

    case 'answerPrompt': {
      const pending = state.interaction;
      if (!pending) return reject('INVALID_ANSWER', 'Prompt answer ignored: no prompt is pending.');
      // Trust boundary: UI highlighting is not enforcement (§9.3). `validateAnswer` is pure and
      // owns the detail strings, so a rejected answer leaves the suspension untouched.
      const verdict = validateAnswer(pending, action.chosen);
      if (!verdict.ok) return reject(verdict.reason, verdict.detail ?? verdict.reason, SUSPENDED);

      const head = top(state);
      if (head?.kind !== 'rule') {
        return reject('INVALID_ANSWER', 'Prompt answer ignored: the suspended effect is gone.', SUSPENDED);
      }
      head.ctx.promptAnswers[pending.promptId] = [...action.chosen];
      clear(state);
      log(lines, {
        level: 'info',
        kind: 'prompt',
        depth: head.depth,
        ruleId: head.ruleId,
        message: `Prompt "${pending.promptText}" (seat ${pending.seat}) answered: ${action.chosen.join(', ')}.`,
      });
      return MORE;
    }

    case 'cancelPrompt': {
      const pending = state.interaction;
      if (!pending) return reject('PROMPT_CANCELED', 'Cancel ignored: no prompt is pending.');
      const head = top(state);
      clear(state);
      log(lines, {
        level: 'reject',
        kind: 'prompt',
        message: `Prompt "${pending.promptText}" (seat ${pending.seat}): canceled by tester.`,
      });
      // Not an override, and not flagged as one. The RuleSet then continues or aborts per
      // onRejection (§5.9 row 8b) — resuming at the SAME cursor would just re-raise the prompt.
      if (head?.kind === 'rule') {
        const rule = indexOf(def).rules.get(head.ruleId);
        if (rule && rule.onRejection === 'continue') head.cursor += 1;
        else head.aborted = true;
      }
      return MORE;
    }
  }
}

// ---------------------------------------------------------------------------

/** Exactly ONE unit of work per call. §3.2. */
export function step(
  state: PlayState,
  input: EngineInput,
  lines: LogLine[],
  def: GameDefinition
): StepResult {
  return input.kind === 'action'
    ? applyAction(state, input.action, input.override, def, lines)
    : advance(state, def, lines);
}
