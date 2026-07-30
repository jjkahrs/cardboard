/**
 * `RuleSet.activation` and the `activate` action. TECHNICAL_DESIGN_V2.md §4.5, §4.12, §5.8, §9.4(e),
 * §9.5 edge case 12; TECHNICAL_DESIGN_V4.md §4.5 (G5) — the two-pass interactive cost.
 *
 * **v4 §4.5 — the two passes, and why the ban only NARROWED.** A cost may now ask a question: "discard
 * a card", "sacrifice a creature", "pay {X}". Paying it is therefore two passes over
 * `activation.cost`, not one:
 *
 *  1. **Freeze** (`freezeCost` below) — walk the cost effects and raise the first interaction any of
 *    them needs, recording each answer under the reserved key `@costTarget:<i>` and MUTATING NOTHING
 *    ELSE. Re-entrant across suspend and resume by construction: an effect whose key is already
 *    present is skipped on the next pass. This is `pending.ts`'s `announceAction` freeze pattern,
 *    copied deliberately — including its treatment of a prompt with zero legal candidates, which is
 *    left for pass 2 to refuse rather than special-cased here.
 *  2. **Apply** (`applyCost`) — once nothing further suspends, the whole cost runs under the SAME
 *    deep-copy probe-then-replay that has always guarded it (see below). Atomicity is untouched.
 *
 * Three kinds stay banned, in both `schema.ts` and here (v4 §4.5.0(c)): `chooseMode`, because WHICH
 * branch is chosen decides which sub-effects exist and freezing it means recursively freezing a tree
 * whose shape is not known until the answers arrive; `sealedChoice`, because it needs several seats to
 * submit and one seat's cost payment cannot drive that; and `openPriority`, because a priority window
 * inside a cost has no defensible resolution point. A fourth, `announceAction`, is not banned but can
 * suspend INTERNALLY (`pending.ts` raises its own target prompts) — the probe catches that by name,
 * see `applyCost`.
 *
 * **Where the answers live, and the collision that had to be avoided (v4 §4.5.0(d)).** `activation.cost`
 * and `rule.effects` are two different lists, both indexed from zero, and the ability's `rule` frame
 * inherits the very `ctx` object the cost used. So a cost answer frozen under any key `rule.effects`
 * also reads — `pending.ts`'s `@actionTarget:<i>`, or `interaction.ts`'s `${logSeq}:${ruleId}:<i>` —
 * would be read back by `rule.effects[i]` as ITS answer, silently aiming the ability's first effect at
 * whatever the cost selected. Hence `@costTarget:<i>`, which nothing else in the engine reads, and a
 * translation into a ONE-EFFECT copy of the context at apply time (`costEffectCtx`).
 *
 * **The one deliberate deviation from §5.8's literal wording, and why.** §5.8 says the cost runs "in
 * a nested produce" that is "discarded" on any rejection — i.e. an immer `produce`. That cannot be
 * implemented literally: the engine never imports immer (§3.2 — see the header comments at
 * `effects.ts:16` and `index.ts:4`; the engine only ever mutates a draft `sessionStore.ts` hands it).
 * Adding an immer import here to satisfy the letter of §5.8 would violate the rule §5.8's own
 * mechanism exists inside — §3.2 outranks it.
 *
 * §5.8's INTENT survives exactly: the cost is all-or-nothing, and nothing about a failed cost is ever
 * observable — no log line, no state change, no rewind point for it. Only the MECHANISM changes:
 *
 *  1. Take a plain deep copy of `PlayState` before the cost runs (`deepCopyState`, below) — a
 *     `JSON.parse(JSON.stringify(state))` round trip. This is sufficient and honest specifically
 *     BECAUSE `PlayState` is pure JSON data by construction (§4.10: "everything rewindable, and
 *     nothing else" — no `Map`, no `Date`, no class instance, nothing a JSON round trip would drop).
 *     `activation.test.ts` pins that invariant directly: the day someone adds a `Map` or a `Date` to
 *     `PlayState`, that test fails LOUDLY (a `Map` round-trips through JSON as `{}`) rather than this
 *     module silently discarding a field on every activation from then on.
 *  2. Run the cost effects against the COPY, through the exact same `applyEffect` every other effect
 *     in the engine goes through — buffering their log lines into a THROWAWAY array rather than the
 *     real transaction's `lines`.
 *  3. On ANY rejection: discard the copy and the buffered lines. The real `state` was never touched
 *     — not even read into a variable that outlives this function — so there is nothing to undo, and
 *     "no log line for any cost effect was ever emitted" (§9.4(e)) is true because none ever was.
 *  4. On success: REPLAY the identical cost effects, in the identical order, against the REAL draft.
 *     This is deterministic, not merely convenient: the copy's run proved every effect in the list
 *     succeeds against that exact starting state, and the replay starts from `state`'s ORIGINAL
 *     `rngCursor` — the discarded probe run never touched it — so if a cost effect ever drew on
 *     randomness, the replay consumes the SAME draws the probe would have, not a shifted sequence.
 *     (Today's five interceptable-in-cost kinds have no random cost effect in practice — §9.5 edge
 *     case 12 forbids anything that could suspend — but the determinism argument holds regardless of
 *     what a future cost effect turns out to be.)
 *
 * **§9.5 edge case 12 — the runtime re-check.** `schema.ts`'s zod refinement (private
 * `costEffectSuspends`) already rejects an authored `activation.cost` containing `chooseMode` /
 * `sealedChoice` / `openPriority` — but that only protects the EDITOR. Imported JSON bypasses it
 * entirely, and none of those three can be frozen by pass 1, so the two-pass model is as unsound for
 * them as the old one was for all five. `costEffectSuspends` below is a deliberate duplicate of
 * schema.ts's private helper, not an import: the whole point of a SECOND enforcement layer is that it
 * does not share a code path with the first one it is backstopping.
 */

