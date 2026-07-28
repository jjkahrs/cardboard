import { describe, expect, it } from 'vitest';
import { parseZoneKey, resolvePoolDef, resolveSeat, resolveValueRef, zoneKey } from './valueRef';
import { evalCriteriaBool } from './criteria';
import type { CriteriaNode } from './types';
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
    budget: { causalDepth: 0, effectsUsed: 0, settleIterations: 0 },
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
