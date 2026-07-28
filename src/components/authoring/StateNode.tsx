import { useRef, type PointerEvent as ReactPointerEvent, type KeyboardEvent } from 'react';
import type { MachineState } from '../../engine/types';

/** Fixed so the graph can compute edge endpoints without measuring the DOM. */
export const NODE_W = 148;
export const NODE_H = 60;

/** One arrow-key press. Big enough to be worth pressing, small enough to line two nodes up. */
const NUDGE = 8;

export interface StateNodeProps {
  state: MachineState;
  selected: boolean;
  reserved: boolean;
  onSelect: () => void;
  onMove: (position: { x: number; y: number }) => void;
}

/**
 * A draggable node on the machine canvas. `position` is part of the definition (§4.8), so a layout
 * the designer arranged survives export and reopens the way they left it.
 *
 * Drag is pointer events directly, not dnd-kit: dnd-kit models droppable *containers* for the play
 * table, and a free canvas has none — every drop lands wherever the pointer is. Arrow keys move the
 * node too, because a canvas reachable only by mouse is a canvas half the users cannot rearrange.
 */
export function StateNode({ state, selected, reserved, onSelect, onMove }: StateNodeProps) {
  const drag = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    drag.current = {
      pointerId: e.pointerId,
      dx: e.clientX - state.position.x,
      dy: e.clientY - state.position.y,
    };
    // Optional chaining: jsdom has no pointer capture, and losing it costs the test nothing.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onSelect();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== e.pointerId) return;
    onMove({
      // Clamped at 0 so a node can never be dragged off the top-left and out of reach.
      x: Math.max(0, Math.round(e.clientX - active.dx)),
      y: Math.max(0, Math.round(e.clientY - active.dy)),
    });
  };

  const endDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const delta = { ArrowLeft: [-NUDGE, 0], ArrowRight: [NUDGE, 0], ArrowUp: [0, -NUDGE], ArrowDown: [0, NUDGE] }[
      e.key
    ];
    if (!delta) return;
    e.preventDefault(); // arrows would scroll the canvas out from under the node
    onMove({
      x: Math.max(0, state.position.x + delta[0]),
      y: Math.max(0, state.position.y + delta[1]),
    });
  };

  return (
    <button
      type="button"
      className="cb-state-node"
      style={{ insetInlineStart: state.position.x, insetBlockStart: state.position.y }}
      aria-pressed={selected}
      data-reserved={reserved ? '1' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onClick={onSelect}
    >
      <strong>{state.name}</strong>
      <span className="cb-hint">
        {state.entryCriteria === null ? (state.transitionLabel ?? 'manual') : 'when its criteria hold'}
        {state.priority !== 0 && ` · priority ${state.priority}`}
      </span>
    </button>
  );
}
