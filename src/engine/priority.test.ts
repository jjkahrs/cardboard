/**
 * The `priority` frame. TECHNICAL_DESIGN_V2.md §4.6, §5.5, §9.1 rows MTG1/MTG4/MTG5/V3/V4, §9.5 edge
 * cases 1/2/16.
 *
 * A minimal, zone-less, card-less definition throughout (mirrors `dispatch.test.ts`'s own `mini()`):
 * every scenario here is about the ROUND-ROBIN mechanism itself, not about what an activated rule's
 * effects do, so a pool flip is all any rule needs to be independently observable.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTINUE,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
  type CriteriaNode,
  type EngineInput,
  type GameDefinition,
  type LogLine,
  type PlayAction,
  type PlayState,
  type PriorityWindow,
  type PlayZone,
  type RuleSet,
  type SeatRef,
  type StepResult,
} from './types';
import { step } from './dispatch';
import { createPlayState } from './setup';
import { resolveSeat } from './seats';
import { END_NODE, FIXTURE_UPDATED_AT, START_NODE } from '../test/fixtures/empty';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const HP = 'pool_hp';
const ATTACKERS = 'pool_attackers';
/** Boolean, player-scoped — the ONLY per-seat gate a `costCheck` needs to make "seat X may respond,
 * seat Y may not" deterministic without any card at all. */
const CAN_RESPOND = 'pool_canRespond';

const WIN_MTG = 'win_mtg';
const WIN_BLOCK = 'win_block';

const RS_ANNOUNCE = 'rs_announce'; // global, trigger 'doAnnounce' — announces RS_ORIGINAL
const RS_ORIGINAL = 'rs_original'; // the announced action's own rule
const RS_RESPOND = 'rs_respond'; // activatable, announces RS_RESPONSE
const RS_RESPONSE = 'rs_response'; // the response's own rule

const lit = (value: number | boolean) => ({ kind: 'literal' as const, value });
const triggeringSeat = { kind: 'triggeringSeat' as const };

const baseRule: Omit<RuleSet, 'id' | 'name' | 'trigger' | 'effects'> = {
  stateFilter: null,
  condition: null,
  priority: 0,
  onRejection: 'continue',
  modifier: null,
  continuous: false,
  replaces: null,
  activation: null,
};

const rsAnnounce = (ruleId: string, window: string | null): RuleSet => ({
  ...baseRule,
  id: RS_ANNOUNCE,
  name: 'Announce',
  trigger: 'doAnnounce',
  effects: [{ kind: 'announceAction', ruleId, window }],
});

/** "Original" — HP(triggeringSeat) −3. Never bound to a real trigger; only reached via announce/resolve. */
const rsOriginal: RuleSet = {
  ...baseRule,
  id: RS_ORIGINAL,
  name: 'Original',
  trigger: 'never_original',
  effects: [{ kind: 'changePool', poolId: HP, seat: triggeringSeat, op: 'subtract', amount: lit(3) }],
};

/** "Response" — Attackers(triggeringSeat) +1. Same discipline. */
const rsResponse: RuleSet = {
  ...baseRule,
  id: RS_RESPONSE,
  name: 'Response',
  trigger: 'never_response',
  effects: [{ kind: 'changePool', poolId: ATTACKERS, seat: triggeringSeat, op: 'add', amount: lit(1) }],
};

/** costCheck `CAN_RESPOND(triggeringSeat) === true` — so a test can gate "only seat N may respond"
 * purely by seeding `state.playerPools[CAN_RESPOND]` after `createPlayState`, no card needed. */
function costGated(window: string): RuleSet {
  const canRespond: CriteriaNode = {
    kind: 'criteria',
    left: { kind: 'pool', poolId: CAN_RESPOND, seat: triggeringSeat },
    op: '=',
    right: { kind: 'literal', value: true },
  };
  return {
    ...baseRule,
    id: RS_RESPOND,
    name: 'Respond',
    trigger: 'never_respond',
    effects: [{ kind: 'announceAction', ruleId: RS_RESPONSE, window: null }],
    activation: { costCheck: canRespond, cost: [], window, perInstance: false, label: 'Respond' },
  };
}

