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
  type GameDefinition,
  type Id,
  type PlayState,
  type PointPool,
  type TriggerContext,
  type ValueRef,
} from './types';
import { fail, resolveCardRef, resolveSeat, resolveZoneKeys } from './seats';
import type { ResolutionFail } from './seats';

// `resolveSeat` moved to seats.ts with the ring (§3.5); `zoneKey`/`parseZoneKey`/`resolveCardRef`
// followed it in step 17, because §4.1's `owner`/`controller` make SeatRef, CardRef and ZoneRef one
// mutually recursive cluster that cannot be split across two modules. Re-exported here so every
// call site that has always imported them from this module is untouched.
export { resolveSeat, zoneKey, parseZoneKey, resolveCardRef } from './seats';
export type { CardResolution, ResolutionFail, SeatResolution, SeatResolutionOk } from './seats';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ValueResolutionOk {
  ok: true;
  /** Ascending seat order when the ref resolved to multiple seats (`all`); length 1 otherwise. */
  values: (number | boolean)[];
  /**
   * Never `'sum'`: `quantified()` collapses that to a single value before it can leave this module,
   * so no consumer has to know the third quantifier exists. Deliberately NARROWER than
   * `SeatResolutionOk.quantifier`, which forces the compiler to point at any future return path
   * that forgets to collapse.
   */
  quantifier: 'every' | 'some';
}

export type ValueResolution = ValueResolutionOk | ResolutionFail;

/**
 * §4.1's `sum`. Unlike `every`/`some` this is not a fold to a boolean — it collapses the per-seat
 * values into ONE arithmetic total, which is exactly why the ref is then usable anywhere a single
 * number is (effect amounts, comparison operands) and nowhere else.
 *
 * A boolean operand has no total, so it evaluates `TYPE_MISMATCH` here. `schema.ts` rejects the
 * same shape at author time; neither check substitutes for the other, because imported JSON never
 * passed through the editor and an authored definition never reaches this line.
 */
function quantified(
  values: (number | boolean)[],
  quantifier: 'every' | 'some' | 'sum',
  label: string
): ValueResolution {
  if (quantifier !== 'sum') return { ok: true, values, quantifier };
  if (values.some((v) => typeof v !== 'number')) {
    return fail('TYPE_MISMATCH', `${label}: the "sum" quantifier needs numbers; this resolved to a boolean.`);
  }
  return { ok: true, values: [(values as number[]).reduce((a, b) => a + b, 0)], quantifier: 'every' };
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
      // `seatRes.seats` is the RING, never `perSeat`'s indices — an eliminated seat's stale value is
      // still sitting in the dense array and would otherwise be summed into every vote tally (§4.1).
      return quantified(values, seatRes.quantifier, `Pool "${ref.poolId}"`);
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
      return quantified(values, zr.quantifier, `Zone "${ref.zone.zoneId}"`);
    }

    // §3.5 — the live ring's length. `playerCount` survives only as the initial seat count and the
    // bound on a valid SeatId, so it is the wrong number to read the moment anyone is ousted.
    case 'activeSeatCount':
      return { ok: true, values: [state.seatOrder.length], quantifier: 'every' };
  }
}
