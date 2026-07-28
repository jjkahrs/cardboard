/**
 * Step 25 — the event log and its rewind control (§6.6). The rewind itself is the store's, proved
 * in `sessionStore.test.ts` (AC: H1); what is under test here is that the UI aims it at the right
 * entry and shows what will be lost BEFORE the click.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { LogEntry, LogLine } from '../../engine/types';
import { EventLogPanel } from './EventLogPanel';

const line = (over: Partial<LogLine> = {}): LogLine => ({
  level: 'info',
  kind: 'effect',
  message: 'HP changed',
  change: { path: 'playerPools.pool_hp.1', before: 20, after: 19 },
  ruleId: 'rs_strike',
  effectKind: 'changePool',
  depth: 1,
  visibility: null,
  ...over,
});

const entry = (seq: number, over: Partial<LogEntry> = {}): LogEntry => ({
  seq,
  cause: { kind: 'userAction', description: `Action ${seq}`, seat: null, visibility: null },
  lines: [line()],
  flags: {},
  ...over,
});

const panel = (log: LogEntry[]) => {
  const onRewind = vi.fn();
  return { onRewind, user: userEvent.setup(), ...render(<EventLogPanel log={log} onRewind={onRewind} />) };
};

describe('<EventLogPanel>', () => {
  it('says so when nothing has happened yet', () => {
    panel([]);
    expect(screen.getByText(/nothing has happened yet/i)).toBeInTheDocument();
  });

  it('shows each entry, its cause and the before → after of every change (AC: H2, UI half)', () => {
    panel([entry(0)]);
    const only = screen.getByLabelText('Entry 0');
    expect(only).toHaveTextContent('Action 0');
    expect(only).toHaveTextContent('20 → 19');
  });

  it('marks a rejection and an override differently from an ordinary line', () => {
    panel([
      entry(0, { lines: [line({ level: 'reject', kind: 'transition', message: 'no', change: null })] }),
      entry(1, { flags: { override: true }, lines: [line({ level: 'override', change: null })] }),
    ]);

    expect(screen.getByLabelText('Entry 0').querySelector('[data-level="reject"]')).not.toBeNull();
    expect(screen.getByLabelText('Entry 1').querySelector('[data-level="override"]')).not.toBeNull();
  });

  it('previews exactly what a rewind would discard while the pointer is on the control', async () => {
    const { user } = panel([entry(0), entry(1), entry(2)]);

    await user.hover(screen.getByRole('button', { name: 'Rewind to entry 1' }));

    // The hovered entry is itself discarded — rewind(1) keeps [0, 1).
    expect(screen.getByLabelText('Entry 0')).toHaveAttribute('data-doomed', 'false');
    expect(screen.getByLabelText('Entry 1')).toHaveAttribute('data-doomed', 'true');
    expect(screen.getByLabelText('Entry 2')).toHaveAttribute('data-doomed', 'true');

    await user.unhover(screen.getByRole('button', { name: 'Rewind to entry 1' }));
    expect(screen.getByLabelText('Entry 2')).toHaveAttribute('data-doomed', 'false');
  });

  it('asks inline before rewinding, and names how many entries go', async () => {
    const { user, onRewind } = panel([entry(0), entry(1), entry(2)]);

    await user.click(screen.getByRole('button', { name: 'Rewind to entry 1' }));
    expect(onRewind).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /discard 2 entries/i }));
    expect(onRewind).toHaveBeenCalledWith(1);
  });

  it('counts one entry as an entry', async () => {
    const { user } = panel([entry(0), entry(1)]);
    await user.click(screen.getByRole('button', { name: 'Rewind to entry 1' }));
    expect(screen.getByRole('button', { name: /discard 1 entry\?/i })).toBeInTheDocument();
  });

  it('leaves a marker so the history of rewinding is itself visible', async () => {
    const { user, rerender, onRewind } = panel([entry(0), entry(1), entry(2)]);

    await user.click(screen.getByRole('button', { name: 'Rewind to entry 1' }));
    await user.click(screen.getByRole('button', { name: /discard 2 entries/i }));
    // The store truncates; this component is handed the shorter log back.
    rerender(<EventLogPanel log={[entry(0)]} onRewind={onRewind} />);

    expect(screen.getByText(/rewound to 1/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Entry 1')).not.toBeInTheDocument();
  });

  it('lets the rewind control be reached and previewed from the keyboard', async () => {
    // Hover-only would put rewind — the most common action in a playtest — out of keyboard reach.
    const { user } = panel([entry(0), entry(1)]);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Rewind to entry 0' })).toHaveFocus();
    expect(screen.getByLabelText('Entry 1')).toHaveAttribute('data-doomed', 'true');
  });
});

describe('the glyph vocabulary (§6.6)', () => {
  it.each([
    ['event', 'info', '▸'],
    ['rule', 'info', '⤷'],
    ['effect', 'info', '·'],
    ['transition', 'info', '⟳'],
    ['change', 'reject', '✖'],
    ['change', 'override', '⚑'],
    ['change', 'warn', '⚠'],
  ] as const)('renders a %s line at level %s with %s', (kind, level, glyph) => {
    panel([entry(0, { lines: [line({ kind, level, change: null })] })]);
    expect(within(screen.getByLabelText('Entry 0')).getByText(glyph)).toBeInTheDocument();
  });
});
