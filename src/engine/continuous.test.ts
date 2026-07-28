import { describe, expect, it } from 'vitest';

import { continuousKey, scanContinuous } from './continuous';
import { step } from './dispatch';
import { createPlayState } from './setup';
import {
  CONTINUE,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
  type EngineInput,
  type GameDefinition,
  type LogLine,
  type PlayAction,
  type PlayState,
  type PointPool,
  type RuleSet,
  type StepResult,
} from './types';

/**
 * All fixtures here are card-less and rule-bound only through `globalRuleSetIds` — §5.6's fixpoint
 * does not need a card to exercise, and every ACTUAL card-attachment behaviour it inherits (one arm
 * per card instance) is a direct, un-special-cased consequence of `collectBindings` walking zones
 * exactly like `dispatch.ts`'s `resolveBindings` does — proven for the event path already in
 * `dispatch.test.ts` and not re-proven here.
 *
 * Every continuous rule below sets `trigger: 'unused'` — a name nothing ever fires — precisely so a
 * driver action (`start`, a harmless `fireEvent`) reaches settle without ALSO binding the rule
 * through the ordinary event path. `continuous: true` makes the engine ignore `trigger` at
 * evaluation time (§5.6), but `resolveBindings` in `dispatch.ts` does not know that — it will still
 * match a continuous rule whose `trigger` happens to equal the event just fired, double-running it.
 */
const UNUSED_TRIGGER = 'unused';

interface Run {
  lines: LogLine[];
  result: StepResult;
}

/** Exactly what `sessionStore.ts` does (§3.3): re-enter with CONTINUE until `done`. */
function drive(state: PlayState, def: GameDefinition, action: PlayAction): Run {
  const lines: LogLine[] = [];
  let input: EngineInput = { kind: 'action', action, override: false };
  let result = step(state, input, lines, def);
  let steps = 0;
  while (!result.done) {
    if (++steps > 100_000) throw new Error('driver runaway — the settle/loop guard did not stop the chain');
    input = CONTINUE;
    result = step(state, input, lines, def);
  }
  return { lines, result };
}

