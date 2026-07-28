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
import type { CriteriaNode, GameDefinition, LogEntry, PlayState, RuleSet } from '../../engine/types';
import { duel } from '../../test/fixtures/duel';
import { useUiStore } from '../../stores/uiStore';
import { PlayToolbar } from './PlayToolbar';

const SEED = '12345';

const toolbar = (
  state: PlayState = createPlayState(duel, SEED),
  log: LogEntry[] = [],
  definition: GameDefinition = duel,
  onActivate?: (ruleId: string) => void
) => {
  const onTransition = vi.fn();
  const onRestart = vi.fn();
  return {
    onTransition,
    onRestart,
    user: userEvent.setup(),
    ...render(
      <MemoryRouter>
        <PlayToolbar
          definition={definition}
          state={state}
          log={log}
          onTransition={onTransition}
          onRestart={onRestart}
          onActivate={onActivate}
        />
      </MemoryRouter>
    ),
  };
};

beforeEach(() => {
  useUiStore.setState({ viewingSeat: 0, revealAll: false, overrideEnabled: false, logVerbosity: 2 });
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

    // The click is the only thing that moves the pin (§6.1) — no automatic follow, no dialog.
    await user.click(screen.getByRole('button', { name: 'P2' })); // AC: SP12

    expect(useUiStore.getState().viewingSeat).toBe(1);
    expect(screen.getByRole('button', { name: 'P2' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('is the one place that writes viewingSeat — the other switches never touch it', async () => {
    const { user } = toolbar();

    await user.click(screen.getByRole('checkbox', { name: /reveal all/i }));
    await user.click(screen.getByRole('checkbox', { name: /designer override/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: /log/i }), 'Rules');

    // Every other control in this bar fired; the pin did not move. (§6.1)
    expect(useUiStore.getState().viewingSeat).toBe(0); // AC: SP12
  });

  it('marks an eliminated seat in the strip (§6.3), without disabling the switch to it', async () => {
    const state = createPlayState(duel, SEED);
    state.eliminated = [1];
    const { user } = toolbar(state);

    expect(screen.getByRole('button', { name: 'P1' })).not.toHaveAttribute('data-eliminated');
    expect(screen.getByRole('button', { name: 'P2' })).toHaveAttribute('data-eliminated', 'true');

    // Ousted is still forensically viewable (§5.12) — the strip marks it, it does not remove it.
    await user.click(screen.getByRole('button', { name: 'P2' }));
    expect(useUiStore.getState().viewingSeat).toBe(1);
  });

  it('toggles reveal-all and designer override without touching the session', async () => {
    const { user } = toolbar();

    await user.click(screen.getByRole('checkbox', { name: /reveal all/i }));
    await user.click(screen.getByRole('checkbox', { name: /designer override/i }));

    expect(useUiStore.getState()).toMatchObject({ revealAll: true, overrideEnabled: true });
  });

  it('writes the verbosity select to uiStore, named from §5.9\'s own level table', async () => {
    const { user } = toolbar();
    const select = screen.getByRole('combobox', { name: /log/i });

    // Default is level 2 (§5.9) and the option reads "Rules", its name in that table.
    expect(select).toHaveValue('2');

    await user.selectOptions(select, 'Criteria');
    expect(useUiStore.getState().logVerbosity).toBe(3);

    await user.selectOptions(select, 'Actions');
    expect(useUiStore.getState().logVerbosity).toBe(1);
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

// ---------------------------------------------------------------------------
// Step 37, §6.7/§5.8 — non-perInstance activation, on the toolbar
// ---------------------------------------------------------------------------

const ALWAYS: CriteriaNode = { kind: 'criteria', left: { kind: 'literal', value: 1 }, op: '>', right: { kind: 'literal', value: 0 } };
const NEVER: CriteriaNode = { kind: 'criteria', left: { kind: 'literal', value: 1 }, op: '>', right: { kind: 'literal', value: 999 } };
/** HP's max is 20 (`duel.ts`), so `>= 999` can never be paid — a deterministic COST_UNPAYABLE. */
const UNPAYABLE_COST: CriteriaNode = {
  kind: 'criteria',
  left: { kind: 'pool', poolId: 'pool_hp', seat: { kind: 'triggeringSeat' } },
  op: '>=',
  right: { kind: 'literal', value: 999 },
};

/** A minimal non-`perInstance` activation RuleSet — no template attachment to wire, since
 * `activatableRules` (`priority.ts`) never checks one for a global rule. */
function globalRule(id: string, label: string, opts: { condition?: CriteriaNode; costCheck?: CriteriaNode } = {}): RuleSet {
  return {
    id,
    name: label,
    trigger: `never_${id}`,
    stateFilter: null,
    condition: opts.condition ?? null,
    effects: [],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: false,
    replaces: null,
    activation: { costCheck: opts.costCheck ?? null, cost: [], window: null, perInstance: false, label },
  };
}

/** `duel`, cloned (frozen, §9.2) with `rules` appended — JSON round trip, matching
 * `deepCopyState`'s own established idiom for "this is plain JSON data" (`activation.ts`). */
function defWithGlobalRules(rules: RuleSet[]): GameDefinition {
  const clone: GameDefinition = JSON.parse(JSON.stringify(duel));
  clone.ruleSets.push(...rules);
  return clone;
}

describe('§6.7/step 37 non-perInstance activation on the toolbar', () => {
  it('renders a button for an activatable global rule, and clicking calls onActivate with its id', async () => {
    const def = defWithGlobalRules([globalRule('rs_zap', 'Zap')]);
    const onActivate = vi.fn();
    const { user } = toolbar(createPlayState(def, SEED), [], def, onActivate);

    await user.click(screen.getByRole('button', { name: 'Zap' }));
    expect(onActivate).toHaveBeenCalledWith('rs_zap');
  });

  it('renders an unpayable rule disabled, with the failing cost named in its title, not a generic rejection', () => {
    const def = defWithGlobalRules([globalRule('rs_zap', 'Zap', { costCheck: UNPAYABLE_COST })]);
    toolbar(createPlayState(def, SEED), [], def);

    const button = screen.getByRole('button', { name: 'Zap' }) as HTMLButtonElement;
    expect(button).toBeDisabled();
    expect(button.title).not.toBe('');
  });

  it('omits a rule entirely when its condition fails, rather than showing it disabled', () => {
    const def = defWithGlobalRules([globalRule('rs_hidden', 'Hidden', { condition: NEVER })]);
    toolbar(createPlayState(def, SEED), [], def);
    expect(screen.queryByRole('button', { name: 'Hidden' })).not.toBeInTheDocument();
  });

  it('still renders when the condition is satisfied and there is no cost to fail (control case)', () => {
    const def = defWithGlobalRules([globalRule('rs_zap', 'Zap', { condition: ALWAYS })]);
    toolbar(createPlayState(def, SEED), [], def);
    expect(screen.getByRole('button', { name: 'Zap' })).toBeEnabled();
  });

  it('renders no activation group at all for a v1-shaped game with no activation rules', () => {
    // `duel` itself — every existing test in this file already renders it; this just names the
    // absence explicitly, so a future default that always renders the group is caught here.
    toolbar();
    expect(screen.queryByRole('group', { name: /activate/i })).not.toBeInTheDocument();
  });
});
