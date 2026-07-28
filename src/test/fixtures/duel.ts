/**
 * §9.2 `duel.ts` — the workhorse fixture. Serves S1, S2, R1–R3, M1–M5, H1, H2, A4, P2, L2.
 *
 * Frozen (§9.2). Mutating tests must `structuredClone(duel)` first.
 *
 * Every id is exported as a named const so downstream tests reference ids symbolically instead of
 * pasting string literals.
 *
 * TWO PLACES §9.2's prose could not be satisfied exactly — both are gaps in `types.ts`, not
 * shortcuts here. See the comments on `strikeRule` and `gruntRule`.
 */

import type {
  CriteriaNode,
  Deck,
  GameDefinition,
  MachineState,
  PlayZone,
  PointPool,
  CardTemplate,
  RuleSet,
} from '../../engine/types';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
} from '../../engine/types';
import { deepFreeze, END_NODE, FIXTURE_UPDATED_AT, START_NODE } from './empty';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const HP = 'pool_hp';
export const ATTACKERS = 'pool_attackers';
export const FIRST_BLOOD = 'pool_firstBlood';

export const DECK = 'zone_deck';
export const HAND = 'zone_hand';
export const BATTLEFIELD = 'zone_battlefield';
export const DISCARD = 'zone_discard';

export const STRIKE = 'tpl_strike';
export const CANTRIP = 'tpl_cantrip';
export const GRUNT = 'tpl_grunt';
export const BOMB = 'tpl_bomb';

/** The one card index in the fixture — the target for `setCardIndex` effects. */
export const POWER = 'idx_power';

export const RS_STRIKE = 'rs_strike';
export const RS_CANTRIP = 'rs_cantrip';
export const RS_GRUNT = 'rs_grunt';
export const RS_BOMB = 'rs_bomb';

export const STARTER_DECK = 'deck_starter';

export const MAIN = 'state_main';
export const COMBAT = 'state_combat';
export const END_TURN = 'state_endTurn';
export const UNTAP = 'state_untap';

/** `Grunt` carries this tag; `Bomb`'s prompt selects on it. */
export const CREATURE_TAG = 'creature';

/** `Bomb`'s prompt text — asserted by the R2 prompt tests. */
export const BOMB_PROMPT_TEXT = 'Choose a creature to destroy';

/** How many of each template the starter deck holds; 4 × 10 === 40 (S2). */
export const COPIES_PER_TEMPLATE = 10;

// ---------------------------------------------------------------------------
// Pools — §9.2: HP player int 20/0/20 · attackers player int 0/0/99 · firstBlood game boolean.
// `activePlayer` is deliberately NOT authored: the engine auto-creates it and a test asserts that.
// ---------------------------------------------------------------------------

export const pools: PointPool[] = [
  { id: HP, scope: 'player', value: { type: 'integer', name: 'HP', defaultValue: 20, min: 0, max: 20 } },
  {
    id: ATTACKERS,
    scope: 'player',
    value: { type: 'integer', name: 'Attackers', defaultValue: 0, min: 0, max: 99 },
  },
  {
    id: FIRST_BLOOD,
    scope: 'game',
    value: { type: 'boolean', name: 'First Blood', defaultValue: false },
  },
];

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export const zones: PlayZone[] = [
  { id: DECK, name: 'Deck', scope: 'player', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null },
  { id: HAND, name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: 7 },
  {
    id: BATTLEFIELD,
    name: 'Battlefield',
    scope: 'shared',
    visibility: 'faceUp',
    layout: 'row',
    ordered: false,
    maxCapacity: null,
  },
  { id: DISCARD, name: 'Discard', scope: 'player', visibility: 'faceUp', layout: 'stack', ordered: true, maxCapacity: null },
];

// ---------------------------------------------------------------------------
// RuleSets — the library (§4.7). Templates attach them by id.
// ---------------------------------------------------------------------------

/**
 * §9.2 writes this rule as `HP(triggeringSeat→next) −1`.
 *
 * **That is not expressible.** `SeatRef` (§4.2) is a flat union: `next` resolves to
 * `(activePlayer + 1) mod N` (§5.7 table), and there is no composing form such as
 * `{ kind:'next', of: SeatRef }`. `triggeringSeat` and `next` are alternatives, not composable.
 *
 * `{ kind: 'next' }` is used, which is exactly right for R1 (the only seat that plays a card is the
 * active one, and with N=2 `next` is the opponent) and is what R1's assertion — HP(seat 1) === 19,
 * HP(seat 0) === 20 — expects. It diverges from §9.2 only for an out-of-turn play, which is
 * precisely the silent-wrongness §4.2's own comment warns about. Reported as a finding.
 */
