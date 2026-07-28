import type { GameDefinition, ZoneRef } from '../../engine/types';

/** A shared zone has exactly one instance, so carrying a seat on the reference would be a lie. */
export function zoneRefFor(
  definition: GameDefinition,
  zoneId: string,
  seat: ZoneRef['seat']
): ZoneRef {
  const zone = definition.zones.find((z) => z.id === zoneId);
  return { zoneId, seat: zone?.scope === 'player' ? (seat ?? { kind: 'active' }) : null };
}

/** The first zone as a reference, or `null` when the game has no zones — the caller disables. */
export function defaultZoneRef(definition: GameDefinition): ZoneRef | null {
  const zone = definition.zones[0];
  return zone ? zoneRefFor(definition, zone.id, null) : null;
}

export const isDanglingZone = (zone: ZoneRef, definition: GameDefinition): boolean =>
  !definition.zones.some((z) => z.id === zone.zoneId);
