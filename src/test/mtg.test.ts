/**
 * The Magic sample (`src/samples/mtg.ts`) — validated, PLAYED through a real turn headlessly, and
 * emitted to `samples/magic.json`.
 *
 * The emit lives here rather than in a `scripts/*.mjs` generator for the reason `holdem.test.ts`
 * gives: the definition is authored in TypeScript and this repo has no TS runner outside vitest.
 * `npm test` is therefore also how the sample is regenerated — change `mtg.ts`, run the tests, commit
 * the JSON that falls out.
 *
 * MTG12 is an acceptance criterion about PLAYING, so nearly everything below drives the real
 * dispatcher: a definition that validates but cannot be played would prove nothing. Each of v4's
 * eight gaps has a test here that fails if that gap's primitive stops working, which is the whole
 * reason §6 asked for this sample rather than a demo.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ICON_CATALOG } from '../assets/icons/catalog';
import { continuousKey } from '../engine/continuous';
import { step } from '../engine/dispatch';
import { invalidateEffective } from '../engine/modifiers';
import { exportJson, importJson, validateDefinition } from '../engine/schema';
import { createPlayState } from '../engine/setup';
import type { EngineInput, Id, LogLine, PlayAction, PlayState } from '../engine/types';
import { ACTIVE_PLAYER_POOL_ID } from '../engine/types';
import { zoneKey } from '../engine/valueRef';
import {
  ATTACKS,
  BATTLEFIELD,
  CAST,
  DAMAGE,
  GRAVEYARD,
  HAND,
  LAND_PLAYED,
  LIBRARY,
  LIFE,
  MANA_G,
  MANA_R,
  MTG_DECK,
  OPENING_HAND,
  POWER,
  READY,
  RS_ALTAR,
  RS_CANNON,
  RS_LETHAL,
  RS_PLAY_LAND,
  RS_STRIKE,
  RS_TAP_FOREST,
  SEATS,
  STACK,
  STARTING_LIFE,
  S_COMBAT,
  S_DRAW,
  S_END_STEP,
  S_MAIN,
  S_UNTAP,
  TAPPED,
  TOUGHNESS,
  TPL,
  T_CREATURE,
  mtg,
} from '../samples/mtg';

const SAMPLE_PATH = join(process.cwd(), 'samples', 'magic.json');

// ---------------------------------------------------------------------------
// Driving the engine — the same one-action-then-CONTINUE loop `holdem.test.ts` uses
// ---------------------------------------------------------------------------

function drive(state: PlayState, action: PlayAction): LogLine[] {
  const lines: LogLine[] = [];
  let input: EngineInput = { kind: 'action', action, override: false };
  let result = step(state, input, lines, mtg);
  let steps = 1;
  while (!result.done) {
    if (++steps > 5000) throw new Error('driver runaway');
    input = { kind: 'continue' };
    result = step(state, input, lines, mtg);
  }
  return lines;
}

const cardsIn = (state: PlayState, zone: string, seat: number | null = null): Id[] =>
  state.zones[zoneKey(zone, seat)].cardIds;

const life = (state: PlayState, seat: number): number => state.playerPools[LIFE][seat] as number;

/**
 * Change phase. Both seats have to PASS first: Main and Combat open a priority window on entry
 * (header note 6) and an open interaction rejects every other action, so "everyone passes, then the
 * phase ends" is enforced by the engine rather than by etiquette.
 */
function goTo(state: PlayState, toStateId: string): void {
  let laps = 0;
  while (state.interaction?.kind === 'priority') {
    if (++laps > 4 * SEATS.length) throw new Error('the priority window never closed');
    drive(state, { kind: 'passPriority' });
  }
  drive(state, { kind: 'transition', toStateId });
}

/** Start, then walk to the Main phase of seat 0's first turn. */
function inMain(): PlayState {
  const state = createPlayState(mtg, 'sparkbloom-test');
  drive(state, { kind: 'start' });
  goTo(state, S_UNTAP);
  goTo(state, S_DRAW);
  goTo(state, S_MAIN);
  return state;
}

/** The Draw step: the last point in a turn where no priority window is open. */
function inDraw(): PlayState {
  const state = createPlayState(mtg, 'sparkbloom-test');
  drive(state, { kind: 'start' });
  goTo(state, S_UNTAP);
  goTo(state, S_DRAW);
  return state;
}

