/**
 * `RuleSet.activation` / the `activate` action. TECHNICAL_DESIGN_V2.md §4.5, §5.8, §9.1 rows
 * SP7/SP8, §9.4(e), §9.5 edge case 12.
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
  type EngineInput,
  type GameDefinition,
  type LogLine,
  type PlayState,
  type PlayZone,
  type RuleSet,
  type StepResult,
} from './types';
import { step } from './dispatch';
import { deepCopyState } from './activation';
import { emptyBoard, place } from '../test/board';
import { END_NODE, FIXTURE_UPDATED_AT, START_NODE } from '../test/fixtures/empty';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const POOL = 'pool_mana';
const ATTACKERS = 'pool_attackers';
const HAND = 'zone_hand';
const BATTLEFIELD = 'zone_battlefield';
const BLANK = 'tpl_blank';

const RS_ABILITY = 'rs_ability';
const TARGET_CARD = 'sac1';

const triggeringSeat = { kind: 'triggeringSeat' as const };
const lit = (value: number | boolean) => ({ kind: 'literal' as const, value });

const costCheckPoolAtLeast2: CriteriaNode = {
  kind: 'criteria',
  left: { kind: 'pool', poolId: POOL, seat: triggeringSeat },
  op: '>=',
  right: { kind: 'literal', value: 2 },
};

const baseRule: Omit<RuleSet, 'id' | 'name' | 'trigger' | 'effects'> = {
  stateFilter: null,
  condition: null,
  priority: 0,
  onRejection: 'continue',
  modifier: null,
  continuous: false,
  replaces: null,
  activation: null,
};

/** Cost = [changePool POOL -2, moveCards(TARGET_CARD) → Battlefield] — §9.4(e)'s exact three-case
 * scenario. `costCheck` is `POOL(triggeringSeat) >= 2` unless overridden. */
function rsAbility(over: { costCheck?: CriteriaNode | null; cost?: Effect[] } = {}): RuleSet {
  return {
    ...baseRule,
    id: RS_ABILITY,
    name: 'Ability',
    trigger: 'never',
    effects: [{ kind: 'changePool', poolId: ATTACKERS, seat: triggeringSeat, op: 'add', amount: lit(1) }],
    activation: {
      costCheck: over.costCheck === undefined ? costCheckPoolAtLeast2 : over.costCheck,
      cost:
        over.cost ??
        [
          { kind: 'changePool', poolId: POOL, seat: triggeringSeat, op: 'subtract', amount: lit(2) },
          {
            kind: 'moveCards',
            // `allInZone` on seat 0's hand, which this fixture's `board()` seeds with exactly
            // `TARGET_CARD` and nothing else — TargetSelector has no "this specific card id" kind.
            target: { kind: 'allInZone', zone: { zoneId: HAND, seat: { kind: 'seat', index: 0 } } },
            to: { zoneId: BATTLEFIELD, seat: null },
            position: 'top',
          },
        ],
      window: null,
      perInstance: false,
      label: 'Ability',
    },
  };
}

const LIMITS = {
  maxDepth: DEFAULT_MAX_DEPTH,
  maxEffects: DEFAULT_MAX_EFFECTS,
  maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
  maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
};

function def(ruleSets: RuleSet[], battlefieldCapacity: number | null): GameDefinition {
  const zones: PlayZone[] = [
    { id: HAND, name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: null },
    { id: BATTLEFIELD, name: 'Battlefield', scope: 'shared', visibility: 'faceUp', layout: 'row', ordered: false, maxCapacity: battlefieldCapacity },
  ];
  const templates: CardTemplate[] = [
    { id: BLANK, name: 'Blank', marquee: 'Blank', faceIcon: 'gi-card', borderColor: '#000000', tags: [], indexes: [], ruleSetIds: [], rulesTextOverride: null },
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'game_activation',
    name: 'Activation',
    playerCount: 2,
    pools: [
      { id: POOL, scope: 'player', value: { type: 'integer', name: 'Pool', defaultValue: 5, min: 0, max: 99 } },
      { id: ATTACKERS, scope: 'player', value: { type: 'integer', name: 'Attackers', defaultValue: 0, min: 0, max: 99 } },
    ],
    zones,
    templates,
    decks: [],
    customEvents: [],
    ruleSets,
    globalRuleSetIds: [],
    priorityWindows: [],
    machine: { states: [START_NODE, END_NODE], startStateId: START_STATE_ID, endStateId: END_STATE_ID },
    limits: LIMITS,
    updatedAt: FIXTURE_UPDATED_AT,
  };
}

const HAND0 = `${HAND}#0`;
const FIELD = BATTLEFIELD;

/** A board with `TARGET_CARD` in seat 0's hand, and `battlefieldCapacity` worth of OTHER cards
 * already filling the battlefield (so a move onto it can be made to hit ZONE_FULL on demand). */