import type {
  Effect,
  Frame,
  GameDefinition,
  Id,
  LogLine,
  PlayAction,
  PlayState,
  RejectReason,
  RuleSet,
  SeatId,
  StepResult,
  TargetSelector,
  TriggerContext,
} from './types';
import { pushLine } from './types';
import { applyEffect } from './effects';
import { makeEc, raiseValueChoice } from './dispatch';
import { activationCtx } from './priority';
import { evalCriteria } from './criteria';
import { pop, push, top } from './frames';
import { clear, isSuspended, raise } from './interaction';
import { CHOSEN_PROMPT_KEY, resolveTargets } from './targets';

// ---------------------------------------------------------------------------
// The deep-copy discard-and-replay mechanism — see the file header.
// ---------------------------------------------------------------------------

/**
 * `PlayState` is pure JSON data (§4.10), so this round trip is sufficient. Exported so
 * `activation.test.ts` can assert `deepCopyState(state)` is deep-equal to `state` directly, pinning
 * that invariant rather than trusting the doc comment.
 */
export function deepCopyState(state: PlayState): PlayState {
  return JSON.parse(JSON.stringify(state)) as PlayState;
}

// ---------------------------------------------------------------------------
// §9.5 edge case 12 — duplicated from schema.ts's private refinement on purpose; see the file header.
// ---------------------------------------------------------------------------

/** The `prompt` selector inside `s`, at any depth, or `null` — mirrors `pending.ts`'s `innerPrompt`
 * and `schema.ts`'s `selectorSuspends`, both of which walk exactly the same two arms. */
function innerPrompt(s: TargetSelector): Extract<TargetSelector, { kind: 'prompt' }> | null {
  if (s.kind === 'prompt') return s;
  if (s.kind === 'matching') return innerPrompt(s.from);
  return null;
}

