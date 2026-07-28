import { Link } from 'react-router-dom';
import { ACTIVE_PLAYER_POOL_ID, type GameDefinition, type Id, type LogEntry, type PlayState } from '../../engine/types';
import { useUiStore } from '../../stores/uiStore';
import { TransitionBar } from './TransitionBar';

/**
 * The top bar (§6.4): who you are viewing as, the two tester switches, the seed, the state and its
 * transitions, and restart.
 *
 * Viewing seat / reveal-all / override live in `uiStore`, NOT in the session — rewinding must not
 * yank the tester's view to another seat or flip their switches underneath them (§3.5).
 */
export function PlayToolbar({
  definition,
  state,
  log,
  onTransition,
  onRestart,
}: {
  definition: GameDefinition;
  state: PlayState;
  log: LogEntry[];
  onTransition: (toStateId: Id) => void;
  onRestart: () => void;
}) {
  const viewingSeat = useUiStore((s) => s.viewingSeat);
  const setViewingSeat = useUiStore((s) => s.setViewingSeat);
  const revealAll = useUiStore((s) => s.revealAll);
  const setRevealAll = useUiStore((s) => s.setRevealAll);
  const overrideEnabled = useUiStore((s) => s.overrideEnabled);
  const setOverrideEnabled = useUiStore((s) => s.setOverrideEnabled);

  const seats = Array.from({ length: state.playerCount }, (_, i) => i);
  const active = state.pools[ACTIVE_PLAYER_POOL_ID];

  return (
    <header className="cb-toolbar">
      <div className="cb-toolbar__group">
        <span className="cb-toolbar__label" id="cb-seat-switch-label">
          Viewing as
        </span>
        <div role="group" aria-labelledby="cb-seat-switch-label">
          {seats.map((seat) => (
            <button
              key={seat}
              type="button"
              className="cb-btn cb-seat-switch"
              aria-pressed={seat === viewingSeat}
              onClick={() => setViewingSeat(seat)}
            >
              P{seat + 1}
            </button>
          ))}
        </div>
      </div>

      <label className="cb-radio">
        <input
          type="checkbox"
          checked={revealAll}
          onChange={(e) => setRevealAll(e.target.checked)}
        />
        Reveal all
      </label>

      <label className="cb-radio">
        <input
          type="checkbox"
          checked={overrideEnabled}
          onChange={(e) => setOverrideEnabled(e.target.checked)}
        />
        Designer override
      </label>

      <span className="cb-toolbar__group">
        <span className="cb-toolbar__label">Active</span>
        <strong>{typeof active === 'number' ? `P${active + 1}` : '—'}</strong>
      </span>

      <span className="cb-toolbar__group">
        <span className="cb-toolbar__label">Seed</span>
        {/* Shown, not just stored: reproducing a past game means reading this number back out
            (AC: S2). */}
        <strong>{state.seed}</strong>
        <button
          type="button"
          className="cb-btn"
          data-variant="ghost"
          // Optional-chained: clipboard access is absent in insecure contexts and in jsdom, and a
          // copy button is not worth a crash.
          onClick={() => void navigator.clipboard?.writeText(state.seed)}
        >
          Copy
        </button>
      </span>

      <TransitionBar
        definition={definition}
        state={state}
        log={log}
        onTransition={onTransition}
      />

      <button type="button" className="cb-btn" onClick={onRestart}>
        Restart
      </button>

      {/* The play screen has no rail (§6.1), so this bar carries the only way back to the editor.
          The route id and the definition id are the same thing, so it needs no extra prop. */}
      <Link className="cb-btn" to={`/game/${definition.id}/pools`}>
        Back to the editor
      </Link>
    </header>
  );
}