/** No activation-bearing rule anywhere reachable → every offer in the window is empty (MTG4). */
function defNoResponder(playerCount: number, window: PriorityWindow): GameDefinition {
  return def(playerCount, [rsAnnounce(RS_ORIGINAL, window.id), rsOriginal], [window]);
}

/** Exactly one rule can ever be legal, gated per-seat by `CAN_RESPOND` (MTG5, V4). */
function defOneResponder(playerCount: number, window: PriorityWindow): GameDefinition {
  return def(
    playerCount,
    [rsAnnounce(RS_ORIGINAL, window.id), rsOriginal, costGated(window.id), rsResponse],
    [window]
  );
}

const LIMITS = {
  maxDepth: DEFAULT_MAX_DEPTH,
  maxEffects: DEFAULT_MAX_EFFECTS,
  maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
  maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
};

function def(
  playerCount: number,
  ruleSets: RuleSet[],
  priorityWindows: PriorityWindow[],
  limits = LIMITS
): GameDefinition {
  const zones: PlayZone[] = [];
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'game_priority',
    name: 'Priority',
    playerCount,
    pools: [
      { id: HP, scope: 'player', value: { type: 'integer', name: 'HP', defaultValue: 20, min: 0, max: 20 } },
      { id: ATTACKERS, scope: 'player', value: { type: 'integer', name: 'Attackers', defaultValue: 0, min: 0, max: 99 } },
      { id: CAN_RESPOND, scope: 'player', value: { type: 'boolean', name: 'Can Respond', defaultValue: false } },
    ],
    zones,
    templates: [],
    decks: [],
    customEvents: ['doAnnounce'],
    ruleSets,
    globalRuleSetIds: ruleSets.filter((r) => r.trigger === 'doAnnounce').map((r) => r.id),
    priorityWindows,
    machine: { states: [START_NODE, END_NODE], startStateId: START_STATE_ID, endStateId: END_STATE_ID },
    limits,
    updatedAt: FIXTURE_UPDATED_AT,
  };
}

const winMtg = (over: Partial<PriorityWindow> = {}): PriorityWindow => ({
  id: WIN_MTG,
  name: 'MTG Priority',
  start: 'active',
  direction: 'forward',
  includeStart: true,
  passesToClose: null,
  collapseEmptyOffers: true,
  ...over,
});

const winBlock = (over: Partial<PriorityWindow> = {}): PriorityWindow => ({
  id: WIN_BLOCK,
  name: 'Block Window',
  start: 'controllerOfAction',
  direction: 'forward',
  includeStart: false,
  passesToClose: null,
  collapseEmptyOffers: true,
  ...over,
});

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

interface Run {
  lines: LogLine[];
  result: StepResult;
}

const RUNAWAY = 200_000;

function drive(state: PlayState, gameDef: GameDefinition, action: PlayAction, override = false): Run {
  const lines: LogLine[] = [];
  let input: EngineInput = { kind: 'action', action, override };
  let result = step(state, input, lines, gameDef);
  let n = 0;
  while (!result.done) {
    if (++n > RUNAWAY) throw new Error('priority.test.ts driver runaway');
    input = CONTINUE;
    result = step(state, input, lines, gameDef);
  }
  return { lines, result };
}

function stepOnce(state: PlayState, gameDef: GameDefinition, lines: LogLine[]): StepResult {
  return step(state, CONTINUE, lines, gameDef);
}

/** Dispatches `action`, then steps CONTINUE until the top of the stack is a `priority` frame, or the
 * transaction settles without ever reaching one. */
function stepUntilPriority(state: PlayState, gameDef: GameDefinition, lines: LogLine[], action: PlayAction): void {
  let result = step(state, { kind: 'action', action, override: false }, lines, gameDef);
  let n = 0;
  while (state.stack[state.stack.length - 1]?.kind !== 'priority') {
    if (result.done) return;
    if (++n > RUNAWAY) throw new Error('priority.test.ts driver runaway (never reached a priority frame)');
    result = stepOnce(state, gameDef, lines);
  }
}

