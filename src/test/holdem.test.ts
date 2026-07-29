/**
 * The Texas Hold'em sample (`src/samples/holdem.ts`) — validated, driven through one hand's worth of
 * setup, and EMITTED to `samples/texas-holdem.json`.
 *
 * The emit lives here rather than in a `scripts/*.mjs` generator because the definition is authored
 * in TypeScript and this repo has no TS runner outside vitest. `npm test` is therefore also how the
 * sample is regenerated: change `holdem.ts`, run the tests, commit the JSON that falls out.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ICON_CATALOG } from '../assets/icons/catalog';
import { step } from '../engine/dispatch';
import { exportJson, importJson, validateDefinition } from '../engine/schema';
import { createPlayState } from '../engine/setup';
import type { EngineInput, GameDefinition, LogLine, PlayAction, PlayState } from '../engine/types';
import { zoneKey } from '../engine/valueRef';
import {
  BIG_BLIND,
  BOARD,
  BURN,
  CHIPS,
  COMMITTED,
  DECK,
  FOLDED,
  HAND,
  POT,
  RS_FOLD,
  RS_WAGER,
  SEATS,
  SEAT_COUNT,
  SMALL_BLIND,
  STARTING_CHIPS,
  S_DEAL,
  S_FLOP,
  S_PAYOUT,
  S_PREFLOP,
  holdem,
} from '../samples/holdem';
import { ACTIVE_PLAYER_POOL_ID } from '../engine/types';

const SAMPLE_PATH = join(process.cwd(), 'samples', 'texas-holdem.json');

/** Same shape as `dispatch.test.ts`'s driver: one action, then CONTINUE until the engine settles. */
function drive(state: PlayState, def: GameDefinition, action: PlayAction): LogLine[] {
  const lines: LogLine[] = [];
  let input: EngineInput = { kind: 'action', action, override: false };
  let result = step(state, input, lines, def);
  let steps = 1;
  while (!result.done) {
    if (++steps > 5000) throw new Error('driver runaway');
    input = { kind: 'continue' };
    result = step(state, input, lines, def);
  }
  return lines;
}

function started(): PlayState {
  const state = createPlayState(holdem, 'holdem-test-seed');
  drive(state, holdem, { kind: 'start' });
  return state;
}

const cardsIn = (state: PlayState, zone: string, seat: number | null = null): string[] =>
  state.zones[zoneKey(zone, seat)].cardIds;

const chips = (state: PlayState, seat: number): number => state.playerPools[CHIPS][seat] as number;

/**
 * Everybody checks. Passing IS checking in this sample (see `holdem.ts`'s header note 4), and a full
 * lap of passes is what closes the window — which is also the only way to reach the next street,
 * since an open interaction rejects every other action.
 */
function checkAround(state: PlayState): number {
  let laps = 0;
  while (state.interaction?.kind === 'priority') {
    if (++laps > 3 * SEAT_COUNT) throw new Error('betting window never closed');
    drive(state, holdem, { kind: 'passPriority' });
  }
  return laps;
}

