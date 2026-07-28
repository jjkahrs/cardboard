import type { StateMachine } from '../../engine/types';
import { NODE_H, NODE_W, StateNode } from './StateNode';

const PADDING = 120;

export interface StateGraphProps {
  machine: StateMachine;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, position: { x: number; y: number }) => void;
}

/**
 * The canvas (§8 step 23): nodes at their authored positions, one line per legal transition.
 *
 * Edges are drawn from `exitableTo` only. A legal transition needs both sides (§4.8), and the
 * screen writes both together — so drawing both directions would double every line, and drawing
 * `enterableFrom` as well would render a one-sided edge as if it were legal.
 */
export function StateGraph({ machine, selectedId, onSelect, onMove }: StateGraphProps) {
  const byId = new Map(machine.states.map((s) => [s.id, s]));
  const width = Math.max(...machine.states.map((s) => s.position.x + NODE_W)) + PADDING;
  const height = Math.max(...machine.states.map((s) => s.position.y + NODE_H)) + PADDING;

  const edges = machine.states.flatMap((from) =>
    from.exitableTo.flatMap((toId) => {
      const to = byId.get(toId);
      if (!to) return [];
      return [
        {
          key: `${from.id}->${toId}`,
          label: `${from.name} to ${to.name}`,
          x1: from.position.x + NODE_W / 2,
          y1: from.position.y + NODE_H / 2,
          x2: to.position.x + NODE_W / 2,
          y2: to.position.y + NODE_H / 2,
        },
      ];
    })
  );

  return (
    <div className="cb-state-canvas" style={{ inlineSize: width, blockSize: height }}>
      <svg className="cb-state-canvas__edges" width={width} height={height} aria-hidden="true">
        <defs>
          <marker
            id="cb-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {edges.map((edge) => (
          <line
            key={edge.key}
            x1={edge.x1}
            y1={edge.y1}
            x2={edge.x2}
            y2={edge.y2}
            markerEnd="url(#cb-arrow)"
          />
        ))}
      </svg>

      {/* The edges are decoration for the SVG layer; the readable version is the transition lists
          in the panel beside the canvas, which are also the only way to edit them. */}
      {machine.states.map((state) => (
        <StateNode
          key={state.id}
          state={state}
          selected={state.id === selectedId}
          reserved={state.id === machine.startStateId || state.id === machine.endStateId}
          onSelect={() => onSelect(state.id)}
          onMove={(position) => onMove(state.id, position)}
        />
      ))}
    </div>
  );
}