function priorityFrame(state: PlayState) {
  const frame = state.stack[state.stack.length - 1];
  if (frame?.kind !== 'priority') throw new Error('expected a priority frame on top of the stack');
  return frame;
}

/** Finds the (one, in every scenario here) `priority` frame anywhere in the stack — for the moment
 * right after a response, when a fresh `rule` frame for the activated ability sits ABOVE it. */
function anyPriorityFrame(state: PlayState) {
  const frame = state.stack.find((f) => f.kind === 'priority');
  if (!frame || frame.kind !== 'priority') throw new Error('expected a priority frame somewhere on the stack');
  return frame;
}

// ---------------------------------------------------------------------------
// MTG1 — offered in seatOrder order starting at active; a response places a new PendingAction above.
// ---------------------------------------------------------------------------

describe('AC: MTG1 — priority is offered in order; a response places a new PendingAction above', () => {
  // AC: MTG1
  it('offers the active seat first, and activating pushes a new PendingAction onto actionStack', () => {
    const d = defOneResponder(2, winMtg());
    const state = createPlayState(d, 'seed-mtg1');
    state.playerPools[CAN_RESPOND][0] = true; // the active seat (0) may respond to its own spell

    const run = drive(state, d, { kind: 'fireEvent', name: 'doAnnounce', seat: 0 });
    expect(run.result.suspended).toBe(true);
    expect(state.interaction?.kind).toBe('priority');
    const interaction = state.interaction!;
    if (interaction.kind !== 'priority') throw new Error('unreachable');
    expect(interaction.seat).toBe(0); // order[0] === active seat, per §5.5
    expect(interaction.legal).toEqual([{ ruleId: RS_RESPOND, cardId: null, label: 'Respond' }]);

    const originalId = state.actionStack[0];
    expect(state.actionStack).toEqual([originalId]);

    const respond = drive(state, d, { kind: 'activate', ruleId: RS_RESPOND, cardId: null, seat: 0 });
    expect(respond.result.done).toBe(true);
    expect(state.actionStack).toHaveLength(2);
    expect(state.actionStack[0]).toBe(originalId);
    const responseId = state.actionStack[1];
    expect(state.pendingActions[responseId].ruleId).toBe(RS_RESPONSE);
  });
});

// ---------------------------------------------------------------------------
// MTG4 — nobody anywhere has a legal response: the round collapses with no per-seat log entry, and
// the frame pops (and the action resolves) inside the SAME transaction.
// ---------------------------------------------------------------------------

