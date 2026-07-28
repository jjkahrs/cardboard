/**
 * Step 36 — the priority bar (§6.5).
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Interaction, PlayAction } from '../../engine/types';
import { PriorityBar } from './PriorityBar';

const priority: Interaction = {
  kind: 'priority',
  promptId: 'p1',
  windowId: 'w1',
  seat: 1,
  legal: [
    { ruleId: 'rs_counter', cardId: 'c1', label: 'Counterspell' },
    { ruleId: 'rs_fizzle', cardId: null, label: 'Fizzle (Ruby Ring)' },
  ],
};

const bar = (interaction: Interaction = priority) => {
  const dispatch = vi.fn<(action: PlayAction) => void>();
  return {
    dispatch,
    user: userEvent.setup(),
    ...render(<PriorityBar interaction={interaction as Extract<Interaction, { kind: 'priority' }>} dispatch={dispatch} />),
  };
};

describe('<PriorityBar>', () => {
  // AC: MTG5 — a seat that can respond sees its offer
  it('offers one button per legal response, labelled from `label`', () => {
    bar();
    expect(screen.getByRole('button', { name: 'Counterspell' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fizzle (Ruby Ring)' })).toBeInTheDocument();
  });

  // AC: MTG5
  it('dispatches activate with the entry\'s ruleId/cardId and the interaction\'s seat', async () => {
    const { user, dispatch } = bar();
    await user.click(screen.getByRole('button', { name: 'Counterspell' }));
    expect(dispatch).toHaveBeenCalledWith({ kind: 'activate', ruleId: 'rs_counter', cardId: 'c1', seat: 1 });
  });

  it('a rule with no per-instance source dispatches a null cardId', async () => {
    const { user, dispatch } = bar();
    await user.click(screen.getByRole('button', { name: 'Fizzle (Ruby Ring)' }));
    expect(dispatch).toHaveBeenCalledWith({ kind: 'activate', ruleId: 'rs_fizzle', cardId: null, seat: 1 });
  });

  it('[Pass] dispatches passPriority', async () => {
    const { user, dispatch } = bar();
    await user.click(screen.getByRole('button', { name: /pass/i }));
    expect(dispatch).toHaveBeenCalledWith({ kind: 'passPriority' });
  });

  it('Esc is inert — passing is the only abort path', async () => {
    const { user, dispatch } = bar();
    await user.keyboard('{Escape}');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