function base(over: Partial<GameDefinition> & { pools?: PointPool[]; ruleSets?: RuleSet[] }): GameDefinition {
  const ruleSets = over.ruleSets ?? [];
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'game_continuous',
    name: 'Continuous fixture',
    playerCount: 2,
    pools: over.pools ?? [],
    zones: [],
    templates: [],
    decks: [],
    customEvents: [],
    ruleSets,
    globalRuleSetIds: ruleSets.map((r) => r.id),
    priorityWindows: [],
    machine: { states: [{ id: START_STATE_ID, name: 'start', enterableFrom: [], exitableTo: [], entryCriteria: null, transitionLabel: null, priority: 0, position: { x: 0, y: 0 } }, { id: END_STATE_ID, name: 'end', enterableFrom: [], exitableTo: [], entryCriteria: null, transitionLabel: null, priority: 0, position: { x: 0, y: 0 } }], startStateId: START_STATE_ID, endStateId: END_STATE_ID },
    limits: {
      maxDepth: DEFAULT_MAX_DEPTH,
      maxEffects: DEFAULT_MAX_EFFECTS,
      maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
      maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const ruleLines = (lines: LogLine[], ruleId: string) =>
  lines.filter((l) => l.kind === 'rule' && l.level === 'info' && l.ruleId === ruleId);

// ---------------------------------------------------------------------------
// The binding key — §10.2's decision, unit-level.
// ---------------------------------------------------------------------------

describe('continuousKey — §10.2 decision', () => {
  it('is `${ruleId}:` for a game-level rule (sourceCardId null)', () => {
    expect(continuousKey('rs_x', null)).toBe('rs_x:');
  });

  it('is `${ruleId}:${cardId}` for a card-attached rule, so two instances of one card never collide', () => {
    expect(continuousKey('rs_x', 'c0')).toBe('rs_x:c0');
    expect(continuousKey('rs_x', 'c1')).toBe('rs_x:c1');
    expect(continuousKey('rs_x', 'c0')).not.toBe(continuousKey('rs_x', 'c1'));
  });
});

// ---------------------------------------------------------------------------
// AC: SP9 — two rules, one settle pass arms the next, both fire in one transaction.
// ---------------------------------------------------------------------------

describe('AC: SP9 — a rule\'s effect arms a second rule\'s condition within one transaction', () => {
  const TRIGGER = 'pool_trigger';
  const DERIVED = 'pool_derived';
  const MARK = 'pool_mark';

  const ruleA: RuleSet = {
    id: 'rs_a',
    name: 'A — arms B',
    trigger: UNUSED_TRIGGER,
    stateFilter: null,
    condition: { kind: 'criteria', left: { kind: 'pool', poolId: TRIGGER, seat: null }, op: '=', right: { kind: 'literal', value: true } },
    effects: [{ kind: 'changePool', poolId: DERIVED, seat: null, op: 'set', amount: { kind: 'literal', value: true } }],
    priority: 10,
    onRejection: 'continue',
    modifier: null,
    continuous: true,
    replaces: null,
    activation: null,
  };

  const ruleB: RuleSet = {
    id: 'rs_b',
    name: 'B — armed by A',
    trigger: UNUSED_TRIGGER,
    stateFilter: null,
    condition: { kind: 'criteria', left: { kind: 'pool', poolId: DERIVED, seat: null }, op: '=', right: { kind: 'literal', value: true } },
    effects: [{ kind: 'changePool', poolId: MARK, seat: null, op: 'set', amount: { kind: 'literal', value: true } }],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: true,
    replaces: null,
    activation: null,
  };

  const def = base({
    pools: [
      { id: TRIGGER, scope: 'game', value: { type: 'boolean', name: 'Trigger', defaultValue: true } },
      { id: DERIVED, scope: 'game', value: { type: 'boolean', name: 'Derived', defaultValue: false } },
      { id: MARK, scope: 'game', value: { type: 'boolean', name: 'Mark', defaultValue: false } },
    ],
    ruleSets: [ruleA, ruleB],
  });

  // AC: SP9
  it('both rules fire — and A\'s effect is what makes B eligible — inside one drive() (one LogEntry)', () => {
    const state = createPlayState(def, 'seed');
    const { lines, result } = drive(state, def, { kind: 'start' });

    expect(result).toEqual({ done: true, suspended: false, haltedByLoopGuard: false });
    // Both effects actually ran, not just "conditions were true" — DERIVED came from A, MARK from B.
    expect(state.pools[DERIVED]).toBe(true);
    expect(state.pools[MARK]).toBe(true);
    // Both continuousFired keys present after settle (§5.6, §9.4(c)).
    expect(state.continuousFired[continuousKey(ruleA.id, null)]).toBe(true);
    expect(state.continuousFired[continuousKey(ruleB.id, null)]).toBe(true);
    // Each rule ran exactly once — B did not fire before A armed it, and A did not re-fire once true.
    expect(ruleLines(lines, ruleA.id)).toHaveLength(1);
    expect(ruleLines(lines, ruleB.id)).toHaveLength(1);
    // More than one settle pass was needed (A's effect isn't visible to B until the NEXT pass — see
    // continuous.ts's module comment) — proof this is really the fixpoint re-entering, not a fluke
    // of evaluation order within a single pass.
    expect(state.budget.settleIterations).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// AC: MTG9 — a continuous rule eliminates a seat at zero life; session continues.
// ---------------------------------------------------------------------------

describe('AC: MTG9 — zero-life elimination lands at the next settle, session continues', () => {
  const LIFE = 'pool_life';
  const SCORE = 'pool_score';

  /**
   * §10.2's decision means "a player at zero life is eliminated" has no card to attach to, so it is
   * authored as one GLOBAL rule PER SEAT — see continuous.ts's `continuousKey` doc comment for why a
   * single global rule covering every seat cannot work (it would have exactly one arm for the whole
   * table).
   */
  const eliminateAtZero = (seatIndex: number, id: string): RuleSet => ({
    id,
    name: `Eliminate seat ${seatIndex} at zero life`,
    trigger: UNUSED_TRIGGER,
    stateFilter: null,
    condition: {
      kind: 'criteria',
      left: { kind: 'pool', poolId: LIFE, seat: { kind: 'seat', index: seatIndex } },
      op: '<=',
      right: { kind: 'literal', value: 0 },
    },
    effects: [{ kind: 'eliminateSeat', seat: { kind: 'seat', index: seatIndex } }],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: true,
    replaces: null,
    activation: null,
  });

  const rsElim0 = eliminateAtZero(0, 'rs_elim0');
  const rsElim1 = eliminateAtZero(1, 'rs_elim1');

  /** Proves the session (and OTHER seats) still act, both before and after an elimination lands. */
  const scoreRule: RuleSet = {
    id: 'rs_score',
    name: 'Score',
    trigger: 'score',
    stateFilter: null,
    condition: null,
    effects: [{ kind: 'changePool', poolId: SCORE, seat: { kind: 'triggeringSeat' }, op: 'add', amount: { kind: 'literal', value: 1 } }],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: false,
    replaces: null,
    activation: null,
  };

  const def = base({
    pools: [
      { id: LIFE, scope: 'player', value: { type: 'integer', name: 'Life', defaultValue: 20, min: 0, max: 20 } },
      { id: SCORE, scope: 'player', value: { type: 'integer', name: 'Score', defaultValue: 0, min: 0, max: null } },
    ],
    ruleSets: [rsElim0, rsElim1, scoreRule],
    customEvents: ['score'],
  });

  // AC: MTG9
  it('seat 1 at zero life is eliminated at settle; eliminated/seatOrder/finished all update; seat 0 still acts after', () => {
    const state = createPlayState(def, 'seed');
    drive(state, def, { kind: 'start' }); // settles the initial (both seats at full life) state
    expect(state.eliminated).toEqual([]);

    state.playerPools[LIFE][1] = 0; // seat 1 takes lethal damage — driven directly, as effects.test.ts does
    const elim = drive(state, def, { kind: 'fireEvent', name: 'tick', seat: 0 });

    expect(elim.result).toEqual({ done: true, suspended: false, haltedByLoopGuard: false });
    expect(state.eliminated).toEqual([1]);
    expect(state.seatOrder).toEqual([0]);
    expect(state.finished).toBe(false);
    expect(ruleLines(elim.lines, rsElim1.id)).toHaveLength(1);

    // Other seats still act AFTER the elimination — a fresh transaction, seat 0 alone.
    const after = drive(state, def, { kind: 'fireEvent', name: 'score', seat: 0 });
    expect(after.result).toEqual({ done: true, suspended: false, haltedByLoopGuard: false });
    expect(state.playerPools[SCORE][0]).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // §9.4(c) — the non-termination trap. `life <= 0` stays true forever once eliminated; nothing
  // un-sets it. Without `continuousFired`, EVERY later settle for the rest of the session re-runs
  // `eliminateSeat` on an already-eliminated seat.
  // ---------------------------------------------------------------------------
  it('§9.4(c) trap — the rule fires exactly once, and continuousFired never clears, across 3+ later transactions', () => {
    const state = createPlayState(def, 'seed');
    drive(state, def, { kind: 'start' });
    state.playerPools[LIFE][1] = 0;

    const first = drive(state, def, { kind: 'fireEvent', name: 'tick', seat: 0 });
    expect(state.eliminated).toEqual([1]);
    const key = continuousKey(rsElim1.id, null);
    expect(state.continuousFired[key]).toBe(true);
    expect(ruleLines(first.lines, rsElim1.id)).toHaveLength(1);

    // At least three MORE transactions after the elimination — §9.4(c)'s "rest of the session".
    for (let i = 0; i < 3; i++) {
      const run = drive(state, def, { kind: 'fireEvent', name: 'score', seat: 0 });
      expect(run.result.haltedByLoopGuard).toBe(false);
      // The rule never fires again — no second `eliminateSeat` attempt on the same seat.
      expect(ruleLines(run.lines, rsElim1.id)).toHaveLength(0);
      // Never cleared: the condition (life <= 0) never goes false, so the key never gets deleted.
      expect(state.continuousFired[key]).toBe(true);
      expect(state.eliminated).toEqual([1]); // still just the one seat, never re-appended
    }
    // Seat 0 kept acting the whole time — the session is genuinely still alive, not stalled.
    expect(state.playerPools[SCORE][0]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// §9.5 edge case 10 — two independent global rules, no card binding, must not share one key.
// ---------------------------------------------------------------------------

describe('§9.5 #10 — two card-less global continuous rules never collide on one continuousFired key', () => {
  const X = 'pool_x';
  const Y = 'pool_y';

  const ruleX: RuleSet = {
    id: 'rs_watchX',
    name: 'Watch X',
    trigger: UNUSED_TRIGGER,
    stateFilter: null,
    condition: { kind: 'criteria', left: { kind: 'pool', poolId: X, seat: null }, op: '>', right: { kind: 'literal', value: 0 } },
    effects: [], // firing itself, via continuousFired, is the thing under test
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: true,
    replaces: null,
    activation: null,
  };

  const ruleY: RuleSet = {
    id: 'rs_watchY',
    name: 'Watch Y',
    trigger: UNUSED_TRIGGER,
    stateFilter: null,
    condition: { kind: 'criteria', left: { kind: 'pool', poolId: Y, seat: null }, op: '>', right: { kind: 'literal', value: 0 } },
    effects: [],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: true,
    replaces: null,
    activation: null,
  };

  const def = base({
    pools: [
      { id: X, scope: 'game', value: { type: 'integer', name: 'X', defaultValue: 5, min: 0, max: null } },
      { id: Y, scope: 'game', value: { type: 'integer', name: 'Y', defaultValue: 0, min: 0, max: null } }, // Y's condition starts false
    ],
    ruleSets: [ruleX, ruleY],
  });

  it('only the rule whose condition is true gets a key; the other stays unset, and the two keys differ', () => {
    const state = createPlayState(def, 'seed');
    drive(state, def, { kind: 'start' });

    expect(continuousKey(ruleX.id, null)).not.toBe(continuousKey(ruleY.id, null));
    expect(state.continuousFired[continuousKey(ruleX.id, null)]).toBe(true);
    expect(state.continuousFired[continuousKey(ruleY.id, null)]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The budget — a genuine continuous cycle halts via SETTLE_DIVERGED, fast.
// ---------------------------------------------------------------------------

describe('settle budget — a genuine continuous-condition cycle halts via SETTLE_DIVERGED', () => {
  const FLAG_A = 'pool_flagA';
  const FLAG_B = 'pool_flagB';

  /** A ⇄ B: each rule's effect makes the OTHER's condition true and its own false — never converges. */
  const ruleA: RuleSet = {
    id: 'rs_flip_a',
    name: 'Flip A -> B',
    trigger: UNUSED_TRIGGER,
    stateFilter: null,
    condition: { kind: 'criteria', left: { kind: 'pool', poolId: FLAG_A, seat: null }, op: '=', right: { kind: 'literal', value: true } },
    effects: [
      { kind: 'changePool', poolId: FLAG_A, seat: null, op: 'set', amount: { kind: 'literal', value: false } },
      { kind: 'changePool', poolId: FLAG_B, seat: null, op: 'set', amount: { kind: 'literal', value: true } },
    ],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: true,
    replaces: null,
    activation: null,
  };

  const ruleB: RuleSet = {
    id: 'rs_flip_b',
    name: 'Flip B -> A',
    trigger: UNUSED_TRIGGER,
    stateFilter: null,
    condition: { kind: 'criteria', left: { kind: 'pool', poolId: FLAG_B, seat: null }, op: '=', right: { kind: 'literal', value: true } },
    effects: [
      { kind: 'changePool', poolId: FLAG_B, seat: null, op: 'set', amount: { kind: 'literal', value: false } },
      { kind: 'changePool', poolId: FLAG_A, seat: null, op: 'set', amount: { kind: 'literal', value: true } },
    ],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: true,
    replaces: null,
    activation: null,
  };

  const def = base({
    pools: [
      { id: FLAG_A, scope: 'game', value: { type: 'boolean', name: 'Flag A', defaultValue: true } },
      { id: FLAG_B, scope: 'game', value: { type: 'boolean', name: 'Flag B', defaultValue: false } },
    ],
    ruleSets: [ruleA, ruleB],
  });

  it('trips SETTLE_DIVERGED at maxSettleIterations, same discipline as R4, well under 100ms', () => {
    const state = createPlayState(def, 'seed');
    const t0 = performance.now();
    const { lines, result } = drive(state, def, { kind: 'start' });
    const ms = performance.now() - t0;

    expect(result).toEqual({ done: true, suspended: false, haltedByLoopGuard: true });
    expect(state.budget.settleIterations).toBe(DEFAULT_MAX_SETTLE_ITERATIONS + 1);
    const halt = lines.filter((l) => l.level === 'error' && l.message.includes('SETTLE_DIVERGED'));
    expect(halt).toHaveLength(1);
    expect(halt[0].message).toContain(`> limit ${DEFAULT_MAX_SETTLE_ITERATIONS}`);
    expect(halt[0].message).toContain('use Rewind to back this out');
    // §9.5 #16 — the new, higher ceiling (64) must not itself be what hangs the browser.
    expect(ms).toBeLessThan(100);
    // Discards both work arrays and clears any suspension, exactly like the loop guard (§5.5).
    expect(state.stack).toEqual([]);
    expect(state.pending).toEqual([]);
    expect(state.interaction).toBeNull();
  });

  it('honours a maxSettleIterations set by the definition, not the default', () => {
    const tight: GameDefinition = { ...def, limits: { ...def.limits, maxSettleIterations: 3 } };
    const state = createPlayState(tight, 'seed');
    const { result } = drive(state, tight, { kind: 'start' });

    expect(result.haltedByLoopGuard).toBe(true);
    expect(state.budget.settleIterations).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// scanContinuous — direct unit coverage, no card involved. Everything card-shaped (one arm per
// instance) is the same zone/template walk `dispatch.test.ts` already proves for the event path.
// ---------------------------------------------------------------------------

describe('scanContinuous — direct', () => {
  it('returns false and touches nothing when there are no continuous rules', () => {
    const def = base({ pools: [] });
    const state = createPlayState(def, 'seed');
    const before = JSON.stringify(state.continuousFired);
    expect(scanContinuous(state, def)).toBe(false);
    expect(state.stack).toEqual([]);
    expect(JSON.stringify(state.continuousFired)).toBe(before);
  });

  it('a rule with condition: null always passes and fires exactly once', () => {
    const rule: RuleSet = {
      id: 'rs_always',
      name: 'Always',
      trigger: UNUSED_TRIGGER,
      stateFilter: null,
      condition: null,
      effects: [],
      priority: 0,
      onRejection: 'continue',
      modifier: null,
      continuous: true,
      replaces: null,
      activation: null,
    };
    const def = base({ pools: [], ruleSets: [rule] });
    const state = createPlayState(def, 'seed');

    expect(scanContinuous(state, def)).toBe(true);
    expect(state.stack).toHaveLength(1);
    expect(state.continuousFired[continuousKey(rule.id, null)]).toBe(true);
    // A second pass: still true, already fired — no second frame pushed.
    expect(scanContinuous(state, def)).toBe(false);
    expect(state.stack).toHaveLength(1);
  });
});