describe('the Hold’em sample is a valid definition', () => {
  it('passes shape and referential validation', () => {
    expect(validateDefinition(holdem)).toEqual([]);
  });

  it('round-trips byte-identically through import/export', () => {
    const once = exportJson(holdem);
    const back = importJson(once);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(exportJson(back.definition)).toBe(once);
  });

  it('holds exactly 52 distinct cards, one of each', () => {
    expect(holdem.templates).toHaveLength(52);
    expect(new Set(holdem.templates.map((t) => t.id)).size).toBe(52);
    expect(holdem.decks[0].entries.every((e) => e.quantity === 1)).toBe(true);
    expect(holdem.decks[0].entries).toHaveLength(52);
  });

  it('names only icons the sprite actually ships', () => {
    const known = new Set(ICON_CATALOG.map((icon) => icon.id));
    const missing = holdem.templates
      .flatMap((t) => [t.faceIcon, ...t.indexes.map((i) => i.icon)])
      .filter((icon) => !known.has(icon));
    expect([...new Set(missing)]).toEqual([]);
  });

  // Derived from the MARQUEE — the string a human reads off the table — rather than from the same
  // rank/suit pair `faceIcon` was built from, so this cannot agree with a wrong mapping by sharing
  // its inputs. The sprite once shipped no numbered pips and all 36 borrowed their suit's ace, which
  // the "icons the sprite ships" check above passes happily: a wrong glyph is a real one.
  it('gives every card the glyph for its own rank and suit', () => {
    const suits: Record<string, string> = {
      '♠': 'spades',
      '♥': 'hearts',
      '♦': 'diamonds',
      '♣': 'clubs',
    };
    const courts: Record<string, string> = { J: 'jack', Q: 'queen', K: 'king', A: 'ace' };

    const wrong = holdem.templates
      .map((t) => {
        const [, rank, suit] = /^(10|[2-9]|[JQKA])(.)$/u.exec(t.marquee) ?? [];
        const want = `gi-card-${courts[rank] ?? rank}-${suits[suit]}`;
        return t.faceIcon === want ? null : `${t.marquee}: ${t.faceIcon} (wanted ${want})`;
      })
      .filter(Boolean);

    expect(wrong).toEqual([]);
    // 52 cards, 52 distinct glyphs — no two cards share a face.
    expect(new Set(holdem.templates.map((t) => t.faceIcon)).size).toBe(52);
  });
});

describe('dealing a hand', () => {
  it('deals two cards a seat off one shared deck and posts both blinds', () => {
    const state = started();
    drive(state, holdem, { kind: 'transition', toStateId: S_DEAL });

    for (const seat of SEATS) expect(cardsIn(state, HAND, seat)).toHaveLength(2);
    expect(cardsIn(state, DECK)).toHaveLength(52 - 2 * SEAT_COUNT);

    // Button is seat 0 (activePlayer's default), so small blind is seat 1 and big blind seat 2.
    expect(chips(state, 1)).toBe(STARTING_CHIPS - SMALL_BLIND);
    expect(chips(state, 2)).toBe(STARTING_CHIPS - BIG_BLIND);
    expect(chips(state, 0)).toBe(STARTING_CHIPS);
    expect(state.pools[POT]).toBe(SMALL_BLIND + BIG_BLIND);
    expect(state.playerPools[COMMITTED][1]).toBe(SMALL_BLIND);
    expect(state.playerPools[COMMITTED][2]).toBe(BIG_BLIND);
  });

  it('re-deals from a full deck: the previous hand’s cards go back before the shuffle', () => {
    const state = started();
    drive(state, holdem, { kind: 'transition', toStateId: S_DEAL });
    const first = SEATS.map((seat) => [...cardsIn(state, HAND, seat)]);

    // Straight back into Deal — the legal route is via Payout, which is also what moves the button.
    state.currentStateId = S_PAYOUT;
    drive(state, holdem, { kind: 'transition', toStateId: S_DEAL });

    expect(cardsIn(state, DECK)).toHaveLength(52 - 2 * SEAT_COUNT);
    for (const seat of SEATS) expect(cardsIn(state, HAND, seat)).toHaveLength(2);
    // A different shuffle, i.e. the gather really happened rather than the deck running down.
    expect(SEATS.map((seat) => cardsIn(state, HAND, seat))).not.toEqual(first);
    expect(state.pools[POT]).toBe(SMALL_BLIND + BIG_BLIND);
  });
});

