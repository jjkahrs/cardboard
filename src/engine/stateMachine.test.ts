import { describe, expect, it } from 'vitest';
import { applyTransition, checkTransitionLegal, findAutoTransition, manualTransitions } from './stateMachine';
import { createPlayState } from './setup';
import {
  COMBAT,
  duel,
  duelOneSidedEdge,
  END_TURN,
  MAIN,
  ATTACKERS,
  UNTAP,
} from '../test/fixtures/duel';
import {
  END_STATE_ID,
  START_STATE_ID,
  type EventName,
  type GameDefinition,
  type LogLine,
  type MachineState,
  type PlayState,
  type TriggerContext,
} from './types';

const CTX: TriggerContext = { triggeringCardId: null, zoneKey: null, triggeringSeat: 0, promptAnswers: {} };

function stateAt(stateId: string, def: GameDefinition = duel): PlayState {
  const state = createPlayState(def, 'seed');
  state.currentStateId = stateId;
  return state;
}

/** Stand-in for effects.ts's EffectContext — recording, so tests can assert fire ORDER. */
function makeEc(state: PlayState, def: GameDefinition = duel, override = false) {
  const fired: EventName[] = [];
  const logged: LogLine[] = [];
  return {
    ec: {
      state,
      def,
      ctx: CTX,
      depth: 0,
      override,
      log: (l: LogLine) => logged.push(l),
      fireEvent: (name: EventName) => fired.push(name),
    },
    fired,
    logged,
  };
}

// ---------------------------------------------------------------------------
// Legality — §5.6, §5.9 rows 5 / 5b
// ---------------------------------------------------------------------------

describe('checkTransitionLegal', () => {
  it('accepts a two-sided edge', () => {
    expect(checkTransitionLegal(duel, MAIN, COMBAT)).toEqual({ ok: true });
  });

  it('is a conjunction, not a disjunction — a one-sided edge is rejected', () => {
    // duelOneSidedEdge: Main.exitableTo lists Untap, Untap.enterableFrom does not list Main.
    const res = checkTransitionLegal(duelOneSidedEdge, MAIN, UNTAP);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'ONE_SIDED_EDGE' });
    expect(res.ok === false && res.detail).toBe(
      'Transition Main → Untap: "Main".exitableTo lists "Untap", but "Untap".enterableFrom does not list "Main". Edge is one-sided.'
    );
  });

  it('names the other missing side when only enterableFrom lists the edge', () => {
    // Mirror of the above: Untap.enterableFrom gains Main, Main.exitableTo does not list Untap.
    const def: GameDefinition = {
      ...duel,
      machine: {
        ...duel.machine,
        states: duel.machine.states.map((s) =>
          s.id === UNTAP ? { ...s, enterableFrom: [START_STATE_ID, MAIN] } : s
        ),
      },
    };
    const res = checkTransitionLegal(def, MAIN, UNTAP);
    expect(res).toMatchObject({ reason: 'ONE_SIDED_EDGE' });
    expect(res.ok === false && res.detail).toContain('"Main".exitableTo does not list "Untap"');
  });

  it('a wholly absent edge gets a distinct reason from a one-sided one', () => {
    const absent = checkTransitionLegal(duel, MAIN, UNTAP);
    const oneSided = checkTransitionLegal(duelOneSidedEdge, MAIN, UNTAP);
    expect(absent).toMatchObject({ reason: 'ILLEGAL_TRANSITION' });
    expect(oneSided).toMatchObject({ reason: 'ONE_SIDED_EDGE' });
  });

  it('an unknown state is a missing referent, not an illegal transition', () => {
    expect(checkTransitionLegal(duel, MAIN, 'state_nope')).toMatchObject({ reason: 'MISSING_REFERENT' });
    expect(checkTransitionLegal(duel, 'state_nope', MAIN)).toMatchObject({ reason: 'MISSING_REFERENT' });
  });
});

// ---------------------------------------------------------------------------
// M1 — the quiescence scan
// ---------------------------------------------------------------------------

