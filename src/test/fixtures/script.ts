/**
 * §9.2 `script.ts` — the hand-written scripted session that drives the rewind-fidelity suite
 * (§9.3): 200 rows applied in order against `duel` at seed `12345`, a canonical snapshot recorded
 * after each, then point rewinds at [0, 1, 12, 99, 198] and a replay-equivalence check.
 *
 * Hand-written, never fuzzed (§9.2) — the phases below are authored decisions, and the `for` loops
 * only spell out a decision already made ("play out seat 1's ten Strikes"). Every row's effect on
 * the game is predictable from the phase comment above it.
 *
 * CARD IDS ARE DERIVED, NOT GUESSED. `createPlayState(duel, '12345')` is called once at module
 * load and the seeded deck order is read straight out of it, so the script stays honest against
 * the real shuffle. If the PRNG or the deck changes, these ids follow rather than rot.
 *
 * WHAT THIS SCRIPT CANNOT COVER, and why — `duel`'s RuleSet library only ever executes three of
 * the eleven `Effect` kinds (`changePool`, `drawCards`, `destroyCards`). No authored rule in
 * `duel` performs `moveCards`, `shuffleZone`, `setCardIndex`, `flipCard`, `rotateCard`,
 * `createCard`, `fireEvent` or `forceTransition`, and a `PlayAction` cannot conjure an effect that
 * no rule contains. §9.2's "hit every effect kind" is therefore unreachable from a `PlayAction[]`
 * against this definition; it needs rules added to `duel.ruleSets`, which is not this file's call.
 * See the report. The script does cover every `PlayAction` kind except `cancelPrompt` (which would
 * make a third prompt pause, and exactly two were asked for).
 */

import type { Id, InsertPosition, PlayAction, RejectReason, ZoneRef } from '../../engine/types';
import { createPlayState } from '../../engine/setup';
import { zoneKey } from '../../engine/valueRef';
import {
  BATTLEFIELD,
  BOMB,
  CANTRIP,
  DECK,
  DISCARD,
  duel,
  END_TURN,
  GRUNT,
  HAND,
  MAIN,
  STRIKE,
  UNTAP,
} from './duel';
import { deepFreeze } from './empty';
import { END_STATE_ID } from '../../engine/types';

export const SCRIPT_SEED = '12345';

export interface ScriptRow {
  action: PlayAction;
  /** §4.10 — override lives on `EngineInput`, not on the action, so it rides alongside. */
  override?: boolean;
  /** Why this row exists. Read it when a rewind test fails at row 137. */
  note: string;
  /** Set when the row is SUPPOSED to be refused (§5.9) — an assertion, not a bug. */
  expectRejected?: RejectReason;
}

// ---------------------------------------------------------------------------
// Card ids, derived from the seeded opening state
// ---------------------------------------------------------------------------

const opening = createPlayState(duel, SCRIPT_SEED);

/** Ids of one template in one seat's deck, in shuffled deck order. */
const drawPile = (templateId: Id, seat: number): Id[] =>
  opening.zones[zoneKey(DECK, seat)].cardIds.filter((id) => opening.cards[id].templateId === templateId);

/** `scriptCards.strike[1][3]` — seat 1's fourth Strike. Exported so step 15 can name cards too. */
export const scriptCards = deepFreeze({
  strike: [drawPile(STRIKE, 0), drawPile(STRIKE, 1)],
  cantrip: [drawPile(CANTRIP, 0), drawPile(CANTRIP, 1)],
  grunt: [drawPile(GRUNT, 0), drawPile(GRUNT, 1)],
  bomb: [drawPile(BOMB, 0), drawPile(BOMB, 1)],
});

const { strike, cantrip, grunt, bomb } = scriptCards;

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

const at = (zoneId: Id, seat: number | null): ZoneRef => ({
  zoneId,
  seat: seat === null ? null : { kind: 'seat', index: seat },
});

const move = (cardId: Id, to: ZoneRef, position: InsertPosition): PlayAction => ({
  kind: 'moveCard',
  cardId,
  to,
  position,
});

const rows: ScriptRow[] = [];
const row = (action: PlayAction, note: string, extra: Omit<ScriptRow, 'action' | 'note'> = {}) => {
  rows.push({ action, note, ...extra });
};

const draw = (cardId: Id, seat: number, note: string) =>
  row(move(cardId, at(HAND, seat), 'bottom'), note);
const play = (cardId: Id, note: string) => row(move(cardId, at(BATTLEFIELD, null), 'bottom'), note);
const discard = (cardId: Id, seat: number, note: string) =>
  row(move(cardId, at(DISCARD, seat), 'top'), note);

// ---------------------------------------------------------------------------
// Phase 1 — open the session and prove an illegal transition changes nothing (3)
// ---------------------------------------------------------------------------

row({ kind: 'start' }, 'open the session');
row({ kind: 'transition', toStateId: MAIN }, 'start → Main, the only manual opening move');
row({ kind: 'transition', toStateId: UNTAP }, 'Main → Untap: Untap.enterableFrom omits Main (§5.9 row 5)', {
  expectRejected: 'ILLEGAL_TRANSITION',
});

