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
  type Interaction,
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
  pushLine,
  tagVerbosity,
} from './types';
import { evalCriteria } from './criteria';
import { scanContinuous } from './continuous';
import { applyEffect, canMove, type EffectContext } from './effects';
import { zoneAudience } from './visibility';
import { appendPending, pop, promotePending, push, top } from './frames';
import {
  clear,
  isResuming,
  isSuspended,
  promptIdOf,
  raise,
  validateAnswer,
  validateNumberAnswer,
  validateOptionAnswer,
  validateSeatAnswer,
} from './interaction';
// v2 §4.7, §4.8 — step 22. `pending.ts` owns the `resolve` frame's body; this module only wires it
// into the `advance()` switch, the same way it wires `event`/`rule`/`settle`.
import { actionTargetKey, advanceResolve } from './pending';
// v2 §4.6, §4.7, §5.5 — step 24. `priority.ts` owns the `priority` frame's body and the
// `passPriority` action; this module only wires both into `advance()`/`applyAction`.
import { advancePriority, passPriority } from './priority';
// v2 §4.12, §5.8 — step 25. `activation.ts` owns the `activate` action's body; v4 §4.5 adds the
// `activation` frame's, for a cost that has to stop and ask something.
import { activateRule, advanceActivation } from './activation';
import { applyTransition, findAutoTransition } from './stateMachine';
import { CHOSEN_PROMPT_KEY, resolveTargets } from './targets';
import { resolveSeat, resolveValueRef, zoneKey } from './valueRef';

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
  pushLine(lines, { change: null, ruleId: null, effectKind: null, depth: 0, visibility: null, ...entry });
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
// v4 §4.6 (G8) — the modal branch queue. One level per `chooseMode` whose chosen branch is
// mid-flight on the frame; see `RuleFrame.branch`'s own comment in types.ts for why it is a PATH
// rather than a copied `Effect[]`.
// ---------------------------------------------------------------------------

/** The effect list a `rule` frame is ACTUALLY executing, and the position in it. */
interface Slot {
  effects: readonly Effect[];
  index: number;
  /** True while any branch level is open — the one flag three collision-sensitive decisions read. */
  inBranch: boolean;
}

/**
 * Walk `frame.branch` down to the innermost live effect list. `rule.effects` at `frame.cursor` when
 * no branch is open, which is every frame that never met a `chooseMode`.
 *
 * `null` when the recorded path no longer names a `chooseMode` with that mode. Unreachable while a
 * `GameDefinition` is immutable for a session's lifetime (it is — `step()` takes it as a parameter
 * and never writes to it) and while `runEffect` only ever pushes a level for a mode it just
 * validated. Reported rather than guessed at, because the plausible guess — fall back to the
 * enclosing cursor — re-runs the host `chooseMode` forever.
 */
function slotOf(frame: RuleFrame, rule: RuleSet): Slot | null {
  let effects: readonly Effect[] = rule.effects;
  let index = frame.cursor;
  for (const level of frame.branch ?? []) {
    const host = effects[index];
    if (host?.kind !== 'chooseMode') return null;
    const mode = host.modes[level.mode];
    if (!mode) return null;
    effects = mode.effects;
    index = level.cursor;
  }
  return { effects, index, inBranch: (frame.branch?.length ?? 0) > 0 };
}

/**
 * Advance the cursor that is actually driving execution — the innermost branch level's, or the
 * frame's own.
 *
 * Every "this effect is finished with, move on" site goes through here, which is the whole reason a
 * branch effect needs no special handling anywhere else: a completed effect, a skipped one, a
 * cancelled prompt and an unresolvable choice all advance the SAME cursor whether the effect came
 * from `rule.effects` or from a mode's branch (v4 §4.6).
 */
function bumpCursor(frame: RuleFrame): void {
  const inner = frame.branch?.at(-1);
  if (inner) inner.cursor += 1;
  else frame.cursor += 1;
}

/**
 * The prompt id for the effect at `slot`, unique per branch POSITION.
 *
 * `promptIdOf`'s `${logSeq}:${ruleId}:${effectIndex}` is unique per top-level effect, and re-entry
 * recognises "already answered" by recomputing it — but every effect in a branch shares one
 * `frame.cursor`, so without the path suffix the first branch effect's answer would satisfy the
 * second's check and the second prompt would never be raised. `#<mode>.<cursor>` per level; no plain
 * promptId and no reserved key (`@chosen`, `@actionTarget:<i>`, `@costTarget:<i>`) contains a `#`.
 */
function slotPromptId(state: PlayState, ruleId: Id, frame: RuleFrame): string {
  const base = promptIdOf(state, ruleId, frame.cursor);
  return (frame.branch ?? []).reduce((id, level) => `${id}#${level.mode}.${level.cursor}`, base);
}

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

