/**
 * Step 38 — the interaction bar (§6.5–6.6). `viewingSeat`/`revealAll` live in `uiStore`, outside
 * the session (§3.5, precedent: `PlayToolbar.test.tsx`), so these tests set that store directly.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Interaction, PlayAction } from '../../engine/types';
import { useUiStore } from '../../stores/uiStore';
import { InteractionBar } from './InteractionBar';

const chooseCards: Interaction = {
  kind: 'chooseCards',
  promptId: '0:rs_bomb:0',
  promptText: 'Choose a target',
  seat: 0,
  candidates: ['g1', 'g2'],
  min: 1,
  max: 1,
};

const chooseOption: Interaction = {
  kind: 'chooseOption',
  promptId: 'p1',
  promptText: 'Choose one',
  seat: 0,
  options: [
    { id: 'opt_a', label: 'Draw a card' },
    { id: 'opt_b', label: 'Gain 3 life' },
  ],
};

const chooseNumber: Interaction = {
  kind: 'chooseNumber',
  promptId: 'p1',
  promptText: 'Choose X',
  seat: 0,
  min: 0,
  max: 5,
};

const chooseSeat: Interaction = {
  kind: 'chooseSeat',
  promptId: 'p1',
  promptText: 'Choose a seat',
  seat: 0,
  candidates: [0, 1],
};

const priority: Interaction = {
  kind: 'priority',
  promptId: 'p1',
  windowId: 'w1',
  seat: 0,
  legal: [{ ruleId: 'rs_x', cardId: null, label: 'Fizzle' }],
};

const sealed = (submitted: Record<number, string> = {}): Interaction => ({
  kind: 'sealed',
  promptId: 'p1',
  choiceId: 'strike',
  seats: [0, 1],
  options: [
    { id: 'rock', label: 'Rock' },
    { id: 'paper', label: 'Paper' },
  ],
  submitted,
});

const bar = (interaction: Interaction, chosen: string[] = []) => {
  const dispatch = vi.fn<(action: PlayAction) => void>();
  return {
    dispatch,
    user: userEvent.setup(),
    ...render(<InteractionBar interaction={interaction} chosen={chosen} dispatch={dispatch} />),
  };
};

beforeEach(() => {
  useUiStore.setState({ viewingSeat: 0, revealAll: false });
});

describe('<InteractionBar>', () => {
  // AC: SP12 — the pinned-seat gate
  it('hides the question entirely from a seat that is not pinned', () => {
    useUiStore.setState({ viewingSeat: 1 });
    const { container } = bar(chooseOption);

    expect(container.innerHTML).not.toContain('Choose one');
    expect(container.innerHTML).not.toContain('Draw a card');
    expect(container.innerHTML).not.toContain('opt_a');
    expect(screen.getByText('P1 must answer.')).toBeInTheDocument();
  });

  it('switches the pinned seat from the gate button', async () => {
    useUiStore.setState({ viewingSeat: 1 });
    const { user } = bar(chooseOption);

    await user.click(screen.getByRole('button', { name: /view as p1/i }));
    expect(useUiStore.getState().viewingSeat).toBe(0);
  });

  it('reveal-all bypasses the gate (§6.1 — the one deliberate short-circuit)', () => {
    useUiStore.setState({ viewingSeat: 1, revealAll: true });
    bar(chooseOption);
    expect(screen.getByText('Choose one')).toBeInTheDocument();
  });

  it('renders PromptBar unchanged for chooseCards and dispatches answerPrompt/cancelPrompt', async () => {
    const { user, dispatch } = bar(chooseCards, ['g1']);

    await user.click(screen.getByRole('button', { name: /confirm/i }));
    expect(dispatch).toHaveBeenCalledWith({ kind: 'answerPrompt', chosen: ['g1'] });

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(dispatch).toHaveBeenCalledWith({ kind: 'cancelPrompt' });
  });

  it('chooseOption shows labels only and dispatches the id', async () => {
    const { user, dispatch } = bar(chooseOption);

    expect(screen.getByText('Draw a card')).toBeInTheDocument();
    expect(screen.queryByText('opt_a')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Draw a card' }));
    expect(dispatch).toHaveBeenCalledWith({ kind: 'answerOption', optionId: 'opt_a' });
  });

  it('chooseNumber carries min/max on the element and gates Confirm on validity', async () => {
    const { user, dispatch } = bar(chooseNumber);

    const input = screen.getByLabelText(/choose a number/i);
    expect(input).toHaveAttribute('min', '0');
    expect(input).toHaveAttribute('max', '5');

    const confirm = screen.getByRole('button', { name: /confirm/i });
    expect(confirm).toBeDisabled();

    await user.type(input, '3');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(dispatch).toHaveBeenCalledWith({ kind: 'answerNumber', value: 3 });
  });

  it('chooseNumber keeps Confirm disabled outside the resolved bounds', async () => {
    const { user } = bar(chooseNumber);
    const input = screen.getByLabelText(/choose a number/i);
    await user.type(input, '9');
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
  });

  it('chooseSeat offers one Pn button per candidate and dispatches answerSeat', async () => {
    const { user, dispatch } = bar(chooseSeat);

    await user.click(screen.getByRole('button', { name: 'P2' }));
    expect(dispatch).toHaveBeenCalledWith({ kind: 'answerSeat', seat: 1 });
  });

  it('priority renders PriorityBar for the pinned seat and dispatches activate', async () => {
    const { user, dispatch } = bar(priority);
    await user.click(screen.getByRole('button', { name: 'Fizzle' }));
    expect(dispatch).toHaveBeenCalledWith({ kind: 'activate', ruleId: 'rs_x', cardId: null, seat: 0 });
  });

  it('priority shows nothing but the gate for an unpinned seat', () => {
    useUiStore.setState({ viewingSeat: 1 });
    const { container } = bar(priority);
    expect(container.innerHTML).not.toContain('Fizzle');
    expect(screen.getByText('P1 must answer.')).toBeInTheDocument();
  });

  describe('sealed', () => {
    // AC: V5 — the component half of the sealed-count contract
    it('lets the pinned seat submit and never leaks another seat’s submission', () => {
      const { container } = bar(sealed({ 1: 'rock' }));

      expect(screen.getByText('1 of 2 submitted')).toBeInTheDocument();
      expect(container.innerHTML).not.toContain('rock');
      expect(screen.getByRole('button', { name: 'Paper' })).toBeInTheDocument();
    });

    it('shows a waiting state, with a count, once the pinned seat has submitted', () => {
      bar(sealed({ 0: 'paper' }));

      expect(screen.getByText(/you have submitted — waiting for 1 others/)).toBeInTheDocument();
    });

    it('dispatches submitSealed for the pinned seat', async () => {
      const { user, dispatch } = bar(sealed());
      await user.click(screen.getByRole('button', { name: 'Rock' }));
      expect(dispatch).toHaveBeenCalledWith({ kind: 'submitSealed', seat: 0, optionId: 'rock' });
    });

    it('the pinned-seat gate reads seat membership, not a single seat field, when unpinned', () => {
      useUiStore.setState({ viewingSeat: 2 });
      const { container } = bar(sealed({ 0: 'rock' }));

      expect(container.innerHTML).not.toContain('Rock');
      expect(container.innerHTML).not.toContain('Paper');
      expect(screen.getByText('1 of 2 submitted.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /view as p1/i })).toBeInTheDocument();
    });
  });
});
