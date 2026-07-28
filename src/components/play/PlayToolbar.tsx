import { Link } from 'react-router-dom';
import { evalCriteria } from '../../engine/criteria';
import { activatableRules, activationCtx, type ActivationCandidate } from '../../engine/priority';
import { ACTIVE_PLAYER_POOL_ID, type GameDefinition, type Id, type LogEntry, type PlayState } from '../../engine/types';
import { useUiStore } from '../../stores/uiStore';
import { TransitionBar } from './TransitionBar';

function noop(): void {}

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
  onActivate = noop,
}: {
  definition: GameDefinition;
  state: PlayState;
  log: LogEntry[];
  onTransition: (toStateId: Id) => void;
  onRestart: () => void;
  /**
   * §6.7/§8 step 37 — non-`perInstance` `activation` rules, the toolbar's half of the same
   * mechanism `ZoneView`'s per-card buttons use. Defaulted to a no-op so every existing call site
   * keeps compiling; `PlayScreen` wraps this the same way it wraps `ZoneView`'s `onActivate` —
   * `dispatch({ kind: 'activate', ruleId, cardId: null, seat: viewingSeat })`.
   */
  onActivate?: (ruleId: Id) => void;
}) {
  const viewingSeat = useUiStore((s) => s.viewingSeat);
  const setViewingSeat = useUiStore((s) => s.setViewingSeat);
  const revealAll = useUiStore((s) => s.revealAll);
  const setRevealAll = useUiStore((s) => s.setRevealAll);
  const overrideEnabled = useUiStore((s) => s.overrideEnabled);
  const setOverrideEnabled = useUiStore((s) => s.setOverrideEnabled);
  const logVerbosity = useUiStore((s) => s.logVerbosity);
  const setLogVerbosity = useUiStore((s) => s.setLogVerbosity);

  const seats = Array.from({ length: state.playerCount }, (_, i) => i);
  const active = state.pools[ACTIVE_PLAYER_POOL_ID];

  // §6.7 — same "live" gate as `ZoneView`'s per-instance buttons (see the fuller reasoning there):
  // a priority window offered to a seat OTHER than the one we're pinned to must not render a
  // button either, because `activate` (`activation.ts`) rejects NOT_ACTIVATABLE unconditionally on
  // a seat mismatch (no override bypass), and a control that always fails on click is worse than
  // none. Outside any interaction, or during a window offered to our own pinned seat, is live;
  // any other open interaction leaves the toolbar's activation group inert.
  const priorityOpen = state.interaction?.kind === 'priority' ? state.interaction : null;
  const activationLive = state.interaction === null || priorityOpen?.seat === viewingSeat;
  const activationWindowId = priorityOpen ? priorityOpen.windowId : null;
  const enabled = activationLive
    ? activatableRules(state, definition, viewingSeat, activationWindowId)
    : [];
  const globalRuleActions = activationLive
    ? globalActions(state, definition, viewingSeat, activationWindowId, enabled)
    : [];

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
              // §6.3's vocabulary, minimally: greyed and " — ousted", the same marker the seat band
              // itself carries. This strip stays the secondary switch path (§6.1) — one click, no
              // dialog — elimination only changes how the button reads, never how it behaves.
              data-eliminated={state.eliminated.includes(seat) ? true : undefined}
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

      <label className="cb-toolbar__group">
        <span className="cb-toolbar__label">Log</span>
        {/* §5.9's own three levels, named from its table rather than invented here. Gates emission
            only (§5.9), so raising this after the fact cannot recover detail that was never
            written — the tester rewinds and redoes at the higher level. */}
        <select
          value={logVerbosity}
          onChange={(e) => setLogVerbosity(Number(e.target.value) as 1 | 2 | 3)}
        >
          <option value={1}>Actions</option>
          <option value={2}>Rules</option>
          <option value={3}>Criteria</option>
        </select>
      </label>

      <label className="cb-radio">
        <input
          type="checkbox"
          checked={overrideEnabled}
          onChange={(e) => setOverrideEnabled(e.target.checked)}
        />
        Designer override
      </label>

      {/* §6.7/step 37 — non-perInstance activation, its own group; renders nothing when there is
          none, the same v1-parity discipline `ActionStackRail` already uses (a v1-shaped game with
          no activation rules sees no new toolbar clutter). */}
      {globalRuleActions.length > 0 && (
        <div className="cb-toolbar__group" role="group" aria-label="Activate">
          {globalRuleActions.map((a) => (
            <button
              key={a.ruleId}
              type="button"
              className="cb-btn"
              data-variant="ghost"
              disabled={a.disabled}
              title={a.title}
              onClick={() => onActivate(a.ruleId)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

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

interface GlobalAction {
  ruleId: Id;
  label: string;
  disabled: boolean;
  title?: string;
}

/**
 * §6.7/§5.8 — every non-`perInstance` activation rule matching `windowId`, classified against
 * `enabled` (this render's one `activatableRules` call). The `ZoneView.tsx` twin (`instanceActions`)
 * does the identical classification per card; this is the un-per-card version, since a non-`perInstance`
 * rule (`priority.ts`'s `activatableRules`) is evaluated once, with no template/attachment to check.
 *
 * A rule is omitted when its `condition` fails (doesn't apply right now), enabled when
 * `activatableRules` already returned it, and otherwise disabled with the failing `costCheck` leaf's
 * own description as `title` — COST_UNPAYABLE named inline rather than a generic rejection (step 37).
 * The classification split uses `evalCriteria`, the same evaluator `activation.ts` itself calls —
 * never a second legality rule.
 *
 * ponytail: the `title` is the engine's own criteria description, and it is NOT redacted. The
 * per-card twin of this surface (`ZoneView`) can gate the whole affordance on the card being
 * face-down; a global rule has no card, so there is nothing here to gate on. `activationCtx(seat,
 * null)` leaves `sourceCardId` null, so `CardRef{kind:'host'}` — the only kind that reads it —
 * fails with a generic unbound message and names nothing. But an authored `costCheck` reading
 * `zoneTop` / `instance` / `triggeringCard` into a face-down zone ("top of your library's power >=
 * 3") could put a hidden card's id or value in this tooltip. Not reachable from `mtgish` or
 * `vtesish`, so it is documented rather than guessed at. Closing it needs one of two things this
 * layer cannot do: `evalCriteria` reporting that a leaf touched a hidden zone (so the title can be
 * withheld), or a zod refinement forbidding those `CardRef` kinds into hidden zones inside
 * `activation.costCheck`, mirroring the refinement `activation.cost` already carries (§5.8).
 */
function globalActions(
  state: PlayState,
  def: GameDefinition,
  seat: number,
  windowId: Id | null,
  enabled: ActivationCandidate[]
): GlobalAction[] {
  const ctx = activationCtx(seat, null);
  const out: GlobalAction[] = [];
  for (const rule of def.ruleSets) {
    const activation = rule.activation;
    if (!activation || activation.perInstance || activation.window !== windowId) continue;

    if (enabled.some((c) => c.ruleId === rule.id)) {
      out.push({ ruleId: rule.id, label: activation.label, disabled: false });
      continue;
    }
    if (rule.condition && !evalCriteria(rule.condition, state, ctx, def).value) continue;
    const verdict = activation.costCheck ? evalCriteria(activation.costCheck, state, ctx, def) : null;
    const failing = verdict?.leaves.find((l) => !l.value);
    out.push({ ruleId: rule.id, label: activation.label, disabled: true, title: failing?.description });
  }
  return out;
}
