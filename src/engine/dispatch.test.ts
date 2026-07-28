import { describe, expect, it } from 'vitest';

import {
  CONTINUE,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
  type CardTemplate,
  type EngineInput,
  type GameDefinition,
  type Id,
  type LogLine,
  type PlayAction,
  type PlayState,
  type PlayZone,
  type RuleSet,
  type StepResult,
} from './types';
import { enqueue, step } from './dispatch';
import { createPlayState } from './setup';
import { zoneKey } from './valueRef';
import {
  ATTACKERS,
  BATTLEFIELD,
  BOMB,
  BOMB_PROMPT_TEXT,
  duel,
  GRUNT,
  HAND,
  HP,
  MAIN,
  STRIKE,
} from '../test/fixtures/duel';
import { emptyBoard, place } from '../test/board';
import { ECHO, fanOut, mutualLoop, N, PING, selfLoop } from '../test/fixtures/loop';
import { END_NODE, FIXTURE_UPDATED_AT, START_NODE } from '../test/fixtures/empty';

// ---------------------------------------------------------------------------
// Driver — exactly what sessionStore.ts does (§3.3), minus immer.
// ---------------------------------------------------------------------------

interface Run {
  lines: LogLine[];
  result: StepResult;
  steps: number;
}

function drive(state: PlayState, def: GameDefinition, action: PlayAction, override = false): Run {
  const lines: LogLine[] = [];
  let input: EngineInput = { kind: 'action', action, override };
  let result = step(state, input, lines, def);
  let steps = 1;
  while (!result.done) {
    if (++steps > 200_000) throw new Error('driver runaway — the loop guard did not stop the chain');
    input = CONTINUE;
    result = step(state, input, lines, def);
  }
  return { lines, result, steps };
}

/**
 * Fires a CARD-BINDING event on behalf of a specific card. `PlayAction.fireEvent` carries no card,
 * and under the self-scoping rule a card-attached rule only binds for `ctx.triggeringCardId` — so
 * the realistic driver for these is either a `moveCard` action or, when the surrounding move would
 * bury the log, this: the same event work item a move would enqueue.
 */
function driveEvent(state: PlayState, def: GameDefinition, name: string, triggeringCardId: Id | null, seat = 0): Run {
  enqueue(state, {
    kind: 'event',
    name,
    ctx: { triggeringCardId, zoneKey: null, triggeringSeat: seat, promptAnswers: {} },
    parentId: null,
    depth: 1,
  });
  const lines: LogLine[] = [];
  let result = step(state, CONTINUE, lines, def);
  let steps = 1;
  while (!result.done) {
    if (++steps > 200_000) throw new Error('driver runaway');
    result = step(state, CONTINUE, lines, def);
  }
  return { lines, result, steps };
}

const kinds = (lines: LogLine[]) => lines.map((l) => `${l.level}/${l.kind}`);
const ruleLines = (lines: LogLine[]) => lines.filter((l) => l.kind === 'rule' && l.level === 'info');

/** Collapses a run of identical entries, so "one destroy" vs "two destroy lines" doesn't matter. */
const sequence = (lines: LogLine[]): string[] =>
  lines
    .filter((l) => l.kind === 'prompt' || l.effectKind !== null)
    .map((l) => l.effectKind ?? 'prompt')
    .filter((v, i, a) => v !== a[i - 1]);

// State builders — a board with nothing on it but what the test puts there — live in
// `src/test/board.ts`; the play components build the same boards.

const BF = zoneKey(BATTLEFIELD, null);
const HAND_0 = zoneKey(HAND, 0);

/** A definition with no zones, no cards and no auto-transitions — rules bind globally. */
function mini(over: Partial<GameDefinition> = {}): GameDefinition {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'game_mini',
    name: 'Mini',
    playerCount: 2,
    pools: [{ id: N, scope: 'game', value: { type: 'integer', name: 'n', defaultValue: 0, min: 0, max: null } }],
    zones: [],
    templates: [],
    decks: [],
    customEvents: ['e'],
    ruleSets: [],
    globalRuleSetIds: [],
    machine: { states: [START_NODE, END_NODE], startStateId: START_STATE_ID, endStateId: END_STATE_ID },
    limits: { maxDepth: DEFAULT_MAX_DEPTH, maxEffects: DEFAULT_MAX_EFFECTS },
    updatedAt: FIXTURE_UPDATED_AT,
    ...over,
  };
}

const sharedZone = (id: Id): PlayZone => ({
  id,
  name: id,
  scope: 'shared',
  visibility: 'faceUp',
  layout: 'row',
  ordered: true,
  maxCapacity: null,
});

const tpl = (id: Id, ruleSetIds: Id[], tags: string[] = []): CardTemplate => ({
  id,
  name: id,
  marquee: id,
  faceIcon: 'gi-x',
  borderColor: '#000000',
  tags,
  indexes: [],
  ruleSetIds,
  rulesTextOverride: null,
});

const bump = (id: string, trigger: string, extra: Partial<RuleSet> = {}): RuleSet => ({
  id,
  name: id,
  trigger,
  stateFilter: null,
  condition: null,
  effects: [{ kind: 'changePool', poolId: N, seat: null, op: 'add', amount: { kind: 'literal', value: 1 } }],
  priority: 0,
  onRejection: 'continue',
  ...extra,
});

