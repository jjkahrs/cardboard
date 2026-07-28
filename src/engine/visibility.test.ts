import { describe, expect, it } from 'vitest';
import { projectCause, projectLogLine, resolveVisibility, zoneAudience } from './visibility';
import type { CardInstance, GameDefinition, LogEntry, LogLine, PlayZone } from './types';
import { empty } from '../test/fixtures/empty';
import { zoneKey } from './valueRef';

const faceUpZone: PlayZone = { id: 'z', name: 'Z', scope: 'shared', visibility: 'faceUp', layout: 'row', ordered: false, maxCapacity: null };
const faceDownZone: PlayZone = { ...faceUpZone, visibility: 'faceDown' };
const ownerOnlyZone: PlayZone = { ...faceUpZone, visibility: 'ownerOnly', scope: 'player' };

function card(faceDown: boolean): CardInstance {
  return { id: 'c1', templateId: 't', indexValues: {}, faceDown, rotated: false, tags: [], owner: 0, controller: null, attachedTo: null };
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

// ---------------------------------------------------------------------------
// v2 §3.6, §4.10, §6.2, §9.4(f) point 1 — the log's own visibility gate, engine-side.
// ---------------------------------------------------------------------------

const BATTLEFIELD = 'zone_bf';
const HAND = 'zone_hand';

const battlefield: PlayZone = { id: BATTLEFIELD, name: 'Battlefield', scope: 'shared', visibility: 'faceUp', layout: 'row', ordered: false, maxCapacity: null };
const hand: PlayZone = { id: HAND, name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: null };
const deck: PlayZone = { id: 'zone_deck', name: 'Deck', scope: 'player', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null };

const def: GameDefinition = { ...empty, zones: [battlefield, hand, deck] };

describe('zoneAudience', () => {
  it('a public (faceUp, shared) zone is visible to everyone — null', () => {
    expect(zoneAudience(def, zoneKey(BATTLEFIELD, null))).toBeNull();
  });

  it('an ownerOnly zone restricts to that seat alone', () => {
    expect(zoneAudience(def, zoneKey(HAND, 1))).toEqual([1]);
  });

  it('a faceDown zone is visible to nobody', () => {
    expect(zoneAudience(def, zoneKey('zone_deck', 0))).toEqual([]);
  });

  it('a dangling zone key (definition edited out from under it) is treated as public, not a throw', () => {
    expect(zoneAudience(def, zoneKey('zone_gone', null))).toBeNull();
  });
});

describe('projectLogLine — §9.4(f) point 1', () => {
  const baseLine: LogLine = {
    level: 'info',
    kind: 'change',
    message: 'Move Grunt: Hand (seat 1) → Battlefield.',
    change: { path: `zones/${BATTLEFIELD}/cardIds`, before: zoneKey(HAND, 1), after: BATTLEFIELD },
    ruleId: null,
    effectKind: null,
    depth: 0,
    visibility: [1], // e.g. a move INTO seat 1's hidden hand — only seat 1 may see which card
  };

  it('a seat inside the audience sees the real message, template name included', () => {
    const view = projectLogLine(baseLine, 1, false);
    expect(view.message).toContain('Grunt');
    expect(view.change).toEqual(baseLine.change);
  });

  it('a seat outside the audience gets a placeholder, not the real template name', () => {
    const view = projectLogLine(baseLine, 0, false);
    expect(view.message).not.toContain('Grunt');
    expect(view.message).toContain('a card');
    expect(view.change).toBeNull();
  });

  it('revealAll bypasses the audience for any viewer', () => {
    const view = projectLogLine(baseLine, 0, true);
    expect(view.message).toContain('Grunt');
    expect(view.change).toEqual(baseLine.change);
  });

  it('visibility: null is public to every seat', () => {
    const publicLine: LogLine = { ...baseLine, visibility: null };
    expect(projectLogLine(publicLine, 0, false).message).toContain('Grunt');
    expect(projectLogLine(publicLine, 3, false).message).toContain('Grunt');
  });
});

describe('projectCause', () => {
  const cause: LogEntry['cause'] = {
    kind: 'userAction',
    description: 'Submit sealed choice hit',
    seat: 1,
    visibility: [1],
  };

  it('the submitter sees the real description', () => {
    expect(projectCause(cause, 1, false).description).toBe('Submit sealed choice hit');
  });

  it('another pinned seat gets the generic placeholder — the seat is not secret, the description is', () => {
    expect(projectCause(cause, 0, false).description).not.toContain('hit');
  });

  it('revealAll discloses it to anyone', () => {
    expect(projectCause(cause, 0, true).description).toBe('Submit sealed choice hit');
  });
});
