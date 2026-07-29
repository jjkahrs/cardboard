/**
 * Texas Hold'em — a shipped sample definition, emitted to `samples/texas-holdem.json` by
 * `src/test/holdem.test.ts` and imported through the ordinary game-list importer (§7.1).
 *
 * Authored in TypeScript rather than hand-written JSON for one reason: 52 templates plus ~40 effects
 * of dealing/blind plumbing is not something anyone should type twice, and the `GameDefinition` type
 * catches a mistyped effect kind here instead of at import time.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ENGINE CANNOT DO, AND WHAT THE SAMPLE DOES INSTEAD
 * ---------------------------------------------------------------------------
 *
 * 1. **Hand ranking is not expressible, so the showdown is human-judged.** A `CriteriaNode` compares
 *    two scalar `ValueRef`s; the only aggregation in the language is `SeatQuantifier:'sum'` over a
 *    per-seat POOL (`seats.ts`), and no `ValueRef` folds a card index across a set of cards — the
 *    same gap `vtesish.ts` documents for vote tallies. Ranking best-five-of-seven needs sorting and
 *    combinations, neither of which exists. So `Showdown` is a state where players compare hands by
 *    eye (turn on Reveal all), and `Take the Pot` is an activation the winner presses.
 *
 * 2. **No arithmetic on `ValueRef`s, so the wager is typed, not computed.** There is no `a - b` node,
 *    so "the amount you still owe" cannot be derived from `currentBet - committed`. The single
 *    betting ability therefore raises a `chooseNumber` (1..your chips) and the tester types what they
 *    are putting in. Each seat's `Committed` pool is on the board, so the amount to call is readable
 *    at a glance. Nothing verifies that a raise is legal — this is a playtest table, not a referee.
 *
 * 3. **Action starts at the button, not under the gun.** `PriorityWindow.start` is one of
 *    `active | triggeringSeat | controllerOfAction` (§4.6) — there is no "+3 seats" form — so every
 *    betting round polls from the button (the `activePlayer` pool) forward. Legality is unaffected;
 *    only the order of who is asked first differs from real Hold'em.
 *
 * 4. **A betting round closes on a full lap of passes, not on "everyone has matched".** Priority
 *    windows count consecutive passes (`priority.ts`); taking any action resets the counter
 *    (`activation.ts`). So after the last call, one more lap of checks closes the street. Checking is
 *    passing — that is why the wager prompt's minimum is 1 rather than 0.
 *
 * 5. **No side pots and no split pots.** `Take the Pot` moves the whole pot to one seat; there is no
 *    division primitive. An all-in for less than the bet is played out on the honour system.
 *
 * 6. **Folding is a pool, not elimination.** `eliminateSeat` drops a seat from `seatOrder`
 *    permanently and nothing puts it back, which would end a player's session on their first fold.
 *    Instead every betting ability's `costCheck` requires `Folded = false`, so a folded seat is
 *    offered nothing and auto-passes silently (`priority.ts`'s empty-offer collapse).
 */

import type {
  CardTemplate,
  Deck,
  Effect,
  GameDefinition,
  MachineState,
  PlayZone,
  PointPool,
  PriorityWindow,
  RuleSet,
  SeatRef,
  ValueRef,
  ZoneRef,
} from '../engine/types';
import {
  ACTIVE_PLAYER_POOL_ID,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
} from '../engine/types';

// ---------------------------------------------------------------------------
// Table constants
// ---------------------------------------------------------------------------

export const SEAT_COUNT = 6;
export const SEATS = Array.from({ length: SEAT_COUNT }, (_, i) => i);
export const STARTING_CHIPS = 1000;
export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const CHIPS = 'pool_chips';
export const POT = 'pool_pot';
export const COMMITTED = 'pool_committed';
export const FOLDED = 'pool_folded';

export const DECK = 'zone_deck';
export const HAND = 'zone_hand';
export const BOARD = 'zone_board';
export const BURN = 'zone_burn';

