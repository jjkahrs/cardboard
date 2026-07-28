/**
 * Effect replacement. TECHNICAL_DESIGN_V2.md §4.5, §5.7, §8 step 27, §9.1 MTG10, §9.4(d), §9.5 #7/#14.
 *
 * `applyWithReplacement` is the ONE new hook `applyEffect` (effects.ts) calls, before anything
 * mutates. It scans `def.ruleSets` for rules whose `replaces.effectKind` matches the pending
 * effect, in §5.1 order; the first whose `replaces.match` passes wins and its `effects` run IN
 * PLACE of the original, recursively subject to the same scan (so a substitute can itself be
 * replaced) with the winning rule's id excluded from re-matching (§9.5 edge case 7's "accumulating
 * exclusion set" — see the long comment on `run` below).
 *
 * **`replacedAmount`/`replacedTarget` are bound by AST substitution, not by threading anything
 * through `TriggerContext`.** `bindMatch` walks a COPY of `rule.replaces.match`, swapping every
 * `ValueRef{kind:'replacedAmount'}` for the intercepted effect's own amount `ValueRef` (re-resolved
 * fresh against the pre-mutation state — nothing has moved yet) and every `CardRef{kind:
 * 'replacedTarget'}` for a concrete `{kind:'instance'}` ref when exactly one target resolved. The
 * unsubstituted node is left in place otherwise, so it reaches `valueRef.ts`/`seats.ts`'s existing,
 * unconditional `UNBOUND_REF` stubs on its own — this file never edits those two arms and never
 * needs a scratch field on `TriggerContext`: there is no state left behind for §9.5 #14 to leak.
 */

import {
  type CardRef,
  type CriteriaNode,
  type Effect,
  type EffectResult,
  type GameDefinition,
  type Id,
  type LogLevel,
  type LogLine,
  type PlayState,
  type RuleSet,
  type TargetSelector,
  type ValueRef,
} from './types';
import type { EffectContext } from './effects'; // type-only — no runtime cycle with effects.ts
import { evalCriteriaBool } from './criteria';
import { invalidateEffective } from './modifiers';
import { resolveTargets } from './targets';
import { zoneKey } from './valueRef';
import { top } from './frames';

// ---------------------------------------------------------------------------
// Logging — one line for the original ("replaced, not applied"); the substitute's own ordinary
// success/reject line (emitted by `applyInner` itself when it actually runs) is the second,
// distinguishable by its own message text alone (§5.7's "two distinguishable lines").
// ---------------------------------------------------------------------------

function emit(ec: EffectContext, effect: Effect, level: LogLevel, message: string): void {
  const line: LogLine = {
    level,
    kind: 'effect',
    message,
    change: null,
    ruleId: null, // dispatch.ts's `log` wrapper fills in the CURRENTLY EXECUTING rule (H2), same as effects.ts's own `emit`
    effectKind: effect.kind,
    depth: ec.depth,
  };
  ec.log(line);
}

function describeValue(ref: ValueRef): string {
  return ref.kind === 'literal' ? String(ref.value) : `<${ref.kind}>`;
}

/** Only the five interceptable kinds (§5.7) need a bespoke description; anything else just names itself. */
function describeEffect(e: Effect): string {
  switch (e.kind) {
    case 'drawCards':
      return `drawCards(count:${describeValue(e.count)})`;
    case 'changePool':
      return `changePool(${e.poolId}, ${e.op} ${describeValue(e.amount)})`;
    case 'moveCards':
      return `moveCards(→ ${e.to.zoneId})`;
    case 'destroyCards':
      return 'destroyCards';
    case 'setCardIndex':
      return `setCardIndex(${e.indexId}, ${e.op} ${describeValue(e.amount)})`;
    default:
      return e.kind;
  }
}

// ---------------------------------------------------------------------------
// Binding — the AMOUNT and TARGET the intercepted effect was about to apply.
// ---------------------------------------------------------------------------

interface ReplacementBinding {
  /** The intercepted effect's own amount `ValueRef` (unresolved — re-evaluated fresh by `evalCriteria`). */
  amount: ValueRef | null;
  targetId: Id | null;
}

