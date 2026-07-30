/**
 * Sparkbloom Duel — a shipped two-seat Magic-alike, emitted to `samples/magic.json` by
 * `src/test/mtg.test.ts` and imported through the ordinary game-list importer (§7.1).
 *
 * v4 §6 — this file is the PROOF for the v4 primitives, not a demo of them: every one of G1–G8 is
 * load-bearing somewhere below, on a pool small enough to read and large enough to play a real game
 * with (two colours, a land drop, a clock, and a way to interact with your opponent's spells).
 *
 * Authored in TypeScript rather than hand-written JSON for the reason `holdem.ts:5` gives: a dozen
 * templates plus ~45 rules of casting plumbing is not something anyone should type twice, and the
 * `GameDefinition` type catches a mistyped effect kind here instead of at import time.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ENGINE CANNOT DO, AND WHAT THE SAMPLE DOES INSTEAD
 * ---------------------------------------------------------------------------
 *
 *  1. **"Until end of turn" has no primitive (G7), so a combat trick is a tag plus a cleanup rule.**
 *     REQUIREMENTS § v4 calls this "authorable, badly", and it is: `Giant Growth` is SIX effects for
 *     one line of card text. It tags the chosen creature `growing` (the tag is what lets one prompt
 *     drive several effects — each prompting effect would otherwise raise its OWN prompt and nothing
 *     would make the two answers agree), pumps everything tagged `growing`, marks it `grown` for the
 *     cleanup, then clears `growing` again. `rs_growthWearsOff` in the End step subtracts the same
 *     3/3 back off everything tagged `grown`. Two known flaws, both inherent to the workaround:
 *     it is one rule PER MAGNITUDE, and a boolean tag cannot count — two Growths on the SAME
 *     creature take 6 and give back 3.
 *
 *  2. **`CardRef{self}` can be READ but never TARGETED.** G4 landed the reference; no
 *     `TargetSelector` arm consumes a `CardRef`, so a rule can *test* the card carrying it and can
 *     use its indexes as an amount, but nothing can tap, sacrifice, pump or move ITSELF. Three cards
 *     are shaped around that, not by preference:
 *       - a land has no ability of its own; `rs_tapMountain`/`rs_tapForest` are GLOBAL activations
 *         whose interactive cost (G5) prompts over your own untapped lands of that type;
 *       - `rs_strike` cannot tap the creature that strikes, so striking spends an `Attacks` pool
 *         (note 13) instead of tapping;
 *       - `Bone Altar` sacrifices a CHOSEN creature you control rather than itself.
 *     The only workaround that exists today is to `attach` a card to itself and then address it as
 *     `attachedTo{host:{kind:'self'}}`. It works. It is also unreadable and it burns the attachment
 *     field, so nothing here does it — see the step-48 report.
 *
 *  3. **Nothing reads a card's ZONE, so a `perInstance` ability is offered for every copy in the
 *     game.** `activatableRules` (`priority.ts`) walks `state.cards` and deliberately does not
 *     restrict a `perInstance` rule by zone or by controller, and no `ValueRef` says which zone a
 *     card is in — so without a gate, `Strike` would be offered on creatures still in the library.
 *     The `Ready` index is that gate: 0 by default, set to 1 only by the untap step, which only ever
 *     touches the battlefield. `self.Ready = 1` therefore means "on the battlefield AND not
 *     summoning-sick" in one criterion, which is also why summoning sickness needed no primitive.
 *
 *  4. **Nothing reads the current machine state, or the acting seat's number, so both are pools.**
 *     `Phase` is written by each state's own `onStateEnter` rule, and "sorcery speed" is
 *     `Phase = Main` in a `costCheck` — `RuleSet.stateFilter` narrows a state EVENT and does nothing
 *     for an activation. `Seat` is seeded with each seat's own index at game start, because no
 *     `ValueRef` yields "the seat asking this question": `Seat(me) = activePlayer` is the only way to
 *     write "it is my turn", and `Seat(controller-of-self) = Seat(me)` the only way to write "I
 *     control this card". Both read like plumbing on the board because they are.
 *
 *  5. **No selector filters by controller, so the Battlefield is PLAYER-scoped.** Magic has one
 *     shared battlefield; `mtgish.ts` copies that and documents the consequence — its Anthem Lord
 *     buffs everyone's creatures, because no criterion reads a card's controller as a comparable
 *     value. "Creatures you control" is only expressible as a ZONE, so each seat gets their own
 *     Battlefield instance and `countMatching(taggedInZone(battlefield#me, 'creature'))` is exact.
 *     Price: a board-wide sweep needs `seat: {kind:'all'}` (the lethal-damage rule, the damage wipe).
 *
 *  6. **`activation.window` is ONE window id, so everything happens inside one window.** An ability
 *     cannot be legal both inside a priority window and outside it, and authoring every card twice to
 *     get instant speed is worse than the alternative: Main and Combat each `openPriority` on entry,
 *     every activation names that same window, and SPEED is expressed by note 4's phase check
 *     instead. Passing the whole table therefore ends a phase, which is close to Magic anyway.
 *
 *  7. **Casting is an activation, not a drag.** A tester's `moveCard` is the only thing that fires
 *     `onCardPlayed` and nothing gates it, so a drag-to-cast model cannot enforce a mana cost at all
 *     (`changePool` CLAMPS at the pool minimum rather than refusing — AC A4). Each card therefore has
 *     a `Cast X` activation whose interactive cost (G5) pays the mana and moves the chosen copy from
 *     hand onto your Stack zone, and whose one effect is `announceAction` (so the opponent gets
 *     priority — MTG1). Two consequences: you answer a one-candidate prompt to say WHICH copy, and
 *     the resolve rule addresses the spell POSITIONALLY as `topOfZone(stack#me, 1)`, which is exact
 *     because `announceAction` freezes it at announce time (§4.8) — later spells cannot re-aim it.
 *
 *  8. **`destroyCards` deletes the card outright**, so a creature that dies does not reach the
 *     graveyard (§4.7's product ruling: "a destroyed card DOES leave its zone"). Spells move
 *     themselves to the graveyard on resolution; dead creatures simply vanish.
 *
 *  9. **Nothing in the pool counters a spell.** `counterAction` removes the `PendingAction`, and no
 *     `TargetSelector` reads a pending action's CARD, so a countered spell's physical card would sit
 *     on the Stack zone with nothing able to bin it. MTG3 already proves `counterAction` on
 *     `mtgish.ts`; here a response is an instant (`Lightning Bolt`, `Splinter Storm`, `Giant Growth`).
 *
 * 10. **One `modifier` per RuleSet, so +1/+1 is two rules** — `rs_lordPower` and `rs_lordToughness`.
 *     Both read `{kind:'controller', card:{kind:'self'}}` for their scope's seat, which is G4 doing
 *     the one thing it can do: identify the card carrying the rule in order to READ something off it.
 *
 * 11. **A sweep over an empty set is a rejection, not a no-op** — NO_TARGETS (§5.9 row 2), continued
 *     past because every rule here is `onRejection: 'continue'`. So the untap step logs refusals on a
 *     board with no lands yet. Guarded with a `countMatching >= 1` condition where the noise would be
 *     every-turn (`rs_growthWearsOff`), accepted where guarding it would mean one rule per effect.
 *
 * 12. **Life reaching 0 is not a win condition.** `eliminateSeat` drops a seat from `seatOrder`, and
 *     the turn-advance rules would then walk `activePlayer` onto an ousted seat in a two-seat game.
 *     `Life` clamps at 0, the table sees it, and the table stops — the same human-judged ending
 *     `holdem.ts` note 1 settles on for a showdown.
 *
 * 13. **No combat.** v4's non-goals keep combat out of the engine, so `rs_strike` is the stand-in: ONE
 *     `perInstance` activation referenced by id from every creature template (REQUIREMENTS § v4's
 *     "keyword *behaviour* is one shared `RuleSet`"), dealing that creature's own power — read through
 *     `cardIndex(self, Power)`, so every modifier and every Giant Growth on the board is included
 *     (MTG6) — to a player chosen with `chooseSeat` (G3). It is limited by an `Attacks` pool refilled
 *     at untap to `countMatching(your creatures)`, because note 2 means a striker cannot tap itself.
 *     So one creature striking twice while another sits idle is legal here. There are no attackers,
 *     no blockers and no first strike, and nothing below pretends otherwise.
 *
 * 14. **Mana empties on every state exit** — one rule with `stateFilter: null`, which fires for every
 *     state change there is. That is "mana empties at end of step" with no per-state duplication.
 */