/**
 * v4 §4.5.0(c) — the NARROWED ban: why a cost effect cannot be frozen by pass 1, or `null` if it can.
 *
 * What left the list, and what stayed, is the whole content of v4 §4.5. A `prompt` target selector,
 * `chooseNumber` and `chooseSeat` are now all frozen-then-applied — that covers "sacrifice a
 * creature", "discard a card", "tap an untapped creature you control" and every {X} cost, which is
 * every case G5 was raised for. The three that stayed are the three pass 1 genuinely cannot handle;
 * see the file header for one sentence each.
 */
function costEffectSuspends(e: Effect): string | null {
  // ponytail: a MODAL cost stays refused. v4 row 5 (§4.6) HAS now landed — `chooseMode` has its
  // frame-level branch queue, and `dispatch.ts`'s `bumpCursor`/`slotOf` pair is the machinery a
  // recursive freeze was waiting for. What is still missing is a place for the freeze to happen: the
  // branch queue lives on a `rule` frame, and a cost is paid from an `activation` frame with no rule
  // frame yet (§4.5.0(a)). Lifting this means teaching `freezeCost` to walk into the chosen branch —
  // its own change, with its own atomicity tests, since a cancel part-way down a branch must still
  // spend nothing. Until then "choose a mode, then pay for it" is authorable as two rules.
  if (e.kind === 'chooseMode' || e.kind === 'sealedChoice' || e.kind === 'openPriority') {
    return `it is a "${e.kind}" effect`;
  }
  return null;
}

/**
 * v4 §4.5.0(d) — where one cost effect's frozen answer lives, for as long as the cost is suspended.
 *
 * Reserved, parallel to `pending.ts`'s `@actionTarget:<i>` and `targets.ts`'s `@chosen`, and no
 * authored id can collide with it (an id cannot contain `@`). It doubles as the resumption marker and
 * as the frozen value, which is what makes pass 1 re-entrant with no second bookkeeping key: the
 * answer arms in `dispatch.ts` write it, and pass 1 skips any effect that already has it.
 */
const costTargetKey = (effectIndex: number): string => `@costTarget:${effectIndex}`;

// ---------------------------------------------------------------------------
// Small local logging — same discipline as pending.ts/priority.ts: no import of effects.ts's
// PRIVATE emit/reject.
// ---------------------------------------------------------------------------

const MORE: StepResult = { done: false, suspended: false, haltedByLoopGuard: false };
const DONE: StepResult = { done: true, suspended: false, haltedByLoopGuard: false };
const SUSPENDED: StepResult = { done: true, suspended: true, haltedByLoopGuard: false };

/** Matches dispatch.ts's own private sentinel (`pending.ts` duplicates it too) — the `rule` frame's
 * once-per-frame header (condition check, opening log line) has not run yet. */
const UNRESOLVED = -1;

/** NOT_ACTIVATABLE and COST_UNPAYABLE are both §4.12/§5.8 rule-legal refusals, not authoring faults —
 * `effects.ts`'s own (private) `LEVEL_OF` maps both to `'reject'`; this mirrors that, not guesses it.
 *
 * `result` is DONE for every refusal `activateRule` itself makes — the transaction ends there, exactly
 * as it always has. A refusal from `advanceActivation` passes MORE instead: that path has already
 * suspended once, so the `priority` frame underneath (if any) has to be re-entered to re-raise its
 * offer, and a free-standing one simply settles. */
function rejectResult(reason: RejectReason, message: string, lines: LogLine[], result = DONE): StepResult {
  pushLine(lines, { level: 'reject', kind: 'skip', message: `${reason}: ${message}`, change: null, ruleId: null, effectKind: null, depth: 0, visibility: null });
  return result;
}

function overrideLine(lines: LogLine[], message: string, depth: number): void {
  pushLine(lines, { level: 'override', kind: 'skip', message, change: null, ruleId: null, effectKind: null, depth, visibility: null });
}

