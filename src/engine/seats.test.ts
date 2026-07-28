/**
 * The seat ring — §3.5, §4.1, §5.12.
 *
 * `valueRef.test.ts` keeps the v1 resolveSeat suite (active/seat/triggeringSeat, the
 * refusal-to-clamp cases) because those assertions are about reference resolution generally. This
 * file is about the RING: what `relative` does, and what happens to it once `seatOrder` is not
 * simply `0..playerCount-1`.
 *
 * No `eliminateSeat` effect exists yet (step 12), so the eliminated-seat cases build the post-oust
 * `seatOrder` directly. That is exactly the state §5.12 says the effect must leave behind — a seat
 * dropped from the ring with its storage untouched.
 */

import { describe, expect, it } from 'vitest';
import { resolveSeat } from './seats';
import { ACTIVE_PLAYER_POOL_ID, type PlayState, type SeatRef, type TriggerContext } from './types';

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

const ctx: TriggerContext = {
  triggeringCardId: null,
  zoneKey: null,
  triggeringSeat: null,
  promptAnswers: {},
};

/** The single seat a ref resolved to, or the reject reason. Keeps the assertions one line each. */
function seatOf(ref: SeatRef, state: PlayState): number | string {
  const res = resolveSeat(ref, state, ctx);
  return res.ok ? res.seats[0] : res.reason;
}

const relative = (from: SeatRef, offset: number): SeatRef => ({ kind: 'relative', from, offset });
const seat = (index: number): SeatRef => ({ kind: 'seat', index });

// ---------------------------------------------------------------------------
// relative — §4.1
// ---------------------------------------------------------------------------

describe('relative', () => {
  it('steps forward and backward from any base seat, not just the active one', () => {
    const state = makeState(5, 0);
    expect(seatOf(relative(seat(3), 1), state)).toBe(4);
    expect(seatOf(relative(seat(3), 2), state)).toBe(0); // wraps past the end
    expect(seatOf(relative(seat(3), -1), state)).toBe(2);
    expect(seatOf(relative(seat(3), -4), state)).toBe(4); // wraps past the start
  });

  it('offset 0 is the base seat itself', () => {
    expect(seatOf(relative(seat(2), 0), makeState(4, 0))).toBe(2);
  });

  it('offsets larger than the ring wrap as many times as needed', () => {
    const state = makeState(4, 0);
    expect(seatOf(relative(seat(1), 4), state)).toBe(1);
    expect(seatOf(relative(seat(1), 6), state)).toBe(3);
    expect(seatOf(relative(seat(1), -6), state)).toBe(3);
  });

  it('nests — relative(relative(active, 1), 1) is two seats along', () => {
    const state = makeState(4, 0);
    expect(seatOf(relative(relative({ kind: 'active' }, 1), 1), state)).toBe(2);
  });

  it('refuses a fractional offset rather than reading a fractional index', () => {
    const res = resolveSeat(relative(seat(0), 1.5), makeState(3, 0), ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('INVALID_SEAT');
      expect(res.message).toContain('1.5');
    }
  });

  it('refuses `all` as a base — "the seat after every seat" has no single answer', () => {
    const res = resolveSeat(relative({ kind: 'all' }, 1), makeState(3, 0), ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('INVALID_SEAT');
  });

  it('propagates the base ref\'s own failure unchanged', () => {
    const res = resolveSeat(relative({ kind: 'triggeringSeat' }, 1), makeState(3, 0), ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('UNBOUND_REF');
  });
});

// ---------------------------------------------------------------------------
// next / previous are sugar over relative — §3.5
// ---------------------------------------------------------------------------

describe('next / previous', () => {
  it('are exactly relative(active, +1) and relative(active, -1) at every seat of the ring', () => {
    for (let active = 0; active < 4; active++) {
      const state = makeState(4, active);
      expect(resolveSeat({ kind: 'next' }, state, ctx)).toEqual(
        resolveSeat(relative({ kind: 'active' }, 1), state, ctx)
      );
      expect(resolveSeat({ kind: 'previous' }, state, ctx)).toEqual(
        resolveSeat(relative({ kind: 'active' }, -1), state, ctx)
      );
    }
  });

  it('keep v1 wrap-around behaviour while nothing is eliminated', () => {
    expect(seatOf({ kind: 'next' }, makeState(3, 2))).toBe(0);
    expect(seatOf({ kind: 'previous' }, makeState(3, 0))).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The ring closes on elimination — §5.12
// ---------------------------------------------------------------------------

describe('a seat removed from seatOrder', () => {
  /** Five seats, seat 3 ousted. Storage stays full-length; only the ring shrank (§3.5). */
  const ousted = (activePlayer: number) =>
    makeState(5, activePlayer, { seatOrder: [0, 1, 2, 4], eliminated: [3] });

  it('closes the ring — its former neighbours become adjacent', () => {
    const state = ousted(2);
    expect(seatOf({ kind: 'next' }, state)).toBe(4); // 2 -> 4, skipping 3
    expect(seatOf(relative(seat(4), -1), state)).toBe(2);
  });

  it('shortens the ring, so a full lap is one step less', () => {
    const state = ousted(0);
    expect(seatOf(relative(seat(0), 4), state)).toBe(0);
    expect(seatOf(relative(seat(0), 2), state)).toBe(2);
  });

  it('fails INVALID_SEAT when the BASE is the eliminated seat, rather than guessing a survivor', () => {
    const res = resolveSeat(relative(seat(3), 1), ousted(0), ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('INVALID_SEAT');
      expect(res.message).toContain('seat 3');
    }
  });

  it('fails next/previous when the ACTIVE seat is the eliminated one', () => {
    const state = ousted(3);
    // `active` itself still resolves: 3 is in range, and §5.12 keeps the raw index readable.
    expect(seatOf({ kind: 'active' }, state)).toBe(3);
    expect(seatOf({ kind: 'next' }, state)).toBe('INVALID_SEAT');
    expect(seatOf({ kind: 'previous' }, state)).toBe('INVALID_SEAT');
  });

  it('still resolves {kind:"seat", index} for the eliminated seat — forensics (§5.12)', () => {
    expect(seatOf(seat(3), ousted(0))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// `all` iterates the ring, NOT the dense storage — the trap §4.1 names
// ---------------------------------------------------------------------------

describe('all', () => {
  it('iterates seatOrder, so an eliminated seat is not counted', () => {
    // playerCount stays 5 and playerPools would still be length 5: iterating either would include 3.
    const state = makeState(5, 0, { seatOrder: [0, 1, 2, 4], eliminated: [3] });
    expect(resolveSeat({ kind: 'all' }, state, ctx)).toEqual({
      ok: true,
      seats: [0, 1, 2, 4],
      quantifier: 'every',
    });
  });

  it('carries the quantifier through unchanged, defaulting to every (§5.7)', () => {
    const state = makeState(3, 0);
    expect(resolveSeat({ kind: 'all', quantifier: 'some' }, state, ctx)).toEqual({
      ok: true,
      seats: [0, 1, 2],
      quantifier: 'some',
    });
  });

  it('returns a copy — a caller sorting the result must not reorder the ring', () => {
    const state = makeState(3, 0);
    const res = resolveSeat({ kind: 'all' }, state, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.seats).not.toBe(state.seatOrder);
  });
});