/** An event nothing is bound to: one transaction, therefore one settle scan, and no side effects. */
const tick = (state: PlayState): LogLine[] => drive(state, { kind: 'fireEvent', name: 'tick', seat: 0 });

/** Untap → Draw → Main → Combat → End Step → Untap, i.e. hand the turn to the other seat. */
function passTheTurn(state: PlayState): void {
  goTo(state, S_COMBAT);
  goTo(state, S_END_STEP);
  goTo(state, S_UNTAP);
}

/**
 * Both players' turns, ending in seat 0's Combat phase: a board placed by hand during seat 0's Main
 * has been through an untap step by then, so its creatures are ready and its `Attacks` pool is full.
 */
function toSeat0Combat(state: PlayState): void {
  passTheTurn(state); // seat 1's Untap
  goTo(state, S_DRAW);
  goTo(state, S_MAIN);
  passTheTurn(state); // seat 0's Untap
  goTo(state, S_DRAW);
  goTo(state, S_MAIN);
  goTo(state, S_COMBAT);
}

/**
 * Put a specific card into a seat's hand, taken out of their own library.
 *
 * An opening hand is five cards off a shuffled 28-card deck, so a test that needs a Forest AND a Bear
 * cannot wait for one — this is the `place()` of `board.ts`, restricted to cards that genuinely
 * belong to that seat's deck.
 */
function putInHand(state: PlayState, seat: number, templateId: string): Id {
  const hand = cardsIn(state, HAND, seat);
  // The library first, but the opening hand may already hold the only copy of a one-of.
  for (const from of [cardsIn(state, LIBRARY, seat), hand]) {
    const id = from.find((cardId) => state.cards[cardId].templateId === templateId);
    if (id === undefined) continue;
    if (from === hand) return id;
    from.splice(from.indexOf(id), 1);
    hand.unshift(id);
    invalidateEffective(state);
    return id;
  }
  throw new Error(`seat ${seat} owns no ${templateId}`);
}

/** Put a card straight onto a seat's battlefield, the way a resolved permanent would arrive. */
function putInPlay(state: PlayState, seat: number, templateId: string): Id {
  const id = putInHand(state, seat, templateId);
  const hand = cardsIn(state, HAND, seat);
  hand.splice(hand.indexOf(id), 1);
  cardsIn(state, BATTLEFIELD, seat).unshift(id);
  invalidateEffective(state);
  return id;
}

function grantMana(state: PlayState, seat: number, red: number, green: number): void {
  state.playerPools[MANA_R][seat] = red;
  state.playerPools[MANA_G][seat] = green;
}

const chooseCards = (state: PlayState) => {
  const interaction = state.interaction;
  if (interaction?.kind !== 'chooseCards') throw new Error(`expected chooseCards, got ${interaction?.kind}`);
  return interaction;
};

/** Answer an open card prompt with `cardId`, or with its only candidate. */
function answerCard(state: PlayState, cardId?: Id): LogLine[] {
  const candidates = chooseCards(state).candidates;
  return drive(state, { kind: 'answerPrompt', chosen: [cardId ?? candidates[0]] });
}

/** Pass until whatever is on the stack has resolved (or until a resolution asks a question). */
function letItResolve(state: PlayState): void {
  let laps = 0;
  while (state.actionStack.length > 0 && state.interaction?.kind === 'priority') {
    if (++laps > 4 * SEATS.length) throw new Error('the stack never resolved');
    drive(state, { kind: 'passPriority' });
  }
}

/** Activate, answer the one-candidate "which copy?" prompt, and let the spell resolve. */
function cast(state: PlayState, key: string, seat = 0): void {
  drive(state, { kind: 'activate', ruleId: CAST[key], cardId: null, seat });
  answerCard(state);
  letItResolve(state);
}

// ---------------------------------------------------------------------------

