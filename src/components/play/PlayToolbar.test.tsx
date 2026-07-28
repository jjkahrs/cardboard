/**
 * Step 25 — the play toolbar (§6.4).
 *
 * The seat switcher, reveal-all and override live in `uiStore`, deliberately outside the session
 * (§3.5), so these tests read that store back rather than a prop.
 */

import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlayState } from '../../engine/setup';
import type { LogEntry, PlayState } from '../../engine/types';
import { duel } from '../../test/fixtures/duel';
import { useUiStore } from '../../stores/uiStore';
import { PlayToolbar } from './PlayToolbar';

const SEED = '12345';

const toolbar = (state: PlayState = createPlayState(duel, SEED), log: LogEntry[] = []) => {
  const onTransition = vi.fn();
  const onRestart = vi.fn();
  return {
    onTransition,
    onRestart,
    user: userEvent.setup(),
    ...render(
      <MemoryRouter>
        <PlayToolbar
          definition={duel}
          state={state}
          log={log}
          onTransition={onTransition}
          onRestart={onRestart}
        />
      </MemoryRouter>
    ),
  };
};

beforeEach(() => {
  useUiStore.setState({ viewingSeat: 0, revealAll: false, overrideEnabled: false });
});

describe('<PlayToolbar>', () => {
  it('shows the seed the session was dealt with (AC: S2)', () => {
    // Reproducing a past game means reading this number back out of the UI; a seed that only lives
    // in state is a seed nobody can write down.
    toolbar();
    expect(screen.getByText(SEED)).toBeInTheDocument();
  });

  it('offers one button per seat and marks the one being viewed', async () => {
    const { user } = toolbar();

    expect(screen.getByRole('button', { name: 'P1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'P2' })).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: 'P2' }));

    expect(useUiStore.getState().viewingSeat).toBe(1);
    expect(screen.getByRole('button', { name: 'P2' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggles reveal-all and designer override without touching the session', async () => {
    const { user } = toolbar();

    await user.click(screen.getByRole('checkbox', { name: /reveal all/i }));
    await user.click(screen.getByRole('checkbox', { name: /designer override/i }));

    expect(useUiStore.getState()).toMatchObject({ revealAll: true, overrideEnabled: true });
  });

  it('names the active player from the reserved pool', () => {
    const state = createPlayState(duel, SEED);
    state.pools.activePlayer = 1;
    toolbar(state);
    // Scoped to the readout: "P2" is also a seat-switcher button, and a bare getByText would match
    // whichever came first rather than the thing under test.
    expect(screen.getByText('Active').parentElement).toHaveTextContent('P2');
  });

  it('restarts on request', async () => {
    const { user, onRestart } = toolbar();
    await user.click(screen.getByRole('button', { name: /restart/i }));
    expect(onRestart).toHaveBeenCalled();
  });
});
