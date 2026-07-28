import type { HTMLAttributes, ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { ZoneKey } from '../../engine/types';
import { zoneDropId } from './ids';

/** What the engine probe says about dropping the carried card here (§6.4). */
export type DropState = 'ok' | 'reject' | 'override';

export interface ZoneDroppableProps extends HTMLAttributes<HTMLDivElement> {
  zoneKey: ZoneKey;
  /** Undefined while nothing is being carried — the zone is then just a zone. */
  drop?: DropState;
  disabled?: boolean;
  children: ReactNode;
}

/**
 * One droppable over the whole zone — the unordered case (§6.5). A drop here appends; ordered
 * zones use `<GapDroppable>` instead so the insert index is explicit.
 */
export function ZoneDroppable({
  zoneKey: key,
  drop,
  disabled = false,
  children,
  ...rest
}: ZoneDroppableProps) {
  const { setNodeRef, isOver } = useDroppable({ id: zoneDropId(key), disabled });

  return (
    <div ref={setNodeRef} {...rest} data-drop={drop} data-over={isOver || undefined}>
      {children}
    </div>
  );
}