describe('betting', () => {
  it('opens a priority window on the button when preflop starts, offering fold and wager', () => {
    const state = started();
    drive(state, holdem, { kind: 'transition', toStateId: S_DEAL });
    drive(state, holdem, { kind: 'transition', toStateId: S_PREFLOP });

    const interaction = state.interaction;
    expect(interaction?.kind).toBe('priority');
    if (interaction?.kind !== 'priority') return;
    expect(interaction.seat).toBe(0);
    expect(interaction.legal.map((l) => l.ruleId).sort()).toEqual([RS_FOLD, RS_WAGER].sort());
  });

  it('moves the typed wager from the seat’s stack into the pot', () => {
    const state = started();
    drive(state, holdem, { kind: 'transition', toStateId: S_DEAL });
    drive(state, holdem, { kind: 'transition', toStateId: S_PREFLOP });

    drive(state, holdem, { kind: 'activate', ruleId: RS_WAGER, cardId: null, seat: 0 });
    expect(state.interaction?.kind).toBe('chooseNumber');
    drive(state, holdem, { kind: 'answerNumber', value: BIG_BLIND });

    expect(chips(state, 0)).toBe(STARTING_CHIPS - BIG_BLIND);
    expect(state.playerPools[COMMITTED][0]).toBe(BIG_BLIND);
    expect(state.pools[POT]).toBe(SMALL_BLIND + 2 * BIG_BLIND);
  });

  it('offers a folded seat nothing, so priority passes it over in silence', () => {
    const state = started();
    drive(state, holdem, { kind: 'transition', toStateId: S_DEAL });
    drive(state, holdem, { kind: 'transition', toStateId: S_PREFLOP });

    drive(state, holdem, { kind: 'activate', ruleId: RS_FOLD, cardId: null, seat: 0 });
    expect(state.playerPools[FOLDED][0]).toBe(true);

    // The window walked on to the next seat rather than re-offering seat 0.
    const interaction = state.interaction;
    expect(interaction?.kind).toBe('priority');
    if (interaction?.kind !== 'priority') return;
    expect(interaction.seat).not.toBe(0);
  });
});

describe('the board and the button', () => {
  it('burns one and turns three on the flop', () => {
    const state = started();
    drive(state, holdem, { kind: 'transition', toStateId: S_DEAL });
    drive(state, holdem, { kind: 'transition', toStateId: S_PREFLOP });
    // One pass per seat and the street is over — no seat is asked twice.
    expect(checkAround(state)).toBe(SEAT_COUNT);
    drive(state, holdem, { kind: 'transition', toStateId: S_FLOP });

    expect(cardsIn(state, BOARD)).toHaveLength(3);
    expect(cardsIn(state, BURN)).toHaveLength(1);
    // The flop reset every seat's stake in the street; the pot kept the blinds.
    expect(state.playerPools[COMMITTED].every((v) => v === 0)).toBe(true);
    expect(state.pools[POT]).toBe(SMALL_BLIND + BIG_BLIND);
  });

  it('advances the button on leaving Payout, and wraps it past the last seat', () => {
    const state = started();
    state.currentStateId = S_PAYOUT;
    drive(state, holdem, { kind: 'transition', toStateId: S_DEAL });
    expect(state.pools[ACTIVE_PLAYER_POOL_ID]).toBe(1);

    state.pools[ACTIVE_PLAYER_POOL_ID] = SEAT_COUNT - 1;
    state.currentStateId = S_PAYOUT;
    drive(state, holdem, { kind: 'transition', toStateId: S_DEAL });
    expect(state.pools[ACTIVE_PLAYER_POOL_ID]).toBe(0);
  });

  it('pays the whole pot to whoever claims it', () => {
    const state = started();
    drive(state, holdem, { kind: 'transition', toStateId: S_DEAL });
    drive(state, holdem, { kind: 'transition', toStateId: S_PREFLOP });
    checkAround(state);
    state.currentStateId = S_PAYOUT;

    const pot = state.pools[POT] as number;
    drive(state, holdem, { kind: 'activate', ruleId: 'rs_takePot', cardId: null, seat: 3 });

    expect(chips(state, 3)).toBe(STARTING_CHIPS + pot);
    expect(state.pools[POT]).toBe(0);
  });
});

describe('the emitted sample file', () => {
  it('writes samples/texas-holdem.json', () => {
    mkdirSync(join(process.cwd(), 'samples'), { recursive: true });
    writeFileSync(SAMPLE_PATH, `${exportJson(holdem)}\n`, 'utf8');
    expect(importJson(exportJson(holdem)).ok).toBe(true);
  });
});
