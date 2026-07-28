/**
 * TECHNICAL_DESIGN.md §6.3. Resolved above `<Card>` (in `ZoneView`) so the Catalog can render the
 * identical component with zero play-state coupling — no React, no store import here.
 */

import type { CardInstance, Interaction, PlayZone, SeatId } from './types';

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

/**
 * v2 §5.11 rule 2 — refuses to resolve another seat's sealed submission for the pinned seat. This is
 * TECHNICAL_DESIGN_V2.md §10.1's point made concrete: the refusal exists so that seat B's turn at
 * the keyboard is an honest reproduction of seat B's information state, not because the same tester
 * couldn't otherwise look — reveal-all short-circuits it exactly like `resolveVisibility` above,
 * because reveal-all is "look at everything," the one deliberate global bypass, not a leak.
 *
 * Returns the submitted `ChoiceOption.id`, or `null` when nothing should be disclosed — either the
 * submitter hasn't submitted yet, or the viewer is pinned to a different seat and reveal-all is off.
 * The UI (`PromptBar`, Phase 3) is expected to render `Object.keys(submitted).length` — a COUNT —
 * for a seat this returns `null` for, never to fall back to guessing a value some other way.
 */
export function resolveSealedSubmission(
  interaction: Extract<Interaction, { kind: 'sealed' }>,
  submitterSeat: SeatId,
  viewingSeat: number,
  revealAll: boolean
): string | null {
  if (!revealAll && submitterSeat !== viewingSeat) return null;
  return interaction.submitted[submitterSeat] ?? null;
}
