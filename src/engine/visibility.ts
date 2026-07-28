/**
 * TECHNICAL_DESIGN.md §6.3. Resolved above `<Card>` (in `ZoneView`) so the Catalog can render the
 * identical component with zero play-state coupling — no React, no store import here.
 */

import type { CardInstance, PlayZone } from './types';

/** Returns true iff the card should render face-down for this viewer. */
export function resolveVisibility(
  zone: PlayZone,
  instance: CardInstance,
  viewingSeat: number,
  zoneSeat: number | null,
  revealAll: boolean
): boolean {
  if (revealAll) return false;
  return zone.visibility === 'faceDown' || (zone.visibility === 'ownerOnly' && zoneSeat !== viewingSeat) || instance.faceDown;
}
