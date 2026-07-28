/**
 * Step 36 — the pending-action rail (§6.4). Builds `PendingAction` records by hand onto a real
 * `createPlayState(duel, ...)` — the engine doesn't yet produce a case where one action's `targets`
 * names another action's id (nothing in `TargetSelector` resolves to an action, only `ActionSelector`
 * does, and that's a different field), but §6.4 specifies the rendering rule for when it happens, so
 * the fixture below constructs that shape directly rather than waiting on an engine path to exist.
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPlayState } from '../../engine/setup';
import type { PendingAction, PlayState, TriggerContext } from '../../engine/types';
import { zoneKey } from '../../engine/valueRef';
import { duel, HAND, BATTLEFIELD, RS_STRIKE, RS_CANTRIP, STRIKE, GRUNT } from '../../test/fixtures/duel';
import { useUiStore } from '../../stores/uiStore';
import { ActionStackRail } from './ActionStackRail';

const SEED = '12345';

const ctx: TriggerContext = {
  triggeringCardId: null,
  zoneKey: null,
  triggeringSeat: 0,
  promptAnswers: {},
  sourceCardId: null,
};

function pendingAction(overrides: Partial<PendingAction>): PendingAction {
  return {
    id: 'a1',
    ruleId: RS_STRIKE,
    sourceCardId: null,
    controller: 0,
    ctx,
    targets: {},
    tags: [],
    countered: false,
    ...overrides,
  };
}

function baseState(): PlayState {
  return structuredClone(createPlayState(duel, SEED));
}

/** Strips a card out of wherever `createPlayState` dealt it and drops it in `toKey`. */
function moveCard(state: PlayState, cardId: string, toKey: string) {
  for (const key of Object.keys(state.zones)) {
    const idx = state.zones[key].cardIds.indexOf(cardId);
    if (idx !== -1) state.zones[key].cardIds.splice(idx, 1);
  }
  state.zones[toKey].cardIds.push(cardId);
}

const cardOfTemplate = (state: PlayState, templateId: string) =>
  Object.values(state.cards).find((c) => c.templateId === templateId)!.id;

beforeEach(() => {
  useUiStore.setState({ viewingSeat: 0, revealAll: false });
});

describe('<ActionStackRail>', () => {
  it('renders nothing when actionStack is empty', () => {
    const { container } = render(<ActionStackRail definition={duel} state={baseState()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders top-down in resolution order — last pushed is "resolves next"', () => {
    const state = baseState();
    state.pendingActions = {
      a1: pendingAction({ id: 'a1', ruleId: RS_STRIKE, controller: 0 }),
      a2: pendingAction({ id: 'a2', ruleId: RS_CANTRIP, controller: 1 }),
    };
    state.actionStack = ['a1', 'a2']; // a2 placed last -> resolves first

    const { container } = render(<ActionStackRail definition={duel} state={state} />);
    const rows = container.querySelectorAll('.cb-action-rail__row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-action-id', 'a2');
    expect(rows[0]).toHaveTextContent('resolves next');
    expect(rows[0]).toHaveTextContent('Cantrip');
    expect(rows[1]).toHaveAttribute('data-action-id', 'a1');
    expect(rows[1]).toHaveTextContent('①');
    expect(rows[1]).toHaveTextContent('Strike');
  });

  it('shows the controller seat and the source card marquee', () => {
    const state = baseState();
    const strikeCard = cardOfTemplate(state, STRIKE);
    state.pendingActions = { a1: pendingAction({ sourceCardId: strikeCard, controller: 1 }) };
    state.actionStack = ['a1'];

    render(<ActionStackRail definition={duel} state={state} />);
    expect(screen.getByText('P2')).toBeInTheDocument();
    // "Strike" is both the rule name (<span>, from `ruleId`) and the source card's marquee (<em>) —
    // both are asserted, distinguished by tag rather than an ambiguous `getByText`.
    expect(document.querySelector('.cb-action-rail__name')).toHaveTextContent('Strike');
    expect(document.querySelector('.cb-action-rail__head em')).toHaveTextContent('Strike');
  });

  describe('target redaction (reuses resolveVisibility)', () => {
    it('redacts a target hidden from the pinned seat, and reveal-all bypasses it', () => {
      // AC: SP12
      const state = baseState();
      const grunt = cardOfTemplate(state, GRUNT);
      moveCard(state, grunt, zoneKey(HAND, 1)); // seat 1's hand — ownerOnly, hidden from seat 0
      state.pendingActions = { a1: pendingAction({ targets: { '0': [grunt] } }) };
      state.actionStack = ['a1'];

      const { container, rerender } = render(<ActionStackRail definition={duel} state={state} />);
      expect(screen.getByText('a card')).toBeInTheDocument();
      expect(container.innerHTML).not.toContain('Grunt');

      act(() => useUiStore.setState({ revealAll: true }));
      rerender(<ActionStackRail definition={duel} state={state} />);
      expect(screen.getByText('Grunt')).toBeInTheDocument();
    });

    it('shows a target the pinned seat may see', () => {
      const state = baseState();
      const grunt = cardOfTemplate(state, GRUNT);
      moveCard(state, grunt, zoneKey(BATTLEFIELD, null)); // shared, faceUp
      state.pendingActions = { a1: pendingAction({ targets: { '0': [grunt] } }) };
      state.actionStack = ['a1'];

      render(<ActionStackRail definition={duel} state={state} />);
      expect(screen.getByText('Grunt')).toBeInTheDocument();
    });
  });

  it('a countered action stays visible, struck through, with the removed-without-applying wording', () => {
    // AC: MTG3 — component half; the log half is proved engine-side.
    const state = baseState();
    state.pendingActions = { a1: pendingAction({ countered: true }) };
    state.actionStack = ['a1'];

    const { container } = render(<ActionStackRail definition={duel} state={state} />);
    expect(container.querySelector('[data-action-id="a1"]')).toHaveAttribute('data-countered', 'true');
    expect(screen.getByText(/countered — removed without applying/)).toBeInTheDocument();
  });

  it('renders tags as chips', () => {
    const state = baseState();
    state.pendingActions = { a1: pendingAction({ tags: ['spell'] }) };
    state.actionStack = ['a1'];

    render(<ActionStackRail definition={duel} state={state} />);
    expect(screen.getByText('spell')).toHaveClass('cb-chip');
  });

  it('hovering a targeting note marks the referenced row data-targeted', async () => {
    const state = baseState();
    // a2 (placed last, resolves first / "resolves next") targets a1 (row ①) — the counterAction shape.
    state.pendingActions = {
      a1: pendingAction({ id: 'a1', ruleId: RS_STRIKE }),
      a2: pendingAction({ id: 'a2', ruleId: RS_CANTRIP, targets: { '0': ['a1'] } }),
    };
    state.actionStack = ['a1', 'a2'];

    const user = userEvent.setup();
    const { container } = render(<ActionStackRail definition={duel} state={state} />);

    const note = screen.getByText(/↑ targets/);
    expect(note).toHaveTextContent('↑ targets ①');

    const referenced = container.querySelector('[data-action-id="a1"]')!;
    expect(referenced).toHaveAttribute('data-targeted', 'false');

    await user.hover(note);
    expect(referenced).toHaveAttribute('data-targeted', 'true');

    await user.unhover(note);
    expect(referenced).toHaveAttribute('data-targeted', 'false');
  });
});