export const strikeRule: RuleSet = {
  id: RS_STRIKE,
  name: 'Strike',
  trigger: 'onCardPlayed',
  stateFilter: null,
  condition: null,
  effects: [
    {
      kind: 'changePool',
      poolId: HP,
      seat: { kind: 'next' },
      op: 'subtract',
      amount: { kind: 'literal', value: 1 },
    },
  ],
  priority: 0,
  onRejection: 'continue',
  modifier: null,
};

/** A3 asserts this rule's generated prose verbatim, so it stays one unambiguous effect. */
export const cantripRule: RuleSet = {
  id: RS_CANTRIP,
  name: 'Cantrip',
  trigger: 'onCardPlayed',
  stateFilter: null,
  condition: null,
  effects: [
    {
      kind: 'drawCards',
      from: { zoneId: DECK, seat: { kind: 'triggeringSeat' } },
      to: { zoneId: HAND, seat: { kind: 'triggeringSeat' } },
      count: { kind: 'literal', value: 2 },
    },
  ],
  priority: 0,
  onRejection: 'continue',
  modifier: null,
};

/**
 * §9.2 writes this as `onZoneEnter(Battlefield) → attackers +1`.
 *
 * **The `(Battlefield)` narrowing is not expressible.** `RuleSet` (§4.7) has `stateFilter` and
 * nothing else: no zone filter. Nor can `condition` stand in — no `ValueRef` reads
 * `TriggerContext.zoneKey`, so a criterion cannot ask "which zone fired this". So this rule fires on
 * *any* zone the Grunt enters, Hand included.
 *
 * M1 is still driven correctly (play a Grunt to the Battlefield → attackers 1 → auto-transition),
 * but a test that draws a Grunt into Hand will see attackers tick too. Reported as a finding.
 */
export const gruntRule: RuleSet = {
  id: RS_GRUNT,
  name: 'Muster',
  trigger: 'onZoneEnter',
  stateFilter: null,
  condition: null,
  effects: [
    {
      kind: 'changePool',
      poolId: ATTACKERS,
      seat: { kind: 'triggeringSeat' },
      op: 'add',
      amount: { kind: 'literal', value: 1 },
    },
  ],
  priority: 0,
  onRejection: 'continue',
  modifier: null,
};

/**
 * Effect ORDER is load-bearing: while the prompt in effect 0 is pending, effect 1 must NOT have run.
 * Do not reorder, and do not add effects between them.
 */
export const bombRule: RuleSet = {
  id: RS_BOMB,
  name: 'Bomb',
  trigger: 'onCardPlayed',
  stateFilter: null,
  condition: null,
  effects: [
    {
      kind: 'destroyCards',
      target: {
        kind: 'prompt',
        from: { kind: 'taggedInZone', zone: { zoneId: BATTLEFIELD, seat: null }, tag: CREATURE_TAG },
        count: { kind: 'literal', value: 1 },
        promptText: BOMB_PROMPT_TEXT,
      },
    },
    {
      kind: 'changePool',
      poolId: HP,
      seat: { kind: 'active' },
      op: 'subtract',
      amount: { kind: 'literal', value: 1 },
    },
  ],
  priority: 0,
  onRejection: 'continue',
  modifier: null,
};

export const ruleSets: RuleSet[] = [strikeRule, cantripRule, gruntRule, bombRule];

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const templates: CardTemplate[] = [
  {
    id: STRIKE,
    name: 'Strike',
    marquee: 'Strike',
    faceIcon: 'gi-broadsword',
    borderColor: '#9e2f26',
    tags: ['spell'],
    indexes: [],
    ruleSetIds: [RS_STRIKE],
    rulesTextOverride: null,
  },
  {
    id: CANTRIP,
    name: 'Cantrip',
    marquee: 'Cantrip',
    faceIcon: 'gi-book-cover',
    borderColor: '#26467f',
    tags: ['spell'],
    indexes: [],
    ruleSetIds: [RS_CANTRIP],
    rulesTextOverride: null,
  },
  {
    id: GRUNT,
    name: 'Grunt',
    marquee: 'Grunt',
    faceIcon: 'gi-shield',
    borderColor: '#2b6034',
    tags: [CREATURE_TAG],
    // The fixture's only card index — `setCardIndex` effects need a real indexId to point at.
    indexes: [
      {
        id: POWER,
        value: { type: 'integer', name: 'Power', defaultValue: 1, min: 0, max: 99 },
        icon: 'gi-sword-clash',
        position: 'bottomLeft',
      },
    ],
    ruleSetIds: [RS_GRUNT],
    rulesTextOverride: null,
  },
  {
    id: BOMB,
    name: 'Bomb',
    marquee: 'Bomb',
    faceIcon: 'gi-unlit-bomb',
    borderColor: '#9a6a12',
    tags: ['spell'],
    indexes: [],
    ruleSetIds: [RS_BOMB],
    rulesTextOverride: null,
  },
];

