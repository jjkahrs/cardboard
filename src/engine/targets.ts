/**
 * Target selector resolution. TECHNICAL_DESIGN.md §4.7, §5.3, §5.4, §5.9 rows 2/2b/8/13.
 *
 * Pure and never throws, like valueRef.ts: a malformed selector resolves to a typed failure.
 *
 * Two invariants from §5.3 the callers depend on:
 *  - The selector resolves **once** into a frozen, ordered id list. Nothing here re-reads the board
 *    as an effect mutates it.
 *  - **Shortfall vs constraint asymmetry.** Asking for the top 2 of a 1-card zone is a *partial
 *    success* — `{ requested: 2, actual: 1 }`, caller logs `[WARN] ... only 1 available`. A missing
 *    zone, an unbound ref or a destroyed card is a *full failure*. Do not collapse the two.
 */

import type {
  GameDefinition,
  Id,
  PlayState,
  TargetSelector,
  TriggerContext,
  ZoneKey,
  ZoneRef,
} from './types';
import { type ResolutionFail, resolveCardRef, resolveSeat, resolveValueRef, zoneKey } from './valueRef';
// Cyclic with `modifiers.ts` (it calls `resolveTargets` for a modifier's scope) by design (§5.4).
// Function-body calls only, so module evaluation order never matters.
import { effectiveTags } from './modifiers';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** A resolved selection. `requested > actual` is the §5.3 quantity shortfall — still a success. */
export interface TargetsOk {
  ok: true;
  kind: 'cards';
  /** Frozen, in zone order. */
  cardIds: readonly Id[];
  /** What the selector asked for. Equals `actual` for the selectors that carry no count. */
  requested: number;
  actual: number;
}

/**
 * A `prompt` selector resolves to the **legal candidate set**, never to a final selection —
 * dispatch.ts raises `Interaction{kind:'chooseCards'}` from this and the tester picks. A distinct
 * variant rather than a flag on TargetsOk so an effect can never mistake candidates for chosen cards.
 */
export interface TargetsPrompt {
  ok: true;
  kind: 'prompt';
  /** Frozen, in zone order — the set the UI highlights. */
  candidates: readonly Id[];
  min: number;
  max: number;
  promptText: string;
}

export type TargetResult = TargetsOk | TargetsPrompt | ResolutionFail;

function fail(reason: ResolutionFail['reason'], message: string): ResolutionFail {
  return { ok: false, reason, message };
}

/**
 * Reserved `TriggerContext.promptAnswers` key holding the answer to the prompt of the effect being
 * applied RIGHT NOW. dispatch.ts sets it when it re-enters an answered prompting effect; a real
 * promptId is `${logSeq}:${ruleId}:${effectIndex}` and so can never collide with it.
 *
 * This exists because `applyEffect(effect, ec)` knows neither the ruleId nor the effect index, so it
 * cannot compute the promptId — but it does call `resolveTargets`, which is where the answer has to
 * turn back into a card list. Effects stay unaware that a prompt happened at all.
 */
export const CHOSEN_PROMPT_KEY = '@chosen';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** ZoneRef -> the ZoneInstance keys it names, in ascending seat order. */
function zoneKeysOf(
  zone: ZoneRef,
  state: PlayState,
  ctx: TriggerContext
): { ok: true; keys: ZoneKey[] } | ResolutionFail {
  if (zone.seat === null) return { ok: true, keys: [zoneKey(zone.zoneId, null)] };
  const seats = resolveSeat(zone.seat, state, ctx);
  if (!seats.ok) return seats;
  return { ok: true, keys: seats.seats.map((s) => zoneKey(zone.zoneId, s)) };
}

/**
 * Every card id in the named zones, seat order then zone order. Zone `visibility` is a RENDERING
 * concern (§5.7) — face-down cards are targetable and are not filtered here.
 */
function idsInZones(
  zone: ZoneRef,
  state: PlayState,
  ctx: TriggerContext
): { ok: true; ids: Id[] } | ResolutionFail {
  const zk = zoneKeysOf(zone, state, ctx);
  if (!zk.ok) return zk;
  const ids: Id[] = [];
  for (const key of zk.keys) {
    const inst = state.zones[key];
    if (!inst) return fail('MISSING_REFERENT', `Zone "${key}" does not exist in this definition.`);
    ids.push(...inst.cardIds);
  }
  return { ok: true, ids };
}

/** `count` is a ValueRef resolved lazily, right now (§5.3). Negatives and fractions floor to a count. */
function resolveCount(
  sel: Extract<TargetSelector, { count: unknown }>,
  state: PlayState,
  ctx: TriggerContext,
  def: GameDefinition
): { ok: true; count: number } | ResolutionFail {
  const res = resolveValueRef(sel.count, state, ctx, def);
  if (!res.ok) return res;
  if (res.values.length !== 1) {
    return fail(
      'INVALID_SEAT',
      `Selector "${sel.kind}": count resolved to ${res.values.length} values; expected exactly one.`
    );
  }
  const value = res.values[0];
  if (typeof value !== 'number') {
    return fail('TYPE_MISMATCH', `Selector "${sel.kind}": count resolved to a boolean; expected an integer.`);
  }
  return { ok: true, count: Math.max(0, Math.trunc(value)) };
}

