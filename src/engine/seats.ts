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
 * That constraint is why `zoneKey`/`parseZoneKey`/`resolveZoneKeys`/`resolveCardRef` live here as
 * of step 17 rather than in `valueRef.ts`. §4.1's `owner`/`controller` make `SeatRef` hold a
 * `CardRef`, which holds a `ZoneRef`, which holds a `SeatRef`: the three are now ONE mutually
 * recursive cluster and cannot be split across two files at all. They sit at the base of the
 * dependency graph, and `valueRef.ts` re-exports the two public names so every existing call site
 * is unchanged. Nothing about their behaviour moved with them.
 *
 * Pure and never throws, like everything it was extracted from: a malformed ref resolves to a
 * typed failure instead of bricking the session.
 */

import {
  ACTIVE_PLAYER_POOL_ID,
  type CardInstance,
  type CardRef,
  type Id,
  type PlayState,
  type RejectReason,
  type SeatId,
  type SeatQuantifier,
  type SeatRef,
  type TriggerContext,
  type ZoneKey,
  type ZoneRef,
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
  quantifier: SeatQuantifier;
}

export type SeatResolution = SeatResolutionOk | ResolutionFail;

export function fail(reason: RejectReason, message: string): ResolutionFail {
  return { ok: false, reason, message };
}

function ok(seats: SeatId[], quantifier: SeatQuantifier = 'every'): SeatResolutionOk {
  return { ok: true, seats, quantifier };
}

/**
 * §5.12: a ref that RESOLVES TO an eliminated seat fails `SEAT_ELIMINATED`.
 *
 * Only three kinds of ref can produce one. `relative`, `next`, `previous` and `all` never can —
 * they only ever return members of `seatOrder` — and `{kind:'seat', index}` is the one documented
 * exception, kept readable for forensics. That leaves the refs that read a seat out of the state or
 * off a card: `active`, `triggeringSeat`, and §4.3's `owner`/`controller`.
 *
 * Note the deliberate asymmetry with `stepRing` below, which fails `INVALID_SEAT` when its BASE is
 * eliminated: §4.1 pins that case to `INVALID_SEAT` by name, because "the seat after an ousted
 * seat" is a broken question rather than an ousted answer.
 */
function live(seat: SeatId, state: PlayState, label: string): SeatResolution {
  return state.eliminated.includes(seat)
    ? fail('SEAT_ELIMINATED', `Player ref "${label}": seat ${seat} has been eliminated.`)
    : ok([seat]);
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
      return err ?? live(A, state, 'active');
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
        : live(ctx.triggeringSeat, state, 'triggeringSeat');
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
    // §4.1, §4.3. The three-way owner/controller/holder split is what makes "return it to its
    // OWNER's hand after its CONTROLLER changed" resolve to the right zone instance.
    case 'owner':
    case 'controller': {
      const res = resolveCardRef(ref.card, state, ctx);
      if (!res.ok) return res;
      const seat = ref.kind === 'owner' ? ownerOf(state, res.card.id) : controllerOf(state, res.card.id);
      if (seat === null) {
        // A card in a shared zone with no `owner` genuinely has no seat. Failing beats defaulting
        // to `active`, which would silently retarget the effect at whoever's turn it happens to be.
        return fail(
          'MISSING_REFERENT',
          `Player ref "${ref.kind}": card "${res.card.id}" has no ${ref.kind} (it is unowned or in a shared zone).`
        );
      }
      return live(seat, state, ref.kind);
    }
  }
}

// ---------------------------------------------------------------------------
// Owner / controller / holder — §4.3
// ---------------------------------------------------------------------------

/**
 * The seat of the zone instance currently holding `cardId`, or null for a shared zone (or a card
 * that is in no zone at all, which a mid-effect destroyed card briefly is).
 *
 * ponytail: linear scan of every zone, matching `effects.ts`'s `zoneKeyOf` for the same reason —
 * a `cardId -> ZoneKey` index would have to live inside `PlayState` to survive rewind, i.e. a
 * second source of truth to keep in sync. Reads `ZoneInstance.seat` rather than parsing the key,
 * so it costs nothing to be correct about zoneIds that contain `#`.
 */
function seatOfZoneHolding(state: PlayState, cardId: Id): SeatId | null {
  for (const key of Object.keys(state.zones)) {
    const inst = state.zones[key];
    if (inst.cardIds.includes(cardId)) return inst.seat;
  }
  return null;
}

