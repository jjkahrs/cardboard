/**
 * `RuleSet.activation` and the `activate` action. TECHNICAL_DESIGN_V2.md §4.5, §4.12, §5.8, §9.4(e),
 * §9.5 edge case 12.
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
 * `chooseNumber` / `sealedChoice` / `openPriority`, or a `prompt` `TargetSelector` at any depth — but
 * that only protects the EDITOR. Imported JSON bypasses it entirely, and the discard-on-fail model
 * above is unsound the instant a cost effect suspends (suspending COMMITS the transaction, which
 * publishes the half-applied cost — the two models are in direct conflict, §5.8). `costEffectSuspends`
 * below is a deliberate duplicate of schema.ts's private helper, not an import: `schema.ts` is out of
 * this wave's file boundary, and the whole point of a SECOND enforcement layer is that it does not
 * share a code path with the first one it is backstopping.
 */

import type {
  Effect,
  GameDefinition,
  LogLine,
  PlayAction,
  PlayState,
  RejectReason,
  StepResult,
  TargetSelector,
} from './types';
import { applyEffect } from './effects';
import { makeEc } from './dispatch';
import { activationCtx } from './priority';
import { evalCriteria } from './criteria';
import { push, top } from './frames';
import { clear } from './interaction';

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

function selectorSuspends(s: TargetSelector): boolean {
  if (s.kind === 'prompt') return true;
  if (s.kind === 'matching') return selectorSuspends(s.from);
  return false;
}

function costEffectSuspends(e: Effect): string | null {
  if (e.kind === 'chooseMode' || e.kind === 'chooseNumber' || e.kind === 'sealedChoice' || e.kind === 'openPriority') {
    return `it is a "${e.kind}" effect`;
  }
  if ('target' in e && selectorSuspends(e.target)) {
    return 'its target selector contains a prompt';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small local logging — same discipline as pending.ts/priority.ts: no import of effects.ts's
// PRIVATE emit/reject.
// ---------------------------------------------------------------------------

const MORE: StepResult = { done: false, suspended: false, haltedByLoopGuard: false };
const DONE: StepResult = { done: true, suspended: false, haltedByLoopGuard: false };

/** Matches dispatch.ts's own private sentinel (`pending.ts` duplicates it too) — the `rule` frame's
 * once-per-frame header (condition check, opening log line) has not run yet. */
const UNRESOLVED = -1;

/** NOT_ACTIVATABLE and COST_UNPAYABLE are both §4.12/§5.8 rule-legal refusals, not authoring faults —
 * `effects.ts`'s own (private) `LEVEL_OF` maps both to `'reject'`; this mirrors that, not guesses it. */
function rejectResult(reason: RejectReason, message: string, lines: LogLine[]): StepResult {
  lines.push({ level: 'reject', kind: 'skip', message: `${reason}: ${message}`, change: null, ruleId: null, effectKind: null, depth: 0 });
  return DONE;
}

function overrideLine(lines: LogLine[], message: string, depth: number): void {
  lines.push({ level: 'override', kind: 'skip', message, change: null, ruleId: null, effectKind: null, depth });
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

  // §9.5 edge case 12 — the runtime re-check. Nothing has run yet; a hit here rejects with NOTHING
  // attempted, exactly like a false costCheck, rather than suspending mid-cost.
  for (let i = 0; i < activation.cost.length; i++) {
    const why = costEffectSuspends(activation.cost[i]);
    if (why) {
      return rejectResult(
        'COST_UNPAYABLE',
        `Activate "${rule.name}": cost effect ${i} (${activation.cost[i].kind}) must not suspend (${why}).`,
        lines
      );
    }
  }

  // The head of the stack BEFORE anything below mutates it — either the `priority` frame this
  // activation is responding to, or nothing (a free-standing, sorcery-speed activation always finds
  // an EMPTY stack here: `applyAction` only reaches a fresh top-level action once the previous
  // transaction fully settled, i.e. `state.stack`/`state.pending` both drained).
  const head = top(state);
  const parentId = head?.id ?? null;
  const depth = head?.depth ?? 1;

  // §5.8's discard-and-replay — see the file header for why this shape rather than a literal nested
  // immer produce.
  const probeState = deepCopyState(state);
  const probeLines: LogLine[] = [];
  for (let i = 0; i < activation.cost.length; i++) {
    const effect = activation.cost[i];
    const ec = makeEc(probeState, def, probeLines, ctx, depth, parentId, false, rule.id, effect.kind, i);
    const result = applyEffect(effect, ec);
    if (!result.ok) {
      // AC: SP7, §9.4(e) case 2 — the copy and its lines are simply never used again. `state`/`lines`
      // (the real ones) have not been touched by a single line of this loop.
      return rejectResult(
        'COST_UNPAYABLE',
        `Activate "${rule.name}": cost could not be paid — cost effect ${i} (${effect.kind}): ${result.detail ?? result.reason}.`,
        lines
      );
    }
  }

  // Replay against the REAL draft — deterministic (§9.5 edge case 12's header note); every effect is
  // already proven to succeed by the probe above.
  for (let i = 0; i < activation.cost.length; i++) {
    const effect = activation.cost[i];
    const ec = makeEc(state, def, lines, ctx, depth, parentId, false, rule.id, effect.kind, i);
    applyEffect(effect, ec);
  }

  // AC: SP8, §9.4(e) case 3 — one LogEntry covers cost AND effects because both are logged into the
  // SAME `lines` array inside the SAME top-level dispatch, and `rule.effects` runs via the identical
  // `rule` frame + cursor machinery every other rule frame uses (`advanceRule`/`runEffect`), not a
  // second copy of it.
  lines.push({
    level: 'info',
    kind: 'rule',
    ruleId: rule.id,
    effectKind: null,
    depth,
    change: null,
    message: `Activate "${rule.name}"${action.cardId ? ` (${action.cardId})` : ''} — cost paid, seat ${action.seat}.`,
  });

  push(state, {
    kind: 'rule',
    ruleId: rule.id,
    sourceCardId: action.cardId,
    ctx,
    cursor: UNRESOLVED,
    aborted: false,
    parentId,
    depth,
  });

  // §5.5 — "a response resets `passes` to 0, so the window re-polls the table." Only when this
  // activation IS the response to an open offer; a free-standing activation touches no priority frame.
  if (offering && head?.kind === 'priority') {
    clear(state);
    head.consecutivePasses = 0;
    head.cursor = (head.cursor + 1) % head.order.length;
  }

  return MORE;
}
