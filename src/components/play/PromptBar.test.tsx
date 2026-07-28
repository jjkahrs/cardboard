/**
 * Step 25 — the prompt bar (§6.7). The cards are the picker; this bar states the question, counts
 * the choice, and owns the two abort paths (`[Cancel]` and `Esc`, §5.4).
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PendingPrompt } from '../../engine/types';
import { BOMB_PROMPT_TEXT } from '../../test/fixtures/duel';
import { PromptBar } from './PromptBar';

const prompt: PendingPrompt = {
  promptId: '0:rs_bomb:0',
  promptText: BOMB_PROMPT_TEXT,
  seat: 0,
  candidates: ['g1', 'g2', 'g3'],
  min: 1,
  max: 1,
};

const bar = (chosen: string[] = [], over: Partial<PendingPrompt> = {}) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  return {
    onConfirm,
    onCancel,
    user: userEvent.setup(),
    ...render(
      <PromptBar prompt={{ ...prompt, ...over }} chosen={chosen} onConfirm={onConfirm} onCancel={onCancel} />
    ),
  };
};

describe('<PromptBar>', () => {
  it('states the question, the seat, and how many legal targets there are', () => {
    bar();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(BOMB_PROMPT_TEXT);
    expect(status).toHaveTextContent('P1');
    expect(status).toHaveTextContent('3 legal targets');
  });

  it('refuses to confirm until the choice is within min and max', async () => {
    const { rerender, onConfirm, user } = bar([]);
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();

    rerender(<PromptBar prompt={prompt} chosen={['g1']} onConfirm={onConfirm} onCancel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('refuses to confirm when more than max are chosen', () => {
    bar(['g1', 'g2']);
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
  });

  it('shows a range when the prompt takes more than one card', () => {
    bar([], { min: 1, max: 3 });
    expect(screen.getByRole('status')).toHaveTextContent('1–3');
  });

  it('aborts on the button and on Escape — the same path (§5.4)', async () => {
    const { user, onCancel } = bar(['g1']);

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