/** §4.3 — set once at creation and never changed. Null for a card dealt into a shared zone. */
export function ownerOf(state: PlayState, cardId: Id): SeatId | null {
  return state.cards[cardId]?.owner ?? null;
}

/**
 * §4.3 — `card.controller ?? seatOfZoneHolding(card)`. The override wins over the holding zone,
 * which is the whole point: a contested unique changes hands without changing zones, and a stolen
 * creature is controlled from across the table while it sits on a shared battlefield.
 */
export function controllerOf(state: PlayState, cardId: Id): SeatId | null {
  const card = state.cards[cardId];
  if (!card) return null;
  return card.controller ?? seatOfZoneHolding(state, cardId);
}

// ---------------------------------------------------------------------------
// Zone keys and card refs — §4.2, §4.5. Here rather than in valueRef.ts because of the
// SeatRef -> CardRef -> ZoneRef -> SeatRef recursion; see the file header.
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

export function resolveZoneKeys(
  zone: ZoneRef,
  state: PlayState,
  ctx: TriggerContext
): { ok: true; keys: ZoneKey[]; quantifier: SeatQuantifier } | ResolutionFail {
  if (zone.seat === null) {
    return { ok: true, keys: [zoneKey(zone.zoneId, null)], quantifier: 'every' };
  }
  const seatRes = resolveSeat(zone.seat, state, ctx);
  if (!seatRes.ok) return seatRes;
  return { ok: true, keys: seatRes.seats.map((s) => zoneKey(zone.zoneId, s)), quantifier: seatRes.quantifier };
}

export type CardResolution = { ok: true; card: CardInstance } | ResolutionFail;

/** Convention: index 0 is the TOP of a zone (last index is the bottom). InsertPosition 'top'
 * means insert-at-front; effects.ts and rendering must follow this same convention. */
export function resolveCardRef(ref: CardRef, state: PlayState, ctx: TriggerContext): CardResolution {
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
    // §4.2, §4.3 — the host of the card whose rule is running, read off `ctx.sourceCardId` and
    // deliberately NOT off `triggeringCardId`: an equipment's rule fires on events about other
    // cards, and "the vampire I am equipping" must never collapse into "whatever set this off".
    //
    // Three distinct failures, none of them collapsed into one: no rule card at all (a global rule,
    // or a direct tester action), a rule card that is not attached to anything, and a host id that
    // no longer names a card. The last is what a dangling `attachedTo` would look like — the
    // destroy path detaches instead of leaving one, so reaching it means something else did not.
    case 'host': {
      if (ctx.sourceCardId === null) {
        return fail('UNBOUND_REF', 'Ref "host" is unbound: this rule has no source card.');
      }
      const self = state.cards[ctx.sourceCardId];
      if (!self) return fail('TARGET_GONE', `Card "${ctx.sourceCardId}" no longer exists.`);
      if (self.attachedTo === null) {
        return fail('MISSING_REFERENT', `Ref "host": card "${self.id}" is not attached to anything.`);
      }
      const host = state.cards[self.attachedTo];
      return host ? { ok: true, card: host } : fail('TARGET_GONE', `Card "${self.attachedTo}" no longer exists.`);
    }
    // §4.4 — bound only while a `matching` selector is testing this card, via the per-candidate
    // context copy `targets.ts` derives. Outside one there is nothing to mean, so it is an unbound
    // ref like any other rather than a silent fallback to `triggering`, which would make the
    // predicate test a different card than the one being filtered.
    case 'candidate': {
      const id = ctx.candidateCardId ?? null;
      if (id === null) {
        return fail('UNBOUND_REF', 'Ref "candidate" is unbound: it resolves only inside a "matching" selector.');
      }
      const card = state.cards[id];
      return card ? { ok: true, card } : fail('TARGET_GONE', `Card "${id}" no longer exists.`);
    }
    // v2 §4.2, §5.7 — bound only inside a replacement rule's `replaces.match`, to the target the
    // intercepted effect was about to touch. `replacement.ts` (step 27) is the only writer of that
    // binding; outside it there is nothing to mean, same discipline as `candidate` above. Final
    // behaviour, not a stub — UNBOUND_REF is genuinely correct everywhere this wave can reach it.
    case 'replacedTarget':
      return fail('UNBOUND_REF', 'Ref "replacedTarget" is unbound: it resolves only inside a replacement rule.');
  }
}