/** The one place a candidate list becomes a result: existence check, zero check, freeze. */
function selection(
  ids: Id[],
  requested: number,
  kind: TargetSelector['kind'],
  state: PlayState
): TargetsOk | ResolutionFail {
  for (const id of ids) {
    if (!state.cards[id]) return fail('TARGET_GONE', `Card "${id}" no longer exists.`);
  }
  // §5.9 row 2 — the caller rejects the effect and continues. Distinct from a shortfall, which
  // still has at least one card and comes back as a success.
  if (ids.length === 0) return fail('NO_TARGETS', `Selector "${kind}" matched 0 cards.`);
  return { ok: true, kind: 'cards', cardIds: Object.freeze(ids), requested, actual: ids.length };
}

// ---------------------------------------------------------------------------
// resolveTargets — §5.3, §5.4
// ---------------------------------------------------------------------------

export function resolveTargets(
  sel: TargetSelector,
  state: PlayState,
  ctx: TriggerContext,
  def: GameDefinition
): TargetResult {
  switch (sel.kind) {
    case 'triggeringCard': {
      // Bound only under CARD_BINDING_EVENTS (types.ts). §5.9 row 13.
      if (ctx.triggeringCardId === null) return fail('UNBOUND_REF', 'Ref "triggeringCard" is unbound.');
      return selection([ctx.triggeringCardId], 1, sel.kind, state);
    }

    case 'topOfZone':
    case 'bottomOfZone': {
      const n = resolveCount(sel, state, ctx, def);
      if (!n.ok) return n;
      const zk = zoneKeysOf(sel.zone, state, ctx);
      if (!zk.ok) return zk;
      // "top N of every seat's Deck" has no single answer — same guard valueRef.ts puts on zoneTop.
      if (zk.keys.length !== 1) {
        return fail(
          'INVALID_SEAT',
          `Zone ref for "${sel.kind}" resolved to ${zk.keys.length} seats; expected exactly one.`
        );
      }
      const inst = state.zones[zk.keys[0]];
      if (!inst) return fail('MISSING_REFERENT', `Zone "${zk.keys[0]}" does not exist in this definition.`);
      // Index 0 is the TOP — the convention valueRef.ts's resolveCardRef('zoneTop') already fixed.
      const ids =
        sel.kind === 'topOfZone'
          ? inst.cardIds.slice(0, n.count)
          : inst.cardIds.slice(Math.max(0, inst.cardIds.length - n.count));
      return selection(ids, n.count, sel.kind, state);
    }

    case 'allInZone': {
      const z = idsInZones(sel.zone, state, ctx);
      if (!z.ok) return z;
      return selection(z.ids, z.ids.length, sel.kind, state);
    }

    case 'taggedInZone': {
      const z = idsInZones(sel.zone, state, ctx);
      if (!z.ok) return z;
      const ids: Id[] = [];
      for (const id of z.ids) {
        const card = state.cards[id];
        if (!card) return fail('TARGET_GONE', `Card "${id}" no longer exists.`);
        const template = def.templates.find((t) => t.id === card.templateId);
        if (!template) {
          return fail('MISSING_REFERENT', `Card template "${card.templateId}" does not exist in this definition.`);
        }
        // §5.4 read site. Tags are PER-INSTANCE since §4.3 — seeded from the template at creation
        // and mutable thereafter — so reading `template.tags` here would miss every tag an effect
        // has added or removed. The template lookup above stays: a dangling templateId is still a
        // MISSING_REFERENT, which `effectiveTags` has no channel to report.
        if (effectiveTags(state, def, id).includes(sel.tag)) ids.push(id);
      }
      return selection(ids, ids.length, sel.kind, state);
    }

    // §4.4 — the attachment relation, read in both directions. Neither arm consults a zone: an
    // attachment is a REFERENCE, so a host sitting in a graveyard still has its attachments and an
    // attached card in some other zone entirely still resolves its host.
    case 'attachedTo': {
      const hostRes = resolveCardRef(sel.host, state, ctx);
      if (!hostRes.ok) return hostRes;
      // Sorted, not in `Object.keys` order: a rewind re-adds a deleted card at the END of the key
      // order, so insertion order is not stable across the one operation the whole log exists for.
      // Lexicographic on the id is (`c10` before `c2`), which is what determinism needs here.
      const ids = Object.keys(state.cards)
        .filter((id) => state.cards[id].attachedTo === hostRes.card.id)
        .sort();
      return selection(ids, ids.length, sel.kind, state);
    }

    case 'hostOf': {
      const cardRes = resolveCardRef(sel.card, state, ctx);
      if (!cardRes.ok) return cardRes;
      const hostId = cardRes.card.attachedTo;
      // Not attached is NO_TARGETS via `selection` below — the same "matched 0 cards" a
      // `taggedInZone` over an untagged zone produces, and a rule-legal refusal rather than an error.
      return selection(hostId === null ? [] : [hostId], 1, sel.kind, state);
    }

    case 'prompt': {
      // Already answered: the selection IS the answer, not the candidate set.
      const answered = ctx.promptAnswers[CHOSEN_PROMPT_KEY];
      if (answered !== undefined) return selection([...answered], answered.length, sel.kind, state);

      const inner = resolveTargets(sel.from, state, ctx, def);
      if (!inner.ok) return inner;
      if (inner.kind !== 'cards') {
        return fail('TYPE_MISMATCH', 'A "prompt" selector cannot wrap another "prompt".');
      }
      const n = resolveCount(sel, state, ctx, def);
      if (!n.ok) return n;
      // §5.4 gives one `count`, and §5.9 row 8c's log reads "expected exactly 1" — so count is both
      // min and max. A range would need a second ValueRef the schema does not have.
      return {
        ok: true,
        kind: 'prompt',
        candidates: inner.cardIds,
        min: n.count,
        max: n.count,
        promptText: sel.promptText,
      };
    }
  }
}