export const RANK = 'idx_rank';

export const WIN_BETTING = 'win_betting';

export const RS_DEAL = 'rs_deal';
export const RS_PREFLOP = 'rs_preflop';
export const RS_FLOP = 'rs_flop';
export const RS_TURN = 'rs_turn';
export const RS_RIVER = 'rs_river';
export const RS_FOLD = 'rs_fold';
export const RS_WAGER = 'rs_wager';
export const RS_TAKE_POT = 'rs_takePot';
export const RS_BUTTON_ADVANCE = 'rs_buttonAdvance';
export const RS_BUTTON_WRAP = 'rs_buttonWrap';

export const HOLDEM_DECK = 'deck_standard52';

export const S_DEAL = 'state_deal';
export const S_PREFLOP = 'state_preflop';
export const S_FLOP = 'state_flop';
export const S_TURN = 'state_turn';
export const S_RIVER = 'state_river';
export const S_SHOWDOWN = 'state_showdown';
export const S_PAYOUT = 'state_payout';

/** The prompt key the wager ability writes and its own later effects read back. */
export const WAGER_KEY = 'wager';

// ---------------------------------------------------------------------------
// Small builders — the same shapes appear a few dozen times below
// ---------------------------------------------------------------------------

const lit = (value: number | boolean): ValueRef => ({ kind: 'literal', value });
const at = (index: number): SeatRef => ({ kind: 'seat', index });
const acting: SeatRef = { kind: 'triggeringSeat' };
const everySeat: SeatRef = { kind: 'all' };
/** Seat `offset` places clockwise of the button (`activePlayer`) — the ring walk skips ousted seats. */
const fromButton = (offset: number): SeatRef => ({ kind: 'relative', from: { kind: 'active' }, offset });
const zone = (zoneId: string, seat: SeatRef | null = null): ZoneRef => ({ zoneId, seat });
const poolOf = (poolId: string, seat: SeatRef | null): ValueRef => ({ kind: 'pool', poolId, seat });

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

