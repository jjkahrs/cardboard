/**
 * The seat ring. TECHNICAL_DESIGN_V2.md §3.5, §4.1, §5.12.
 *
 * Split out of `valueRef.ts` because seat identity and seat *position* are now different things:
 * `SeatId` is stable and assigned once at setup, while `state.seatOrder` is the live ring and
 * shrinks as seats are eliminated. Every relative reference walks `seatOrder`, never modular
 * arithmetic over `playerCount`, which is what closes the ring on an oust with no other code aware
 * anything happened.
 *
 * Storage stays dense and full-length (§3.5) — `playerPools[poolId]` is still indexed by `SeatId`
 * and every per-seat zone instance is still in `state.zones`. An eliminated seat's values are
 * unreachable through references, not deleted.
 *
 * This module must NOT import `valueRef.ts` — `valueRef.ts` imports it, and the cycle would be a
 * real one (both are loaded at module-eval time by `effects.ts` and `targets.ts`).
 *
 * Pure and never throws, like everything it was extracted from: a malformed ref resolves to a
 * typed failure instead of bricking the session.
 */

import {
  ACTIVE_PLAYER_POOL_ID,
  type PlayState,
  type RejectReason,
  type SeatId,
  type SeatRef,
  type TriggerContext,
} from './types';

// ---------------------------------------------------------------------------
// Result types — shared with valueRef.ts, which re-exports them for existing call sites
// ---------------------------------------------------------------------------

export interface ResolutionFail {
  ok: false;
  reason: RejectReason;
  /** Human-readable, suitable for a log line. Does not itself carry a LogLevel. */
  message: string;
}

export interface SeatResolutionOk {
  ok: true;
  /** Length 1 for every SeatRef except `all`, which returns `seatOrder` — ring order, not indices. */
  seats: SeatId[];
  /** Only meaningful when `seats.length > 1` (the `all` case). Defaults to 'every' — §5.7. */
  quantifier: 'every' | 'some';
}

export type SeatResolution = SeatResolutionOk | ResolutionFail;

export function fail(reason: RejectReason, message: string): ResolutionFail {
  return { ok: false, reason, message };
}

function ok(seats: SeatId[], quantifier: 'every' | 'some' = 'every'): SeatResolutionOk {
  return { ok: true, seats, quantifier };
}

// ---------------------------------------------------------------------------
// resolveSeat — §4.1, §5.7
// ---------------------------------------------------------------------------

/**
 * Steps `offset` positions round the LIVE ring from `base`. Eliminated seats are simply absent from
 * `seatOrder`, so they are skipped with no special-casing and former neighbours become adjacent.
 *
 * `base` not being in `seatOrder` means it was eliminated (or was never a seat at all). That fails
 * rather than clamping or guessing a nearest survivor — §4.1 is explicit, and the same
 * refusal-to-clamp discipline governs every other seat failure in this file.
 */
function stepRing(base: SeatId, offset: number, state: PlayState, label: string): SeatResolution {
  const order = state.seatOrder;
  const at = order.indexOf(base);
  if (at < 0) {
    return fail(
      'INVALID_SEAT',
      `Player ref "${label}": seat ${base} is not in the seat order (eliminated, or never seated).`
    );
  }
  // Authored offsets are `.int()` in the schema, but a hand-edited import reaches here unvalidated
  // and a fractional offset would index the array with a fraction and read `undefined`.
  if (!Number.isInteger(offset)) {
    return fail('INVALID_SEAT', `Player ref "${label}": offset ${offset} is not an integer.`);
  }
  const n = order.length;
  return ok([order[(((at + offset) % n) + n) % n]]);
}

export function resolveSeat(ref: SeatRef, state: PlayState, ctx: TriggerContext): SeatResolution {
  const N = state.playerCount;
  const A = state.pools[ACTIVE_PLAYER_POOL_ID] as number;

  // active/next/previous all derive from activePlayer — one guard covers all three. A hand-edited
  // JSON (or an authored `changePool activePlayer add 0.5` — the literal has no `.int()`, and
  // clampValue doesn't truncate) can make this a fraction, NaN, or a boolean. None of those is a
  // valid seat either, and `Number.isInteger` rejects all three (it's false for non-numbers too).
  const requireActiveInRange = (kind: string): ResolutionFail | null =>
    !Number.isInteger(A) || A < 0 || A >= N
      ? fail('INVALID_SEAT', `Player ref "${kind}": activePlayer = ${A} is not a valid seat (${N} seats).`)
      : null;

  switch (ref.kind) {
    case 'active': {
      const err = requireActiveInRange('active');
      return err ?? ok([A]);
    }
    // Sugar for relative(active, ±1) — §3.5. Identical to v1's modular arithmetic while nothing is
    // eliminated, and correct rather than off-by-one once something is.
    case 'next': {
      const err = requireActiveInRange('next');
      return err ?? stepRing(A, 1, state, 'next');
    }
    case 'previous': {
      const err = requireActiveInRange('previous');
      return err ?? stepRing(A, -1, state, 'previous');
    }
    case 'relative': {
      const from = resolveSeat(ref.from, state, ctx);
      if (!from.ok) return from;
      // `all` as a base is meaningless: "the seat after every seat" has no single answer. Refuse it
      // rather than silently taking the first.
      if (from.seats.length !== 1) {
        return fail(
          'INVALID_SEAT',
          `Player ref "relative": its base resolved to ${from.seats.length} seats; expected exactly one.`
        );
      }
      return stepRing(from.seats[0], ref.offset, state, 'relative');
    }
    case 'triggeringSeat':
      return ctx.triggeringSeat === null
        ? fail('UNBOUND_REF', 'Ref "triggeringSeat" is unbound.')
        : ok([ctx.triggeringSeat]);
    // Deliberately resolves for an ELIMINATED seat too, as long as the index was ever a seat:
    // §5.12 keeps `{kind:'seat', index}` working for forensics. Rejecting it as a move or target
    // destination is a separate check, not this one's job.
    case 'seat':
      return ref.index < 0 || ref.index >= N
        ? fail('INVALID_SEAT', `Player ref "seat: ${ref.index}": ${ref.index} is not a valid seat (${N} seats).`)
        : ok([ref.index]);
    // §4.1 names this as a trap: storage stays dense and full-length, so iterating 0..playerCount-1
    // (or `playerPools`' array indices) silently counts ousted seats in every "all players" check.
    // The ring is the only truth about who is still at the table.
    case 'all':
      return ok([...state.seatOrder], ref.quantifier ?? 'every');
  }
}