describe('the Magic sample is a valid definition', () => {
  it('passes shape and referential validation', () => {
    expect(validateDefinition(mtg)).toEqual([]);
  });

  it('round-trips byte-identically through import/export', () => {
    const once = exportJson(mtg);
    const back = importJson(once);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(exportJson(back.definition)).toBe(once);
  });

  it('names only icons the sprite actually ships', () => {
    const known = new Set(ICON_CATALOG.map((icon) => icon.id));
    const missing = mtg.templates
      .flatMap((t) => [t.faceIcon, ...t.indexes.map((i) => i.icon)])
      .filter((icon) => !known.has(icon));
    expect([...new Set(missing)]).toEqual([]);
  });

  it('authors Strike ONCE and references it by id from every creature', () => {
    // REQUIREMENTS § v4: "keyword *behaviour* is one shared RuleSet, referenced by id from many
    // templates". If someone ever copies the rule per card, this is the test that objects.
    const creatures = mtg.templates.filter((t) => t.tags.includes(T_CREATURE));
    expect(creatures.length).toBeGreaterThan(1);
    expect(creatures.every((t) => t.ruleSetIds.includes(RS_STRIKE))).toBe(true);
    expect(mtg.ruleSets.filter((r) => r.activation?.perInstance).map((r) => r.id)).toEqual([RS_STRIKE]);
  });

  it('deals a 28-card library and a five-card opening hand to each seat', () => {
    const deck = mtg.decks[0];
    expect(deck.id).toBe(MTG_DECK);
    expect(deck.entries.reduce((n, e) => n + e.quantity, 0)).toBe(28);

    const state = createPlayState(mtg, 'sparkbloom-test');
    drive(state, { kind: 'start' });
    for (const seat of SEATS) {
      expect(cardsIn(state, HAND, seat)).toHaveLength(OPENING_HAND);
      expect(cardsIn(state, LIBRARY, seat)).toHaveLength(28 - OPENING_HAND);
      // Each seat knows its own number — the pool nothing else in the engine can express (note 4).
      expect(state.playerPools['pool_seatNumber'][seat]).toBe(seat);
      expect(life(state, seat)).toBe(STARTING_LIFE);
    }
  });
});

// ---------------------------------------------------------------------------
// AC: MTG12 — the criterion itself, in one sequence: a land under the once-per-turn limit, a creature
// cast through the stack, a burn spell at a chosen player, and a "for each" spell reading the board.
// ---------------------------------------------------------------------------