// ---------------------------------------------------------------------------
// Phase 2 — fill Hand(0) to its cap of 7, get refused, then force it through (9)
// AC: R3 (the rejection) and M4 (the same move with override)
// ---------------------------------------------------------------------------

for (let i = 0; i < 7; i++) draw(strike[0][i], 0, `fill Hand(0) toward capacity — Strike ${i + 1}/7`);
row(move(strike[0][7], at(HAND, 0), 'bottom'), '8th card into a Hand capped at 7 — nothing moves', {
  expectRejected: 'ZONE_FULL',
});
row(move(strike[0][7], at(HAND, 0), 'bottom'), 'same move, designer override — Hand(0) goes to 8', {
  override: true,
});

// ---------------------------------------------------------------------------
// Phase 3 — direct manipulation, the actions that mutate a card and nothing else (6)
// ---------------------------------------------------------------------------

row({ kind: 'flipCard', cardId: strike[0][0], to: 'faceDown' }, 'flip a hand card face down');
row({ kind: 'flipCard', cardId: strike[0][0], to: 'toggle' }, 'and back — toggle is its own inverse');
row({ kind: 'rotateCard', cardId: strike[0][0], to: 'rotated' }, 'rotate it');
row({ kind: 'rotateCard', cardId: strike[0][1], to: 'rotated' }, 'rotate a second card, so one undo cannot mask the other');
row({ kind: 'rotateCard', cardId: strike[0][0], to: 'toggle' }, 'un-rotate the first');
row({ kind: 'flipCard', cardId: strike[0][1], to: 'toggle' }, 'flip the second face down via toggle');

// ---------------------------------------------------------------------------
// Phase 4-6 — play out every Strike in the game. Each onCardPlayed takes HP(next) −1,
// and with activePlayer 0 and 2 seats that is always seat 1: 20 Strikes, 20 → 0. (32)
// AC: R1
// ---------------------------------------------------------------------------

for (let i = 0; i < 8; i++) play(strike[0][i], `seat 0 plays Strike ${i + 1} — HP(seat 1) −1`);
for (let i = 8; i < 10; i++) {
  draw(strike[0][i], 0, `seat 0 draws its last Strikes — ${i + 1}/10`);
  play(strike[0][i], `seat 0 plays Strike ${i + 1} — HP(seat 1) −1`);
}
for (let i = 0; i < 10; i++) {
  draw(strike[1][i], 1, `seat 1 draws Strike ${i + 1}/10`);
  play(strike[1][i], `seat 1 plays Strike ${i + 1} — HP(seat 1) −1, and yes, onto itself`);
}

// ---------------------------------------------------------------------------
// Phase 7 — HP(seat 1) is now exactly 0. Re-play a Strike so the 21st subtraction
// clamps instead of going negative. (2)
// AC: A4 — the log line must record 0, never −1.
// ---------------------------------------------------------------------------

row(move(strike[0][0], at(HAND, 0), 'bottom'), 'pick a spent Strike back up off the Battlefield');
play(strike[0][0], 'replay it into HP(seat 1) = 0 — subtract 1 CLAMPS to 0, no event fired');

// ---------------------------------------------------------------------------
// Phase 8 — the first creature enters play. attackers 0 → 1 trips Combat's entry
// criteria, and the engine auto-transitions Main → Combat at quiescence. (5)
// AC: M1
// ---------------------------------------------------------------------------

for (let i = 0; i < 5; i++) {
  play(grunt[0][i], `seat 0 musters Grunt ${i + 1} — attackers +1${i === 0 ? ', which auto-enters Combat' : ''}`);
}

// ---------------------------------------------------------------------------
// Phase 9 — FIRST PROMPT PAUSE. Bomb's effect 0 asks; effect 1 (HP −1) must not have
// run yet. The answer resumes it. (3)
// AC: R2
// ---------------------------------------------------------------------------

draw(bomb[0][0], 0, 'seat 0 draws a Bomb');
play(bomb[0][0], 'play it — SUSPENDS on the creature prompt, 5 Grunts are candidates');
row({ kind: 'answerPrompt', chosen: [grunt[0][0]] }, 'destroy the first Grunt; only now does HP(active) −1 run');

// ---------------------------------------------------------------------------
// Phase 10 — a turn cycle. Main is never a resting state again: attackers stays above
// zero, so every return to Main immediately auto-transitions back to Combat. (4)
// AC: M2 (EndTurn is the criteria-less, labeled one)
// ---------------------------------------------------------------------------

row({ kind: 'transition', toStateId: END_TURN }, 'Combat → EndTurn, the labeled button');
row({ kind: 'transition', toStateId: MAIN }, 'EndTurn → Main, which auto-transitions straight back to Combat');
row({ kind: 'transition', toStateId: END_TURN }, 'and around again — two cycles, so a rewind lands mid-loop');
row({ kind: 'transition', toStateId: MAIN }, 'EndTurn → Main once more');

// ---------------------------------------------------------------------------
// Phase 11-12 — seat 1 musters, then the SECOND PROMPT PAUSE. (8)
// ---------------------------------------------------------------------------

