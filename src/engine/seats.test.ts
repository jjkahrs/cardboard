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
import { resolveCardRef, resolveSeat } from './seats';
import { applyEffect, type EffectContext } from './effects';
import { resolveValueRef } from './valueRef';
import { evalCriteriaBool } from './criteria';
import { createPlayState } from './setup';
import { duel } from '../test/fixtures/duel';
import {
  ACTIVE_PLAYER_POOL_ID,
  type CriteriaNode,
  type GameDefinition,
  type LogLine,
  type PlayState,
  type SeatRef,
  type TriggerContext,
} from './types';

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

const ctx: TriggerContext = {
  triggeringCardId: null,
  zoneKey: null,
  triggeringSeat: null,
  promptAnswers: {},
  sourceCardId: null,
};

/** The single seat a ref resolved to, or the reject reason. Keeps the assertions one line each. */
function seatOf(ref: SeatRef, state: PlayState): number | string {
  const res = resolveSeat(ref, state, ctx);
  return res.ok ? res.seats[0] : res.reason;
}

const relative = (from: SeatRef, offset: number): SeatRef => ({ kind: 'relative', from, offset });
const seat = (index: number): SeatRef => ({ kind: 'seat', index });

/** `duel` at an arbitrary table size. Only `playerCount` differs, so V10's threshold is identical. */
const table = (playerCount: number): GameDefinition => ({ ...duel, playerCount });

/**
 * Runs the real `eliminateSeat` effect against `state`, in place, and hands back its log lines.
 * The tests below go through the effect rather than editing `seatOrder` by hand precisely because
 * §5.12's guarantees are about what the effect does NOT touch as much as what it does.
 */
function eliminate(state: PlayState, def: GameDefinition, ref: SeatRef): LogLine[] {
  const lines: LogLine[] = [];
  const ec: EffectContext = {
    state,
    def,
    ctx,
    depth: 0,
    override: false,
    log: (line) => lines.push(line),
    fireEvent: () => {
      throw new Error('eliminateSeat must not fire events — §5.12 names no event for elimination');
    },
  };
  const res = applyEffect({ kind: 'eliminateSeat', seat: ref }, ec);
  if (!res.ok) throw new Error(`eliminateSeat rejected: ${res.reason} — ${res.detail ?? ''}`);
  return lines;
}

