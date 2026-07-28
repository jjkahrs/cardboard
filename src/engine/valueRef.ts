/**
 * Seat and value reference resolution. TECHNICAL_DESIGN.md §4.2, §5.7, §5.9 rows 3b/11/12/13.
 *
 * Every function here is pure and never throws: a malformed ref (hand-edited JSON, a dangling
 * id) resolves to a typed failure instead of bricking the session. Callers (criteria.ts,
 * effects.ts, targets.ts) decide what a failure means for them.
 */

import {
  ACTIVE_PLAYER_POOL,
  ACTIVE_PLAYER_POOL_ID,
  type CardRef,
  type GameDefinition,
  type Id,
  type PlayState,
  type PointPool,
  type RejectReason,
  type SeatRef,
  type TriggerContext,
  type ValueRef,
  type ZoneKey,
  type ZoneRef,
} from './types';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ResolutionFail {
  ok: false;
  reason: RejectReason;
  /** Human-readable, suitable for a log line. Does not itself carry a LogLevel. */
  message: string;
}

export interface SeatResolutionOk {
  ok: true;
  /** Ascending seat order. Length 1 for every SeatRef except `all`. */
  seats: number[];
  /** Only meaningful when `seats.length > 1` (the `all` case). Defaults to 'every' — §5.7. */
  quantifier: 'every' | 'some';
}

export type SeatResolution = SeatResolutionOk | ResolutionFail;

export interface ValueResolutionOk {
  ok: true;
  /** Ascending seat order when the ref resolved to multiple seats (`all`); length 1 otherwise. */
  values: (number | boolean)[];
  quantifier: 'every' | 'some';
}

export type ValueResolution = ValueResolutionOk | ResolutionFail;

function fail(reason: RejectReason, message: string): ResolutionFail {
  return { ok: false, reason, message };
}

// ---------------------------------------------------------------------------
// zoneKey / parseZoneKey — §4.5
// ---------------------------------------------------------------------------

export function zoneKey(zoneId: Id, seat: number | null): ZoneKey {
  return seat === null ? zoneId : `${zoneId}#${seat}`;
}

/**
 * Splits on a trailing `#<digits>`. A zoneId that itself ends in that exact shape (e.g. `"z#3"`)
 * and is used seatless is genuinely ambiguous with a seated key for the shorter zoneId `"z"` —
 * both produce the string `"z#3"`. Authored zoneIds should avoid ending in `#<digits>`; any other
 * zoneId, including one containing `#` elsewhere (`"z#one"`), round-trips correctly.
 */
export function parseZoneKey(key: ZoneKey): { zoneId: Id; seat: number | null } {
  const match = /^(.*)#(\d+)$/.exec(key);
  if (match) {
    return { zoneId: match[1], seat: Number(match[2]) };
  }
  return { zoneId: key, seat: null };
}

// ---------------------------------------------------------------------------
// resolveSeat — §5.7
// ---------------------------------------------------------------------------

function ok(seats: number[], quantifier: 'every' | 'some' = 'every'): SeatResolutionOk {
  return { ok: true, seats, quantifier };
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
    case 'next': {
      const err = requireActiveInRange('next');
      return err ?? ok([(A + 1) % N]);
    }
    case 'previous': {
      const err = requireActiveInRange('previous');
      return err ?? ok([((A - 1) % N + N) % N]);
    }
    case 'triggeringSeat':
      return ctx.triggeringSeat === null
        ? fail('UNBOUND_REF', 'Ref "triggeringSeat" is unbound.')
        : ok([ctx.triggeringSeat]);
    case 'seat':
      return ref.index < 0 || ref.index >= N
        ? fail('INVALID_SEAT', `Player ref "seat: ${ref.index}": ${ref.index} is not a valid seat (${N} seats).`)
        : ok([ref.index]);
    case 'all':
      return ok(
        Array.from({ length: N }, (_, i) => i),
        ref.quantifier ?? 'every'
      );
  }
}

// ---------------------------------------------------------------------------
// ZoneRef -> ZoneKey[] — shared by zoneCount and zoneTop
// ---------------------------------------------------------------------------

function resolveZoneKeys(
  zone: ZoneRef,
  state: PlayState,
  ctx: TriggerContext
): { ok: true; keys: ZoneKey[]; quantifier: 'every' | 'some' } | ResolutionFail {
  if (zone.seat === null) {
    return { ok: true, keys: [zoneKey(zone.zoneId, null)], quantifier: 'every' };
  }
  const seatRes = resolveSeat(zone.seat, state, ctx);
  if (!seatRes.ok) return seatRes;
  return { ok: true, keys: seatRes.seats.map((s) => zoneKey(zone.zoneId, s)), quantifier: seatRes.quantifier };
}

// ---------------------------------------------------------------------------
// CardRef -> CardInstance — §4.2, §5.9 row 13
// ---------------------------------------------------------------------------

type CardResolution = { ok: true; card: PlayState['cards'][string] } | ResolutionFail;

/** Convention: index 0 is the TOP of a zone (last index is the bottom). InsertPosition 'top'
 * means insert-at-front; effects.ts and rendering must follow this same convention. */