for (let i = 0; i < 5; i++) play(grunt[1][i], `seat 1 musters Grunt ${i + 1} — attackers(seat 1) +1`);

draw(bomb[1][0], 1, 'seat 1 draws a Bomb');
play(bomb[1][0], 'play it — SUSPENDS again, now with 9 creatures on the Battlefield');
row({ kind: 'answerPrompt', chosen: [grunt[0][1]] }, 'destroy a seat 0 Grunt — a legal answer need not be your own card');

// ---------------------------------------------------------------------------
// Phase 13-14 — the 8 surviving creatures attack, then leave play. This empties the
// Battlefield of anything tagged `creature`, which is what lets Phase 15 run. (16)
// ---------------------------------------------------------------------------

const survivors: [Id, number][] = [
  ...grunt[0].slice(2, 5).map((id): [Id, number] => [id, 0]),
  ...grunt[1].slice(0, 5).map((id): [Id, number] => [id, 1]),
];

for (const [id] of survivors) row({ kind: 'rotateCard', cardId: id, to: 'rotated' }, 'rotate the Grunt — it is attacking');
for (const [id, seat] of survivors) discard(id, seat, 'the attack resolves and the Grunt goes to its owner Discard');

// ---------------------------------------------------------------------------
// Phase 15 — the remaining 18 Bombs, played with an empty board. Zero legal targets, so
// the prompt is SKIPPED and the trailing HP(active) −1 still runs (§5.9 row 8, §9.3).
// 18 Bombs takes HP(seat 0) from 18 to exactly 0 — no second clamp. (54)
// ---------------------------------------------------------------------------

const leftoverBombs: [Id, number][] = [
  ...bomb[0].slice(1).map((id): [Id, number] => [id, 0]),
  ...bomb[1].slice(1).map((id): [Id, number] => [id, 1]),
];

for (const [id, seat] of leftoverBombs) {
  draw(id, seat, `seat ${seat} draws a Bomb`);
  play(id, 'play it — no creatures, so the prompt is skipped and HP(active) −1 still runs');
  discard(id, seat, 'the spent Bomb goes to the Discard');
}

// ---------------------------------------------------------------------------
// Phase 16 — the last 10 Grunts, straight from the deck to the board and rotated. (20)
// ---------------------------------------------------------------------------

const lateGrunts: [Id, number][] = [
  ...grunt[0].slice(5).map((id): [Id, number] => [id, 0]),
  ...grunt[1].slice(5).map((id): [Id, number] => [id, 1]),
];

for (const [id, seat] of lateGrunts) play(id, `seat ${seat} musters a late Grunt — deck straight to the Battlefield`);
for (const [id] of lateGrunts) row({ kind: 'rotateCard', cardId: id, to: 'rotated' }, 'rotate the late Grunt');

// ---------------------------------------------------------------------------
// Phase 17 — sweep all 20 spent Strikes off the Battlefield. (20)
// ---------------------------------------------------------------------------

for (let seat = 0; seat < 2; seat++) {
  for (const id of strike[seat]) discard(id, seat, `sweep seat ${seat}'s spent Strike to the Discard`);
}

// ---------------------------------------------------------------------------
// Phase 18 — Cantrips LAST, deliberately. Their drawCards effect pulls whatever is on
// top of the deck, so from here on the script no longer knows the deck by name and must
// not address it. Each play: Hand +2. (12)
// AC: A3's rule, exercised
// ---------------------------------------------------------------------------

for (let seat = 0; seat < 2; seat++) {
  for (let i = 0; i < 3; i++) {
    draw(cantrip[seat][i], seat, `seat ${seat} draws a Cantrip`);
    play(cantrip[seat][i], 'play it — drawCards 2 from Deck to Hand');
  }
}

// ---------------------------------------------------------------------------
// Phase 19 — a custom event nothing is bound to. Not an error: it resolves with zero
// rules (§5.9 row 6). (1)
// ---------------------------------------------------------------------------

row({ kind: 'fireEvent', name: 'resonate', seat: 0 }, 'fire an unbound event — dispatches, 0 rules, no error');

// ---------------------------------------------------------------------------
// Phase 20 — end the session, then prove it is closed. (5)
// AC: M5
// ---------------------------------------------------------------------------

row({ kind: 'transition', toStateId: END_TURN }, 'Combat → EndTurn for the last time');
row({ kind: 'transition', toStateId: MAIN }, 'EndTurn → Main → auto Combat, one final cycle');
row({ kind: 'transition', toStateId: END_TURN }, 'Combat → EndTurn');
row({ kind: 'transition', toStateId: END_STATE_ID }, 'EndTurn → End: finished, onGameEnd fires once');
row({ kind: 'flipCard', cardId: grunt[0][9], to: 'toggle' }, 'anything after End is refused — only rewind is accepted', {
  expectRejected: 'SESSION_FINISHED',
});

/** 200 rows. Frozen like every other fixture — mutating tests `structuredClone` first. */
export const script: ScriptRow[] = deepFreeze(rows);