/**
 * ponytail: a target binds only when its selector resolves to EXACTLY one card. §5.7 gives no
 * worked multi-target replacement case (every AC/edge-case example is `drawCards`, which has no
 * `target` at all), so zero/many/still-open-prompt are all left unbound rather than guessed at —
 * upgrade this if a real definition ever needs "replace the destruction of a set of creatures" to
 * see per-candidate `replacedTarget` values.
 */
function singleTargetId(target: TargetSelector, ec: EffectContext): Id | null {
  const res = resolveTargets(target, ec.state, ec.ctx, ec.def);
  if (!res.ok || res.kind !== 'cards' || res.cardIds.length !== 1) return null;
  return res.cardIds[0];
}

function bindingFor(effect: Effect, ec: EffectContext): ReplacementBinding {
  switch (effect.kind) {
    case 'drawCards':
      return { amount: effect.count, targetId: null };
    case 'changePool':
      return { amount: effect.amount, targetId: null };
    case 'setCardIndex':
      return { amount: effect.amount, targetId: singleTargetId(effect.target, ec) };
    case 'moveCards':
      return { amount: null, targetId: singleTargetId(effect.target, ec) };
    case 'destroyCards':
      return { amount: null, targetId: singleTargetId(effect.target, ec) };
    default:
      return { amount: null, targetId: null };
  }
}

function bindCardRef(card: CardRef, b: ReplacementBinding): CardRef {
  return card.kind === 'replacedTarget' && b.targetId !== null ? { kind: 'instance', id: b.targetId } : card;
}

/** Only descends into the two `ValueRef` kinds that carry a `CardRef` directly (§4.2: `cardIndex`,
 *  `cardTag`) — a `CardRef` nested inside a `SeatRef` (`owner`/`controller`) is not chased, same
 *  documented scope limit as `singleTargetId` above. */
function bindValueRef(ref: ValueRef, b: ReplacementBinding): ValueRef {
  switch (ref.kind) {
    case 'replacedAmount':
      return b.amount ?? ref;
    case 'cardIndex':
      return { ...ref, card: bindCardRef(ref.card, b) };
    case 'cardTag':
      return { ...ref, card: bindCardRef(ref.card, b) };
    default:
      return ref;
  }
}

function bindMatch(node: CriteriaNode, b: ReplacementBinding): CriteriaNode {
  if (node.kind === 'group') return { ...node, children: node.children.map((c) => bindMatch(c, b)) };
  return { ...node, left: bindValueRef(node.left, b), right: bindValueRef(node.right, b) };
}

// ---------------------------------------------------------------------------
// Candidate scan — §5.1's total order, duplicated (not imported) from dispatch.ts's private
// `compareBindings`/`resolveBindings`: dispatch.ts is off-limits for this step (two sibling agents
// own it for steps 22/23) and exports neither helper. Deliberately smaller than the original —
// replacement has no `sourceCardId` tiebreak to make, because two candidates here can never share
// every other sort key AND a source card the way one event's bindings can bind the same rule twice
// under two different triggering cards.
// ---------------------------------------------------------------------------

interface Candidate {
  rule: RuleSet;
  scope: number; // 0 game-level, 1 card-attached
  zoneOrder: number;
  position: number;
  seat: number;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    b.rule.priority - a.rule.priority ||
    a.scope - b.scope ||
    a.zoneOrder - b.zoneOrder ||
    a.position - b.position ||
    a.seat - b.seat ||
    (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0)
  );
}

function candidateRuleSets(
  def: GameDefinition,
  state: PlayState,
  eligible: (r: RuleSet) => boolean
): Candidate[] {
  const out: Candidate[] = [];
  for (const id of def.globalRuleSetIds) {
    const rule = def.ruleSets.find((r) => r.id === id);
    if (rule && eligible(rule)) out.push({ rule, scope: 0, zoneOrder: 0, position: 0, seat: -1 });
  }
  def.zones.forEach((zone, zoneOrder) => {
    const keys =
      zone.scope === 'shared'
        ? [zoneKey(zone.id, null)]
        : Array.from({ length: state.playerCount }, (_, s) => zoneKey(zone.id, s));
    keys.forEach((key, seat) => {
      const inst = state.zones[key];
      if (!inst) return;
      inst.cardIds.forEach((cardId, position) => {
        const card = state.cards[cardId];
        const template = card && def.templates.find((t) => t.id === card.templateId);
        if (!template) return;
        for (const ruleId of template.ruleSetIds) {
          const rule = def.ruleSets.find((r) => r.id === ruleId);
          if (rule && eligible(rule)) {
            out.push({ rule, scope: 1, zoneOrder, position, seat: zone.scope === 'shared' ? -1 : seat });
          }
        }
      });
    });
  });
  return out.sort(compareCandidates);
}

