import { describe, expect, it } from 'vitest';
import { evalCriteria, evalCriteriaBool } from './criteria';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  SCHEMA_VERSION,
  ACTIVE_PLAYER_POOL_ID,
  type ComparisonOp,
  type CriteriaNode,
  type GameDefinition,
  type PlayState,
  type PointPool,
  type TriggerContext,
  type ValueRef,
} from './types';

// ---------------------------------------------------------------------------
// Fixtures — tiny literals, built here so this file owns its own data.
// ---------------------------------------------------------------------------

function intPool(id: string, name: string, scope: 'game' | 'player'): PointPool {
  return { id, scope, value: { type: 'integer', name, defaultValue: 0, min: null, max: null } };
}

function boolPool(id: string, name: string, scope: 'game' | 'player'): PointPool {
  return { id, scope, value: { type: 'boolean', name, defaultValue: false } };
}

const DEF: GameDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: 'g1',
  name: 'Test Game',
  playerCount: 2,
  pools: [
    intPool(ACTIVE_PLAYER_POOL_ID, 'Active Player', 'game'),
    intPool('hp', 'HP', 'player'),
    intPool('maxHp', 'MaxHP', 'player'),
    intPool('turn', 'Turn', 'game'),
    boolPool('ready', 'isReady', 'player'),
  ],
  zones: [],
  templates: [],
  decks: [],
  customEvents: [],
  ruleSets: [],
  globalRuleSetIds: [],
  machine: { states: [], startStateId: 'start', endStateId: 'end' },
  limits: {
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEffects: DEFAULT_MAX_EFFECTS,
    maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
    maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
  },
  updatedAt: '2024-01-01T00:00:00.000Z',
};

function makeState(overrides: Partial<PlayState> = {}): PlayState {
  return {
    definitionId: 'g1',
    seed: 'seed',
    rngCursor: 0,
    nextSeq: 0,
    nextWorkId: 0,
    logSeq: 0,
    playerCount: 2,
    pools: { [ACTIVE_PLAYER_POOL_ID]: 0, turn: 3 },
    playerPools: { hp: [12, 5], maxHp: [20, 20], ready: [true, false] },
    cards: {},
    zones: {},
    currentStateId: 'start',
    finished: false,
    stack: [],
    pending: [],
    interaction: null,
    budget: { causalDepth: 0, effectsUsed: 0, settleIterations: 0 },
    ...overrides,
  };
}

const CTX: TriggerContext = {
  triggeringCardId: null,
  zoneKey: null,
  triggeringSeat: null,
  promptAnswers: {},
};

// ValueRef shorthands
const lit = (value: number | boolean): ValueRef => ({ kind: 'literal', value });
const seatPool = (poolId: string, index: number): ValueRef => ({
  kind: 'pool',
  poolId,
  seat: { kind: 'seat', index },
});
const allPool = (poolId: string, quantifier?: 'every' | 'some'): ValueRef => ({
  kind: 'pool',
  poolId,
  seat: { kind: 'all', quantifier },
});
const gamePool = (poolId: string): ValueRef => ({ kind: 'pool', poolId, seat: null });
const activePool = (poolId: string): ValueRef => ({ kind: 'pool', poolId, seat: { kind: 'active' } });

const leaf = (left: ValueRef, op: ComparisonOp, right: ValueRef): CriteriaNode => ({
  kind: 'criteria',
  left,
  op,
  right,
});
const and = (...children: CriteriaNode[]): CriteriaNode => ({ kind: 'group', combinator: 'and', children });
const or = (...children: CriteriaNode[]): CriteriaNode => ({ kind: 'group', combinator: 'or', children });

const run = (node: CriteriaNode, state: PlayState = makeState()) => evalCriteria(node, state, CTX, DEF);

// ---------------------------------------------------------------------------
// Leaves and operators
// ---------------------------------------------------------------------------

