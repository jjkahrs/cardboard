/**
 * Step 25 — the event log and its rewind control (§6.6). The rewind itself is the store's, proved
 * in `sessionStore.test.ts` (AC: H1); what is under test here is that the UI aims it at the right
 * entry and shows what will be lost BEFORE the click.
 */

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry, LogLine } from '../../engine/types';
import { useUiStore } from '../../stores/uiStore';
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

// The panel reads `viewingSeat`/`revealAll` straight from `uiStore` (the `PlayToolbar` precedent),
// so every test starts from the same pinned seat rather than inheriting whatever an earlier test
// left behind.
beforeEach(() => {
  useUiStore.setState({ viewingSeat: 0, revealAll: false });
});

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

describe('§6.2 log redaction', () => {
  const SECRET = 'Ambush Viper';

  it('redacts a line hidden from the pinned seat, and the secret touches no attribute either', () => {
    useUiStore.setState({ viewingSeat: 2 });
    const { container } = panel([
      entry(0, {
        lines: [line({ message: `${SECRET} enters the battlefield`, change: { path: 'x', before: 0, after: 1 }, visibility: [1] })],
      }),
    ]);

    expect(screen.getByLabelText('Entry 0')).toHaveTextContent('hidden from you');
    // Raw HTML, not just the accessible text — this is what would also catch a `title` or `data-*` leak.
    expect(container.innerHTML).not.toContain(SECRET); // AC: SP12
  });

  it("keeps a redacted line's slot: same count, level, kind, and glyph as an unredacted one (§6.2)", () => {
    useUiStore.setState({ viewingSeat: 2 });
    panel([
      entry(0, {
        lines: [
          line({ message: 'public one', visibility: null }),
          line({ message: SECRET, level: 'warn', kind: 'rule', visibility: [1] }),
        ],
      }),
    ]);

    const lines = screen.getByLabelText('Entry 0').querySelectorAll('.cb-log__line');
    expect(lines).toHaveLength(2); // slot survives — rewind indices must not shift per seat
    expect(lines[1]).toHaveAttribute('data-redacted', 'true');
    expect(lines[1]).toHaveAttribute('data-level', 'warn');
    expect(lines[1]).toHaveAttribute('data-kind', 'rule');
    expect(within(lines[1] as HTMLElement).getByText('⚠')).toBeInTheDocument(); // glyph still rendered
  });

  it('un-redacts live when reveal-all flips, with no remount of the panel', () => {
    const { container } = panel([entry(0, { lines: [line({ message: SECRET, visibility: [1] })] })]);
    // Pinned to the default seat 0 — the line is hidden to start.
    expect(container.innerHTML).not.toContain(SECRET);

    act(() => useUiStore.setState({ revealAll: true }));

    expect(screen.getByLabelText('Entry 0')).toHaveTextContent(SECRET);
  });

  it('treats visibility: null as public for every seat', () => {
    useUiStore.setState({ viewingSeat: 3 });
    panel([entry(0, { lines: [line({ message: 'nothing to hide here', visibility: null })] })]);
    expect(screen.getByLabelText('Entry 0')).toHaveTextContent('nothing to hide here');
  });

  it('redacts a cause to its seat, not its description — "P3 acted"', () => {
    const { container } = panel([
      entry(0, { cause: { kind: 'userAction', description: `Play ${SECRET}`, seat: 2, visibility: [2] } }),
    ]);

    expect(screen.getByLabelText('Entry 0')).toHaveTextContent('P3 acted');
    expect(container.innerHTML).not.toContain(SECRET); // AC: SP12
  });

  it('rewinds to the right seq with a redacted line in the way', async () => {
    useUiStore.setState({ viewingSeat: 2 });
    const { user, onRewind } = panel([
      entry(0, { lines: [line({ message: SECRET, visibility: [1] })] }),
      entry(1),
      entry(2),
    ]);

    await user.click(screen.getByRole('button', { name: 'Rewind to entry 1' }));
    await user.click(screen.getByRole('button', { name: /discard 2 entries/i }));
    expect(onRewind).toHaveBeenCalledWith(1); // AC: SP12
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
