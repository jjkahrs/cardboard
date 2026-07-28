/**
 * Step 26 — the `onDragEnd` contract (§6.5).
 *
 * jsdom cannot drive a real pointer drag, and dnd-kit hands the handler nothing but two id
 * strings, so these ids ARE the drag's data model. Tested as the pure functions they are.
 */

import { describe, expect, it } from 'vitest';
import { cardDragId, gapDropId, parseCardDragId, parseDropId, zoneDropId } from './ids';

describe('drag ids round-trip', () => {
  it('recovers the card id, including one containing a colon', () => {
    expect(parseCardDragId(cardDragId('card_1'))).toBe('card_1');
    expect(parseCardDragId(cardDragId('card:odd'))).toBe('card:odd');
  });

  it('reads a zone drop as an append', () => {
    expect(parseDropId(zoneDropId('zone_battlefield'))).toEqual({
      zoneKey: 'zone_battlefield',
      position: 'bottom',
    });
  });

  it('reads a gap drop as an insert at exactly that index', () => {
    // The seat suffix must survive: `zone_hand` and `zone_hand#1` are different piles.
    expect(parseDropId(gapDropId('zone_hand#1', 3))).toEqual({
      zoneKey: 'zone_hand#1',
      position: { kind: 'index', index: 3 },
    });
    expect(parseDropId(gapDropId('zone_deck#0', 0))).toEqual({
      zoneKey: 'zone_deck#0',
      position: { kind: 'index', index: 0 },
    });
  });

  it('returns null rather than guessing at anything else', () => {
    // A drop outside every droppable, or a droppable this module did not mint, must be a no-op —
    // never a move to a zone whose key happens to parse.
    expect(parseDropId('card:c1')).toBeNull();
    expect(parseDropId('zone:')).toBeNull();
    expect(parseDropId('gap:zone_hand')).toBeNull();
    expect(parseDropId('gap:zone_hand:x')).toBeNull();
    expect(parseCardDragId('zone:zone_hand')).toBeNull();
  });
});
