/**
 * TECHNICAL_DESIGN.md §6.3. Resolved above `<Card>` (in `ZoneView`) so the Catalog can render the
 * identical component with zero play-state coupling — no React, no store import here.
 *
 * v2 §3.6, §4.10, §6.2 add the log's own visibility surface: `zoneAudience` is what `dispatch.ts`
 * stamps `LogLine.visibility` with at emission, and `projectLogLine`/`projectCause` are the
 * seat-scoped projection the Phase-3 log panel (step 35) will call — computed once, engine-side, so
 * the panel never needs a second copy of this rule (§4.10).
 */

import type { CardInstance, GameDefinition, Interaction, LogEntry, LogLine, PlayZone, SeatId, ZoneKey } from './types';
import { parseZoneKey } from './valueRef';

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

// ---------------------------------------------------------------------------
// v2 §3.6, §4.10, §6.2 — the log's audience
// ---------------------------------------------------------------------------

/**
 * Which seats may see a LINE about a card that just landed in `key` — `dispatch.ts` stamps the
 * result on `LogLine.visibility` at emission. The RESULTING zone alone governs: once a card is
 * sitting in a public zone its identity is knowable from the board itself regardless of where it
 * came from, so only entering a hidden zone restricts anything. `null` => public.
 *
 * ponytail: only the zone the card ends up in is consulted, not the one it left — see the
 * `visibility` comment at its one call site (`dispatch.ts`'s `moveCard` case) for why that direction
 * is the one that actually hides information. Per-instance `faceDown` (one card individually
 * flipped) is deliberately NOT read here, unlike `resolveVisibility` above — a log line about a
 * whole zone's policy is not the same claim as one card's own flip state, and folding the two would
 * make an ordinary face-down card played into a face-up zone unnamed to its own controller.
 */
export function zoneAudience(def: GameDefinition, key: ZoneKey): SeatId[] | null {
  const { zoneId, seat } = parseZoneKey(key);
  const zone = def.zones.find((z) => z.id === zoneId);
  if (!zone) return null; // dangling — nothing here to hide from
  if (zone.visibility === 'faceDown') return [];
  if (zone.visibility === 'ownerOnly' && seat !== null) return [seat];
  return null;
}

/**
 * The seat-scoped log projection, §9.4(f) point 1 and §6.2. Redacts `message`/`change` only — NEVER
 * the line itself, because `entry.seq === index in log[] === index in history[]` (§4.10): a log that
 * dropped slots per seat would give different seats different rewind indices for the same moment.
 * The Phase-3 panel (step 35) calls this for every line; nothing else needs a second copy of the
 * `line.visibility === null || revealAll || line.visibility.includes(viewingSeat)` check.
 */
export function projectLogLine(
  line: LogLine,
  viewingSeat: SeatId,
  revealAll: boolean
): Pick<LogLine, 'message' | 'change'> {
  if (revealAll || line.visibility === null || line.visibility.includes(viewingSeat)) {
    return { message: line.message, change: line.change };
  }
  return { message: 'a card', change: null };
}

/** Same rule, for `LogEntry.cause` — §6.2's own example: "a redacted cause renders its header as
 * `▸ P3 acted` — the seat is not secret, the description is." */
export function projectCause(
  cause: LogEntry['cause'],
  viewingSeat: SeatId,
  revealAll: boolean
): Pick<LogEntry['cause'], 'description'> {
  if (revealAll || cause.visibility === null || cause.visibility.includes(viewingSeat)) {
    return { description: cause.description };
  }
  return { description: 'acted' };
}
