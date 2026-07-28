import type { HTMLAttributes, ReactNode } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { Id } from '../../engine/types';
import { cardDragId } from './ids';

export interface CardDraggableProps extends HTMLAttributes<HTMLDivElement> {
  cardId: Id;
  disabled?: boolean;
  children: ReactNode;
}

/**
 * The card slot, made draggable (§6.5). It carries no transform of its own: while a drag is live
 * the moving card is the `<DragOverlay>`, and the source stays put at `opacity: .35`.
 *
 * dnd-kit's `attributes` are deliberately NOT spread. They announce `role="button"` and
 * `aria-roledescription="draggable"`, which would be a lie — there is no `KeyboardSensor` here.
 * The keyboard path is click-to-place (§6.5), and `<Card>` already carries the button role for it.
 */
export function CardDraggable({ cardId, disabled = false, children, ...rest }: CardDraggableProps) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: cardDragId(cardId), disabled });

  return (
    <div ref={setNodeRef} {...rest} {...listeners} data-dragging={isDragging || undefined}>
      {children}
    </div>
  );
}