export function makeEc(
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[],
  ctx: TriggerContext,
  depth: number,
  parentId: number | null,
  override: boolean,
  ruleId: Id | null,
  effectKind: Effect['kind'] | null,
  // v2 §4.8, step 22/23 — this effect's position in `rule.effects`, i.e. `frame.cursor` at the one
  // call site that has a `rule` frame (`runEffect`, below). Every other caller omits it, which is
  // exactly what tells `effects.ts`'s `resolveEffectTargets` a frozen-target lookup cannot apply.
  effectIndex?: number
): EffectContext {
  return {
    state,
    def,
    ctx,
    depth,
    override,
    effectIndex,
    // v2 §4.6, §4.7 — the enclosing `rule` frame's own id, so an effect that pushes a frame directly
    // (`priority.ts`'s `openPriorityWindow`) can set `parentId` correctly. See EffectContext's own
    // doc comment in effects.ts.
    parentId,
    // Filling in a null ruleId/effectKind is this module's job — effects.ts does not know which
    // RuleSet is driving it, and H2 requires every change line to name one.
    log: (l) =>
      pushLine(lines, { ...l, ruleId: l.ruleId ?? ruleId, effectKind: l.effectKind ?? effectKind }),
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

/**
 * The effects that carry a target; only a target CONTAINING a prompt suspends.
 *
 * §4.4 lets `matching` wrap the prompt, so the prompt is not always the outermost selector. Both
 * halves are returned because both are needed and neither substitutes for the other: the WHOLE
 * target is what resolves (so a `matching` around the prompt narrows the highlighted legal set —
 * there is no second targeting language), while the inner `prompt` carries the text the "0 legal
 * targets" line has to name before anything has resolved.
 */
function promptTarget(
  effect: Effect
): { target: TargetSelector; prompt: Extract<TargetSelector, { kind: 'prompt' }> } | null {
  if (!('target' in effect)) return null;
  const inner = (s: TargetSelector): Extract<TargetSelector, { kind: 'prompt' }> | null =>
    s.kind === 'prompt' ? s : s.kind === 'matching' ? inner(s.from) : null;
  const prompt = inner(effect.target);
  return prompt === null ? null : { target: effect.target, prompt };
}

const promptSeat = (state: PlayState, ctx: TriggerContext) => ctx.triggeringSeat ?? activeSeat(state);

/**
 * v2 §4.9 — `promptText`/`seat` are common to FOUR of the six `Interaction` arms, not all six:
 * `priority` has no `promptText` and `sealed` has no singular `seat` (§4.9). The three messages
 * below used to read `interaction.promptText`/`.seat` unconditionally, which only worked while
 * `chooseCards` was the only arm that could exist — exactly the §8 trap this file's own comments
 * warn about elsewhere. `null` for the two that lack them; neither can be raised yet in this wave
 * (steps 24/29), so the fallback text at each call site below is never exercised today.
 */
function promptFields(interaction: Interaction): { promptText: string; seat: number } | null {
  switch (interaction.kind) {
    case 'chooseCards':
    case 'chooseOption':
    case 'chooseNumber':
    case 'chooseSeat':
      return { promptText: interaction.promptText, seat: interaction.seat };
    case 'priority':
    case 'sealed':
      return null;
  }
}

/** `"X" (seat N)` — the shared shape `answerPrompt`/`cancelPrompt`'s log lines quote. */
function promptLabel(interaction: Interaction): string {
  const fields = promptFields(interaction);
  return fields ? `"${fields.promptText}" (seat ${fields.seat})` : `"${interaction.kind}"`;
}

/**
 * v4 §4.5.0(a) — the frame an answer resumes INTO, and the one place that decides which kinds those
 * are.
 *
 * Every one of the five answer arms in `applyAction` used to narrow `top(state)` to `kind === 'rule'`
 * itself, five times over. A suspended activation COST is held by an `activation` frame instead (a
 * `rule` frame exists only for the ability's own effects, and is not pushed until the cost is paid),
 * so all five have to accept either — and both carry the three fields they need: `ctx` to write the
 * answer into, plus `ruleId`/`depth` for the log line. Widening once here is what keeps the fifth
 * copy from being the one that gets forgotten.
 */
type AnswerFrame = Extract<Frame, { kind: 'rule' | 'activation' }>;

function answerFrame(state: PlayState): AnswerFrame | null {
  const head = top(state);
  return head !== undefined && (head.kind === 'rule' || head.kind === 'activation') ? head : null;
}

/** Write the answer where the suspended frame will find it on re-entry, clear, log, resume. */
function recordAnswer(
  state: PlayState,
  head: AnswerFrame,
  promptId: string,
  answer: Id[],
  lines: LogLine[],
  message: string
): StepResult {
  head.ctx.promptAnswers[promptId] = answer;
  clear(state);
  log(lines, { level: 'info', kind: 'prompt', depth: head.depth, ruleId: head.ruleId, message });
  return MORE;
}

/**
 * v4 §4.5 — resolve and raise ONE `chooseNumber`/`chooseSeat` interaction, with no frame in sight.
 *
 * Two callers now need this: `raiseChoice` below, from a `rule` frame's cursor, and `activation.ts`'s
 * cost freeze pass, from an `activation` frame. The resolution rules are identical in both (exactly
 * one seat asked; integral bounds), and what DIFFERS is only what a failure means — skip this one
 * effect per `onRejection`, or refuse the whole cost — so the failure is returned rather than acted
 * on, and the caller logs it at its own depth/ruleId. The alternative was a second copy of the
 * min/max resolution in `activation.ts`, which is the drift §3.3 keeps single-definition helpers for.
 */
export function raiseValueChoice(
  effect: Extract<Effect, { kind: 'chooseNumber' | 'chooseSeat' }>,
  promptId: string,
  state: PlayState,
  def: GameDefinition,
  ctx: TriggerContext
): { ok: true; seat: number } | { ok: false; reason: RejectReason; message: string } {
  const bad = (reason: RejectReason, message: string) => ({ ok: false as const, reason, message });
  const seats = resolveSeat(effect.seat, state, ctx);
  if (!seats.ok) return bad(seats.reason, `${effect.kind} "${effect.promptText}": ${seats.message}`);
  if (seats.seats.length !== 1) {
    return bad(
      'INVALID_SEAT',
      `${effect.kind} "${effect.promptText}": seat ref resolved to ${seats.seats.length} seats; expected exactly one.`
    );
  }
  const seat = seats.seats[0];

  if (effect.kind === 'chooseSeat') {
    // v4 §4.3 (G3) — candidates are the LIVE ring: `seatOrder`, never 0..playerCount-1, so an
    // eliminated seat is not offered (§4.1's named trap). An empty ring cannot happen while a rule is
    // running, but a one-seat ring can — "target player" with only yourself left is a legal, if
    // pointless, question.
    if (state.seatOrder.length === 0) {
      return bad('NO_TARGETS', `chooseSeat "${effect.promptText}": no seats remain to choose from.`);
    }
    raise(state, { kind: 'chooseSeat', promptId, promptText: effect.promptText, seat, candidates: [...state.seatOrder] });
    return { ok: true, seat };
  }

  const min = resolveValueRef(effect.min, state, ctx, def);
  if (!min.ok) return bad(min.reason, `chooseNumber "${effect.promptText}": min — ${min.message}`);
  if (min.values.length !== 1 || typeof min.values[0] !== 'number') {
    return bad('TYPE_MISMATCH', `chooseNumber "${effect.promptText}": min did not resolve to a single number.`);
  }
  const max = resolveValueRef(effect.max, state, ctx, def);
  if (!max.ok) return bad(max.reason, `chooseNumber "${effect.promptText}": max — ${max.message}`);
  if (max.values.length !== 1 || typeof max.values[0] !== 'number') {
    return bad('TYPE_MISMATCH', `chooseNumber "${effect.promptText}": max did not resolve to a single number.`);
  }
  raise(state, {
    kind: 'chooseNumber',
    promptId,
    promptText: effect.promptText,
    seat,
    min: min.values[0],
    max: max.values[0],
  });
  return { ok: true, seat };
}

/**
 * v2 §4.5, §5.5, §5.11, steps 28/29 (v4 §4.3 adds `chooseSeat`) — the raise half of
 * `chooseMode`/`chooseNumber`/`chooseSeat`/`sealedChoice`'s
 * suspension. Parallels the `TargetSelector`-prompt block in `runEffect` below: resolve whatever the
 * interaction needs, raise it (or push the `sealed` frame and raise), log, and leave the cursor
 * untouched (§3.3 — raise before mutate). A resolution failure (a bad seat ref, a non-numeric
 * min/max) is NOT a suspend — it is a rule-legal refusal of just this ONE effect, handled exactly
 * like "0 legal targets" above: `onRejection` decides whether the RULE aborts or continues past it.
 */
function raiseChoice(
  frame: RuleFrame,
  rule: RuleSet,
  effect: Extract<Effect, { kind: 'chooseMode' | 'chooseNumber' | 'chooseSeat' | 'sealedChoice' }>,
  promptId: string,
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[]
): StepResult {
  const fail = (reason: RejectReason, message: string): StepResult => {
    log(lines, {
      level: levelFor(reason),
      kind: 'prompt',
      depth: frame.depth,
      ruleId: rule.id,
      effectKind: effect.kind,
      message,
    });
    // v4 §4.6 — `bumpCursor`, not `frame.cursor += 1`: an unresolvable choice inside a modal branch
    // skips that branch effect, exactly as it skips a top-level one. `abort` still aborts the whole
    // frame, branch and all — see `runEffect`'s own rejection path for why that is the same rule.
    if (rule.onRejection === 'abort') frame.aborted = true;
    else bumpCursor(frame);
    return MORE;
  };

  if (effect.kind === 'sealedChoice') {
    const seats = resolveSeat(effect.seats, state, frame.ctx);
    if (!seats.ok) return fail(seats.reason, `sealedChoice "${effect.choiceId}": ${seats.message}`);
    if (seats.seats.length === 0) {
      return fail('NO_TARGETS', `sealedChoice "${effect.choiceId}": no seats resolved.`);
    }
    // Pushed ON TOP of this very `rule` frame — dispatch's `advance()` processes the `sealed` frame
    // next, and this `rule` frame resumes (from the SAME cursor) once it pops (§5.11, `submitSealed`).
    push(state, { kind: 'sealed', choiceId: effect.choiceId, parentId: frame.id, depth: frame.depth });
    raise(state, {
      kind: 'sealed',
      promptId,
      choiceId: effect.choiceId,
      seats: seats.seats,
      options: effect.options,
      submitted: {},
    });
    log(lines, {
      level: 'info',
      kind: 'prompt',
      depth: frame.depth,
      ruleId: rule.id,
      effectKind: effect.kind,
      // Opening the choice names WHO is in it, never what anyone will pick — §5.11 rule 1 governs
      // submission, not this line, but nothing here reveals a value either.
      message: `Sealed choice "${effect.choiceId}" opened for seats ${seats.seats.join(', ')}.`,
    });
    return SUSPENDED;
  }

  if (effect.kind === 'chooseNumber' || effect.kind === 'chooseSeat') {
    const raised = raiseValueChoice(effect, promptId, state, def, frame.ctx);
    if (!raised.ok) return fail(raised.reason, raised.message);
    log(lines, {
      level: 'info',
      kind: 'prompt',
      depth: frame.depth,
      ruleId: rule.id,
      effectKind: effect.kind,
      message: `Prompt "${effect.promptText}" (seat ${raised.seat}): raised.`,
    });
    return SUSPENDED;
  }

  const seats = resolveSeat(effect.seat, state, frame.ctx);
  if (!seats.ok) return fail(seats.reason, `${effect.kind} "${effect.promptText}": ${seats.message}`);
  if (seats.seats.length !== 1) {
    return fail(
      'INVALID_SEAT',
      `${effect.kind} "${effect.promptText}": seat ref resolved to ${seats.seats.length} seats; expected exactly one.`
    );
  }
  const seat = seats.seats[0];

  raise(state, {
    kind: 'chooseOption',
    promptId,
    promptText: effect.promptText,
    seat,
    options: effect.modes.map((m, idx) => ({ id: String(idx), label: m.label })),
  });
  log(lines, {
    level: 'info',
    kind: 'prompt',
    depth: frame.depth,
    ruleId: rule.id,
    effectKind: effect.kind,
    message: `Prompt "${effect.promptText}" (seat ${seat}): raised.`,
  });
  return SUSPENDED;
}

/**
 * ONE effect — the one at `slot` — then the cursor moves. v1 ran the whole remaining list
 * per `step()`; v2 runs one (§3.2). Observable state is identical, only the number of `step()`
 * calls changes, and the store loops until `done`.
 *
 * The cursor is advanced by exactly one of three exits: the effect completed, the effect was
 * skipped, or the frame was aborted. A SUSPENDED return advances nothing — see below.
 *
 * v4 §4.6 (G8) — "the cursor" is `slot`'s, which is the innermost open modal branch's when there is
 * one. A branch effect is otherwise treated as *the same thing* as a top-level effect: it raises its
 * own interactions here, suspends by leaving its own cursor alone, and resumes into the next effect
 * of its own list. Two differences, both about not aliasing a frozen selection made elsewhere — see
 * `inBranch`'s two uses below.
 */
function runEffect(
  frame: RuleFrame,
  rule: RuleSet,
  slot: Slot,
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[]
): StepResult {
  const i = slot.index;
  const effect = slot.effects[i];
  const selector = promptTarget(effect);
  const promptId = slotPromptId(state, rule.id, frame);
  let chosen: Id[] | undefined;

  if (selector) {
    // v2 §4.8's carried-over fix (§8 step 24) — a target already FROZEN by `announceAction` (this
    // effect is being run by a `resolve` frame, at its own position in the announced rule's
    // `effects`) is an answer too, under `pending.ts`'s reserved key rather than this one. Without
    // this, a rule whose OWN top-level effect target is (or wraps) a `prompt` would ask a SECOND,
    // live prompt at resolve time regardless of what was frozen at announce time — exactly the
    // silent re-aiming §4.8 exists to prevent, just delayed instead of skipped.
    //
    // v4 §4.6 — the frozen-target fallback is read ONLY outside a branch. `@actionTarget:<i>` is
    // keyed by position in the ANNOUNCED rule's `rule.effects`, and a branch effect's `i` indexes a
    // mode's own list; consulting it there would hand a branch effect whatever the announced rule's
    // i-th effect froze. (`@costTarget:<i>` cannot reach here at all — `activation.ts` is the only
    // reader of that key — but it is keyed the same way and the same reasoning covers it.)
    chosen = frame.ctx.promptAnswers[promptId] ?? (slot.inBranch ? undefined : frame.ctx.promptAnswers[actionTargetKey(i)]);
    if (chosen === undefined) {
      // §3.3 hard rule: raise BEFORE any mutation. This effect executes twice — once to raise, once
      // to complete — so it must be re-entrant by construction.
      const candidates = resolveTargets(selector.target, state, frame.ctx, def, (line) =>
        // §5.9 level 3 — a `matching` around the prompt logs why each candidate is (not) offered.
        log(lines, {
          level: 'info',
          kind: line.kind,
          depth: frame.depth,
          ruleId: rule.id,
          effectKind: effect.kind,
          message: line.message,
        })
      );
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
          message: `Prompt "${selector.prompt.promptText}" (seat ${promptSeat(state, frame.ctx)}): ${
            candidates.ok ? '0 legal targets' : candidates.message
          } Prompt skipped.`,
        });
        if (rule.onRejection === 'abort') frame.aborted = true;
        else bumpCursor(frame);
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

  // v2 §4.5, §5.11, steps 28/29 (v4 §4.3 adds `chooseSeat`) — `chooseMode`/`chooseNumber`/
  // `chooseSeat`/`sealedChoice` all suspend WITHOUT a
  // `target: TargetSelector` (`selector` above is null for every one of them), so they get their own
  // raise-before-mutate dance here, parallel to the block above. `promptId` is the SAME formula
  // either way, which is what lets re-entry (after the answer/reveal lands) recognise "already
  // resolved" through the SAME `frame.ctx.promptAnswers[promptId]` check `chooseCards` uses.
  if (
    !selector &&
    (effect.kind === 'chooseMode' ||
      effect.kind === 'chooseNumber' ||
      effect.kind === 'chooseSeat' ||
      effect.kind === 'sealedChoice')
  ) {
    chosen = frame.ctx.promptAnswers[promptId];
    if (chosen === undefined) {
      return raiseChoice(frame, rule, effect, promptId, state, def, lines);
    }
    if (effect.kind === 'sealedChoice') {
      // `submitSealed` already did EVERYTHING — recorded, revealed, logged, cleared the interaction,
      // popped the `sealed` frame, and wrote this very marker. Nothing is left to apply; `effects.ts`
      // is deliberately never reached for this kind from the top level (see its own comment) — nor,
      // since v4 §4.6, from inside a modal branch either.
      bumpCursor(frame);
      return MORE;
    }
    if (effect.kind === 'chooseNumber' || effect.kind === 'chooseSeat') {
      // Persist under the AUTHORED key too, not just `promptId` — `promptId` only proves resumption;
      // this is what makes a LATER effect's `ValueRef{kind:'promptNumber', key}` (or v4 §4.3's
      // `SeatRef{kind:'promptSeat', key}`) resolve. `frame.ctx` is the real, rewound object — unlike
      // the `effectCtx` copy built below for the CURRENT effect only — so this write outlives this
      // one application.
      frame.ctx.promptAnswers[effect.key] = [...chosen];
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
    //
    // v4 §4.6 — `effectIndex` is UNDEFINED for a branch effect, which is the second half of the
    // frozen-target isolation above and the half that reaches `effects.ts`: it is what makes
    // `resolveEffectTargets`'s `@actionTarget:<i>` lookup structurally unable to fire, so two branch
    // effects at different positions cannot alias one frozen announce key. Same discipline
    // `activation.ts`'s `applyCost` uses for a cost effect, and for the same reason.
    makeEc(state, def, lines, effectCtx, frame.depth, frame.id, false, rule.id, effect.kind, slot.inBranch ? undefined : i)
  );
  // v2 §4.8's carried-over fix — `announceAction` can now suspend INTERNALLY (raising its own
  // interaction before it has frozen anything, mirroring the raise-before-mutate rule above) rather
  // than only through this function's own top-of-function `target`-prompt path. This check is what
  // makes that possible without a second copy of the suspend/resume machinery: nothing else in this
  // file ever calls `raise()` from inside `applyEffect`, so for every OTHER effect kind
  // `isSuspended(state)` is unconditionally false here and this branch never fires.
  if (isSuspended(state)) {
    return SUSPENDED;
  }
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
    //
    // v4 §4.6 — `onRejection` inside a modal branch is the SAME policy it is outside one, deliberately:
    // it is a property of the RULE ("on a failed effect, abort me / carry on"), not of the effect
    // list an effect happens to sit in. So `abort` aborts the whole frame — the rest of the branch
    // AND the rest of the rule, since `advanceRule` pops an aborted frame and the branch path dies
    // with it — while `continue` (below) skips just the failed effect and runs the next one in the
    // branch. Deciding otherwise would mean a branch-local abort, i.e. two rejection policies to
    // author against with nothing in `RuleSet` to distinguish them.
    if (rule.onRejection === 'abort') {
      log(lines, {
        level: 'info',
        kind: 'skip',
        depth: frame.depth,
        ruleId: rule.id,
        message: `RuleSet "${rule.name}" aborted after ${slot.inBranch ? 'modal-branch ' : ''}effect ${i + 1} of ${slot.effects.length}.`,
      });
      frame.aborted = true;
      return MORE;
    }
  } else if (effect.kind === 'chooseMode' && chosen !== undefined) {
    // v4 §4.6 (G8) — THE change. `effects.ts` has validated the answer and logged the chosen mode;
    // its effects now become queued work on this frame, one per `step()`, through the very cursor
    // machinery that already makes a top-level effect suspendable. The frame's OWN cursor stays on
    // the `chooseMode` (so `slotOf` can re-derive the path) and is advanced past it by
    // `advanceRule`'s branch-exhausted arm once the level pops.
    if (!frame.branch) frame.branch = [];
    frame.branch.push({ mode: Number(chosen[0]), cursor: 0 });
    return MORE;
  }
  bumpCursor(frame);
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

  // v4 §4.6 (G8) — which list is being executed: `rule.effects` normally, or the innermost open
  // modal branch. `frame.cursor` stays parked ON the `chooseMode` for as long as its branch runs,
  // which is why the end-of-rule check above cannot fire mid-branch.
  const slot = slotOf(frame, rule);
  if (!slot) {
    log(lines, {
      level: 'error',
      kind: 'skip',
      depth: frame.depth,
      ruleId: rule.id,
      message: `RuleSet "${rule.name}": modal branch path ${JSON.stringify(frame.branch)} no longer names a chooseMode mode. Aborted.`,
    });
    frame.branch = undefined;
    frame.aborted = true;
    return MORE;
  }
  if (slot.index >= slot.effects.length) {
    // The branch ran out. Pop the level and let the ENCLOSING cursor move past its `chooseMode` —
    // `bumpCursor` after the pop targets exactly that, whether the enclosing list is another branch
    // or `rule.effects` itself. (Unreachable with no branch open: the check above already popped.)
    frame.branch?.pop();
    if (frame.branch?.length === 0) frame.branch = undefined;
    bumpCursor(frame);
    return MORE;
  }

  return runEffect(frame, rule, slot, state, def, lines);
}

/**
 * Shared by both settle slots (§5.3): re-entering settle — whether slot 1 fired a continuous rule or
 * slot 2 fired an auto-transition — costs one `settleIterations` tick against the SAME bound, so a
 * fixpoint alternating between the two slots trips exactly as fast as one that loops inside a single
 * slot. Returns the halt result when the cap is exceeded, `null` when it is fine to continue.
 */
function bumpSettleIterations(state: PlayState, def: GameDefinition, lines: LogLine[]): StepResult | null {
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
  return null;
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

  // ---- Slot 1: continuous-condition fixpoint scan (§5.6, v2 step 26). ----
  // "a creature with lethal damage dies" and "a player at zero pool is ousted" must both land before
  // slot 2 decides whether the phase is over — that ordering is the entire reason this is slot 1.
  // `continuous.ts` owns the scan itself (bindings, §5.1 order, the fired/cleared bookkeeping);
  // this only wires it into the settle sequence and shares slot 2's own re-entry/divergence bound,
  // so a fixpoint that never settles halts identically regardless of which slot is looping.
  if (scanContinuous(state, def)) {
    const halted = bumpSettleIterations(state, def, lines);
    return halted ?? MORE; // re-enter settle once the newly-pushed rule frame(s) drain.
  }

  // ---- Slot 2: auto-transition scan (v1 §5.6, unchanged). ----
  const auto = findAutoTransition(state, def, baseCtx(state));

  // ---- Slot 3: nothing fired, so the world is settled and the transaction commits. ----
  if (!auto) return DONE;

  const halted = bumpSettleIterations(state, def, lines);
  if (halted) return halted;

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
    // v2 §4.7, §4.8 — step 22. `pending.ts`'s `advanceResolve` owns the body.
    case 'resolve':
      return advanceResolve(frame, state, def, lines);
    // v2 §4.7, §4.6, §5.5 — step 24. `priority.ts` owns the body.
    case 'priority':
      return advancePriority(frame, state, def, lines);
    // v2 §4.7, §5.11, step 29 — genuinely unreachable in normal play: `raiseChoice` always pairs
    // pushing this frame with raising the matching `Interaction`, so `isSuspended` at the top of this
    // function returns SUSPENDED before this switch is ever reached while the choice is open, and
    // `submitSealed` pops the frame in the SAME action that clears the interaction once resolved.
    // Kept as a named, non-throwing recovery — matching `pending.ts`'s `advanceResolve` precedent for
    // "nothing in this wave can reach this" — rather than a throw, in case a future caller ever pushes
    // one without following that pairing.
    case 'sealed':
      pop(state);
      log(lines, {
        level: 'error',
        kind: 'skip',
        depth: frame.depth,
        message: `Sealed choice "${frame.choiceId}": frame reached advance() with no open Interaction — popped defensively.`,
      });
      return MORE;
    // v4 §4.5 — step 6. `activation.ts` owns the body: one more pass at the cost, which either raises
    // the next question it needs, pays the whole thing, or refuses it.
    case 'activation':
      return advanceActivation(frame, state, def, lines);
  }
}

// ---------------------------------------------------------------------------
// v2 §4.12, §5.5 — `passPriority` and a priority-window `activate` response are RESUMES of an
// already-open transaction, exactly like `answerPrompt`/`cancelPrompt`, but `isResuming` (which
// `sessionStore.ts` also reads) cannot classify them from the action alone: `activate` is legal
// BOTH as a fresh top-level action (a sorcery-speed ability, no window open) and as a response to an
// open `priority` interaction, and only the CURRENT `state.interaction` tells the two apart. Kept
// local to this file rather than widening `interaction.ts`'s exported `isResuming` — `sessionStore.
// ts`'s OWN `!resuming && !isSuspended(...)` guard already refuses to bump `logSeq` whenever an
// interaction is genuinely open, regardless of this predicate, so nothing there needs to agree with
// it (§8 step 24's own report works through why in detail).
// ---------------------------------------------------------------------------

function isPriorityResume(state: PlayState, action: PlayAction): boolean {
  return state.interaction?.kind === 'priority' && (action.kind === 'passPriority' || action.kind === 'activate');
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
  const resuming = isResuming(action) || isPriorityResume(state, action);
  if (state.interaction && !resuming) {
    // Row 9, widened from "a card prompt" to ANY interaction. Rewind is the store's job and never
    // reaches step().
    const fields = promptFields(state.interaction);
    return reject(
      'AWAITING_PROMPT',
      `Input ignored: awaiting response to ${fields ? `prompt "${fields.promptText}"` : `interaction "${state.interaction.kind}"`}.`,
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
    // v2 §5.5 — same "per transaction, not per dispatch()" scope as the three counters above.
    if (state.budget.priorityRounds !== 0) state.budget.priorityRounds = 0;
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
        // v2 §3.6, §4.10, §6.2 — the RESULTING zone governs: a card entering a hidden zone is
        // unnamed to everyone but that zone's audience; a card leaving one into a public zone is
        // fully knowable from the public zone alone, so it stays public. `from`'s own visibility
        // doesn't additionally restrict it — see visibility.ts's `zoneAudience` doc comment.
        visibility: zoneAudience(def, to),
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

      const head = answerFrame(state);
      if (!head) {
        return reject('INVALID_ANSWER', 'Prompt answer ignored: the suspended effect is gone.', SUSPENDED);
      }
      return recordAnswer(
        state,
        head,
        pending.promptId,
        [...action.chosen],
        lines,
        `Prompt ${promptLabel(pending)} answered: ${action.chosen.join(', ')}.`
      );
    }

    case 'cancelPrompt': {
      const pending = state.interaction;
      if (!pending) return reject('PROMPT_CANCELED', 'Cancel ignored: no prompt is pending.');
      const head = top(state);
      clear(state);
      log(lines, {
        level: 'reject',
        kind: 'prompt',
        message: `Prompt ${promptLabel(pending)}: canceled by tester.`,
      });
      // v4 §4.5.0(a), AC SP18(c) — a cancelled COST spends nothing, and that is structural rather
      // than a rollback: the apply pass has not started, so not one cost effect has run and there is
      // nothing to take back. `onRejection` is not consulted — it governs a rule's own EFFECTS, and
      // none of them exist yet (the `rule` frame is pushed only once the cost is paid) — and resuming
      // at the same cost effect would only re-raise the very prompt that was just declined. So the
      // frame is popped and the activation is simply abandoned. MORE, not DONE: the `priority` frame
      // this activation was responding to (when there was one) is now the head again, with its cursor
      // and pass count exactly as this activation found them, so `advancePriority` re-offers the SAME
      // seat the same choices — declining to pay is not passing.
      if (head?.kind === 'activation') {
        pop(state);
        log(lines, {
          level: 'reject',
          kind: 'skip',
          depth: head.depth,
          ruleId: head.ruleId,
          message: `Activate "${indexOf(def).rules.get(head.ruleId)?.name ?? head.ruleId}": cost canceled — nothing spent.`,
        });
        return MORE;
      }
      // Not an override, and not flagged as one. The RuleSet then continues or aborts per
      // onRejection (§5.9 row 8b) — resuming at the SAME cursor would just re-raise the prompt.
      // v4 §4.6 — `bumpCursor` so cancelling a prompt raised by a MODAL BRANCH effect skips that
      // branch effect and runs the next one, rather than skipping the whole `chooseMode`.
      if (head?.kind === 'rule') {
        const rule = indexOf(def).rules.get(head.ruleId);
        if (rule && rule.onRejection === 'continue') bumpCursor(head);
        else head.aborted = true;
      }
      return MORE;
    }

    // v2 §4.12, §5.8 — step 25. `activation.ts` owns the body.
    case 'activate':
      return activateRule(state, def, action, lines, override);
    // v2 §4.12, §5.5 — step 24. `priority.ts` owns the body.
    case 'passPriority':
      return passPriority(state, def, lines);

    // -----------------------------------------------------------------------
    // v2 §4.9, §4.12, step 28 — mirrors `answerPrompt` exactly: validate against the pinned
    // interaction (pure, so a rejected answer leaves the suspension untouched), write the answer
    // into the suspended `rule` frame's own `ctx.promptAnswers` (keyed by ITS `promptId`, so
    // `runEffect` recognises "already answered" on re-entry), clear, log, resume.
    case 'answerOption': {
      const pending = state.interaction;
      if (!pending) return reject('INVALID_ANSWER', 'Answer ignored: no prompt is pending.');
      const verdict = validateOptionAnswer(pending, action.optionId);
      if (!verdict.ok) return reject(verdict.reason, verdict.detail ?? verdict.reason, SUSPENDED);
      const head = answerFrame(state);
      if (!head) {
        return reject('INVALID_ANSWER', 'Answer ignored: the suspended effect is gone.', SUSPENDED);
      }
      return recordAnswer(
        state,
        head,
        pending.promptId,
        [action.optionId],
        lines,
        `Prompt ${promptLabel(pending)} answered: ${action.optionId}.`
      );
    }

    case 'answerNumber': {
      const pending = state.interaction;
      if (!pending) return reject('INVALID_ANSWER', 'Answer ignored: no prompt is pending.');
      const verdict = validateNumberAnswer(pending, action.value);
      if (!verdict.ok) return reject(verdict.reason, verdict.detail ?? verdict.reason, SUSPENDED);
      const head = answerFrame(state);
      if (!head) {
        return reject('INVALID_ANSWER', 'Answer ignored: the suspended effect is gone.', SUSPENDED);
      }
      return recordAnswer(
        state,
        head,
        pending.promptId,
        [String(action.value)],
        lines,
        `Prompt ${promptLabel(pending)} answered: ${action.value}.`
      );
    }

    // v4 §4.3 (G3) — reachable at last: the `chooseSeat` effect is the producer this arm waited two
    // waves for, and it needed no change to serve it. The answer lands under `pending.promptId` for
    // resumption; `runEffect` copies it to the authored `key` so `SeatRef{kind:'promptSeat'}` reads it.
    case 'answerSeat': {
      const pending = state.interaction;
      if (!pending) return reject('INVALID_ANSWER', 'Answer ignored: no prompt is pending.');
      const verdict = validateSeatAnswer(pending, action.seat);
      if (!verdict.ok) return reject(verdict.reason, verdict.detail ?? verdict.reason, SUSPENDED);
      const head = answerFrame(state);
      if (!head) {
        return reject('INVALID_ANSWER', 'Answer ignored: the suspended effect is gone.', SUSPENDED);
      }
      return recordAnswer(
        state,
        head,
        pending.promptId,
        [String(action.seat)],
        lines,
        `Prompt ${promptLabel(pending)} answered: seat ${action.seat}.`
      );
    }

    // -----------------------------------------------------------------------
    // v2 §4.9, §4.12, §5.11, step 29. §5.11's three rules, all enforced right here:
    //  1. NO log line while seats remain outstanding — the early `return SUSPENDED` below logs
    //     nothing at all.
    //  2. `interaction.submitted` only ever gains entries; nothing here (or anywhere else) lets one
    //     seat read another's before the reveal — that refusal lives in `visibility.ts`, consulted by
    //     the UI, not by this action (there is nothing secret in `PlayState` itself to leak from).
    //  3. Reveal walks `pending.seats` (the frame-push-time resolution order), never
    //     `Object.keys(pending.submitted)` (insertion/submission order) — so two sessions where the
    //     same two seats submit in opposite orders produce byte-identical state (§9.4(b)).
    case 'submitSealed': {
      const pending = state.interaction;
      if (!pending || pending.kind !== 'sealed') {
        return reject('INVALID_ANSWER', 'Submission ignored: no sealed choice is open.');
      }
      if (!pending.seats.includes(action.seat)) {
        return reject(
          'INVALID_ANSWER',
          `Submission ignored: seat ${action.seat} is not part of sealed choice "${pending.choiceId}".`,
          SUSPENDED
        );
      }
      if (action.seat in pending.submitted) {
        return reject('INVALID_ANSWER', `Submission ignored: seat ${action.seat} already submitted.`, SUSPENDED);
      }
      if (!pending.options.some((o) => o.id === action.optionId)) {
        return reject(
          'INVALID_ANSWER',
          `Submission invalid: "${action.optionId}" is not one of the offered options.`,
          SUSPENDED
        );
      }

      pending.submitted[action.seat] = action.optionId;

      if (Object.keys(pending.submitted).length < pending.seats.length) {
        // Rule 1 — still sealed. Nothing logged, nothing else touched.
        return SUSPENDED;
      }

      // Every seat is in — reveal. Rule 3: SEATS order, never submission order.
      const optionLabel = (id: string) => pending.options.find((o) => o.id === id)?.label ?? id;
      const parts = pending.seats.map((s) => `seat ${s} → ${optionLabel(pending.submitted[s])}`);
      log(lines, {
        level: 'info',
        kind: 'prompt',
        message: `Sealed choice "${pending.choiceId}" resolved: ${parts.join(', ')}.`,
      });

      clear(state);
      // The `sealed` frame is the top of the stack by construction — nothing can push above an open
      // interaction (§3.3's AWAITING_PROMPT gate blocks every action but the ones resuming it).
      const sealedFrame = pop(state);
      const head = top(state);
      if (sealedFrame?.kind === 'sealed' && head?.kind === 'rule') {
        // The marker `runEffect` checks for "already resolved" on re-entry — see its `sealedChoice`
        // branch, which advances the cursor and does nothing else once it finds this.
        head.ctx.promptAnswers[pending.promptId] = ['resolved'];
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
  // §5.9 — the level reaches the engine on BOTH `EngineInput` arms, since most lines are emitted
  // during CONTINUE re-entry rather than on the initiating action. Re-tagging every call is a no-op
  // in the common case (the level is constant for the whole transaction).
  tagVerbosity(lines, input.level ?? 3);
  return input.kind === 'action'
    ? applyAction(state, input.action, input.override, def, lines)
    : advance(state, def, lines);
}
