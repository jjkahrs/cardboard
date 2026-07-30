import { describe, expect, it } from 'vitest';
import { parseZoneKey, resolvePoolDef, resolveSeat, resolveValueRef, zoneKey } from './valueRef';
import { evalCriteriaBool } from './criteria';
import type { CriteriaNode, RuleSet, TargetSelector, ValueRef } from './types';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  SCHEMA_VERSION,
  ACTIVE_PLAYER_POOL,
  ACTIVE_PLAYER_POOL_ID,
  type CardInstance,
  type GameDefinition,
  type PlayState,
  type PointPool,
  type TriggerContext,
  type ZoneInstance,
} from './types';
import { createPlayState } from './setup';
import { exportJson } from './schema';
import { duel } from '../test/fixtures';

function makeDef(overrides: Partial<GameDefinition> = {}): GameDefinition {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'g1',
    name: 'Test Game',
    playerCount: 2,
    pools: [],
    zones: [],
    templates: [],
    decks: [],
    customEvents: [],
    ruleSets: [],
    globalRuleSetIds: [],
    priorityWindows: [],
    machine: { states: [], startStateId: 'start', endStateId: 'end' },
    limits: {
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEffects: DEFAULT_MAX_EFFECTS,
    maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
    maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
  },
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeState(playerCount: number, activePlayer: number, overrides: Partial<PlayState> = {}): PlayState {
  return {
    definitionId: 'g1',
    seed: 'seed',
    rngCursor: 0,
    nextSeq: 0,
    nextWorkId: 0,
    logSeq: 0,
    playerCount,
    seatOrder: Array.from({ length: playerCount }, (_, i) => i),
    eliminated: [],
    pools: { [ACTIVE_PLAYER_POOL_ID]: activePlayer },
    playerPools: {},
    cards: {},
    zones: {},
    currentStateId: 'start',
    finished: false,
    stack: [],
    pending: [],
    interaction: null,
    pendingActions: {},
    actionStack: [],
    continuousFired: {},
    budget: { causalDepth: 0, effectsUsed: 0, settleIterations: 0, priorityRounds: 0 },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return { triggeringCardId: null, zoneKey: null, triggeringSeat: null, promptAnswers: {}, sourceCardId: null, ...overrides };
}

function card(id: string, indexValues: Record<string, number | boolean> = {}): CardInstance {
  return { id, templateId: 't1', indexValues, faceDown: false, rotated: false, tags: [], owner: null, controller: null, attachedTo: null };
}

function zoneInst(zoneId: string, seat: number | null, cardIds: string[]): ZoneInstance {
  return { zoneId, seat, cardIds };
}

// ---------------------------------------------------------------------------
// zoneKey / parseZoneKey — §4.5
// ---------------------------------------------------------------------------

describe('zoneKey / parseZoneKey', () => {
  it('game-scoped (seat null) has no suffix', () => {
    expect(zoneKey('hand', null)).toBe('hand');
    expect(parseZoneKey('hand')).toEqual({ zoneId: 'hand', seat: null });
  });

  it('player-scoped appends #seat', () => {
    expect(zoneKey('hand', 1)).toBe('hand#1');
    expect(parseZoneKey('hand#1')).toEqual({ zoneId: 'hand', seat: 1 });
  });

  it('round-trips a zoneId containing # that is not itself a trailing-digit suffix', () => {
    const seatless = zoneKey('zone#extra', null);
    expect(seatless).toBe('zone#extra');
    expect(parseZoneKey(seatless)).toEqual({ zoneId: 'zone#extra', seat: null });

    const seated = zoneKey('zone#extra', 2);
    expect(seated).toBe('zone#extra#2');
    expect(parseZoneKey(seated)).toEqual({ zoneId: 'zone#extra', seat: 2 });
  });
});

// ---------------------------------------------------------------------------
// resolveSeat — §5.7, §9.4 item 7
// ---------------------------------------------------------------------------

describe('resolveSeat', () => {
  it('1 player: active/next/previous all equal the sole seat', () => {
    const state = makeState(1, 0);
    const ctx = makeCtx();
    expect(resolveSeat({ kind: 'active' }, state, ctx)).toEqual({ ok: true, seats: [0], quantifier: 'every' });
    expect(resolveSeat({ kind: 'next' }, state, ctx)).toEqual({ ok: true, seats: [0], quantifier: 'every' });
    expect(resolveSeat({ kind: 'previous' }, state, ctx)).toEqual({ ok: true, seats: [0], quantifier: 'every' });
  });

  it('2 players, activePlayer=1: next and previous resolve to the same seat', () => {
    const state = makeState(2, 1);
    const ctx = makeCtx();
    const next = resolveSeat({ kind: 'next' }, state, ctx);
    const previous = resolveSeat({ kind: 'previous' }, state, ctx);
    expect(next).toEqual({ ok: true, seats: [0], quantifier: 'every' });
    expect(previous).toEqual({ ok: true, seats: [0], quantifier: 'every' });
    expect(resolveSeat({ kind: 'active' }, state, ctx)).toEqual({ ok: true, seats: [1], quantifier: 'every' });
    expect(resolveSeat({ kind: 'all' }, state, ctx)).toEqual({ ok: true, seats: [0, 1], quantifier: 'every' });
  });

  it('3 players, activePlayer=1: next and previous wrap in opposite directions', () => {
    const state = makeState(3, 1);
    const ctx = makeCtx();
    expect(resolveSeat({ kind: 'next' }, state, ctx)).toEqual({ ok: true, seats: [2], quantifier: 'every' });
    expect(resolveSeat({ kind: 'previous' }, state, ctx)).toEqual({ ok: true, seats: [0], quantifier: 'every' });
    expect(resolveSeat({ kind: 'all', quantifier: 'some' }, state, ctx)).toEqual({
      ok: true,
      seats: [0, 1, 2],
      quantifier: 'some',
    });
  });

  it('3 players: previous wraps below zero back to N-1, next wraps above N-1 back to zero', () => {
    const ctx = makeCtx();
    expect(resolveSeat({ kind: 'previous' }, makeState(3, 0), ctx)).toEqual({
      ok: true,
      seats: [2],
      quantifier: 'every',
    });
    expect(resolveSeat({ kind: 'next' }, makeState(3, 2), ctx)).toEqual({
      ok: true,
      seats: [0],
      quantifier: 'every',
    });
  });

  it('explicit seat: k resolves directly', () => {
    const state = makeState(2, 0);
    expect(resolveSeat({ kind: 'seat', index: 1 }, state, makeCtx())).toEqual({
      ok: true,
      seats: [1],
      quantifier: 'every',
    });
  });

  it('out-of-range activePlayer fails rather than clamping', () => {
    const state = makeState(2, 5);
    const res = resolveSeat({ kind: 'active' }, state, makeCtx());
    expect(res).toEqual({
      ok: false,
      reason: 'INVALID_SEAT',
      message: 'Player ref "active": activePlayer = 5 is not a valid seat (2 seats).',
    });
    // next/previous derive from the same activePlayer read and must fail identically.
    expect(resolveSeat({ kind: 'next' }, state, makeCtx()).ok).toBe(false);
    expect(resolveSeat({ kind: 'previous' }, state, makeCtx()).ok).toBe(false);
  });

  // F2: activePlayer's runtime value is unconstrained to an integer in [0, N) — a hand-edited
  // JSON, or an authored `changePool activePlayer add 0.5` (the literal has no `.int()` and
  // clampValue doesn't truncate), can make it a fraction, NaN, or a boolean. None of these is a
  // valid seat and none should clamp; each must fail with the same §5.9 row-12 shape as an
  // out-of-range integer, not a downstream MISSING_REFERENT one layer up.
  it('a fractional activePlayer fails INVALID_SEAT with the row-12 message', () => {
    const state = makeState(2, 0.5);
    expect(resolveSeat({ kind: 'active' }, state, makeCtx())).toEqual({
      ok: false,
      reason: 'INVALID_SEAT',
      message: 'Player ref "active": activePlayer = 0.5 is not a valid seat (2 seats).',
    });
  });

  it('a NaN activePlayer fails INVALID_SEAT with the row-12 message', () => {
    const state = makeState(2, NaN);
    expect(resolveSeat({ kind: 'active' }, state, makeCtx())).toEqual({
      ok: false,
      reason: 'INVALID_SEAT',
      message: 'Player ref "active": activePlayer = NaN is not a valid seat (2 seats).',
    });
  });

  it('a boolean activePlayer fails INVALID_SEAT with the row-12 message', () => {
    const state = makeState(2, true as unknown as number);
    expect(resolveSeat({ kind: 'active' }, state, makeCtx())).toEqual({
      ok: false,
      reason: 'INVALID_SEAT',
      message: 'Player ref "active": activePlayer = true is not a valid seat (2 seats).',
    });
  });

  it('explicit seat: k outside [0, N) fails with INVALID_SEAT', () => {
    const state = makeState(2, 0);
    const res = resolveSeat({ kind: 'seat', index: 5 }, state, makeCtx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('INVALID_SEAT');
  });

  it('triggeringSeat resolves from ctx when bound', () => {
    const state = makeState(2, 0);
    const res = resolveSeat({ kind: 'triggeringSeat' }, state, makeCtx({ triggeringSeat: 1 }));
    expect(res).toEqual({ ok: true, seats: [1], quantifier: 'every' });
  });

  it('unbound triggeringSeat fails with UNBOUND_REF', () => {
    const state = makeState(2, 0);
    const res = resolveSeat({ kind: 'triggeringSeat' }, state, makeCtx());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('UNBOUND_REF');
  });
});

// ---------------------------------------------------------------------------
// resolveValueRef — §4.2, §5.9 rows 3b/11/12/13
// ---------------------------------------------------------------------------

describe('resolveValueRef', () => {
  it('literal: passes the number or boolean through', () => {
    const state = makeState(2, 0);
    const ctx = makeCtx();
    const def = makeDef();
    expect(resolveValueRef({ kind: 'literal', value: 42 }, state, ctx, def)).toEqual({
      ok: true,
      values: [42],
      quantifier: 'every',
    });
    expect(resolveValueRef({ kind: 'literal', value: true }, state, ctx, def)).toEqual({
      ok: true,
      values: [true],
      quantifier: 'every',
    });
  });

  describe('pool', () => {
    it('game-scoped read', () => {
      const def = makeDef({
        pools: [{ id: 'score', scope: 'game', value: { type: 'integer', name: 'Score', defaultValue: 0, min: null, max: null } }],
      });
      const state = makeState(2, 0, { pools: { [ACTIVE_PLAYER_POOL_ID]: 0, score: 10 } });
      const res = resolveValueRef({ kind: 'pool', poolId: 'score', seat: null }, state, makeCtx(), def);
      expect(res).toEqual({ ok: true, values: [10], quantifier: 'every' });
    });

    it('player-scoped read for a single seat', () => {
      const def = makeDef({
        pools: [{ id: 'hp', scope: 'player', value: { type: 'integer', name: 'HP', defaultValue: 10, min: 0, max: null } }],
      });
      const state = makeState(2, 0, { playerPools: { hp: [10, 20] } });
      const res = resolveValueRef(
        { kind: 'pool', poolId: 'hp', seat: { kind: 'seat', index: 1 } },
        state,
        makeCtx(),
        def
      );
      expect(res).toEqual({ ok: true, values: [20], quantifier: 'every' });
    });

    it('player-scoped read for all seats, ascending, carrying the quantifier', () => {
      const def = makeDef({
        pools: [{ id: 'hp', scope: 'player', value: { type: 'integer', name: 'HP', defaultValue: 10, min: 0, max: null } }],
      });
      const state = makeState(3, 0, { playerPools: { hp: [10, 20, 30] } });
      const res = resolveValueRef(
        { kind: 'pool', poolId: 'hp', seat: { kind: 'all', quantifier: 'some' } },
        state,
        makeCtx(),
        def
      );
      expect(res).toEqual({ ok: true, values: [10, 20, 30], quantifier: 'some' });
    });

    // AC: SP6 — §4.1. `sum` is the one quantifier that does not fold to a boolean: it collapses the
    // per-seat values into ONE arithmetic total, which is what makes a vote tally authorable. It
    // must resolve, not report TYPE_MISMATCH the way a multi-value amount otherwise would.
    it('sum collapses a per-player pool to one arithmetic total', () => {
      const def = makeDef({
        pools: [{ id: 'votes', scope: 'player', value: { type: 'integer', name: 'Votes', defaultValue: 0, min: 0, max: null } }],
      });
      const state = makeState(3, 0, { playerPools: { votes: [1, 2, 1] } });
      const res = resolveValueRef(
        { kind: 'pool', poolId: 'votes', seat: { kind: 'all', quantifier: 'sum' } },
        state,
        makeCtx(),
        def
      );
      // One value, and quantifier 'every': every consumer downstream sees a plain single number,
      // so `sum` needs no special case in criteria.ts or in effects.ts's singleAmount.
      expect(res).toEqual({ ok: true, values: [4], quantifier: 'every' });
    });

    it('sum sums only the LIVE ring — the ousted seat\'s stale pool value is still in storage', () => {
      const def = makeDef({
        pools: [{ id: 'votes', scope: 'player', value: { type: 'integer', name: 'Votes', defaultValue: 0, min: 0, max: null } }],
      });
      const state = makeState(3, 0, { seatOrder: [0, 2], eliminated: [1], playerPools: { votes: [1, 99, 1] } });
      const res = resolveValueRef(
        { kind: 'pool', poolId: 'votes', seat: { kind: 'all', quantifier: 'sum' } },
        state,
        makeCtx(),
        def
      );
      expect(res).toEqual({ ok: true, values: [2], quantifier: 'every' });
    });

    // §4.1 names EVERY quantifier, not just `sum`: "an implementation that iterates the array
    // silently counts ousted players in every vote tally AND every 'all players' check". The tally
    // half is above; this is the check half, asserted through `evalCriteriaBool` because that is the
    // consumer — `resolveSeat` returning the right seats proves nothing if criteria re-index.
    it('every/some fold over the RING, so an ousted seat cannot decide an "all players" check', () => {
      const def = makeDef({
        pools: [{ id: 'hp', scope: 'player', value: { type: 'integer', name: 'HP', defaultValue: 0, min: null, max: null } }],
      });
      // Seat 1 is out and its stale HP of 0 is still sitting in the dense array (§3.5).
      const state = makeState(3, 0, { seatOrder: [0, 2], eliminated: [1], playerPools: { hp: [5, 0, 5] } });
      const node = (op: 'every' | 'some'): CriteriaNode => ({
        kind: 'criteria',
        left: { kind: 'pool', poolId: 'hp', seat: { kind: 'all', quantifier: op } },
        op: '>',
        right: { kind: 'literal', value: 0 },
      });
      // Iterating playerPools would make `every` false (seat 1's 0) and is the whole trap.
      expect(evalCriteriaBool(node('every'), state, makeCtx(), def)).toBe(true);

      // …and the mirror: with the LIVE seats at 0 and only the ousted one above the line, `some`
      // must be false rather than rescued by a player who is no longer at the table.
      const inverted = makeState(3, 0, { seatOrder: [0, 2], eliminated: [1], playerPools: { hp: [0, 5, 0] } });
      expect(evalCriteriaBool(node('some'), inverted, makeCtx(), def)).toBe(false);
    });

    it('sum over a BOOLEAN pool is TYPE_MISMATCH at runtime — the import path bypasses the editor', () => {
      const def = makeDef({
        pools: [{ id: 'ready', scope: 'player', value: { type: 'boolean', name: 'Ready', defaultValue: false } }],
      });
      const state = makeState(2, 0, { playerPools: { ready: [true, false] } });
      const res = resolveValueRef(
        { kind: 'pool', poolId: 'ready', seat: { kind: 'all', quantifier: 'sum' } },
        state,
        makeCtx(),
        def
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('TYPE_MISMATCH');
        expect(res.message).toContain('sum');
      }
    });

    it('sum over a single seat is that seat\'s value — the quantifier only bites on `all`', () => {
      const def = makeDef({
        pools: [{ id: 'votes', scope: 'player', value: { type: 'integer', name: 'Votes', defaultValue: 0, min: 0, max: null } }],
      });
      const state = makeState(3, 0, { playerPools: { votes: [1, 2, 1] } });
      const res = resolveValueRef(
        { kind: 'pool', poolId: 'votes', seat: { kind: 'seat', index: 1 } },
        state,
        makeCtx(),
        def
      );
      expect(res).toEqual({ ok: true, values: [2], quantifier: 'every' });
    });

    it('pool absent from the definition is MISSING_REFERENT', () => {
      const def = makeDef();
      const state = makeState(2, 0);
      const res = resolveValueRef({ kind: 'pool', poolId: 'ghost', seat: null }, state, makeCtx(), def);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('MISSING_REFERENT');
    });

    it('pool in the definition but absent from state is MISSING_REFERENT (defensive)', () => {
      const def = makeDef({
        pools: [{ id: 'score', scope: 'game', value: { type: 'integer', name: 'Score', defaultValue: 0, min: null, max: null } }],
      });
      const state = makeState(2, 0); // pools.score never seeded
      const res = resolveValueRef({ kind: 'pool', poolId: 'score', seat: null }, state, makeCtx(), def);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('MISSING_REFERENT');
    });

    // F4: the reserved activePlayer pool has a runtime value (setup.ts seeds it) but no authored
    // PointPool, so a criterion on it must not fail MISSING_REFERENT just because no designer
    // happened to author a colliding pool.
    it('activePlayer resolves successfully even when the designer never authored the pool', () => {
      const def = makeDef(); // pools: [] — nothing authored
      const state = makeState(2, 0);
      const res = resolveValueRef({ kind: 'pool', poolId: ACTIVE_PLAYER_POOL_ID, seat: null }, state, makeCtx(), def);
      expect(res).toEqual({ ok: true, values: [0], quantifier: 'every' });
    });

    it('bad seat ref inside a pool ref propagates the seat failure', () => {
      const def = makeDef({
        pools: [{ id: 'hp', scope: 'player', value: { type: 'integer', name: 'HP', defaultValue: 10, min: 0, max: null } }],
      });
      const state = makeState(2, 9, { playerPools: { hp: [10, 20] } });
      const res = resolveValueRef(
        { kind: 'pool', poolId: 'hp', seat: { kind: 'active' } },
        state,
        makeCtx(),
        def
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('INVALID_SEAT');
    });
  });

  describe('cardIndex', () => {
    it('resolves via CardRef "instance"', () => {
      const def = makeDef();
      const state = makeState(2, 0, { cards: { c1: card('c1', { power: 5 }) } });
      const res = resolveValueRef(
        { kind: 'cardIndex', card: { kind: 'instance', id: 'c1' }, indexId: 'power' },
        state,
        makeCtx(),
        def
      );
      expect(res).toEqual({ ok: true, values: [5], quantifier: 'every' });
    });

    it('destroyed/missing card is TARGET_GONE', () => {
      const def = makeDef();
      const state = makeState(2, 0);
      const res = resolveValueRef(
        { kind: 'cardIndex', card: { kind: 'instance', id: 'ghost' }, indexId: 'power' },
        state,
        makeCtx(),
        def
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('TARGET_GONE');
    });

    it('unknown indexId is MISSING_REFERENT', () => {
      const def = makeDef();
      const state = makeState(2, 0, { cards: { c1: card('c1', { power: 5 }) } });
      const res = resolveValueRef(
        { kind: 'cardIndex', card: { kind: 'instance', id: 'c1' }, indexId: 'nope' },
        state,
        makeCtx(),
        def
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('MISSING_REFERENT');
    });

    it('CardRef "triggering" resolves ctx.triggeringCardId', () => {
      const def = makeDef();
      const state = makeState(2, 0, { cards: { c1: card('c1', { power: 5 }) } });
      const res = resolveValueRef(
        { kind: 'cardIndex', card: { kind: 'triggering' }, indexId: 'power' },
        state,
        makeCtx({ triggeringCardId: 'c1' }),
        def
      );
      expect(res).toEqual({ ok: true, values: [5], quantifier: 'every' });
    });

    it('CardRef "triggering" is UNBOUND_REF when ctx.triggeringCardId is null', () => {
      const def = makeDef();
      const state = makeState(2, 0);
      const res = resolveValueRef(
        { kind: 'cardIndex', card: { kind: 'triggering' }, indexId: 'power' },
        state,
        makeCtx(),
        def
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('UNBOUND_REF');
    });

    it('CardRef "zoneTop" reads index 0 (the documented top-of-zone convention)', () => {
      const def = makeDef();
      const state = makeState(2, 0, {
        cards: { c1: card('c1', { power: 1 }), c2: card('c2', { power: 2 }) },
        zones: { deck: zoneInst('deck', null, ['c1', 'c2']) },
      });
      const res = resolveValueRef(
        { kind: 'cardIndex', card: { kind: 'zoneTop', zone: { zoneId: 'deck', seat: null } }, indexId: 'power' },
        state,
        makeCtx(),
        def
      );
      expect(res).toEqual({ ok: true, values: [1], quantifier: 'every' });
    });

    it('CardRef "zoneTop" on an empty zone is TARGET_GONE', () => {
      const def = makeDef();
      const state = makeState(2, 0, { zones: { deck: zoneInst('deck', null, []) } });
      const res = resolveValueRef(
        { kind: 'cardIndex', card: { kind: 'zoneTop', zone: { zoneId: 'deck', seat: null } }, indexId: 'power' },
        state,
        makeCtx(),
        def
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('TARGET_GONE');
    });

    it('CardRef "zoneTop" on a missing zone instance is MISSING_REFERENT', () => {
      const def = makeDef();
      const state = makeState(2, 0);
      const res = resolveValueRef(
        { kind: 'cardIndex', card: { kind: 'zoneTop', zone: { zoneId: 'deck', seat: null } }, indexId: 'power' },
        state,
        makeCtx(),
        def
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('MISSING_REFERENT');
    });

    it('CardRef "promptAnswer" resolves ctx.promptAnswers[promptId][ordinal]', () => {
      const def = makeDef();
      const state = makeState(2, 0, { cards: { c1: card('c1', { power: 7 }) } });
      const res = resolveValueRef(
        { kind: 'cardIndex', card: { kind: 'promptAnswer', promptId: 'p1', ordinal: 0 }, indexId: 'power' },
        state,
        makeCtx({ promptAnswers: { p1: ['c1'] } }),
        def
      );
      expect(res).toEqual({ ok: true, values: [7], quantifier: 'every' });
    });

    it('CardRef "promptAnswer" absent is MISSING_REFERENT', () => {
      const def = makeDef();
      const state = makeState(2, 0);
      const res = resolveValueRef(
        { kind: 'cardIndex', card: { kind: 'promptAnswer', promptId: 'p1', ordinal: 0 }, indexId: 'power' },
        state,
        makeCtx(),
        def
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('MISSING_REFERENT');
    });
  });

  describe('zoneCount', () => {
    it('counts cards including face-down ones', () => {
      const def = makeDef({
        zones: [{ id: 'hand', name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: null }],
      });
      const state = makeState(2, 0, {
        cards: {
          c1: card('c1'),
          c2: { ...card('c2'), faceDown: true },
        },
        zones: { 'hand#0': zoneInst('hand', 0, ['c1', 'c2']) },
      });
      const res = resolveValueRef(
        { kind: 'zoneCount', zone: { zoneId: 'hand', seat: { kind: 'seat', index: 0 } } },
        state,
        makeCtx(),
        def
      );
      expect(res).toEqual({ ok: true, values: [2], quantifier: 'every' });
    });

    it('all seats, ascending, carrying the quantifier', () => {
      const def = makeDef({
        zones: [{ id: 'hand', name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: null }],
      });
      const state = makeState(3, 0, {
        zones: {
          'hand#0': zoneInst('hand', 0, ['a']),
          'hand#1': zoneInst('hand', 1, []),
          'hand#2': zoneInst('hand', 2, ['b', 'c']),
        },
      });
      const res = resolveValueRef(
        { kind: 'zoneCount', zone: { zoneId: 'hand', seat: { kind: 'all' } } },
        state,
        makeCtx(),
        def
      );
      expect(res).toEqual({ ok: true, values: [1, 0, 2], quantifier: 'every' });
    });

    it('sums across the RING, not the dense storage — an eliminated seat is not counted', () => {
      const def = makeDef({
        zones: [{ id: 'hand', name: 'Hand', scope: 'player', visibility: 'faceUp', layout: 'fan', ordered: true, maxCapacity: null }],
      });
      const state = makeState(3, 0, {
        seatOrder: [0, 2],
        eliminated: [1],
        zones: {
          'hand#0': zoneInst('hand', 0, ['c1']),
          'hand#1': zoneInst('hand', 1, ['c2', 'c3', 'c4']), // still instantiated (§3.5)
          'hand#2': zoneInst('hand', 2, ['c5', 'c6']),
        },
      });
      const res = resolveValueRef(
        { kind: 'zoneCount', zone: { zoneId: 'hand', seat: { kind: 'all', quantifier: 'sum' } } },
        state,
        makeCtx(),
        def
      );
      expect(res).toEqual({ ok: true, values: [3], quantifier: 'every' });
    });

    it('zone absent from the definition is MISSING_REFERENT', () => {
      const def = makeDef();
      const state = makeState(2, 0);
      const res = resolveValueRef({ kind: 'zoneCount', zone: { zoneId: 'ghost', seat: null } }, state, makeCtx(), def);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('MISSING_REFERENT');
    });

    it('zone in the definition but with no runtime instance is MISSING_REFERENT', () => {
      const def = makeDef({
        zones: [{ id: 'discard', name: 'Discard', scope: 'shared', visibility: 'faceUp', layout: 'stack', ordered: true, maxCapacity: null }],
      });
      const state = makeState(2, 0); // zones.discard never instantiated
      const res = resolveValueRef({ kind: 'zoneCount', zone: { zoneId: 'discard', seat: null } }, state, makeCtx(), def);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('MISSING_REFERENT');
    });
  });

  // -------------------------------------------------------------------------
  // CardRef{kind:'host'} — §4.2. Reads `ctx.sourceCardId`, never `triggeringCardId`.
  // -------------------------------------------------------------------------

  describe('host', () => {
    const ref = { kind: 'cardTag', card: { kind: 'host' }, tag: 'x' } as const;
    const boardWith = (self: Partial<CardInstance>, host?: Partial<CardInstance>) =>
      makeState(2, 0, {
        cards: {
          c1: { ...card('c1'), ...self },
          ...(host ? { c2: { ...card('c2'), ...host } } : {}),
        },
      });

    it('resolves the host of the card whose RULE is running, ignoring the triggering card', () => {
      const state = boardWith({ attachedTo: 'c2' }, { tags: ['x'] });
      // `triggeringCardId` deliberately points at a third card: if the two refs were conflated
      // this would resolve nothing at all, which is the failure mode this asserts against.
      const res = resolveValueRef(ref, state, makeCtx({ sourceCardId: 'c1', triggeringCardId: 'c9' }), makeDef());
      expect(res).toEqual({ ok: true, values: [true], quantifier: 'every' });
    });

    it('no source card at all is UNBOUND_REF — a global rule has no "self"', () => {
      const res = resolveValueRef(ref, boardWith({ attachedTo: 'c2' }, {}), makeCtx({ triggeringCardId: 'c1' }), makeDef());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('UNBOUND_REF');
    });

    it('a source card that is attached to nothing is MISSING_REFERENT, not UNBOUND_REF', () => {
      const res = resolveValueRef(ref, boardWith({ attachedTo: null }), makeCtx({ sourceCardId: 'c1' }), makeDef());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('MISSING_REFERENT');
    });

    it('a host id naming no card is TARGET_GONE', () => {
      const res = resolveValueRef(ref, boardWith({ attachedTo: 'ghost' }), makeCtx({ sourceCardId: 'c1' }), makeDef());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('TARGET_GONE');
    });
  });

  // -------------------------------------------------------------------------
  // cardTag — §4.2, §4.3. A BOOLEAN, read through effectiveTags.
  // -------------------------------------------------------------------------

  describe('cardTag', () => {
    const tagged = (tags: string[]): PlayState =>
      makeState(2, 0, { cards: { c1: { ...card('c1'), tags } } });

    it('resolves true when the instance carries the tag', () => {
      expect(
        resolveValueRef({ kind: 'cardTag', card: { kind: 'instance', id: 'c1' }, tag: 'enchanted' }, tagged(['enchanted']), makeCtx(), makeDef())
      ).toEqual({ ok: true, values: [true], quantifier: 'every' });
    });

    it('a tag the card does not carry is false, not MISSING_REFERENT', () => {
      // Unlike a card Index, a tag has no declaration to dangle from — "is this tagged" has to be
      // askable of the cards that aren't, or the ref is only usable where the answer is known.
      expect(
        resolveValueRef({ kind: 'cardTag', card: { kind: 'instance', id: 'c1' }, tag: 'enchanted' }, tagged([]), makeCtx(), makeDef())
      ).toEqual({ ok: true, values: [false], quantifier: 'every' });
    });

    it('reads the INSTANCE, not the template — a template tag the instance lost reads false', () => {
      const def = makeDef({
        templates: [{ id: 't1', name: 'T', marquee: 'T', faceIcon: 'sword', borderColor: '#000', tags: ['creature'], indexes: [], ruleSetIds: [], rulesTextOverride: null }],
      });
      expect(
        resolveValueRef({ kind: 'cardTag', card: { kind: 'instance', id: 'c1' }, tag: 'creature' }, tagged([]), makeCtx(), def)
      ).toEqual({ ok: true, values: [false], quantifier: 'every' });
    });

    it('propagates the CardRef failure rather than answering false', () => {
      const res = resolveValueRef({ kind: 'cardTag', card: { kind: 'triggering' }, tag: 'x' }, tagged([]), makeCtx(), makeDef());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('UNBOUND_REF');
    });

    it('a dead instance ref is TARGET_GONE, not false', () => {
      const res = resolveValueRef({ kind: 'cardTag', card: { kind: 'instance', id: 'ghost' }, tag: 'x' }, tagged([]), makeCtx(), makeDef());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('TARGET_GONE');
    });
  });

  // -------------------------------------------------------------------------
  // activeSeatCount — §3.5, §4.2
  // -------------------------------------------------------------------------

  describe('activeSeatCount', () => {
    it('reads seatOrder.length, NOT playerCount', () => {
      // The distinction is the whole point: storage stays dense and full-length, so `playerCount`
      // is still 5 here and reading it would report a table that no longer exists.
      const state = makeState(5, 0, { seatOrder: [0, 1, 2, 4], eliminated: [3] });
      expect(resolveValueRef({ kind: 'activeSeatCount' }, state, makeCtx(), makeDef())).toEqual({
        ok: true,
        values: [4],
        quantifier: 'every',
      });
    });

    it('needs no pool, zone or template to resolve — it is pure state', () => {
      expect(resolveValueRef({ kind: 'activeSeatCount' }, makeState(2, 0), makeCtx(), makeDef())).toEqual({
        ok: true,
        values: [2],
        quantifier: 'every',
      });
    });
  });

  // -------------------------------------------------------------------------
  // v2 §4.2, §5.7 — replacedAmount. Final behaviour, not a stub: outside a replacement rule it is
  // genuinely unbound.
  // -------------------------------------------------------------------------

  describe('replacedAmount', () => {
    it('is UNBOUND_REF outside a replacement rule — replacement.ts (step 27) is the only writer', () => {
      const result = resolveValueRef({ kind: 'replacedAmount' }, makeState(2, 0), makeCtx(), makeDef());
      expect(result).toMatchObject({ ok: false, reason: 'UNBOUND_REF' });
    });
  });

  // -------------------------------------------------------------------------
  // v2 §4.2, §4.8 — actionField, resolved for real by `pending.ts` (step 23). Ordering,
  // resolve-time behaviour and the stack-based ACs (MTG2/MTG3) live in `pending.test.ts`; this is
  // just the ValueRef wiring plus §9.5 edge case 11.
  // -------------------------------------------------------------------------

  describe('actionField', () => {
    const pendingAction = {
      id: 'a1',
      ruleId: 'r1',
      sourceCardId: null,
      controller: 1,
      ctx: makeCtx(),
      targets: { '0': ['c1', 'c2'], '1': ['c3'] },
      tags: [],
      countered: false,
    };

    it('reads controller/targetCount off an action on top of the stack', () => {
      const state = makeState(2, 0, { pendingActions: { a1: pendingAction }, actionStack: ['a1'] });
      expect(
        resolveValueRef(
          { kind: 'actionField', action: { kind: 'topOfStack' }, field: 'controller' },
          state,
          makeCtx(),
          makeDef()
        )
      ).toEqual({ ok: true, values: [1], quantifier: 'every' });
      expect(
        resolveValueRef(
          { kind: 'actionField', action: { kind: 'topOfStack' }, field: 'targetCount' },
          state,
          makeCtx(),
          makeDef()
        )
      ).toEqual({ ok: true, values: [3], quantifier: 'every' });
    });

    // §9.5 edge case 11 — never `undefined` propagating a silent NaN/false.
    it('an empty actionStack fails MISSING_REFERENT, not undefined', () => {
      const ref = { kind: 'actionField', action: { kind: 'topOfStack' }, field: 'controller' } as const;
      const result = resolveValueRef(ref, makeState(2, 0), makeCtx(), makeDef());
      expect(result).toMatchObject({ ok: false, reason: 'MISSING_REFERENT' });
    });

    it('a dangling {kind:"action", id} is TARGET_GONE', () => {
      const ref = { kind: 'actionField', action: { kind: 'action', id: 'ghost' }, field: 'controller' } as const;
      const result = resolveValueRef(ref, makeState(2, 0), makeCtx(), makeDef());
      expect(result).toMatchObject({ ok: false, reason: 'TARGET_GONE' });
    });

    it('triggeringAction is UNBOUND_REF outside a pending action\'s own resolution', () => {
      const ref = { kind: 'actionField', action: { kind: 'triggeringAction' }, field: 'controller' } as const;
      const result = resolveValueRef(ref, makeState(2, 0), makeCtx(), makeDef());
      expect(result).toMatchObject({ ok: false, reason: 'UNBOUND_REF' });
    });
  });

  // -------------------------------------------------------------------------
  // v2 §4.2, §8 step 28 — the `chooseNumber` design-slip closure. `dispatch.ts`'s `runEffect` writes
  // the answer into `ctx.promptAnswers[effect.key]` once `answerNumber` resolves it (see
  // `dispatch.test.ts`'s "promptNumber" describe block for that end-to-end path); this is just the
  // ValueRef read, same level `actionField`'s own "wiring" tests sit at above.
  // -------------------------------------------------------------------------

  describe('promptNumber', () => {
    it('resolves to the number stored under ctx.promptAnswers[key]', () => {
      const ctx = makeCtx({ promptAnswers: { x: ['7'] } });
      const result = resolveValueRef({ kind: 'promptNumber', key: 'x' }, makeState(2, 0), ctx, makeDef());
      expect(result).toEqual({ ok: true, values: [7], quantifier: 'every' });
    });

    // Same discipline as `replacedAmount` — a dangling read must not read as a plausible number.
    it('is UNBOUND_REF when nothing has answered under that key yet', () => {
      const result = resolveValueRef({ kind: 'promptNumber', key: 'x' }, makeState(2, 0), makeCtx(), makeDef());
      expect(result).toMatchObject({ ok: false, reason: 'UNBOUND_REF' });
    });

    it('a DIFFERENT key answered does not satisfy this one', () => {
      const ctx = makeCtx({ promptAnswers: { y: ['7'] } });
      const result = resolveValueRef({ kind: 'promptNumber', key: 'x' }, makeState(2, 0), ctx, makeDef());
      expect(result).toMatchObject({ ok: false, reason: 'UNBOUND_REF' });
    });
  });

  // -------------------------------------------------------------------------
  // v4 §4.1 (G1) — `arith`, the value language's only combinator.
  // -------------------------------------------------------------------------

  describe('arith', () => {
    const lit = (value: number | boolean): ValueRef => ({ kind: 'literal', value });
    const arith = (op: Extract<ValueRef, { kind: 'arith' }>['op'], left: ValueRef, right: ValueRef): ValueRef =>
      ({ kind: 'arith', op, left, right });
    const resolve = (ref: ValueRef, def = makeDef()) =>
      resolveValueRef(ref, makeState(2, 0), makeCtx(), def);

    it('applies each of the five ops to two literals', () => {
      expect(resolve(arith('add', lit(2), lit(3)))).toEqual({ ok: true, values: [5], quantifier: 'every' });
      expect(resolve(arith('subtract', lit(2), lit(3)))).toEqual({ ok: true, values: [-1], quantifier: 'every' });
      expect(resolve(arith('multiply', lit(2), lit(3)))).toEqual({ ok: true, values: [6], quantifier: 'every' });
      expect(resolve(arith('min', lit(2), lit(3)))).toEqual({ ok: true, values: [2], quantifier: 'every' });
      expect(resolve(arith('max', lit(2), lit(3)))).toEqual({ ok: true, values: [3], quantifier: 'every' });
    });

    // AC: SP13 — a nested expression compared against a literal resolves to ONE number, and a
    // boolean operand is refused rather than coerced. Both halves of the criterion, one test.
    it('resolves a nested expression to one number, and refuses a boolean operand', () => {
      const nested = arith('multiply', arith('add', lit(2), lit(3)), lit(4)); // (2 + 3) * 4
      const criterion: CriteriaNode = { kind: 'criteria', left: nested, op: '=', right: lit(20) };
      expect(resolve(nested)).toEqual({ ok: true, values: [20], quantifier: 'every' });
      expect(evalCriteriaBool(criterion, makeState(2, 0), makeCtx(), makeDef())).toBe(true);

      // `true` is neither 1 nor an error to swallow — the same refusal `modifiers.ts` makes rather
      // than adding a boolean into an `adjust`, and it holds on either side.
      expect(resolve(arith('add', lit(true), lit(1)))).toMatchObject({ ok: false, reason: 'TYPE_MISMATCH' });
      expect(resolve(arith('add', lit(1), lit(false)))).toMatchObject({ ok: false, reason: 'TYPE_MISMATCH' });
      expect(resolve(arith('max', lit(1), lit(true)))).toMatchObject({ ok: false, reason: 'TYPE_MISMATCH' });
    });

    it('reads real refs on both sides, not just literals', () => {
      const def = makeDef({ pools: [{ id: 'hp', scope: 'player', value: { type: 'integer', name: 'HP', defaultValue: 0, min: null, max: null } }] });
      const state = makeState(2, 0, { playerPools: { hp: [7, 2] } });
      const ref: ValueRef = arith('subtract', { kind: 'pool', poolId: 'hp', seat: { kind: 'seat', index: 0 } }, { kind: 'activeSeatCount' });
      expect(resolveValueRef(ref, state, makeCtx(), def)).toEqual({ ok: true, values: [5], quantifier: 'every' });
    });

    it('an operand resolving to one value PER SEAT has no single answer', () => {
      const def = makeDef({ pools: [{ id: 'hp', scope: 'player', value: { type: 'integer', name: 'HP', defaultValue: 0, min: null, max: null } }] });
      const state = makeState(2, 0, { playerPools: { hp: [7, 2] } });
      const ref: ValueRef = arith('add', { kind: 'pool', poolId: 'hp', seat: { kind: 'all' } }, lit(1));
      expect(resolveValueRef(ref, state, makeCtx(), def)).toMatchObject({ ok: false, reason: 'INVALID_SEAT' });
      // …but the `sum` quantifier collapses it to one total first, and then it does.
      const summed: ValueRef = arith('add', { kind: 'pool', poolId: 'hp', seat: { kind: 'all', quantifier: 'sum' } }, lit(1));
      expect(resolveValueRef(summed, state, makeCtx(), def)).toEqual({ ok: true, values: [10], quantifier: 'every' });
    });

    it('propagates an operand failure rather than treating it as zero', () => {
      expect(resolve(arith('add', { kind: 'replacedAmount' }, lit(1)))).toMatchObject({ ok: false, reason: 'UNBOUND_REF' });
    });

    // §5.5's ceiling, answered by the DEFINITION's knob rather than a hardcoded constant — the same
    // property `dispatch.test.ts` asserts for causal depth.
    it('nesting deeper than limits.maxDepth is RULE_LOOP, at the definition\'s own limit', () => {
      const def = makeDef({ limits: { ...makeDef().limits, maxDepth: 3 } });
      let deep: ValueRef = lit(1);
      for (let i = 0; i < 3; i++) deep = arith('add', deep, lit(1));
      expect(resolve(deep, def)).toEqual({ ok: true, values: [4], quantifier: 'every' });
      expect(resolve(arith('add', deep, lit(1)), def)).toMatchObject({ ok: false, reason: 'RULE_LOOP' });
      // The same expression is fine under the default limit: the cap is configuration, not a bug.
      expect(resolve(arith('add', deep, lit(1)))).toEqual({ ok: true, values: [5], quantifier: 'every' });
    });
  });

  // -------------------------------------------------------------------------
  // v4 §4.1 (G2) — `countMatching` and `sumIndex`, the two folds over a card set.
  // -------------------------------------------------------------------------

  describe('countMatching / sumIndex', () => {
    const BF = 'bf';
    const ENCH = 'ench';
    const powerIndex = { id: 'power', value: { type: 'integer' as const, name: 'Power', defaultValue: 0, min: null, max: null }, icon: 'sword', position: 'topLeft' as const };
    const shared = (id: string, name: string) =>
      ({ id, name, scope: 'shared' as const, visibility: 'faceUp' as const, layout: 'row' as const, ordered: false, maxCapacity: null });

    /**
     * Two shared zones and two templates. The rule-carrying template sits in the OTHER zone and
     * declares no index of its own, so one modifier means exactly one source: a rule on the counted
     * cards themselves would apply once per copy and bury the arithmetic these tests are about.
     */
    function boardDef(ruleSets: RuleSet[] = []): GameDefinition {
      const template = (id: string, indexes: typeof powerIndex[], ruleSetIds: string[]) =>
        ({ id, name: id, marquee: id, faceIcon: 'sword', borderColor: '#000', tags: [], indexes, ruleSetIds, rulesTextOverride: null });
      return makeDef({
        zones: [shared(BF, 'Battlefield'), shared(ENCH, 'Enchantments')],
        templates: [template('t1', [powerIndex], []), template('lord', [], ruleSets.map((r) => r.id))],
        ruleSets,
        globalRuleSetIds: [],
      });
    }

    /** Cards on the battlefield with the given Power values, plus the one rule-carrying source. */
    function board(powers: number[]): PlayState {
      const ids = powers.map((_, i) => `c${i + 1}`);
      return makeState(2, 0, {
        cards: {
          ...Object.fromEntries(powers.map((p, i) => [ids[i], card(ids[i], { power: p })])),
          lord: { ...card('lord'), templateId: 'lord' },
        },
        zones: { [BF]: zoneInst(BF, null, ids), [ENCH]: zoneInst(ENCH, null, ['lord']) },
      });
    }

    const allOnBoard: TargetSelector = { kind: 'allInZone', zone: { zoneId: BF, seat: null } };
    /** "…where Power of the card is above 2" — the predicate three of the five cards pass. */
    const bigOnes: TargetSelector = {
      kind: 'matching',
      from: allOnBoard,
      where: {
        kind: 'criteria',
        left: { kind: 'cardIndex', card: { kind: 'candidate' }, indexId: 'power' },
        op: '>',
        right: { kind: 'literal', value: 2 },
      },
    };

    /** An anthem: +1 Power to every card on the battlefield, from a rule every card carries. */
    const anthem: RuleSet = {
      id: 'anthem',
      name: 'Anthem',
      trigger: 'onGameStart',
      stateFilter: null,
      condition: null,
      effects: [],
      priority: 0,
      onRejection: 'continue',
      continuous: false,
      replaces: null,
      activation: null,
      modifier: { scope: allOnBoard, indexId: 'power', op: 'adjust', amount: { kind: 'literal', value: 1 }, activeZones: [] },
    };

    // AC: SP14 — five cards, three matching the predicate -> countMatching reads 3; and sumIndex over
    // that same set totals what the cards READ AS, modifiers included, not their stored base values.
    it('counts the matching cards and totals their EFFECTIVE index, not the stored base', () => {
      const powers = [1, 2, 3, 4, 5]; // three are above 2
      expect(resolveValueRef({ kind: 'countMatching', from: bigOnes }, board(powers), makeCtx(), boardDef())).toEqual({
        ok: true,
        values: [3],
        quantifier: 'every',
      });

      const sum: ValueRef = { kind: 'sumIndex', from: bigOnes, indexId: 'power' };
      expect(resolveValueRef(sum, board(powers), makeCtx(), boardDef())).toEqual({
        ok: true,
        values: [12], // 3 + 4 + 5, the stored values
        quantifier: 'every',
      });

      // The same board under one anthem. Reading `card.indexValues` would still say 12 — the exact
      // blindness MTG6 exists to prevent for a single card, here for a fold (§4.1).
      const buffed = boardDef([anthem]);
      expect(resolveValueRef(sum, board(powers), makeCtx(), buffed)).toEqual({
        ok: true,
        values: [18], // 3+1, 4+1, 5+1 — and 2+1, which is the next line
        quantifier: 'every',
      });
      // …and the anthem moves a card INTO the matching set, because the predicate reads effectively
      // too: Power 2 becomes 3, so four cards now match rather than three.
      expect(resolveValueRef({ kind: 'countMatching', from: bigOnes }, board(powers), makeCtx(), buffed)).toEqual({
        ok: true,
        values: [4],
        quantifier: 'every',
      });
    });

    it('an empty board counts 0 and totals 0 rather than failing NO_TARGETS', () => {
      const empty = makeState(2, 0, { zones: { [BF]: zoneInst(BF, null, []) } });
      expect(resolveValueRef({ kind: 'countMatching', from: allOnBoard }, empty, makeCtx(), boardDef())).toEqual({
        ok: true,
        values: [0],
        quantifier: 'every',
      });
      expect(resolveValueRef({ kind: 'sumIndex', from: allOnBoard, indexId: 'power' }, empty, makeCtx(), boardDef())).toEqual({
        ok: true,
        values: [0],
        quantifier: 'every',
      });
    });

    it('a deleted zone still fails — "none" and "broken" are not the same answer', () => {
      const ghost: TargetSelector = { kind: 'allInZone', zone: { zoneId: 'ghost', seat: null } };
      expect(resolveValueRef({ kind: 'countMatching', from: ghost }, board([1]), makeCtx(), boardDef())).toMatchObject({
        ok: false,
        reason: 'MISSING_REFERENT',
      });
    });

    // v4 §3 decision 4 — a read never asks a question. The precedent is `modifiers.ts`'s handling of
    // a `prompt` scope during a modifier read.
    it('a prompt anywhere inside `from` folds over nothing', () => {
      const asked: TargetSelector = { kind: 'prompt', from: allOnBoard, count: { kind: 'literal', value: 1 }, promptText: 'Pick' };
      const state = board([1, 2, 3, 4, 5]);
      expect(resolveValueRef({ kind: 'countMatching', from: asked }, state, makeCtx(), boardDef())).toEqual({
        ok: true,
        values: [0],
        quantifier: 'every',
      });
      // Wrapped the other way round (`matching(prompt(…))`) the prompt variant is what propagates
      // outward, so the same answer has to come back — this is the arm that catches depth.
      const wrapped: TargetSelector = { ...bigOnes, from: asked };
      expect(resolveValueRef({ kind: 'sumIndex', from: wrapped, indexId: 'power' }, state, makeCtx(), boardDef())).toEqual({
        ok: true,
        values: [0],
        quantifier: 'every',
      });
    });

    it('a card that does not declare the index contributes nothing', () => {
      const state = board([3, 4]);
      state.cards.c2 = card('c2', {}); // same template, no stored Power
      expect(resolveValueRef({ kind: 'sumIndex', from: allOnBoard, indexId: 'power' }, state, makeCtx(), boardDef())).toEqual({
        ok: true,
        values: [3],
        quantifier: 'every',
      });
    });

    it('a boolean index has no total', () => {
      const flagIndex = { ...powerIndex, id: 'flag', value: { type: 'boolean' as const, name: 'Flag', defaultValue: false } };
      const def = makeDef({
        zones: [{ id: BF, name: 'Battlefield', scope: 'shared', visibility: 'faceUp', layout: 'row', ordered: false, maxCapacity: null }],
        templates: [{ id: 't1', name: 'T', marquee: 'T', faceIcon: 'sword', borderColor: '#000', tags: [], indexes: [flagIndex], ruleSetIds: [], rulesTextOverride: null }],
      });
      const state = makeState(2, 0, {
        cards: { c1: card('c1', { flag: true }) },
        zones: { [BF]: zoneInst(BF, null, ['c1']) },
      });
      expect(resolveValueRef({ kind: 'sumIndex', from: allOnBoard, indexId: 'flag' }, state, makeCtx(), def)).toMatchObject({
        ok: false,
        reason: 'TYPE_MISMATCH',
      });
    });

    /**
     * v4 §4.1's named hazard, and §8's third risk: `valueRef -> resolveTargets -> evalCriteria ->
     * resolveValueRef` is a cycle ordinary authored text closes. This rule is exactly the sentence
     * the design cites — "creatures get +1/+1 while the total power of your creatures is 5 or more" —
     * with the fold in the modifier's own `amount`, which is the tightest form of it.
     */
    const selfReferentialAnthem: RuleSet = {
      ...anthem,
      modifier: {
        scope: allOnBoard,
        indexId: 'power',
        op: 'adjust',
        // The amount is a total of the very index this modifier adjusts.
        amount: { kind: 'sumIndex', from: allOnBoard, indexId: 'power' },
        activeZones: [],
      },
    };

    const total: ValueRef = { kind: 'sumIndex', from: allOnBoard, indexId: 'power' };
    const powerOf = (id: string): ValueRef => ({ kind: 'cardIndex', card: { kind: 'instance', id }, indexId: 'power' });

    it('a fold that reads the index it modifies terminates rather than recursing', () => {
      const def = boardDef([selfReferentialAnthem]);
      const read = () => resolveValueRef(total, board([1, 2]), makeCtx(), def);
      // Terminates at all: without the shared `inFlight` guard this is a stack overflow inside a
      // render. ponytail: the magnitude of a self-referential fold is defined but not meaningful —
      // the re-entrant read answers 0, so each card sees a total taken with itself held at base.
      // Getting a *layered* answer is MTG's layer system, which §5.4 deliberately stops short of.
      expect(read()).toEqual({ ok: true, values: [9], quantifier: 'every' });
      expect(read()).toEqual(read());
    });

    // §8's third risk, in full: "the degraded answer must not depend on which card the UI read
    // first". A committed `PlayState` is shared between a render and the engine's own criteria
    // gates, so if a prior read could change this one, rendering could change a rule's outcome.
    it('a prior read of the same index does not change the fold\'s answer', () => {
      const def = boardDef([selfReferentialAnthem]);
      const fresh = resolveValueRef(total, board([1, 2]), makeCtx(), def);

      // Same state object, per-card reads FIRST — the order that populates the §5.4 memo before the
      // fold runs. The memo must not have kept a value that a degraded read contributed to.
      const state = board([1, 2]);
      resolveValueRef(powerOf('c1'), state, makeCtx(), def);
      resolveValueRef(powerOf('c2'), state, makeCtx(), def);
      expect(resolveValueRef(total, state, makeCtx(), def)).toEqual(fresh);

      // And the reverse order, on a third state: fold first, then the per-card reads.
      const other = board([1, 2]);
      resolveValueRef(total, other, makeCtx(), def);
      expect(resolveValueRef(powerOf('c1'), other, makeCtx(), def)).toEqual(
        resolveValueRef(powerOf('c1'), board([1, 2]), makeCtx(), def)
      );
    });

    // The memo is only disabled where a cycle actually forced a degraded read: an ordinary board
    // still caches, which is the whole reason §5.4 has a memo.
    it('an acyclic modifier board still memoizes — one read, one collect', () => {
      const def = boardDef([anthem]);
      const state = board([1, 2]);
      expect(resolveValueRef(powerOf('c1'), state, makeCtx(), def)).toEqual({ ok: true, values: [2], quantifier: 'every' });
      // Mutating the base UNDER the memo is visible only if the memo was not written. It is: the
      // second read answers the cached 2, not the 6 the mutated base would produce.
      state.cards.c1.indexValues.power = 5;
      expect(resolveValueRef(powerOf('c1'), state, makeCtx(), def)).toEqual({ ok: true, values: [2], quantifier: 'every' });
    });
  });
});

// ---------------------------------------------------------------------------
// resolvePoolDef — F4: the reserved activePlayer pool has a runtime value but no authored
// PointPool. An authored pool with the same id must still win (the designer's bounds apply).
// ---------------------------------------------------------------------------

describe('resolvePoolDef', () => {
  it('falls back to the implicit activePlayer definition when nothing is authored', () => {
    const def = makeDef(); // pools: []
    expect(resolvePoolDef(def, ACTIVE_PLAYER_POOL_ID)).toBe(ACTIVE_PLAYER_POOL);
  });

  it('an authored activePlayer pool wins over the implicit definition', () => {
    const authored: PointPool = {
      id: ACTIVE_PLAYER_POOL_ID,
      scope: 'player',
      value: { type: 'integer', name: 'Custom Active Player', defaultValue: 1, min: 0, max: 3 },
    };
    const def = makeDef({ pools: [authored] });
    expect(resolvePoolDef(def, ACTIVE_PLAYER_POOL_ID)).toBe(authored);
  });

  it('an unknown, non-reserved pool id is undefined', () => {
    expect(resolvePoolDef(makeDef(), 'ghost')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F4, system-level: setup.ts seeds a runtime activePlayer value even when it isn't authored
// (§4.1), but createPlayState must never write it back into the definition itself — the
// byte-identical export round trip (§7.1) would break the moment a definition passes through a
// play session.
// ---------------------------------------------------------------------------

describe('activePlayer never leaks into the exported definition', () => {
  it('exportJson(duel) is unchanged after createPlayState seeds activePlayer at runtime', () => {
    const before = exportJson(duel);
    createPlayState(duel, 'seed-1'); // duel is frozen — a mutation attempt would throw
    expect(exportJson(duel)).toBe(before);
    expect(JSON.parse(before).pools.some((p: { id: string }) => p.id === ACTIVE_PLAYER_POOL_ID)).toBe(false);
  });
});
