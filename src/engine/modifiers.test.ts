/**
 * §5.4 — derived card values.
 *
 * The fixture here is deliberately local rather than `duel.ts`: `duel` has no modifiers and §9.3's
 * `mtgish.ts` does not exist yet (it lands with phase 2). It is the smallest board that can express
 * MTG6 and MTG7 — one `adjust` lord, one `set` lord, and a bear for them to point at.
 */

import { describe, expect, it } from 'vitest';

import {
  ACTIVE_PLAYER_POOL_ID,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
  type CardInstance,
  type CriteriaNode,
  type Effect,
  type GameDefinition,
  type Id,
  type LogLine,
  type PlayState,
  type RuleSet,
  type TargetSelector,
  type TriggerContext,
  type ValueRef,
} from './types';
import { applyEffect, type EffectContext } from './effects';
import { evalCriteriaBool } from './criteria';
import { collectModifiers, effectiveIndex, effectiveTags } from './modifiers';
import { resolveTargets } from './targets';
import { resolveValueRef, zoneKey } from './valueRef';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const BF = 'bf';
const HAND = 'hand';
const POWER = 'power';
const CREATURE = 'creature';

const T_BEAR = 'tBear';
const T_ADJUST_LORD = 'tAdjustLord';
const T_SET_LORD = 'tSetLord';

const RS_ADJUST = 'rsAdjust';
const RS_SET = 'rsSet';

const BF_KEY = zoneKey(BF, null);
const HAND_0 = zoneKey(HAND, 0);

const lit = (value: number | boolean): ValueRef => ({ kind: 'literal', value });

/** `power`, integer, clamped 0..10 — the bounds step 4 of §5.4's order has to respect. */
const powerIndex = {
  id: POWER,
  value: { type: 'integer' as const, name: 'Power', defaultValue: 2, min: 0, max: 10 },
  icon: 'gi-broadsword',
  position: 'topLeft' as const,
};

function modifierRule(id: Id, op: 'set' | 'adjust', amount: ValueRef, activeZones: Id[] = [BF]): RuleSet {
  return {
    id,
    name: id,
    // `trigger` is inert on a modifier rule — nothing fires it; it is scanned, never dispatched.
    trigger: 'onGameStart',
    stateFilter: null,
    condition: null,
    effects: [],
    priority: 0,
    onRejection: 'continue',
    modifier: {
      scope: { kind: 'taggedInZone', zone: { zoneId: BF, seat: null }, tag: CREATURE },
      indexId: POWER,
      op,
      amount,
      activeZones,
    },
    continuous: false,
    replaces: null,
    activation: null,
  };
}

/**
 * `ruleSets` is authored `[adjust, set]` — the wrong order for the result MTG7 demands, which is
 * the entire point of the criterion.
 */