describe('AC: MTG12 — playing a turn of the shipped Magic sample', () => {
  it('opens priority on the active seat when the Main phase begins', () => {
    const state = inMain();
    const interaction = state.interaction;
    expect(interaction?.kind).toBe('priority');
    if (interaction?.kind !== 'priority') return;
    expect(interaction.seat).toBe(0);
    expect(state.pools['pool_phase']).toBe(2);
  });

  // AC: MTG12
  it('plays a land, and refuses the second one in the same turn', () => {
    const state = inMain();
    const forest = putInHand(state, 0, TPL.forest);
    putInHand(state, 0, TPL.mountain);

    drive(state, { kind: 'activate', ruleId: RS_PLAY_LAND, cardId: null, seat: 0 });
    // The land moves inside the COST, so the prompt is raised before anything has been spent (SP18).
    // Candidates are every land in hand, including whatever the opening hand happened to deal.
    expect(chooseCards(state).candidates).toContain(forest);
    expect(cardsIn(state, BATTLEFIELD, 0)).toEqual([]);
    answerCard(state, forest);

    expect(cardsIn(state, BATTLEFIELD, 0)).toEqual([forest]);
    expect(state.playerPools[LAND_PLAYED][0]).toBe(true);

    // The once-per-turn limit: `costCheck` refuses, and the Mountain is still in hand.
    const lines = drive(state, { kind: 'activate', ruleId: RS_PLAY_LAND, cardId: null, seat: 0 });
    expect(lines.some((l) => l.message.startsWith('COST_UNPAYABLE'))).toBe(true);
    expect(cardsIn(state, BATTLEFIELD, 0)).toEqual([forest]);
    expect(cardsIn(state, HAND, 0).length).toBeGreaterThan(0);

    // …and it comes back next turn, for the seat whose turn it now is.
    passTheTurn(state);
    expect(state.pools[ACTIVE_PLAYER_POOL_ID]).toBe(1);
    expect(state.playerPools[LAND_PLAYED][1]).toBe(false);
    // Seat 0's flag is untouched: the untap step only clears the ACTIVE seat's.
    expect(state.playerPools[LAND_PLAYED][0]).toBe(true);
  });

  // AC: MTG12
  it('taps the land for mana and casts a creature through the stack', () => {
    const state = inMain();
    const forest = putInHand(state, 0, TPL.forest);
    const bear = putInHand(state, 0, TPL.bear);

    drive(state, { kind: 'activate', ruleId: RS_PLAY_LAND, cardId: null, seat: 0 });
    answerCard(state, forest);

    // Tapping is an interactive cost over your own untapped Forests (header note 2).
    drive(state, { kind: 'activate', ruleId: RS_TAP_FOREST, cardId: null, seat: 0 });
    answerCard(state, forest);
    expect(state.playerPools[MANA_G][0]).toBe(1);
    expect(state.cards[forest].indexValues[TAPPED]).toBe(1);
    expect(state.cards[forest].rotated).toBe(true);

    // No second Forest to tap: the ability is not even offered.
    const offered = state.interaction;
    if (offered?.kind !== 'priority') throw new Error('expected the Main-phase window to be open');
    expect(offered.legal.map((l) => l.ruleId)).not.toContain(RS_TAP_FOREST);

    drive(state, { kind: 'activate', ruleId: CAST.bear, cardId: null, seat: 0 });
    const lines = answerCard(state, bear);

    // It went through the stack: the card was put there by the cost, announced as a PendingAction, and
    // a fresh priority window opened over it — MTG1's shape, reached by an activation rather than a
    // drag. It then resolved inside the SAME transaction, because with no mana left neither seat has a
    // legal response and `collapseEmptyOffers` closes the window without asking (§5.5). The
    // "respond at instant speed" test below is the case where somebody CAN answer.
    expect(lines.some((l) => l.message.includes(`Move ${bear}`) || l.message.includes('Move 1 card → Stack'))).toBe(true);
    expect(lines.some((l) => l.message.includes('Announce "Grizzly Bear (resolve)"'))).toBe(true);
    expect(lines.some((l) => l.message.includes('Priority window "Priority" opened'))).toBe(true);
    expect(state.playerPools[MANA_G][0]).toBe(0);
    expect(cardsIn(state, STACK, 0)).toEqual([]);
    expect(cardsIn(state, BATTLEFIELD, 0)).toEqual([bear, forest]);
    // Summoning-sick: `Ready` is only ever written by the untap step (header note 3).
    expect(state.cards[bear].indexValues[READY]).toBe(0);
  });

  // AC: MTG12
  it('casts a burn spell at a chosen player — G3, end to end', () => {
    const state = inMain();
    const bolt = putInHand(state, 0, TPL.bolt);
    grantMana(state, 0, 1, 0);

    drive(state, { kind: 'activate', ruleId: CAST.bolt, cardId: null, seat: 0 });
    answerCard(state, bolt);
    letItResolve(state);

    // Resolution suspends on the seat choice: the candidates are the LIVE ring, and NOTHING has
    // happened to either player's life yet.
    expect(state.interaction).toMatchObject({ kind: 'chooseSeat', candidates: [0, 1] });
    expect(state.playerPools[LIFE]).toEqual([STARTING_LIFE, STARTING_LIFE]);

    // Seat 1, deliberately not the seat that was asked, so "aimed at the chosen seat" cannot pass by
    // reading `active` or the caster instead of the answer.
    drive(state, { kind: 'answerSeat', seat: 1 });

    expect(state.playerPools[LIFE]).toEqual([STARTING_LIFE, STARTING_LIFE - 3]);
    // The spell put itself in its owner's graveyard on the way out.
    expect(cardsIn(state, GRAVEYARD, 0)).toEqual([bolt]);
    expect(cardsIn(state, STACK, 0)).toEqual([]);
  });

  // AC: MTG12
  it('casts a "for each" spell that reads a count off the board — G2', () => {
    const state = inMain();
    const warcry = putInHand(state, 0, TPL.warcry);
    putInPlay(state, 0, TPL.bear);
    putInPlay(state, 0, TPL.raider);
    // The opponent's creatures must NOT be counted: that is the whole reason the Battlefield is
    // player-scoped (header note 5).
    putInPlay(state, 1, TPL.bear);
    grantMana(state, 0, 2, 0);

    cast(state, 'warcry');
    drive(state, { kind: 'answerSeat', seat: 1 });

    expect(state.playerPools[LIFE]).toEqual([STARTING_LIFE, STARTING_LIFE - 2]);
    expect(cardsIn(state, GRAVEYARD, 0)).toEqual([warcry]);
  });
});