function resolveCardRef(ref: CardRef, state: PlayState, ctx: TriggerContext): CardResolution {
  switch (ref.kind) {
    case 'triggering': {
      if (ctx.triggeringCardId === null) {
        return fail('UNBOUND_REF', 'Ref "triggeringCard" is unbound.');
      }
      const card = state.cards[ctx.triggeringCardId];
      return card ? { ok: true, card } : fail('TARGET_GONE', `Card "${ctx.triggeringCardId}" no longer exists.`);
    }
    case 'zoneTop': {
      const zr = resolveZoneKeys(ref.zone, state, ctx);
      if (!zr.ok) return zr;
      if (zr.keys.length !== 1) {
        return fail(
          'INVALID_SEAT',
          `Zone ref for "zoneTop" resolved to ${zr.keys.length} seats; expected exactly one.`
        );
      }
      const key = zr.keys[0];
      const zoneInst = state.zones[key];
      if (!zoneInst) return fail('MISSING_REFERENT', `Zone "${key}" does not exist in this definition.`);
      const topId = zoneInst.cardIds[0];
      if (topId === undefined) return fail('TARGET_GONE', `Zone "${key}" is empty; no top card.`);
      const card = state.cards[topId];
      return card ? { ok: true, card } : fail('TARGET_GONE', `Card "${topId}" no longer exists.`);
    }
    case 'promptAnswer': {
      const id = ctx.promptAnswers[ref.promptId]?.[ref.ordinal];
      if (id === undefined) {
        return fail('MISSING_REFERENT', `Prompt answer "${ref.promptId}"[${ref.ordinal}] is not available.`);
      }
      const card = state.cards[id];
      return card ? { ok: true, card } : fail('TARGET_GONE', `Card "${id}" no longer exists.`);
    }
    case 'instance': {
      const card = state.cards[ref.id];
      return card ? { ok: true, card } : fail('TARGET_GONE', `Card "${ref.id}" no longer exists.`);
    }
  }
}

// ---------------------------------------------------------------------------
// PointPool lookup — the reserved activePlayer pool has a runtime value but no authored
// definition (§4.1: "the engine creates it if absent"). Every pool lookup in this module and
// effects.ts's changePool must fall back to the implicit definition, or a criterion/effect on
// `activePlayer` fails MISSING_REFERENT for every designer who didn't hand-author a colliding
// pool.
// ---------------------------------------------------------------------------

export function resolvePoolDef(def: GameDefinition, poolId: Id): PointPool | undefined {
  const authored = def.pools.find((p) => p.id === poolId);
  if (authored) return authored; // an authored pool always wins, even for the reserved id
  return poolId === ACTIVE_PLAYER_POOL_ID ? ACTIVE_PLAYER_POOL : undefined;
}

// ---------------------------------------------------------------------------
// resolveValueRef — §4.2, §5.9 rows 3b/11/12/13
// ---------------------------------------------------------------------------

export function resolveValueRef(
  ref: ValueRef,
  state: PlayState,
  ctx: TriggerContext,
  def: GameDefinition
): ValueResolution {
  switch (ref.kind) {
    case 'literal':
      return { ok: true, values: [ref.value], quantifier: 'every' };

    case 'pool': {
      const poolDef = resolvePoolDef(def, ref.poolId);
      if (!poolDef) {
        return fail('MISSING_REFERENT', `Pool "${ref.poolId}" does not exist in this definition.`);
      }
      if (ref.seat === null) {
        const value = state.pools[ref.poolId];
        if (value === undefined) {
          return fail('MISSING_REFERENT', `Pool "${ref.poolId}" does not exist in this definition.`);
        }
        return { ok: true, values: [value], quantifier: 'every' };
      }
      const seatRes = resolveSeat(ref.seat, state, ctx);
      if (!seatRes.ok) return seatRes;
      const perSeat = state.playerPools[ref.poolId];
      if (!perSeat) {
        return fail('MISSING_REFERENT', `Pool "${ref.poolId}" does not exist in this definition.`);
      }
      const values = seatRes.seats.map((s) => perSeat[s]);
      if (values.some((v) => v === undefined)) {
        return fail('MISSING_REFERENT', `Pool "${ref.poolId}" is missing a value for one or more seats.`);
      }
      return { ok: true, values, quantifier: seatRes.quantifier };
    }

    case 'cardIndex': {
      const cardRes = resolveCardRef(ref.card, state, ctx);
      if (!cardRes.ok) return cardRes;
      const value = cardRes.card.indexValues[ref.indexId];
      if (value === undefined) {
        return fail('MISSING_REFERENT', `Card index "${ref.indexId}" does not exist on card "${cardRes.card.id}".`);
      }
      return { ok: true, values: [value], quantifier: 'every' };
    }

    case 'zoneCount': {
      const zoneDef = def.zones.find((z) => z.id === ref.zone.zoneId);
      if (!zoneDef) {
        return fail('MISSING_REFERENT', `Zone "${ref.zone.zoneId}" does not exist in this definition.`);
      }
      const zr = resolveZoneKeys(ref.zone, state, ctx);
      if (!zr.ok) return zr;
      const values: number[] = [];
      for (const key of zr.keys) {
        const zoneInst = state.zones[key];
        // Face-down cards count too — zone visibility affects rendering only, never criteria (§5.7).
        if (!zoneInst) {
          return fail('MISSING_REFERENT', `Zone "${key}" does not exist in this definition.`);
        }
        values.push(zoneInst.cardIds.length);
      }
      return { ok: true, values, quantifier: zr.quantifier };
    }
  }
}