function makeDef(over: Partial<GameDefinition> = {}): GameDefinition {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'mods',
    name: 'Modifiers',
    playerCount: 2,
    pools: [],
    zones: [
      { id: BF, name: 'Battlefield', scope: 'shared', visibility: 'faceUp', layout: 'row', ordered: false, maxCapacity: null },
      { id: HAND, name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: null },
    ],
    templates: [
      { id: T_BEAR, name: 'Bear', marquee: 'Bear', faceIcon: 'gi-bear', borderColor: '#000', tags: [CREATURE], indexes: [powerIndex], ruleSetIds: [], rulesTextOverride: null },
      { id: T_ADJUST_LORD, name: 'Anthem', marquee: 'Anthem', faceIcon: 'gi-crown', borderColor: '#000', tags: [CREATURE], indexes: [powerIndex], ruleSetIds: [RS_ADJUST], rulesTextOverride: null },
      { id: T_SET_LORD, name: 'Humility', marquee: 'Humility', faceIcon: 'gi-crown', borderColor: '#000', tags: [CREATURE], indexes: [powerIndex], ruleSetIds: [RS_SET], rulesTextOverride: null },
    ],
    decks: [],
    customEvents: [],
    ruleSets: [modifierRule(RS_ADJUST, 'adjust', lit(1)), modifierRule(RS_SET, 'set', lit(0))],
    globalRuleSetIds: [],
    priorityWindows: [],
    machine: {
      states: [
        { id: START_STATE_ID, name: 'Start', enterableFrom: [], exitableTo: [END_STATE_ID], entryCriteria: null, transitionLabel: 'Go', priority: 0, position: { x: 0, y: 0 } },
        { id: END_STATE_ID, name: 'End', enterableFrom: [START_STATE_ID], exitableTo: [], entryCriteria: null, transitionLabel: null, priority: 0, position: { x: 1, y: 0 } },
      ],
      startStateId: START_STATE_ID,
      endStateId: END_STATE_ID,
    },
    limits: {
      maxDepth: DEFAULT_MAX_DEPTH,
      maxEffects: DEFAULT_MAX_EFFECTS,
      maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
      maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function card(id: Id, templateId: Id, over: Partial<CardInstance> = {}): CardInstance {
  return {
    id,
    templateId,
    indexValues: { [POWER]: powerIndex.value.defaultValue },
    faceDown: false,
    rotated: false,
    tags: [CREATURE],
    owner: 0,
    controller: null,
    attachedTo: null,
    ...over,
  };
}

function makeState(cards: CardInstance[], zones: Record<string, Id[]>): PlayState {
  return {
    definitionId: 'mods',
    seed: 'seed',
    rngCursor: 0,
    nextSeq: cards.length,
    nextWorkId: 0,
    logSeq: 0,
    playerCount: 2,
    seatOrder: [0, 1],
    eliminated: [],
    pools: { [ACTIVE_PLAYER_POOL_ID]: 0 },
    playerPools: {},
    cards: Object.fromEntries(cards.map((c) => [c.id, c])),
    zones: {
      [BF_KEY]: { zoneId: BF, seat: null, cardIds: zones[BF_KEY] ?? [] },
      [HAND_0]: { zoneId: HAND, seat: 0, cardIds: zones[HAND_0] ?? [] },
      [zoneKey(HAND, 1)]: { zoneId: HAND, seat: 1, cardIds: [] },
    },
    currentStateId: START_STATE_ID,
    finished: false,
    stack: [],
    pending: [],
    interaction: null,
    pendingActions: {},
    actionStack: [],
    continuousFired: {},
    budget: { causalDepth: 0, effectsUsed: 0, settleIterations: 0, priorityRounds: 0 },
  };
}

const ctx: TriggerContext = { triggeringCardId: null, zoneKey: null, triggeringSeat: 0, promptAnswers: {}, sourceCardId: null };

function effectContext(state: PlayState, def: GameDefinition): EffectContext {
  const lines: LogLine[] = [];
  return {
    state,
    def,
    ctx,
    depth: 0,
    override: false,
    log: (line) => lines.push(line),
    fireEvent: () => {},
  };
}

/** immer hands back a fresh object per `produce`; `structuredClone` is the same identity change. */
const produced = (state: PlayState): PlayState => structuredClone(state);

// ---------------------------------------------------------------------------
// collectModifiers
// ---------------------------------------------------------------------------

describe('collectModifiers (§5.4)', () => {
  it('finds one modifier per source INSTANCE, not per rule', () => {
    const def = makeDef();
    const state = makeState(
      [card('c0', T_BEAR), card('c1', T_ADJUST_LORD), card('c2', T_ADJUST_LORD)],
      { [BF_KEY]: ['c0', 'c1', 'c2'] }
    );
    const mods = collectModifiers(state, def);
    expect(mods.map((m) => m.sourceCardId)).toEqual(['c1', 'c2']);
    // Two lords, two +1s.
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(4);
  });

  it('orders by source instance sequence, not by def.ruleSets array position', () => {
    const def = makeDef();
    // c1 carries the SET rule (second in the array), c2 the ADJUST rule (first).
    const state = makeState(
      [card('c0', T_BEAR), card('c1', T_SET_LORD), card('c2', T_ADJUST_LORD)],
      { [BF_KEY]: ['c0', 'c1', 'c2'] }
    );
    expect(collectModifiers(state, def).map((m) => [m.sourceCardId, m.ruleId])).toEqual([
      ['c1', RS_SET],
      ['c2', RS_ADJUST],
    ]);
  });

  it('sorts c2 before c10 — numeric suffix, not string order', () => {
    const def = makeDef();
    const state = makeState(
      [card('c2', T_ADJUST_LORD), card('c10', T_SET_LORD)],
      { [BF_KEY]: ['c10', 'c2'] }
    );
    expect(collectModifiers(state, def).map((m) => m.sourceCardId)).toEqual(['c2', 'c10']);
  });

  it('drops a modifier whose source has left its activeZones', () => {
    const def = makeDef();
    const state = makeState(
      [card('c0', T_BEAR), card('c1', T_ADJUST_LORD)],
      { [BF_KEY]: ['c0'], [HAND_0]: ['c1'] }
    );
    expect(collectModifiers(state, def)).toEqual([]);
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(2);
  });

  it('empty activeZones applies wherever the source is', () => {
    const def = makeDef({
      ruleSets: [modifierRule(RS_ADJUST, 'adjust', lit(1), []), modifierRule(RS_SET, 'set', lit(0))],
    });
    const state = makeState(
      [card('c0', T_BEAR), card('c1', T_ADJUST_LORD)],
      { [BF_KEY]: ['c0'], [HAND_0]: ['c1'] }
    );
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(3);
  });

  it('a failing condition suppresses the modifier', () => {
    const never = modifierRule(RS_ADJUST, 'adjust', lit(1));
    const def = makeDef({
      ruleSets: [
        { ...never, condition: { kind: 'criteria', left: lit(1), op: '>', right: lit(2) } },
        modifierRule(RS_SET, 'set', lit(0)),
      ],
    });
    const state = makeState([card('c0', T_BEAR), card('c1', T_ADJUST_LORD)], { [BF_KEY]: ['c0', 'c1'] });
    expect(collectModifiers(state, def)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// effectiveIndex
// ---------------------------------------------------------------------------

describe('effectiveIndex (§5.4)', () => {
  it('returns the base value when nothing modifies it', () => {
    const def = makeDef();
    const state = makeState([card('c0', T_BEAR, { indexValues: { [POWER]: 5 } })], { [BF_KEY]: ['c0'] });
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(5);
  });

  it('falls back to the CardIndex default when the instance has no stored value', () => {
    const def = makeDef();
    const state = makeState([card('c0', T_BEAR, { indexValues: {} })], { [BF_KEY]: ['c0'] });
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(2);
  });

  // AC: MTG7
  it('applies every `set` before every `adjust`, regardless of authoring order', () => {
    const def = makeDef();
    // `def.ruleSets` is authored [adjust, set] — §9.1's MTG7 spells that array order out.
    expect(def.ruleSets.map((r) => r.modifier?.op)).toEqual(['adjust', 'set']);
    const state = makeState(
      [card('c0', T_BEAR), card('c1', T_SET_LORD), card('c2', T_ADJUST_LORD)],
      { [BF_KEY]: ['c0', 'c1', 'c2'] }
    );
    // set.amount (0) + adjust.amount (1) — the adjust is NOT clobbered by the set.
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(1);
  });

  // The half MTG7's own arrangement cannot see. Above, the set-carrying lord is ALSO the earlier
  // instance, so a naive "apply every modifier in creation order" engine lands on 1 too. Swapping
  // the two instances separates them: creation order gives 2 + 1 = 3, then set → 0, while §5.4's
  // two passes give set → 0, then + 1 = 1.
  it('…and the set still wins when the ADJUST source is the earlier instance', () => {
    const def = makeDef();
    const state = makeState(
      [card('c0', T_BEAR), card('c1', T_ADJUST_LORD), card('c2', T_SET_LORD)],
      { [BF_KEY]: ['c0', 'c1', 'c2'] }
    );
    expect(collectModifiers(state, def).map((m) => m.spec.op)).toEqual(['adjust', 'set']);
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(1);
  });

  it('is identical with the two rules authored in the opposite array order (§9.4(b))', () => {
    const flipped = makeDef({
      ruleSets: [modifierRule(RS_SET, 'set', lit(0)), modifierRule(RS_ADJUST, 'adjust', lit(1))],
    });
    const state = makeState(
      [card('c0', T_BEAR), card('c1', T_SET_LORD), card('c2', T_ADJUST_LORD)],
      { [BF_KEY]: ['c0', 'c1', 'c2'] }
    );
    expect(effectiveIndex(state, flipped, 'c0', POWER)).toBe(effectiveIndex(produced(state), makeDef(), 'c0', POWER));
  });

  it('a later `set` overwrites an earlier one, in creation order', () => {
    const def = makeDef({
      ruleSets: [modifierRule(RS_ADJUST, 'set', lit(7)), modifierRule(RS_SET, 'set', lit(3))],
    });
    const state = makeState(
      [card('c0', T_BEAR), card('c1', T_ADJUST_LORD), card('c2', T_SET_LORD)],
      { [BF_KEY]: ['c0', 'c1', 'c2'] }
    );
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(3);
  });

  it('clamps against the CardIndex bounds after every modifier (§5.4 step 4)', () => {
    const def = makeDef({ ruleSets: [modifierRule(RS_ADJUST, 'adjust', lit(-99)), modifierRule(RS_SET, 'set', lit(0))] });
    const state = makeState([card('c0', T_BEAR), card('c1', T_ADJUST_LORD)], { [BF_KEY]: ['c0', 'c1'] });
    // 2 - 99 = -97, clamped to the index's min of 0 — not a negative power.
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(0);

    const big = makeDef({ ruleSets: [modifierRule(RS_ADJUST, 'set', lit(99)), modifierRule(RS_SET, 'adjust', lit(0))] });
    const state2 = makeState([card('c0', T_BEAR), card('c1', T_ADJUST_LORD)], { [BF_KEY]: ['c0', 'c1'] });
    expect(effectiveIndex(state2, big, 'c0', POWER)).toBe(10);
  });

  it('the modifier applies to the source itself when the scope catches it', () => {
    const def = makeDef();
    const state = makeState([card('c1', T_ADJUST_LORD)], { [BF_KEY]: ['c1'] });
    expect(effectiveIndex(state, def, 'c1', POWER)).toBe(3);
  });

  it('returns 0 for an indexId no template declares, rather than failing', () => {
    const def = makeDef();
    const state = makeState([card('c0', T_BEAR)], { [BF_KEY]: ['c0'] });
    expect(effectiveIndex(state, def, 'c0', 'noSuchIndex')).toBe(0);
  });

  // AC: MTG6
  it('a card that just entered the zone reads the bonus in the very next read, no recalculation', () => {
    const def = makeDef();
    // The lord is already out; the bear is in hand and unmodified.
    const state = makeState(
      [card('c0', T_BEAR), card('c1', T_ADJUST_LORD)],
      { [BF_KEY]: ['c1'], [HAND_0]: ['c0'] }
    );
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(2);

    const move: Effect = {
      kind: 'moveCards',
      target: { kind: 'allInZone', zone: { zoneId: HAND, seat: { kind: 'seat', index: 0 } } },
      to: { zoneId: BF, seat: null },
      position: 'top',
    };
    // A `produce` boundary, exactly as the store applies it — the state the UI then reads is a new
    // object, so the memo cannot serve the pre-move answer.
    const after = produced(state);
    expect(applyEffect(move, effectContext(after, def))).toEqual({ ok: true });

    // No settle pass, no recalculation action, no second dispatch — just the read.
    expect(after.zones[BF_KEY].cardIds).toContain('c0');
    expect(effectiveIndex(after, def, 'c0', POWER)).toBe(3);
    // The stored BASE is untouched; the +1 exists nowhere in state (§5.4 derivation).
    expect(after.cards['c0'].indexValues[POWER]).toBe(2);
  });

  // §9.5 edge case 5 — a rule's effect list first destroys the modifier's SOURCE, and a LATER effect
  // in the SAME rule (same draft, no `produce` boundary in between) reads the buffed card. Since
  // modifiers are derived from `state.cards` on every read rather than materialized, this must just
  // work — the read after removal already reflects the loss — but it is exactly the class of bug a
  // cached/materialized design would get wrong (a stale buffed value surviving until the next
  // recompute), so it earns its own test rather than trusting the derivation argument in prose.
  it('§9.5 edge case 5 — a later effect in the SAME rule reads the buff as already gone once its source is destroyed', () => {
    const def = makeDef();
    const state = makeState(
      [card('c0', T_BEAR), card('c1', T_ADJUST_LORD)],
      { [BF_KEY]: ['c1', 'c0'] } // lord first, so topOfZone(count:1) below names only the lord
    );
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(3); // 2 base + 1 from the lord's buff

    const ec = effectContext(state, def);
    const destroy: Effect = {
      kind: 'destroyCards',
      target: { kind: 'topOfZone', zone: { zoneId: BF, seat: null }, count: lit(1) },
    };
    expect(applyEffect(destroy, ec)).toEqual({ ok: true });
    expect(state.cards['c1']).toBeUndefined(); // the lord really is gone

    // Read within the SAME rule's resolution — same state object, no produce boundary — and the buff
    // is already gone: effectiveIndex is derived from state.cards on every read, never materialized.
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Memoization — §5.4, outside the patch stream
// ---------------------------------------------------------------------------

describe('the WeakMap memo (§5.4)', () => {
  it('does not leak a cached value across a produce boundary', () => {
    const def = makeDef();
    const before = makeState(
      [card('c0', T_BEAR), card('c1', T_ADJUST_LORD)],
      { [BF_KEY]: ['c0'], [HAND_0]: ['c1'] }
    );
    expect(effectiveIndex(before, def, 'c0', POWER)).toBe(2);

    const after = produced(before);
    after.zones[HAND_0].cardIds = [];
    after.zones[BF_KEY].cardIds = ['c0', 'c1'];

    expect(effectiveIndex(after, def, 'c0', POWER)).toBe(3);
    // The old object still answers with the old board — it IS the old board, which is what makes
    // rewinding to it correct rather than merely cached.
    expect(effectiveIndex(before, def, 'c0', POWER)).toBe(2);
  });

  // Regression, step 20. `applyEffect` used to drop the memo on ENTRY only, which covers a read
  // made by the NEXT effect but not one made between two effects — and `dispatch.ts:564` evaluates
  // the following RuleSet's `condition` in exactly that window, as does `stateMachine.ts`'s settle
  // scan of `entryCriteria`. The memo then answered with the value from before the last write: a
  // `setCardIndex` that raised power to 9 gated the next rule on 5.
  it('does not serve a pre-write value to a read that happens between two effects', () => {
    const { def, state } = buffedBoard(); // c0 base 3, lord +2 → reads 5
    applyEffect(setIndex('add', 2), ecFor(state, def, 'c0')); // 5 + 2 → base 7, reads 9

    expect(state.cards['c0'].indexValues[POWER]).toBe(7);
    // No intervening applyEffect — this is the read dispatch makes for the next rule's condition.
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(9);
    const node: CriteriaNode = {
      kind: 'criteria',
      left: { kind: 'cardIndex', card: { kind: 'instance', id: 'c0' }, indexId: POWER },
      op: '=',
      right: lit(9),
    };
    expect(evalCriteriaBool(node, state, ctx, def)).toBe(true);
  });

  it('does not serve a pre-move value either — moveCards changes which modifiers are active', () => {
    const def = makeDef();
    const state = makeState(
      [card('c0', T_BEAR), card('c1', T_ADJUST_LORD)],
      { [BF_KEY]: ['c1'], [HAND_0]: ['c0'] }
    );
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(2); // priming the memo on this very object
    applyEffect(
      {
        kind: 'moveCards',
        target: { kind: 'allInZone', zone: { zoneId: HAND, seat: { kind: 'seat', index: 0 } } },
        to: { zoneId: BF, seat: null },
        position: 'top',
      },
      effectContext(state, def)
    );
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(3);
  });

  it('lives nowhere in PlayState — the state is byte-identical after a read', () => {
    const def = makeDef();
    const state = makeState([card('c0', T_BEAR), card('c1', T_ADJUST_LORD)], { [BF_KEY]: ['c0', 'c1'] });
    const snapshot = JSON.stringify(state);
    effectiveIndex(state, def, 'c0', POWER);
    collectModifiers(state, def);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// effectiveTags
// ---------------------------------------------------------------------------

describe('effectiveTags (§5.4, §4.3)', () => {
  it('reads the per-instance tags, not the template', () => {
    const def = makeDef();
    const state = makeState([card('c0', T_BEAR, { tags: [CREATURE, 'enchanted'] })], { [BF_KEY]: ['c0'] });
    expect(effectiveTags(state, def, 'c0')).toEqual([CREATURE, 'enchanted']);
  });

  it('returns a copy — a caller cannot mutate the instance through it', () => {
    const def = makeDef();
    const state = makeState([card('c0', T_BEAR)], { [BF_KEY]: ['c0'] });
    effectiveTags(state, def, 'c0').push('hacked');
    expect(state.cards['c0'].tags).toEqual([CREATURE]);
  });

  it('is empty for a card that does not exist', () => {
    const def = makeDef();
    expect(effectiveTags(makeState([], {}), def, 'nope')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Step 14 — the read sites (§5.4)
// ---------------------------------------------------------------------------

/** A `+2` lord on the battlefield and a base-3 bear beside it. */
function buffedBoard() {
  const def = makeDef({
    ruleSets: [modifierRule(RS_ADJUST, 'adjust', lit(2)), modifierRule(RS_SET, 'set', lit(0))],
  });
  const state = makeState(
    [card('c0', T_BEAR, { indexValues: { [POWER]: 3 } }), card('c1', T_ADJUST_LORD)],
    { [BF_KEY]: ['c0', 'c1'] }
  );
  return { def, state };
}

/** `triggeringCard` is the only selector that names one instance; `ecFor` binds it. */
function setIndex(op: 'add' | 'subtract' | 'set', amount: number): Effect {
  return { kind: 'setCardIndex', target: { kind: 'triggeringCard' }, indexId: POWER, op, amount: lit(amount) };
}

function ecFor(state: PlayState, def: GameDefinition, cardId: Id): EffectContext {
  return { ...effectContext(state, def), ctx: { ...ctx, triggeringCardId: cardId } };
}

describe('setCardIndex reads EFFECTIVE and writes BASE (§5.4)', () => {
  it('subtracts from what the card currently reads as, and stores that as the new base', () => {
    const { def, state } = buffedBoard();
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(5); // base 3 + the lord's 2

    expect(applyEffect(setIndex('subtract', 1), ecFor(state, def, 'c0'))).toEqual({ ok: true });

    // THE assertion of this read site: 5 − 1 = 4 is written to the BASE, not 3 − 1 = 2. Read-base /
    // write-base would make damage on a buffed creature behave differently from damage on an
    // unbuffed one.
    expect(state.cards['c0'].indexValues[POWER]).toBe(4);
    // …and the modifier is still derived on top of the new base, so the card now reads 6.
    expect(effectiveIndex(produced(state), def, 'c0', POWER)).toBe(6);
  });

  it('is unchanged from v1 when no modifier is active — effective IS the base', () => {
    const def = makeDef({ ruleSets: [] });
    const state = makeState([card('c0', T_BEAR, { indexValues: { [POWER]: 3 } })], { [BF_KEY]: ['c0'] });
    expect(applyEffect(setIndex('subtract', 1), ecFor(state, def, 'c0'))).toEqual({ ok: true });
    expect(state.cards['c0'].indexValues[POWER]).toBe(2);
  });

  it('leaves the base alone when the arithmetic lands back where it started', () => {
    const { def, state } = buffedBoard();
    // add 2 then subtract 2 — the second read sees the first write, so this is a real round trip.
    applyEffect(setIndex('add', 2), ecFor(state, def, 'c0'));
    expect(state.cards['c0'].indexValues[POWER]).toBe(7); // 5 + 2
    applyEffect(setIndex('subtract', 2), ecFor(state, def, 'c0'));
    // 7 + 2 = 9 effective, − 2 = 7. Stale memoization across the two effects would have written 5.
    expect(state.cards['c0'].indexValues[POWER]).toBe(7);
  });

  it('clamps the effective arithmetic against the index bounds, not the base arithmetic', () => {
    const { def, state } = buffedBoard();
    // 5 + 8 = 13, clamped to the index max of 10 — base 3 + 8 = 11 would have clamped too, but to a
    // different value on the way in.
    applyEffect(setIndex('add', 8), ecFor(state, def, 'c0'));
    expect(state.cards['c0'].indexValues[POWER]).toBe(10);
  });

  it('`set` overwrites the base outright and reads nothing', () => {
    const { def, state } = buffedBoard();
    applyEffect(setIndex('set', 1), ecFor(state, def, 'c0'));
    expect(state.cards['c0'].indexValues[POWER]).toBe(1);
    expect(effectiveIndex(produced(state), def, 'c0', POWER)).toBe(3);
  });
});

describe('the other engine read sites (§5.4)', () => {
  it('valueRef `cardIndex` resolves the effective value, so criteria compare what the card reads as', () => {
    const { def, state } = buffedBoard();
    const ref: ValueRef = { kind: 'cardIndex', card: { kind: 'instance', id: 'c0' }, indexId: POWER };
    expect(resolveValueRef(ref, state, ctx, def)).toEqual({ ok: true, values: [5], quantifier: 'every' });
  });

  it('…and still reports a dangling indexId rather than answering effectiveIndex`s 0', () => {
    const { def, state } = buffedBoard();
    const ref: ValueRef = { kind: 'cardIndex', card: { kind: 'instance', id: 'c0' }, indexId: 'nope' };
    const res = resolveValueRef(ref, state, ctx, def);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('MISSING_REFERENT');
  });

  it('criteria inherit the change through resolveValueRef, with no read site of their own', () => {
    const { def, state } = buffedBoard();
    const node: CriteriaNode = {
      kind: 'criteria',
      left: { kind: 'cardIndex', card: { kind: 'instance', id: 'c0' }, indexId: POWER },
      op: '>=',
      right: lit(5),
    };
    // 5 >= 5 on the effective value; the stored base of 3 would fail it.
    expect(evalCriteriaBool(node, state, ctx, def)).toBe(true);
    expect(state.cards['c0'].indexValues[POWER]).toBe(3);
  });

  it('taggedInZone reads the INSTANCE tags, so a tag no template lists still selects', () => {
    const def = makeDef();
    const state = makeState(
      [card('c0', T_BEAR, { tags: [CREATURE, 'enchanted'] }), card('c1', T_BEAR)],
      { [BF_KEY]: ['c0', 'c1'] }
    );
    const sel: TargetSelector = { kind: 'taggedInZone', zone: { zoneId: BF, seat: null }, tag: 'enchanted' };
    const res = resolveTargets(sel, state, ctx, def);
    expect(res.ok && res.kind === 'cards' && res.cardIds).toEqual(['c0']);
  });

  it('…and a template tag removed from the instance no longer selects', () => {
    const def = makeDef();
    const state = makeState([card('c0', T_BEAR, { tags: [] })], { [BF_KEY]: ['c0'] });
    const sel: TargetSelector = { kind: 'taggedInZone', zone: { zoneId: BF, seat: null }, tag: CREATURE };
    const res = resolveTargets(sel, state, ctx, def);
    // §5.9 row 2 — matching nothing is NO_TARGETS, not an empty success. The template still lists
    // `creature`; only the instance's copy was emptied, and that is the list that decides.
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('NO_TARGETS');
  });
});

describe('a self-referential modifier terminates instead of recursing (§5.4 is silent)', () => {
  /** "Creatures get +1/+1 as long as a creature reads 3 or more" — the condition re-enters here. */
  const gated = (): GameDefinition =>
    makeDef({
      ruleSets: [
        {
          ...modifierRule(RS_ADJUST, 'adjust', lit(1)),
          condition: {
            kind: 'criteria',
            left: { kind: 'cardIndex', card: { kind: 'instance', id: 'c0' }, indexId: POWER },
            op: '>=',
            right: lit(3),
          },
        },
        modifierRule(RS_SET, 'set', lit(0)),
      ],
    });

  it('answers with the BASE inside a gate, so the modifier cannot see its own output', () => {
    const def = gated();
    const state = makeState(
      [card('c0', T_BEAR, { indexValues: { [POWER]: 3 } }), card('c1', T_ADJUST_LORD)],
      { [BF_KEY]: ['c0', 'c1'] }
    );
    // Gate reads base 3 >= 3 → passes → +1.
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(4);
    // Order-independent: reading the lord first must not change the bear's answer.
    const other = produced(state);
    expect(effectiveIndex(other, def, 'c1', POWER)).toBe(3);
    expect(effectiveIndex(other, def, 'c0', POWER)).toBe(4);
  });

  it('answers with the BASE for an `amount` that refers back to the index it is computing', () => {
    const def = makeDef({
      ruleSets: [
        // "+X, where X is c0's power" — resolving the amount re-enters c0's own read.
        modifierRule(RS_ADJUST, 'adjust', {
          kind: 'cardIndex',
          card: { kind: 'instance', id: 'c0' },
          indexId: POWER,
        }),
        modifierRule(RS_SET, 'set', lit(0)),
      ],
    });
    const state = makeState(
      [card('c0', T_BEAR, { indexValues: { [POWER]: 3 } }), card('c1', T_ADJUST_LORD)],
      { [BF_KEY]: ['c0', 'c1'] }
    );
    // 3 + 3, not a stack overflow.
    expect(effectiveIndex(state, def, 'c0', POWER)).toBe(6);
  });
});