import type {
  CardIndex,
  CardTemplate,
  CriteriaNode,
  Deck,
  Effect,
  GameDefinition,
  MachineState,
  PlayZone,
  PointPool,
  PriorityWindow,
  RuleSet,
  SeatRef,
  TargetSelector,
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

export const SEAT_COUNT = 2;
export const SEATS = Array.from({ length: SEAT_COUNT }, (_, i) => i);
export const STARTING_LIFE = 20;
export const OPENING_HAND = 5;
/** Enough that a `chooseNumber` for {X} has room; nothing authored here can generate more. */
export const MAX_MANA = 20;

// ---------------------------------------------------------------------------
// Pools. `Phase` and `Seat` are plumbing, not flavour — header notes 4 and 6.
// ---------------------------------------------------------------------------

export const LIFE = 'pool_life';
export const MANA_R = 'pool_manaRed';
export const MANA_G = 'pool_manaGreen';
export const LAND_PLAYED = 'pool_landPlayed';
export const ATTACKS = 'pool_attacks';
export const PHASE = 'pool_phase';
export const SEAT_NO = 'pool_seatNumber';

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export const LIBRARY = 'zone_library';
export const HAND = 'zone_hand';
/** Player-scoped on purpose: a SHARED zone has no seat, and `announceAction` needs one (note 7). */
export const STACK = 'zone_stack';
/** Player-scoped on purpose: this is the only way to say "creatures you control" (note 5). */
export const BATTLEFIELD = 'zone_battlefield';
export const GRAVEYARD = 'zone_graveyard';

// ---------------------------------------------------------------------------
// Card indexes
// ---------------------------------------------------------------------------

export const POWER = 'idx_power';
export const TOUGHNESS = 'idx_toughness';
export const DAMAGE = 'idx_damage';
/** 0 = cannot act (in a hidden zone, or summoned this turn); 1 = on the battlefield and ready. Note 3. */
export const READY = 'idx_ready';
/** Lands only. `rotated` is the visual; this is the value a criterion can actually read. */
export const TAPPED = 'idx_tapped';

// ---------------------------------------------------------------------------
// Tags. Card TYPES are tags (REQUIREMENTS § v4), and so is the per-card tag a `Cast X` cost prompts
// over — the cast rule has to name its own card somehow, and a tag is the only handle a selector has.
// ---------------------------------------------------------------------------

export const T_LAND = 'land';
export const T_CREATURE = 'creature';
export const T_INSTANT = 'instant';
export const T_SORCERY = 'sorcery';
export const T_ARTIFACT = 'artifact';
export const T_MOUNTAIN = 'mountain';
export const T_FOREST = 'forest';
export const T_CANNON = 'cannon';
export const T_ALTAR = 'altar';
/** Transient, one resolution long: what lets ONE prompt drive several effects (note 1). */
export const T_GROWING = 'growing';
/** Persistent until the End step: what `rs_growthWearsOff` sweeps (note 1). */
export const T_GROWN = 'grown';

// ---------------------------------------------------------------------------
// Phases — the values `pool_phase` holds (note 4)
// ---------------------------------------------------------------------------

export const PH_UNTAP = 0;
export const PH_DRAW = 1;
export const PH_MAIN = 2;
export const PH_COMBAT = 3;
export const PH_END = 4;

// ---------------------------------------------------------------------------
// States, the one window, and prompt keys
// ---------------------------------------------------------------------------

export const S_UNTAP = 'state_untap';
export const S_DRAW = 'state_draw';
export const S_MAIN = 'state_main';
export const S_COMBAT = 'state_combat';
export const S_END_STEP = 'state_endStep';

export const WIN_STACK = 'win_stack';

/** `chooseSeat`/`chooseNumber` answers are read back by these keys — §4.3, §4.5. */
export const K_STRIKE = 'strikeTarget';
export const K_BOLT = 'boltTarget';
export const K_WARCRY = 'warCryTarget';
export const K_CANNON = 'cannonTarget';
export const K_ALTAR = 'altarTarget';
export const K_STORM = 'stormTarget';
export const K_X = 'cannonX';

export const MTG_DECK = 'deck_sparkbloom';

// ---------------------------------------------------------------------------
// Rule ids that are not derived from a card (the derived ones are `rs_cast_*`/`rs_resolve_*`)
// ---------------------------------------------------------------------------

export const RS_SETUP = 'rs_setup';
export const RS_EMPTY_MANA = 'rs_emptyMana';
export const RS_UNTAP = 'rs_untapStep';
export const RS_DRAW = 'rs_drawStep';
export const RS_MAIN = 'rs_mainPhase';
export const RS_COMBAT = 'rs_combatPhase';
export const RS_END_STEP = 'rs_endStep';
export const RS_GROWTH_OFF = 'rs_growthWearsOff';
export const RS_TURN_ADVANCE = 'rs_turnAdvance';
export const RS_TURN_WRAP = 'rs_turnWrap';
export const RS_PLAY_LAND = 'rs_playLand';
export const RS_TAP_MOUNTAIN = 'rs_tapMountain';
export const RS_TAP_FOREST = 'rs_tapForest';
export const RS_STRIKE = 'rs_strike';
export const RS_CANNON = 'rs_emberCannonAbility';
export const RS_ALTAR = 'rs_boneAltarAbility';
export const RS_LORD_POWER = 'rs_lordPower';
export const RS_LORD_TOUGHNESS = 'rs_lordToughness';
export const RS_LETHAL = 'rs_lethalDamage';

// ---------------------------------------------------------------------------
// Small builders — the same shapes appear a hundred times below
// ---------------------------------------------------------------------------

const lit = (value: number | boolean): ValueRef => ({ kind: 'literal', value });
const at = (index: number): SeatRef => ({ kind: 'seat', index });
/** The seat acting: the activating seat for an activation, the action's controller at resolve time. */
const me: SeatRef = { kind: 'triggeringSeat' };
const active: SeatRef = { kind: 'active' };
const everySeat: SeatRef = { kind: 'all' };
const zone = (zoneId: string, seat: SeatRef | null = null): ZoneRef => ({ zoneId, seat });
const mine = (zoneId: string): ZoneRef => zone(zoneId, me);
const poolOf = (poolId: string, seat: SeatRef | null): ValueRef => ({ kind: 'pool', poolId, seat });
const idxOf = (card: 'self' | 'candidate', indexId: string): ValueRef => ({
  kind: 'cardIndex',
  card: { kind: card },
  indexId,
});
const countOf = (from: TargetSelector): ValueRef => ({ kind: 'countMatching', from });
const cmp = (left: ValueRef, op: '=' | '>=' | '>', right: ValueRef): CriteriaNode => ({
  kind: 'criteria',
  left,
  op,
  right,
});
const every = (...children: CriteriaNode[]): CriteriaNode => ({ kind: 'group', combinator: 'and', children });
const tagged = (zoneId: string, seat: SeatRef | null, tag: string): TargetSelector => ({
  kind: 'taggedInZone',
  zone: zone(zoneId, seat),
  tag,
});
const withTag = (from: TargetSelector, tag: string): TargetSelector => ({
  kind: 'matching',
  from,
  where: { kind: 'criteria', left: { kind: 'cardTag', card: { kind: 'candidate' }, tag }, op: '=', right: lit(true) },
});
const pick = (from: TargetSelector, promptText: string): TargetSelector => ({
  kind: 'prompt',
  from,
  count: lit(1),
  promptText,
});
const setPool = (poolId: string, seat: SeatRef | null, value: number | boolean): Effect => ({
  kind: 'changePool',
  poolId,
  seat,
  op: 'set',
  amount: lit(value),
});

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

/** Creatures you control / anybody's creatures — note 5's whole point. */
const myCreatures = tagged(BATTLEFIELD, me, T_CREATURE);
const allCreatures = tagged(BATTLEFIELD, everySeat, T_CREATURE);
/** The spell now resolving, addressed positionally and frozen at announce (note 7). */
const thisSpell: TargetSelector = { kind: 'topOfZone', zone: mine(STACK), count: lit(1) };

/** Note 4 — the two criteria the engine has no primitive for. */
const isMyTurn = cmp(poolOf(SEAT_NO, me), '=', poolOf(ACTIVE_PLAYER_POOL_ID, null));
const inPhase = (phase: number): CriteriaNode => cmp(poolOf(PHASE, null), '=', lit(phase));
const iControlSelf = cmp(
  poolOf(SEAT_NO, { kind: 'controller', card: { kind: 'self' } }),
  '=',
  poolOf(SEAT_NO, me)
);

/** Damage to a player, aimed at whichever seat answered `key` — G3, four cards deep. */
function burn(key: string, promptText: string, amount: ValueRef): Effect[] {
  return [
    { kind: 'chooseSeat', promptText, seat: me, key },
    { kind: 'changePool', poolId: LIFE, seat: { kind: 'promptSeat', key }, op: 'subtract', amount },
  ];
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

const pools: PointPool[] = [
  {
    id: LIFE,
    scope: 'player',
    // max above 20 because `Sylvan Tally` gains life; min 0 because note 12 stops there.
    value: { type: 'integer', name: 'Life', defaultValue: STARTING_LIFE, min: 0, max: 60 },
  },
  { id: MANA_R, scope: 'player', value: { type: 'integer', name: 'Red Mana', defaultValue: 0, min: 0, max: MAX_MANA } },
  { id: MANA_G, scope: 'player', value: { type: 'integer', name: 'Green Mana', defaultValue: 0, min: 0, max: MAX_MANA } },
  {
    id: LAND_PLAYED,
    scope: 'player',
    // The once-per-turn land drop (MTG12). Cleared by the untap step for the ACTIVE seat only.
    value: { type: 'boolean', name: 'Land Played', defaultValue: false },
  },
  {
    id: ATTACKS,
    scope: 'player',
    // Note 13 — refilled to your creature count at untap, spent one per strike.
    value: { type: 'integer', name: 'Attacks', defaultValue: 0, min: 0, max: 99 },
  },
  { id: PHASE, scope: 'game', value: { type: 'integer', name: 'Phase', defaultValue: PH_UNTAP, min: 0, max: PH_END } },
  {
    id: SEAT_NO,
    scope: 'player',
    // Note 4. Seeded per seat by `rs_setup`; defaults are uniform, so it cannot be authored here.
    value: { type: 'integer', name: 'Seat', defaultValue: 0, min: 0, max: SEAT_COUNT - 1 },
  },
];

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

const zones: PlayZone[] = [
  { id: LIBRARY, name: 'Library', scope: 'player', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null },
  { id: HAND, name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: null },
  { id: STACK, name: 'Stack', scope: 'player', visibility: 'faceUp', layout: 'stack', ordered: true, maxCapacity: null },
  { id: BATTLEFIELD, name: 'Battlefield', scope: 'player', visibility: 'faceUp', layout: 'row', ordered: true, maxCapacity: null },
  { id: GRAVEYARD, name: 'Graveyard', scope: 'player', visibility: 'faceUp', layout: 'stack', ordered: true, maxCapacity: null },
];

// ---------------------------------------------------------------------------
// The one priority window (note 6). Opened by Main and Combat on entry, and again by every
// `announceAction` over the spell it just put on the stack — MTG1's LIFO stack falls out of that.
// ---------------------------------------------------------------------------

const stackWindow: PriorityWindow = {
  id: WIN_STACK,
  name: 'Priority',
  start: 'active',
  direction: 'forward',
  includeStart: true,
  // null => `activeSeatCount`: both seats passing in a row closes it.
  passesToClose: null,
  collapseEmptyOffers: true,
};

// ---------------------------------------------------------------------------
// Casting — one activation and one resolve-only rule per card (note 7)
// ---------------------------------------------------------------------------

interface Card {
  /** Template id suffix, prompt tag, and rule-id stem all at once. */
  key: string;
  name: string;
  icon: string;
  border: string;
  /** Mana cost, as counts of each colour. */
  r?: number;
  g?: number;
  /** Card TYPES are tags; the first one drives the sample's own type checks. */
  types: string[];
  /** false => an instant: castable in any phase, on anybody's turn (note 6 explains why not both). */
  sorcerySpeed: boolean;
  /** true => resolves onto your Battlefield; false => the card goes to your Graveyard. */
  permanent: boolean;
  /** What resolution DOES, before the card itself is put where it belongs. */
  onResolve: Effect[];
  power?: number;
  toughness?: number;
  /** Rules the card carries for their own sake: abilities, modifiers, and `rs_strike`. */
  carries?: string[];
  rulesText: string;
}

const castId = (key: string): string => `rs_cast_${key}`;
const resolveId = (key: string): string => `rs_resolve_${key}`;

function manaLabel(card: Card): string {
  return `${'{R}'.repeat(card.r ?? 0)}${'{G}'.repeat(card.g ?? 0)}` || '{0}';
}

/**
 * The `Cast X` activation. Pays the mana and moves the chosen copy from hand onto your Stack zone in
 * the COST — v4 §4.5's two-pass cost, which is what makes the mana all-or-nothing: cancel the "which
 * copy" prompt and nothing has been spent (SP18(c)). The spend is deliberately ahead of the prompt in
 * the list, the same way `activation.test.ts`'s fixture orders it: pass 1 has to walk the whole cost
 * looking for questions before pass 2 applies any of it.
 */
function castRule(card: Card): RuleSet {
  const spend: Effect[] = [];
  const gates: CriteriaNode[] = [];
  if (card.r) {
    gates.push(cmp(poolOf(MANA_R, me), '>=', lit(card.r)));
    spend.push({ kind: 'changePool', poolId: MANA_R, seat: me, op: 'subtract', amount: lit(card.r) });
  }
  if (card.g) {
    gates.push(cmp(poolOf(MANA_G, me), '>=', lit(card.g)));
    spend.push({ kind: 'changePool', poolId: MANA_G, seat: me, op: 'subtract', amount: lit(card.g) });
  }
  return {
    ...baseRule,
    id: castId(card.key),
    name: `Cast ${card.name}`,
    // Never dispatched: an activation is reached through `activate`, never through an event.
    trigger: `never_cast_${card.key}`,
    effects: [{ kind: 'announceAction', ruleId: resolveId(card.key), window: WIN_STACK }],
    activation: {
      costCheck: every(
        ...gates,
        cmp(countOf(tagged(HAND, me, card.key)), '>=', lit(1)),
        // Sorcery speed is a phase check, not a window (notes 4 and 6).
        ...(card.sorcerySpeed ? [inPhase(PH_MAIN), isMyTurn] : [])
      ),
      cost: [
        ...spend,
        {
          kind: 'moveCards',
          target: pick(tagged(HAND, me, card.key), `Cast ${card.name} — which copy?`),
          to: mine(STACK),
          position: 'top',
        },
      ],
      window: WIN_STACK,
      perInstance: false,
      label: `Cast ${card.name} ${manaLabel(card)}`,
    },
  };
}

/**
 * Resolve-only — never an event trigger, only reachable through a `resolve` frame (§8 step 22).
 *
 * The trailing `moveCards` is where the physical card goes. Its `topOfZone(stack#me, 1)` target is
 * resolved and FROZEN by `announceAction` at cast time (§4.8), so it names this spell even after
 * another spell has been stacked on top of it, and even after the effects above it have suspended for
 * a prompt.
 */
function resolveRule(card: Card): RuleSet {
  return {
    ...baseRule,
    id: resolveId(card.key),
    name: `${card.name} (resolve)`,
    trigger: `never_resolve_${card.key}`,
    effects: [
      ...card.onResolve,
      {
        kind: 'moveCards',
        target: thisSpell,
        to: mine(card.permanent ? BATTLEFIELD : GRAVEYARD),
        position: 'top',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The pool. Two colours: red burns, green builds a board.
// ---------------------------------------------------------------------------

const CARDS: Card[] = [
  {
    key: 'mountain',
    name: 'Mountain',
    icon: 'gi-mountains',
    border: '#9e2f26',
    types: [T_LAND, T_MOUNTAIN],
    sorcerySpeed: true,
    permanent: true,
    onResolve: [],
    // A land is not cast: `rs_playLand` moves it straight to the battlefield under the once-per-turn
    // limit, which is the only kind of play in this game that a RULE restricts (MTG12).
    rulesText: 'Land — tap for {R} (once per turn you may play a land).',
  },
  {
    key: 'forest',
    name: 'Forest',
    icon: 'gi-forest',
    border: '#2b6034',
    types: [T_LAND, T_FOREST],
    sorcerySpeed: true,
    permanent: true,
    onResolve: [],
    rulesText: 'Land — tap for {G} (once per turn you may play a land).',
  },
  {
    key: 'bolt',
    name: 'Lightning Bolt',
    icon: 'gi-bolt-spell-cast',
    border: '#9e2f26',
    r: 1,
    types: [T_INSTANT],
    sorcerySpeed: false,
    permanent: false,
    // G3, at its simplest: "target player".
    onResolve: burn(K_BOLT, 'Lightning Bolt — which player takes 3?', lit(3)),
    rulesText: 'Instant {R} — Lightning Bolt deals 3 damage to target player.',
  },
  {
    key: 'raider',
    name: 'Goblin Raider',
    icon: 'gi-goblin-head',
    border: '#9e2f26',
    r: 1,
    types: [T_CREATURE],
    sorcerySpeed: true,
    permanent: true,
    onResolve: [],
    power: 2,
    toughness: 1,
    carries: [RS_STRIKE],
    rulesText: 'Creature {R} 2/1 — the plain creature: cast it through the stack, strike with it in combat.',
  },
  {
    key: 'warcry',
    name: 'Goblin War Cry',
    icon: 'gi-goblin',
    border: '#9e2f26',
    r: 2,
    types: [T_SORCERY],
    sorcerySpeed: true,
    permanent: false,
    // G2's headline card: the fold that v2 had no expression for at all.
    onResolve: burn(
      K_WARCRY,
      'Goblin War Cry — which player takes it?',
      countOf(myCreatures)
    ),
    rulesText:
      'Sorcery {R}{R} — Goblin War Cry deals damage equal to the number of creatures you control to target player.',
  },
  {
    key: 'cannon',
    name: 'Ember Cannon',
    icon: 'gi-burning-round-shot',
    border: '#9e2f26',
    r: 2,
    types: [T_ARTIFACT, T_CANNON],
    sorcerySpeed: true,
    permanent: true,
    onResolve: [],
    carries: [RS_CANNON],
    rulesText: 'Artifact {R}{R} — {X}{R}: Ember Cannon deals X damage to target player.',
  },
  {
    key: 'storm',
    name: 'Splinter Storm',
    icon: 'gi-thrown-daggers',
    border: '#9e2f26',
    r: 1,
    types: [T_INSTANT],
    sorcerySpeed: false,
    permanent: false,
    // G8: BOTH modes need an interaction of their own, which is precisely what a modal branch could
    // not do before v4 — one asks for a seat, the other for a card.
    onResolve: [
      {
        kind: 'chooseMode',
        promptText: 'Splinter Storm — choose one',
        seat: me,
        modes: [
          { label: 'Deal 2 damage to target player', effects: burn(K_STORM, 'Splinter Storm — which player takes 2?', lit(2)) },
          {
            label: 'Destroy target creature',
            effects: [
              { kind: 'destroyCards', target: pick(allCreatures, 'Splinter Storm — destroy which creature?') },
            ],
          },
        ],
      },
    ],
    rulesText: 'Instant {R} — Choose one: Splinter Storm deals 2 damage to target player; or destroy target creature.',
  },
  {
    key: 'bear',
    name: 'Grizzly Bear',
    icon: 'gi-bear-head',
    border: '#2b6034',
    g: 1,
    types: [T_CREATURE],
    sorcerySpeed: true,
    permanent: true,
    onResolve: [],
    power: 2,
    toughness: 2,
    carries: [RS_STRIKE],
    rulesText: 'Creature {G} 2/2 — a body: something for the Lord to buff and the Altar to eat.',
  },
  {
    key: 'lord',
    name: 'Timber Lord',
    icon: 'gi-crown',
    border: '#2b6034',
    g: 2,
    types: [T_CREATURE],
    sorcerySpeed: true,
    permanent: true,
    onResolve: [],
    power: 2,
    toughness: 2,
    carries: [RS_STRIKE, RS_LORD_POWER, RS_LORD_TOUGHNESS],
    rulesText: 'Creature {G}{G} 2/2 — Creatures you control get +1/+1 (this one included).',
  },
  {
    key: 'growth',
    name: 'Giant Growth',
    icon: 'gi-crystal-growth',
    border: '#2b6034',
    g: 1,
    types: [T_INSTANT],
    sorcerySpeed: false,
    permanent: false,
    // Note 1 — G7's absence, in full. Six effects, and the last two exist only to make the FIRST
    // prompt's answer reusable by the effects after it.
    onResolve: [
      { kind: 'setTag', target: pick(allCreatures, 'Giant Growth — which creature?'), tag: T_GROWING, on: true },
      { kind: 'setCardIndex', target: withTag(allCreatures, T_GROWING), indexId: POWER, op: 'add', amount: lit(3) },
      { kind: 'setCardIndex', target: withTag(allCreatures, T_GROWING), indexId: TOUGHNESS, op: 'add', amount: lit(3) },
      { kind: 'setTag', target: withTag(allCreatures, T_GROWING), tag: T_GROWN, on: true },
      { kind: 'setTag', target: withTag(allCreatures, T_GROWING), tag: T_GROWING, on: false },
    ],
    rulesText: 'Instant {G} — Target creature gets +3/+3 until end of turn.',
  },
  {
    key: 'altar',
    name: 'Bone Altar',
    icon: 'gi-skull-crossed-bones',
    border: '#2b6034',
    g: 2,
    types: [T_ARTIFACT, T_ALTAR],
    sorcerySpeed: true,
    permanent: true,
    onResolve: [],
    carries: [RS_ALTAR],
    rulesText: 'Artifact {G}{G} — Sacrifice a creature: Bone Altar deals 2 damage to target player.',
  },
  {
    key: 'tally',
    name: 'Sylvan Tally',
    icon: 'gi-chestnut-leaf',
    border: '#2b6034',
    g: 1,
    types: [T_SORCERY],
    sorcerySpeed: true,
    permanent: false,
    // G2's second fold. `sumIndex` reads through `effectiveIndex`, so a Lord on the board and a Giant
    // Growth from two turns' worth of tricks are both counted — the point §4.1 makes about it.
    onResolve: [
      {
        kind: 'changePool',
        poolId: LIFE,
        seat: me,
        op: 'add',
        amount: { kind: 'sumIndex', from: myCreatures, indexId: POWER },
      },
    ],
    rulesText: 'Sorcery {G} — You gain life equal to the total power of the creatures you control.',
  },
];

const cardByKey = (key: string): Card => {
  const card = CARDS.find((c) => c.key === key);
  if (!card) throw new Error(`no card "${key}"`);
  return card;
};

// ---------------------------------------------------------------------------
// Turn structure. A state machine plus the reserved `activePlayer` pool, which REQUIREMENTS § v4
// names as the documented way; the phases here are trimmed to the five the cards actually read.
// ---------------------------------------------------------------------------

/** Note 4 — every phase writes its own number, because nothing can read `currentStateId`. */
const setupRule: RuleSet = {
  ...baseRule,
  id: RS_SETUP,
  name: 'Set Up the Duel',
  trigger: 'onGameStart',
  effects: [
    // Note 4: a pool's `defaultValue` is one value for every seat, so "each seat knows its own
    // number" has to be written once per seat here.
    ...SEATS.map((seat) => setPool(SEAT_NO, at(seat), seat)),
    // Per seat, because `drawCards` resolves its zone to exactly ONE seat (`effects.ts`'s `oneKey`)
    // — the same reason `holdem.ts`'s deal is written out per seat.
    ...SEATS.map(
      (seat): Effect => ({
        kind: 'drawCards',
        from: zone(LIBRARY, at(seat)),
        to: zone(HAND, at(seat)),
        count: lit(OPENING_HAND),
      })
    ),
  ],
};

/** Note 14 — every state exit there is, with no per-state duplication. */
const emptyManaRule: RuleSet = {
  ...baseRule,
  id: RS_EMPTY_MANA,
  name: 'Mana Empties',
  trigger: 'onStateExit',
  effects: [setPool(MANA_R, everySeat, 0), setPool(MANA_G, everySeat, 0)],
};

const untapRule: RuleSet = {
  ...baseRule,
  id: RS_UNTAP,
  name: 'Untap Step',
  trigger: 'onStateEnter',
  stateFilter: S_UNTAP,
  effects: [
    setPool(PHASE, null, PH_UNTAP),
    // The once-per-turn land drop resets for the ACTIVE seat only, so the flag is also what stops the
    // non-active seat playing a land on someone else's turn even before `isMyTurn` is checked.
    setPool(LAND_PLAYED, active, false),
    { kind: 'setCardIndex', target: tagged(BATTLEFIELD, active, T_LAND), indexId: TAPPED, op: 'set', amount: lit(0) },
    { kind: 'rotateCard', target: tagged(BATTLEFIELD, active, T_LAND), to: 'upright' },
    // Note 3 — this is the ONLY writer of `Ready`, which is what makes `self.Ready = 1` mean "on the
    // battlefield". A creature that arrived after this ran is still 0, i.e. summoning-sick.
    { kind: 'setCardIndex', target: tagged(BATTLEFIELD, active, T_CREATURE), indexId: READY, op: 'set', amount: lit(1) },
    // Note 13 — one strike per creature you had when the turn began.
    {
      kind: 'changePool',
      poolId: ATTACKS,
      seat: active,
      op: 'set',
      amount: countOf(tagged(BATTLEFIELD, active, T_CREATURE)),
    },
  ],
};

const drawRule: RuleSet = {
  ...baseRule,
  id: RS_DRAW,
  name: 'Draw Step',
  trigger: 'onStateEnter',
  stateFilter: S_DRAW,
  effects: [
    setPool(PHASE, null, PH_DRAW),
    { kind: 'drawCards', from: zone(LIBRARY, active), to: zone(HAND, active), count: lit(1) },
  ],
};

/**
 * `openPriority` is LAST on purpose: it pushes a frame ON TOP of this rule's own, so anything after
 * it would run only once the whole window had closed. `holdem.ts`'s street rules order it the same
 * way for the same reason.
 */
function phaseRule(id: string, name: string, stateId: string, phase: number): RuleSet {
  return {
    ...baseRule,
    id,
    name,
    trigger: 'onStateEnter',
    stateFilter: stateId,
    effects: [setPool(PHASE, null, phase), { kind: 'openPriority', window: WIN_STACK }],
  };
}

const mainRule = phaseRule(RS_MAIN, 'Main Phase', S_MAIN, PH_MAIN);
const combatRule = phaseRule(RS_COMBAT, 'Combat Phase', S_COMBAT, PH_COMBAT);

/** Damage wears off at end of turn, board-wide — note 5's `seat: {kind:'all'}`. */
const endStepRule: RuleSet = {
  ...baseRule,
  id: RS_END_STEP,
  name: 'End Step',
  trigger: 'onStateEnter',
  stateFilter: S_END_STEP,
  effects: [
    setPool(PHASE, null, PH_END),
    { kind: 'setCardIndex', target: allCreatures, indexId: DAMAGE, op: 'set', amount: lit(0) },
  ],
};

/**
 * G7's cleanup half (note 1). Priority 1 so it runs BEFORE the End step wipes damage: both are
 * bindings of one `onStateEnter` event and the settle scan that checks lethal damage only runs once
 * they have both drained, so nothing dies in between — but ordering it explicitly is cheaper than
 * relying on that.
 *
 * The condition is the note-11 guard: without it, three NO_TARGETS refusals would be logged every
 * single turn on a board where nobody cast a trick.
 */
const growthWearsOffRule: RuleSet = {
  ...baseRule,
  id: RS_GROWTH_OFF,
  name: 'Giant Growth Wears Off',
  trigger: 'onStateEnter',
  stateFilter: S_END_STEP,
  priority: 1,
  condition: cmp(countOf(withTag(allCreatures, T_GROWN)), '>=', lit(1)),
  effects: [
    { kind: 'setCardIndex', target: withTag(allCreatures, T_GROWN), indexId: POWER, op: 'subtract', amount: lit(3) },
    { kind: 'setCardIndex', target: withTag(allCreatures, T_GROWN), indexId: TOUGHNESS, op: 'subtract', amount: lit(3) },
    { kind: 'setTag', target: withTag(allCreatures, T_GROWN), tag: T_GROWN, on: false },
  ],
};

/**
 * Two rules, not one conditional pair, and the order matters — `holdem.ts`'s button rules explain it
 * in full: `advance` runs unconditionally (priority 1) and may leave `activePlayer` at 2, which
 * `wrap` (priority 0) folds back to 0. Mutually-exclusive conditions on one snapshot would be wrong,
 * because the second rule sees the first rule's write.
 */
const turnAdvanceRule: RuleSet = {
  ...baseRule,
  id: RS_TURN_ADVANCE,
  name: 'Pass the Turn',
  trigger: 'onStateExit',
  stateFilter: S_END_STEP,
  priority: 1,
  effects: [{ kind: 'changePool', poolId: ACTIVE_PLAYER_POOL_ID, seat: null, op: 'add', amount: lit(1) }],
};

const turnWrapRule: RuleSet = {
  ...baseRule,
  id: RS_TURN_WRAP,
  name: 'Turn Wraps to Seat 0',
  trigger: 'onStateExit',
  stateFilter: S_END_STEP,
  priority: 0,
  condition: cmp(poolOf(ACTIVE_PLAYER_POOL_ID, null), '>=', lit(SEAT_COUNT)),
  effects: [setPool(ACTIVE_PLAYER_POOL_ID, null, 0)],
};

// ---------------------------------------------------------------------------
// The plays that are not casts
// ---------------------------------------------------------------------------

/**
 * MTG12's once-per-turn land drop. An ACTIVATION rather than a drag, because an activation is the
 * only play this engine can gate (note 7) — and `costCheck` is where the limit lives: the second
 * attempt in a turn rejects COST_UNPAYABLE with nothing moved.
 *
 * The land itself moves inside the COST (v4 §4.5), so cancelling the "which land" prompt leaves the
 * turn's land drop unused.
 */
const playLandRule: RuleSet = {
  ...baseRule,
  id: RS_PLAY_LAND,
  name: 'Play a Land',
  trigger: 'never_playLand',
  effects: [setPool(LAND_PLAYED, me, true)],
  activation: {
    costCheck: every(
      cmp(poolOf(LAND_PLAYED, me), '=', lit(false)),
      inPhase(PH_MAIN),
      isMyTurn,
      cmp(countOf(tagged(HAND, me, T_LAND)), '>=', lit(1))
    ),
    cost: [
      {
        kind: 'moveCards',
        target: pick(tagged(HAND, me, T_LAND), 'Play which land?'),
        to: mine(BATTLEFIELD),
        position: 'top',
      },
    ],
    window: WIN_STACK,
    perInstance: false,
    label: 'Play a Land',
  },
};

/**
 * Tapping a land for mana, note 2's first casualty: a land cannot tap ITSELF, so this is a GLOBAL
 * activation whose interactive cost prompts over your own untapped lands of that type. One rule per
 * colour rather than one rule per land.
 *
 * `rotateCard` is cosmetic and sweeps every tapped land of yours, which is idempotent — `rotated` is
 * a boolean and no criterion can read it (which is why `Tapped` exists as an index at all).
 */
function manaRule(id: string, landTag: string, landName: string, poolId: string, symbol: string): RuleSet {
  const untapped: TargetSelector = {
    kind: 'matching',
    from: tagged(BATTLEFIELD, me, landTag),
    where: cmp(idxOf('candidate', TAPPED), '=', lit(0)),
  };
  return {
    ...baseRule,
    id,
    name: `Tap a ${landName}`,
    trigger: `never_${id}`,
    effects: [
      { kind: 'changePool', poolId, seat: me, op: 'add', amount: lit(1) },
      {
        kind: 'rotateCard',
        target: { kind: 'matching', from: tagged(BATTLEFIELD, me, T_LAND), where: cmp(idxOf('candidate', TAPPED), '=', lit(1)) },
        to: 'rotated',
      },
    ],
    activation: {
      costCheck: cmp(countOf(untapped), '>=', lit(1)),
      cost: [
        {
          kind: 'setCardIndex',
          target: pick(untapped, `Tap which ${landName}?`),
          indexId: TAPPED,
          op: 'set',
          amount: lit(1),
        },
      ],
      window: WIN_STACK,
      perInstance: false,
      label: `Tap a ${landName} for ${symbol}`,
    },
  };
}

const tapMountainRule = manaRule(RS_TAP_MOUNTAIN, T_MOUNTAIN, 'Mountain', MANA_R, '{R}');
const tapForestRule = manaRule(RS_TAP_FOREST, T_FOREST, 'Forest', MANA_G, '{G}');

/**
 * Note 13 — combat, such as it is. ONE `perInstance` activation, referenced by id from every creature
 * template: keyword behaviour authored once, which is REQUIREMENTS § v4's own prescription.
 *
 * `cardIndex(self, Power)` is G4 earning its place: the damage is this creature's CURRENT power, read
 * through `effectiveIndex`, so Timber Lord's +1/+1 and any Giant Growth are both included (MTG6). The
 * three gates are notes 3 and 4 in one criterion each — in play and not summoning-sick, mine, and the
 * combat phase.
 */
const strikeRule: RuleSet = {
  ...baseRule,
  id: RS_STRIKE,
  name: 'Strike',
  trigger: 'never_strike',
  effects: burn(K_STRIKE, 'Strike — which player does this creature hit?', idxOf('self', POWER)),
  activation: {
    costCheck: every(
      cmp(idxOf('self', READY), '=', lit(1)),
      iControlSelf,
      inPhase(PH_COMBAT),
      cmp(poolOf(ATTACKS, me), '>=', lit(1))
    ),
    cost: [{ kind: 'changePool', poolId: ATTACKS, seat: me, op: 'subtract', amount: lit(1) }],
    window: WIN_STACK,
    perInstance: true,
    label: 'Strike',
  },
};

/**
 * An {X} cost: v4 §4.1 (arith) and §4.5 (an interactive cost) in one ability. `{X}{R}` means the
 * total is X plus one, which is two pieces of arithmetic the value language could not express at all
 * before v4 — the cap on X (`Red Mana − 1`) and the amount actually paid (`X + 1`).
 *
 * The `chooseNumber` answer is read back by the ability's OWN effects as `promptNumber` under the same
 * key: `activation.ts` persists a cost's answer under its authored key into the very `ctx` the
 * ability's `rule` frame inherits, which is what makes "pay {X}, deal X" one ability rather than two.
 */
const cannonRule: RuleSet = {
  ...baseRule,
  id: RS_CANNON,
  name: 'Ember Cannon',
  trigger: 'never_cannon',
  effects: burn(K_CANNON, 'Ember Cannon — which player takes X?', { kind: 'promptNumber', key: K_X }),
  activation: {
    costCheck: every(
      cmp(countOf(tagged(BATTLEFIELD, me, T_CANNON)), '>=', lit(1)),
      // >= 2, not >= 1: {X}{R} with X at least 1 needs two red, and it keeps `max` below from
      // resolving to 0 and asking a question with one legal answer.
      cmp(poolOf(MANA_R, me), '>=', lit(2))
    ),
    cost: [
      {
        kind: 'chooseNumber',
        promptText: 'Ember Cannon — pay {X}{R}: how much is X?',
        seat: me,
        min: lit(1),
        max: { kind: 'arith', op: 'subtract', left: poolOf(MANA_R, me), right: lit(1) },
        key: K_X,
      },
      {
        kind: 'changePool',
        poolId: MANA_R,
        seat: me,
        op: 'subtract',
        amount: { kind: 'arith', op: 'add', left: { kind: 'promptNumber', key: K_X }, right: lit(1) },
      },
    ],
    window: WIN_STACK,
    perInstance: false,
    label: 'Ember Cannon: {X}{R}, X damage',
  },
};

/**
 * "Sacrifice a creature:" — the cost line v4 §4.5 was raised for, and the reason it is a GLOBAL rule
 * gated by `countMatching` rather than a `perInstance` one: a `perInstance` ability would be offered
 * for every copy of the Altar anywhere in the game (note 3), and it could not sacrifice itself
 * anyway (note 2). "You control an Altar" is expressible; "this Altar is in play" is not.
 */
const altarRule: RuleSet = {
  ...baseRule,
  id: RS_ALTAR,
  name: 'Bone Altar',
  trigger: 'never_altar',
  effects: burn(K_ALTAR, 'Bone Altar — which player takes 2?', lit(2)),
  activation: {
    costCheck: every(
      cmp(countOf(tagged(BATTLEFIELD, me, T_ALTAR)), '>=', lit(1)),
      cmp(countOf(myCreatures), '>=', lit(1))
    ),
    cost: [{ kind: 'destroyCards', target: pick(myCreatures, 'Sacrifice which creature?') }],
    window: WIN_STACK,
    perInstance: false,
    label: 'Bone Altar: sacrifice a creature, 2 damage',
  },
};

/**
 * The lord, one index at a time (note 10). The scope's seat is `controller-of-self`, which is G4 used
 * for the one thing it can be used for — identifying the card carrying this rule so something can be
 * read off it. `triggeringSeat` happens to be the same seat inside a modifier's context
 * (`modifiers.ts` binds it to the source card's controller), so this is a demonstration as much as a
 * necessity; the `self` form is the one that stays correct if that ever changes.
 */
function lordRule(id: string, indexId: string, what: string): RuleSet {
  return {
    ...baseRule,
    id,
    name: `Timber Lord (+1 ${what})`,
    trigger: `never_${id}`,
    effects: [],
    modifier: {
      scope: tagged(BATTLEFIELD, { kind: 'controller', card: { kind: 'self' } }, T_CREATURE),
      indexId,
      op: 'adjust',
      amount: lit(1),
      activeZones: [BATTLEFIELD],
    },
  };
}

const lordPowerRule = lordRule(RS_LORD_POWER, POWER, 'power');
const lordToughnessRule = lordRule(RS_LORD_TOUGHNESS, TOUGHNESS, 'toughness');

/**
 * G6, and the one rule in this file that could not be authored at all before v4: "each creature with
 * lethal damage is destroyed", ONCE, game-level, over both battlefields.
 *
 * `mtgish.ts`'s version has to be card-attached and one-sided (its own comment says so) because a
 * boolean-form game-level rule gets ONE `continuousFired` key for the whole session. The object form
 * gives one arm — one false→true edge — per creature, so the second creature to take lethal damage
 * fires it again (SP17). `condition` reads `candidate`, which the arm binds to its own card.
 *
 * ponytail: `over` re-resolves on every settle scan, so this multiplies the scan by the creature
 * count — v4 §4.4's named, unmeasured ceiling. At a two-seat playtest board it is free.
 */
const lethalCondition: CriteriaNode = every(
  cmp(idxOf('candidate', DAMAGE), '>=', lit(1)),
  cmp(idxOf('candidate', DAMAGE), '>=', idxOf('candidate', TOUGHNESS))
);

const lethalDamageRule: RuleSet = {
  ...baseRule,
  id: RS_LETHAL,
  name: 'Lethal Damage',
  trigger: 'never_lethal',
  condition: lethalCondition,
  continuous: { over: allCreatures },
  // The EFFECT still sweeps by predicate rather than acting on the arm's own card: no
  // `TargetSelector` names a `CardRef` (note 2), so an arm can TEST its card but not TARGET it.
  effects: [{ kind: 'destroyCards', target: { kind: 'matching', from: allCreatures, where: lethalCondition } }],
};

// ---------------------------------------------------------------------------
// Templates and the deck
// ---------------------------------------------------------------------------

const combatIndexes = (power: number, toughness: number): CardIndex[] => [
  { id: POWER, value: { type: 'integer', name: 'Power', defaultValue: power, min: 0, max: 99 }, icon: 'gi-broadsword', position: 'bottomLeft' },
  { id: TOUGHNESS, value: { type: 'integer', name: 'Toughness', defaultValue: toughness, min: 0, max: 99 }, icon: 'gi-shield', position: 'bottomRight' },
  { id: DAMAGE, value: { type: 'integer', name: 'Damage', defaultValue: 0, min: 0, max: 99 }, icon: 'gi-bleeding-wound', position: 'topRight' },
  // Note 3 — 0 is "cannot act", and only the untap step ever writes 1.
  { id: READY, value: { type: 'integer', name: 'Ready', defaultValue: 0, min: 0, max: 1 }, icon: 'gi-run', position: 'topLeft' },
];

const landIndexes: CardIndex[] = [
  { id: TAPPED, value: { type: 'integer', name: 'Tapped', defaultValue: 0, min: 0, max: 1 }, icon: 'gi-hourglass', position: 'topRight' },
];

function templateOf(card: Card): CardTemplate {
  const isLand = card.types.includes(T_LAND);
  return {
    id: `tpl_${card.key}`,
    name: card.name,
    marquee: card.name,
    faceIcon: card.icon,
    borderColor: card.border,
    // `card.key` is a tag as well as an id: it is the handle a `Cast X` cost's prompt selects on.
    tags: [...card.types, card.key],
    indexes: isLand
      ? landIndexes
      : card.power !== undefined
        ? combatIndexes(card.power, card.toughness ?? 1)
        : [],
    // Lands are played, not cast, so they carry no cast/resolve pair. The cast and resolve rules are
    // listed for DISPLAY as much as anything — `activatableRules` scans `def.ruleSets` for a
    // non-`perInstance` activation regardless — so that the card face renders its own rules text.
    ruleSetIds: [
      ...(isLand ? [] : [castId(card.key), resolveId(card.key)]),
      ...(card.carries ?? []),
    ],
    rulesTextOverride: card.rulesText,
  };
}

const templates: CardTemplate[] = CARDS.map(templateOf);

/** Two colours in one 28-card list: a mirror match, shuffled per seat off the same entries. */
const DECK_COUNTS: Record<string, number> = {
  mountain: 6,
  forest: 6,
  bolt: 2,
  raider: 2,
  warcry: 2,
  cannon: 1,
  storm: 2,
  bear: 2,
  lord: 1,
  growth: 2,
  altar: 1,
  tally: 1,
};

const decks: Deck[] = [
  {
    id: MTG_DECK,
    name: 'Sparkbloom',
    // Player-scoped zone => one instance per seat, each shuffled separately (§4.5).
    zoneId: LIBRARY,
    entries: CARDS.map((card) => ({ templateId: `tpl_${card.key}`, quantity: DECK_COUNTS[card.key] })),
  },
];

// ---------------------------------------------------------------------------
// Rule sets
// ---------------------------------------------------------------------------

const spellRules: RuleSet[] = CARDS.filter((c) => !c.types.includes(T_LAND)).flatMap((card) => [
  castRule(card),
  resolveRule(card),
]);

const ruleSets: RuleSet[] = [
  setupRule,
  emptyManaRule,
  untapRule,
  drawRule,
  mainRule,
  combatRule,
  endStepRule,
  growthWearsOffRule,
  turnAdvanceRule,
  turnWrapRule,
  playLandRule,
  tapMountainRule,
  tapForestRule,
  strikeRule,
  cannonRule,
  altarRule,
  lordPowerRule,
  lordToughnessRule,
  lethalDamageRule,
  ...spellRules,
];

/**
 * The rules no card carries: turn structure, the two land plays, and the game-level continuous rule.
 * `globalRuleSetIds` is load-bearing for all three kinds — `dispatch.ts` binds event rules from here,
 * and `continuous.ts` collects game-level arms from here — unlike the cast/ability rules, which are
 * reached through `activatableRules`' scan of `def.ruleSets` and are listed on their card instead.
 */
const globalRuleSetIds: string[] = [
  RS_SETUP,
  RS_EMPTY_MANA,
  RS_UNTAP,
  RS_DRAW,
  RS_MAIN,
  RS_COMBAT,
  RS_END_STEP,
  RS_GROWTH_OFF,
  RS_TURN_ADVANCE,
  RS_TURN_WRAP,
  RS_PLAY_LAND,
  RS_TAP_MOUNTAIN,
  RS_TAP_FOREST,
  RS_LETHAL,
];

// ---------------------------------------------------------------------------
// The turn, as a state machine. Untap → Draw → Main → Combat → End Step → Untap, and End Step is the
// only exit to the terminal state. Every transition is a manual button: "the phase is over" is not a
// criterion anything can read (a priority window closing fires no event), so the tester drives it —
// the same finding `holdem.ts` records for its streets.
// ---------------------------------------------------------------------------

const states: MachineState[] = [
  { id: START_STATE_ID, name: 'Start', enterableFrom: [], exitableTo: [S_UNTAP], entryCriteria: null, transitionLabel: null, priority: 0, position: { x: 0, y: 0 } },
  { id: S_UNTAP, name: 'Untap', enterableFrom: [START_STATE_ID, S_END_STEP], exitableTo: [S_DRAW], entryCriteria: null, transitionLabel: 'Untap', priority: 0, position: { x: 160, y: 0 } },
  { id: S_DRAW, name: 'Draw', enterableFrom: [S_UNTAP], exitableTo: [S_MAIN], entryCriteria: null, transitionLabel: 'Draw a card', priority: 0, position: { x: 320, y: 0 } },
  { id: S_MAIN, name: 'Main', enterableFrom: [S_DRAW], exitableTo: [S_COMBAT], entryCriteria: null, transitionLabel: 'Main phase', priority: 0, position: { x: 480, y: 0 } },
  { id: S_COMBAT, name: 'Combat', enterableFrom: [S_MAIN], exitableTo: [S_END_STEP], entryCriteria: null, transitionLabel: 'Combat', priority: 0, position: { x: 640, y: 0 } },
  { id: S_END_STEP, name: 'End Step', enterableFrom: [S_COMBAT], exitableTo: [S_UNTAP, END_STATE_ID], entryCriteria: null, transitionLabel: 'End the turn', priority: 0, position: { x: 800, y: 0 } },
  { id: END_STATE_ID, name: 'Game Over', enterableFrom: [S_END_STEP], exitableTo: [], entryCriteria: null, transitionLabel: 'Concede the game', priority: 0, position: { x: 960, y: 0 } },
];

/** Fixed, never `Date.now()` — the emitted JSON must not churn on every run (§3.6). */
export const MTG_UPDATED_AT = '2026-07-30T00:00:00.000Z';

export const mtg: GameDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: 'game_sparkbloomDuel',
  name: 'Sparkbloom Duel',
  playerCount: SEAT_COUNT,
  pools,
  zones,
  templates,
  decks,
  customEvents: [],
  ruleSets,
  globalRuleSetIds,
  priorityWindows: [stackWindow],
  machine: { states, startStateId: START_STATE_ID, endStateId: END_STATE_ID },
  limits: {
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEffects: DEFAULT_MAX_EFFECTS,
    maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
    maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
  },
  updatedAt: MTG_UPDATED_AT,
};

/** Ids the test drives by name. Exported here so the test never rebuilds the `rs_cast_*` convention. */
export const CAST = Object.fromEntries(CARDS.map((c) => [c.key, castId(c.key)])) as Record<string, string>;
export const TPL = Object.fromEntries(CARDS.map((c) => [c.key, `tpl_${c.key}`])) as Record<string, string>;
export { cardByKey };
