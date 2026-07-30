/**
 * §5.7, §8 step 27, §9.1 MTG10, §9.4(d), §9.5 edge cases #7 and #14.
 *
 * A self-contained fixture, not `mtgish.ts`/`vtesish.ts` (step 32's job, and not built yet at this
 * step — §8's own note on step 32 says it "cannot come earlier").
 *
 * The first half is scoped to `drawCards`, the one interceptable kind every acceptance criterion and
 * edge case in this task actually names. The sections from "the target half of the binding" onward
 * cover the other four §5.7 kinds and the card-attached half of the §5.1 candidate scan — both of
 * which the `drawCards`-only original left entirely unexecuted (`drawCards` carries no `target`, and
 * every rule here was authored globally).
 */

import { describe, expect, it } from 'vitest';

import {
  CONTINUE,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
  type CardTemplate,
  type CriteriaNode,
  type Effect,
  type GameDefinition,
  type Id,
  type LogLine,
  type PlayState,
  type PlayZone,
  type PointPool,
  type RuleSet,
  type TargetSelector,
  type TriggerContext,
} from './types';
import { step } from './dispatch';
import { appendPending } from './frames';
import { evalCriteria } from './criteria';
import type { EffectContext } from './effects';
import { findReplacement } from './replacement';
import { zoneKey } from './valueRef';
import { emptyBoard, place } from '../test/board';
import { END_NODE, FIXTURE_UPDATED_AT, START_NODE } from '../test/fixtures/empty';

// ---------------------------------------------------------------------------
// Fixture — zones + one blank template. RuleSets are built per test (each test's replacement rules
// must not leak into another test's scan, so nothing here is shared global state).
// ---------------------------------------------------------------------------

const DECK = 'zone_deck';
const HAND = 'zone_hand';
const BOARD = 'zone_board';
const TABLE = 'zone_table';
const CARD = 'tpl_card';
/** A tagged, indexed template — `CARD` carries neither, and both are needed to write a `match` that
 *  reads through a BOUND `replacedTarget` (`cardTag`/`cardIndex` are §4.2's only two CardRef-bearing
 *  `ValueRef` kinds, and therefore the only two `bindValueRef` descends into). */
const BEAR = 'tpl_bear';
const WARD = 'tpl_ward';
const TWIN = 'tpl_twin';
const RS_ATTACHED = 'rs_attached';
const RS_AAA = 'rs_aaa';
const RS_ZZZ = 'rs_zzz';
const CREATURE = 'creature';
const POWER = 'idx_power';
const LIFE = 'pool_life';

const zones: PlayZone[] = [
  { id: DECK, name: 'Deck', scope: 'player', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null },
  { id: HAND, name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: null },
  { id: BOARD, name: 'Board', scope: 'player', visibility: 'faceUp', layout: 'grid', ordered: true, maxCapacity: null },
  // A SHARED zone — `candidateRuleSets` keys shared zones with a null seat and a `seat: -1` sort
  // key, a whole arm of the scan that a player-zone-only fixture never reaches.
  { id: TABLE, name: 'Table', scope: 'shared', visibility: 'faceUp', layout: 'grid', ordered: true, maxCapacity: null },
];

const pools: PointPool[] = [
  { id: LIFE, scope: 'player', value: { type: 'integer', name: 'Life', defaultValue: 0, min: null, max: null } },
];

const templates: CardTemplate[] = [
  { id: CARD, name: 'Card', marquee: 'Card', faceIcon: 'gi-card-random', borderColor: '#000000', tags: [], indexes: [], ruleSetIds: [], rulesTextOverride: null },
  {
    id: BEAR,
    name: 'Bear',
    marquee: 'Bear',
    faceIcon: 'gi-card-random',
    borderColor: '#000000',
    tags: [CREATURE],
    indexes: [{ id: POWER, value: { type: 'integer', name: 'Power', defaultValue: 2, min: null, max: null }, icon: 'gi-broadsword', position: 'bottomLeft' }],
    ruleSetIds: [],
    rulesTextOverride: null,
  },
  // Card-ATTACHED replacement rules (§5.1 scope 1). The ids are dangling in most defs below and
  // `candidateRuleSets` simply skips a template rule id it cannot resolve, so one shared template
  // array serves every test.
  { id: WARD, name: 'Ward', marquee: 'Ward', faceIcon: 'gi-card-random', borderColor: '#000000', tags: [], indexes: [], ruleSetIds: [RS_ATTACHED], rulesTextOverride: null },
  // Two attached rules on ONE card: every §5.1 sort key ties, so only the rule-id tiebreak can pick.
  { id: TWIN, name: 'Twin', marquee: 'Twin', faceIcon: 'gi-card-random', borderColor: '#000000', tags: [], indexes: [], ruleSetIds: [RS_ZZZ, RS_AAA], rulesTextOverride: null },
];