describe('AC: MTG4 — an empty round collapses without suspending, and resolves in one transaction', () => {
  // AC: MTG4
  it('never raises an interaction, and the original action resolves in the same drive() call', () => {
    const d = defNoResponder(2, winMtg());
    const state = createPlayState(d, 'seed-mtg4');

    const run = drive(state, d, { kind: 'fireEvent', name: 'doAnnounce', seat: 0 });

    expect(run.result.suspended).toBe(false);
    expect(run.result.done).toBe(true);
    expect(state.interaction).toBeNull();
    expect(state.actionStack).toEqual([]); // resolved
    expect(state.playerPools[HP][0]).toBe(17); // RS_ORIGINAL's effect ran: 20 - 3

    // No per-seat log entry anywhere — the whole round is silent by construction (§5.5's pseudocode).
    const perSeat = run.lines.filter((l) => l.message.includes('offered') || l.message.includes('passes priority'));
    expect(perSeat).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MTG5 — a seat that CAN respond and declines anyway gets its own fresh top-level action (and, per
// sessionStore.test.ts, its own LogEntry/rewind point).
// ---------------------------------------------------------------------------

describe('AC: MTG5 — a seat that can respond and passes anyway is a fresh top-level action', () => {
  // AC: MTG5
  it('passPriority resets nothing it should not, advances the round, and is its own dispatch', () => {
    const d = defOneResponder(2, winMtg());
    const state = createPlayState(d, 'seed-mtg5');
    state.playerPools[CAN_RESPOND][1] = true; // only seat 1 may respond

    const run = drive(state, d, { kind: 'fireEvent', name: 'doAnnounce', seat: 0 });
    expect(run.result.suspended).toBe(true);
    // Seat 0 (no legal response) auto-passed silently first — no PER-SEAT line names it (the window's
    // own "opened ... starting seat 0" line is not one — MTG4 already pins that distinction).
    expect(run.lines.some((l) => l.message.includes('seat 0 offered') || l.message.includes('seat 0 passes'))).toBe(false);
    expect(state.interaction).toMatchObject({ kind: 'priority', seat: 1 });

    const frameBefore = priorityFrame(state);
    expect(frameBefore.consecutivePasses).toBe(1); // seat 0's silent auto-pass

    const pass = drive(state, d, { kind: 'passPriority' });
    expect(pass.lines.some((l) => l.level === 'info' && l.message.includes('passes priority'))).toBe(true);
    expect(state.interaction).toBeNull();
    // Both seats have now passed consecutively (threshold 2 for 2 seats) — the window closed and the
    // action resolved in this SAME dispatch, exactly like MTG4's collapse once the last decline lands.
    expect(state.actionStack).toEqual([]);
    expect(state.playerPools[HP][0]).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// V3 — a block window offers each OTHER seat in order; closes only after ALL decline consecutively.
// ---------------------------------------------------------------------------

describe('AC: V3 — block window excludes the announcer, closes only after every other seat declines', () => {
  // AC: V3
  it('order excludes the controller; the frame survives 2 declines and pops on the 3rd', () => {
    const window = winBlock({ passesToClose: 3 });
    const d = defNoResponder(4, window);
    const state = createPlayState(d, 'seed-v3');
    const lines: LogLine[] = [];

    stepUntilPriority(state, d, lines, { kind: 'fireEvent', name: 'doAnnounce', seat: 0 });
    const frame = priorityFrame(state);
    expect(frame.order).toEqual([1, 2, 3]); // seat 0 announced; includeStart:false excludes it

    stepOnce(state, d, lines); // seat 1 auto-passes
    expect(priorityFrame(state).consecutivePasses).toBe(1);
    stepOnce(state, d, lines); // seat 2 auto-passes
    expect(priorityFrame(state).consecutivePasses).toBe(2);
    // Still open — 2 of 3 declined.
    expect(state.stack[state.stack.length - 1]?.kind).toBe('priority');

    stepOnce(state, d, lines); // seat 3 auto-passes — the 3rd consecutive decline
    expect(priorityFrame(state).consecutivePasses).toBe(3);
    stepOnce(state, d, lines); // the NEXT call's own top-of-function threshold check pops it
    expect(state.stack.some((f) => f.kind === 'priority')).toBe(false); // popped
  });
});

// ---------------------------------------------------------------------------
// V4 — one seat blocks: passes resets to 0 and the round continues WITHOUT re-offering seats that
// already declined earlier in the same round.
// ---------------------------------------------------------------------------

describe('AC: V4 — a block resets passes and continues forward, not re-offering already-declined seats', () => {
  // AC: V4
  it('resets consecutivePasses to 0 and advances the cursor past the responder, not back to seat 1', () => {
    const window = winBlock({ passesToClose: 3 });
    const d = defOneResponder(4, window);
    const state = createPlayState(d, 'seed-v4');
    state.playerPools[CAN_RESPOND][2] = true; // seat 2 (the SECOND seat offered) may block
    const lines: LogLine[] = [];

    stepUntilPriority(state, d, lines, { kind: 'fireEvent', name: 'doAnnounce', seat: 0 });
    expect(priorityFrame(state).order).toEqual([1, 2, 3]);

    stepOnce(state, d, lines); // seat 1 auto-passes
    expect(priorityFrame(state).consecutivePasses).toBe(1);

    // seat 2 is offered next and has a legal response — raises rather than auto-passing.
    stepOnce(state, d, lines);
    expect(state.interaction).toMatchObject({ kind: 'priority', seat: 2 });

    // Respond — ONE step() call, so its own synchronous consecutivePasses/cursor reset is visible
    // immediately, before the pushed rule frame's effects (or the rest of the round) run any further.
    const respondResult = step(
      state,
      { kind: 'action', action: { kind: 'activate', ruleId: RS_RESPOND, cardId: null, seat: 2 }, override: false },
      lines,
      d
    );
    expect(respondResult.done).toBe(false); // more to do — the pushed rule frame hasn't run yet
    // The activated ability's own `rule` frame now sits ABOVE the priority frame (§9.4(a)'s nesting
    // shape) — find it rather than assuming it is still the top.
    const frame = anyPriorityFrame(state);
    expect(frame.consecutivePasses).toBe(0); // §5.5 — "a response resets passes to 0"
    expect(frame.order[frame.cursor]).toBe(3); // continues at seat 3, NOT back to seat 1
  });
});

// ---------------------------------------------------------------------------
// v4 §4.5 (AC: SP18) — an INTERACTIVE cost inside an open priority window. The window is where the
// two-pass cost has its sharpest interaction with §5.5, for two reasons this block pins:
//
//  - the cost's own prompt REPLACES the priority offer in `state.interaction` while it is open, so the
//    seat is being asked about its cost, not about its options; and
//  - §5.5's response bookkeeping (passes to 0, cursor forward) waits until the cost is actually PAID.
//    Doing it when the offer was taken would leave a cancelled cost having silently advanced the round.
//
// §4.5.0(b) is confirmed here too, in passing: the legality probe still offers the rule at all, which
// it only does because `passesActivationGates` evaluates `costCheck` as a CRITERION and never applies a
// cost effect — an interactive cost does not make the probe start asking questions.
// ---------------------------------------------------------------------------

describe('v4 §4.5 — an interactive cost inside a priority window (AC: SP18)', () => {
  /** Same per-seat gate as `costGated`, but the cost now ASKS: "pay how much?", then spends it. */
  function costAsks(window: string): RuleSet {
    return {
      ...costGated(window),
      activation: {
        ...costGated(window).activation!,
        cost: [
          { kind: 'chooseNumber', promptText: 'Pay how much?', seat: triggeringSeat, min: lit(0), max: lit(2), key: 'x' },
          { kind: 'changePool', poolId: HP, seat: triggeringSeat, op: 'subtract', amount: { kind: 'promptNumber', key: 'x' } },
        ],
      },
    };
  }

  function askingDef(window: PriorityWindow): GameDefinition {
    return def(2, [rsAnnounce(RS_ORIGINAL, window.id), rsOriginal, costAsks(window.id), rsResponse], [window]);
  }

  /** Fires the announce, walks to the priority offer, and activates — landing on the COST's prompt. */
  function upToCostPrompt(): { d: GameDefinition; state: PlayState; lines: LogLine[] } {
    const d = askingDef(winMtg());
    const state = createPlayState(d, 'seed-sp18-window');
    state.playerPools[CAN_RESPOND][0] = true;

    const { lines } = drive(state, d, { kind: 'fireEvent', name: 'doAnnounce', seat: 0 });
    expect(state.interaction).toMatchObject({ kind: 'priority', seat: 0 });

    step(state, { kind: 'action', action: { kind: 'activate', ruleId: RS_RESPOND, cardId: null, seat: 0 }, override: false }, lines, d);
    return { d, state, lines };
  }

  it('suspends on the COST prompt, leaving the window and the spend exactly as they were', () => {
    const { state } = upToCostPrompt();

    // The seat is now being asked about its cost, not about its options.
    expect(state.interaction).toMatchObject({ kind: 'chooseNumber', seat: 0, min: 0, max: 2 });
    expect(state.stack[state.stack.length - 1].kind).toBe('activation');
    expect(state.playerPools[HP][0]).toBe(20); // nothing spent
    // Untouched: no response has happened yet, so §5.5's reset has not either.
    const frame = anyPriorityFrame(state);
    expect(frame.consecutivePasses).toBe(0);
    expect(frame.order[frame.cursor]).toBe(0);
  });

  it('answering pays the cost and only THEN resets passes and advances the cursor', () => {
    const { d, state, lines } = upToCostPrompt();

    // `answerNumber` is one unit of work — it files the answer and clears the suspension, and that is
    // all. The cost is applied by the NEXT step, when `advance()` re-enters the `activation` frame.
    step(state, { kind: 'action', action: { kind: 'answerNumber', value: 2 }, override: false }, lines, d);
    expect(state.interaction).toBeNull();
    expect(state.playerPools[HP][0]).toBe(20);

    stepOnce(state, d, lines); // ...and here the cost lands, all of it, in one go
    expect(state.playerPools[HP][0]).toBe(18); // the cost spent, X = 2
    const frame = anyPriorityFrame(state);
    expect(frame.consecutivePasses).toBe(0); // §5.5 — a response resets passes
    expect(frame.order[frame.cursor]).toBe(1); // and the round continues at the next seat

    // Driving on, the response lands on the action stack exactly as a free cost's would (MTG1's shape).
    let result: StepResult = { done: false, suspended: false, haltedByLoopGuard: false };
    let n = 0;
    while (!result.done) {
      if (++n > RUNAWAY) throw new Error('runaway');
      result = stepOnce(state, d, lines);
    }
    expect(state.actionStack.map((id) => state.pendingActions[id].ruleId)).toContain(RS_RESPONSE);
  });

  it('cancelling the cost spends nothing and re-offers the SAME seat — declining to pay is not passing', () => {
    const { d, state, lines } = upToCostPrompt();

    step(state, { kind: 'action', action: { kind: 'cancelPrompt' }, override: false }, lines, d);

    expect(state.playerPools[HP][0]).toBe(20); // nothing spent
    expect(state.stack.some((f) => f.kind === 'activation')).toBe(false); // nothing half-activated
    const frame = anyPriorityFrame(state);
    expect(frame.consecutivePasses).toBe(0);
    expect(frame.order[frame.cursor]).toBe(0); // the cursor never moved

    // One more step and seat 0 is offered its options again, not skipped and not counted as a pass.
    stepOnce(state, d, lines);
    expect(state.interaction).toMatchObject({ kind: 'priority', seat: 0 });
    expect(state.actionStack.map((id) => state.pendingActions[id].ruleId)).not.toContain(RS_RESPONSE);
  });
});

// ---------------------------------------------------------------------------
// §9.5 edge case 1 — a seat eliminated while it holds the NEXT slot in `order` is skipped silently:
// no log entry, no interaction, `consecutivePasses` untouched.
// ---------------------------------------------------------------------------

describe('§9.5 edge case 1 — an eliminated seat is skipped silently, not counted as a pass', () => {
  it('advance steps past the eliminated seat without a log line or touching consecutivePasses', () => {
    const d = defNoResponder(3, winMtg());
    const state = createPlayState(d, 'seed-edge1');
    const lines: LogLine[] = [];

    stepUntilPriority(state, d, lines, { kind: 'fireEvent', name: 'doAnnounce', seat: 0 });
    expect(priorityFrame(state).order).toEqual([0, 1, 2]);

    stepOnce(state, d, lines); // seat 0 auto-passes
    expect(priorityFrame(state).consecutivePasses).toBe(1);
    expect(priorityFrame(state).cursor).toBe(1); // about to visit seat 1 next

    // Eliminate the seat whose cursor position is next.
    state.seatOrder = state.seatOrder.filter((s) => s !== 1);
    state.eliminated.push(1);

    const before = lines.length;
    stepOnce(state, d, lines); // must skip seat 1 silently
    expect(lines.length).toBe(before); // no new log line at all
    expect(priorityFrame(state).consecutivePasses).toBe(1); // untouched — not a pass
    expect(priorityFrame(state).cursor).toBe(2); // stepped past it to seat 2
  });
});

// ---------------------------------------------------------------------------
// §9.5 edge case 2 — passesToClose:null re-reads seatOrder.length live: a window opened at 5 seats
// pops at 4 consecutive passes once an elimination drops the table to 4, not at 5.
// ---------------------------------------------------------------------------

describe('§9.5 edge case 2 — the close threshold is re-read live, not captured at push time', () => {
  it('pops at 4 consecutive passes after an elimination, not 5', () => {
    const d = defNoResponder(5, winMtg());
    const state = createPlayState(d, 'seed-edge2');
    const lines: LogLine[] = [];

    stepUntilPriority(state, d, lines, { kind: 'fireEvent', name: 'doAnnounce', seat: 0 });
    expect(priorityFrame(state).order).toEqual([0, 1, 2, 3, 4]);

    stepOnce(state, d, lines); // seat 0
    stepOnce(state, d, lines); // seat 1
    stepOnce(state, d, lines); // seat 2
    expect(priorityFrame(state).consecutivePasses).toBe(3);
    expect(state.stack.some((f) => f.kind === 'priority')).toBe(true); // still open — 3 of 5

    // Drop the table to 4 BEFORE the 4th pass lands.
    state.seatOrder = state.seatOrder.filter((s) => s !== 4);
    state.eliminated.push(4);

    stepOnce(state, d, lines); // seat 3 — the 4th consecutive pass
    expect(priorityFrame(state).consecutivePasses).toBe(4);
    stepOnce(state, d, lines); // the NEXT call's own top-of-function threshold check pops it
    expect(state.stack.some((f) => f.kind === 'priority')).toBe(false); // closed at 4, not 5
  });
});

// ---------------------------------------------------------------------------
// §9.5 edge case 16 — maxPriorityRounds trips well under a hang-detector budget, at the new,
// higher default ceiling (256), same discipline as R4/SETTLE_DIVERGED.
// ---------------------------------------------------------------------------

describe('§9.5 edge case 16 — PRIORITY_EXHAUSTED trips fast at the new default ceiling', () => {
  it('trips well under 100ms and still resolves the action afterward', () => {
    // passesToClose is set far above the round cap, so the window can never close by passing —
    // PRIORITY_EXHAUSTED is the only way out.
    const d = defNoResponder(2, winMtg({ passesToClose: 1_000_000 }));
    const state = createPlayState(d, 'seed-edge16');

    const t0 = performance.now();
    const run = drive(state, d, { kind: 'fireEvent', name: 'doAnnounce', seat: 0 });
    const ms = performance.now() - t0;

    expect(ms).toBeLessThan(100);
    expect(state.budget.priorityRounds).toBe(DEFAULT_MAX_PRIORITY_ROUNDS + 1);
    const trip = run.lines.filter((l) => l.level === 'reject' && l.message.includes('PRIORITY_EXHAUSTED'));
    expect(trip).toHaveLength(1);
    expect(trip[0].message).toContain(`> limit ${DEFAULT_MAX_PRIORITY_ROUNDS}`);
    // The safety valve closes the window and lets resolution continue — not a chain halt.
    expect(run.result.haltedByLoopGuard).toBe(false);
    expect(state.actionStack).toEqual([]);
    expect(state.playerPools[HP][0]).toBe(17);
  });

  // §9.5 edge case 9 — override does NOT bypass PRIORITY_EXHAUSTED: it is RULE_LOOP's sibling (a
  // §5.5 safety valve), not a move/target-destination check. `advancePriority` never reads an
  // `override` flag at all — the round cap trips identically regardless.
  it('override does NOT bypass PRIORITY_EXHAUSTED — the window still closes at the same round count', () => {
    const d = defNoResponder(2, winMtg({ passesToClose: 1_000_000 }));
    const state = createPlayState(d, 'seed-edge16-override');

    const run = drive(state, d, { kind: 'fireEvent', name: 'doAnnounce', seat: 0 }, true); // override: true

    expect(state.budget.priorityRounds).toBe(DEFAULT_MAX_PRIORITY_ROUNDS + 1);
    const trip = run.lines.filter((l) => l.level === 'reject' && l.message.includes('PRIORITY_EXHAUSTED'));
    expect(trip).toHaveLength(1);
    expect(run.lines.some((l) => l.level === 'override')).toBe(false); // never logged as one — it wasn't
  });
});

// ---------------------------------------------------------------------------
// §9.4(b) — seat-elimination determinism. Two 5-seat sessions, same seed, seat 3 eliminated at a
// DIFFERENT point in each (once mid-priority-window, once between transactions entirely) but
// converging on the same eventual game state — `seatOrder` and every `relative` resolution must
// agree regardless of WHEN within a transaction the elimination landed.
// ---------------------------------------------------------------------------

describe('§9.4(b) seat-elimination determinism — mid-window vs. between-transaction, same result', () => {
  const triggeringCtx = { triggeringCardId: null, zoneKey: null, triggeringSeat: 0, promptAnswers: {}, sourceCardId: null };
  const relativeFrom = (index: number, offset: number): SeatRef => ({ kind: 'relative', from: { kind: 'seat', index }, offset });

  it('converges on the same seatOrder and the same relative resolution either way', () => {
    // Session A — eliminated MID-WINDOW, between two of the round's own auto-passes.
    const dA = defNoResponder(5, winMtg());
    const stateA = createPlayState(dA, 'seed-9-4-b-elim');
    const linesA: LogLine[] = [];
    stepUntilPriority(stateA, dA, linesA, { kind: 'fireEvent', name: 'doAnnounce', seat: 0 });
    expect(priorityFrame(stateA).order).toEqual([0, 1, 2, 3, 4]);
    stepOnce(stateA, dA, linesA); // seat 0 auto-passes
    stepOnce(stateA, dA, linesA); // seat 1 auto-passes
    stateA.seatOrder = stateA.seatOrder.filter((s) => s !== 3); // eliminated mid-round, seat 3 next up
    stateA.eliminated.push(3);
    let n = 0;
    while (stateA.stack.some((f) => f.kind === 'priority')) {
      if (++n > 10_000) throw new Error('runaway');
      stepOnce(stateA, dA, linesA);
    }

    // Session B — same seed, same window, but eliminated only AFTER the window has fully closed and
    // the action resolved — an entirely separate later transaction, no window open at all.
    const dB = defNoResponder(5, winMtg());
    const stateB = createPlayState(dB, 'seed-9-4-b-elim');
    const runB = drive(stateB, dB, { kind: 'fireEvent', name: 'doAnnounce', seat: 0 });
    expect(runB.result.done).toBe(true);
    expect(stateB.stack.some((f) => f.kind === 'priority')).toBe(false); // window fully closed already
    stateB.seatOrder = stateB.seatOrder.filter((s) => s !== 3);
    stateB.eliminated.push(3);

    // Converged: same seatOrder, same eliminated set, regardless of timing.
    expect(stateA.seatOrder).toEqual([0, 1, 2, 4]);
    expect(stateB.seatOrder).toEqual([0, 1, 2, 4]);
    expect(stateA.seatOrder).toEqual(stateB.seatOrder);
    expect(stateA.eliminated).toEqual(stateB.eliminated);

    // And every `relative` resolution agrees too — "the seat after 2" and "the seat before 4" both
    // land on the same answer in both sessions.
    const nextAfter2A = resolveSeat(relativeFrom(2, 1), stateA, triggeringCtx);
    const nextAfter2B = resolveSeat(relativeFrom(2, 1), stateB, triggeringCtx);
    expect(nextAfter2A).toEqual(nextAfter2B);
    expect(nextAfter2A).toMatchObject({ ok: true, seats: [4] });

    const beforeElim0A = resolveSeat(relativeFrom(0, -1), stateA, triggeringCtx);
    const beforeElim0B = resolveSeat(relativeFrom(0, -1), stateB, triggeringCtx);
    expect(beforeElim0A).toEqual(beforeElim0B);
  });
});
