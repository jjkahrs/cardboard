/**
 * The continuous-condition fixpoint scan. TECHNICAL_DESIGN_V2.md §4.5, §5.1, §5.3, §5.6.
 *
 * A `RuleSet` with `continuous: true` ignores `trigger` entirely; instead its `condition` is
 * scanned here, at slot 1 of every `settle` frame (§5.3), ahead of the auto-transition scan v1
 * built (slot 2) — "a creature with lethal damage dies" and "a player at zero pool is ousted" must
 * both land before the state machine decides whether the phase is over.
 *
 * **Fires on the false→true transition, not while true.** `PlayState.continuousFired` records that
 * a binding has fired; the key is deleted the moment its condition next evaluates false. Without
 * this a condition that stays true — which is the ordinary case, not the exceptional one: a
 * destroyed creature stays destroyed, an eliminated seat stays eliminated — would re-fire its rule
 * on every single settle pass for the rest of the session (§9.4(c)).
 *
 * `dispatch.ts`'s `advanceSettle` owns re-entry and the `SETTLE_DIVERGED` divergence bound; this
 * module is a pure(ish) scan-and-schedule step that only touches `state.continuousFired` and
 * pushes `rule` frames onto `state.stack` — it never applies an effect itself.
 */

import { evalCriteriaBool } from './criteria';
import { push } from './frames';
import { zoneKey } from './seats';
import {
  ACTIVE_PLAYER_POOL_ID,
  type GameDefinition,
  type Id,
  type PlayState,
  type RuleSet,
  type TriggerContext,
} from './types';

// ---------------------------------------------------------------------------
// The binding key — TECHNICAL_DESIGN_V2.md §10.2's open question, DECIDED here (v2 step 26).
// ---------------------------------------------------------------------------

/**
 * `continuousFired` is keyed by `` `${ruleId}:${bindingKey}` `` (§5.6). What `bindingKey` means for
 * a rule with no source card was left open by §10.2 specifically so it would be settled here, before
 * any Phase 2 fixture leaned on a guess.
 *
 * **Decision:** `bindingKey = binding.sourceCardId ?? ''`.
 *
 * This falls straight out of `dispatch.ts`'s binding resolution (mirrored below, since a continuous
 * rule has no `trigger` for that function's matcher to key off): every binding this module ever
 * produces is exactly `{ rule, sourceCardId }`, and `sourceCardId` is already `null` for a rule
 * reached through `GameDefinition.globalRuleSetIds` and a real card id for one reached through a
 * template's `ruleSetIds`. No third binding shape exists, so no third key shape is needed —
 * inventing one (e.g. hashing the condition, or keying by seat) would be a key scheme nothing else
 * in the engine produces a binding for.
 *
 * **The consequence, spelled out because it is the part a reviewer actually needs:** a card-attached
 * continuous rule gets one arm — and one `continuousFired` entry — PER CARD INSTANCE currently
 * carrying it, because `sourceCardId` differs per instance. A game-level rule (`globalRuleSetIds`)
 * gets exactly ONE arm for the whole board, because every binding of it shares `sourceCardId: null`
 * and therefore the same key. **"Each creature with lethal damage dies" is therefore only correct
 * authored as a card-attached rule** (typically on every creature template, or on one card whose
 * `TargetSelector` sweeps the board — but a `RuleSet` has no target selector of its own outside its
 * `effects`, so in practice: per-template). Authored as a GLOBAL rule instead, it fires once, the
 * first time ANY creature has lethal damage, and then never again for the rest of the session even
 * though a different creature takes lethal damage later — because the key never changed and the
 * condition (evaluated with no card bound) never had a card-specific shape to go false and re-arm.
 * MTG9's own fixture hits the mirror image of this directly: "a player at zero life is eliminated"
 * has no card to attach to, so it is authored as one global rule PER SEAT (§9.5 edge case 10 is the
 * regression guard that two such rules never collide on one key).
 */
export function continuousKey(ruleId: Id, sourceCardId: Id | null): string {
  return `${ruleId}:${sourceCardId ?? ''}`;
}

// ---------------------------------------------------------------------------
// Bindings — §5.1 order: priority desc, game-level before card-attached, zone declaration order,
// positional index, seat index, RuleSet id tiebreak.
// ---------------------------------------------------------------------------

interface ContinuousBinding {
  rule: RuleSet;
  sourceCardId: Id | null;
  /** 0 game-level, 1 card-attached — §5.1. */
  scope: number;
  zoneOrder: number;
  position: number;
  seat: number;
}

/**
 * Same total order as `dispatch.ts`'s `compareBindings` (§5.1) — deliberately NOT imported, because
 * that comparator's sibling, `resolveBindings`, filters on `rule.trigger === name` and a continuous
 * rule has no trigger to match (§5.6). Reshaping `resolveBindings` to serve both call sites is out
 * of scope for this step (see the file-boundary note in this module's PR description) — the ordering
 * rule is eleven lines and stable, so duplicating it here is cheaper and safer than restructuring the
 * function three other steps in this same phase are editing concurrently.
 */
function compareBindings(a: ContinuousBinding, b: ContinuousBinding): number {
  return (
    b.rule.priority - a.rule.priority ||
    a.scope - b.scope ||
    a.zoneOrder - b.zoneOrder ||
    a.position - b.position ||
    a.seat - b.seat ||
    (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0) ||
    String(a.sourceCardId).localeCompare(String(b.sourceCardId))
  );
}

