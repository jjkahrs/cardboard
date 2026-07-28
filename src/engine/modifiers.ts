/**
 * Computed card values. TECHNICAL_DESIGN_V2.md §5.4, §4.3, §4.5.
 *
 * **Derivation, not materialization.** A modifier is never written into `PlayState`. It is
 * discovered, on every read, by scanning `def.ruleSets` for rules with `modifier !== null` whose
 * source card is currently in an `activeZones` zone and whose `condition` passes. §5.4 is explicit
 * about why: a materialized design needs a teardown path for every route a source can leave play
 * by — destroyed, moved, detached, controller changed, seat eliminated — and every route someone
 * forgets leaves a permanent phantom buff that no test naturally catches.
 *
 * Pure and never throws, like the rest of the engine. A modifier whose scope, condition or amount
 * fails to resolve is **skipped**, not surfaced: `effectiveIndex` has no failure channel (§5.4's
 * signature returns a plain value) and a broken rule must not brick a render.
 */

import type {
  CardIndex,
  GameDefinition,
  Id,
  PlayState,
  RuleSet,
  TriggerContext,
  ZoneKey,
} from './types';
import { clampValue } from './effects';
import { evalCriteriaBool } from './criteria';
import { resolveTargets } from './targets';
import { parseZoneKey, resolveValueRef } from './valueRef';

/** The non-null branch of `RuleSet.modifier` — §4.5. */
type ModifierSpec = NonNullable<RuleSet['modifier']>;

/** One live modifier: a (source instance, RuleSet) pair whose gate has already been checked. */
export interface ActiveModifier {
  /** The card instance carrying the rule. Half of the §5.4 creation-order key. */
  sourceCardId: Id;
  ruleId: Id;
  spec: ModifierSpec;
  /** Cards the `scope` selector resolved to, this read. */
  scope: readonly Id[];
  /** The context `scope`/`condition` were evaluated under; `amount` is resolved under it too. */
  ctx: TriggerContext;
}

// ---------------------------------------------------------------------------
// Memoization — OUTSIDE the patch stream (§5.4)
// ---------------------------------------------------------------------------

/**
 * immer returns a fresh state object per `produce`, so keying on state identity invalidates the
 * cache for free with no version counter. A cache *inside* `PlayState` would be rewindable,
 * patch-visible, and a source of spurious log churn — §5.4 forbids it explicitly.
 */
const modifierCache = new WeakMap<PlayState, ActiveModifier[]>();
const indexCache = new WeakMap<PlayState, Map<string, number | boolean>>();

// ---------------------------------------------------------------------------
// collectModifiers — §5.4
// ---------------------------------------------------------------------------

/**
 * ponytail: linear scan of every zone, matching `effects.ts`'s `zoneKeyOf`. A `cardId -> ZoneKey`
 * index would have to live in `PlayState` to survive rewind, i.e. a second source of truth. At
 * playtest sizes the scan is free.
 */
function zoneKeyOf(state: PlayState, cardId: Id): ZoneKey | null {
  for (const key of Object.keys(state.zones)) {
    if (state.zones[key].cardIds.includes(cardId)) return key;
  }
  return null;
}

/**
 * §5.4 "creation order": the source card instance's numeric id suffix ascending, then RuleSet id.
 *
 * Instance ids are `c${state.nextSeq++}` (§4.3), a counter that is itself part of the rewound
 * domain and is written verbatim into an export — so this ordering is identical across
 * export/import and across two replays of the same seed. Array position in `def.ruleSets` is
 * deliberately NOT part of the key: authoring order must not change a result (MTG7, §9.4(b)).
 */
function seqOf(cardId: Id): number {
  const digits = /(\d+)$/.exec(cardId);
  // A hand-written id with no numeric suffix sorts before every generated one, then by id string
  // via the RuleSet tiebreak below plus the stable source-id compare — still total, still stable.
  return digits ? Number(digits[1]) : -1;
}

function compareCreation(a: ActiveModifier, b: ActiveModifier): number {
  const bySeq = seqOf(a.sourceCardId) - seqOf(b.sourceCardId);
  if (bySeq !== 0) return bySeq;
  // Same suffix from two different id shapes: fall back to the raw id so the order stays total.
  if (a.sourceCardId !== b.sourceCardId) return a.sourceCardId < b.sourceCardId ? -1 : 1;
  return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
}

/**
 * Every modifier currently applying anywhere on the board, in §5.4 creation order.
 *
 * A modifier's source is a card *instance* whose template lists the rule (`CardTemplate.ruleSetIds`,
 * §4.4). Two copies of the same lord are two modifiers. A rule in `globalRuleSetIds` has no source
 * instance and therefore no zone to be active in, so it contributes nothing — see the report note.
 */
