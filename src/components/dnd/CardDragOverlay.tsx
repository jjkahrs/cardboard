import { DragOverlay } from '@dnd-kit/core';
import { resolveVisibility } from '../../engine/visibility';
import type { GameDefinition, Id, PlayState } from '../../engine/types';
import { Card } from '../card/Card';
import { zoneKeyHolding } from './destinations';

export interface CardDragOverlayProps {
  /** The card under the pointer, or `null` when no drag is live. */
  cardId: Id | null;
  definition: GameDefinition;
  state: PlayState;
  viewingSeat: number;
  revealAll: boolean;
}

/**
 * The card that follows the pointer (§6.5). It is the SAME `<Card>` the table renders — including
 * face-down, so dragging an opponent's hand card never flashes its face — with the jitter zeroed
 * and the rough filter dropped in CSS, since this node repaints every frame.
 */
export function CardDragOverlay({
  cardId,
  definition,
  state,
  viewingSeat,
  revealAll,
}: CardDragOverlayProps) {
  const instance = cardId === null ? undefined : state.cards[cardId];
  const template = instance && definition.templates.find((t) => t.id === instance.templateId);

  const key = cardId === null ? null : zoneKeyHolding(state, cardId);
  const zoneInstance = key === null ? undefined : state.zones[key];
  const zone = zoneInstance && definition.zones.find((z) => z.id === zoneInstance.zoneId);

  return (
    <DragOverlay>
      {instance && template ? (
        <div className="cb-card-slot cb-drag-overlay">
          <Card
            template={template}
            instance={instance}
            definition={definition}
            faceDown={
              zone && zoneInstance
                ? resolveVisibility(zone, instance, viewingSeat, zoneInstance.seat, revealAll)
                : instance.faceDown
            }
          />
        </div>
      ) : null}
    </DragOverlay>
  );
}