// ---------------------------------------------------------------------------
// R1 — the smallest complete cascade
// ---------------------------------------------------------------------------

describe('AC: R1 — event → rule → change', () => {
  it('onCardPlayed → opponent HP −1, with the log shape §9.1 pins', () => {
    const state = emptyBoard(duel, MAIN);
    place(state, duel, BF, STRIKE, 'c1');

    const { lines } = driveEvent(state, duel, 'onCardPlayed', 'c1');

    expect(state.playerPools[HP]).toEqual([20, 19]);
    // The trailing line is the onPoolChanged the write itself fires (§5.1) — real, and binding
    // nothing here. The first three are R1's [event, rule, change].
    expect(kinds(lines)).toEqual(['info/event', 'info/rule', 'info/change', 'info/event']);
    expect(lines[2].change).toMatchObject({ before: 20, after: 19 });
    expect(lines[3].message).toContain('0 rules bound');
  });

  it('AC: H2 — every change line carries before/after and a rule or a manual action', () => {
    const state = emptyBoard(duel, MAIN);
    place(state, duel, BF, STRIKE, 'c1');
    const { lines } = driveEvent(state, duel, 'onCardPlayed', 'c1');
    const manual = drive(emptyBoardWithCard(), duel, { kind: 'flipCard', cardId: 'c1', to: 'toggle' });

    for (const l of [...lines, ...manual.lines].filter((l) => l.kind === 'change')) {
      expect(l.change).not.toBeNull();
      expect(l.change?.before).not.toBeUndefined();
      expect(l.change?.after).not.toBeUndefined();
      // Rule-caused lines name their rule; manual actions carry no effect at all.
      expect(l.ruleId !== null || l.effectKind === null).toBe(true);
    }
  });

  function emptyBoardWithCard(): PlayState {
    const s = emptyBoard(duel, MAIN);
    place(s, duel, BF, GRUNT, 'c1');
    return s;
  }
});

// ---------------------------------------------------------------------------
// R2 — prompt suspension (§5.4, §9.3)
// ---------------------------------------------------------------------------