// ---------------------------------------------------------------------------
// activate — the PlayAction. §5.8's pseudocode, plus the window/seat resolution §5.5's Interaction
// makes necessary and the override scoping §9.5 edge case 9 names (window-mismatch only — see the
// implementation report for what is and is not covered).
// ---------------------------------------------------------------------------

export function activateRule(
  state: PlayState,
  def: GameDefinition,
  action: Extract<PlayAction, { kind: 'activate' }>,
  lines: LogLine[],
  override: boolean
): StepResult {
  const rule = def.ruleSets.find((r) => r.id === action.ruleId);
  if (!rule || rule.activation === null) {
    return rejectResult('NOT_ACTIVATABLE', `Activate "${action.ruleId}": not an activatable rule.`, lines);
  }
  const activation = rule.activation;

  // The CURRENT window context. `applyAction`'s gate only lets `activate` through here while EITHER
  // no interaction is open, OR the open one is a `priority` interaction (`isPriorityResume`,
  // dispatch.ts) — so `state.interaction`, if set at all, is always the `priority` one this seat is
  // being offered, never an unrelated kind.
  const offering = state.interaction?.kind === 'priority' ? state.interaction : null;
  if (offering && offering.seat !== action.seat) {
    return rejectResult(
      'NOT_ACTIVATABLE',
      `Activate "${rule.name}": seat ${action.seat} is not currently offered priority (seat ${offering.seat} is).`,
      lines
    );
  }
  const windowId = offering ? offering.windowId : null;
  const windowMatches = activation.window === windowId;
  if (!windowMatches) {
    const wanted = activation.window === null ? 'outside any priority window' : `inside window "${activation.window}"`;
    const have = windowId === null ? 'outside any priority window' : `inside window "${windowId}"`;
    // §9.5 edge case 9 — override bypasses a WRONG-WINDOW refusal the same way it bypasses a
    // capacity/destination check elsewhere (§5.9 rows 1b/5c): a property of the tester's own move,
    // not of the ability's own legality. It does NOT reach the cost checks below — those stay a
    // precondition, never bypassable, exactly like every other reject reason this file can produce.
    if (!override) {
      return rejectResult('NOT_ACTIVATABLE', `Activate "${rule.name}": activatable ${wanted}, but ${have}.`, lines);
    }
    overrideLine(lines, `Activate "${rule.name}": activatable ${wanted}, but ${have}. Performed anyway.`, 0);
  }

  if (!state.seatOrder.includes(action.seat)) {
    if (!override) {
      return rejectResult('SEAT_ELIMINATED', `Activate "${rule.name}": seat ${action.seat} has been eliminated.`, lines);
    }
    overrideLine(lines, `Activate "${rule.name}": seat ${action.seat} has been eliminated. Performed anyway.`, 0);
  }

  const ctx = activationCtx(action.seat, action.cardId);

  if (activation.costCheck) {
    const verdict = evalCriteria(activation.costCheck, state, ctx, def);
    if (!verdict.value) {
      const failing = verdict.leaves.find((l) => !l.value) ?? verdict.leaves[0];
      return rejectResult(
        'COST_UNPAYABLE',
        `Activate "${rule.name}": cost precondition failed${failing ? ` — ${failing.description}` : ''}.`,
        lines
      );
    }
  }

  // §9.5 edge case 12 — the runtime re-check, narrowed by v4 §4.5.0(c) but not weakened. Nothing has
  // run yet; a hit here rejects with NOTHING attempted, exactly like a false costCheck, rather than
  // suspending part-way into a cost it could never finish.
  for (let i = 0; i < activation.cost.length; i++) {
    const why = costEffectSuspends(activation.cost[i]);
    if (why) {
      return rejectResult(
        'COST_UNPAYABLE',
        `Activate "${rule.name}": cost effect ${i} (${activation.cost[i].kind}) cannot be frozen ahead of the cost (${why}).`,
        lines
      );
    }
  }

  // The head of the stack BEFORE anything below mutates it — either the `priority` frame this
  // activation is responding to, or nothing (a free-standing, sorcery-speed activation always finds
  // an EMPTY stack here: `applyAction` only reaches a fresh top-level action once the previous
  // transaction fully settled, i.e. `state.stack`/`state.pending` both drained).
  const head = top(state);

  // v4 §4.5 — from here on, `payCost` owns it, whether it finishes inside this call or has to stop and
  // ask a question first. `pushed: false` because there is no `activation` frame yet and, for the
  // overwhelmingly common cost that asks nothing, there never will be: it is paid, logged and
  // finished right here, allocating no frame and consuming no extra `step()`, exactly as before v4.
  return payCost(
    state,
    def,
    rule,
    {
      ruleId: rule.id,
      sourceCardId: action.cardId,
      seat: action.seat,
      ctx,
      // Non-null exactly when this activation is a RESPONSE to an open offer (`windowId` is read off
      // `offering` above, and a `priority` interaction's own `windowId` is never null), which is what
      // the completion path tests to decide whether §5.5's bookkeeping applies.
      windowId,
      parentId: head?.id ?? null,
      depth: head?.depth ?? 1,
    },
    lines,
    false
  );
}