/**
 * The first (§5.1 order) `replaces` rule matching `effect.kind`, not excluded, whose `match`
 * passes — `null` (no `match`) always passes, mirroring every other "null condition passes" rule in
 * this engine (§4.7). Exported for direct, dispatch-free unit testing of the ordering/matching rules
 * in isolation from the substitution recursion below.
 */
export function findReplacement(
  effect: Effect,
  ec: EffectContext,
  excluded: Readonly<Record<Id, true>>
): RuleSet | null {
  const eligible = (r: RuleSet): boolean =>
    r.replaces !== null && r.replaces.effectKind === effect.kind && !excluded[r.id];
  const list = candidateRuleSets(ec.def, ec.state, eligible);
  if (list.length === 0) return null;

  const binding = bindingFor(effect, ec);
  for (const { rule } of list) {
    const match = rule.replaces?.match ?? null;
    if (match === null || evalCriteriaBool(bindMatch(match, binding), ec.state, ec.ctx, ec.def)) {
      return rule;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// applyWithReplacement — effects.ts's one hook.
// ---------------------------------------------------------------------------

type ApplyInner = (effect: Effect, ec: EffectContext) => EffectResult;

/**
 * `excluded` accumulates for the WHOLE chain of ONE top-level effect (§9.5 edge case 7's designed
 * resolution): the rule that just fired is added before its substitutes are scanned, so it cannot
 * re-match its own output ("draw two instead" cannot recurse into "draw two instead" again), but a
 * SECOND, distinct replacement rule is NOT pre-excluded and may intercept a substitute exactly once
 * — the design doc names this as open ("does not name whether a second, distinct rule... is allowed
 * to intercept") and this file decides it: allowed, once, bounded by the number of distinct
 * replacement rules a definition can author (each can only ever be added to `excluded` once), never
 * by a cycle. Mirrored onto the current `rule` frame's `replacedBy` (when one exists) purely for
 * §4.7/§5.7's own described shape and for post-hoc inspection — the recursion itself does not read
 * the frame back, so this works identically with or without a `rule` frame on the stack (every
 * pre-v2 `applyEffect(effect, h.ec)` unit test calls this with an empty `state.stack`).
 */
function run(effect: Effect, ec: EffectContext, excluded: Readonly<Record<Id, true>>, applyInner: ApplyInner): EffectResult {
  const winner = findReplacement(effect, ec, excluded);
  if (!winner) return applyInner(effect, ec);

  const nextExcluded: Record<Id, true> = { ...excluded, [winner.id]: true };
  const frame = top(ec.state);
  if (frame?.kind === 'rule') frame.replacedBy = nextExcluded;

  emit(ec, effect, 'info', `${describeEffect(effect)}: replaced by RuleSet "${winner.name}". Not applied.`);

  let result: EffectResult = { ok: true };
  for (const sub of winner.effects) {
    result = run(sub, ec, nextExcluded, applyInner);
    // §5.4 — each substitute is its own mutation boundary. `applyEffect`'s outer invalidate only
    // brackets the WHOLE top-level call now that one call can run several substitute mutations in
    // sequence; without this a second substitute's `effectiveIndex` read could see a value cached
    // from before the first substitute's write.
    invalidateEffective(ec.state);
    if (!result.ok) break; // first failing substitute stops the rest — undocumented by §5.7, a
    // reasonable default given `replaces.effects` has no `onRejection` of its own to consult.
  }
  return result;
}

/**
 * Entry point `applyEffect` (effects.ts) calls in place of running `applyInner` directly. `excluded`
 * always starts EMPTY here — every call is, by construction, a fresh top-level effect instance
 * (dispatch.ts's `runEffect` calls `applyEffect` once per `rule.effects[cursor]`, and this function
 * is the only place that recurses into substitutes, via the private `run` above, which is what keeps
 * one effect's chain from leaking exclusions into an unrelated later effect in the same RuleSet).
 */
export function applyWithReplacement(effect: Effect, ec: EffectContext, applyInner: ApplyInner): EffectResult {
  return run(effect, ec, {}, applyInner);
}