// ---------------------------------------------------------------------------
// Deck — 10 of each of the four templates === exactly 40 cards (S2).
// Targets a player-scoped zone, so it is instantiated once per seat (§4.5).
// ---------------------------------------------------------------------------

export const decks: Deck[] = [
  {
    id: STARTER_DECK,
    name: 'Starter',
    zoneId: DECK,
    entries: templates.map((t) => ({ templateId: t.id, quantity: COPIES_PER_TEMPLATE })),
  },
];

// ---------------------------------------------------------------------------
// State machine
//
// Every edge below is two-sided: A→B appears in both B.enterableFrom and A.exitableTo, so `duel`
// passes full referential validation (gate 4, §7.2). The one-sided-edge fixture M3/5b needs is a
// SEPARATE export at the bottom of this file — never `duel` itself.
//
//   start → Main, start → Untap
//   Main  → Combat, Main ⇄ EndTurn
//   Combat → EndTurn
//   EndTurn → end
//
// Main → Untap is absent from BOTH sides on purpose: that is M3's rejection.
// ---------------------------------------------------------------------------

const attackersAboveZero: CriteriaNode = {
  kind: 'criteria',
  left: { kind: 'pool', poolId: ATTACKERS, seat: { kind: 'active' } },
  op: '>',
  right: { kind: 'literal', value: 0 },
};

export const states: MachineState[] = [
  { ...START_NODE, exitableTo: [MAIN, UNTAP] },
  {
    id: MAIN,
    name: 'Main',
    enterableFrom: [START_STATE_ID, END_TURN],
    exitableTo: [COMBAT, END_TURN],
    entryCriteria: null,
    transitionLabel: 'Main Phase',
    priority: 0,
    position: { x: 200, y: 0 },
  },
  {
    id: COMBAT,
    name: 'Combat',
    enterableFrom: [MAIN],
    exitableTo: [END_TURN],
    entryCriteria: attackersAboveZero, // M1: auto-transition when attackers > 0
    transitionLabel: null,
    priority: 0,
    position: { x: 400, y: 0 },
  },
  {
    id: END_TURN,
    name: 'End Turn',
    enterableFrom: [MAIN, COMBAT],
    exitableTo: [MAIN, END_STATE_ID],
    entryCriteria: null, // M2: criteria-less ⇒ renders as the labeled button below
    transitionLabel: 'End Turn',
    priority: 0,
    position: { x: 600, y: 0 },
  },
  {
    id: UNTAP,
    name: 'Untap',
    enterableFrom: [START_STATE_ID], // M3: deliberately NOT Main
    exitableTo: [],
    entryCriteria: null,
    transitionLabel: 'Untap',
    priority: 0,
    position: { x: 200, y: -140 },
  },
  { ...END_NODE, enterableFrom: [END_TURN], position: { x: 800, y: 0 } },
];

export const duel: GameDefinition = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: 'game_duel',
  name: 'Duel',
  playerCount: 2,
  pools,
  zones,
  templates,
  decks,
  customEvents: [],
  ruleSets,
  globalRuleSetIds: [],
  machine: { states, startStateId: START_STATE_ID, endStateId: END_STATE_ID },
  limits: {
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEffects: DEFAULT_MAX_EFFECTS,
    maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
    maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
  },
  updatedAt: FIXTURE_UPDATED_AT,
});

/**
 * §9.2 / failure mode 5b — `Main.exitableTo` lists `Untap` but `Untap.enterableFrom` does not list
 * `Main`. Kept OUT of `duel` so `duel` stays referentially valid; this export exists only for the
 * one-sided-edge rejection test.
 */
export const duelOneSidedEdge: GameDefinition = deepFreeze({
  ...duel,
  id: 'game_duel_oneSided',
  name: 'Duel (one-sided edge)',
  machine: {
    ...duel.machine,
    states: states.map((s) => (s.id === MAIN ? { ...s, exitableTo: [COMBAT, END_TURN, UNTAP] } : s)),
  },
});
