/**
 * §8 step 32 / §9.3 `mtgish.ts` — 2 seats. Serves MTG1–MTG11, and the shared-primitive rows that
 * need modifiers or replacement (SP6, SP7, SP8, SP9).
 *
 * Frozen, like every other §9.2/§9.3 fixture. Mutating tests must `structuredClone(mtgish)` first.
 *
 * Scoped strictly to the cards §9.1's MTG rows name — no template exists here that is not the
 * subject of a criterion.
 *
 * TWO PLACES this fixture could not satisfy §9.3's prose literally — both are gaps in the engine's
 * addressing primitives, not shortcuts here. Both are documented at the rule that hits them
 * (`lethalDamageRule`, `blockRule`) and summarized in the step-32 report.
 */

import type {
  CardTemplate,
  CriteriaNode,
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

export const LIFE = 'pool_life';

export const MTG_LIBRARY = 'zone_library';
export const MTG_HAND = 'zone_hand';
export const MTG_BATTLEFIELD = 'zone_battlefield';
export const GRAVEYARD = 'zone_graveyard';

export const BOLT = 'tpl_bolt';
export const BEAR = 'tpl_bear';
export const COUNTER_MAGIC = 'tpl_counterMagic';
export const ANTHEM_LORD = 'tpl_anthemLord';
export const POWER_SET = 'tpl_powerSet';
export const MIND_CONTROL = 'tpl_mindControl';

export const MTG_CREATURE_TAG = 'creature';

/** The three card indexes the fixture needs — power/toughness for combat, damage as the marker
 * MTG11's `LethalDamage` rule compares against toughness. */
export const MTG_POWER = 'idx_power';
export const TOUGHNESS = 'idx_toughness';
export const DAMAGE = 'idx_damage';

export const WINDOW_STACK = 'win_stack';

export const RS_BOLT = 'rs_bolt';
export const RS_BOLT_RESOLVE = 'rs_boltResolve';
export const RS_COUNTER_MAGIC = 'rs_counterMagic';
export const RS_ANTHEM_LORD = 'rs_anthemLord';
export const RS_POWER_SET = 'rs_powerSet';
export const RS_MIND_CONTROL = 'rs_mindControl';
export const RS_RETURN_TO_OWNER = 'rs_returnToOwner';
export const RS_DRAW_TWO_INSTEAD = 'rs_drawTwoInstead';
export const RS_LETHAL_DAMAGE = 'rs_lethalDamage';
export const RS_BLOCK = 'rs_block';
export const RS_OUST_SEAT0 = 'rs_oustSeat0';
export const RS_OUST_SEAT1 = 'rs_oustSeat1';

export const MTG_STARTER_DECK = 'deck_mtgishStarter';

export const MTG_MAIN = 'state_main';
export const MTG_END_TURN = 'state_endTurn';

const lit = (value: number | boolean): ValueRef => ({ kind: 'literal', value });

// ---------------------------------------------------------------------------
// Pools — §9.3: life, player int 20/0/20 (MTG9's zero-life elimination target).
// ---------------------------------------------------------------------------

const pools: PointPool[] = [
  { id: LIFE, scope: 'player', value: { type: 'integer', name: 'Life', defaultValue: 20, min: 0, max: 20 } },
];

// ---------------------------------------------------------------------------
// Zones — §9.3's four, small decks (not 40 — S2/PRNG golden coverage is duel.ts's job).
// ---------------------------------------------------------------------------

const zones: PlayZone[] = [
  { id: MTG_LIBRARY, name: 'Library', scope: 'player', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null },
  { id: MTG_HAND, name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: null },
  { id: MTG_BATTLEFIELD, name: 'Battlefield', scope: 'shared', visibility: 'faceUp', layout: 'row', ordered: false, maxCapacity: null },
  { id: GRAVEYARD, name: 'Graveyard', scope: 'player', visibility: 'faceUp', layout: 'stack', ordered: true, maxCapacity: null },
];

// ---------------------------------------------------------------------------
// Priority window — §9.3: start:'active', forward, includeStart:true, passesToClose:null.
// Drives MTG1, MTG4, MTG5.
// ---------------------------------------------------------------------------

export const windowStack: PriorityWindow = {
  id: WINDOW_STACK,
  name: 'The Stack',
  start: 'active',
  direction: 'forward',
  includeStart: true,
  passesToClose: null,
  collapseEmptyOffers: true,
};

const priorityWindows: PriorityWindow[] = [windowStack];

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
 * `Bolt` is "cast" by the test moving the card straight from Hand to Graveyard (`moveCard`), which
 * fires `onCardPlayed` per §5.1's compound order — mtgish has no "stack zone" to visually park a
 * spell mid-resolution, so the physical card is already discarded by the time this rule runs, and
 * `RS_BOLT_RESOLVE` only has to apply the SPELL EFFECT. Drives MTG1–MTG3.
 */
export const boltRule: RuleSet = {
  ...baseRule,
  id: RS_BOLT,
  name: 'Bolt',
  trigger: 'onCardPlayed',
  effects: [{ kind: 'announceAction', ruleId: RS_BOLT_RESOLVE, window: WINDOW_STACK }],
};

/**
 * Resolve-only — never itself an event trigger, only reachable via a `resolve` frame (§8 step 22).
 *
 * `seat:{kind:'next'}` targets the opponent, correct exactly when the caster is the active seat —
 * the same documented divergence `duel.ts`'s `strikeRule` already reports: `SeatRef` has
 * `triggeringSeat` and `next` as alternatives, never composable (`next` derives from `activePlayer`,
 * not from whoever cast the spell). Not a new finding, the same one, hit again.
 */
export const boltResolveRule: RuleSet = {
  ...baseRule,
  id: RS_BOLT_RESOLVE,
  name: 'Bolt (resolve)',
  trigger: 'never_boltResolve',
  effects: [{ kind: 'changePool', poolId: LIFE, seat: { kind: 'next' }, op: 'subtract', amount: lit(3) }],
};

/** No trigger; a `perInstance` activation open only during `WINDOW_STACK`. Drives MTG3. */
export const counterMagicRule: RuleSet = {
  ...baseRule,
  id: RS_COUNTER_MAGIC,
  name: 'Counter Magic',
  trigger: 'never_counterMagic',
  effects: [{ kind: 'counterAction', action: { kind: 'action', ref: { kind: 'topOfStack' } } }],
  activation: { costCheck: null, cost: [], window: WINDOW_STACK, perInstance: true, label: 'Counter target spell' },
};

const creatureScope = { kind: 'taggedInZone' as const, zone: { zoneId: MTG_BATTLEFIELD, seat: null }, tag: MTG_CREATURE_TAG };

/**
 * §9.3 describes the scope as "creatures ... controlled by self". `TargetSelector` has no
 * controller-filtered variant (no `matching` criterion reads a card's controller as a comparable
 * `ValueRef`), so this buffs every creature on the battlefield regardless of controller — the same
 * simplification `modifiers.test.ts`'s own local fixture already makes for the identical reason, not
 * a new gap. Drives MTG6, paired with `powerSetRule` for MTG7.
 */
export const anthemLordRule: RuleSet = {
  ...baseRule,
  id: RS_ANTHEM_LORD,
  name: 'Anthem Lord',
  trigger: 'onGameStart', // inert — a modifier rule is scanned by modifiers.ts, never dispatched.
  effects: [],
  modifier: { scope: creatureScope, indexId: MTG_POWER, op: 'adjust', amount: lit(1), activeZones: [MTG_BATTLEFIELD] },
};

/**
 * Authored BEFORE `anthemLordRule` in `ruleSets` array order (below) — MTG7's own claim is that
 * authoring order must not matter, since §5.4's algorithm always applies every `set` before every
 * `adjust`, structurally, regardless of array position or even creation order.
 */
export const powerSetRule: RuleSet = {
  ...baseRule,
  id: RS_POWER_SET,
  name: 'Power Set',
  trigger: 'onGameStart',
  effects: [],
  modifier: { scope: creatureScope, indexId: MTG_POWER, op: 'set', amount: lit(0), activeZones: [MTG_BATTLEFIELD] },
};

/** Steals a prompted creature. Drives MTG8, paired with `returnToOwnerRule`. */
export const mindControlRule: RuleSet = {
  ...baseRule,
  id: RS_MIND_CONTROL,
  name: 'Mind Control',
  trigger: 'onCardPlayed',
  effects: [
    {
      kind: 'setController',
      target: { kind: 'prompt', from: { kind: 'taggedInZone', zone: { zoneId: MTG_BATTLEFIELD, seat: null }, tag: MTG_CREATURE_TAG }, count: lit(1), promptText: 'Choose a creature to control' },
      seat: { kind: 'triggeringSeat' },
    },
  ],
};

/**
 * §9.3: "moveCards to a zone selected by `{kind:'owner'}` seat ref." A global, no-cost activation
 * rather than a card-attached one: `TargetSelector` has no way for an ability to target "the card I
 * am attached to/the card carrying me" outside the four `CARD_BINDING_EVENTS`' automatic
 * `triggeringCardId === sourceCardId` binding (`resolveBindings`, `dispatch.ts`) — a `perInstance`
 * activation's own context (`activationCtx`, `priority.ts`) never binds `triggeringCardId`, only
 * `sourceCardId`, and no `CardRef`/`TargetSelector` kind reads `sourceCardId` directly (`host` reads
 * ONE HOP further, the ATTACHED host of it). See the step-32 report for the general finding.
 *
 * Worked around here the same way `activation.test.ts` already documents ("TargetSelector has no
 * 'this specific card id' kind"): `allInZone` on the whole (shared) Battlefield, relying on the test
 * scenario leaving exactly the stolen creature there when this fires.
 */
export const returnToOwnerRule: RuleSet = {
  ...baseRule,
  id: RS_RETURN_TO_OWNER,
  name: 'Return to Owner',
  trigger: 'never_returnToOwner',
  effects: [
    {
      kind: 'moveCards',
      target: { kind: 'allInZone', zone: { zoneId: MTG_BATTLEFIELD, seat: null } },
      to: { zoneId: MTG_HAND, seat: { kind: 'owner', card: { kind: 'zoneTop', zone: { zoneId: MTG_BATTLEFIELD, seat: null } } } },
      position: 'top',
    },
  ],
  activation: { costCheck: null, cost: [], window: null, perInstance: false, label: 'Return to Owner' },
};

/** Global `replaces`. `match: null` — always substitutes. Drives MTG10 and §9.4(d). */
export const drawTwoInsteadRule: RuleSet = {
  ...baseRule,
  id: RS_DRAW_TWO_INSTEAD,
  name: 'Draw Two Instead',
  trigger: 'never_drawTwoInstead',
  effects: [
    {
      kind: 'drawCards',
      from: { zoneId: MTG_LIBRARY, seat: { kind: 'triggeringSeat' } },
      to: { zoneId: MTG_HAND, seat: { kind: 'triggeringSeat' } },
      count: lit(2),
    },
  ],
  replaces: { effectKind: 'drawCards', match: null },
};

const lethalCondition = (card: 'host' | 'candidate'): CriteriaNode => ({
  kind: 'criteria',
  left: { kind: 'cardIndex', card: { kind: card }, indexId: DAMAGE },
  op: '>=',
  right: { kind: 'cardIndex', card: { kind: card }, indexId: TOUGHNESS },
});

/**
 * Card-attached (Bear carries it — engine ceiling: a GLOBAL `continuous` rule gets one
 * `continuousFired` arm for the WHOLE board, so "each creature with lethal damage dies" only
 * re-arms correctly per creature if it is card-attached).
 *
 * `condition` reads `{kind:'host'}` — "the card I am attached to" — rather than "myself" (no such
 * `CardRef` exists; see `returnToOwnerRule`'s comment). `blockRule` below sets the BLOCKER's
 * `attachedTo` to the ATTACKER (one direction, matching §9.3's literal wording), so only the
 * blocker's own binding of this rule can ever see a bound `host` and fire — a documented, one-sided
 * simplification of "each creature checks itself": in this fixture's scenarios the test always
 * arranges for the creature that could die to be checkable this way. Once fired, the EFFECT sweeps
 * the whole board via `matching`/`candidate` (which needs no self-reference at all), so either
 * creature actually dies if it independently qualifies — only the CONDITION gate is one-sided.
 * Drives MTG11.
 */
export const lethalDamageRule: RuleSet = {
  ...baseRule,
  id: RS_LETHAL_DAMAGE,
  name: 'Lethal Damage',
  trigger: 'onGameStart', // inert — continuous:true means trigger is ignored (§4.5, §5.6).
  effects: [
    {
      kind: 'destroyCards',
      target: { kind: 'matching', from: { kind: 'allInZone', zone: { zoneId: MTG_BATTLEFIELD, seat: null } }, where: lethalCondition('candidate') },
    },
  ],
  condition: lethalCondition('host'),
  continuous: true,
};

/**
 * Card-attached to Bear, `trigger:'onZoneEnter'` — deliberately reusing the one case where
 * `triggeringCardId` IS bound to the card carrying the rule (`resolveBindings`'s `selfScoped` check,
 * §5.1), which is what lets this rule address "myself" via `{kind:'triggeringCard'}` at all. Same
 * caveat `duel.ts`'s `gruntRule` already documents: fires on ANY zone entry, not "entering the
 * battlefield as a declared blocker" specifically (no `ValueRef` reads which zone fired an event).
 *
 * The test drives this by placing the attacker directly via `board.ts`'s `place()` (bypassing
 * `onZoneEnter` for it) and then moving the blocker onto the Battlefield with a real `moveCard`
 * action, so the attacker is the ONLY other creature present — `{kind:'zoneTop'}` on the (shared,
 * unordered) Battlefield resolves to it.
 *
 * Effects: attach blocker → attacker; blocker takes attacker's power as damage; attacker takes
 * blocker's power as damage (`{kind:'hostOf', card:{kind:'triggering'}}` — "the card the triggering
 * card [blocker] is attached to", i.e. the attacker, resolvable once the attach above has run,
 * since effects apply in order). Drives MTG11 together with `lethalDamageRule`.
 */
export const blockRule: RuleSet = {
  ...baseRule,
  id: RS_BLOCK,
  name: 'Declare Block',
  trigger: 'onZoneEnter',
  effects: [
    { kind: 'attach', target: { kind: 'triggeringCard' }, host: { kind: 'zoneTop', zone: { zoneId: MTG_BATTLEFIELD, seat: null } } },
    {
      kind: 'setCardIndex',
      target: { kind: 'triggeringCard' },
      indexId: DAMAGE,
      op: 'add',
      amount: { kind: 'cardIndex', card: { kind: 'host' }, indexId: MTG_POWER },
    },
    {
      kind: 'setCardIndex',
      target: { kind: 'hostOf', card: { kind: 'triggering' } },
      indexId: DAMAGE,
      op: 'add',
      amount: { kind: 'cardIndex', card: { kind: 'triggering' }, indexId: MTG_POWER },
    },
  ],
};

/** One global rule PER SEAT (engine ceiling — a single global rule only ever fires once for the
 * whole board). Drives MTG9. */
function oustRule(id: string, seat: 0 | 1): RuleSet {
  return {
    ...baseRule,
    id,
    name: `Oust Seat ${seat}`,
    trigger: 'onGameStart',
    effects: [{ kind: 'eliminateSeat', seat: { kind: 'seat', index: seat } }],
    condition: {
      kind: 'criteria',
      left: { kind: 'pool', poolId: LIFE, seat: { kind: 'seat', index: seat } },
      op: '<=',
      right: lit(0),
    },
    continuous: true,
  };
}

export const oustSeat0Rule = oustRule(RS_OUST_SEAT0, 0);
export const oustSeat1Rule = oustRule(RS_OUST_SEAT1, 1);

const ruleSets: RuleSet[] = [
  boltRule,
  boltResolveRule,
  counterMagicRule,
  powerSetRule,
  anthemLordRule,
  mindControlRule,
  returnToOwnerRule,
  drawTwoInsteadRule,
  lethalDamageRule,
  blockRule,
  oustSeat0Rule,
  oustSeat1Rule,
];

const globalRuleSetIds: string[] = [returnToOwnerRule.id, drawTwoInsteadRule.id, oustSeat0Rule.id, oustSeat1Rule.id];

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const combatIndexes = [
  { id: MTG_POWER, value: { type: 'integer' as const, name: 'Power', defaultValue: 2, min: 0, max: 99 }, icon: 'gi-broadsword', position: 'bottomLeft' as const },
  { id: TOUGHNESS, value: { type: 'integer' as const, name: 'Toughness', defaultValue: 2, min: 0, max: 99 }, icon: 'gi-shield', position: 'bottomRight' as const },
  { id: DAMAGE, value: { type: 'integer' as const, name: 'Damage', defaultValue: 0, min: 0, max: 99 }, icon: 'gi-bleeding-wound', position: 'topRight' as const },
];

const templates: CardTemplate[] = [
  { id: BOLT, name: 'Bolt', marquee: 'Bolt', faceIcon: 'gi-lightning-bow', borderColor: '#9e2f26', tags: ['instant'], indexes: [], ruleSetIds: [RS_BOLT], rulesTextOverride: null },
  { id: BEAR, name: 'Bear', marquee: 'Bear', faceIcon: 'gi-bear-head', borderColor: '#2b6034', tags: [MTG_CREATURE_TAG], indexes: combatIndexes, ruleSetIds: [RS_LETHAL_DAMAGE, RS_BLOCK], rulesTextOverride: null },
  { id: COUNTER_MAGIC, name: 'Counter Magic', marquee: 'Counter Magic', faceIcon: 'gi-cancel', borderColor: '#26467f', tags: ['instant'], indexes: [], ruleSetIds: [RS_COUNTER_MAGIC], rulesTextOverride: null },
  { id: ANTHEM_LORD, name: 'Anthem Lord', marquee: 'Anthem Lord', faceIcon: 'gi-crown', borderColor: '#9a6a12', tags: [MTG_CREATURE_TAG], indexes: combatIndexes, ruleSetIds: [RS_ANTHEM_LORD], rulesTextOverride: null },
  { id: POWER_SET, name: 'Humility', marquee: 'Humility', faceIcon: 'gi-halo', borderColor: '#7a7a7a', tags: [MTG_CREATURE_TAG], indexes: combatIndexes, ruleSetIds: [RS_POWER_SET], rulesTextOverride: null },
  { id: MIND_CONTROL, name: 'Mind Control', marquee: 'Mind Control', faceIcon: 'gi-brain', borderColor: '#5a2b7a', tags: ['sorcery'], indexes: [], ruleSetIds: [RS_MIND_CONTROL], rulesTextOverride: null },
];

// ---------------------------------------------------------------------------
// Deck — small, enough for scripted scenarios, not 40 (S2 is duel.ts's job).
// ---------------------------------------------------------------------------

const decks: Deck[] = [
  {
    id: MTG_STARTER_DECK,
    name: 'Starter',
    zoneId: MTG_LIBRARY,
    entries: templates.map((t) => ({ templateId: t.id, quantity: 2 })),
  },
];

// ---------------------------------------------------------------------------
// State machine — minimal Start → Main → End; not exercising state-machine breadth (duel.ts's job).
// ---------------------------------------------------------------------------

const states: MachineState[] = [
  { ...START_NODE, exitableTo: [MTG_MAIN] },
  { id: MTG_MAIN, name: 'Main', enterableFrom: [START_STATE_ID, MTG_END_TURN], exitableTo: [MTG_END_TURN], entryCriteria: null, transitionLabel: null, priority: 0, position: { x: 200, y: 0 } },
  { id: MTG_END_TURN, name: 'End Turn', enterableFrom: [MTG_MAIN], exitableTo: [MTG_MAIN, END_STATE_ID], entryCriteria: null, transitionLabel: 'End Turn', priority: 0, position: { x: 400, y: 0 } },
  { ...END_NODE, enterableFrom: [MTG_END_TURN], position: { x: 600, y: 0 } },
];

const LIMITS = {
  maxDepth: DEFAULT_MAX_DEPTH,
  maxEffects: DEFAULT_MAX_EFFECTS,
  maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
  maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
};

export const mtgish: GameDefinition = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: 'game_mtgish',
  name: 'MTG-ish',
  playerCount: 2,
  pools,
  zones,
  templates,
  decks,
  customEvents: [],
  ruleSets,
  globalRuleSetIds,
  priorityWindows,
  machine: { states, startStateId: START_STATE_ID, endStateId: END_STATE_ID },
  limits: LIMITS,
  updatedAt: FIXTURE_UPDATED_AT,
});