function makeDef(ruleSets: RuleSet[], globalRuleSetIds: Id[]): GameDefinition {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'game_replacement_test',
    name: 'Replacement test',
    playerCount: 2,
    pools,
    zones,
    templates,
    decks: [],
    customEvents: [],
    ruleSets,
    globalRuleSetIds,
    priorityWindows: [],
    machine: { states: [START_NODE, END_NODE], startStateId: START_STATE_ID, endStateId: END_STATE_ID },
    limits: {
      maxDepth: DEFAULT_MAX_DEPTH,
      maxEffects: DEFAULT_MAX_EFFECTS,
      maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
      maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
    },
    updatedAt: FIXTURE_UPDATED_AT,
  };
}

/** An empty board with `deckSize` dummy cards seeded into each seat's Deck. */
function board(def: GameDefinition, deckSize = 10): PlayState {
  const state = emptyBoard(def);
  for (let seat = 0; seat < def.playerCount; seat++) {
    for (let i = 0; i < deckSize; i++) place(state, def, zoneKey(DECK, seat), CARD, `card_${seat}_${i}`);
  }
  return state;
}

const lit = (value: number | boolean) => ({ kind: 'literal' as const, value });

const drawEffect = (count: number): Effect => ({
  kind: 'drawCards',
  from: { zoneId: DECK, seat: { kind: 'triggeringSeat' } },
  to: { zoneId: HAND, seat: { kind: 'triggeringSeat' } },
  count: lit(count),
});

/** A plain triggered RuleSet — the thing WHOSE effect gets intercepted. Global, so no card template
 *  wiring is needed to fire it: `onCardPlayed` is fired directly via `driveEvent` below. */
function drawRule(id: Id, count: number): RuleSet {
  return {
    id,
    name: id,
    trigger: 'onCardPlayed',
    stateFilter: null,
    condition: null,
    effects: [drawEffect(count)],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: false,
    replaces: null,
    activation: null,
  };
}

/**
 * A replacement rule. `trigger` is set to an event this file never fires — replacement scanning
 * (`replacement.ts`) never reads `RuleSet.trigger` at all, only `replaces`, so this is inert exactly
 * the way `continuous` rules' `trigger` field is inert (§4.5's "ignored" convention).
 */
function replaceRule(id: Id, priority: number, match: CriteriaNode | null, substituteCount: number): RuleSet {
  return {
    id,
    name: id,
    trigger: 'onGameStart',
    stateFilter: null,
    condition: null,
    effects: [drawEffect(substituteCount)],
    priority,
    onRejection: 'continue',
    modifier: null,
    continuous: false,
    replaces: { effectKind: 'drawCards', match },
    activation: null,
  };
}

const amountEquals = (n: number): CriteriaNode => ({
  kind: 'criteria',
  left: { kind: 'replacedAmount' },
  op: '=',
  right: lit(n),
});

// ---------------------------------------------------------------------------
// Driver — same shape as dispatch.test.ts's, duplicated locally (that file is off-limits for this
// step; a sibling agent owns steps 22/23 there).
// ---------------------------------------------------------------------------

const RUNAWAY_STEPS = 2_000_000;

function driveEvent(state: PlayState, def: GameDefinition, name: string, seat = 0): LogLine[] {
  appendPending(state, {
    kind: 'event',
    name,
    ctx: { triggeringCardId: null, zoneKey: null, triggeringSeat: seat, promptAnswers: {}, sourceCardId: null },
    bindings: [],
    cursor: -1,
    parentId: null,
    depth: 1,
  });
  const lines: LogLine[] = [];
  let result = step(state, CONTINUE, lines, def);
  let steps = 1;
  while (!result.done) {
    if (++steps > RUNAWAY_STEPS) throw new Error('driver runaway — the loop guard did not stop the chain');
    result = step(state, CONTINUE, lines, def);
  }
  return lines;
}

