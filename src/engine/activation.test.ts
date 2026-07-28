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

describe('§9.5 edge case 12 — the runtime re-check rejects a suspending cost effect imported past the schema', () => {
  it('rejects COST_UNPAYABLE naming the offending effect, rather than suspending mid-cost', () => {
    // Hand-built PAST the schema: a real editor / RuleSetSchema could never produce this — the zod
    // refinement (schema.test.ts) already blocks it. This is exactly what imported JSON bypassing
    // the editor looks like once it reaches the engine.
    const smuggledCost: Effect[] = [
      { kind: 'chooseNumber', promptText: 'X', seat: triggeringSeat, min: lit(0), max: lit(1), key: 'x' },
    ];
    const gameDef = def([rsAbility({ costCheck: null, cost: smuggledCost })], 1);
    const state = board(gameDef, 0);
    const before = JSON.stringify(state);

    const { lines, result } = dispatchActivate(state, gameDef, 0);

    expect(result.suspended).toBe(false); // never suspends mid-cost
    expect(state.interaction).toBeNull();
    const reject = lines.find((l) => l.message.startsWith('COST_UNPAYABLE'));
    expect(reject?.message).toContain('cost effect 0');
    expect(reject?.message).toContain('chooseNumber');
    expect(JSON.stringify(state)).toBe(before);
  });

  // The positive case: "sacrifice a card of your choice as a cost" authored the SUPPORTED way — a
  // prompt in the rule's own `effects` (never in `activation.cost`, which cannot hold one), ahead of
  // the effect the sacrifice pays for. `onRejection: 'abort'` is what makes the sacrifice a genuine
  // precondition for the rest: no sacrifice, no follow-on effect.
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
