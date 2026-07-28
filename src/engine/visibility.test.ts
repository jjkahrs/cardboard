import { describe, expect, it } from 'vitest';
import { resolveVisibility } from './visibility';
import type { CardInstance, PlayZone } from './types';

const faceUpZone: PlayZone = { id: 'z', name: 'Z', scope: 'shared', visibility: 'faceUp', layout: 'row', ordered: false, maxCapacity: null };
const faceDownZone: PlayZone = { ...faceUpZone, visibility: 'faceDown' };
const ownerOnlyZone: PlayZone = { ...faceUpZone, visibility: 'ownerOnly', scope: 'player' };

function card(faceDown: boolean): CardInstance {
  return { id: 'c1', templateId: 't', indexValues: {}, faceDown, rotated: false };
}

describe('resolveVisibility', () => {
  // Truth table: zone.visibility x owner/non-owner x instance.faceDown x revealAll.
  it('faceUp zone, face-up instance, viewer is owner -> visible', () => {
    expect(resolveVisibility(faceUpZone, card(false), 0, 0, false)).toBe(false);
  });

  it('faceUp zone, face-up instance, viewer is not owner -> still visible (zone scope has no owner)', () => {
    expect(resolveVisibility(faceUpZone, card(false), 1, 0, false)).toBe(false);
  });

  it('faceUp zone but instance itself flipped face-down -> hidden regardless of zone', () => {
    expect(resolveVisibility(faceUpZone, card(true), 0, 0, false)).toBe(true);
  });

  it('faceDown zone -> always hidden, even for the owner', () => {
    expect(resolveVisibility(faceDownZone, card(false), 0, 0, false)).toBe(true);
  });

  it('ownerOnly zone, viewer is the owner -> visible', () => {
    expect(resolveVisibility(ownerOnlyZone, card(false), 0, 0, false)).toBe(false);
  });

  it('ownerOnly zone, viewer is not the owner -> hidden', () => {
    expect(resolveVisibility(ownerOnlyZone, card(false), 1, 0, false)).toBe(true);
  });

  it('ownerOnly zone, shared instance (zoneSeat null) -> hidden for any viewer (never equals a seat)', () => {
    expect(resolveVisibility(ownerOnlyZone, card(false), 0, null, false)).toBe(true);
  });

  it('revealAll overrides a faceDown zone', () => {
    expect(resolveVisibility(faceDownZone, card(false), 1, 0, true)).toBe(false);
  });

  it('revealAll overrides ownerOnly for a non-owner', () => {
    expect(resolveVisibility(ownerOnlyZone, card(false), 1, 0, true)).toBe(false);
  });

  it('revealAll overrides the instance\'s own faceDown flag', () => {
    expect(resolveVisibility(faceUpZone, card(true), 0, 0, true)).toBe(false);
  });
});