const drawLines = (lines: LogLine[]) => lines.filter((l) => l.kind === 'effect' && l.effectKind === 'drawCards');
const HAND0 = zoneKey(HAND, 0);

// ---------------------------------------------------------------------------
// AC MTG10 / §9.4(d) — the substitution happens once, in place of the original, before any card
// moves, and the log distinguishes the replaced original from the applied substitute.
// ---------------------------------------------------------------------------

describe('effect replacement — AC MTG10 / §9.4(d)', () => {
  // AC: MTG10 — a draw becomes two; substitution before any card moves; log distinguishes original
  // from substitute. Exactly 2 cards move, never 3, never 4, never 2-then-3 (the competing rule).
  it('drawCards(count:1) becomes drawCards(count:2), never count:4, and a lower-priority competing rule never wins or chains', () => {
    const drawOne = drawRule('rs_draw_one', 1);
    // Higher §5.1 priority — wins "first match wins" over drawThreeInstead for the ORIGINAL effect.
    const drawTwoInstead = replaceRule('rs_draw_two_instead', 10, null, 2);
    // Lower §5.1 priority AND scoped to count:1 specifically, so it never re-matches the count:2
    // substitute either (2 !== 1) — see the file-level note above `replaceRule` about `match`.
    const drawThreeInstead = replaceRule('rs_draw_three_instead', 0, amountEquals(1), 3);

    const def = makeDef(
      [drawOne, drawTwoInstead, drawThreeInstead],
      [drawOne.id, drawTwoInstead.id, drawThreeInstead.id]
    );
    const state = board(def);

    const lines = driveEvent(state, def, 'onCardPlayed', 0);

    // The hard requirement: exactly 2 cards moved. Never 1 (unreplaced), never 3, never 4
    // (drawTwoInstead re-matching its own output), never 5 (2 then 3).
    expect(state.zones[HAND0].cardIds).toHaveLength(2);

    // Exactly two distinguishable lines (§5.7's own wording) — a literal string check, not a
    // paraphrase. `drawLines` already narrows to `kind:'effect', effectKind:'drawCards'`, so this
    // count alone proves no THIRD drawCards line (from drawThreeInstead) ever fired.
    const draws = drawLines(lines);
    expect(draws).toHaveLength(2);

    const [original, substitute] = draws;
    expect(original.message).toContain('drawCards(count:1)');
    expect(original.message).toContain('replaced by RuleSet "rs_draw_two_instead"');
    expect(original.message).toContain('Not applied.');
    expect(original.message).not.toContain('replaced by RuleSet "rs_draw_three_instead"');

    expect(substitute.message).toContain('Draw 2 from');
    expect(substitute.message).not.toContain('replaced');

    // Belt-and-braces: nowhere in the whole transaction's log does an actual "Draw 3" or "Draw 4"
    // line appear — drawThreeInstead's id may be NAMED (in the "not applied" line above) but its
    // effects never RUN.
    expect(lines.some((l) => l.message.includes('Draw 3'))).toBe(false);
    expect(lines.some((l) => l.message.includes('Draw 4'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §9.5 edge case 7 — the design doc leaves open whether a SECOND, distinct replacement rule may
// intercept the substitute a FIRST rule just produced. Decided here, not derived from the spec.
// ---------------------------------------------------------------------------

describe('§9.5 edge case 7 — a second, distinct replacement rule intercepting a substitute', () => {
  it(
    // DESIGNED CHOICE, pinned down by this test — not behaviour the spec mandates. §5.7 only says a
    // rule cannot re-match its OWN substitute ("draw two instead" cannot recurse into itself); it is
    // silent on whether a DIFFERENT rule may catch what the first produced. This file's answer: yes,
    // once — `replacedBy`/`excluded` ACCUMULATES every rule that has fired anywhere in this effect's
    // chain (not just the immediate replacer), so the chain is bounded by the number of distinct
    // replacement rules a definition authors, never by a cycle. If this reading is ever flipped
    // (e.g. "at most one substitution total, full stop"), update this comment, not just the
    // assertions below — a future reader must not mistake this for spec-derived behaviour.
    'a distinct rule may intercept a substitute exactly once; the chain terminates by rule count, not a cycle guard',
    () => {
      const drawOne = drawRule('rs_draw_one', 1);
      const replaceA = replaceRule('rs_replace_a', 10, null, 2); // any draw of 1 -> draw of 2
      const replaceB = replaceRule('rs_replace_b', 5, amountEquals(2), 5); // specifically a draw of 2 -> draw of 5

      const def = makeDef([drawOne, replaceA, replaceB], [drawOne.id, replaceA.id, replaceB.id]);
      const state = board(def, 10);

      const lines = driveEvent(state, def, 'onCardPlayed', 0);

      // replaceA fires on the original (1 -> 2), replaceB fires on replaceA's substitute (2 -> 5);
      // replaceB's own substitute (count:5) matches neither rule's `match` (replaceA is excluded by
      // then, replaceB's own condition wants exactly 2) so it applies and the chain ends there.
      expect(state.zones[HAND0].cardIds).toHaveLength(5);

      const draws = drawLines(lines);
      expect(draws).toHaveLength(3); // replaced(1) -> replaced(2) -> applied(5)
      expect(draws[0].message).toContain('replaced by RuleSet "rs_replace_a"');
      expect(draws[0].message).toContain('drawCards(count:1)');
      expect(draws[1].message).toContain('replaced by RuleSet "rs_replace_b"');
      expect(draws[1].message).toContain('drawCards(count:2)');
      expect(draws[2].message).toContain('Draw 5 from');
    }
  );
});

// ---------------------------------------------------------------------------
// §9.5 edge case 14 — `replacedAmount`/`replacedTarget` outside a replacement scan, including the
// re-entrancy half: a real replacement scan running ELSEWHERE must leave nothing for an unrelated
// evaluation to pick up.
// ---------------------------------------------------------------------------

describe('§9.5 edge case 14 — replacedAmount/replacedTarget referenced outside a replacement scan', () => {
  it('fails UNBOUND_REF standalone, and still fails UNBOUND_REF after a real replacement scan has run elsewhere (no stale binding leaks)', () => {
    const def = makeDef([], []);
    const state = emptyBoard(def);
    const ctx: TriggerContext = { triggeringCardId: null, zoneKey: null, triggeringSeat: 0, promptAnswers: {}, sourceCardId: null };
    const node = amountEquals(1);

    const before = evalCriteria(node, state, ctx, def);
    expect(before.value).toBe(false);
    expect(before.leaves[0]?.error?.reason).toBe('UNBOUND_REF');

    // A wholly separate definition/state actually resolves `replacedAmount` successfully inside a
    // real replacement scan (the mechanics MTG10 above already proves work).
    const drawOne = drawRule('rs_draw_one3', 1);
    const drawTwoInstead = replaceRule('rs_draw_two_instead3', 10, null, 2);
    const liveDef = makeDef([drawOne, drawTwoInstead], [drawOne.id, drawTwoInstead.id]);
    const liveState = board(liveDef);
    driveEvent(liveState, liveDef, 'onCardPlayed', 0);
    expect(liveState.zones[zoneKey(HAND, 0)].cardIds).toHaveLength(2);

    // Re-entrancy: evaluating the SAME unbound node against the ORIGINAL state/def afterward gives
    // the identical answer — nothing from the other scan leaked in.
    const after = evalCriteria(node, state, ctx, def);
    expect(after.value).toBe(false);
    expect(after.leaves[0]?.error?.reason).toBe('UNBOUND_REF');
  });
});

// ---------------------------------------------------------------------------
// findReplacement — direct, dispatch-free unit coverage of §5.1 ordering and the exclusion set.
// ---------------------------------------------------------------------------

describe('findReplacement — §5.1 ordering, in isolation from the substitution recursion', () => {
  function ec(def: GameDefinition, state: PlayState): EffectContext {
    return {
      state,
      def,
      ctx: { triggeringCardId: null, zoneKey: null, triggeringSeat: 0, promptAnswers: {}, sourceCardId: null },
      depth: 0,
      override: false,
      log: () => {},
      fireEvent: () => {},
    };
  }

  it('the highest-priority matching rule wins, not authoring order', () => {
    const low = replaceRule('rs_low', 0, null, 9);
    const high = replaceRule('rs_high', 10, null, 2);
    // authored with the LOW-priority rule listed first, to prove order-in-array is not the tiebreak
    const def = makeDef([low, high], [low.id, high.id]);
    const state = board(def);
    expect(findReplacement(drawEffect(1), ec(def, state), {})?.id).toBe('rs_high');
  });

  it('a rule id present in `excluded` is skipped even when it would otherwise win', () => {
    const only = replaceRule('rs_only', 0, null, 2);
    const def = makeDef([only], [only.id]);
    const state = board(def);
    const c = ec(def, state);
    expect(findReplacement(drawEffect(1), c, {})?.id).toBe('rs_only');
    expect(findReplacement(drawEffect(1), c, { rs_only: true })).toBeNull();
  });

  it('returns null when no rule matches the effect kind at all', () => {
    const def = makeDef([], []);
    const state = board(def);
    expect(findReplacement(drawEffect(1), ec(def, state), {})).toBeNull();
  });

  it("a non-null `match` gates the rule — it must actually evaluate true against the bound `replacedAmount`", () => {
    const onlyTwos = replaceRule('rs_only_twos', 0, amountEquals(2), 9);
    const def = makeDef([onlyTwos], [onlyTwos.id]);
    const state = board(def);
    const c = ec(def, state);
    expect(findReplacement(drawEffect(1), c, {})).toBeNull(); // count:1, rule wants count:2
    expect(findReplacement(drawEffect(2), c, {})?.id).toBe('rs_only_twos');
  });
});

// ---------------------------------------------------------------------------
// §5.7 / §4.2 — the OTHER four interceptable kinds, and the `replacedTarget` half of the binding.
//
// Everything above this line is scoped to `drawCards`, which has no `target` at all — so
// `singleTargetId`/`bindCardRef` (the whole target half of `bindingFor`) were never once executed,
// and `describeEffect` only ever named one of its five kinds. This section drives the other four
// through the real dispatcher and pins the documented zero/many fallback as behaviour rather than
// as a comment.
// ---------------------------------------------------------------------------

const BOARD0 = zoneKey(BOARD, 0);
const LIFE_GAIN = 7;

/** The substitute used throughout this section: "gain 7 life". Chosen because it touches NEITHER the
 *  board nor the hand, so "was the original replaced?" and "what did the original do?" stay
 *  independently observable in one run. */
const gainLife: Effect = {
  kind: 'changePool',
  poolId: LIFE,
  seat: { kind: 'triggeringSeat' },
  op: 'add',
  amount: lit(LIFE_GAIN),
};

const everythingOnBoard: TargetSelector = {
  kind: 'allInZone',
  zone: { zoneId: BOARD, seat: { kind: 'triggeringSeat' } },
};

/** A triggered rule whose one effect is the thing under interception. */
function victimRule(id: Id, effect: Effect): RuleSet {
  return { ...drawRule(id, 1), effects: [effect] };
}

/** A replacement rule intercepting `effectKind` and substituting `gainLife`. */
function interceptRule(id: Id, effectKind: Effect['kind'], match: CriteriaNode | null): RuleSet {
  return { ...replaceRule(id, 0, match, 1), effects: [gainLife], replaces: { effectKind, match } };
}

/** `cardTag(replacedTarget, 'creature') = true` — only satisfiable when a target actually BOUND. */
const targetIsCreature: CriteriaNode = {
  kind: 'criteria',
  left: { kind: 'cardTag', card: { kind: 'replacedTarget' }, tag: CREATURE },
  op: '=',
  right: lit(true),
};

/** Runs one interception and reports both halves: did the substitute fire, and what did the log say. */
function intercept(victim: Effect, rule: RuleSet, bears: number): { life: number; lines: LogLine[]; state: PlayState } {
  const trigger = victimRule('rs_victim', victim);
  const def = makeDef([trigger, rule], [trigger.id, rule.id]);
  const state = board(def);
  for (let i = 0; i < bears; i++) place(state, def, BOARD0, BEAR, `bear_${i}`);
  const lines = driveEvent(state, def, 'onCardPlayed', 0);
  return { life: state.playerPools[LIFE][0] as number, lines, state };
}

const replacedLine = (lines: LogLine[]) => lines.find((l) => l.message.includes('replaced by RuleSet'));

describe('§5.7 — the target half of the binding (`replacedTarget`)', () => {
  it('binds when the intercepted effect resolves to EXACTLY one card, so a `cardTag` match on `replacedTarget` can pass', () => {
    const rule = interceptRule('rs_shield', 'destroyCards', targetIsCreature);
    const { life, lines, state } = intercept({ kind: 'destroyCards', target: everythingOnBoard }, rule, 1);

    // Replaced: the bear is still on the board and the substitute ran instead.
    expect(state.zones[BOARD0].cardIds).toHaveLength(1);
    expect(life).toBe(LIFE_GAIN);
    expect(replacedLine(lines)?.message).toContain('destroyCards: replaced by RuleSet "rs_shield"');
  });

  it.each([
    ['zero', 0],
    ['many', 2],
  ])('leaves `replacedTarget` UNBOUND when the selector resolves to %s cards, so the match cannot pass', (_label, bears) => {
    const rule = interceptRule('rs_shield', 'destroyCards', targetIsCreature);
    const { life, lines, state } = intercept({ kind: 'destroyCards', target: everythingOnBoard }, rule, bears);

    // NOT replaced — the documented ponytail fallback. The original applied: every bear is gone.
    expect(state.zones[BOARD0].cardIds).toHaveLength(0);
    expect(life).toBe(0);
    expect(replacedLine(lines)).toBeUndefined();
  });

  it('binds through `cardIndex` too, and `setCardIndex` binds an amount AND a target in the same rule', () => {
    const powerIsTwo: CriteriaNode = {
      kind: 'criteria',
      left: { kind: 'cardIndex', card: { kind: 'replacedTarget' }, indexId: POWER },
      op: '=',
      right: lit(2),
    };
    const rule = interceptRule('rs_ward', 'setCardIndex', powerIsTwo);
    const { life, lines, state } = intercept(
      { kind: 'setCardIndex', target: everythingOnBoard, indexId: POWER, op: 'add', amount: lit(3) },
      rule,
      1
    );

    expect(state.cards.bear_0.indexValues[POWER]).toBe(2); // never got its +3
    expect(life).toBe(LIFE_GAIN);
    expect(replacedLine(lines)?.message).toContain(`setCardIndex(${POWER}, add 3): replaced by`);
  });

  it('binds for `moveCards`, which has a target but no amount', () => {
    const rule = interceptRule('rs_anchor', 'moveCards', targetIsCreature);
    const { life, lines, state } = intercept(
      { kind: 'moveCards', target: everythingOnBoard, to: { zoneId: HAND, seat: { kind: 'triggeringSeat' } }, position: 'top' },
      rule,
      1
    );

    expect(state.zones[BOARD0].cardIds).toHaveLength(1); // never moved
    expect(state.zones[HAND0].cardIds).toHaveLength(0);
    expect(life).toBe(LIFE_GAIN);
    expect(replacedLine(lines)?.message).toContain(`moveCards(→ ${HAND}): replaced by`);
  });
});

describe('§5.7 — binding into a nested match, and an amount that is not a literal', () => {
  it('descends into a criteria GROUP, and leaves `replacedAmount` alone when the intercepted kind carries no amount', () => {
    // `destroyCards` binds a target but no amount, so the `replacedAmount` leaf keeps its original
    // node and resolves UNBOUND_REF — an `or` group means the OTHER leaf can still carry the match,
    // which is the only way to observe "left alone" rather than "the whole rule silently died".
    const match: CriteriaNode = {
      kind: 'group',
      combinator: 'or',
      children: [{ kind: 'criteria', left: { kind: 'replacedAmount' }, op: '=', right: lit(1) }, targetIsCreature],
    };
    const rule = interceptRule('rs_group', 'destroyCards', match);
    const { life, lines, state } = intercept({ kind: 'destroyCards', target: everythingOnBoard }, rule, 1);

    expect(state.zones[BOARD0].cardIds).toHaveLength(1); // the creature leaf carried it
    expect(life).toBe(LIFE_GAIN);
    expect(replacedLine(lines)?.message).toContain('replaced by RuleSet "rs_group"');
  });

  it('renders a non-literal amount as its kind rather than a value — the log describes the effect, it does not resolve it', () => {
    const rule = interceptRule('rs_instead', 'changePool', null);
    const { lines } = intercept(
      { kind: 'changePool', poolId: LIFE, seat: { kind: 'triggeringSeat' }, op: 'add', amount: { kind: 'pool', poolId: LIFE, seat: { kind: 'triggeringSeat' } } },
      rule,
      0
    );

    expect(replacedLine(lines)?.message).toContain(`changePool(${LIFE}, add <pool>): replaced by`);
  });
});

describe('§5.7 — a substitute list stops at its first failing effect', () => {
  it('does not run later substitutes once one fails', () => {
    // Undocumented by §5.7 and decided in `run()`: `replaces.effects` has no `onRejection` of its
    // own to consult, so the list stops rather than pressing on. Pinned here so a change is deliberate.
    const rule: RuleSet = {
      ...interceptRule('rs_partial', 'destroyCards', null),
      effects: [{ kind: 'changePool', poolId: 'pool_does_not_exist', seat: { kind: 'triggeringSeat' }, op: 'add', amount: lit(1) }, gainLife],
    };
    const { life, lines, state } = intercept({ kind: 'destroyCards', target: everythingOnBoard }, rule, 1);

    expect(replacedLine(lines)?.message).toContain('replaced by RuleSet "rs_partial"');
    expect(state.zones[BOARD0].cardIds).toHaveLength(1); // the original still did not apply
    expect(life).toBe(0); // ...and the SECOND substitute never ran either
  });
});

describe('§5.7 — `describeEffect` names the intercepted effect in the log', () => {
  it('describes a `changePool` original by pool, op and amount', () => {
    const rule = interceptRule('rs_instead', 'changePool', null);
    const { life, lines } = intercept(
      { kind: 'changePool', poolId: LIFE, seat: { kind: 'triggeringSeat' }, op: 'add', amount: lit(5) },
      rule,
      0
    );

    // The substitute is itself a `changePool`, but `rs_instead` is excluded by then and no other
    // rule matches — so exactly one gain lands, and it is the substitute's 7, never the original's 5.
    expect(life).toBe(LIFE_GAIN);
    expect(replacedLine(lines)?.message).toContain(`changePool(${LIFE}, add 5): replaced by`);
  });

  it('falls back to the bare kind name for an effect outside §5.7’s five, and binds neither amount nor target', () => {
    // `flipCard` is not one of the five interceptable kinds — a zod refinement rejects it at import,
    // so this can only be reached by a definition built in memory, as this file builds them. The
    // fallback arms exist precisely so that stays a named no-binding case rather than a crash.
    const rule = interceptRule('rs_odd', 'flipCard', null);
    const { life, lines, state } = intercept({ kind: 'flipCard', target: everythingOnBoard, to: 'faceDown' }, rule, 1);

    expect(state.cards.bear_0.faceDown).toBe(false); // never flipped
    expect(life).toBe(LIFE_GAIN);
    expect(replacedLine(lines)?.message).toContain('flipCard: replaced by');
  });
});

// ---------------------------------------------------------------------------
// §5.1 — card-ATTACHED replacement rules and the full tiebreak chain.
//
// Every test above authors its replacement rules GLOBALLY, so `candidateRuleSets` only ever walked
// `def.globalRuleSetIds` and only ever produced scope-0 candidates all sharing one sort key. The
// zone walk — shared vs player keying, zone order, position within a zone, seat — and every
// comparator term after `priority` were dead.
// ---------------------------------------------------------------------------

describe('§5.1 — attached replacement rules and the candidate ordering', () => {
  /** A def whose replacement rules are reachable only through the cards placed on the board. */
  function attachedDef(rules: RuleSet[]): GameDefinition {
    const trigger = victimRule('rs_victim', { kind: 'destroyCards', target: everythingOnBoard });
    return makeDef([trigger, ...rules], [trigger.id]); // note: the replacement rules are NOT global
  }

  function runWith(def: GameDefinition, seed: (state: PlayState) => void): LogLine[] {
    const state = board(def);
    place(state, def, BOARD0, BEAR, 'bear_0');
    seed(state);
    return driveEvent(state, def, 'onCardPlayed', 0);
  }

  it('a rule attached to a card in a SHARED zone is a candidate', () => {
    const attached = interceptRule(RS_ATTACHED, 'destroyCards', null);
    const def = attachedDef([attached]);
    const lines = runWith(def, (state) => place(state, def, zoneKey(TABLE, null), WARD, 'ward_shared'));

    expect(replacedLine(lines)?.message).toContain(`replaced by RuleSet "${RS_ATTACHED}"`);
  });

  it('a rule attached to a card in a PLAYER zone is a candidate too', () => {
    const attached = interceptRule(RS_ATTACHED, 'destroyCards', null);
    const def = attachedDef([attached]);
    const lines = runWith(def, (state) => place(state, def, zoneKey(HAND, 1), WARD, 'ward_seat1'));

    expect(replacedLine(lines)?.message).toContain(`replaced by RuleSet "${RS_ATTACHED}"`);
  });

  it('a GLOBAL rule outranks an attached one of equal priority — scope is the tiebreak after priority', () => {
    const attached = interceptRule(RS_ATTACHED, 'destroyCards', null);
    const global = interceptRule('rs_global', 'destroyCards', null);
    expect(attached.priority).toBe(global.priority); // the premise: nothing but scope can decide

    const trigger = victimRule('rs_victim', { kind: 'destroyCards', target: everythingOnBoard });
    const def = makeDef([trigger, attached, global], [trigger.id, global.id]);
    const lines = runWith(def, (state) => place(state, def, zoneKey(TABLE, null), WARD, 'ward_shared'));

    expect(replacedLine(lines)?.message).toContain('replaced by RuleSet "rs_global"');
  });

  it('two attached rules on the SAME card tie on every key, and the rule id decides — not authoring order', () => {
    // TWIN lists RS_ZZZ first; if array order were the tiebreak, `rs_zzz` would win.
    const aaa = interceptRule(RS_AAA, 'destroyCards', null);
    const zzz = interceptRule(RS_ZZZ, 'destroyCards', null);
    const def = attachedDef([zzz, aaa]);
    const lines = runWith(def, (state) => place(state, def, zoneKey(TABLE, null), TWIN, 'twin_0'));

    expect(replacedLine(lines)?.message).toContain(`replaced by RuleSet "${RS_AAA}"`);
  });

  it('among equal-priority attached copies, the earlier zone / earlier position / lower seat wins', () => {
    // One rule, several holders — the candidate list has one entry per holder and the comparator
    // must still produce a stable, position-derived order rather than throwing or picking at random.
    const attached = interceptRule(RS_ATTACHED, 'destroyCards', null);
    const def = attachedDef([attached]);
    const lines = runWith(def, (state) => {
      place(state, def, zoneKey(HAND, 1), WARD, 'ward_seat1');
      place(state, def, zoneKey(HAND, 0), WARD, 'ward_seat0_a');
      place(state, def, zoneKey(HAND, 0), WARD, 'ward_seat0_b');
      place(state, def, zoneKey(TABLE, null), WARD, 'ward_shared');
    });

    // Whichever holder sorts first, the rule fires exactly once — the exclusion set is keyed by rule
    // id, so four copies of one rule can never chain into four substitutions.
    expect(lines.filter((l) => l.message.includes('replaced by RuleSet')).length).toBe(1);
  });
});

describe('v4 §4.1 — `arith` over `replacedAmount` inside a replacement `match`', () => {
  // "the replaced amount plus one" is the first thing anyone writes with `arith`, and the binding is
  // a SUBSTITUTION, so both operands have to be descended into or the ref resolves UNBOUND_REF.
  const amountPlusOneEquals = (n: number): CriteriaNode => ({
    kind: 'criteria',
    left: { kind: 'arith', op: 'add', left: { kind: 'replacedAmount' }, right: lit(1) },
    op: '=',
    right: lit(n),
  });

  it('substitutes into the operands of the fold, so the match sees the bound amount', () => {
    const drawOne = drawRule('rs_draw_one', 1);
    const rule = replaceRule('rs_plus_one', 0, amountPlusOneEquals(2), 3); // 1 + 1 === 2 -> fires
    const def = makeDef([drawOne, rule], [drawOne.id, rule.id]);
    const state = board(def);

    driveEvent(state, def, 'onCardPlayed', 0);
    expect(state.zones[HAND0].cardIds).toHaveLength(3);
  });

  it('does not fire when the fold evaluates to something else — the operand is really being read, not ignored', () => {
    const drawOne = drawRule('rs_draw_one', 1);
    const rule = replaceRule('rs_plus_one', 0, amountPlusOneEquals(5), 3); // 1 + 1 !== 5
    const def = makeDef([drawOne, rule], [drawOne.id, rule.id]);
    const state = board(def);

    driveEvent(state, def, 'onCardPlayed', 0);
    expect(state.zones[HAND0].cardIds).toHaveLength(1);
  });
});
