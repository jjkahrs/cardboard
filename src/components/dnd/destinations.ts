/**
 * Where the card currently being carried may go, and why not (§6.4, §6.5).
 *
 * One list feeds three surfaces — the numbered click-to-place badges, the drop-target styling
 * during a drag, and the capacity tooltip — so they cannot disagree. `blocked` comes straight from
 * the engine's `canMove()` probe: the UI MIRRORS the capacity rule, it never restates it.
 */

import { canMove } from '../../engine/effects';
import { parseZoneKey, zoneKey } from '../../engine/valueRef';
import type {
  GameDefinition,
  Id,
  InsertPosition,
  PlayState,
  ZoneKey,
  ZoneRef,
} from '../../engine/types';

export interface MoveDestination {
  /** 1-based. The badge's label, and its digit shortcut for the first nine. */
  ordinal: number;
  zoneKey: ZoneKey;
  to: ZoneRef;
  position: InsertPosition;
  label: string;
  /** The engine's refusal, ready to show; `null` when the move is legal. */
  blocked: string | null;
}

/** The one spelling of a zone instance's name, shared by the table and the destination list. */
export function zoneInstanceLabel(name: string, seat: number | null): string {
  return seat === null ? name : `${name} (seat ${seat + 1})`;
}

/** A drop id carries a `ZoneKey`; `moveCard` wants a `ZoneRef`. Same information, other shape. */
export function zoneRefFromKey(key: ZoneKey): ZoneRef {
  const { zoneId, seat } = parseZoneKey(key);
  return { zoneId, seat: seat === null ? null : { kind: 'seat', index: seat } };
}

export function zoneKeyHolding(state: PlayState, cardId: Id): ZoneKey | null {
  for (const [key, instance] of Object.entries(state.zones)) {
    if (instance.cardIds.includes(cardId)) return key;
  }
  return null;
}

export function moveDestinations(
  def: GameDefinition,
  state: PlayState,
  cardId: Id
): MoveDestination[] {
  const from = zoneKeyHolding(state, cardId);
  const destinations: MoveDestination[] = [];

  for (const zone of def.zones) {
    const seats =
      zone.scope === 'shared'
        ? [null]
        : Array.from({ length: state.playerCount }, (_, seat) => seat);

    for (const seat of seats) {
      const key = zoneKey(zone.id, seat);
      // The zone the card is already in is a no-op move (§5.9 row 15), not a destination.
      if (key === from || !state.zones[key]) continue;

      const probe = canMove(state, def, [cardId], key);
      destinations.push({
        ordinal: destinations.length + 1,
        zoneKey: key,
        to: zoneRefFromKey(key),
        // The top of a stack is what "put it back on the deck" means; everything else appends.
        // ponytail: click-to-place is one badge per zone, so it cannot name an arbitrary insert
        // index — that is the drag path's gap droppables. Add a second badge if a tester ever
        // needs bottom-of-deck without a mouse.
        position: zone.layout === 'stack' ? 'top' : 'bottom',
        label: zoneInstanceLabel(zone.name, seat),
        blocked: probe.ok ? null : (probe.detail ?? probe.reason),
      });
    }
  }

  return destinations;
}
