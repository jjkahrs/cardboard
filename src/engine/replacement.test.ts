/**
 * §5.7, §8 step 27, §9.1 MTG10, §9.4(d), §9.5 edge cases #7 and #14.
 *
 * A self-contained fixture, not `mtgish.ts`/`vtesish.ts` (step 32's job, and not built yet at this
 * step — §8's own note on step 32 says it "cannot come earlier"). Everything below is scoped to
 * `drawCards`, the one interceptable kind every acceptance criterion and edge case in this task
 * actually names.
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
  type RuleSet,
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
const CARD = 'tpl_card';

const zones: PlayZone[] = [
  { id: DECK, name: 'Deck', scope: 'player', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null },
  { id: HAND, name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: null },
];

const templates: CardTemplate[] = [
  { id: CARD, name: 'Card', marquee: 'Card', faceIcon: 'gi-card-random', borderColor: '#000000', tags: [], indexes: [], ruleSetIds: [], rulesTextOverride: null },
];

function makeDef(ruleSets: RuleSet[], globalRuleSetIds: Id[]): GameDefinition {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'game_replacement_test',
    name: 'Replacement test',
    playerCount: 2,
    pools: [],
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