describe('AC: R2 — prompt suspension', () => {
  /** §9.3's board: three Grunts and a Strike on Battlefield, a Bomb in hand, then onCardPlayed. */
  function bombBoard(): PlayState {
    const state = emptyBoard(duel, MAIN);
    place(state, duel, BF, GRUNT, 'g1');
    place(state, duel, BF, STRIKE, 's1');
    place(state, duel, BF, GRUNT, 'g2');
    place(state, duel, BF, GRUNT, 'g3');
    place(state, duel, HAND_0, BOMB, 'b1');
    place(state, duel, HAND_0, GRUNT, 'g4'); // in Hand — must NOT be a candidate
    return state;
  }

  /** The Bomb is the card played, so only ITS rule binds — the Strike's does not. */
  const play = (state: PlayState) => driveEvent(state, duel, 'onCardPlayed', 'b1');

  it('suspends with exactly the Battlefield creatures as candidates', () => {
    const state = bombBoard();
    const { result } = play(state);

    expect(result).toEqual({ done: true, suspended: true, haltedByLoopGuard: false });
    expect(state.pendingPrompt).not.toBeNull();
    expect([...state.pendingPrompt!.candidates].sort()).toEqual(['g1', 'g2', 'g3']);
    expect(state.pendingPrompt!.promptText).toBe(BOMB_PROMPT_TEXT);
    expect(state.pendingPrompt!).toMatchObject({ min: 1, max: 1, seat: 0 });
  });

  it('the DEFERRED effect has demonstrably not run', () => {
    // Asserting only "suspended" would pass an implementation that ran everything and then asked.
    const state = bombBoard();
    play(state);
    expect(state.playerPools[HP][0]).toBe(20);
    expect(Object.keys(state.cards)).toHaveLength(6);
  });

  it('resume destroys the chosen card and finishes the RuleSet in order', () => {
    const state = bombBoard();
    play(state);
    const { lines, result } = drive(state, duel, { kind: 'answerPrompt', chosen: ['g2'] });

    expect(result.suspended).toBe(false);
    expect(state.pendingPrompt).toBeNull();
    expect(state.cards['g2']).toBeUndefined();
    expect(state.cards['g1']).toBeDefined();
    expect(state.cards['g3']).toBeDefined();
    expect(state.zones[BF].cardIds).toEqual(['g1', 's1', 'g3']);
    expect(state.playerPools[HP][0]).toBe(19);
    expect(sequence(lines).slice(0, 3)).toEqual(['prompt', 'destroyCards', 'changePool']);
  });

  it.each([
    ['wrong tag', ['s1']],
    ['wrong zone', ['g4']],
    ['wrong count', ['g1', 'g3']],
    ['nonexistent', ['zzz']],
  ])('rejects an illegal answer (%s) leaving state and suspension untouched', (_label, chosen) => {
    const state = bombBoard();
    play(state);
    const before = JSON.stringify(state);

    const { lines, result } = drive(state, duel, { kind: 'answerPrompt', chosen });

    expect(JSON.stringify(state)).toBe(before);
    expect(result.suspended).toBe(true);
    expect(state.pendingPrompt).not.toBeNull();
    expect(lines[0].message).toContain('Prompt answer invalid');
  });

  it('while suspended, every other input is AWAITING_PROMPT', () => {
    const state = bombBoard();
    play(state);
    const before = JSON.stringify(state);

    for (const action of [
      { kind: 'fireEvent', name: 'onCardPlayed', seat: 0 },
      { kind: 'flipCard', cardId: 'g1', to: 'toggle' },
      { kind: 'transition', toStateId: MAIN },
      { kind: 'start' },
    ] as PlayAction[]) {
      const { lines, result } = drive(state, duel, action);
      expect(result.suspended).toBe(true);
      expect(lines[0].message).toContain('awaiting response to prompt');
    }
    expect(JSON.stringify(state)).toBe(before);
  });

  it('zero candidates: the prompt is never raised and the trailing effect still runs', () => {
    const state = emptyBoard(duel, MAIN);
    place(state, duel, BF, STRIKE, 's1'); // no creature anywhere
    place(state, duel, HAND_0, BOMB, 'b1');

    const { lines, result } = play(state);

    expect(result.suspended).toBe(false);
    expect(state.pendingPrompt).toBeNull();
    expect(lines.some((l) => l.kind === 'prompt' && l.message.includes('Prompt skipped'))).toBe(true);
    expect(state.playerPools[HP][0]).toBe(19); // the changePool after it ran anyway
  });

  it('one candidate still prompts rather than auto-selecting', () => {
    const state = emptyBoard(duel, MAIN);
    place(state, duel, BF, GRUNT, 'g1');
    place(state, duel, HAND_0, BOMB, 'b1');

    play(state);
    expect(state.pendingPrompt?.candidates).toEqual(['g1']);
    expect(state.cards['g1']).toBeDefined();
  });

  it('cancel rejects the prompting effect but the RuleSet continues', () => {
    const state = bombBoard();
    play(state);
    const { lines, result } = drive(state, duel, { kind: 'cancelPrompt' });

    expect(state.pendingPrompt).toBeNull();
    expect(state.cards['g1']).toBeDefined(); // nothing destroyed
    expect(state.playerPools[HP][0]).toBe(19); // onRejection 'continue' → effect 2 ran
    expect(lines[0]).toMatchObject({ level: 'reject', kind: 'prompt' });
    expect(lines[0].message).toContain('canceled by tester');
    // Not an override, and never flagged as one.
    expect(lines.some((l) => l.level === 'override')).toBe(false);
    expect(result.haltedByLoopGuard).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R4 — loop guard (§5.5, §9.3)
// ---------------------------------------------------------------------------

describe('AC: R4 — loop guard', () => {
  const fireLines = (lines: LogLine[], event: string) =>
    lines.filter((l) => l.kind === 'event' && l.message.includes(`"${event}"`) && l.message.includes('rules bound'));
  const loopErrors = (lines: LogLine[]) =>
    lines.filter((l) => l.level === 'error' && l.message.startsWith('Possible rule loop'));

  function timed(def: GameDefinition, event: string, override = false): Run & { ms: number; state: PlayState } {
    const state = createPlayState(def, 'seed');
    const t0 = performance.now();
    const run = drive(state, def, { kind: 'fireEvent', name: event, seat: 0 }, override);
    return { ...run, ms: performance.now() - t0, state };
  }

  /**
   * §9.3 asks these to encode "rather than hanging the browser". The deterministic proof of that is
   * that the guard TRIPS — a wall-clock bound near the real runtime is a coin flip under parallel
   * load, and a flaky test trains everyone to re-run until green. So the load-bearing assertions are
   * the counters and the halt; HANG_MS stays purely as a hang detector, which still fails instantly
   * on a genuine infinite loop (it never terminates) and never on a loaded machine.
   */
  const HANG_MS = 2000;

  it('selfLoop halts with exactly maxDepth fire lines and one RULE_LOOP error', () => {
    const run = timed(selfLoop, ECHO);
    expect(run.result.haltedByLoopGuard).toBe(true);
    expect(fireLines(run.lines, ECHO)).toHaveLength(DEFAULT_MAX_DEPTH);
    expect(loopErrors(run.lines)).toHaveLength(1);
    expect(loopErrors(run.lines)[0].message).toContain(`> limit ${DEFAULT_MAX_DEPTH}`);
    expect(run.state.queue).toEqual([]);
    expect(run.ms).toBeLessThan(HANG_MS);
  });

  it('mutualLoop halts too — a depth counter keyed on the event NAME would hang here', () => {
    const run = timed(mutualLoop, PING);
    expect(run.result.haltedByLoopGuard).toBe(true);
    expect(loopErrors(run.lines)).toHaveLength(1);
    expect(run.state.budget.causalDepth).toBe(DEFAULT_MAX_DEPTH + 1);
    expect(run.state.queue).toEqual([]);
    expect(run.ms).toBeLessThan(HANG_MS);
  });

  it('fanOut halts on the EFFECT budget, not the depth budget', () => {
    const run = timed(fanOut, 'Burst');

    expect(run.result.haltedByLoopGuard).toBe(true);
    expect(loopErrors(run.lines)).toHaveLength(1);
    expect(loopErrors(run.lines)[0].message).toContain('effectsUsed');
    // The whole point of the fixture: flat and wide, so depth never gets near its own ceiling.
    expect(run.state.budget.causalDepth).toBeLessThan(DEFAULT_MAX_DEPTH);
    expect(run.state.budget.effectsUsed).toBe(DEFAULT_MAX_EFFECTS + 1);
    expect(run.state.queue).toEqual([]);
    expect(run.ms).toBeLessThan(HANG_MS);
  });

  // §5.5 puts both ceilings in the definition because "a combo-heavy design will legitimately need
  // more than 64; the designer needs a knob, not a bug report". Every fixture sets them to exactly
  // the defaults, so configured and hardcoded are otherwise indistinguishable.
  it('honours a maxDepth raised or lowered by the definition, not DEFAULT_MAX_DEPTH', () => {
    const def: GameDefinition = { ...structuredClone(selfLoop), limits: { maxDepth: 4, maxEffects: DEFAULT_MAX_EFFECTS } };
    const run = timed(def, ECHO);

    expect(run.result.haltedByLoopGuard).toBe(true);
    expect(fireLines(run.lines, ECHO)).toHaveLength(4); // not DEFAULT_MAX_DEPTH
    expect(run.state.budget.causalDepth).toBe(5);
    expect(loopErrors(run.lines)[0].message).toContain('> limit 4');
  });

  it('honours a maxEffects set by the definition, not DEFAULT_MAX_EFFECTS', () => {
    const def: GameDefinition = { ...structuredClone(fanOut), limits: { maxDepth: DEFAULT_MAX_DEPTH, maxEffects: 20 } };
    const run = timed(def, 'Burst');

    expect(run.result.haltedByLoopGuard).toBe(true);
    expect(run.state.budget.effectsUsed).toBe(21); // not DEFAULT_MAX_EFFECTS + 1
    expect(loopErrors(run.lines)[0].message).toContain('> limit 20');
  });

  it('discards the queue, clears any suspension, and leaves the state playable', () => {
    const state = createPlayState(selfLoop, 'seed');
    drive(state, selfLoop, { kind: 'fireEvent', name: ECHO, seat: 0 });

    expect(state.queue).toEqual([]);
    expect(state.pendingPrompt).toBeNull();
    const before = state.pools[N];
    // Rolls back nothing — the world is exactly as of the last completed effect, and still drivable.
    const again = drive(state, selfLoop, { kind: 'fireEvent', name: 'unbound', seat: 0 });
    expect(again.result.haltedByLoopGuard).toBe(false);
    expect(state.pools[N]).toBe(before);
  });

  // Both counters, or override becomes "ignore all checks" one unguarded branch at a time
  // (§9.4 item 8). selfLoop trips the DEPTH guard, fanOut the EFFECT budget.
  it.each([
    ['depth', selfLoop, ECHO] as const,
    ['effect budget', fanOut, 'Burst'] as const,
  ])('override does NOT bypass the %s guard', (_label, def, event) => {
    const run = timed(def, event, true);
    expect(run.result.haltedByLoopGuard).toBe(true);
    expect(run.state.queue).toEqual([]);
    expect(loopErrors(run.lines)).toHaveLength(1);
  });

  it('a 10-deep non-looping chain completes normally', () => {
    // If the guard is set too tight the first real combo deck trips it.
    const events = Array.from({ length: 10 }, (_, i) => `e${i}`);
    const rules = events.map((e, i) =>
      bump(`rs_${e}`, e, {
        effects: [
          { kind: 'changePool', poolId: N, seat: null, op: 'add', amount: { kind: 'literal', value: 1 } },
          ...(i + 1 < events.length ? [{ kind: 'fireEvent' as const, name: events[i + 1] }] : []),
        ],
      })
    );
    const def = mini({ customEvents: events, ruleSets: rules, globalRuleSetIds: rules.map((r) => r.id) });
    const state = createPlayState(def, 'seed');

    const { result } = drive(state, def, { kind: 'fireEvent', name: 'e0', seat: 0 });

    expect(result).toEqual({ done: true, suspended: false, haltedByLoopGuard: false });
    expect(state.pools[N]).toBe(10);
    // 10 authored events at depths 1..10, plus the onPoolChanged the last write fires at 11.
    expect(state.budget.causalDepth).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// §5.2 ordering
// ---------------------------------------------------------------------------

describe('RuleSet ordering', () => {
  const zoneA = sharedZone('zA');
  const zoneB = sharedZone('zB');

  /** rs_hi has priority 1; the rest are 0 and separate only on scope, board position and id. */
  const rules = [
    bump('rs_global', 'e'),
    bump('rs_hi', 'e', { priority: 1 }),
    bump('rs_card_x', 'e'),
    bump('rs_card_y', 'e'),
  ];

  const def = mini({
    zones: [zoneA, zoneB],
    templates: [tpl('t_hi', ['rs_hi']), tpl('t_x', ['rs_card_x']), tpl('t_y', ['rs_card_y', 'rs_card_x'])],
    ruleSets: rules,
    globalRuleSetIds: ['rs_global'],
  });

  function board(d: GameDefinition): PlayState {
    const state = emptyBoard(d);
    // zB first in insertion order, so a Object.keys-driven implementation gets the zones backwards.
    place(state, d, zoneKey('zB', null), 't_y', 'cB');
    place(state, d, zoneKey('zA', null), 't_hi', 'cHi');
    place(state, d, zoneKey('zA', null), 't_x', 'cA');
    return state;
  }

  const order = (d: GameDefinition, state: PlayState) =>
    ruleLines(drive(state, d, { kind: 'fireEvent', name: 'e', seat: 0 }).lines).map(
      (l) => `${l.ruleId}${/on (\w+)/.exec(l.message)?.[1] ?? ''}`
    );

  it('priority beats scope beats board position beats id', () => {
    expect(order(def, board(def))).toEqual([
      'rs_hicHi', // priority 1 — outranks even the game-level rule
      'rs_global', // scope: game-level before card-attached
      'rs_card_xcA', // zone A (declaration order), position 1
      'rs_card_xcB', // zone B, and rs_card_x < rs_card_y on the id tiebreak
      'rs_card_ycB',
    ]);
  });

  it('is identical after a serialize/deserialize round trip with everything scrambled', () => {
    // §9.4 item 4 — object iteration order and array order must not leak into the result.
    const scrambled: GameDefinition = {
      ...(JSON.parse(JSON.stringify(def)) as GameDefinition),
      ruleSets: [...rules].reverse(),
      templates: [...def.templates].reverse(),
    };
    const state = board(scrambled);
    const reversedZones: PlayState['zones'] = {};
    for (const key of Object.keys(state.zones).reverse()) reversedZones[key] = state.zones[key];
    state.zones = reversedZones;

    expect(order(scrambled, state)).toEqual(order(def, board(def)));
  });
});

// ---------------------------------------------------------------------------
// Bindings, conditions, rejection policy — §5.2, §5.3, §5.9 rows 6/16/17
// ---------------------------------------------------------------------------

describe('bindings and rejection policy', () => {
  it('row 6 — a custom event with no bound RuleSet is not an error', () => {
    const def = mini();
    const state = createPlayState(def, 'seed');
    const { lines, result } = drive(state, def, { kind: 'fireEvent', name: 'resonate', seat: 0 });

    expect(result.haltedByLoopGuard).toBe(false);
    expect(kinds(lines)).toEqual(['info/event']);
    expect(lines[0].message).toBe('Event "resonate" fired — 0 rules bound.');
  });

  it('row 17 — a false condition skips the rule, naming the failing leaf', () => {
    const rule = bump('rs_gated', 'e', {
      condition: {
        kind: 'criteria',
        left: { kind: 'pool', poolId: N, seat: null },
        op: '>',
        right: { kind: 'literal', value: 10 },
      },
    });
    const def = mini({ ruleSets: [rule], globalRuleSetIds: [rule.id] });
    const state = createPlayState(def, 'seed');
    const { lines } = drive(state, def, { kind: 'fireEvent', name: 'e', seat: 0 });

    expect(state.pools[N]).toBe(0);
    const skip = lines.find((l) => l.kind === 'skip');
    expect(skip?.message).toContain('condition false');
    expect(skip?.message).toContain('not > 10');
  });

  it('conditions are evaluated late, so an earlier rule on the same event can gate a later one', () => {
    const setter = bump('rs_a_set', 'e'); // n: 0 → 1
    const gated = bump('rs_b_gated', 'e', {
      condition: {
        kind: 'criteria',
        left: { kind: 'pool', poolId: N, seat: null },
        op: '>=',
        right: { kind: 'literal', value: 1 },
      },
    });
    const def = mini({ ruleSets: [setter, gated], globalRuleSetIds: [setter.id, gated.id] });
    const state = createPlayState(def, 'seed');

    drive(state, def, { kind: 'fireEvent', name: 'e', seat: 0 });
    // A snapshotted condition would have seen n === 0 and skipped the second rule.
    expect(state.pools[N]).toBe(2);
  });

  // Both halves of §5.2's "bindings snapshot at frame start, existence re-validated immediately
  // before each runs" share one definition: a zone, and cards that destroy each other by tag.
  const ZR = 'zR';
  const KEY_R = zoneKey(ZR, null);
  const destroyTagged = (tag: string) => ({
    kind: 'destroyCards' as const,
    target: { kind: 'taggedInZone' as const, zone: { zoneId: ZR, seat: null }, tag },
  });
  const add = (amount: number) => ({
    kind: 'changePool' as const,
    poolId: N,
    seat: null,
    op: 'add' as const,
    amount: { kind: 'literal' as const, value: amount },
  });

  it('§9.4 item 14 — destroying the card whose RuleSet is executing does not abort it', () => {
    // Effect 2 destroys the rule's OWN source card; effect 3 must still run. Every "when this
    // dies" combo depends on this.
    const boom = bump('rs_boom', 'e', { effects: [add(1), destroyTagged('self'), add(1)] });
    const def = mini({
      zones: [sharedZone(ZR)],
      templates: [tpl('t_boom', [boom.id], ['self'])],
      ruleSets: [boom],
    });
    const state = emptyBoard(def);
    place(state, def, KEY_R, 't_boom', 'cBoom');

    drive(state, def, { kind: 'fireEvent', name: 'e', seat: 0 });

    expect(state.cards['cBoom']).toBeUndefined(); // it really did destroy itself
    expect(state.zones[KEY_R].cardIds).toEqual([]);
    expect(state.pools[N]).toBe(2); // effect 3 ran anyway — the assertion that matters
  });

  it('row 16 — a card destroyed by an EARLIER rule this event has its binding skipped', () => {
    const killer = bump('rs_a_killer', 'e', { effects: [destroyTagged('victim')] });
    const victim = bump('rs_b_victim', 'e', { effects: [add(10)] });
    const def = mini({
      zones: [sharedZone(ZR)],
      templates: [tpl('t_killer', [killer.id]), tpl('t_victim', [victim.id], ['victim'])],
      ruleSets: [killer, victim],
    });
    const state = emptyBoard(def);
    place(state, def, KEY_R, 't_killer', 'cK'); // position 0 — sorts first
    place(state, def, KEY_R, 't_victim', 'cV'); // position 1 — bound at snapshot, gone by its turn

    const { lines, result } = drive(state, def, { kind: 'fireEvent', name: 'e', seat: 0 });

    expect(result.haltedByLoopGuard).toBe(false); // skipped, never thrown
    expect(state.cards['cV']).toBeUndefined();
    expect(state.pools[N]).toBe(0); // the victim's own rule never ran
    expect(lines.filter((l) => l.kind === 'rule').map((l) => l.ruleId)).toEqual(['rs_a_killer']);
    expect(lines.find((l) => l.kind === 'skip')?.message).toBe(
      'Skipped RuleSet "rs_b_victim" on cV: card destroyed earlier this event.'
    );
  });

  it("onRejection 'abort' stops the remaining effects but keeps the applied ones", () => {
    const rule = bump('rs_abort', 'e', {
      onRejection: 'abort',
      effects: [
        { kind: 'changePool', poolId: N, seat: null, op: 'add', amount: { kind: 'literal', value: 1 } },
        { kind: 'changePool', poolId: 'nope', seat: null, op: 'add', amount: { kind: 'literal', value: 1 } },
        { kind: 'changePool', poolId: N, seat: null, op: 'add', amount: { kind: 'literal', value: 1 } },
      ],
    });
    const def = mini({ ruleSets: [rule], globalRuleSetIds: [rule.id] });
    const state = createPlayState(def, 'seed');
    const { lines } = drive(state, def, { kind: 'fireEvent', name: 'e', seat: 0 });

    expect(state.pools[N]).toBe(1); // abort is not rollback — effect 1 stays
    expect(lines.some((l) => l.kind === 'skip' && l.message.includes('aborted after effect 2'))).toBe(true);
  });

  it("onRejection 'continue' runs the effects after a rejected one", () => {
    const rule = bump('rs_continue', 'e', {
      effects: [
        { kind: 'changePool', poolId: 'nope', seat: null, op: 'add', amount: { kind: 'literal', value: 1 } },
        { kind: 'changePool', poolId: N, seat: null, op: 'add', amount: { kind: 'literal', value: 1 } },
      ],
    });
    const def = mini({ ruleSets: [rule], globalRuleSetIds: [rule.id] });
    const state = createPlayState(def, 'seed');
    drive(state, def, { kind: 'fireEvent', name: 'e', seat: 0 });
    expect(state.pools[N]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Queue mechanics — §3.3, §5.1
// ---------------------------------------------------------------------------

describe('queue mechanics', () => {
  it('step() performs exactly one unit of work and leaves the rest in state.queue', () => {
    const rule = bump('rs_one', 'e');
    const def = mini({ ruleSets: [rule], globalRuleSetIds: [rule.id] });
    const state = createPlayState(def, 'seed');
    const lines: LogLine[] = [];

    // 1: the action enqueues the event.
    expect(step(state, { kind: 'action', action: { kind: 'fireEvent', name: 'e', seat: 0 }, override: false }, lines, def).done).toBe(false);
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]).toMatchObject({ kind: 'event', name: 'e', depth: 1, parentId: null });

    // 2: the event resolves into rule work — and nothing has been applied yet.
    step(state, CONTINUE, lines, def);
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]).toMatchObject({ kind: 'rule', ruleId: 'rs_one', parentId: 0 });
    expect(state.pools[N]).toBe(0);

    // 3: the rule runs its effects.
    step(state, CONTINUE, lines, def);
    expect(state.pools[N]).toBe(1);
  });

  it('fired events go to the TAIL — breadth first, siblings before children', () => {
    // a fires b; the rules on `e` are a then z. If b jumped the queue, z would run last.
    const a = bump('rs_a', 'e', { effects: [{ kind: 'fireEvent', name: 'child' }] });
    const z = bump('rs_z', 'e');
    const child = bump('rs_child', 'child');
    const def = mini({ ruleSets: [a, z, child], globalRuleSetIds: [a.id, z.id, child.id] });
    const state = createPlayState(def, 'seed');

    const { lines } = drive(state, def, { kind: 'fireEvent', name: 'e', seat: 0 });
    expect(ruleLines(lines).map((l) => l.ruleId)).toEqual(['rs_a', 'rs_z', 'rs_child']);
  });

  it('every work item carries a parent id and depth+1 on the child', () => {
    const a = bump('rs_a', 'e', { effects: [{ kind: 'fireEvent', name: 'child' }] });
    const def = mini({ ruleSets: [a], globalRuleSetIds: [a.id] });
    const state = createPlayState(def, 'seed');
    const lines: LogLine[] = [];

    step(state, { kind: 'action', action: { kind: 'fireEvent', name: 'e', seat: 0 }, override: false }, lines, def);
    step(state, CONTINUE, lines, def); // event → rule
    const ruleItem = state.queue[0];
    step(state, CONTINUE, lines, def); // rule → fires child at tail

    expect(state.queue[0]).toMatchObject({ kind: 'event', name: 'child', depth: 2, parentId: ruleItem.id });
  });

  it('enqueue assigns deterministic ids from nextWorkId and appends', () => {
    const def = mini();
    const state = createPlayState(def, 'seed');
    enqueue(state, { kind: 'event', name: 'a', ctx: { triggeringCardId: null, zoneKey: null, triggeringSeat: 0, promptAnswers: {} }, parentId: null, depth: 1 });
    enqueue(state, { kind: 'event', name: 'b', ctx: { triggeringCardId: null, zoneKey: null, triggeringSeat: 0, promptAnswers: {} }, parentId: null, depth: 1 });

    expect(state.queue.map((w) => [w.id, (w as { name: string }).name])).toEqual([
      [0, 'a'],
      [1, 'b'],
    ]);
    expect(state.nextWorkId).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Actions — §5.1 compound order, §5.9 rows 10/15
// ---------------------------------------------------------------------------

describe('actions', () => {
  it('a card move enqueues exit → enter → played, after the card has settled', () => {
    const state = emptyBoard(duel, MAIN);
    place(state, duel, HAND_0, GRUNT, 'g1');
    const lines: LogLine[] = [];

    step(state, { kind: 'action', action: { kind: 'moveCard', cardId: 'g1', to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' }, override: false }, lines, duel);

    expect(state.zones[BF].cardIds).toEqual(['g1']); // settled BEFORE any rule runs
    expect(state.zones[HAND_0].cardIds).toEqual([]);
    expect(state.queue.map((w) => (w as { name: string }).name)).toEqual(['onZoneExit', 'onZoneEnter', 'onCardPlayed']);
  });

  it('row 15 — moving a card to the zone it occupies is a no-op with no events', () => {
    const state = emptyBoard(duel, MAIN);
    place(state, duel, BF, GRUNT, 'g1');
    const { lines } = drive(state, duel, { kind: 'moveCard', cardId: 'g1', to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' });

    expect(state.queue).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toContain('No-op, no events fired');
  });

  it('row 10 — every action after the session finishes is rejected', () => {
    const state = emptyBoard(duel, MAIN);
    state.finished = true;
    const { lines, result } = drive(state, duel, { kind: 'fireEvent', name: 'onCardPlayed', seat: 0 });

    expect(result).toEqual({ done: true, suspended: false, haltedByLoopGuard: false });
    expect(lines[0].message).toContain('Only Rewind is accepted');
    expect(state.queue).toEqual([]);
  });

  it('flip and rotate log a change line with before and after', () => {
    const state = emptyBoard(duel, MAIN);
    place(state, duel, BF, GRUNT, 'g1');

    drive(state, duel, { kind: 'flipCard', cardId: 'g1', to: 'toggle' });
    expect(state.cards['g1'].faceDown).toBe(true);
    const { lines } = drive(state, duel, { kind: 'rotateCard', cardId: 'g1', to: 'rotated' });
    expect(state.cards['g1'].rotated).toBe(true);
    expect(lines[0].change).toMatchObject({ before: false, after: true });
  });

  it('a new action resets the budget; a resume does not', () => {
    const state = emptyBoard(duel, MAIN);
    place(state, duel, BF, GRUNT, 'g1');
    place(state, duel, HAND_0, BOMB, 'b1');

    driveEvent(state, duel, 'onCardPlayed', 'b1');
    const spent = state.budget.effectsUsed;
    drive(state, duel, { kind: 'answerPrompt', chosen: ['g1'] });
    expect(state.budget.effectsUsed).toBeGreaterThan(spent);

    drive(state, duel, { kind: 'flipCard', cardId: 'b1', to: 'toggle' });
    expect(state.budget).toEqual({ causalDepth: 0, effectsUsed: 0 });
  });
});

// ---------------------------------------------------------------------------
// M5 — a finished session accepts nothing but rewind (§5.9 row 10, §9.4 item 8)
// ---------------------------------------------------------------------------

describe('AC: M5 — SESSION_FINISHED', () => {
  /** Compile-time exhaustiveness: a new PlayAction kind fails to build until it is in the table. */
  const COVERED: Record<PlayAction['kind'], true> = {
    start: true,
    moveCard: true,
    flipCard: true,
    rotateCard: true,
    transition: true,
    fireEvent: true,
    answerPrompt: true,
    cancelPrompt: true,
  };

  const actions: PlayAction[] = [
    { kind: 'start' },
    { kind: 'moveCard', cardId: 'g1', to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' },
    { kind: 'flipCard', cardId: 'g1', to: 'toggle' },
    { kind: 'rotateCard', cardId: 'g1', to: 'rotated' },
    { kind: 'transition', toStateId: MAIN },
    { kind: 'fireEvent', name: 'onCardPlayed', seat: 0 },
    { kind: 'answerPrompt', chosen: ['g1'] },
    { kind: 'cancelPrompt' },
  ];

  it('the table covers every PlayAction kind in types.ts', () => {
    expect([...new Set(actions.map((a) => a.kind))].sort()).toEqual(Object.keys(COVERED).sort());
  });

  function finishedBoard(): PlayState {
    const state = emptyBoard(duel, MAIN);
    place(state, duel, HAND_0, GRUNT, 'g1');
    state.finished = true;
    return state;
  }

  it.each(actions.flatMap((action) => [
    [action.kind, action, false] as const,
    [`${action.kind} (override)`, action, true] as const,
  ]))('%s is rejected with SESSION_FINISHED and changes nothing', (_label, action, override) => {
    const state = finishedBoard();
    const before = JSON.stringify(state);

    const { lines, result } = drive(state, duel, action, override);

    // Override is about designer intent regarding legality, not a way back into a closed session
    // (§9.4 item 8) — the guard runs before override is ever consulted.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'reject', kind: 'skip' });
    expect(lines[0].message).toBe('Session finished at "End". Only Rewind is accepted.');
    expect(result).toEqual({ done: true, suspended: false, haltedByLoopGuard: false });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('leaves the state intact for the store to rewind', () => {
    // Rewind is applied by sessionStore from the inverse patches and never reaches step(); what
    // dispatch must guarantee is that a rejected action produces NO patch to rewind past.
    const state = finishedBoard();
    const before = JSON.parse(JSON.stringify(state));
    for (const action of actions) drive(state, duel, action);

    expect(state).toEqual(before);
    expect(state.queue).toEqual([]);
    expect(state.finished).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Self-scoped card bindings — a card rule on a CARD_BINDING_EVENT fires only for its own card
// ---------------------------------------------------------------------------

describe('card-attached bindings are self-scoped under the four card events', () => {
  it('a fourth Grunt entering the Battlefield raises attackers by 1, not by 4', () => {
    // The fixture case. Grunt carries onZoneEnter → attackers +1; three copies are already there.
    const state = emptyBoard(duel, MAIN);
    for (const id of ['g1', 'g2', 'g3']) place(state, duel, BF, GRUNT, id);
    place(state, duel, HAND_0, GRUNT, 'g4');

    drive(state, duel, { kind: 'moveCard', cardId: 'g4', to: { zoneId: BATTLEFIELD, seat: null }, position: 'bottom' });

    expect(state.playerPools[ATTACKERS][0]).toBe(1);
  });

  it('a rule on card A does not fire when card B triggers the event', () => {
    const state = emptyBoard(duel, MAIN);
    place(state, duel, BF, STRIKE, 'sA'); // carries onCardPlayed → HP(next) −1
    place(state, duel, BF, STRIKE, 'sB');
    place(state, duel, BF, GRUNT, 'gC');

    const { lines } = driveEvent(state, duel, 'onCardPlayed', 'sA');

    expect(state.playerPools[HP]).toEqual([20, 19]); // one tick, not two
    expect(ruleLines(lines).map((l) => l.message)).toEqual(['RuleSet "Strike" on sA.']);
  });

  it('triggeringCard inside a rule that fires resolves to the card the rule is attached to', () => {
    // The rule flips `triggeringCard`. If binding were board-wide, the wrong card would flip.
    const flipSelf = bump('rs_flip', 'onZoneEnter', {
      effects: [{ kind: 'flipCard', target: { kind: 'triggeringCard' }, to: 'faceDown' }],
    });
    const def = mini({
      zones: [sharedZone('zR')],
      templates: [tpl('t_flip', [flipSelf.id])],
      ruleSets: [flipSelf],
    });
    const state = emptyBoard(def);
    place(state, def, zoneKey('zR', null), 't_flip', 'cA');
    place(state, def, zoneKey('zR', null), 't_flip', 'cB');

    driveEvent(state, def, 'onZoneEnter', 'cB');

    expect(state.cards['cA'].faceDown).toBe(false);
    expect(state.cards['cB'].faceDown).toBe(true);
  });

  it('a GLOBAL rule on a card event still fires once, board-wide, regardless of the trigger card', () => {
    // This is the documented way to express "whenever any creature enters…".
    const watcher = bump('rs_watch', 'onZoneEnter');
    const def = mini({ ruleSets: [watcher], globalRuleSetIds: [watcher.id] });
    const state = createPlayState(def, 'seed');

    driveEvent(state, def, 'onZoneEnter', 'anything');
    driveEvent(state, def, 'onZoneEnter', null);

    expect(state.pools[N]).toBe(2);
  });

  it('a NON-card trigger still binds every card carrying the rule, in §5.2 order', () => {
    // The half that must NOT change — over-applying the filter would silently break board sweeps.
    const sweep = bump('rs_sweep', 'e');
    const def = mini({
      zones: [sharedZone('zR')],
      templates: [tpl('t_sweep', [sweep.id])],
      ruleSets: [sweep],
    });
    const state = emptyBoard(def);
    for (const id of ['c1', 'c2', 'c3']) place(state, def, zoneKey('zR', null), 't_sweep', id);

    const { lines } = drive(state, def, { kind: 'fireEvent', name: 'e', seat: 0 });

    expect(state.pools[N]).toBe(3);
    expect(ruleLines(lines).map((l) => l.message)).toEqual([
      'RuleSet "rs_sweep" on c1.', // zone position order — §5.2 rule 3, intact
      'RuleSet "rs_sweep" on c2.',
      'RuleSet "rs_sweep" on c3.',
    ]);
  });

  it('onStateEnter binds every card carrying the rule too', () => {
    const onEnter = bump('rs_enter', 'onStateEnter');
    const def = mini({
      zones: [sharedZone('zR')],
      templates: [tpl('t_enter', [onEnter.id])],
      ruleSets: [onEnter],
    });
    const state = emptyBoard(def);
    place(state, def, zoneKey('zR', null), 't_enter', 'c1');
    place(state, def, zoneKey('zR', null), 't_enter', 'c2');

    driveEvent(state, def, 'onStateEnter', null);

    expect(state.pools[N]).toBe(2);
  });
});