/** Every `continuous: true` RuleSet currently live on the board, in §5.1 order. */
function collectBindings(state: PlayState, def: GameDefinition): ContinuousBinding[] {
  const rulesById = new Map(def.ruleSets.map((r) => [r.id, r] as const));
  const templatesById = new Map(def.templates.map((t) => [t.id, t] as const));
  const out: ContinuousBinding[] = [];

  for (const id of def.globalRuleSetIds) {
    const rule = rulesById.get(id);
    if (rule?.continuous) {
      out.push({ rule, sourceCardId: null, scope: 0, zoneOrder: 0, position: 0, seat: -1 });
    }
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
        const template = card && templatesById.get(card.templateId);
        if (!template) return;
        for (const ruleId of template.ruleSetIds) {
          const rule = rulesById.get(ruleId);
          if (rule?.continuous) {
            out.push({
              rule,
              sourceCardId: cardId,
              scope: 1,
              zoneOrder,
              position,
              seat: zone.scope === 'shared' ? -1 : seat,
            });
          }
        }
      });
    });
  });

  return out.sort(compareBindings);
}

/** Mirrors `dispatch.ts`'s `activeSeat` — the only sane `triggeringSeat` for a scan nothing "triggered". */
const activeSeat = (state: PlayState): number => Number(state.pools[ACTIVE_PLAYER_POOL_ID] ?? 0);

function bindingCtx(state: PlayState, binding: ContinuousBinding): TriggerContext {
  return {
    triggeringCardId: null,
    zoneKey: null,
    triggeringSeat: activeSeat(state),
    promptAnswers: {},
    // Mirrors `dispatch.ts`'s `advanceEvent`: this is the one place a continuous binding's source
    // card is stamped, so `CardRef{kind:'host'}` inside the rule's own condition/effects resolves.
    sourceCardId: binding.sourceCardId,
  };
}

// ---------------------------------------------------------------------------
// The scan — §5.6's fixpoint, one pass.
// ---------------------------------------------------------------------------

/**
 * `frame.cursor`'s UNRESOLVED sentinel, duplicated from `dispatch.ts` rather than imported: it is a
 * private module constant there (`const UNRESOLVED = -1`), and every `rule` frame this module ever
 * pushes needs the exact same value so `advanceRule` runs its usual header (source-card check,
 * condition re-check, log line) instead of treating the frame as already-started.
 */
const UNRESOLVED = -1;

/**
 * One pass of slot 1 (§5.3, §5.6). For every live continuous binding, in §5.1 order:
 *   - condition true, not yet fired → mark fired, schedule a `rule` frame.
 *   - condition false → clear the fired mark, so a later false→true is a real re-fire.
 *   - condition true, already fired → untouched (this is what stops the fixpoint looping forever
 *     on a condition that just stays true, e.g. an eliminated seat's `life <= 0`).
 *
 * Conditions are evaluated against the state as it stands RIGHT NOW, not snapshotted — a binding
 * later in §5.1 order sees anything an earlier one in THIS pass has already changed via a completed
 * effect. It does NOT see anything scheduled by an earlier binding in this SAME pass, because firing
 * only pushes a frame; the frame's effects run on a later `step()`, after this function returns. That
 * is exactly why SP9's two-rule chain (first rule's effect arms the second rule's condition) needs
 * TWO settle passes, not one — `advanceSettle` re-enters slot 1 every time this returns `true`, so
 * both still land inside the same transaction, just not the same call to this function.
 *
 * Returns whether anything fired, telling the caller whether to bump `budget.settleIterations` and
 * re-enter settle, or fall through to slot 2.
 */
export function scanContinuous(state: PlayState, def: GameDefinition): boolean {
  const bindings = collectBindings(state, def);
  const toFire: ContinuousBinding[] = [];

  for (const binding of bindings) {
    const key = continuousKey(binding.rule.id, binding.sourceCardId);
    // null condition => always true (criteria.ts: "a null condition is the caller's problem").
    const value = binding.rule.condition
      ? evalCriteriaBool(binding.rule.condition, state, bindingCtx(state, binding), def)
      : true;

    if (value) {
      if (!state.continuousFired[key]) {
        state.continuousFired[key] = true;
        toFire.push(binding);
      }
    } else if (state.continuousFired[key]) {
      delete state.continuousFired[key];
    }
  }

  // Pushed in REVERSE §5.1 order. `push` is LIFO and the stack is empty when this runs (the settle
  // frame that called us was already popped) — the frame that ends up on TOP, and therefore runs
  // FIRST on the next `advance()`, must be the one pushed LAST. Firing several bindings in one pass
  // only happens when their conditions were ALL already true independently before this pass began —
  // a genuine dependency between two rules needs a second pass (see above) — so this loop only
  // restores §5.1's order among rules that were never actually ordered relative to each other by
  // cause and effect.
  for (let i = toFire.length - 1; i >= 0; i--) {
    const binding = toFire[i];
    push(state, {
      kind: 'rule',
      ruleId: binding.rule.id,
      sourceCardId: binding.sourceCardId,
      ctx: bindingCtx(state, binding),
      cursor: UNRESOLVED,
      aborted: false,
      parentId: null,
      depth: state.budget.causalDepth,
    });
  }

  return toFire.length > 0;
}