// ---------------------------------------------------------------------------
// v4 §4.5 — the two-pass cost. See the file header for the shape and for §4.5.0(c)/(d).
// ---------------------------------------------------------------------------

type ActivationFrame = Extract<Frame, { kind: 'activation' }>;

/** Everything the cost needs to know, present both before the `activation` frame exists and on it. */
interface CostRun {
  ruleId: Id;
  sourceCardId: Id | null;
  seat: SeatId;
  ctx: TriggerContext;
  windowId: Id | null;
  parentId: number | null;
  depth: number;
}

function promptLine(run: CostRun, lines: LogLine[], effect: Effect, message: string): void {
  pushLine(lines, { level: 'info', kind: 'prompt', message, change: null, ruleId: run.ruleId, effectKind: effect.kind, depth: run.depth, visibility: null });
}

/**
 * Pass 1. Raise the first interaction the cost still needs, or report that it needs none.
 *
 * Touches NOTHING in the game state — only `state.interaction` and the activation's own
 * `ctx.promptAnswers`, neither of which is a cost being paid. §3.3's raise-before-mutate, held to for
 * the same reason `runEffect` and `announceAction` hold to it: this walk runs again from the top after
 * every answer, so anything it did would be done once per question.
 */
function freezeCost(
  activation: NonNullable<RuleSet['activation']>,
  run: CostRun,
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[]
): 'ready' | 'suspended' | { reason: RejectReason; message: string } {
  for (let i = 0; i < activation.cost.length; i++) {
    const effect = activation.cost[i];
    const frozen = run.ctx.promptAnswers[costTargetKey(i)];

    if (frozen !== undefined) {
      // Already answered on an earlier pass. For the two `choose*` kinds, persist the answer under its
      // AUTHORED key as well — `runEffect` does exactly this for a rule effect (and for the same
      // reason): `@costTarget:<i>` only proves resumption, while `effect.key` is what makes a LATER
      // cost effect's (or the ability's own) `ValueRef{kind:'promptNumber'}` / `SeatRef{kind:'promptSeat'}`
      // resolve. Idempotent, which is why re-walking costs nothing.
      if (effect.kind === 'chooseNumber' || effect.kind === 'chooseSeat') {
        run.ctx.promptAnswers[effect.key] = [...frozen];
      }
      continue;
    }

    const promptId = costTargetKey(i);

    if ('target' in effect) {
      if (!innerPrompt(effect.target)) continue;
      const candidates = resolveTargets(effect.target, state, run.ctx, def);
      if (!candidates.ok || candidates.kind !== 'prompt') {
        // Zero legal targets, or an outright resolution failure — left UNFROZEN, exactly as
        // `announceAction` leaves it (`pending.ts:307`). Pass 2's probe reaches the same effect and
        // turns it into COST_UNPAYABLE with nothing spent, which is the right answer for a cost and
        // needs no second copy of the reasoning here.
        continue;
      }
      raise(state, {
        kind: 'chooseCards',
        promptId,
        promptText: candidates.promptText,
        seat: run.seat,
        candidates: [...candidates.candidates],
        min: candidates.min,
        max: candidates.max,
      });
      promptLine(
        run,
        lines,
        effect,
        `Cost effect ${i}: prompt "${candidates.promptText}" (seat ${run.seat}) — ${candidates.candidates.length} legal target(s).`
      );
      return 'suspended';
    }

    if (effect.kind === 'chooseNumber' || effect.kind === 'chooseSeat') {
      const raised = raiseValueChoice(effect, promptId, state, def, run.ctx);
      // Unlike a rule effect — where `onRejection` decides whether to skip past an unresolvable
      // prompt — an unaskable question in a COST is a cost that cannot be paid. Nothing has been
      // raised, so nothing needs taking back.
      if (!raised.ok) return { reason: raised.reason, message: `cost effect ${i} (${effect.kind}): ${raised.message}` };
      promptLine(run, lines, effect, `Cost effect ${i}: prompt "${effect.promptText}" (seat ${raised.seat}): raised.`);
      return 'suspended';
    }
  }
  return 'ready';
}

