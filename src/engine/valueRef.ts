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
// Cyclic with `modifiers.ts` by design (§5.4): a computed value is defined in terms of the refs it
// reads. Only ever called from inside a function body, so module evaluation order is irrelevant.
import { effectiveIndex, effectiveTags } from './modifiers';
// v2 §4.2, §4.8, step 23 — `pending.ts` owns ActionRef/ActionSelector resolution the way `seats.ts`
// owns SeatRef/CardRef. Cyclic with `criteria.ts`/`valueRef.ts` by design (`pending.ts`'s
// `allOnStack` needs `evalCriteria`, which needs `resolveValueRef` from here) — function-body calls
// only, same discipline as the `modifiers.ts` cycle immediately above.
import { resolveActionField } from './pending';

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
      // The BASE is what proves the index exists on this instance — `effectiveIndex` has no failure
      // channel and answers 0 for an index nothing declares, which would turn a dangling ref into a
      // silently plausible number (§5.4).
      if (cardRes.card.indexValues[ref.indexId] === undefined) {
        return fail('MISSING_REFERENT', `Card index "${ref.indexId}" does not exist on card "${cardRes.card.id}".`);
      }
      // §5.4 read site: criteria compare what the card READS AS, modifiers included. `criteria.ts`
      // inherits this through its two `resolveValueRef` calls and needs no change of its own.
      const value = effectiveIndex(state, def, cardRes.card.id, ref.indexId);
      return { ok: true, values: [value], quantifier: 'every' };
    }

    // §4.2, §4.3. A BOOLEAN, so it is usable on either side of an `=` against a boolean literal and
    // nowhere arithmetic. Read through `effectiveTags` for the same reason `cardIndex` reads through
    // `effectiveIndex`: `template.tags` is the creation-time SEED, and a criterion that consulted it
    // would answer for the card's whole print run rather than for this instance (§5.4 read site).
    //
    // An absent tag is `false`, not MISSING_REFERENT — unlike an index, a tag has no declaration to
    // dangle from. `taggedInZone` already treats "not tagged" the same way, and "does this card have
    // the tag" would otherwise be unaskable of the cards that don't.
    case 'cardTag': {
      const cardRes = resolveCardRef(ref.card, state, ctx);
      if (!cardRes.ok) return cardRes;
      return {
        ok: true,
        values: [effectiveTags(state, def, cardRes.card.id).includes(ref.tag)],
        quantifier: 'every',
      };
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

    // v2 §4.2, §5.7 — bound only inside a replacement rule's `replaces.match`, to the AMOUNT the
    // intercepted effect was about to apply. `replacement.ts` (step 27) is the only writer of that
    // binding. Final behaviour, not a stub — UNBOUND_REF is genuinely correct everywhere this wave
    // can reach it, same discipline as `resolveCardRef`'s `replacedTarget` in seats.ts.
    case 'replacedAmount':
      return fail('UNBOUND_REF', 'Ref "replacedAmount" is unbound: it resolves only inside a replacement rule.');

    // v2 §4.2, §4.8 — reads a characteristic off a `PendingAction`. `pending.ts` owns ActionRef
    // resolution the way `seats.ts` owns SeatRef/CardRef; this is a thin ActionRef resolve + field
    // read, mirroring `cardTag`'s shape immediately above.
    case 'actionField':
      return resolveActionField(ref, state, ctx);

    // v2 §4.2, §8 step 28 — the `chooseNumber` design-slip closure. `chooseNumber`'s answer is
    // written into `ctx.promptAnswers[effect.key]` by `dispatch.ts`'s `runEffect` the moment
    // `answerNumber` resolves it (the SAME `ctx.promptAnswers` mechanism `targets.ts`'s
    // `CHOSEN_PROMPT_KEY` already uses for card-target prompts, just keyed by the AUTHORED `key`
    // instead of a derived promptId, so it survives past the one effect that raised it and is
    // readable by any later effect in the same rule). Same discipline as `replacedAmount`:
    // UNBOUND_REF, not 0, when nothing has answered it — a dangling read must not read as a
    // plausible number.
    case 'promptNumber': {
      const answer = ctx.promptAnswers[ref.key]?.[0];
      if (answer === undefined) {
        return fail('UNBOUND_REF', `Ref "promptNumber" (key "${ref.key}") is unbound: no chooseNumber has answered under that key yet.`);
      }
      const value = Number(answer);
      if (!Number.isFinite(value)) {
        return fail('TYPE_MISMATCH', `Ref "promptNumber" (key "${ref.key}"): stored answer "${answer}" is not a number.`);
      }
      return { ok: true, values: [value], quantifier: 'every' };
    }
  }
}
