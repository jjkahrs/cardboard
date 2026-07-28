import { useDroppable } from '@dnd-kit/core';
import type { ZoneKey } from '../../engine/types';
import { gapDropId } from './ids';
import type { DropState } from './ZoneDroppable';

export interface GapDroppableProps {
  zoneKey: ZoneKey;
  /** The insert index a drop here produces: `n + 1` gaps for `n` cards. */
  index: number;
  drop?: DropState;
  disabled?: boolean;
}

/**
 * A thin insert-here target between two cards (§6.5). 10px at rest, expanding to 22px with a
 * marker caret when the pointer is over it, so the drop point is unambiguous without a
 * hover-guessing heuristic.
 *
 * `aria-hidden` because it is pointer-only: dragging is never the sole path to a move, and the
 * keyboard route is the numbered place badge in the zone header.
 */
export function GapDroppable({ zoneKey: key, index, drop, disabled = false }: GapDroppableProps) {
  const { setNodeRef, isOver } = useDroppable({ id: gapDropId(key, index), disabled });

  return (
    <div
      ref={setNodeRef}
      className="cb-gap"
      aria-hidden="true"
      data-gap-index={index}
      data-drop={drop}
      data-over={isOver || undefined}
    />
  );
}