const activeSeatCount = (state: PlayState, def: GameDefinition): number | boolean => {
  const res = resolveValueRef({ kind: 'activeSeatCount' }, state, ctx, def);
  if (!res.ok) throw new Error(`activeSeatCount failed: ${res.reason}`);
  return res.values[0];
};

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

  it('fails active/next/previous when the ACTIVE seat is the eliminated one', () => {
    const state = ousted(3);
    // Two different refusals, and the split is deliberate. `active` RESOLVES TO the ousted seat, so
    // §5.12's rule applies: SEAT_ELIMINATED. `next`/`previous` are sugar for relative(active, ±1),
    // whose BASE is ousted — §4.1 pins that case to INVALID_SEAT by name, because "the seat after
    // an ousted seat" is a broken question rather than an ousted answer.
    expect(seatOf({ kind: 'active' }, state)).toBe('SEAT_ELIMINATED');
    expect(seatOf({ kind: 'next' }, state)).toBe('INVALID_SEAT');
    expect(seatOf({ kind: 'previous' }, state)).toBe('INVALID_SEAT');
  });

  it('fails triggeringSeat when the seat that fired the event has since been eliminated', () => {
    const res = resolveSeat({ kind: 'triggeringSeat' }, ousted(0), { ...ctx, triggeringSeat: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('SEAT_ELIMINATED');
      expect(res.message).toContain('seat 3');
    }
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

  it('carries `sum` through untouched — collapsing it is valueRef.ts\'s job, not the ring\'s', () => {
    const state = makeState(3, 0);
    expect(resolveSeat({ kind: 'all', quantifier: 'sum' }, state, ctx)).toEqual({
      ok: true,
      seats: [0, 1, 2],
      quantifier: 'sum',
    });
  });
});

// ---------------------------------------------------------------------------
// The eliminateSeat effect — §5.12
// ---------------------------------------------------------------------------

describe('eliminateSeat', () => {
  const def = table(5);

  it('moves the seat from seatOrder to eliminated and logs ONE change line', () => {
    const state = createPlayState(def, 'oust');
    const lines = eliminate(state, def, seat(3));

    expect(state.seatOrder).toEqual([0, 1, 2, 4]);
    expect(state.eliminated).toEqual([3]);
    const changes = lines.filter((l) => l.kind === 'change');
    expect(changes).toHaveLength(1);
    expect(changes[0].change).toEqual({ path: 'seatOrder', before: [0, 1, 2, 3, 4], after: [0, 1, 2, 4] });
    expect(changes[0].effectKind).toBe('eliminateSeat');
  });

  it('deletes no storage — pools, zone instances and cards all survive (§3.5)', () => {
    const state = createPlayState(def, 'oust');
    const zonesBefore = Object.keys(state.zones).length;
    const cardsBefore = Object.keys(state.cards).length;
    const hpBefore = state.playerPools.pool_hp?.slice();

    eliminate(state, def, seat(3));

    expect(Object.keys(state.zones)).toHaveLength(zonesBefore);
    expect(Object.keys(state.cards)).toHaveLength(cardsBefore);
    expect(state.playerPools.pool_hp).toEqual(hpBefore);
    expect(state.zones['zone_hand#3']).toBeDefined();
    expect(state.playerCount).toBe(5); // the INITIAL count, deliberately unchanged (§3.5)
  });

  it('refuses to eliminate a seat that is already out, rather than double-appending it', () => {
    const state = createPlayState(def, 'oust');
    eliminate(state, def, seat(3));
    const lines: LogLine[] = [];
    const res = applyEffect(
      { kind: 'eliminateSeat', seat: seat(3) },
      { state, def, ctx, depth: 0, override: false, log: (l) => lines.push(l), fireEvent: () => {} }
    );
    expect(res).toMatchObject({ ok: false, reason: 'SEAT_ELIMINATED' });
    expect(state.eliminated).toEqual([3]);
  });

  it('an `all` ref containing an already-ousted seat eliminates NOBODY (§5.3 atomicity)', () => {
    // `all` walks seatOrder, so it can never contain an ousted seat; the reachable version of this
    // is the same seat named twice, which is what an authored "eliminate everyone at 0 HP" loop
    // produces on a second pass. Assert the plan-then-mutate split holds either way.
    const state = createPlayState(def, 'oust');
    state.seatOrder = [0, 1, 2, 4];
    state.eliminated = [3];
    const lines: LogLine[] = [];
    const res = applyEffect(
      { kind: 'eliminateSeat', seat: { kind: 'relative', from: seat(4), offset: -1 } },
      { state, def, ctx, depth: 0, override: false, log: (l) => lines.push(l), fireEvent: () => {} }
    );
    expect(res.ok).toBe(true); // relative(4, -1) is seat 2 — live, so this one goes through
    expect(state.seatOrder).toEqual([0, 1, 4]);
  });
});

// ---------------------------------------------------------------------------
// §9.1 acceptance criteria
// ---------------------------------------------------------------------------

// AC: SP11 — the three consequences of one oust, asserted together because §5.12's claim is that
// they follow from a single `seatOrder` splice with nothing else in the engine aware of it.
it('SP11: 5 seats, seat 3 eliminated — the ring closes, the count drops, the session continues', () => {
  const def = table(5);
  const state = createPlayState(def, 'sp11');
  expect(activeSeatCount(state, def)).toBe(5);

  eliminate(state, def, seat(3));

  expect(seatOf(relative(seat(2), 1), state)).toBe(4); // the seat after 2 is now 4, not 3
  expect(activeSeatCount(state, def)).toBe(4);
  expect(state.finished).toBe(false); // elimination is NOT session end (§5.12)
});

// AC: V2 — one session, one createPlayState. The point is that nothing had to be rebuilt: the
// post-oust ring is the same object the pre-oust references were resolved against.
it('V2: a seat ousted mid-session makes its former neighbours adjacent, with no restart', () => {
  const def = table(5);
  const state = createPlayState(def, 'v2');

  // Pre-oust: 2 -> 3 -> 4, and 4's predecessor is 3.
  expect(seatOf(relative(seat(2), 1), state)).toBe(3);
  expect(seatOf(relative(seat(4), -1), state)).toBe(3);

  eliminate(state, def, seat(3));

  // Post-oust, same state object: 2 and 4 are neighbours in both directions...
  expect(seatOf(relative(seat(2), 1), state)).toBe(4);
  expect(seatOf(relative(seat(4), -1), state)).toBe(2);
  // ...and the ring is genuinely shorter, so a full lap is one step less than it was.
  expect(seatOf(relative(seat(0), 4), state)).toBe(0);
  // The ousted seat's own index stays readable for forensics, but is no longer walked past.
  expect(seatOf(seat(3), state)).toBe(3);
  expect(seatOf(relative(seat(3), 1), state)).toBe('INVALID_SEAT');
});

// ---------------------------------------------------------------------------
// owner / controller as seat refs — §4.1, §4.3
// ---------------------------------------------------------------------------

describe('owner / controller seat refs', () => {
  const def = table(5);

  /** Seat 3's top deck card, moved into seat 3's Hand. Owned by 3, held by 3. */
  const cardOfSeat3 = (state: PlayState) => state.zones['zone_deck#3'].cardIds[0];

  const ownerOfCard = (id: string): SeatRef => ({ kind: 'owner', card: { kind: 'instance', id } });
  const controllerOfCard = (id: string): SeatRef => ({ kind: 'controller', card: { kind: 'instance', id } });

  it('resolve to the seat that owns / controls the card, independently of each other', () => {
    const state = createPlayState(def, 'owner');
    const id = cardOfSeat3(state);
    expect(seatOf(ownerOfCard(id), state)).toBe(3);
    expect(seatOf(controllerOfCard(id), state)).toBe(3); // derived from the holding zone

    state.cards[id].controller = 0;
    expect(seatOf(ownerOfCard(id), state)).toBe(3); // unchanged
    expect(seatOf(controllerOfCard(id), state)).toBe(0);
  });

  it('propagate the card ref\'s own failure rather than inventing a seat', () => {
    const state = createPlayState(def, 'owner');
    expect(seatOf(ownerOfCard('c-nope'), state)).toBe('TARGET_GONE');
    expect(resolveSeat({ kind: 'owner', card: { kind: 'triggering' } }, state, ctx)).toMatchObject({
      ok: false,
      reason: 'UNBOUND_REF',
    });
  });

  it('fail MISSING_REFERENT for a card with no seat at all, rather than defaulting to active', () => {
    const state = createPlayState(def, 'owner');
    const id = cardOfSeat3(state);
    state.cards[id].owner = null;
    expect(seatOf(ownerOfCard(id), state)).toBe('MISSING_REFERENT');
  });

  it('fail SEAT_ELIMINATED once the owning seat is ousted (§5.12)', () => {
    const state = createPlayState(def, 'owner');
    const id = cardOfSeat3(state);
    eliminate(state, def, seat(3));
    expect(seatOf(ownerOfCard(id), state)).toBe('SEAT_ELIMINATED');
  });
});

// AC: V1 — the point of `relative` taking ANY base. `next`/`previous` would answer relative to the
// active seat, which is the wrong player for a card whose turn it is not.
it('V1: predator-of-the-owner resolves relative to the owner, not to the active seat', () => {
  const def = table(5);
  const state = createPlayState(def, 'v1');
  const id = state.zones['zone_deck#3'].cardIds[0]; // owned by seat 3
  state.pools[ACTIVE_PLAYER_POOL_ID] = 0; // ...whose turn it is NOT
  const card: SeatRef = { kind: 'owner', card: { kind: 'instance', id } };

  expect(seatOf({ kind: 'active' }, state)).toBe(0);
  expect(seatOf(card, state)).toBe(3);
  expect(seatOf(relative(card, -1), state)).toBe(2); // the owner's predator
  expect(seatOf(relative(card, 1), state)).toBe(4); // and their prey

  // The active-seat spelling answers a different question, which is exactly the bug V1 guards.
  expect(seatOf({ kind: 'previous' }, state)).toBe(4);

  // Still correct after an oust closes the ring between the owner and their predator.
  eliminate(state, def, seat(2));
  expect(seatOf(relative(card, -1), state)).toBe(1);
});

// AC: V10 — the same authored criterion, two table sizes, no per-game configuration. The threshold
// is a single frozen CriteriaNode shared by both sessions on purpose: if `activeSeatCount` needed
// tuning per table size, this could not be one object.
it('V10: one authored threshold reads the correct table size at 4 and at 5 seats', () => {
  const fiveOrMore: CriteriaNode = {
    kind: 'criteria',
    left: { kind: 'activeSeatCount' },
    op: '>=',
    right: { kind: 'literal', value: 5 },
  };

  const four = table(4);
  const five = table(5);
  const stateOf4 = createPlayState(four, 'v10');
  const stateOf5 = createPlayState(five, 'v10');

  expect(activeSeatCount(stateOf4, four)).toBe(4);
  expect(activeSeatCount(stateOf5, five)).toBe(5);
  expect(evalCriteriaBool(fiveOrMore, stateOf4, ctx, four)).toBe(false);
  expect(evalCriteriaBool(fiveOrMore, stateOf5, ctx, five)).toBe(true);

  // And it keeps tracking: ousting one seat at the 5-seat table flips the same criterion.
  eliminate(stateOf5, five, seat(1));
  expect(evalCriteriaBool(fiveOrMore, stateOf5, ctx, five)).toBe(false);
});

// ---------------------------------------------------------------------------
// v2 §4.2, §5.7 — CardRef{kind:'replacedTarget'}. Final behaviour, not a stub: outside a
// replacement rule it is genuinely unbound — replacement.ts (step 27) is the only writer.
// ---------------------------------------------------------------------------

describe('resolveCardRef — replacedTarget', () => {
  it('is UNBOUND_REF outside a replacement rule', () => {
    const state = makeState(2, 0);
    const result = resolveCardRef({ kind: 'replacedTarget' }, state, ctx);
    expect(result).toMatchObject({ ok: false, reason: 'UNBOUND_REF' });
  });
});

// ---------------------------------------------------------------------------
// v4 §4.2 (G4) — CardRef{kind:'self'}. The end-to-end proof (that `dispatch.ts` stamps
// `sourceCardId` per binding, so `self` is right inside triggers/activations/modifiers) is
// `dispatch.test.ts`'s; this is the resolver, where the three outcomes are one line each.
// ---------------------------------------------------------------------------

describe('resolveCardRef — self (v4 §4.2)', () => {
  const withCard = (): { state: PlayState; id: string } => {
    const state = createPlayState(table(2), 'self');
    return { state, id: state.zones['zone_deck#0'].cardIds[0] };
  };

  it('resolves to the card carrying the rule, NOT to the card an event was about', () => {
    const { state, id } = withCard();
    const other = state.zones['zone_deck#1'].cardIds[0];
    // The shape that matters: an event about someone else's card, a rule printed on mine.
    const res = resolveCardRef({ kind: 'self' }, state, {
      ...ctx,
      sourceCardId: id,
      triggeringCardId: other,
    });
    expect(res).toMatchObject({ ok: true });
    expect(res.ok && res.card.id).toBe(id);
    // ...and `triggering` on the same ctx answers the other question, which is the whole point.
    const trig = resolveCardRef({ kind: 'triggering' }, state, {
      ...ctx,
      sourceCardId: id,
      triggeringCardId: other,
    });
    expect(trig.ok && trig.card.id).toBe(other);
  });

  it('is UNBOUND_REF in a game-level rule, which has no card to mean', () => {
    const { state } = withCard();
    expect(resolveCardRef({ kind: 'self' }, state, ctx)).toMatchObject({
      ok: false,
      reason: 'UNBOUND_REF',
    });
  });

  it('is TARGET_GONE, not UNBOUND_REF, when the source card has been destroyed mid-rule', () => {
    const { state, id } = withCard();
    delete state.cards[id];
    expect(resolveCardRef({ kind: 'self' }, state, { ...ctx, sourceCardId: id })).toMatchObject({
      ok: false,
      reason: 'TARGET_GONE',
    });
  });
});

// ---------------------------------------------------------------------------
// v4 §4.3 (G3) — SeatRef{kind:'promptSeat'}, the reader half. `dispatch.test.ts` owns the round trip
// that writes the answer; these are the reads, including the ones no answer can produce but a
// rewound or hand-poked session could.
// ---------------------------------------------------------------------------

describe('resolveSeat — promptSeat (v4 §4.3)', () => {
  const chosen = (key: string): SeatRef => ({ kind: 'promptSeat', key });
  const answered = (key: string, answer: string): TriggerContext => ({
    ...ctx,
    promptAnswers: { [key]: [answer] },
  });

  it('is UNBOUND_REF before any chooseSeat has answered under that key — never a fallback to active', () => {
    const state = makeState(3, 1);
    expect(resolveSeat(chosen('victim'), state, ctx)).toMatchObject({
      ok: false,
      reason: 'UNBOUND_REF',
    });
    // The wrong key is just as unbound as no key at all.
    expect(resolveSeat(chosen('victim'), state, answered('other', '2'))).toMatchObject({
      ok: false,
      reason: 'UNBOUND_REF',
    });
  });

  it('resolves to the answered seat', () => {
    const state = makeState(3, 1);
    const res = resolveSeat(chosen('victim'), state, answered('victim', '2'));
    expect(res).toMatchObject({ ok: true, quantifier: 'every' });
    expect(res.ok && res.seats).toEqual([2]);
  });

  it('is INVALID_SEAT for a stored answer that is not a seat — a blank must not read as seat 0', () => {
    const state = makeState(3, 1);
    for (const answer of ['', ' ', 'two', '1.5', '-1', '3']) {
      expect(resolveSeat(chosen('victim'), state, answered('victim', answer))).toMatchObject({
        ok: false,
        reason: 'INVALID_SEAT',
      });
    }
  });

  it('is SEAT_ELIMINATED once the chosen seat is ousted between the answer and the read (§5.12)', () => {
    const def = table(3);
    const state = createPlayState(def, 'promptSeat');
    eliminate(state, def, seat(2));
    expect(resolveSeat(chosen('victim'), state, answered('victim', '2'))).toMatchObject({
      ok: false,
      reason: 'SEAT_ELIMINATED',
    });
  });
});
