/**
 * §8 step 32 / §9.3 `vtesish.ts` — 5 seats (ring semantics need at least three distinct relative
 * positions to be meaningfully different from 2; 5 matches V10's own wording and V1/V2's
 * ring-closure asserts). Serves V1–V11, and the shared-primitive rows about seat elimination and
 * sealed choice (SP11, SP12).
 *
 * Frozen, like every other §9.2/§9.3 fixture. Mutating tests must `structuredClone(vtesish)` first.
 *
 * Scoped strictly to the cards §9.1's V rows name.
 *
 * Two more places this fixture could not satisfy §9.3's prose literally, beyond the addressing gap
 * `mtgish.ts` already documents — see `strikeResolveRule` (sealedChoice.seats cannot name an
 * arbitrary pair of seats) and the vote-tallying pools below (no ValueRef sums a card index across a
 * filtered set of cards). Summarized in the step-32 report.
 */

import type {
  CardTemplate,
  Deck,
  GameDefinition,
  MachineState,
  PlayZone,
  PointPool,
  PriorityWindow,
  RuleSet,
  ValueRef,
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

export const POOL = 'pool_pool'; // blood/pool resource — V2's oust condition, V10's threshold.
export const VOTES_FOR = 'pool_votesFor';
export const VOTES_AGAINST = 'pool_votesAgainst';
export const BLOCKED = 'pool_blocked'; // game bool — marks V4's "one seat blocks" outcome.
export const REFERENDUM_PASSED = 'pool_referendumPassed'; // game bool — V6/V7's verdict.
/**
 * V6 — "log names both resolved totals, not just the verdict." No effect in this engine can log an
 * arbitrary composed message (no such primitive exists — see the step-32 report), so the referendum
 * rules write each side's SUMMED total into its own game pool via an ordinary `changePool`, whose own
 * log line already names the pool and the resolved value. Two distinguishable lines ("Votes For
 * Total: 0 → 4.", "Votes Against Total: 0 → 0.") is the route to "the log names both totals" that
 * exists without inventing a new primitive.
 */
export const VOTES_FOR_TOTAL = 'pool_votesForTotal';
export const VOTES_AGAINST_TOTAL = 'pool_votesAgainstTotal';

export const UNCONTROLLED = 'zone_uncontrolled';
export const READY = 'zone_ready'; // V11's two ends.
export const VTES_LIBRARY = 'zone_library';
export const VTES_HAND = 'zone_hand';

export const ACTION_CARD = 'tpl_actionCard';
export const MINION = 'tpl_minion';
export const VOTE_CARD = 'tpl_voteCard';
export const EQUIPMENT = 'tpl_equipment';
export const UNIQUE_VAMPIRE = 'tpl_uniqueVampire';
export const VTES_STRIKE = 'tpl_strike';

export const MINION_TAG = 'minion';
export const UNIQUE_TAG = 'unique';

export const INFLUENCE = 'idx_influence';
export const CAPACITY = 'idx_capacity';
export const DISCIPLINE = 'idx_discipline';
export const VOTE_VALUE = 'idx_voteValue';

export const ON_UNTAP = 'onUntap';
export const ON_REFERENDUM_CLOSE = 'onReferendumClose';

export const WINDOW_BLOCK = 'win_block';

export const RS_ACTION = 'rs_action';
export const RS_ACTION_RESOLVE = 'rs_actionResolve';
export const RS_BLOCK_DECLARE = 'rs_blockDeclare';
export const RS_TICK = 'rs_tick';
export const RS_READY = 'rs_ready';
export const RS_REFERENDUM_PASS = 'rs_referendumPass';
export const RS_REFERENDUM_FAIL = 'rs_referendumFail';
export const RS_EQUIPMENT_ABILITY = 'rs_equipmentAbility';
export const RS_SEIZE = 'rs_seize';
export const VTES_RS_STRIKE = 'rs_strike';
export const RS_STRIKE_RESOLVE = 'rs_strikeResolve';

export const VTES_STARTER_DECK = 'deck_vtesishStarter';

export const VTES_MAIN = 'state_main';
export const VTES_END_TURN = 'state_endTurn';

const lit = (value: number | boolean): ValueRef => ({ kind: 'literal', value });

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

const pools: PointPool[] = [
  { id: POOL, scope: 'player', value: { type: 'integer', name: 'Pool', defaultValue: 30, min: 0, max: 30 } },
  { id: VOTES_FOR, scope: 'player', value: { type: 'integer', name: 'Votes For', defaultValue: 0, min: 0, max: 10 } },
  { id: VOTES_AGAINST, scope: 'player', value: { type: 'integer', name: 'Votes Against', defaultValue: 0, min: 0, max: 10 } },
  { id: BLOCKED, scope: 'game', value: { type: 'boolean', name: 'Blocked', defaultValue: false } },
  { id: REFERENDUM_PASSED, scope: 'game', value: { type: 'boolean', name: 'Referendum Passed', defaultValue: false } },
  { id: VOTES_FOR_TOTAL, scope: 'game', value: { type: 'integer', name: 'Votes For Total', defaultValue: 0, min: 0, max: 50 } },
  { id: VOTES_AGAINST_TOTAL, scope: 'game', value: { type: 'integer', name: 'Votes Against Total', defaultValue: 0, min: 0, max: 50 } },
];

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

const zones: PlayZone[] = [
  { id: UNCONTROLLED, name: 'Uncontrolled', scope: 'player', visibility: 'faceUp', layout: 'row', ordered: false, maxCapacity: null },
  { id: READY, name: 'Ready', scope: 'player', visibility: 'faceUp', layout: 'row', ordered: false, maxCapacity: null },
  { id: VTES_LIBRARY, name: 'Library', scope: 'player', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null },
  { id: VTES_HAND, name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: null },
];

// ---------------------------------------------------------------------------
// Priority window — start:'controllerOfAction', forward, includeStart:false. Drives V3, V4.
// ---------------------------------------------------------------------------

export const windowBlock: PriorityWindow = {
  id: WINDOW_BLOCK,
  name: 'Block Window',
  start: 'controllerOfAction',
  direction: 'forward',
  includeStart: false,
  passesToClose: null,
  collapseEmptyOffers: true,
};

const priorityWindows: PriorityWindow[] = [windowBlock];

// ---------------------------------------------------------------------------
// RuleSets
// ---------------------------------------------------------------------------

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

/**
 * The predator-referencing action card AND the block-windowed announce are one and the same card —
 * §9.3 lists them as separate bullets, but both are most naturally one action being played and
 * responded to, so this single template drives both rather than adding a second card that would
 * have no criterion of its own to be the subject of. Drives V1, V3, V4.
 */
export const actionRule: RuleSet = {
  ...baseRule,
  id: RS_ACTION,
  name: 'Predator’s Claim',
  trigger: 'onCardPlayed',
  effects: [{ kind: 'announceAction', ruleId: RS_ACTION_RESOLVE, window: WINDOW_BLOCK }],
};

/**
 * Resolve-only — reached only via a `resolve` frame. AC: V1 — `{kind:'relative', from:{kind:'owner',
 * card:{kind:'triggering'}}, offset:-1}` resolves the PREDATOR of the card's OWNER, which stays
 * correct however far the active seat is from the triggering seat (`resolve`'s `ctx` carries the
 * announce-time `ctx` forward — `pending.ts`'s `announceAction` — so `triggering` still names the
 * action card here, exactly as it does at announce time).
 */
export const actionResolveRule: RuleSet = {
  ...baseRule,
  id: RS_ACTION_RESOLVE,
  name: 'Predator’s Claim (resolve)',
  trigger: 'never_actionResolve',
  effects: [
    {
      kind: 'changePool',
      poolId: POOL,
      seat: { kind: 'relative', from: { kind: 'owner', card: { kind: 'triggering' } }, offset: -1 },
      op: 'subtract',
      amount: lit(1),
    },
  ],
};

/** Global, no cost, open only inside `WINDOW_BLOCK`. A minimal, observable marker effect — the
 * window MECHANISM itself is what V3/V4 exercise, not this rule's own payload. Drives V3, V4. */
export const blockDeclareRule: RuleSet = {
  ...baseRule,
  id: RS_BLOCK_DECLARE,
  name: 'Block',
  trigger: 'never_blockDeclare',
  effects: [{ kind: 'changePool', poolId: BLOCKED, seat: null, op: 'set', amount: lit(true) }],
  activation: { costCheck: null, cost: [], window: WINDOW_BLOCK, perInstance: false, label: 'Block' },
};

/**
 * V11 — "influence counters reach capacity -> the minion moves to Ready, via existing v1 primitives
 * only." `RS_TICK` and `RS_READY` are both global (`globalRuleSetIds`), both triggered by the
 * ordinary custom event `onUntap`; NEITHER touches `announceAction`, `priority`, `replaces`, or
 * `modifier` — the fixtures.test.ts structural check greps these two objects directly for that.
 *
 * Both target via `{kind:'allInZone', zone:{... seat:{kind:'triggeringSeat'}}}` /
 * `{kind:'matching', from: allInZone, where}` rather than "the specific minion", because — as
 * `mtgish.ts`'s `returnToOwnerRule` documents — no `TargetSelector` addresses a specific card by id
 * or by tag-across-zones, only by zone membership (+ predicate). `RS_TICK` relies on the triggering
 * seat's Uncontrolled zone holding exactly the minion under test; `RS_READY`'s `matching` sweep needs
 * no such assumption at all, since `candidate` binds per card regardless of which one triggered it.
 */
export const tickRule: RuleSet = {
  ...baseRule,
  id: RS_TICK,
  name: 'Tick Influence',
  trigger: ON_UNTAP,
  priority: 1, // runs before RS_READY within the same event (§5.1: priority desc).
  effects: [
    {
      kind: 'setCardIndex',
      target: { kind: 'allInZone', zone: { zoneId: UNCONTROLLED, seat: { kind: 'triggeringSeat' } } },
      indexId: INFLUENCE,
      op: 'add',
      amount: lit(1),
    },
  ],
};

export const readyRule: RuleSet = {
  ...baseRule,
  id: RS_READY,
  name: 'Ready When Influenced',
  trigger: ON_UNTAP,
  priority: 0,
  effects: [
    {
      kind: 'moveCards',
      target: {
        kind: 'matching',
        from: { kind: 'allInZone', zone: { zoneId: UNCONTROLLED, seat: { kind: 'triggeringSeat' } } },
        where: {
          kind: 'criteria',
          left: { kind: 'cardIndex', card: { kind: 'candidate' }, indexId: INFLUENCE },
          op: '>=',
          right: { kind: 'cardIndex', card: { kind: 'candidate' }, indexId: CAPACITY },
        },
      },
      to: { zoneId: READY, seat: { kind: 'triggeringSeat' } },
      position: 'top',
    },
  ],
};

/**
 * V6, V7 — "vote values 1/2/1 summed to 4." No `ValueRef` sums a card index across a filtered set of
 * cards (`cardIndex` takes exactly one `CardRef`); the only summing primitive is `SeatQuantifier:
 * 'sum'` over a per-player POOL (SP6). So a vote is modeled as copying a `VoteCard`'s `voteValue`
 * into that seat's `VOTES_FOR`/`VOTES_AGAINST` pool (test-driven — see the step-32 report; the same
 * "read my own card index" gap `mtgish.ts` hits for `returnToOwnerRule` blocks an authored
 * "cast vote" ability from reading its own card's value), and the referendum sums those pools across
 * every seat.
 */
/** Both sides' summed totals, resolved via the SAME `sum` quantifier the condition below reads. */
const votesForSum: ValueRef = { kind: 'pool', poolId: VOTES_FOR, seat: { kind: 'all', quantifier: 'sum' } };
const votesAgainstSum: ValueRef = { kind: 'pool', poolId: VOTES_AGAINST, seat: { kind: 'all', quantifier: 'sum' } };

export const referendumPassRule: RuleSet = {
  ...baseRule,
  id: RS_REFERENDUM_PASS,
  name: 'Referendum Passes',
  trigger: ON_REFERENDUM_CLOSE,
  effects: [
    // AC: V6 — writes each side's RESOLVED total into its own pool before the verdict, so the log
    // names both totals ("Votes For Total: 0 → 4.", "Votes Against Total: 0 → 0."), not just "passed".
    { kind: 'changePool', poolId: VOTES_FOR_TOTAL, seat: null, op: 'set', amount: votesForSum },
    { kind: 'changePool', poolId: VOTES_AGAINST_TOTAL, seat: null, op: 'set', amount: votesAgainstSum },
    { kind: 'changePool', poolId: REFERENDUM_PASSED, seat: null, op: 'set', amount: lit(true) },
  ],
  condition: {
    kind: 'criteria',
    left: votesForSum,
    op: '>',
    right: votesAgainstSum,
  },
};

export const referendumFailRule: RuleSet = {
  ...baseRule,
  id: RS_REFERENDUM_FAIL,
  name: 'Referendum Fails',
  trigger: ON_REFERENDUM_CLOSE,
  effects: [
    { kind: 'changePool', poolId: VOTES_FOR_TOTAL, seat: null, op: 'set', amount: votesForSum },
    { kind: 'changePool', poolId: VOTES_AGAINST_TOTAL, seat: null, op: 'set', amount: votesAgainstSum },
    { kind: 'changePool', poolId: REFERENDUM_PASSED, seat: null, op: 'set', amount: lit(false) },
  ],
  condition: {
    kind: 'criteria',
    left: votesForSum,
    op: '<=',
    right: votesAgainstSum,
  },
};

/** AC: V8 — gated on the HOST's discipline, read via `{kind:'host'}` (ctx.sourceCardId for a
 * `perInstance` activation IS the equipment itself, and `host` reads one hop further: the vampire it
 * is attached to — this is the one case in these two fixtures where "read something about the
 * activating card" needs no self-reference workaround, because the thing being read is the HOST, not
 * the card itself). */
export const equipmentAbilityRule: RuleSet = {
  ...baseRule,
  id: RS_EQUIPMENT_ABILITY,
  name: 'Use Equipment',
  trigger: 'never_equipmentAbility',
  effects: [{ kind: 'changePool', poolId: POOL, seat: { kind: 'triggeringSeat' }, op: 'add', amount: lit(1) }],
  activation: {
    costCheck: {
      kind: 'criteria',
      left: { kind: 'cardIndex', card: { kind: 'host' }, indexId: DISCIPLINE },
      op: '>=',
      right: lit(2),
    },
    cost: [],
    window: null,
    perInstance: true,
    label: 'Use Equipment',
  },
};

/**
 * V9 — "controller resolves to one seat without a zone change." `target` is `allInZone` on seat 0's
 * Uncontrolled zone rather than a self-reference (same documented gap, same
 * `activation.test.ts`-established workaround as `mtgish.ts`'s `returnToOwnerRule`): the V9 test
 * scenario places `UniqueVampire` alone there.
 */
export const seizeRule: RuleSet = {
  ...baseRule,
  id: RS_SEIZE,
  name: 'Seize',
  trigger: 'never_seize',
  effects: [
    {
      kind: 'setController',
      target: { kind: 'allInZone', zone: { zoneId: UNCONTROLLED, seat: { kind: 'seat', index: 0 } } },
      seat: { kind: 'triggeringSeat' },
    },
  ],
  activation: { costCheck: null, cost: [], window: null, perInstance: true, label: 'Seize' },
};

export const vtesStrikeRule: RuleSet = {
  ...baseRule,
  id: VTES_RS_STRIKE,
  name: 'Strike',
  trigger: 'onCardPlayed',
  effects: [{ kind: 'announceAction', ruleId: RS_STRIKE_RESOLVE, window: null }],
};

/**
 * AC: V5. §9.3 asks for `seats: the two combatants` — `SeatRef` has no variant naming an arbitrary
 * pair (only a single seat, or `{kind:'all'}` — every live seat). `{kind:'all'}` is the closest
 * expressible approximation used here; see the step-32 report.
 */
export const strikeResolveRule: RuleSet = {
  ...baseRule,
  id: RS_STRIKE_RESOLVE,
  name: 'Strike (resolve)',
  trigger: 'never_strikeResolve',
  effects: [
    {
      kind: 'sealedChoice',
      choiceId: 'strike',
      seats: { kind: 'all' },
      options: [
        { id: 'hit', label: 'Hit' },
        { id: 'dodge', label: 'Dodge' },
      ],
    },
  ],
};

/** One global rule PER SEAT (engine ceiling — a single global rule only fires once for the whole
 * board). Drives V2, pairs with V1. */
function oustRule(id: string, seat: number): RuleSet {
  return {
    ...baseRule,
    id,
    name: `Oust Seat ${seat}`,
    trigger: 'onGameStart',
    effects: [{ kind: 'eliminateSeat', seat: { kind: 'seat', index: seat } }],
    condition: {
      kind: 'criteria',
      left: { kind: 'pool', poolId: POOL, seat: { kind: 'seat', index: seat } },
      op: '<=',
      right: lit(0),
    },
    continuous: true,
  };
}

export const oustRules: RuleSet[] = [0, 1, 2, 3, 4].map((seat) => oustRule(`rs_oustSeat${seat}`, seat));

const ruleSets: RuleSet[] = [
  actionRule,
  actionResolveRule,
  blockDeclareRule,
  tickRule,
  readyRule,
  referendumPassRule,
  referendumFailRule,
  equipmentAbilityRule,
  seizeRule,
  vtesStrikeRule,
  strikeResolveRule,
  ...oustRules,
];

const globalRuleSetIds: string[] = [
  blockDeclareRule.id,
  tickRule.id,
  readyRule.id,
  referendumPassRule.id,
  referendumFailRule.id,
  ...oustRules.map((r) => r.id),
];

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const minionIndexes = [
  { id: INFLUENCE, value: { type: 'integer' as const, name: 'Influence', defaultValue: 0, min: 0, max: 10 }, icon: 'gi-influence', position: 'topLeft' as const },
  { id: CAPACITY, value: { type: 'integer' as const, name: 'Capacity', defaultValue: 3, min: 0, max: 10 }, icon: 'gi-crystal-ball', position: 'topRight' as const },
  { id: DISCIPLINE, value: { type: 'integer' as const, name: 'Discipline', defaultValue: 0, min: 0, max: 10 }, icon: 'gi-fangs', position: 'bottomLeft' as const },
];

const templates: CardTemplate[] = [
  { id: ACTION_CARD, name: 'Predator’s Claim', marquee: 'Predator’s Claim', faceIcon: 'gi-fangs', borderColor: '#7a1f1f', tags: ['action'], indexes: [], ruleSetIds: [RS_ACTION], rulesTextOverride: null },
  { id: MINION, name: 'Minion', marquee: 'Minion', faceIcon: 'gi-vampire-dracula', borderColor: '#2b2b4a', tags: [MINION_TAG], indexes: minionIndexes, ruleSetIds: [], rulesTextOverride: null },
  { id: VOTE_CARD, name: 'Vote Card', marquee: 'Vote Card', faceIcon: 'gi-scroll-unfurled', borderColor: '#4a3b2b', tags: [MINION_TAG], indexes: [{ id: VOTE_VALUE, value: { type: 'integer', name: 'Vote Value', defaultValue: 1, min: 0, max: 5 }, icon: 'gi-vote', position: 'bottomRight' }], ruleSetIds: [], rulesTextOverride: null },
  { id: EQUIPMENT, name: 'Equipment', marquee: 'Equipment', faceIcon: 'gi-sword', borderColor: '#6a6a6a', tags: ['equipment'], indexes: [], ruleSetIds: [RS_EQUIPMENT_ABILITY], rulesTextOverride: null },
  { id: UNIQUE_VAMPIRE, name: 'Unique Vampire', marquee: 'Unique Vampire', faceIcon: 'gi-fangs', borderColor: '#8a2b8a', tags: [MINION_TAG, UNIQUE_TAG], indexes: minionIndexes, ruleSetIds: [RS_SEIZE], rulesTextOverride: null },
  { id: VTES_STRIKE, name: 'Strike', marquee: 'Strike', faceIcon: 'gi-claw-slashes', borderColor: '#9e2f26', tags: ['combat'], indexes: [], ruleSetIds: [VTES_RS_STRIKE], rulesTextOverride: null },
];

// ---------------------------------------------------------------------------
// Deck — Library/Hand minimal, setup only (§9.3).
// ---------------------------------------------------------------------------

const decks: Deck[] = [
  {
    id: VTES_STARTER_DECK,
    name: 'Starter',
    zoneId: VTES_LIBRARY,
    entries: templates.map((t) => ({ templateId: t.id, quantity: 2 })),
  },
];

// ---------------------------------------------------------------------------
// State machine — minimal Start -> Main -> End; the ring/combat/vote mechanics are what this
// fixture exists to exercise, not state-machine breadth.
// ---------------------------------------------------------------------------

const states: MachineState[] = [
  { ...START_NODE, exitableTo: [VTES_MAIN] },
  { id: VTES_MAIN, name: 'Main', enterableFrom: [START_STATE_ID, VTES_END_TURN], exitableTo: [VTES_END_TURN], entryCriteria: null, transitionLabel: null, priority: 0, position: { x: 200, y: 0 } },
  { id: VTES_END_TURN, name: 'End Turn', enterableFrom: [VTES_MAIN], exitableTo: [VTES_MAIN, END_STATE_ID], entryCriteria: null, transitionLabel: 'End Turn', priority: 0, position: { x: 400, y: 0 } },
  { ...END_NODE, enterableFrom: [VTES_END_TURN], position: { x: 600, y: 0 } },
];

const LIMITS = {
  maxDepth: DEFAULT_MAX_DEPTH,
  maxEffects: DEFAULT_MAX_EFFECTS,
  maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
  maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
};

export const vtesish: GameDefinition = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: 'game_vtesish',
  name: 'VTES-ish',
  playerCount: 5,
  pools,
  zones,
  templates,
  decks,
  customEvents: [ON_UNTAP, ON_REFERENDUM_CLOSE],
  ruleSets,
  globalRuleSetIds,
  priorityWindows,
  machine: { states, startStateId: START_STATE_ID, endStateId: END_STATE_ID },
  limits: LIMITS,
  updatedAt: FIXTURE_UPDATED_AT,
});
