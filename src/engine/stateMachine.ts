/**
 * State machine evaluation. TECHNICAL_DESIGN.md §5.6, §5.1, §5.9 rows 5 / 5b / 5c / 14.
 *
 * Pure except for `applyTransition`, which mutates the immer draft it is handed.
 */

import { evalCriteria } from './criteria';
import type { EffectContext } from './effects';
import type {
  EffectResult,
  GameDefinition,
  Id,
  LogLine,
  MachineState,
  PlayState,
  RejectReason,
  TriggerContext,
} from './types';

function stateById(def: GameDefinition, id: Id): MachineState | undefined {
  return def.machine.states.find((s) => s.id === id);
}

function reject(reason: RejectReason, detail: string): EffectResult {
  return { ok: false, reason, detail };
}

// ---------------------------------------------------------------------------
// Legality — §5.6, §5.9 rows 5 / 5b
// ---------------------------------------------------------------------------

/**
 * A→B is legal iff `A.exitableTo` includes B AND `B.enterableFrom` includes A. Conjunction, not
 * disjunction: a one-sided edge is nearly always an authoring slip, so it gets its own reason code
 * and a message naming which side is missing.
 */
export function checkTransitionLegal(def: GameDefinition, fromId: Id, toId: Id): EffectResult {
  const from = stateById(def, fromId);
  const to = stateById(def, toId);
  if (!from) return reject('MISSING_REFERENT', `Transition from "${fromId}": state does not exist in this definition.`);
  if (!to) return reject('MISSING_REFERENT', `Transition to "${toId}": state does not exist in this definition.`);

  const exits = from.exitableTo.includes(toId);
  const enters = to.enterableFrom.includes(fromId);
  if (exits && enters) return { ok: true };

  const edge = `Transition ${from.name} → ${to.name}`;
  if (exits) {
    return reject(
      'ONE_SIDED_EDGE',
      `${edge}: "${from.name}".exitableTo lists "${to.name}", but "${to.name}".enterableFrom does not list "${from.name}". Edge is one-sided.`
    );
  }
  if (enters) {
    return reject(
      'ONE_SIDED_EDGE',
      `${edge}: "${to.name}".enterableFrom lists "${from.name}", but "${from.name}".exitableTo does not list "${to.name}". Edge is one-sided.`
    );
  }
  // Neither side. §5.9 row 5 names enterableFrom — the side a designer reads first.
  return reject('ILLEGAL_TRANSITION', `${edge}: "${to.name}".enterableFrom does not list "${from.name}".`);
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** Legal targets of the current state, in `exitableTo` order, paired with that index. */
function candidates(state: PlayState, def: GameDefinition): { target: MachineState; exitIndex: number }[] {
  const current = stateById(def, state.currentStateId);
  if (!current) return [];
  const out: { target: MachineState; exitIndex: number }[] = [];
  current.exitableTo.forEach((toId, exitIndex) => {
    if (out.some((c) => c.target.id === toId)) return; // a duplicate entry is one edge, not two
    const target = stateById(def, toId);
    if (!target) return;
    if (!checkTransitionLegal(def, current.id, toId).ok) return;
    out.push({ target, exitIndex });
  });
  return out;
}

// ---------------------------------------------------------------------------
// The quiescence scan — §5.6, §5.9 row 14
// ---------------------------------------------------------------------------

/**
 * **Call this ONLY at quiescence** — never after every effect, never on a tick (§5.1's loop is the
 * one caller). Mid-RuleSet the world is transiently inconsistent: the cost is paid and the benefit
 * is not yet granted, so a scan there fires transitions on half-applied rules and produces states
 * the game logically never occupied.
 *
 * This is a pure scan with no way to interrupt anything: an auto-transition cannot preempt a
 * mid-flight RuleSet, it waits.
 *
 * `eligible` lists every state that qualified so the caller can warn whenever there was more than
 * one, regardless of how the tiebreak resolved (§5.9 row 14).
 */
export function findAutoTransition(
  state: PlayState,
  def: GameDefinition,
  ctx: TriggerContext
): { toStateId: Id; eligible: Id[] } | null {
  const eligible = candidates(state, def).filter((c) => {
    // entryCriteria === null means MANUAL: the state renders as a button and is never auto-entered.
    if (c.target.entryCriteria === null) return false;
    const verdict = evalCriteria(c.target.entryCriteria, state, ctx, def);
    // A criteria tree with no leaves is a state still being authored — the editor writes an empty
    // AND group the moment "Enter automatically instead" is clicked, and an empty AND is true, which
    // would auto-enter the state unconditionally before a single criterion is typed.
    return verdict.leaves.length > 0 && verdict.value;
  });
  if (eligible.length === 0) return null;

  // Total comparator — §5.6. Never relies on sort stability or key order.
  const declIndex = (id: Id) => def.machine.states.findIndex((s) => s.id === id);
  const winner = [...eligible].sort(
    (a, b) =>
      b.target.priority - a.target.priority ||
      a.exitIndex - b.exitIndex ||
      // Formally required by §5.6 and unreachable by construction: exitIndex is already unique
      // per candidate. Kept so the comparator stays total if candidates are ever sourced elsewhere.
      declIndex(a.target.id) - declIndex(b.target.id)
  )[0];

  return { toStateId: winner.target.id, eligible: eligible.map((c) => c.target.id) };
}

/** Criteria-less states legally reachable from the current one — these render as labeled buttons. */
export function manualTransitions(state: PlayState, def: GameDefinition): MachineState[] {
  return candidates(state, def)
    .filter((c) => c.target.entryCriteria === null)
    .map((c) => c.target);
}

// ---------------------------------------------------------------------------
// applyTransition — §5.6, §5.9 rows 5c / 10
// ---------------------------------------------------------------------------

function line(ec: EffectContext, level: LogLine['level'], message: string): LogLine {
  return { level, kind: 'transition', message, change: null, ruleId: null, effectKind: null, depth: ec.depth };
}

/**
 * Performs the transition on the draft: sets `currentStateId`, then enqueues `onStateExit` for the
 * state left and `onStateEnter` for the state entered, in that order. Entering `End` also sets
 * `finished` and enqueues `onGameEnd` — settling it is dispatch's job.
 *
 * `opts.forced` marks a `forceTransition` effect for the log; it does NOT bypass legality. Only
 * `ec.override` does (§5.9 row 5c), and then both events still fire.
 */
export function applyTransition(
  ec: EffectContext,
  toStateId: Id,
  opts: { forced: boolean }
): EffectResult {
  // §5.6: reaching End "rejects all input except rewind". Guarded HERE, not at the callers, so
  // every route closes at once — including a queued `forceTransition` work item, which dispatch's
  // drain loop runs with no finished check and which could otherwise fire `onGameEnd` twice.
  if (ec.state.finished) {
    const detail = 'Session finished at "End". Only Rewind is accepted.';
    ec.log(line(ec, 'reject', detail));
    return reject('SESSION_FINISHED', detail);
  }

  const fromId = ec.state.currentStateId;
  const legal = checkTransitionLegal(ec.def, fromId, toStateId);
  if (!legal.ok) {
    if (!ec.override || legal.reason === 'MISSING_REFERENT') {
      // Nothing is mutated and no event fires — the rejection is total.
      ec.log(line(ec, legal.reason === 'MISSING_REFERENT' ? 'error' : 'reject', legal.detail ?? ''));
      return legal;
    }
    const from = stateById(ec.def, fromId)!;
    const to = stateById(ec.def, toStateId)!;
    ec.log(line(ec, 'override', `Transition ${from.name} → ${to.name} performed despite ${legal.reason === 'ONE_SIDED_EDGE' ? 'a one-sided edge' : 'enterableFrom restriction'}.`));
  } else {
    const from = stateById(ec.def, fromId)!;
    const to = stateById(ec.def, toStateId)!;
    ec.log(line(ec, 'info', `Transition ${from.name} → ${to.name}${opts.forced ? ' (forced by effect)' : ''}.`));
  }

  ec.state.currentStateId = toStateId;

  // A transition binds no card and no zone — leaking `triggeringCard` here is exactly what §5.7's
  // "bound only under the four card events" forbids. The seat and prompt answers stay.
  const eventCtx: TriggerContext = {
    triggeringCardId: null,
    zoneKey: null,
    triggeringSeat: ec.ctx.triggeringSeat,
    promptAnswers: ec.ctx.promptAnswers,
  };
  ec.fireEvent('onStateExit', eventCtx, fromId);
  ec.fireEvent('onStateEnter', eventCtx);

  if (toStateId === ec.def.machine.endStateId) {
    ec.state.finished = true;
    ec.fireEvent('onGameEnd', eventCtx);
  }

  return { ok: true };
}