/**
 * v4 §4.5.0(d) — the one-effect context a single cost effect is applied through.
 *
 * The frozen answer is handed over under `targets.ts`'s `@chosen`, which is the SAME channel
 * `runEffect` uses to hand a rule effect its own answered prompt — so a `prompt` target selector, a
 * `chooseNumber` and a `chooseSeat` are all served by one key, and `effects.ts` needed no new arm at
 * all. Crucially the write lands on a COPY: `@chosen` on the shared `ctx` would be inherited by the
 * ability's `rule` frame and by every event the cost fires (`dispatch.ts`'s `stripChosen` exists for
 * precisely that hazard), and a cost answer must not outlive the effect that asked for it.
 */
function costEffectCtx(ctx: TriggerContext, effectIndex: number): TriggerContext {
  const frozen = ctx.promptAnswers[costTargetKey(effectIndex)];
  if (frozen === undefined) return ctx;
  return { ...ctx, promptAnswers: { ...ctx.promptAnswers, [CHOSEN_PROMPT_KEY]: [...frozen] } };
}

/**
 * Pass 2 — §5.8's discard-and-replay, unchanged in substance by v4. See the file header for why this
 * shape rather than a literal nested immer produce.
 *
 * `effectIndex` is deliberately NOT passed to `makeEc`: a cost effect is not an announced action's
 * frozen target at that index (v4 §4.5.0(d)), and leaving it undefined is what makes
 * `resolveEffectTargets`'s `@actionTarget:<i>` lookup structurally unable to fire on a cost — the
 * same discipline `effects.ts`'s `chooseMode` branch uses for its sub-effects.
 */
