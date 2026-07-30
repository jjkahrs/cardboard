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
import { effectiveIndex, effectiveTags, guardReentrant } from './modifiers';
// v4 §4.1 — `countMatching`/`sumIndex` fold over a selector, so a value now reaches the targeting
// language. Cyclic with `targets.ts` (which resolves this module's `count` refs) on the same terms
// as `modifiers.ts` above: function-body calls only.
import { resolveTargets } from './targets';
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
// v4 §4.1 — derived values (G1, G2)
// ---------------------------------------------------------------------------

const ARITH: Record<Extract<ValueRef, { kind: 'arith' }>['op'], (l: number, r: number) => number> = {
  add: (l, r) => l + r,
  subtract: (l, r) => l - r,
  multiply: (l, r) => l * r,
  min: Math.min,
  max: Math.max,
};

/** One side of an `arith`: exactly one value, and a number. */
function operand(
  ref: ValueRef,
  state: PlayState,
  ctx: TriggerContext,
  def: GameDefinition,
  depth: number,
  side: 'left' | 'right'
): { ok: true; value: number } | ResolutionFail {
  const res = resolveValueRef(ref, state, ctx, def, depth);
  if (!res.ok) return res;
  // A `pool` over `all` seats resolves to one value PER SEAT, and "HP of each player plus 1" has no
  // single answer. Same arity guard, same reason code, as `targets.ts`'s `resolveCount`.
  if (res.values.length !== 1) {
    return fail('INVALID_SEAT', `Arithmetic ${side} operand resolved to ${res.values.length} values; expected exactly one.`);
  }
  const value = res.values[0];
  // Never coerced. `modifiers.ts`'s `adjust` refuses a boolean the same way, and `quantified`'s
  // `sum` above refuses it for the same reason: a boolean has no defined sum or product.
  if (typeof value !== 'number') {
    return fail('TYPE_MISMATCH', `Arithmetic ${side} operand resolved to a boolean; arithmetic needs numbers.`);
  }
  return { ok: true, value };
}

/** The zero fold — an empty board counts 0 and totals 0, rather than refusing to resolve. */
const emptyFold = (): ValueResolution => ({ ok: true, values: [0], quantifier: 'every' });

function foldOverTargets(
  ref: Extract<ValueRef, { kind: 'countMatching' | 'sumIndex' }>,
  state: PlayState,
  ctx: TriggerContext,
  def: GameDefinition
): ValueResolution {
  const res = resolveTargets(ref.from, state, ctx, def);
  // NO_TARGETS is "none", not a failure: "damage equal to the number of creatures you control" has
  // to read 0 on an empty board. Every other failure (a deleted zone, an unbound ref) still
  // propagates — a dangling read must not come back as a plausible number (§5.9).
  if (!res.ok) return res.reason === 'NO_TARGETS' ? emptyFold() : res;
  // v4 §3 decision 4, the shape `modifiers.ts:194` already handles for a modifier's `prompt` scope:
  // a prompt selector resolves to CANDIDATES, never a selection, and a read never asks a question.
  // `matching` propagates the prompt variant outward, so this catches a prompt at any depth.
  if (res.kind !== 'cards') return emptyFold();

  if (ref.kind === 'countMatching') {
    return { ok: true, values: [res.cardIds.length], quantifier: 'every' };
  }

  let total = 0;
  for (const id of res.cardIds) {
    // ponytail: a card that does not declare the index contributes nothing rather than failing —
    // the selector defines the set, so "total power of your creatures" must survive a land sitting
    // in the same zone. An indexId naming nothing at all is caught at author/import time by
    // `schema.ts`'s referential pass, which is where a typo belongs.
    if (state.cards[id]?.indexValues[ref.indexId] === undefined) continue;
    // §5.4 read site — the whole point of G2. `card.indexValues` would be blind to every modifier.
    const value = effectiveIndex(state, def, id, ref.indexId);
    if (typeof value !== 'number') {
      return fail('TYPE_MISMATCH', `Ref "sumIndex": index "${ref.indexId}" on card "${id}" is a boolean; a total needs numbers.`);
    }
    total += value;
  }
  return { ok: true, values: [total], quantifier: 'every' };
}

// ---------------------------------------------------------------------------
// resolveValueRef — §4.2, §5.9 rows 3b/11/12/13
// ---------------------------------------------------------------------------

export function resolveValueRef(
  ref: ValueRef,
  state: PlayState,
  ctx: TriggerContext,
  def: GameDefinition,
  /** v4 §4.1 — `arith` nesting only. Every caller outside this module starts a fresh expression. */
  depth = 0
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

    // v4 §4.1 (G1). Depth is counted here rather than in the schema because the ceiling is the
    // definition's own `maxDepth` (§5.5's "the designer needs a knob, not a bug report"), and a
    // depth-256 expression is a hand-edited file, not something the picker can build.
    case 'arith': {
      if (depth >= def.limits.maxDepth) {
        return fail('RULE_LOOP', `Arithmetic value nested deeper than limit ${def.limits.maxDepth}.`);
      }
      const left = operand(ref.left, state, ctx, def, depth + 1, 'left');
      if (!left.ok) return left;
      const right = operand(ref.right, state, ctx, def, depth + 1, 'right');
      if (!right.ok) return right;
      return { ok: true, values: [ARITH[ref.op](left.value, right.value)], quantifier: 'every' };
    }

    // v4 §4.1 (G2). Both folds close the `valueRef -> resolveTargets -> evalCriteria -> resolveValueRef`
    // cycle on ordinary authored input ("creatures get +1/+1 while the total power of your creatures
    // is 5 or more"), so both go through §5.4's shared re-entrancy guard: a node re-entered while it
    // is still resolving answers zero instead of recursing, and that answer is never memoized.
    case 'countMatching':
    case 'sumIndex':
      return guardReentrant(ref, emptyFold(), () => foldOverTargets(ref, state, ctx, def));
  }
}