function board(gameDef: GameDefinition, fillBattlefield: number): PlayState {
  const state = emptyBoard(gameDef);
  place(state, gameDef, HAND0, BLANK, TARGET_CARD);
  for (let i = 0; i < fillBattlefield; i++) place(state, gameDef, FIELD, BLANK, `filler${i}`);
  return state;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function dispatchActivate(
  state: PlayState,
  gameDef: GameDefinition,
  seat = 0,
  cardId: string | null = null,
  override = false,
  ruleId = RS_ABILITY
): { lines: LogLine[]; result: StepResult } {
  const lines: LogLine[] = [];
  const input: EngineInput = { kind: 'action', action: { kind: 'activate', ruleId, cardId, seat }, override };
  let result = step(state, input, lines, gameDef);
  let n = 0;
  while (!result.done) {
    if (++n > 100_000) throw new Error('activation.test.ts driver runaway');
    result = step(state, CONTINUE, lines, gameDef);
  }
  return { lines, result };
}

// ---------------------------------------------------------------------------
// The deep-copy invariant the whole discard/replay mechanism relies on.
// ---------------------------------------------------------------------------

describe('deepCopyState — the §5.8 discard/replay mechanism’s one load-bearing assumption', () => {
  it('is deep-equal to the original PlayState, so a future Map/Date field fails this loudly', () => {
    const gameDef = def([rsAbility()], 1);
    const state = board(gameDef, 1);
    const copy = deepCopyState(state);
    expect(copy).toEqual(state);
    expect(copy).not.toBe(state); // genuinely a different object graph, not the same reference
  });
});

// ---------------------------------------------------------------------------
// AC: SP7 — cost precondition requiring 2, only 1 available → nothing runs, nothing spent, cost named.
// ---------------------------------------------------------------------------

describe('AC: SP7 — a false costCheck rejects COST_UNPAYABLE with nothing run or spent', () => {
  // AC: SP7
  it('rejects COST_UNPAYABLE, names the failing check, and mutates nothing', () => {
    const gameDef = def([rsAbility()], 1);
    const state = board(gameDef, 0);
    state.playerPools[POOL][0] = 1; // only 1 available, costCheck wants >= 2
    const before = JSON.stringify(state);

    const { lines, result } = dispatchActivate(state, gameDef, 0);

    expect(result.suspended).toBe(false);
    const reject = lines.filter((l) => l.message.startsWith('COST_UNPAYABLE'));
    expect(reject).toHaveLength(1);
    expect(reject[0].message).toContain('cost precondition failed');
    // Nothing at all ran — not the pool spend, not the move, not the ability's own effect.
    expect(JSON.stringify(state)).toBe(before);
    expect(lines.some((l) => l.change !== null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC: SP8 — same rule with 2 available → one transaction, cost AND effects both land.
// ---------------------------------------------------------------------------

describe('AC: SP8 — a payable cost runs, and the ability’s own effects run in the same activation', () => {
  // AC: SP8
  it('spends the cost, moves the card, and runs the ability effect — all in one activate() call', () => {
    const gameDef = def([rsAbility()], 2); // room for the incoming card
    const state = board(gameDef, 0);
    state.playerPools[POOL][0] = 2;

    const { lines, result } = dispatchActivate(state, gameDef, 0);

    expect(result.suspended).toBe(false);
    expect(state.playerPools[POOL][0]).toBe(0); // cost spent
    expect(state.zones[FIELD].cardIds).toContain(TARGET_CARD); // cost's move landed
    expect(state.playerPools[ATTACKERS][0]).toBe(1); // the ability's OWN effect ran too

    // One entry's worth of lines covers BOTH halves — the pool spend (a `changePool` change line),
    // the move (its own info line — moveCards logs no `.change` path, only pool/index writes do),
    // and the ability's own effect (a second `changePool` change line) are all in this SAME `lines`
    // array from this SAME `activate()` call (rewind proof for "one LogEntry" lives in
    // sessionStore.test.ts).
    const changes = lines.filter((l) => l.change !== null);
    expect(changes).toHaveLength(2); // the pool spend, and the ability's own pool write
    expect(lines.some((l) => l.effectKind === 'moveCards')).toBe(true);
    expect(lines.filter((l) => l.effectKind === 'changePool').map((l) => l.change?.path)).toEqual([
      `playerPools.${POOL}.0`,
      `playerPools.${ATTACKERS}.0`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// §9.4(e) — the three cases against cost = [changePool -2, moveCards → a zone at capacity].
// ---------------------------------------------------------------------------

describe('§9.4(e) — the cost transaction is all-or-nothing and discarded, not inverse-patched', () => {
  it('case 1: costCheck false — nothing in cost runs; COST_UNPAYABLE names the CHECK, not an effect', () => {
    const gameDef = def([rsAbility({ costCheck: { kind: 'criteria', left: { kind: 'literal', value: false }, op: '=', right: { kind: 'literal', value: true } } })], 1);
    const state = board(gameDef, 1); // battlefield already full — irrelevant, cost never runs
    const before = JSON.stringify(state);

    const { lines } = dispatchActivate(state, gameDef, 0);

    const reject = lines.find((l) => l.message.startsWith('COST_UNPAYABLE'));
    expect(reject?.message).toContain('cost precondition failed');
    expect(reject?.message).not.toContain('cost effect'); // names the CHECK, not an effect
    expect(JSON.stringify(state)).toBe(before);
  });

  it('case 2: costCheck true but the move hits ZONE_FULL — the pool spend is ALSO discarded, with no log line for it at all', () => {
    const gameDef = def([rsAbility()], 1);
    const state = board(gameDef, 1); // battlefield already at capacity 1
    state.playerPools[POOL][0] = 2; // costCheck passes

    const { lines } = dispatchActivate(state, gameDef, 0);

    const reject = lines.find((l) => l.message.startsWith('COST_UNPAYABLE'));
    expect(reject?.message).toContain('cost effect 1');
    expect(reject?.message).toContain('capacity'); // the moveCards rejection's own detail (ZONE_FULL)
    // The discriminating assertion (§9.4(e)): pool is at its PRE-cost value...
    expect(state.playerPools[POOL][0]).toBe(2);
    // ...and — the part an inverse-patch design would also pass — NO log line for the pool spend
    // exists at all. Nothing about `changePool`/the pool ever reached the real `lines` array.
    expect(lines.some((l) => l.effectKind === 'changePool')).toBe(false);
    expect(lines.some((l) => l.change !== null)).toBe(false);
    expect(state.zones[FIELD].cardIds).not.toContain(TARGET_CARD);
  });

  it('case 3: full success — one activation covers cost and effects; the card actually lands', () => {
    const gameDef = def([rsAbility()], 2); // room for the incoming card
    const state = board(gameDef, 1);
    state.playerPools[POOL][0] = 2;

    const { result } = dispatchActivate(state, gameDef, 0);

    expect(result.suspended).toBe(false);
    expect(state.playerPools[POOL][0]).toBe(0);
    expect(state.zones[FIELD].cardIds).toContain(TARGET_CARD);
    expect(state.playerPools[ATTACKERS][0]).toBe(1);
    // Case 3's rewind half (one-step restore, no partial-restore intermediate state reachable from
    // any rewind point) belongs in sessionStore.test.ts, per §9.4(e)'s own file split.
  });
});

// ---------------------------------------------------------------------------
// §9.5 edge case 12 — the runtime re-check for a cost effect that could suspend, built past the
// schema exactly as imported JSON would arrive (schema.test.ts already covers the zod refinement
// itself — enforcement layer (i); this is layer (ii)).
// ---------------------------------------------------------------------------

describe('§9.5 edge case 12 — the runtime re-check rejects an UNFREEZABLE cost effect imported past the schema', () => {
  it('rejects COST_UNPAYABLE naming the offending effect, rather than suspending mid-cost', () => {
    // Hand-built PAST the schema: a real editor / RuleSetSchema could never produce this — the zod
    // refinement (schema.test.ts) already blocks it. This is exactly what imported JSON bypassing
    // the editor looks like once it reaches the engine.
    //
    // v4 §4.5.0(c) — `chooseMode` rather than `chooseNumber`: the ban narrowed to the three kinds the
    // two-pass cost genuinely cannot freeze, and `chooseNumber` in a cost is now supported (see the
    // SP18 block below). This layer (ii) check has to name one that is still refused.
    const smuggledCost: Effect[] = [
      { kind: 'chooseMode', promptText: 'X', seat: triggeringSeat, modes: [] },
    ];
    const gameDef = def([rsAbility({ costCheck: null, cost: smuggledCost })], 1);
    const state = board(gameDef, 0);
    const before = JSON.stringify(state);

    const { lines, result } = dispatchActivate(state, gameDef, 0);

    expect(result.suspended).toBe(false); // never suspends mid-cost
    expect(state.interaction).toBeNull();
    const reject = lines.find((l) => l.message.startsWith('COST_UNPAYABLE'));
    expect(reject?.message).toContain('cost effect 0');
    expect(reject?.message).toContain('chooseMode');
    expect(JSON.stringify(state)).toBe(before);
  });

  // The v2 workaround, kept as a regression test: "sacrifice a card of your choice as a cost" written
  // as a prompt in the rule's own `effects`, ahead of the effect the sacrifice pays for, with
  // `onRejection: 'abort'` making the sacrifice a genuine precondition for the rest. v4 §4.5 makes the
  // direct spelling work too (the SP18 block below) but does not break this one, and plenty of
  // authored content is shaped this way — `holdem.ts`'s bet/call/raise among it.
  it('the supported pattern — a prompt in `effects`, ahead of the effect it gates — works end to end', () => {
    const rsSacrifice: RuleSet = {
      ...baseRule,
      id: RS_ABILITY,
      name: 'Sacrifice Ability',
      trigger: 'never',
      onRejection: 'abort',
      effects: [
        {
          kind: 'destroyCards',
          target: { kind: 'prompt', from: { kind: 'allInZone', zone: { zoneId: HAND, seat: { kind: 'seat', index: 0 } } }, count: lit(1), promptText: 'Sacrifice a card' },
        },
        { kind: 'changePool', poolId: ATTACKERS, seat: triggeringSeat, op: 'add', amount: lit(1) },
      ],
      activation: { costCheck: null, cost: [], window: null, perInstance: false, label: 'Sacrifice' },
    };
    const gameDef = def([rsSacrifice], 1);
    const state = board(gameDef, 0);

    const { result } = dispatchActivate(state, gameDef, 0);
    expect(result.suspended).toBe(true);
    expect(state.interaction?.kind).toBe('chooseCards');
    const interaction = state.interaction!;
    if (interaction.kind !== 'chooseCards') throw new Error('unreachable');
    expect(interaction.candidates).toEqual([TARGET_CARD]);

    const lines: LogLine[] = [];
    let result2 = step(state, { kind: 'action', action: { kind: 'answerPrompt', chosen: [TARGET_CARD] }, override: false }, lines, gameDef);
    let n = 0;
    while (!result2.done) {
      if (++n > 100_000) throw new Error('runaway');
      result2 = step(state, CONTINUE, lines, gameDef);
    }
    expect(state.cards[TARGET_CARD]).toBeUndefined(); // sacrificed
    expect(state.playerPools[ATTACKERS][0]).toBe(1); // the gated effect ran, because the sacrifice landed
  });
});

// ---------------------------------------------------------------------------
// AC: SP18 — v4 §4.5 (G5), the two-pass interactive cost. Three separate criteria, three separate
// tests, because the sharp edge of SP18 is (c) and a shared test would let (a) and (b) carry it.
//
// The fixture is deliberately ordered against itself: the pool spend is cost effect 0 and the
// PROMPTING effect is cost effect 1. So "suspends before anything is spent" is not satisfied by
// accident (a prompt in first position would suspend before effect 0 whatever the design) — pass 1
// has to walk the whole list looking for questions before pass 2 applies any of it.
// ---------------------------------------------------------------------------

describe('AC: SP18 — an activation whose cost asks a question', () => {
  const OTHER_CARD = 'hand2';

  /** cost = [changePool POOL -2, moveCards(prompt over seat 0's hand) → Battlefield]. */
  function rsDiscardCost(abilityEffects: Effect[]): RuleSet {
    return {
      ...baseRule,
      id: RS_ABILITY,
      name: 'Discard Ability',
      trigger: 'never',
      effects: abilityEffects,
      activation: {
        costCheck: costCheckPoolAtLeast2,
        cost: [
          { kind: 'changePool', poolId: POOL, seat: triggeringSeat, op: 'subtract', amount: lit(2) },
          {
            kind: 'moveCards',
            target: {
              kind: 'prompt',
              from: { kind: 'allInZone', zone: { zoneId: HAND, seat: { kind: 'seat', index: 0 } } },
              count: lit(1),
              promptText: 'Discard a card',
            },
            to: { zoneId: BATTLEFIELD, seat: null },
            position: 'top',
          },
        ],
        window: null,
        perInstance: false,
        label: 'Ability',
      },
    };
  }

  const addAttacker: Effect[] = [
    { kind: 'changePool', poolId: ATTACKERS, seat: triggeringSeat, op: 'add', amount: lit(1) },
  ];

  /** Two cards in seat 0's hand, so the discard is a genuine CHOICE and not a foregone one. */
  function twoCardHand(gameDef: GameDefinition): PlayState {
    const state = board(gameDef, 0);
    place(state, gameDef, HAND0, BLANK, OTHER_CARD);
    state.playerPools[POOL][0] = 2;
    return state;
  }

  function answer(state: PlayState, gameDef: GameDefinition, chosen: string[]): LogLine[] {
    const lines: LogLine[] = [];
    let result = step(state, { kind: 'action', action: { kind: 'answerPrompt', chosen }, override: false }, lines, gameDef);
    let n = 0;
    while (!result.done) {
      if (++n > 100_000) throw new Error('answer driver runaway');
      result = step(state, CONTINUE, lines, gameDef);
    }
    return lines;
  }

  // AC: SP18
  it('(a) suspends on the discard choice BEFORE anything is spent', () => {
    const gameDef = def([rsDiscardCost(addAttacker)], null);
    const state = twoCardHand(gameDef);

    const { lines, result } = dispatchActivate(state, gameDef, 0);

    expect(result.suspended).toBe(true);
    const interaction = state.interaction;
    if (interaction?.kind !== 'chooseCards') throw new Error('expected a chooseCards interaction');
    expect(interaction.promptText).toBe('Discard a card');
    expect(interaction.candidates).toEqual([TARGET_CARD, OTHER_CARD]);

    // Nothing spent, nothing moved — even though the pool spend sits at cost index 0, AHEAD of the
    // effect that asked. Pass 1 raised without applying a single effect.
    expect(state.playerPools[POOL][0]).toBe(2);
    expect(state.zones[HAND0].cardIds).toEqual([TARGET_CARD, OTHER_CARD]);
    expect(state.zones[FIELD].cardIds).toEqual([]);
    expect(state.playerPools[ATTACKERS][0]).toBe(0);
    // Not one change line, and no "cost paid" line either — the transaction that suspends publishes
    // the question and nothing else (§9.4(e)'s discipline, now across a suspension).
    expect(lines.some((l) => l.change !== null)).toBe(false);
    expect(lines.some((l) => l.message.includes('cost paid'))).toBe(false);
    // The frame the answer will resume into.
    expect(state.stack.map((f) => f.kind)).toEqual(['activation']);
  });

  // AC: SP18
  it('(b) once answered, the WHOLE cost applies in one transaction, then the ability runs', () => {
    const gameDef = def([rsDiscardCost(addAttacker)], null);
    const state = twoCardHand(gameDef);
    dispatchActivate(state, gameDef, 0);

    const lines = answer(state, gameDef, [OTHER_CARD]);

    expect(state.interaction).toBeNull();
    expect(state.playerPools[POOL][0]).toBe(0); // cost effect 0 — the spend
    expect(state.zones[FIELD].cardIds).toEqual([OTHER_CARD]); // cost effect 1 — the chosen card only
    expect(state.zones[HAND0].cardIds).toEqual([TARGET_CARD]); // the card NOT chosen stayed put
    expect(state.playerPools[ATTACKERS][0]).toBe(1); // and the ability's own effect ran
    // One transaction: the spend, the discard and the ability's own write are all in the SAME `lines`
    // array from the SAME answer dispatch (the store-level one-LogEntry proof is in sessionStore.test.ts).
    expect(lines.filter((l) => l.effectKind === 'changePool').map((l) => l.change?.path)).toEqual([
      `playerPools.${POOL}.0`,
      `playerPools.${ATTACKERS}.0`,
    ]);
    expect(lines.some((l) => l.message.includes('cost paid'))).toBe(true);
    expect(state.stack).toEqual([]);
  });

  // AC: SP18
  it('(c) cancelled: nothing spent, no card moved, no ability effect', () => {
    const gameDef = def([rsDiscardCost(addAttacker)], null);
    const state = twoCardHand(gameDef);
    dispatchActivate(state, gameDef, 0);
    const suspendedSnapshot = JSON.stringify({ pools: state.playerPools, zones: state.zones, cards: state.cards });

    const lines: LogLine[] = [];
    let result = step(state, { kind: 'action', action: { kind: 'cancelPrompt' }, override: false }, lines, gameDef);
    let n = 0;
    while (!result.done) {
      if (++n > 100_000) throw new Error('cancel driver runaway');
      result = step(state, CONTINUE, lines, gameDef);
    }

    expect(state.interaction).toBeNull();
    expect(state.playerPools[POOL][0]).toBe(2); // not spent
    expect(state.zones[HAND0].cardIds).toEqual([TARGET_CARD, OTHER_CARD]); // no card moved
    expect(state.zones[FIELD].cardIds).toEqual([]);
    expect(state.playerPools[ATTACKERS][0]).toBe(0); // the ability itself never ran
    // The whole board is byte-identical to the moment before the answer was declined: cancelling a
    // cost is not a rollback, because there was nothing to roll back.
    expect(JSON.stringify({ pools: state.playerPools, zones: state.zones, cards: state.cards })).toBe(suspendedSnapshot);
    // The activation frame is gone — nothing is left half-activated on the stack.
    expect(state.stack.some((f) => f.kind === 'activation')).toBe(false);
    expect(lines.some((l) => l.message.includes('cost canceled — nothing spent'))).toBe(true);
    expect(lines.some((l) => l.change !== null)).toBe(false);
  });

  // v4 §4.5.0(d) — the frozen-target channel. `activation.cost` and `rule.effects` are two lists both
  // indexed from zero and the ability's `rule` frame inherits the very `ctx` the cost used, so a cost
  // answer frozen under a key `rule.effects` also reads would silently re-aim the ability's OWN first
  // effect at whatever the cost selected. This is the test that would catch it: the ability's effect 0
  // tags "everything still in hand", which is the card NOT discarded. If the cost's selection leaked,
  // the discarded card would be the tagged one and the kept card would be untouched — the exact
  // inversion of what is asserted below.
  it('(d) the cost\'s frozen selection does not leak into the ability\'s own first effect', () => {
    const tagWhatIsLeft: Effect[] = [
      {
        kind: 'setTag',
        target: { kind: 'allInZone', zone: { zoneId: HAND, seat: { kind: 'seat', index: 0 } } },
        tag: 'kept',
        on: true,
      },
    ];
    const gameDef = def([rsDiscardCost(tagWhatIsLeft)], null);
    const state = twoCardHand(gameDef);
    dispatchActivate(state, gameDef, 0);

    answer(state, gameDef, [OTHER_CARD]);

    expect(state.cards[TARGET_CARD].tags).toContain('kept'); // the card still in hand
    expect(state.cards[OTHER_CARD].tags).not.toContain('kept'); // the discarded one, NOT re-aimed at
  });

  // v4 §4.5, §4.1 — the {X} cost, the other half of what the narrowed ban admits. `chooseNumber` in a
  // cost only means anything if the ANSWER is readable afterwards, which needs the authored `key` to
  // be persisted on the activation's own ctx (not just the reserved resumption key) — so this drives
  // the amount through the cost's own second effect AND through the ability's effect.
  it('({X}) a chooseNumber cost persists its answer under the authored key, for cost and ability alike', () => {
    const x = { kind: 'promptNumber' as const, key: 'x' };
    const rsPayX: RuleSet = {
      ...baseRule,
      id: RS_ABILITY,
      name: 'Pay X',
      trigger: 'never',
      effects: [{ kind: 'changePool', poolId: ATTACKERS, seat: triggeringSeat, op: 'add', amount: x }],
      activation: {
        costCheck: null,
        cost: [
          { kind: 'chooseNumber', promptText: 'Pay how much?', seat: triggeringSeat, min: lit(0), max: lit(3), key: 'x' },
          { kind: 'changePool', poolId: POOL, seat: triggeringSeat, op: 'subtract', amount: x },
        ],
        window: null,
        perInstance: false,
        label: 'Pay X',
      },
    };
    const gameDef = def([rsPayX], null);
    const state = board(gameDef, 0);
    state.playerPools[POOL][0] = 5;

    const { result } = dispatchActivate(state, gameDef, 0);
    expect(result.suspended).toBe(true);
    const interaction = state.interaction;
    if (interaction?.kind !== 'chooseNumber') throw new Error('expected a chooseNumber interaction');
    expect([interaction.min, interaction.max]).toEqual([0, 3]);
    expect(state.playerPools[POOL][0]).toBe(5); // nothing spent yet

    const lines: LogLine[] = [];
    let r = step(state, { kind: 'action', action: { kind: 'answerNumber', value: 3 }, override: false }, lines, gameDef);
    let n = 0;
    while (!r.done) {
      if (++n > 100_000) throw new Error('runaway');
      r = step(state, CONTINUE, lines, gameDef);
    }

    expect(state.playerPools[POOL][0]).toBe(2); // the cost's own second effect read X = 3
    expect(state.playerPools[ATTACKERS][0]).toBe(3); // and so did the ability's effect
  });

  // v4 §4.5 — the backstop for a cost effect that suspends without being one of the three BANNED
  // kinds. `announceAction` is the one live case: it raises its own target prompts from inside
  // `applyEffect`, which pass 1 cannot see and cannot pre-freeze. The probe catches it (a faithful dry
  // run that suspends IS an effect that would suspend the real transaction) and refuses the cost with
  // nothing spent, rather than replaying it into a half-paid, suspended transaction.
  it('refuses a cost whose announceAction would raise its own prompt, with nothing spent', () => {
    const RS_ANNOUNCED = 'rs_announced';
    const rsAnnounced: RuleSet = {
      ...baseRule,
      id: RS_ANNOUNCED,
      name: 'Announced',
      trigger: 'never',
      effects: [
        {
          kind: 'destroyCards',
          target: {
            kind: 'prompt',
            from: { kind: 'allInZone', zone: { zoneId: HAND, seat: { kind: 'seat', index: 0 } } },
            count: lit(1),
            promptText: 'Pick a victim',
          },
        },
      ],
    };
    const rsAnnouncer: RuleSet = {
      ...baseRule,
      id: RS_ABILITY,
      name: 'Announcer',
      trigger: 'never',
      effects: [{ kind: 'changePool', poolId: ATTACKERS, seat: triggeringSeat, op: 'add', amount: lit(1) }],
      activation: {
        costCheck: null,
        cost: [
          { kind: 'changePool', poolId: POOL, seat: triggeringSeat, op: 'subtract', amount: lit(2) },
          { kind: 'announceAction', ruleId: RS_ANNOUNCED, window: null },
        ],
        window: null,
        perInstance: false,
        label: 'Announcer',
      },
    };
    const gameDef = def([rsAnnouncer, rsAnnounced], null);
    const state = twoCardHand(gameDef);
    const before = JSON.stringify(state);

    const { lines, result } = dispatchActivate(state, gameDef, 0);

    expect(result.suspended).toBe(false);
    expect(state.interaction).toBeNull();
    const reject = lines.find((l) => l.message.startsWith('COST_UNPAYABLE'));
    expect(reject?.message).toContain('cost effect 1 (announceAction)');
    expect(reject?.message).toContain('raises an interaction of its own');
    expect(JSON.stringify(state)).toBe(before); // not the pool spend at index 0, not the announce
  });
});

// ---------------------------------------------------------------------------
// §9.5 edge case 9 — override × the six new v2 RejectReasons, continued from effects.test.ts's
// `override` describe block (v1 edge case 8's table). Those five reasons don't originate in
// `applyEffect`, so they can't join that table literally; NOT_ACTIVATABLE/SEAT_ELIMINATED/
// COST_UNPAYABLE all live here, in `activation.ts`, the module that actually produces them.
// SETTLE_DIVERGED and PRIORITY_EXHAUSTED get their own tests in dispatch.test.ts/priority.test.ts,
// next to the fixtures that trip them. ACTION_COUNTERED has no producing code path anywhere in the
// engine today (grep confirms it: declared in the `RejectReason` union and in `effects.ts`'s
// `LEVEL_OF` map, but never actually returned by anything) — there is nothing to bypass or fail to
// bypass, so it is not in this table. See the implementation report for the same finding.
// ---------------------------------------------------------------------------

describe('§9.5 edge case 9 — override × NOT_ACTIVATABLE / SEAT_ELIMINATED / COST_UNPAYABLE', () => {
  const RS_WINDOWED = 'rs_windowed';

  /** Gated to a priority window that is never open in these tests (no `priority` frame is ever
   * pushed), so a free-standing `activate` always finds `windowId === null` — a mismatch with this
   * rule's `activation.window`, which is exactly §9.5 #9's "wrong window" case. */
  function rsWindowed(): RuleSet {
    return {
      ...baseRule,
      id: RS_WINDOWED,
      name: 'Windowed',
      trigger: 'never',
      effects: [{ kind: 'changePool', poolId: ATTACKERS, seat: triggeringSeat, op: 'add', amount: lit(1) }],
      activation: { costCheck: null, cost: [], window: 'w_never_open', perInstance: false, label: 'Windowed' },
    };
  }

  it('NOT_ACTIVATABLE (wrong window): override bypasses it, matching capacity/enterableFrom’s existing bypass', () => {
    const gameDef = def([rsWindowed()], 0);

    const rejected = dispatchActivate(board(gameDef, 0), gameDef, 0, null, false, RS_WINDOWED);
    expect(rejected.lines.some((l) => l.message.startsWith('NOT_ACTIVATABLE'))).toBe(true);
    expect(rejected.result.suspended).toBe(false);

    const state = board(gameDef, 0);
    const forced = dispatchActivate(state, gameDef, 0, null, true, RS_WINDOWED);
    expect(forced.lines.some((l) => l.level === 'override')).toBe(true);
    expect(forced.lines.some((l) => l.message.startsWith('NOT_ACTIVATABLE'))).toBe(false);
    expect(state.playerPools[ATTACKERS][0]).toBe(1); // the ability's own effect actually ran
  });

  it('SEAT_ELIMINATED: override bypasses it — a move/target-destination check, not a precondition', () => {
    // Targets seat 1 (fixed, never eliminated here) rather than `triggeringSeat` — §5.12 makes ANY
    // seat ref that resolves to an eliminated seat fail its OWN SEAT_ELIMINATED independently
    // (`seats.ts`), and rule-driven effects never inherit the action's override (§5.9 rows 1b/5c).
    // Using `triggeringSeat` here would conflate that unrelated, correct rejection with the one
    // this test is actually isolating: whether `activateRule`'s OWN eliminated-seat gate is
    // bypassed by override.
    const rsOtherSeat: RuleSet = {
      ...baseRule,
      id: RS_ABILITY,
      name: 'Ability',
      trigger: 'never',
      effects: [{ kind: 'changePool', poolId: ATTACKERS, seat: { kind: 'seat', index: 1 }, op: 'add', amount: lit(1) }],
      activation: { costCheck: null, cost: [], window: null, perInstance: false, label: 'Ability' },
    };
    const gameDef = def([rsOtherSeat], 0);

    const eliminated = board(gameDef, 0);
    eliminated.seatOrder = eliminated.seatOrder.filter((s) => s !== 0);
    eliminated.eliminated.push(0);

    const rejected = dispatchActivate(eliminated, gameDef, 0, null, false);
    expect(rejected.lines.some((l) => l.message.startsWith('SEAT_ELIMINATED'))).toBe(true);
    expect(rejected.result.suspended).toBe(false);

    const state = board(gameDef, 0);
    state.seatOrder = state.seatOrder.filter((s) => s !== 0);
    state.eliminated.push(0);
    const forced = dispatchActivate(state, gameDef, 0, null, true);
    expect(forced.lines.some((l) => l.level === 'override')).toBe(true);
    expect(state.playerPools[ATTACKERS][1]).toBe(1); // ran despite the ACTING seat being gone
  });

  it('COST_UNPAYABLE: override does NOT bypass it — a cost is a precondition, not a rejected move', () => {
    const gameDef = def([rsAbility()], 0);
    const state = board(gameDef, 0);
    state.playerPools[POOL][0] = 1; // costCheck wants >= 2
    const before = JSON.stringify(state);

    const { lines, result } = dispatchActivate(state, gameDef, 0, null, true); // override: true
    expect(result.suspended).toBe(false);
    expect(lines.some((l) => l.message.startsWith('COST_UNPAYABLE'))).toBe(true);
    expect(lines.some((l) => l.level === 'override')).toBe(false); // never bypassed, never logged as one
    expect(JSON.stringify(state)).toBe(before); // nothing ran, override or not
  });
});

// ---------------------------------------------------------------------------
// v4 §4.5 — a non-empty cost paid as a RESPONSE, inside an open priority window.
//
// `applyCost`'s probe refuses a cost effect that raises an interaction of its own (an
// `announceAction` whose announced rule prompts is the live case). The probe is a deep copy of the
// real state, so it inherits whatever interaction is already open — and for a response that is the
// `priority` offer of this very ability, which `payCost` deliberately does not clear until the cost
// is paid (SP18(c)). Every non-empty cost activated inside a window therefore refused itself.
//
// Nothing caught it because every window-gated activation in the repo before the Magic sample had
// `cost: []`, and a zero-length cost never enters the probe loop at all.
// ---------------------------------------------------------------------------

describe('v4 §4.5 — a cost paid as a response inside a priority window', () => {
  const WINDOW = 'w_responses';
  const RS_OPEN = 'rs_open';
  const RS_RESPOND = 'rs_respond';

  function windowedDef(): GameDefinition {
    const opener: RuleSet = {
      ...baseRule,
      id: RS_OPEN,
      name: 'Open the Window',
      trigger: 'e',
      effects: [{ kind: 'openPriority', window: WINDOW }],
    };
    const responder: RuleSet = {
      ...baseRule,
      id: RS_RESPOND,
      name: 'Respond',
      trigger: 'never',
      effects: [{ kind: 'changePool', poolId: ATTACKERS, seat: triggeringSeat, op: 'add', amount: lit(1) }],
      // A cost that asks NOTHING: the case that goes straight from `activateRule` to the probe with
      // the priority interaction still open.
      activation: {
        costCheck: costCheckPoolAtLeast2,
        cost: [{ kind: 'changePool', poolId: POOL, seat: triggeringSeat, op: 'subtract', amount: lit(2) }],
        window: WINDOW,
        perInstance: false,
        label: 'Respond',
      },
    };
    return {
      ...def([opener, responder], null),
      customEvents: ['e'],
      globalRuleSetIds: [RS_OPEN],
      priorityWindows: [
        { id: WINDOW, name: 'Responses', start: 'active', direction: 'forward', includeStart: true, passesToClose: null, collapseEmptyOffers: true },
      ],
    };
  }

  it('pays the cost and runs the ability, instead of refusing itself', () => {
    const gameDef = windowedDef();
    const state = board(gameDef, 0);
    const lines: LogLine[] = [];
    let result = step(state, { kind: 'action', action: { kind: 'fireEvent', name: 'e', seat: 0 }, override: false }, lines, gameDef);
    let n = 0;
    while (!result.done) {
      if (++n > 100_000) throw new Error('driver runaway');
      result = step(state, CONTINUE, lines, gameDef);
    }
    expect(state.interaction?.kind).toBe('priority');

    const taken = dispatchActivate(state, gameDef, 0, null, false, RS_RESPOND);

    expect(taken.lines.some((l) => l.message.startsWith('COST_UNPAYABLE'))).toBe(false);
    expect(state.playerPools[POOL][0]).toBe(3); // 5 − 2: the cost was paid
    expect(state.playerPools[ATTACKERS][0]).toBe(1); // and the ability ran
  });
});

// ---------------------------------------------------------------------------
// The definition changing UNDER a suspended activation.
//
// Not a hypothetical in this app: a suspended playtest and the authoring screens share one
// `definitionStore`, so a tester can answer a cost prompt after having edited the very rule that
// asked. Delete-protection stops the common cases, but every one of these arms is written as a
// named, non-throwing failure, and that promise is only worth something if it is exercised.
// ---------------------------------------------------------------------------

describe('§5.8 — a cost suspended mid-question, resumed against a changed definition', () => {
  const OTHER = 'hand_other';

  /** cost = [pool −2, moveCards(prompt over seat 0's hand)] — suspends on the prompt, spends nothing. */
  const promptingCost: Effect[] = [
    { kind: 'changePool', poolId: POOL, seat: triggeringSeat, op: 'subtract', amount: lit(2) },
    {
      kind: 'moveCards',
      target: {
        kind: 'prompt',
        from: { kind: 'allInZone', zone: { zoneId: HAND, seat: { kind: 'seat', index: 0 } } },
        count: lit(1),
        promptText: 'Discard a card',
      },
      to: { zoneId: BATTLEFIELD, seat: null },
      position: 'top',
    },
  ];

  /** Suspends an activation on its cost prompt and hands back the state plus the def it started under. */
  function suspended(): { state: PlayState; gameDef: GameDefinition } {
    const gameDef = def([rsAbility({ costCheck: null, cost: promptingCost })], null);
    const state = emptyBoard(gameDef);
    place(state, gameDef, HAND0, BLANK, TARGET_CARD);
    place(state, gameDef, HAND0, BLANK, OTHER);
    state.playerPools[POOL][0] = 2;

    const { result } = dispatchActivate(state, gameDef, 0);
    expect(result.suspended).toBe(true);
    expect(state.stack.map((f) => f.kind)).toEqual(['activation']);
    return { state, gameDef };
  }

  /** Answers the open prompt against `gameDef` — deliberately allowed to differ from the one that asked. */
  function answerAgainst(state: PlayState, gameDef: GameDefinition, chosen: string[]): LogLine[] {
    const lines: LogLine[] = [];
    let result = step(state, { kind: 'action', action: { kind: 'answerPrompt', chosen }, override: false }, lines, gameDef);
    let n = 0;
    while (!result.done) {
      if (++n > 100_000) throw new Error('answer driver runaway');
      result = step(state, CONTINUE, lines, gameDef);
    }
    return lines;
  }

  it('pops and says so when the rule has been deleted outright', () => {
    const { state } = suspended();
    const without: GameDefinition = { ...def([], null) };

    const lines = answerAgainst(state, without, [OTHER]);

    expect(lines.some((l) => l.level === 'error' && l.message.includes('no longer exists in this definition'))).toBe(true);
    expect(state.stack).toHaveLength(0); // popped, not left spinning
    expect(state.playerPools[POOL][0]).toBe(2); // nothing spent
  });

  it('rejects NOT_ACTIVATABLE when the rule survives but is no longer activatable', () => {
    const { state } = suspended();
    const disarmed = def([{ ...rsAbility({ costCheck: null, cost: promptingCost }), activation: null }], null);

    const lines = answerAgainst(state, disarmed, [OTHER]);

    expect(lines.some((l) => l.message.includes('no longer an activatable rule'))).toBe(true);
    expect(state.stack).toHaveLength(0);
    expect(state.playerPools[POOL][0]).toBe(2);
  });

  it('rejects COST_UNPAYABLE when the edited cost can no longer be frozen, with nothing spent', () => {
    const { state } = suspended();
    // The same layer-(ii) re-check §9.5 edge case 12 covers on the un-suspended path, now on resume:
    // the frame is popped and the whole cost is discarded rather than half-applied.
    const smuggled = def(
      [rsAbility({ costCheck: null, cost: [{ kind: 'chooseMode', promptText: 'X', seat: triggeringSeat, modes: [] }] })],
      null
    );

    const lines = answerAgainst(state, smuggled, [OTHER]);

    expect(lines.some((l) => l.message.startsWith('COST_UNPAYABLE'))).toBe(true);
    expect(state.stack).toHaveLength(0);
    expect(state.playerPools[POOL][0]).toBe(2);
    expect(state.zones[HAND0].cardIds).toEqual([TARGET_CARD, OTHER]);
  });
});

describe('§5.8 — activating something that is not an activatable rule', () => {
  it('rejects NOT_ACTIVATABLE for a rule id that does not exist at all', () => {
    const gameDef = def([rsAbility()], 1);
    const state = board(gameDef, 0);

    const { lines } = dispatchActivate(state, gameDef, 0, null, false, 'rs_nonexistent');

    expect(lines.some((l) => l.message.includes('not an activatable rule'))).toBe(true);
  });

  it('rejects NOT_ACTIVATABLE for a real rule that carries no `activation`', () => {
    const inert: RuleSet = { ...baseRule, id: 'rs_inert', name: 'Inert', trigger: 'never', effects: [] };
    const gameDef = def([rsAbility(), inert], 1);
    const state = board(gameDef, 0);

    const { lines } = dispatchActivate(state, gameDef, 0, null, false, 'rs_inert');

    expect(lines.some((l) => l.message.includes('not an activatable rule'))).toBe(true);
  });
});