describe('leaf comparison', () => {
  it('evaluates every operator on integers', () => {
    const hp0 = seatPool('hp', 0); // 12
    expect(run(leaf(hp0, '=', lit(12))).value).toBe(true);
    expect(run(leaf(hp0, '!=', lit(12))).value).toBe(false);
    expect(run(leaf(hp0, '>', lit(11))).value).toBe(true);
    expect(run(leaf(hp0, '<', lit(12))).value).toBe(false);
    expect(run(leaf(hp0, '>=', lit(12))).value).toBe(true);
    expect(run(leaf(hp0, '<=', lit(11))).value).toBe(false);
  });

  it('compares booleans with = and !=', () => {
    expect(run(leaf(seatPool('ready', 0), '=', lit(true))).value).toBe(true);
    expect(run(leaf(seatPool('ready', 1), '!=', lit(true))).value).toBe(true);
  });

  it('compares two pools', () => {
    expect(run(leaf(seatPool('hp', 0), '<', seatPool('maxHp', 0))).value).toBe(true);
  });

  it('evalCriteriaBool returns just the boolean', () => {
    expect(evalCriteriaBool(leaf(gamePool('turn'), '=', lit(3)), makeState(), CTX, DEF)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Nesting, combinators, empty groups
// ---------------------------------------------------------------------------

describe('groups', () => {
  it('nests three levels deep mixing AND/OR', () => {
    // AND[ hp0 > 10, OR[ hp1 > 100, AND[ turn = 3, ready(0) = true ] ] ]
    const node = and(
      leaf(seatPool('hp', 0), '>', lit(10)),
      or(
        leaf(seatPool('hp', 1), '>', lit(100)),
        and(leaf(gamePool('turn'), '=', lit(3)), leaf(seatPool('ready', 0), '=', lit(true)))
      )
    );
    const res = run(node);
    expect(res.value).toBe(true);
    expect(res.leaves).toHaveLength(4);
    // depth-first order
    expect(res.leaves.map((l) => l.value)).toEqual([true, false, true, true]);
  });

  it('a false leaf anywhere in a deep AND fails the whole tree', () => {
    const node = and(or(and(leaf(gamePool('turn'), '=', lit(99)))));
    expect(run(node).value).toBe(false);
  });

  it('empty AND is true, empty OR is false', () => {
    expect(run(and()).value).toBe(true);
    expect(run(or()).value).toBe(false);
    expect(run(and()).leaves).toEqual([]);
  });

  it('empty nested groups fold by their own combinator', () => {
    expect(run(and(or())).value).toBe(false);
    expect(run(or(and())).value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No short-circuiting — §5.7
// ---------------------------------------------------------------------------

describe('no short-circuiting', () => {
  it('evaluates leaves after a false AND child', () => {
    const node = and(
      leaf(gamePool('turn'), '=', lit(99)), // false — an && chain would stop here
      leaf(seatPool('hp', 0), '=', lit(12)),
      leaf(seatPool('hp', 1), '=', lit(5))
    );
    const res = run(node);
    expect(res.value).toBe(false);
    expect(res.leaves).toHaveLength(3);
    expect(res.leaves.map((l) => l.value)).toEqual([false, true, true]);
    // and every one of them carries resolved values, not just the decider
    expect(res.leaves.map((l) => l.left.values)).toEqual([[3], [12], [5]]);
  });

  it('evaluates leaves after a true OR child', () => {
    const node = or(
      leaf(gamePool('turn'), '=', lit(3)), // true — an || chain would stop here
      leaf(seatPool('hp', 0), '=', lit(999)),
      leaf(seatPool('hp', 1), '=', lit(5))
    );
    const res = run(node);
    expect(res.value).toBe(true);
    expect(res.leaves.map((l) => l.value)).toEqual([true, false, true]);
  });

  it('evaluates leaves in sibling subtrees the outcome cannot depend on', () => {
    const node = and(
      leaf(gamePool('turn'), '=', lit(99)), // decides the AND
      or(leaf(seatPool('hp', 0), '>', lit(0)), leaf(seatPool('hp', 1), '>', lit(0)))
    );
    expect(run(node).leaves).toHaveLength(3);
  });

  it('resolves the right side even when the left side failed', () => {
    const res = run(leaf(gamePool('nope'), '=', seatPool('hp', 0)));
    expect(res.leaves[0].left.values).toBeNull();
    expect(res.leaves[0].right.values).toEqual([12]);
  });
});

// ---------------------------------------------------------------------------
// The `all` quantifier — §5.7
// ---------------------------------------------------------------------------

describe('all quantifier', () => {
  it('defaults to every', () => {
    // hp = [12, 5]; every seat > 0 holds, every seat > 10 does not
    expect(run(leaf(allPool('hp'), '>', lit(0))).value).toBe(true);
    expect(run(leaf(allPool('hp'), '>', lit(10))).value).toBe(false);
    expect(run(leaf({ kind: 'pool', poolId: 'hp', seat: { kind: 'all' } }, '>', lit(10))).value).toBe(false);
  });

  it('every and some split on the same data — `some` is not expressible without it', () => {
    // The bog-standard win condition: "any player at 0 HP".
    const state = makeState({ playerPools: { hp: [10, 0], maxHp: [20, 20], ready: [true, false] } });
    expect(run(leaf(allPool('hp', 'every'), '=', lit(0)), state).value).toBe(false);
    expect(run(leaf(allPool('hp', 'some'), '=', lit(0)), state).value).toBe(true);
  });

  it('folds the scalar side against each seat when only the right side is `all`', () => {
    // turn = 3; hp = [12, 5]
    expect(run(leaf(gamePool('turn'), '<', allPool('hp', 'every'))).value).toBe(true);
    expect(run(leaf(gamePool('turn'), '>', allPool('hp', 'every'))).value).toBe(false);
    expect(run(leaf(gamePool('turn'), '>', allPool('hp', 'some'))).value).toBe(false);
    expect(run(leaf(lit(6), '>', allPool('hp', 'some'))).value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Both sides `all` — zipped by seat, never crossed — §5.7
// ---------------------------------------------------------------------------

describe('all vs all is zipped by seat', () => {
  it('a cross product would PASS where zipping FAILS', () => {
    // hp = [5, 1], maxHp = [7, 3].
    // Zipped `some`: 5>7 false, 1>3 false  => false.
    // Crossed `some`: 5>3 is true          => would be true.
    const state = makeState({ playerPools: { hp: [5, 1], maxHp: [7, 3], ready: [true, false] } });
    const res = run(leaf(allPool('hp', 'some'), '>', allPool('maxHp', 'some')), state);
    expect(res.value).toBe(false);
    expect(res.leaves[0].left.values).toEqual([5, 1]);
    expect(res.leaves[0].right.values).toEqual([7, 3]);
  });

  it('a cross product would FAIL where zipping PASSES', () => {
    // hp = [5, 1], maxHp = [3, 0].
    // Zipped `every`: 5>3 true, 1>0 true  => true.
    // Crossed `every`: 1>3 is false       => would be false.
    const state = makeState({ playerPools: { hp: [5, 1], maxHp: [3, 0], ready: [true, false] } });
    expect(run(leaf(allPool('hp'), '>', allPool('maxHp')), state).value).toBe(true);
  });

  it('when the quantifiers disagree, the left side governs', () => {
    // hp = [5, 1] vs maxHp = [3, 7]: zipped => [true, false]. every => false, some => true.
    const state = makeState({ playerPools: { hp: [5, 1], maxHp: [3, 7], ready: [true, false] } });
    expect(run(leaf(allPool('hp', 'every'), '>', allPool('maxHp', 'some')), state).value).toBe(false);
    expect(run(leaf(allPool('hp', 'some'), '>', allPool('maxHp', 'every')), state).value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type mismatches — §5.9 row 11
// ---------------------------------------------------------------------------

describe('type mismatch', () => {
  it('boolean vs integer is false plus an error, never a throw', () => {
    const res = run(leaf(seatPool('ready', 0), '>', lit(3)));
    expect(res.value).toBe(false);
    expect(res.leaves[0].error).toEqual({
      reason: 'TYPE_MISMATCH',
      message: 'Criterion "isReady(seat 0) > 3": cannot compare boolean to integer.',
    });
    expect(res.leaves[0].description).toBe(
      'Criterion "isReady(seat 0) > 3": cannot compare boolean to integer. Evaluated false'
    );
  });

  it('integer vs boolean names the sides in order', () => {
    const res = run(leaf(lit(3), '=', seatPool('ready', 0)));
    expect(res.value).toBe(false);
    expect(res.leaves[0].error?.message).toBe(
      'Criterion "3 = isReady(seat 0)": cannot compare integer to boolean.'
    );
  });

  it('rejects ordering operators on two booleans', () => {
    for (const op of ['>', '<', '>=', '<='] as const) {
      const res = run(leaf(seatPool('ready', 0), op, lit(true)));
      expect(res.value).toBe(false);
      expect(res.leaves[0].error?.reason).toBe('TYPE_MISMATCH');
      expect(res.leaves[0].error?.message).toContain(`operator "${op}" is not valid for boolean values`);
    }
  });

  it('allows = and != on two booleans', () => {
    expect(run(leaf(seatPool('ready', 0), '=', lit(true))).leaves[0].error).toBeNull();
    expect(run(leaf(seatPool('ready', 0), '!=', lit(true))).leaves[0].error).toBeNull();
  });

  it('a mismatched leaf does not stop its siblings', () => {
    const node = and(
      leaf(seatPool('ready', 0), '>', lit(3)), // mismatch
      leaf(seatPool('hp', 0), '=', lit(12)) // still evaluated
    );
    const res = run(node);
    expect(res.value).toBe(false);
    expect(res.leaves).toHaveLength(2);
    expect(res.leaves[1].value).toBe(true);
    expect(res.leaves[1].error).toBeNull();
  });

  it('a mismatch under an OR still lets a true sibling win', () => {
    const node = or(leaf(seatPool('ready', 0), '>', lit(3)), leaf(seatPool('hp', 0), '=', lit(12)));
    expect(run(node).value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failed reference resolution — §5.9 rows 12/13
// ---------------------------------------------------------------------------

describe('failed refs', () => {
  it('activePlayer out of range fails the leaf — no clamping', () => {
    const state = makeState({ pools: { [ACTIVE_PLAYER_POOL_ID]: 5, turn: 3 } });
    const res = run(leaf(activePool('hp'), '>', lit(0)), state);
    expect(res.value).toBe(false);
    expect(res.leaves[0].error).toEqual({
      reason: 'INVALID_SEAT',
      message: 'Player ref "active": activePlayer = 5 is not a valid seat (2 seats).',
    });
    expect(res.leaves[0].description).toBe(
      'Player ref "active": activePlayer = 5 is not a valid seat (2 seats). Evaluated false'
    );
    // it did NOT clamp to seat 1 (hp 5 > 0 would have been true)
    expect(res.leaves[0].left.values).toBeNull();
  });

  it('an out-of-range seat literal fails rather than wrapping', () => {
    const res = run(leaf(seatPool('hp', 7), '>', lit(0)));
    expect(res.value).toBe(false);
    expect(res.leaves[0].error?.reason).toBe('INVALID_SEAT');
  });

  it('an unbound triggeringSeat fails the leaf', () => {
    const res = run(leaf({ kind: 'pool', poolId: 'hp', seat: { kind: 'triggeringSeat' } }, '>', lit(0)));
    expect(res.leaves[0].error?.reason).toBe('UNBOUND_REF');
  });

  it('an unbound triggeringCard fails the leaf', () => {
    const res = run(
      leaf({ kind: 'cardIndex', card: { kind: 'triggering' }, indexId: 'power' }, '>', lit(0))
    );
    expect(res.value).toBe(false);
    expect(res.leaves[0].error?.reason).toBe('UNBOUND_REF');
    expect(res.leaves[0].description).toBe('Ref "triggeringCard" is unbound. Evaluated false');
  });

  it('a missing pool fails the leaf', () => {
    const res = run(leaf(gamePool('mana'), '>', lit(0)));
    expect(res.leaves[0].error?.reason).toBe('MISSING_REFERENT');
  });

  it('a failed leaf does not abort its siblings', () => {
    const state = makeState({ pools: { [ACTIVE_PLAYER_POOL_ID]: 5, turn: 3 } });
    const node = or(leaf(activePool('hp'), '>', lit(0)), leaf(gamePool('turn'), '=', lit(3)));
    const res = run(node, state);
    expect(res.value).toBe(true);
    expect(res.leaves).toHaveLength(2);
    expect(res.leaves[1].value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Leaf detail feeds the log — §5.9 row 17
// ---------------------------------------------------------------------------

describe('leaf detail', () => {
  it('reads like the §5.9 row 17 log line', () => {
    const res = run(leaf(seatPool('hp', 1), '<', lit(10)), makeState({ playerPools: { hp: [3, 12] } }));
    expect(res.value).toBe(false);
    expect(res.leaves[0].description).toBe('HP(seat 1) = 12, not < 10');
    expect(res.leaves[0]).toMatchObject({
      left: { label: 'HP(seat 1)', values: [12] },
      op: '<',
      right: { label: '10', values: [10] },
      value: false,
      error: null,
    });
  });

  it('describes a passing leaf without the negation', () => {
    const res = run(leaf(seatPool('hp', 0), '<', lit(20)));
    expect(res.leaves[0].description).toBe('HP(seat 0) = 12 < 20');
  });

  it('renders multi-seat values as a list and labels the quantifier', () => {
    expect(run(leaf(allPool('hp'), '>', lit(100))).leaves[0].description).toBe(
      'HP(all) = [12, 5], not > 100'
    );
    expect(run(leaf(allPool('hp', 'some'), '>', lit(100))).leaves[0].description).toBe(
      'HP(any) = [12, 5], not > 100'
    );
  });

  it('falls back to the pool id when the pool has no definition entry', () => {
    const res = run(leaf(gamePool('mana'), '>', lit(0)));
    expect(res.leaves[0].left.label).toBe('mana');
  });
});