export function collectModifiers(state: PlayState, def: GameDefinition): ActiveModifier[] {
  const cached = modifierCache.get(state);
  if (cached) return cached;

  const out: ActiveModifier[] = [];
  for (const cardId of Object.keys(state.cards)) {
    const card = state.cards[cardId];
    const template = def.templates.find((t) => t.id === card.templateId);
    if (!template) continue; // MISSING_REFERENT is the dispatcher's to report, not a render's.

    const zk = zoneKeyOf(state, cardId);
    if (zk === null) continue; // Not on the board at all; nothing to be a source of.
    const zoneId = state.zones[zk].zoneId;

    for (const ruleId of template.ruleSetIds) {
      const rule = def.ruleSets.find((r) => r.id === ruleId);
      if (!rule || rule.modifier === null) continue;
      const spec = rule.modifier;

      // §4.5: empty `activeZones` => applies wherever the source is.
      if (spec.activeZones.length > 0 && !spec.activeZones.includes(zoneId)) continue;

      // The source card is what `triggering` binds to inside `scope`, `condition` and `amount` —
      // it is the only card the rule can possibly mean by "self", and §5.4 names no other binding.
      const ctx: TriggerContext = {
        triggeringCardId: cardId,
        zoneKey: zk,
        // §4.3's controllerOf: the explicit controller, else the seat of the holding zone.
        triggeringSeat: card.controller ?? parseZoneKey(zk).seat,
        promptAnswers: {},
      };

      if (rule.condition !== null && !evalCriteriaBool(rule.condition, state, ctx, def)) continue;

      const targets = resolveTargets(spec.scope, state, ctx, def);
      // A `prompt` scope has no answer to consult during a read, so it selects nothing. A failed
      // resolution (no targets, dangling zone) means the modifier simply applies to no card.
      if (!targets.ok || targets.kind !== 'cards') continue;

      out.push({ sourceCardId: cardId, ruleId: rule.id, spec, scope: targets.cardIds, ctx });
    }
  }

  out.sort(compareCreation);
  modifierCache.set(state, out);
  return out;
}

// ---------------------------------------------------------------------------
// effectiveIndex — §5.4
// ---------------------------------------------------------------------------

function indexDefOf(def: GameDefinition, templateId: Id, indexId: Id): CardIndex | undefined {
  return def.templates.find((t) => t.id === templateId)?.indexes.find((i) => i.id === indexId);
}

/** A modifier's `amount`, or null when it does not resolve to exactly one value. */
function amountOf(
  mod: ActiveModifier,
  state: PlayState,
  def: GameDefinition
): number | boolean | null {
  const res = resolveValueRef(mod.spec.amount, state, mod.ctx, def);
  if (!res.ok || res.values.length !== 1) return null;
  return res.values[0];
}

/**
 * The value a card's Index actually reads as, base plus every modifier currently applying to it.
 *
 * §5.4's fixed application order — deliberately short of MTG's layer system, and total:
 *   1. base `card.indexValues[indexId]`
 *   2. every `set` modifier, in creation order (a later `set` overwrites an earlier one)
 *   3. every `adjust` modifier, in creation order
 *   4. `clampValue` against the `CardIndex`'s `GameValue` bounds — the one clamp in `effects.ts`
 */
export function effectiveIndex(
  state: PlayState,
  def: GameDefinition,
  cardId: Id,
  indexId: Id
): number | boolean {
  let perState = indexCache.get(state);
  if (!perState) {
    perState = new Map();
    indexCache.set(state, perState);
  }
  // ` ` cannot appear in an authored id, so the two halves can never run together ambiguously.
  const key = `${cardId} ${indexId}`;
  const hit = perState.get(key);
  if (hit !== undefined) return hit;

  const card = state.cards[cardId];
  const indexDef = card ? indexDefOf(def, card.templateId, indexId) : undefined;
  // Mirrors `Card.tsx`'s existing `instance?.indexValues[id] ?? index.value.defaultValue`. The
  // final `0` covers an indexId that names no CardIndex at all — a dangling ref the walker
  // (§8 step 19) is meant to prevent, and which has no better answer here than "nothing".
  let value: number | boolean = card?.indexValues[indexId] ?? indexDef?.value.defaultValue ?? 0;

  if (card) {
    const mods = collectModifiers(state, def).filter(
      (m) => m.spec.indexId === indexId && m.scope.includes(cardId)
    );
    for (const m of mods) {
      if (m.spec.op !== 'set') continue;
      const amount = amountOf(m, state, def);
      if (amount !== null) value = amount;
    }
    for (const m of mods) {
      if (m.spec.op !== 'adjust') continue;
      const amount = amountOf(m, state, def);
      // `adjust` is arithmetic; a boolean on either side has no defined sum, so it is skipped
      // rather than coerced. Authoring an adjust on a boolean Index is the author's bug.
      if (typeof amount === 'number' && typeof value === 'number') value += amount;
    }
  }

  if (indexDef) value = clampValue(indexDef.value, value);
  perState.set(key, value);
  return value;
}

// ---------------------------------------------------------------------------
// effectiveTags — §5.4, §4.3
// ---------------------------------------------------------------------------

/**
 * A card's tags as the runtime sees them.
 *
 * §4.3 made `tags` per-instance, seeded as a copy of `template.tags` at creation and mutated
 * thereafter by the `setTag` effect — so this is a straight read, not a computation. `RuleSet.
 * modifier` targets an `indexId`, never a tag, so no modifier can grant one; if that ever changes
 * the grant would be collected here exactly as `effectiveIndex` collects its own.
 *
 * A copy is returned so a caller cannot mutate the instance through the result.
 */
export function effectiveTags(state: PlayState, _def: GameDefinition, cardId: Id): string[] {
  return [...(state.cards[cardId]?.tags ?? [])];
}