describe('findAutoTransition', () => {
  it('finds nothing while no entry criteria hold', () => {
    expect(findAutoTransition(stateAt(MAIN), duel, CTX)).toBeNull();
  });

  // AC: M1
  it('makes Combat eligible from Main once attackers > 0', () => {
    const state = stateAt(MAIN);
    state.playerPools[ATTACKERS][0] = 1;
    expect(findAutoTransition(state, duel, CTX)).toEqual({ toStateId: COMBAT, eligible: [COMBAT] });
  });

  // AC: M1
  it('transitions and appends onStateExit(Main) then onStateEnter(Combat), in that order', () => {
    const state = stateAt(MAIN);
    state.playerPools[ATTACKERS][0] = 1;
    const found = findAutoTransition(state, duel, CTX)!;
    const { ec, fired } = makeEc(state);

    expect(applyTransition(ec, found.toStateId, { forced: false })).toEqual({ ok: true });
    expect(state.currentStateId).toBe(COMBAT);
    expect(fired).toEqual(['onStateExit', 'onStateEnter']);
  });

  it('never auto-enters a criteria-less state', () => {
    // EndTurn is legally reachable from Main and has no entryCriteria — it stays a button.
    expect(findAutoTransition(stateAt(MAIN), duel, CTX)).toBeNull();
    const state = stateAt(MAIN);
    state.playerPools[ATTACKERS][0] = 1;
    expect(findAutoTransition(state, duel, CTX)!.eligible).not.toContain(END_TURN);
  });

  it('ignores a state whose criteria hold but whose edge is one-sided', () => {
    // Give Untap entry criteria that hold, but leave the edge one-sided.
    const def: GameDefinition = {
      ...duelOneSidedEdge,
      machine: {
        ...duelOneSidedEdge.machine,
        states: duelOneSidedEdge.machine.states.map((s) =>
          s.id === UNTAP ? { ...s, entryCriteria: { kind: 'criteria', left: { kind: 'literal', value: 1 }, op: '=', right: { kind: 'literal', value: 1 } } } : s
        ) as MachineState[],
      },
    };
    expect(findAutoTransition(stateAt(MAIN, def), def, CTX)).toBeNull();
  });

  it('returns null from a state with no outbound edges', () => {
    expect(findAutoTransition(stateAt(UNTAP), duel, CTX)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tiebreak — §5.6, §5.9 row 14
// ---------------------------------------------------------------------------

describe('tiebreak', () => {
  const always = { kind: 'criteria', left: { kind: 'literal', value: 1 }, op: '=', right: { kind: 'literal', value: 1 } } as const;

  /** Main → [Combat, EndTurn], both always-eligible, with the given priorities. */
  function twoEligible(combatPriority: number, endTurnPriority: number, exitableTo = [COMBAT, END_TURN]): GameDefinition {
    return {
      ...duel,
      machine: {
        ...duel.machine,
        states: duel.machine.states.map((s) => {
          if (s.id === MAIN) return { ...s, exitableTo };
          if (s.id === COMBAT) return { ...s, entryCriteria: always, priority: combatPriority };
          if (s.id === END_TURN) return { ...s, entryCriteria: always, priority: endTurnPriority };
          return s;
        }) as MachineState[],
      },
    };
  }

  it('reports every eligible state so the caller can warn — §5.9 row 14', () => {
    const def = twoEligible(0, 0);
    const res = findAutoTransition(stateAt(MAIN, def), def, CTX)!;
    expect(res.eligible).toHaveLength(2);
    expect(res.eligible).toEqual([COMBAT, END_TURN]);
  });

  it('picks by target priority, descending', () => {
    const def = twoEligible(0, 5); // EndTurn wins on priority despite being second in exitableTo
    expect(findAutoTransition(stateAt(MAIN, def), def, CTX)!.toStateId).toBe(END_TURN);
  });

  it('falls back to exitableTo order when priority does not decide', () => {
    const def = twoEligible(3, 3);
    expect(findAutoTransition(stateAt(MAIN, def), def, CTX)!.toStateId).toBe(COMBAT);
  });

  it('exitableTo order governs over declaration order — reordering it flips the winner', () => {
    // Declaration order in machine.states is Combat before EndTurn and never changes here.
    const def = twoEligible(0, 0, [END_TURN, COMBAT]);
    expect(findAutoTransition(stateAt(MAIN, def), def, CTX)!.toStateId).toBe(END_TURN);
  });

  it('a duplicated exitableTo entry is one edge, not two', () => {
    const def = twoEligible(0, 0, [COMBAT, END_TURN, COMBAT]);
    expect(findAutoTransition(stateAt(MAIN, def), def, CTX)!.eligible).toEqual([COMBAT, END_TURN]);
  });
});

// ---------------------------------------------------------------------------
// manualTransitions — M2's buttons
// ---------------------------------------------------------------------------

describe('manualTransitions', () => {
  it('returns only criteria-less, legally reachable states', () => {
    // Main → [Combat (has criteria), EndTurn (none)]
    expect(manualTransitions(stateAt(MAIN), duel).map((s) => s.id)).toEqual([END_TURN]);
    expect(manualTransitions(stateAt(MAIN), duel)[0].transitionLabel).toBe('End Turn');
  });

  it('excludes a state with entry criteria', () => {
    expect(manualTransitions(stateAt(MAIN), duel).map((s) => s.id)).not.toContain(COMBAT);
  });

  it('excludes a one-sided edge', () => {
    expect(manualTransitions(stateAt(MAIN), duelOneSidedEdge).map((s) => s.id)).not.toContain(UNTAP);
  });

  it('is empty from a state with no outbound edges', () => {
    expect(manualTransitions(stateAt(UNTAP), duel)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M3 — rejection
// ---------------------------------------------------------------------------

describe('applyTransition rejection', () => {
  // AC: M3
  it('rejects Main → Untap naming the missing side, changing nothing', () => {
    const state = stateAt(MAIN);
    const { ec, fired, logged } = makeEc(state);

    const res = applyTransition(ec, UNTAP, { forced: false });

    expect(res).toMatchObject({ reason: 'ILLEGAL_TRANSITION' });
    expect(res.ok === false && res.detail).toBe(
      'Transition Main → Untap: "Untap".enterableFrom does not list "Main".'
    );
    expect(state.currentStateId).toBe(MAIN);
    expect(fired).toEqual([]);
    expect(logged.map((l) => l.level)).toEqual(['reject']);
  });

  it('rejects a one-sided edge without firing events', () => {
    const state = stateAt(MAIN, duelOneSidedEdge);
    const { ec, fired } = makeEc(state, duelOneSidedEdge);
    expect(applyTransition(ec, UNTAP, { forced: false })).toMatchObject({ reason: 'ONE_SIDED_EDGE' });
    expect(state.currentStateId).toBe(MAIN);
    expect(fired).toEqual([]);
  });

  it('a forceTransition effect does not bypass legality — only override does', () => {
    const state = stateAt(MAIN);
    const { ec } = makeEc(state);
    expect(applyTransition(ec, UNTAP, { forced: true })).toMatchObject({ reason: 'ILLEGAL_TRANSITION' });
    expect(state.currentStateId).toBe(MAIN);
  });

  it('override cannot invent a state that does not exist', () => {
    const state = stateAt(MAIN);
    const { ec, fired } = makeEc(state, duel, true);
    expect(applyTransition(ec, 'state_nope', { forced: false })).toMatchObject({ reason: 'MISSING_REFERENT' });
    expect(state.currentStateId).toBe(MAIN);
    expect(fired).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §5.9 row 5c — override
// ---------------------------------------------------------------------------

describe('override', () => {
  it('performs an illegal transition, flags it, and still fires both events', () => {
    const state = stateAt(MAIN);
    const { ec, fired, logged } = makeEc(state, duel, true);

    expect(applyTransition(ec, UNTAP, { forced: false })).toEqual({ ok: true });
    expect(state.currentStateId).toBe(UNTAP);
    expect(fired).toEqual(['onStateExit', 'onStateEnter']);
    expect(logged.map((l) => l.level)).toEqual(['override']);
    expect(logged[0].message).toContain('Transition Main → Untap performed despite');
  });

  it('performs a one-sided edge and flags it as such', () => {
    const state = stateAt(MAIN, duelOneSidedEdge);
    const { ec, logged } = makeEc(state, duelOneSidedEdge, true);
    expect(applyTransition(ec, UNTAP, { forced: false })).toEqual({ ok: true });
    expect(logged[0].message).toContain('one-sided edge');
  });
});

// ---------------------------------------------------------------------------
// M5 — reaching End
// ---------------------------------------------------------------------------

describe('reaching End', () => {
  // AC: M5
  it('sets finished and fires onGameEnd exactly once, after the state events', () => {
    const state = stateAt(END_TURN);
    const { ec, fired } = makeEc(state);

    expect(applyTransition(ec, END_STATE_ID, { forced: false })).toEqual({ ok: true });
    expect(state.currentStateId).toBe(END_STATE_ID);
    expect(state.finished).toBe(true);
    expect(fired).toEqual(['onStateExit', 'onStateEnter', 'onGameEnd']);
    expect(fired.filter((e) => e === 'onGameEnd')).toHaveLength(1);
  });

  it('does not set finished for any other state', () => {
    const state = stateAt(MAIN);
    const { ec, fired } = makeEc(state);
    applyTransition(ec, END_TURN, { forced: false });
    expect(state.finished).toBe(false);
    expect(fired).not.toContain('onGameEnd');
  });

  /**
   * The repro the audit found: `End.exitableTo` non-empty is now rejected at import (schema.ts),
   * but the RUNTIME must not depend on that — a `forceTransition` effect on a rule frame reaches
   * applyTransition without passing dispatch's `finished` guard. Asserting "once per call" (the
   * test above) cannot catch this; this asserts once across the WHOLE cascade.
   */
  it('fires onGameEnd exactly once across an End → S → End cascade', () => {
    const cyclic: GameDefinition = {
      ...duel,
      machine: {
        ...duel.machine,
        states: duel.machine.states.map((s) => {
          if (s.id === END_STATE_ID) return { ...s, exitableTo: [MAIN] };
          if (s.id === MAIN) return { ...s, enterableFrom: [...s.enterableFrom, END_STATE_ID] };
          return s;
        }) as MachineState[],
      },
    };
    const state = stateAt(END_TURN, cyclic);
    const { ec, fired } = makeEc(state, cyclic);

    expect(applyTransition(ec, END_STATE_ID, { forced: false })).toEqual({ ok: true });
    expect(state.finished).toBe(true);

    // Both legs of the cycle must now be refused, so onGameEnd cannot fire a second time.
    expect(applyTransition(ec, MAIN, { forced: true })).toMatchObject({ reason: 'SESSION_FINISHED' });
    expect(state.currentStateId).toBe(END_STATE_ID);
    expect(applyTransition(ec, END_STATE_ID, { forced: true })).toMatchObject({ reason: 'SESSION_FINISHED' });

    expect(fired.filter((e) => e === 'onGameEnd')).toHaveLength(1);
    expect(fired).toEqual(['onStateExit', 'onStateEnter', 'onGameEnd']);
  });

  // §9.4 item 8: override must NOT bypass SESSION_FINISHED.
  it('override does not bypass a finished session', () => {
    const state = stateAt(END_TURN);
    const { ec } = makeEc(state, duel, true);
    applyTransition(ec, END_STATE_ID, { forced: false });
    expect(applyTransition(ec, END_TURN, { forced: false })).toMatchObject({ reason: 'SESSION_FINISHED' });
    expect(state.currentStateId).toBe(END_STATE_ID);
  });

  it('a rejected transition into End leaves finished false', () => {
    const state = stateAt(MAIN); // Main → End is not an edge
    const { ec } = makeEc(state);
    expect(applyTransition(ec, END_STATE_ID, { forced: false }).ok).toBe(false);
    expect(state.finished).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Event context — §5.7's binding rule
// ---------------------------------------------------------------------------

describe('event context', () => {
  it('does not leak a triggering card into onStateEnter/onStateExit', () => {
    const state = stateAt(MAIN);
    const seen: TriggerContext[] = [];
    const ec = {
      state,
      def: duel,
      ctx: { triggeringCardId: 'c1', zoneKey: 'zone_hand#0', triggeringSeat: 1, promptAnswers: {} },
      depth: 2,
      override: false,
      log: () => {},
      fireEvent: (_name: EventName, ctx: TriggerContext) => seen.push(ctx),
    };

    applyTransition(ec, END_TURN, { forced: false });

    expect(seen).toHaveLength(2);
    expect(seen[0].triggeringCardId).toBeNull();
    expect(seen[0].zoneKey).toBeNull();
    expect(seen[0].triggeringSeat).toBe(1);
  });
});
