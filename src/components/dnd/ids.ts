/**
 * The drag/drop id vocabulary of §6.5, and its inverse.
 *
 * These strings are the ENTIRE `onDragEnd` contract: dnd-kit hands back `active.id` and `over.id`
 * and nothing else, so everything the drop needs — which card, which zone, which insert index —
 * has to survive the round trip through them. Pure and separately testable, because jsdom cannot
 * drive a real pointer drag; the parse is where the bugs would be anyway.
 */

import type { Id, InsertPosition, ZoneKey } from '../../engine/types';

export const cardDragId = (cardId: Id): string => `card:${cardId}`;
export const zoneDropId = (key: ZoneKey): string => `zone:${key}`;
export const gapDropId = (key: ZoneKey, index: number): string => `gap:${key}:${index}`;

export interface DropTarget {
  zoneKey: ZoneKey;
  position: InsertPosition;
}

export function parseCardDragId(id: string): Id | null {
  const match = /^card:(.+)$/.exec(id);
  return match ? match[1] : null;
}

/**
 * `zone:` → append, `gap:` → insert at that index. That is the whole handler (§6.5).
 *
 * The gap pattern is anchored on a trailing `:<digits>` so a zoneKey containing a colon still
 * round-trips; a zoneKey ending in `:<digits>` would not, and no generated id has that shape.
 */
export function parseDropId(id: string): DropTarget | null {
  const gap = /^gap:(.+):(\d+)$/.exec(id);
  if (gap) return { zoneKey: gap[1], position: { kind: 'index', index: Number(gap[2]) } };

  const zone = /^zone:(.+)$/.exec(id);
  if (zone) return { zoneKey: zone[1], position: 'bottom' };

  return null;
}