// ---------------------------------------------------------------------------
// The rest of v4, one primitive per test. Every one of these is a card in the pool, and every one of
// them was unauthorable before the row that landed it.
// ---------------------------------------------------------------------------

describe('the v4 primitives the pool exists to prove', () => {
  it('pays an {X} cost and deals X — arith inside an interactive cost (G1 + G5)', () => {
    const state = inMain();
    putInPlay(state, 0, TPL.cannon);
    grantMana(state, 0, 4, 0);

    drive(state, { kind: 'activate', ruleId: RS_CANNON, cardId: null, seat: 0 });

    // `max` is `Red Mana − 1`: {X}{R} leaves one red for the printed part of the cost.
    expect(state.interaction).toMatchObject({ kind: 'chooseNumber', min: 1, max: 3 });
    // Nothing spent yet — the two-pass cost raises before it applies (SP18).
    expect(state.playerPools[MANA_R][0]).toBe(4);

    drive(state, { kind: 'answerNumber', value: 3 });
    // X + 1 = 4 red paid, and the ability's own effect read X back off the cost's answer.
    expect(state.playerPools[MANA_R][0]).toBe(0);
    drive(state, { kind: 'answerSeat', seat: 1 });
    expect(life(state, 1)).toBe(STARTING_LIFE - 3);
  });

  it('refuses the {X} ability with one red, before asking anything', () => {
    const state = inMain();
    putInPlay(state, 0, TPL.cannon);
    grantMana(state, 0, 1, 0);

    const lines = drive(state, { kind: 'activate', ruleId: RS_CANNON, cardId: null, seat: 0 });

    expect(lines.some((l) => l.message.startsWith('COST_UNPAYABLE'))).toBe(true);
    expect(state.interaction?.kind).toBe('priority');
    expect(state.playerPools[MANA_R][0]).toBe(1);
  });

  it('sacrifices a chosen creature as a cost — G5', () => {
    const state = inMain();
    putInPlay(state, 0, TPL.altar);
    const bear = putInPlay(state, 0, TPL.bear);
    const raider = putInPlay(state, 0, TPL.raider);

    drive(state, { kind: 'activate', ruleId: RS_ALTAR, cardId: null, seat: 0 });
    // A genuine choice of two, and neither is gone yet.
    expect(chooseCards(state).candidates.sort()).toEqual([bear, raider].sort());
    expect(state.cards[bear]).toBeDefined();

    answerCard(state, raider);

    expect(state.cards[raider]).toBeUndefined();
    expect(state.cards[bear]).toBeDefined();
    drive(state, { kind: 'answerSeat', seat: 1 });
    expect(life(state, 1)).toBe(STARTING_LIFE - 2);
  });

  it('refuses the Altar with no creature to feed it, spending nothing', () => {
    const state = inMain();
    putInPlay(state, 0, TPL.altar);

    const lines = drive(state, { kind: 'activate', ruleId: RS_ALTAR, cardId: null, seat: 0 });

    expect(lines.some((l) => l.message.startsWith('COST_UNPAYABLE'))).toBe(true);
    expect(lines.some((l) => l.change !== null)).toBe(false);
  });

  it('strikes for the creature\'s OWN power, once per attack — G4', () => {
    const state = inMain();
    const bear = putInPlay(state, 0, TPL.bear);
    // It arrived mid-turn, so it is summoning-sick: only the untap step ever writes `Ready`.
    expect(state.cards[bear].indexValues[READY]).toBe(0);

    toSeat0Combat(state);
    expect(state.cards[bear].indexValues[READY]).toBe(1);
    expect(state.playerPools[ATTACKS][0]).toBe(1);

    drive(state, { kind: 'activate', ruleId: RS_STRIKE, cardId: bear, seat: 0 });
    drive(state, { kind: 'answerSeat', seat: 1 });
    expect(life(state, 1)).toBe(STARTING_LIFE - 2);

    // One attack per creature you had when the turn began (header note 13). The pool is spent and
    // nobody else can act, so the window has already closed itself — a second strike is refused.
    expect(state.playerPools[ATTACKS][0]).toBe(0);
    const lines = drive(state, { kind: 'activate', ruleId: RS_STRIKE, cardId: bear, seat: 0 });
    expect(lines.some((l) => l.level === 'reject')).toBe(true);
    expect(life(state, 1)).toBe(STARTING_LIFE - 2);
  });

  it('reads the Lord\'s buff into the same strike — G4 + existing modifiers', () => {
    const state = inMain();
    const bear = putInPlay(state, 0, TPL.bear);
    putInPlay(state, 0, TPL.lord);
    toSeat0Combat(state);
    // Two creatures, so two attacks — and the Lord is one of them, which is why the pool is 2.
    expect(state.playerPools[ATTACKS][0]).toBe(2);

    drive(state, { kind: 'activate', ruleId: RS_STRIKE, cardId: bear, seat: 0 });
    drive(state, { kind: 'answerSeat', seat: 1 });

    // 3, not 2: `cardIndex(self, Power)` is read through `effectiveIndex`, so the Lord's +1/+1 is in
    // the damage. MTG6's point, applied to an ability's own amount rather than to a card face.
    expect(life(state, 1)).toBe(STARTING_LIFE - 3);
    expect(state.cards[bear].indexValues[POWER]).toBe(2); // the STORED value is untouched (§5.4)
  });

  it('will not let a seat strike with the opponent\'s creature', () => {
    const state = inMain();
    // One ready creature each, and seat 0 holding the only attack — so the window stays open and the
    // OFFER itself is an assertion: `activatableRules` deliberately does not filter a `perInstance`
    // rule by controller, so the gate has to be authored (header note 4).
    const myBear = putInPlay(state, 0, TPL.bear);
    const theirBear = putInPlay(state, 1, TPL.bear);
    state.cards[myBear].indexValues[READY] = 1;
    state.cards[theirBear].indexValues[READY] = 1;
    state.playerPools[ATTACKS][0] = 1;
    invalidateEffective(state);
    goTo(state, S_COMBAT);

    const offer = state.interaction;
    if (offer?.kind !== 'priority') throw new Error('expected the Combat window to be open');
    expect(offer.seat).toBe(0);
    expect(offer.legal.filter((l) => l.ruleId === RS_STRIKE).map((l) => l.cardId)).toEqual([myBear]);

    const lines = drive(state, { kind: 'activate', ruleId: RS_STRIKE, cardId: theirBear, seat: 0 });

    // `Seat(controller-of-self) = Seat(me)` — the only authorable "I control this" (header note 4).
    expect(lines.some((l) => l.message.startsWith('COST_UNPAYABLE'))).toBe(true);
    expect(life(state, 0)).toBe(STARTING_LIFE);
    expect(life(state, 1)).toBe(STARTING_LIFE);
  });

  it('destroys each creature with lethal damage, one arm per creature — G6', () => {
    // In the DRAW step, so nothing is holding priority and a bare event can settle the board. The End
    // Step is deliberately not used: it wipes damage BEFORE the settle scan sees it, which is the
    // right behaviour (Magic's cleanup step) and useless for this test.
    const state = inDraw();
    const bear = putInPlay(state, 0, TPL.bear);
    const raider = putInPlay(state, 1, TPL.raider);

    // Nothing lethal yet: both arms exist and both stay quiet.
    tick(state);
    expect(state.cards[bear]).toBeDefined();
    expect(Object.keys(state.continuousFired)).toEqual([]);

    // The Bear (2/2) takes 2. Its own arm fires; the Raider's does not.
    state.cards[bear].indexValues[DAMAGE] = 2;
    invalidateEffective(state);
    tick(state);
    expect(state.cards[bear]).toBeUndefined();
    expect(state.cards[raider]).toBeDefined();
    expect(state.continuousFired[continuousKey(RS_LETHAL, null, bear)]).toBe(true);

    // The Raider (2/1) takes 1 LATER — a second firing of one game-level rule, which is exactly what
    // the boolean form cannot do (`mtgish.ts`'s lethalDamageRule has to be card-attached instead).
    state.cards[raider].indexValues[DAMAGE] = 1;
    invalidateEffective(state);
    tick(state);
    expect(state.cards[raider]).toBeUndefined();
    expect(state.continuousFired[continuousKey(RS_LETHAL, null, raider)]).toBe(true);
  });

  it('kills a creature when its buff leaves rather than when it takes damage — G6 + modifiers', () => {
    const state = inDraw();
    const lord = putInPlay(state, 0, TPL.lord);
    const bear = putInPlay(state, 0, TPL.bear);
    // 2 damage on a 2/2 that the Lord is making a 3/3: survivable while the Lord is there.
    state.cards[bear].indexValues[DAMAGE] = 2;
    invalidateEffective(state);
    tick(state);
    expect(state.cards[bear]).toBeDefined();
    expect(state.cards[lord]).toBeDefined();

    // Bin the Lord by hand; the Bear's toughness drops back to 2 and its own arm fires on the edge.
    // Nothing about the BEAR changed — this is the derived-modifier read the arm's condition does.
    delete state.cards[lord];
    const field = state.zones[zoneKey(BATTLEFIELD, 0)].cardIds;
    field.splice(field.indexOf(lord), 1);
    invalidateEffective(state);
    tick(state);
    expect(state.cards[bear]).toBeUndefined();
  });

  it('suspends inside a modal branch that targets a PLAYER — G8', () => {
    const state = inMain();
    const storm = putInHand(state, 0, TPL.storm);
    grantMana(state, 0, 1, 0);

    drive(state, { kind: 'activate', ruleId: CAST.storm, cardId: null, seat: 0 });
    answerCard(state, storm);
    letItResolve(state);

    expect(state.interaction).toMatchObject({ kind: 'chooseOption' });
    drive(state, { kind: 'answerOption', optionId: '0' });

    // Before v4 this failed AWAITING_PROMPT: a branch effect had no frame slot to suspend into.
    expect(state.interaction).toMatchObject({ kind: 'chooseSeat', candidates: [0, 1] });
    drive(state, { kind: 'answerSeat', seat: 1 });

    expect(life(state, 1)).toBe(STARTING_LIFE - 2);
    // …and the rule resumed into the effect AFTER the branch, which is the half that proves a queue
    // rather than an abandonment: the card reached the graveyard.
    expect(cardsIn(state, GRAVEYARD, 0)).toEqual([storm]);
  });

  it('suspends inside a modal branch that targets a CARD — G8, the other mode', () => {
    const state = inMain();
    const storm = putInHand(state, 0, TPL.storm);
    const victim = putInPlay(state, 1, TPL.bear);
    grantMana(state, 0, 1, 0);

    drive(state, { kind: 'activate', ruleId: CAST.storm, cardId: null, seat: 0 });
    answerCard(state, storm);
    letItResolve(state);
    drive(state, { kind: 'answerOption', optionId: '1' });

    expect(chooseCards(state).candidates).toEqual([victim]);
    answerCard(state, victim);

    expect(state.cards[victim]).toBeUndefined();
    expect(life(state, 1)).toBe(STARTING_LIFE); // the mode NOT chosen never ran
    expect(cardsIn(state, GRAVEYARD, 0)).toEqual([storm]);
  });

  it('pumps until end of turn and takes it back in the End step — G7\'s workaround', () => {
    const state = inMain();
    const growth = putInHand(state, 0, TPL.growth);
    const bear = putInPlay(state, 0, TPL.bear);
    grantMana(state, 0, 0, 1);

    // The target is chosen at CAST time, because `announceAction` freezes a prompting target then
    // (§4.8) — which is the correct Magic behaviour and not a workaround.
    drive(state, { kind: 'activate', ruleId: CAST.growth, cardId: null, seat: 0 });
    answerCard(state, growth);
    expect(chooseCards(state).promptText).toContain('Giant Growth');
    answerCard(state, bear);
    letItResolve(state);

    expect(state.cards[bear].indexValues[POWER]).toBe(5);
    expect(state.cards[bear].indexValues[TOUGHNESS]).toBe(5);
    expect(state.cards[bear].tags).toContain('grown');
    expect(state.cards[bear].tags).not.toContain('growing');

    goTo(state, S_COMBAT);
    goTo(state, S_END_STEP);

    expect(state.cards[bear].indexValues[POWER]).toBe(2);
    expect(state.cards[bear].indexValues[TOUGHNESS]).toBe(2);
    expect(state.cards[bear].tags).not.toContain('grown');
  });

  it('gains life equal to the total power of your creatures — sumIndex through every modifier', () => {
    const state = inMain();
    const tally = putInHand(state, 0, TPL.tally);
    putInPlay(state, 0, TPL.bear); // 2/2 -> 3 with the Lord
    putInPlay(state, 0, TPL.lord); // 2/2 -> 3, buffs itself too
    putInPlay(state, 1, TPL.bear); // not yours: not counted
    grantMana(state, 0, 0, 1);
    state.playerPools[LIFE][0] = 10;
    invalidateEffective(state);

    cast(state, 'tally');

    // 3 + 3, not 2 + 2 and not 2 + 2 + 2: `sumIndex` reads `effectiveIndex` (v4 §4.1) over YOUR zone.
    expect(life(state, 0)).toBe(16);
    expect(cardsIn(state, GRAVEYARD, 0)).toEqual([tally]);
  });

  it('empties both mana pools on every state exit', () => {
    const state = inMain();
    grantMana(state, 0, 3, 2);
    goTo(state, S_COMBAT);
    expect(state.playerPools[MANA_R]).toEqual([0, 0]);
    expect(state.playerPools[MANA_G]).toEqual([0, 0]);
  });

  it('stacks two spells and resolves the last one first', () => {
    const state = inMain();
    const first = putInHand(state, 0, TPL.bolt);
    const second = putInHand(state, 0, TPL.warcry);
    grantMana(state, 0, 3, 0);

    // Cast the Bolt but do not let it resolve; respond to it with a War Cry on top.
    drive(state, { kind: 'activate', ruleId: CAST.bolt, cardId: null, seat: 0 });
    answerCard(state, first);
    drive(state, { kind: 'activate', ruleId: CAST.warcry, cardId: null, seat: 0 });
    answerCard(state, second);
    expect(cardsIn(state, STACK, 0)).toEqual([second, first]);
    expect(state.actionStack).toHaveLength(2);

    letItResolve(state);

    // The War Cry (last announced) is the one now asking for a target, and its own card — not the
    // Bolt's — is what the frozen `topOfZone` will bin.
    drive(state, { kind: 'answerSeat', seat: 1 });
    expect(cardsIn(state, GRAVEYARD, 0)).toEqual([second]);
    expect(cardsIn(state, STACK, 0)).toEqual([first]);

    letItResolve(state);
    drive(state, { kind: 'answerSeat', seat: 1 });
    expect(cardsIn(state, GRAVEYARD, 0)).toEqual([first, second]);
    expect(life(state, 1)).toBe(STARTING_LIFE - 3); // 0 creatures for the War Cry, 3 for the Bolt
  });

  it('lets the opponent respond at instant speed, and refuses their sorcery', () => {
    const state = inMain();
    const theirBolt = putInHand(state, 1, TPL.bolt);
    putInHand(state, 1, TPL.warcry);
    const myBear = putInHand(state, 0, TPL.bear);
    grantMana(state, 0, 0, 1);
    grantMana(state, 1, 2, 0);

    drive(state, { kind: 'activate', ruleId: CAST.bear, cardId: null, seat: 0 });
    answerCard(state, myBear);
    drive(state, { kind: 'passPriority' }); // seat 0 passes; the window moves to seat 1

    const offer = state.interaction;
    if (offer?.kind !== 'priority') throw new Error('expected seat 1 to hold priority');
    expect(offer.seat).toBe(1);
    // An instant is offered on someone else's turn; a sorcery is not (header notes 4 and 6).
    expect(offer.legal.map((l) => l.ruleId)).toContain(CAST.bolt);
    expect(offer.legal.map((l) => l.ruleId)).not.toContain(CAST.warcry);

    drive(state, { kind: 'activate', ruleId: CAST.bolt, cardId: null, seat: 1 });
    answerCard(state, theirBolt);
    letItResolve(state);
    drive(state, { kind: 'answerSeat', seat: 0 });

    expect(life(state, 0)).toBe(STARTING_LIFE - 3);
    // The Bear was never countered, so it still resolves once the window finally closes.
    letItResolve(state);
    expect(cardsIn(state, BATTLEFIELD, 0)).toEqual([myBear]);
  });
});

describe('the emitted sample file', () => {
  it('writes samples/magic.json', () => {
    mkdirSync(join(process.cwd(), 'samples'), { recursive: true });
    writeFileSync(SAMPLE_PATH, `${exportJson(mtg)}\n`, 'utf8');
    expect(importJson(exportJson(mtg)).ok).toBe(true);
  });
});
