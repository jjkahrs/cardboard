import { manualTransitions } from '../../engine/stateMachine';
import type { GameDefinition, Id, LogEntry, PlayState } from '../../engine/types';

/**
 * The state readout plus one button per criteria-less transition (§6.4, AC: M2).
 *
 * Which transitions are offered comes from `manualTransitions` — the engine's own legality check,
 * not a second implementation of "both sides agree" here. A state WITH entry criteria is entered by
 * the engine when the criteria hold and deliberately gets no button.
 *
 * The rejection banner is read back out of the log rather than tracked separately: the engine
 * already wrote the reason, and a second copy in component state is a second thing to get stale.
 */
export function TransitionBar({
  definition,
  state,
  log,
  onTransition,
}: {
  definition: GameDefinition;
  state: PlayState;
  log: LogEntry[];
  onTransition: (toStateId: Id) => void;
}) {
  const current = definition.machine.states.find((s) => s.id === state.currentStateId);
  const options = state.finished ? [] : manualTransitions(state, definition);
  const rejection = lastTransitionRejection(log);

  return (
    <div className="cb-toolbar__group">
      <span className="cb-toolbar__label">State:</span>
      <strong>{current?.name ?? state.currentStateId}</strong>

      {state.finished ? (
        <span role="status">Game over — rewind is the only way back.</span>
      ) : (
        options.map((target) => (
          <button
            key={target.id}
            type="button"
            className="cb-btn"
            onClick={() => onTransition(target.id)}
          >
            {target.transitionLabel ?? target.name}
          </button>
        ))
      )}

      {rejection !== null && (
        <p className="cb-error" role="alert">
          {rejection}
        </p>
      )}
    </div>
  );
}

/** The reason the most recent entry gives for refusing a transition, or null if it didn't refuse. */
function lastTransitionRejection(log: LogEntry[]): string | null {
  const last = log[log.length - 1];
  if (!last) return null;
  const line = last.lines.find(
    (l) => l.kind === 'transition' && (l.level === 'reject' || l.level === 'error')
  );
  return line?.message ?? null;
}