function applyCost(
  activation: NonNullable<RuleSet['activation']>,
  rule: RuleSet,
  run: CostRun,
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[]
): { ok: true } | { reason: RejectReason; message: string } {
  const probeState = deepCopyState(state);
  // The probe's `isSuspended` check below asks "did THIS cost effect raise an interaction", and the
  // copy inherits whatever was already open — which, for an activation taken as a RESPONSE, is the
  // `priority` interaction offering this very ability (`payCost` clears the real one only once the
  // cost is paid, deliberately, so a refusal leaves the window untouched — SP18(c)). Without this
  // line every non-empty cost activated inside a window refused itself as "raises an interaction of
  // its own"; found by the Magic sample, whose costs are all paid inside one (`mtg.ts` note 6).
  probeState.interaction = null;
  const probeLines: LogLine[] = [];
  for (let i = 0; i < activation.cost.length; i++) {
    const effect = activation.cost[i];
    const ec = makeEc(probeState, def, probeLines, costEffectCtx(run.ctx, i), run.depth, run.parentId, false, rule.id, effect.kind);
    const result = applyEffect(effect, ec);
    if (!result.ok) {
      // AC: SP7, §9.4(e) case 2 — the copy and its lines are simply never used again. `state`/`lines`
      // (the real ones) have not been touched by a single line of this loop.
      return {
        reason: 'COST_UNPAYABLE',
        message: `Activate "${rule.name}": cost could not be paid — cost effect ${i} (${effect.kind}): ${result.detail ?? result.reason}.`,
      };
    }
    // ponytail: REFUSING is the ceiling here, not supporting it. An `announceAction` cost that needs
    // to freeze the announced rule's targets could be made to work by teaching pass 1 to walk into it
    // — `pending.ts` already has the freeze loop and its own reserved prompt ids — but that is a
    // second, nested freeze protocol for a cost nobody has authored, and this refusal is sound.
    //
    // v4 §4.5 — the backstop for an effect that suspends WITHOUT being one of the three banned kinds.
    // `announceAction` is the live case: it raises its own target prompts from inside `applyEffect`
    // (`pending.ts:312`), which pass 1 cannot see and cannot pre-freeze, and which on the REPLAY below
    // would publish a half-paid cost and suspend. The probe is a faithful dry run, so a suspension
    // here is exactly "this effect would suspend the real transaction" — refuse it, nothing spent.
    if (isSuspended(probeState)) {
      return {
        reason: 'COST_UNPAYABLE',
        message: `Activate "${rule.name}": cost effect ${i} (${effect.kind}) raises an interaction of its own, which a cost cannot freeze (v4 §4.5).`,
      };
    }
  }

  // Replay against the REAL draft — deterministic (§9.5 edge case 12's header note); every effect is
  // already proven to succeed by the probe above.
  for (let i = 0; i < activation.cost.length; i++) {
    const effect = activation.cost[i];
    applyEffect(
      effect,
      makeEc(state, def, lines, costEffectCtx(run.ctx, i), run.depth, run.parentId, false, rule.id, effect.kind)
    );
  }
  return { ok: true };
}

/**
 * Both passes, plus the completion. Entered TWICE per interactive cost — once from `activateRule`
 * (with `pushed: false`, no frame yet) and once per answer from `advanceActivation` (`pushed: true`).
 *
 * ponytail: the frame is created LAZILY, at the moment a question actually has to be asked, rather
 * than unconditionally as §4.5.0(a) sketched. The ceiling is one boolean parameter threaded through
 * three call sites; what it buys is that a cost which asks nothing behaves in v4 EXACTLY as it did in
 * v2 — no frame, no extra `step()`, no early withdrawal of the priority offer a refusal would then
 * have to put back, and `nextWorkId` untouched when the cost turns out to be unpayable (§9.4(e)'s
 * "nothing about a failed cost is ever observable", down to the work-id counter). Push
 * unconditionally and drop the boolean the day that stops being worth one parameter.
 */