/** Chips leave a seat, land in the pot, and are remembered as that seat's stake in this street. */
function commit(seat: SeatRef, amount: ValueRef): Effect[] {
  return [
    { kind: 'changePool', poolId: CHIPS, seat, op: 'subtract', amount },
    { kind: 'changePool', poolId: POT, seat: null, op: 'add', amount },
    { kind: 'changePool', poolId: COMMITTED, seat, op: 'add', amount },
  ];
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

const pools: PointPool[] = [
  {
    id: CHIPS,
    scope: 'player',
    value: { type: 'integer', name: 'Chips', defaultValue: STARTING_CHIPS, min: 0, max: 1_000_000 },
  },
  { id: POT, scope: 'game', value: { type: 'integer', name: 'Pot', defaultValue: 0, min: 0, max: 1_000_000 } },
  {
    id: COMMITTED,
    scope: 'player',
    // Reset to 0 at the top of every street: this is the stake in the CURRENT betting round, which
    // is what "the amount to call" is read off (see note 2 in the header).
    value: { type: 'integer', name: 'Committed', defaultValue: 0, min: 0, max: 1_000_000 },
  },
  { id: FOLDED, scope: 'player', value: { type: 'boolean', name: 'Folded', defaultValue: false } },
];

// ---------------------------------------------------------------------------
// Zones. `activePlayer` is the dealer button — seeded by the engine, rotated by the two rules at the
// bottom of this file, and read by every `relative` seat ref above.
// ---------------------------------------------------------------------------

const zones: PlayZone[] = [
  { id: DECK, name: 'Deck', scope: 'shared', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null },
  { id: HAND, name: 'Hole Cards', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: 2 },
  { id: BOARD, name: 'Board', scope: 'shared', visibility: 'faceUp', layout: 'row', ordered: true, maxCapacity: 5 },
  { id: BURN, name: 'Burn', scope: 'shared', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null },
];

// ---------------------------------------------------------------------------
// The 52 cards
// ---------------------------------------------------------------------------

interface Suit {
  key: string;
  name: string;
  symbol: string;
  color: string;
}

const SUITS: Suit[] = [
  { key: 's', name: 'spades', symbol: '♠', color: '#1f2430' },
  { key: 'h', name: 'hearts', symbol: '♥', color: '#9e2f26' },
  { key: 'd', name: 'diamonds', symbol: '♦', color: '#9e2f26' },
  { key: 'c', name: 'clubs', symbol: '♣', color: '#1f2430' },
];

/** 2..14 — ace high, which is what a `rank` comparison wants everywhere except a wheel straight. */
const RANKS = Array.from({ length: 13 }, (_, i) => i + 2);

function rankLabel(rank: number): string {
  return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[rank] ?? String(rank);
}

function rankKey(rank: number): string {
  return { 11: 'j', 12: 'q', 13: 'k', 14: 'a' }[rank] ?? String(rank);
}

/**
 * The sprite ships all 52 faces (`scripts/gen-icons.mjs` pins them), so every card gets its OWN
 * glyph — 7♥ is the seven of hearts, not the suit's ace standing in for it.
 */
function faceIcon(rank: number, suit: Suit): string {
  const named = { 11: 'jack', 12: 'queen', 13: 'king', 14: 'ace' }[rank] ?? String(rank);
  return `gi-card-${named}-${suit.name}`;
}

export function templateIdFor(rank: number, suit: Suit): string {
  return `tpl_${rankKey(rank)}${suit.key}`;
}

const templates: CardTemplate[] = SUITS.flatMap((suit) =>
  RANKS.map((rank): CardTemplate => {
    const label = `${rankLabel(rank)}${suit.symbol}`;
    return {
      id: templateIdFor(rank, suit),
      name: label,
      marquee: label,
      faceIcon: faceIcon(rank, suit),
      borderColor: suit.color,
      tags: [suit.name],
      // The rank lives on the card as an index so a criterion CAN read it — nothing in this sample
      // does, because ranking a hand needs more than one card at a time (header note 1), but a
      // designer forking this file gets the hook for free.
      indexes: [
        {
          id: RANK,
          value: { type: 'integer', name: 'Rank', defaultValue: rank, min: 2, max: 14 },
          icon: 'gi-card-random',
          position: 'topLeft',
        },
      ],
      ruleSetIds: [],
      rulesTextOverride: null,
    };
  })
);

/** Shared zone ⇒ one instance of this deck, not one per seat (§4.5). Exactly 52 cards. */
const decks: Deck[] = [
  {
    id: HOLDEM_DECK,
    name: 'Standard 52',
    zoneId: DECK,
    entries: templates.map((t) => ({ templateId: t.id, quantity: 1 })),
  },
];

// ---------------------------------------------------------------------------
// The betting window
// ---------------------------------------------------------------------------

const bettingWindow: PriorityWindow = {
  id: WIN_BETTING,
  name: 'Betting Round',
  // Header note 3 — the button, because there is no "under the gun" start.
  start: 'active',
  direction: 'forward',
  includeStart: true,
  // null ⇒ `activeSeatCount`: one full lap of passes closes the street (header note 4).
  passesToClose: null,
  collapseEmptyOffers: true,
};

// ---------------------------------------------------------------------------
// Per-street rules
// ---------------------------------------------------------------------------

const notFolded = {
  kind: 'criteria' as const,
  left: poolOf(FOLDED, acting),
  op: '=' as const,
  right: lit(false),
};

/** Every seat's stake in the street resets; the pot does not. */
const resetStreet: Effect = {
  kind: 'changePool',
  poolId: COMMITTED,
  seat: everySeat,
  op: 'set',
  amount: lit(0),
};

/**
 * Entering `Deal` is what starts a hand: everything on the table goes back into the deck, the deck is
 * shuffled, two cards go to each seat, and the blinds are posted from the seats left of the button.
 *
 * The gather is written out per seat because `drawCards`/`moveCards` resolve their zone to exactly
 * one seat (`effects.ts`'s `oneKey`) — `{kind:'all'}` is rejected there, unlike in `changePool`.
 * That is also why this sample's seat count is fixed at six.
 */
const dealRule: RuleSet = {
  ...baseRule,
  id: RS_DEAL,
  name: 'Deal a New Hand',
  trigger: 'onStateEnter',
  stateFilter: S_DEAL,
  effects: [
    { kind: 'moveCards', target: { kind: 'allInZone', zone: zone(BOARD) }, to: zone(DECK), position: 'bottom' },
    { kind: 'moveCards', target: { kind: 'allInZone', zone: zone(BURN) }, to: zone(DECK), position: 'bottom' },
    ...SEATS.map(
      (seat): Effect => ({
        kind: 'moveCards',
        target: { kind: 'allInZone', zone: zone(HAND, at(seat)) },
        to: zone(DECK),
        position: 'bottom',
      })
    ),
    { kind: 'shuffleZone', zone: zone(DECK) },
    { kind: 'changePool', poolId: POT, seat: null, op: 'set', amount: lit(0) },
    resetStreet,
    { kind: 'changePool', poolId: FOLDED, seat: everySeat, op: 'set', amount: lit(false) },
    ...SEATS.map(
      (seat): Effect => ({
        kind: 'drawCards',
        from: zone(DECK),
        to: zone(HAND, at(seat)),
        count: lit(2),
      })
    ),
    ...commit(fromButton(1), lit(SMALL_BLIND)),
    ...commit(fromButton(2), lit(BIG_BLIND)),
  ],
};

/** Preflop deals nothing — the hole cards are already out, so this only opens the betting. */
const preflopRule: RuleSet = {
  ...baseRule,
  id: RS_PREFLOP,
  name: 'Preflop Betting',
  trigger: 'onStateEnter',
  stateFilter: S_PREFLOP,
  effects: [{ kind: 'openPriority', window: WIN_BETTING }],
};

/** Burn one, turn `count`, reset the street's stakes, then poll the table. */
function streetRule(id: string, name: string, stateId: string, count: number): RuleSet {
  return {
    ...baseRule,
    id,
    name,
    trigger: 'onStateEnter',
    stateFilter: stateId,
    effects: [
      { kind: 'drawCards', from: zone(DECK), to: zone(BURN), count: lit(1) },
      { kind: 'drawCards', from: zone(DECK), to: zone(BOARD), count: lit(count) },
      resetStreet,
      { kind: 'openPriority', window: WIN_BETTING },
    ],
  };
}

const flopRule = streetRule(RS_FLOP, 'Deal the Flop', S_FLOP, 3);
const turnRule = streetRule(RS_TURN, 'Deal the Turn', S_TURN, 1);
const riverRule = streetRule(RS_RIVER, 'Deal the River', S_RIVER, 1);

// ---------------------------------------------------------------------------
// What a seat can do when priority reaches it
// ---------------------------------------------------------------------------

/**
 * Folding sets a pool rather than eliminating the seat (header note 6). Once it is true this seat's
 * two abilities both fail their `costCheck`, so priority skips it silently for the rest of the hand.
 */
const foldRule: RuleSet = {
  ...baseRule,
  id: RS_FOLD,
  name: 'Fold',
  trigger: 'never_fold',
  effects: [{ kind: 'changePool', poolId: FOLDED, seat: acting, op: 'set', amount: lit(true) }],
  activation: { costCheck: notFolded, cost: [], window: WIN_BETTING, perInstance: false, label: 'Fold' },
};

/**
 * One ability covers bet, call, raise and all-in: the tester types the amount (header note 2).
 *
 * The prompt lives in `effects`, NOT in `cost` — `activation.cost` may not suspend (§5.8, and both
 * `schema.ts` and `activation.ts` refuse it), and a `chooseNumber` suspends by definition.
 *
 * Minimum 1, because a wager of 0 is a check, and a check is `Pass` — taking an action resets the
 * window's pass counter, so a table of zero-chip "checks" would never close the street.
 */
const wagerRule: RuleSet = {
  ...baseRule,
  id: RS_WAGER,
  name: 'Bet, Call or Raise',
  trigger: 'never_wager',
  effects: [
    {
      kind: 'chooseNumber',
      promptText: 'Chips into the pot (call, bet or raise — Pass to check or to give up the hand’s action)',
      seat: acting,
      min: lit(1),
      max: poolOf(CHIPS, acting),
      key: WAGER_KEY,
    },
    ...commit(acting, { kind: 'promptNumber', key: WAGER_KEY }),
  ],
  activation: {
    costCheck: {
      kind: 'group',
      combinator: 'and',
      children: [notFolded, { kind: 'criteria', left: poolOf(CHIPS, acting), op: '>', right: lit(0) }],
    },
    cost: [],
    window: WIN_BETTING,
    perInstance: false,
    label: 'Bet / Call / Raise',
  },
};

/**
 * The showdown verdict, such as it is (header note 1): whoever the table agrees won presses this.
 * Available outside any window, so it also settles a hand that ended on a fold.
 */
const takePotRule: RuleSet = {
  ...baseRule,
  id: RS_TAKE_POT,
  name: 'Take the Pot',
  trigger: 'never_takePot',
  effects: [
    { kind: 'changePool', poolId: CHIPS, seat: acting, op: 'add', amount: poolOf(POT, null) },
    { kind: 'changePool', poolId: POT, seat: null, op: 'set', amount: lit(0) },
  ],
  activation: {
    costCheck: { kind: 'criteria', left: poolOf(POT, null), op: '>', right: lit(0) },
    cost: [],
    window: null,
    perInstance: false,
    label: 'Take the Pot',
  },
};

// ---------------------------------------------------------------------------
// Moving the button. Two rules, not one conditional pair, and the order matters: `advance` runs
// unconditionally (priority 1) and may leave `activePlayer` at 6, which `wrap` (priority 0) then
// folds back to 0. Mutually-exclusive conditions on one snapshot would be the obvious alternative
// and would be wrong — the second rule sees the first rule's write, so "wrap to 0" would immediately
// re-trigger "advance to 1".
//
// `activePlayer` is deliberately unauthored: the engine seeds it with no maximum (§4.1), which is
// what lets it hold the transient 6.
// ---------------------------------------------------------------------------

const buttonAdvanceRule: RuleSet = {
  ...baseRule,
  id: RS_BUTTON_ADVANCE,
  name: 'Move the Button',
  trigger: 'onStateExit',
  stateFilter: S_PAYOUT,
  priority: 1,
  effects: [{ kind: 'changePool', poolId: ACTIVE_PLAYER_POOL_ID, seat: null, op: 'add', amount: lit(1) }],
};

const buttonWrapRule: RuleSet = {
  ...baseRule,
  id: RS_BUTTON_WRAP,
  name: 'Button Wraps to Seat 0',
  trigger: 'onStateExit',
  stateFilter: S_PAYOUT,
  priority: 0,
  condition: {
    kind: 'criteria',
    left: poolOf(ACTIVE_PLAYER_POOL_ID, null),
    op: '>=',
    right: lit(SEAT_COUNT),
  },
  effects: [{ kind: 'changePool', poolId: ACTIVE_PLAYER_POOL_ID, seat: null, op: 'set', amount: lit(0) }],
};

const ruleSets: RuleSet[] = [
  dealRule,
  preflopRule,
  flopRule,
  turnRule,
  riverRule,
  foldRule,
  wagerRule,
  takePotRule,
  buttonAdvanceRule,
  buttonWrapRule,
];

/**
 * All of them. The three activation rules do not strictly need to be here — `activatableRules`
 * scans `def.ruleSets` directly — but a rule reachable from nothing at all reads like an oversight.
 */
const globalRuleSetIds = ruleSets.map((r) => r.id);

// ---------------------------------------------------------------------------
// The hand, as a state machine. Every transition is manual: "this betting round is over" is not a
// criterion anything can read (a priority window closing fires no event), so the tester drives the
// streets with the buttons. Each street can also jump straight to Payout, which is the everybody-
// folded path.
// ---------------------------------------------------------------------------

const states: MachineState[] = [
  {
    id: START_STATE_ID,
    name: 'Start',
    enterableFrom: [],
    exitableTo: [S_DEAL],
    entryCriteria: null,
    transitionLabel: null,
    priority: 0,
    position: { x: 0, y: 0 },
  },
  {
    id: S_DEAL,
    name: 'Deal',
    enterableFrom: [START_STATE_ID, S_PAYOUT],
    exitableTo: [S_PREFLOP],
    entryCriteria: null,
    transitionLabel: 'Deal a new hand',
    priority: 0,
    position: { x: 160, y: 0 },
  },
  {
    id: S_PREFLOP,
    name: 'Preflop',
    enterableFrom: [S_DEAL],
    exitableTo: [S_FLOP, S_PAYOUT],
    entryCriteria: null,
    transitionLabel: 'Preflop betting',
    priority: 0,
    position: { x: 320, y: 0 },
  },
  {
    id: S_FLOP,
    name: 'Flop',
    enterableFrom: [S_PREFLOP],
    exitableTo: [S_TURN, S_PAYOUT],
    entryCriteria: null,
    transitionLabel: 'Deal the flop',
    priority: 0,
    position: { x: 480, y: 0 },
  },
  {
    id: S_TURN,
    name: 'Turn',
    enterableFrom: [S_FLOP],
    exitableTo: [S_RIVER, S_PAYOUT],
    entryCriteria: null,
    transitionLabel: 'Deal the turn',
    priority: 0,
    position: { x: 640, y: 0 },
  },
  {
    id: S_RIVER,
    name: 'River',
    enterableFrom: [S_TURN],
    exitableTo: [S_SHOWDOWN, S_PAYOUT],
    entryCriteria: null,
    transitionLabel: 'Deal the river',
    priority: 0,
    position: { x: 800, y: 0 },
  },
  {
    id: S_SHOWDOWN,
    name: 'Showdown',
    enterableFrom: [S_RIVER],
    exitableTo: [S_PAYOUT],
    entryCriteria: null,
    // No rules: the engine cannot rank hands (header note 1). Turn on "Reveal all" and compare.
    transitionLabel: 'Showdown — compare hands',
    priority: 0,
    position: { x: 960, y: 0 },
  },
  {
    id: S_PAYOUT,
    name: 'Payout',
    enterableFrom: [S_PREFLOP, S_FLOP, S_TURN, S_RIVER, S_SHOWDOWN],
    exitableTo: [S_DEAL, END_STATE_ID],
    entryCriteria: null,
    transitionLabel: 'Award the pot',
    priority: 0,
    position: { x: 1120, y: 0 },
  },
  {
    id: END_STATE_ID,
    name: 'End',
    enterableFrom: [S_PAYOUT],
    exitableTo: [],
    entryCriteria: null,
    transitionLabel: null,
    priority: 0,
    position: { x: 1280, y: 0 },
  },
];

/** Fixed, never `Date.now()` — the emitted JSON must not churn on every run (§3.6). */
export const HOLDEM_UPDATED_AT = '2026-07-29T00:00:00.000Z';

export const holdem: GameDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: 'game_texasHoldem',
  name: 'Texas Hold’em',
  playerCount: SEAT_COUNT,
  pools,
  zones,
  templates,
  decks,
  customEvents: [],
  ruleSets,
  globalRuleSetIds,
  priorityWindows: [bettingWindow],
  machine: { states, startStateId: START_STATE_ID, endStateId: END_STATE_ID },
  limits: {
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEffects: DEFAULT_MAX_EFFECTS,
    maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
    maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
  },
  updatedAt: HOLDEM_UPDATED_AT,
};
