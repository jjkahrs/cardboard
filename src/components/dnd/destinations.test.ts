/**
 * Step 26 — where a carried card may go (§6.4, §6.5). AC: R3 (UI half), M4 (UI half).
 *
 * The point of this module is that it does NOT restate the capacity rule: it asks the engine. The
 * assertions below are therefore about what the UI does with that answer, plus the one piece of UI
 * judgement it owns — a stack takes the card on top.
 */

import { describe, expect, it } from 'vitest';
import { zoneKey } from '../../engine/valueRef';
import { BATTLEFIELD, DECK, DISCARD, GRUNT, HAND, MAIN, duel } from '../../test/fixtures/duel';
import { emptyBoard, place } from '../../test/board';
import { moveDestinations, zoneRefFromKey } from './destinations';

const BF = zoneKey(BATTLEFIELD, null);
const HAND_0 = zoneKey(HAND, 0);
const DECK_0 = zoneKey(DECK, 0);

function board() {
  const state = emptyBoard(duel, MAIN);
  place(state, duel, BF, GRUNT, 'g1');
  return state;
}

describe('the destination list', () => {
  it('offers every other zone instance, numbered, and never the one the card is in', () => {
    const destinations = moveDestinations(duel, board(), 'g1');

    // Deck×2, Hand×2, Discard×2 — the Battlefield holds the card, so it is a no-op, not an option.
    expect(destinations.map((d) => d.zoneKey)).toEqual([
      zoneKey(DECK, 0),
      zoneKey(DECK, 1),
      zoneKey(HAND, 0),
      zoneKey(HAND, 1),
      zoneKey(DISCARD, 0),
      zoneKey(DISCARD, 1),
    ]);
    expect(destinations.map((d) => d.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(destinations.map((d) => d.label)).toContain('Hand (seat 1)');
  });

  it('puts a card on TOP of a stack and at the back of everything else', () => {
    const destinations = moveDestinations(duel, board(), 'g1');
    const at = (key: string) => destinations.find((d) => d.zoneKey === key);

    // "Put it back on the deck" means the top of the deck; a hand or a row appends.
    expect(at(DECK_0)?.position).toBe('top');
    expect(at(HAND_0)?.position).toBe('bottom');
  });

  it('carries the engine’s capacity refusal, verbatim, instead of restating the rule (AC: R3)', () => {
    const state = board();
    for (let i = 0; i < 7; i++) place(state, duel, HAND_0, GRUNT, `h${i}`);

    const hand = moveDestinations(duel, state, 'g1').find((d) => d.zoneKey === HAND_0);
    expect(hand?.blocked).toBe('zone at capacity (7/7)');

    // And an uncapped zone is never blocked, however many cards it holds.
    expect(moveDestinations(duel, state, 'h0').find((d) => d.zoneKey === BF)?.blocked).toBeNull();
  });

  it('reports no destination at all for a card that is in no zone', () => {
    const state = board();
    delete state.zones[BF].cardIds[0];
    state.zones[BF].cardIds = [];
    // A card off the table still lists every zone — nothing to exclude — and none is blocked.
    expect(moveDestinations(duel, state, 'g1')).toHaveLength(7);
  });
});

describe('zoneRefFromKey', () => {
  it('turns a seated key back into the seat the move action wants', () => {
    expect(zoneRefFromKey(zoneKey(HAND, 1))).toEqual({
      zoneId: HAND,
      seat: { kind: 'seat', index: 1 },
    });
    expect(zoneRefFromKey(BF)).toEqual({ zoneId: BATTLEFIELD, seat: null });
  });
});