function payCost(
  state: PlayState,
  def: GameDefinition,
  rule: RuleSet,
  run: CostRun,
  lines: LogLine[],
  pushed: boolean
): StepResult {
  const activation = rule.activation;
  if (activation === null) {
    // Defensive: only reachable if the definition changed under a suspended activation.
    if (pushed) pop(state);
    return rejectResult('NOT_ACTIVATABLE', `Activate "${rule.name}": no longer an activatable rule.`, lines, pushed ? MORE : DONE);
  }

  const frozen = freezeCost(activation, run, state, def, lines);
  if (typeof frozen === 'object') {
    if (pushed) pop(state);
    return rejectResult('COST_UNPAYABLE', `Activate "${rule.name}": ${frozen.message}`, lines, pushed ? MORE : DONE);
  }
  if (frozen === 'suspended') {
    // The interaction is already raised. Push the frame it will be answered into — on top of the
    // `priority` frame this activation is responding to, when there is one, which is why the answer
    // arms in `dispatch.ts` find an `activation` at the head and the window is left exactly as it was.
    // `raise` has already replaced any priority offer in `state.interaction`, so nothing needs
    // clearing and `advance()` will re-enter this frame (not the window) once the answer lands.
    if (!pushed) push(state, { kind: 'activation', ...run });
    return SUSPENDED;
  }

  const paid = applyCost(activation, rule, run, state, def, lines);
  if ('reason' in paid) {
    if (pushed) pop(state);
    return rejectResult(paid.reason, paid.message, lines, pushed ? MORE : DONE);
  }

  // The cost is paid. The frame has nothing left to do, and the `rule` frame for the ability's own
  // effects takes its place at the same depth and under the same parent the activation had — so the
  // loop-guard parent chain is what it would have been with no cost frame in it at all.
  if (pushed) pop(state);
  const parent = top(state);

  // AC: SP8, §9.4(e) case 3 — one LogEntry covers cost AND effects because both are logged into the
  // SAME `lines` array inside the SAME top-level dispatch, and `rule.effects` runs via the identical
  // `rule` frame + cursor machinery every other rule frame uses (`advanceRule`/`runEffect`), not a
  // second copy of it.
  pushLine(lines, {
    level: 'info',
    kind: 'rule',
    ruleId: rule.id,
    effectKind: null,
    depth: run.depth,
    change: null,
    message: `Activate "${rule.name}"${run.sourceCardId ? ` (${run.sourceCardId})` : ''} — cost paid, seat ${run.seat}.`,
    visibility: null,
  });

  push(state, {
    kind: 'rule',
    ruleId: rule.id,
    sourceCardId: run.sourceCardId,
    ctx: run.ctx,
    cursor: UNRESOLVED,
    aborted: false,
    parentId: run.parentId,
    depth: run.depth,
  });

  // §5.5 — "a response resets `passes` to 0, so the window re-polls the table." Only when this
  // activation IS the response to an open offer; a free-standing activation touches no priority frame.
  // Deferred to HERE rather than done when the offer was taken: a cost cancelled or refused halfway
  // must leave the window exactly as it found it (AC SP18(c)), and the only way to guarantee that is
  // not to touch it until the cost is actually paid.
  if (run.windowId !== null && parent?.kind === 'priority') {
    clear(state);
    parent.consecutivePasses = 0;
    parent.cursor = (parent.cursor + 1) % parent.order.length;
  }

  return MORE;
}

/**
 * The `activation` frame's body — v4 §4.5.0(a), wired into `dispatch.ts`'s `advance()` switch.
 *
 * One more attempt at the cost: raise the next question, pay the whole thing, or refuse it. Reached
 * only after an answer landed (or after a rewind put us back here), because a raised interaction stops
 * `advance()` before the switch.
 */
export function advanceActivation(
  frame: ActivationFrame,
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[]
): StepResult {
  const rule = def.ruleSets.find((r) => r.id === frame.ruleId);
  if (!rule) {
    // Defensive — `definitionStore.ts`'s delete-protection means a rule in use cannot be deleted, so
    // reaching here means the definition changed under a suspended cost. Mirrors `advancePriority`'s
    // dangling-window arm: pop, say so, carry on.
    pop(state);
    pushLine(lines, { level: 'error', kind: 'skip', message: `Activate "${frame.ruleId}": the rule no longer exists in this definition.`, change: null, ruleId: null, effectKind: null, depth: frame.depth, visibility: null });
    return MORE;
  }
  return payCost(state, def, rule, frame, lines, true);
}
