/**
 * Step 25 — the transition bar (§6.4). AC: M2, and the UI half of M3.
 *
 * Which transitions get a button comes from the engine's `manualTransitions`, so these tests drive
 * the real session store rather than hand-written state: a bar that offered a transition the engine
 * would reject is exactly the bug worth catching.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { END_STATE_ID } from '../../engine/types';
import { COMBAT, END_TURN, MAIN, UNTAP, duel } from '../../test/fixtures/duel';
import { useSessionStore } from '../../stores/sessionStore';
import { TransitionBar } from './TransitionBar';

const session = () => {
  const s = useSessionStore.getState().session;
  if (!s) throw new Error('no session');
  return s;
};

const bar = () => {
  const onTransition = vi.fn();
  const { state, log } = session();
  return {
    onTransition,
    user: userEvent.setup(),
    ...render(
      <TransitionBar definition={duel} state={state} log={log} onTransition={onTransition} />
    ),
  };
};

beforeEach(() => {
  useSessionStore.getState().startSession(duel, '12345');
  useSessionStore.getState().dispatch({ kind: 'start' });
  useSessionStore.getState().dispatch({ kind: 'transition', toStateId: MAIN });
});

describe('<TransitionBar> (AC: M2)', () => {
  it('renders a button for a criteria-less transition and none for an automatic one', () => {
    bar();

    // "End Turn" has no entry criteria, so the tester presses it.
    expect(screen.getByRole('button', { name: 'End Turn' })).toBeInTheDocument();
    // "Combat" is entered by the engine when attackers > 0 — a button would be a second, competing
    // way in, and the criteria would never be consulted.
    expect(screen.queryByRole('button', { name: /combat/i })).not.toBeInTheDocument();
    expect(duel.machine.states.find((s) => s.id === COMBAT)?.entryCriteria).not.toBeNull();
  });

  it('names the state the session is in', () => {
    bar();
    expect(screen.getByText('Main')).toBeInTheDocument();
  });

  it('performs the transition when the button is clicked', async () => {
    const { user, onTransition } = bar();
    await user.click(screen.getByRole('button', { name: 'End Turn' }));
    expect(onTransition).toHaveBeenCalledWith(END_TURN);
  });

  it('offers nothing but a game-over notice once the session has finished', () => {
    useSessionStore.getState().dispatch({ kind: 'transition', toStateId: END_TURN });
    useSessionStore.getState().dispatch({ kind: 'transition', toStateId: END_STATE_ID });
    bar();

    expect(session().state.finished).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent(/game over/i);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('a rejected transition (AC: M3, UI half)', () => {
  it("shows the engine's rejection naming both states, and the state does not move", () => {
    // Main → Untap is missing from both sides in the fixture, so this is the rejection path even
    // though no button offers it — a hand-fired action, a rule's forceTransition, or an override
    // that got switched off all land here.
    useSessionStore.getState().dispatch({ kind: 'transition', toStateId: UNTAP });
    bar();

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('Main');
    expect(banner).toHaveTextContent('Untap');
    expect(session().state.currentStateId).toBe(MAIN);
  });

  it('drops the banner as soon as something else happens', () => {
    useSessionStore.getState().dispatch({ kind: 'transition', toStateId: UNTAP });
    useSessionStore.getState().dispatch({ kind: 'transition', toStateId: END_TURN });
    bar();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
