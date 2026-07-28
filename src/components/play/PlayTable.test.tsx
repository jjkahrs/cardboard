/**
 * Steps 25 and 26 — the table (§6.4), its bands, prompt-mode targeting, and the click-to-place
 * half of drag and drop (§6.5). AC: R2 (component half), R3 and M4 (UI halves), plus §9.4 items 9
 * (hidden information) and 16 (React keys in unordered zones).
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { zoneKey } from '../../engine/valueRef';
import type { Id, PlayState } from '../../engine/types';
import {
  BATTLEFIELD,
  BOMB,
  CANTRIP,
  DECK,
  GRUNT,
  HAND,
  HP,
  MAIN,
  STRIKE,
  duel,
} from '../../test/fixtures/duel';
import { emptyBoard, place } from '../../test/board';
import { moveDestinations } from '../dnd/destinations';
import { PlayTable } from './PlayTable';

const BF = zoneKey(BATTLEFIELD, null);
const HAND_0 = zoneKey(HAND, 0);
const HAND_1 = zoneKey(HAND, 1);
const DECK_0 = zoneKey(DECK, 0);

/** What `PlayScreen` hands down once a card is picked up (§6.5). */
const held = (state: PlayState, cardId: Id) =>
  new Map(moveDestinations(duel, state, cardId).map((d) => [d.zoneKey, d]));

/** §9.3's board: three Grunts and a Strike on the Battlefield, a Bomb in seat 0's hand. */
function bombBoard(): PlayState {
  const state = emptyBoard(duel, MAIN);
  place(state, duel, BF, GRUNT, 'g1');
  place(state, duel, BF, STRIKE, 's1');
  place(state, duel, BF, GRUNT, 'g2');
  place(state, duel, BF, GRUNT, 'g3');
  place(state, duel, HAND_0, BOMB, 'b1');
  return state;
}

const table = (state: PlayState, over: Partial<Parameters<typeof PlayTable>[0]> = {}) => {
  const onCardClick = vi.fn();
  return {
    onCardClick,
    user: userEvent.setup(),
    ...render(
      <PlayTable
        definition={duel}
        state={state}
        viewingSeat={0}
        revealAll={false}
        onCardClick={onCardClick}
        {...over}
      />
    ),
  };
};

describe('the bands (§6.4)', () => {
  it('puts the viewing seat at the bottom and every other seat in the opponents band', () => {
    const { rerender } = table(bombBoard());

    expect(within(screen.getByLabelText('Opponents')).getByLabelText('Player 2')).toBeInTheDocument();
    expect(screen.getByLabelText(/your seat/i)).toHaveTextContent('Player 1');

    // Switching who "you" are is the same rule with a different seat — nothing special-cases it.
    rerender(
      <PlayTable definition={duel} state={bombBoard()} viewingSeat={1} revealAll={false} />
    );
    expect(within(screen.getByLabelText('Opponents')).getByLabelText('Player 1')).toBeInTheDocument();
    expect(screen.getByLabelText(/your seat/i)).toHaveTextContent('Player 2');
  });

  it('instances a player zone per seat and a shared zone once (AC: S1, UI half)', () => {
    table(bombBoard());
    expect(screen.getAllByLabelText(/^Hand \(seat \d\)$/)).toHaveLength(2);
    expect(screen.getAllByLabelText('Battlefield')).toHaveLength(1);
  });

  it('shows capacity as count/max, and marks a full zone in more than colour', () => {
    const state = emptyBoard(duel, MAIN);
    for (let i = 0; i < 7; i++) place(state, duel, HAND_0, GRUNT, `h${i}`);
    table(state);

    const hand = screen.getByLabelText('Hand (seat 1)');
    expect(within(hand).getByText('7/7')).toBeInTheDocument();
    expect(hand).toHaveAttribute('data-full', 'true');
  });
});

describe('hidden information (§9.4 item 9)', () => {
  it('keeps an opponent hand card out of the DOM entirely, not merely out of sight', () => {
    // Not "isn't visible" — a screenshot or a Ctrl-F during a playtest is all it takes.
    const state = bombBoard();
    place(state, duel, HAND_1, CANTRIP, 'x1');
    const { container } = table(state);

    expect(container.innerHTML).not.toContain('Cantrip');
    expect(within(screen.getByLabelText('Hand (seat 2)')).getByLabelText('Face-down card')).toBeInTheDocument();
  });

  it('reveals it once the tester asks for reveal-all', () => {
    const state = bombBoard();
    place(state, duel, HAND_1, CANTRIP, 'x1');
    const { container } = table(state, { revealAll: true });

    expect(container.innerHTML).toContain('Cantrip');
  });
});

describe('prompt mode (AC: R2, component half)', () => {
  it('marks exactly the legal targets, and nothing else on the table', () => {
    const state = bombBoard();
    const { container } = table(state, { legalTargets: new Set(['g1', 'g2', 'g3']) });

    const marked = container.querySelectorAll('[data-legal-target]');
    expect(marked).toHaveLength(3);
    // The Strike shares the Battlefield with them and is not a creature; the Bomb is in hand.
    for (const slot of marked) expect(slot).toHaveTextContent('Grunt');
  });

  it('lets a legal target be chosen, and leaves the rest inert', async () => {
    const state = bombBoard();
    const { user, onCardClick } = table(state, { legalTargets: new Set(['g1']) });

    const battlefield = screen.getByLabelText('Battlefield');
    await user.click(within(battlefield).getAllByRole('button')[0]);
    expect(onCardClick).toHaveBeenCalledWith('g1');

    // The Strike is not a candidate, so it is not even a button.
    expect(within(battlefield).getAllByRole('button')).toHaveLength(1);
  });

  it('marks nothing at all when no prompt is open', () => {
    const { container } = table(bombBoard());
    expect(container.querySelectorAll('[data-legal-target]')).toHaveLength(0);
  });
});

describe('click-to-place (§6.5)', () => {
  /** Renders the table with `g1` picked up. */
  const carrying = (state: PlayState, over: Partial<Parameters<typeof PlayTable>[0]> = {}) => {
    const onPlace = vi.fn();
    return {
      onPlace,
      ...table(state, {
        destinations: held(state, 'g1'),
        placing: true,
        heldCardId: 'g1',
        onPlace,
        ...over,
      }),
    };
  };

  it('numbers every zone the card can go to, and never the one it is already in', () => {
    carrying(bombBoard());

    // Deck×2, Hand×2, Discard×2 — the Battlefield holds it, so a move there is a no-op.
    // Sorted, because the badges appear in band order (opponents first) while the numbers are
    // assigned in definition order — the two orders are allowed to differ.
    const badges = screen.getAllByRole('button', { name: /^(Move here|Can’t move here)/ });
    expect(badges.map((b) => b.textContent).sort()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(within(screen.getByLabelText('Battlefield')).queryByRole('button', { name: /move here/i }))
      .toBeNull();
  });

  it('places the card, naming the top of a stack rather than appending to it', async () => {
    const { user, onPlace } = carrying(bombBoard());

    await user.click(screen.getByRole('button', { name: /move here: Deck \(seat 1\)/i }));
    expect(onPlace).toHaveBeenCalledWith(
      expect.objectContaining({ zoneKey: DECK_0, position: 'top' })
    );
  });

  it('refuses a full zone in the UI, saying which capacity refused it (AC: R3, UI half)', async () => {
    const state = bombBoard(); // the Bomb is already in seat 0's hand, so six more fill it
    for (let i = 0; i < 6; i++) place(state, duel, HAND_0, GRUNT, `h${i}`);
    const { user, onPlace } = carrying(state);

    const badge = within(screen.getByLabelText('Hand (seat 1)')).getByRole('button', {
      name: /can’t move here/i,
    });
    expect(badge).toBeDisabled();
    expect(badge).toHaveAttribute('data-drop', 'reject');
    expect(badge).toHaveAttribute('title', 'zone at capacity (7/7)');

    await user.click(badge);
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('re-opens that same zone when override is on (AC: M4, UI half)', async () => {
    const state = bombBoard();
    for (let i = 0; i < 6; i++) place(state, duel, HAND_0, GRUNT, `h${i}`);
    const { user, onPlace } = carrying(state, { override: true });

    const badge = within(screen.getByLabelText('Hand (seat 1)')).getByRole('button', {
      name: /move here/i,
    });
    expect(badge).toBeEnabled();
    expect(badge).toHaveAttribute('data-drop', 'override');

    await user.click(badge);
    expect(onPlace).toHaveBeenCalledWith(expect.objectContaining({ zoneKey: HAND_0 }));
  });

  it('marks the carried card, and shows no badges before anything is picked up', () => {
    const { container, rerender } = carrying(bombBoard());
    expect(container.querySelectorAll('[data-held]')).toHaveLength(1);
    expect(within(container.querySelector('[data-held]')!).getByText('Grunt')).toBeInTheDocument();

    rerender(<PlayTable definition={duel} state={bombBoard()} viewingSeat={0} revealAll={false} />);
    expect(screen.queryByRole('button', { name: /move here/i })).toBeNull();
  });

  it('makes every card pickable when no prompt is open, not only the legal targets', async () => {
    const { user, onCardClick } = table(bombBoard());

    // The mirror of the prompt-mode assertion above: with no prompt, the Strike is clickable too.
    const battlefield = screen.getByLabelText('Battlefield');
    await user.click(within(battlefield).getByText('Strike'));
    expect(onCardClick).toHaveBeenCalledWith('s1');
  });
});

describe('drop targets (§6.5)', () => {
  const gapIndices = (zoneLabel: string) =>
    [...screen.getByLabelText(zoneLabel).querySelectorAll('.cb-gap')].map(
      (g) => (g as HTMLElement).dataset.gapIndex
    );

  it('gives an ordered zone n+1 gaps and a stack exactly two — its top and bottom edges', () => {
    const state = bombBoard();
    for (let i = 0; i < 3; i++) place(state, duel, HAND_0, GRUNT, `h${i}`);
    for (let i = 0; i < 4; i++) place(state, duel, DECK_0, GRUNT, `d${i}`);
    table(state);

    // Hand is an ordered fan of 4 (the Bomb plus three Grunts): a gap before, between and after.
    expect(gapIndices('Hand (seat 1)')).toEqual(['0', '1', '2', '3', '4']);
    // A stack renders three cards but holds four, and gets two gaps regardless. A per-card gap
    // here would mint a second droppable with the bottom edge's id, which dnd-kit cannot resolve.
    expect(gapIndices('Deck (seat 1)')).toEqual(['0', '4']);
    expect(gapIndices('Deck (seat 2)')).toEqual(['0']); // empty pile: one gap, index 0
  });

  it('gives an unordered zone one droppable over the whole zone instead of gaps', () => {
    table(bombBoard());
    // The Battlefield is unordered, so there is no insert index to name.
    expect(gapIndices('Battlefield')).toEqual([]);
  });
});

describe('unordered zones and React keys (§9.4 item 16)', () => {
  it('keeps the rendered card order across an unrelated state change', () => {
    // If the renderer keyed by array index, an unrelated update would reconcile the wrong nodes and
    // the Battlefield would visibly reshuffle.
    const state = bombBoard();
    const { container, rerender } = table(state);
    const before = [...container.querySelectorAll('.cb-card-slot')].map((el) => el.textContent);

    const after = { ...state, playerPools: { ...state.playerPools, [HP]: [19, 20] } };
    rerender(<PlayTable definition={duel} state={after} viewingSeat={0} revealAll={false} />);

    expect([...container.querySelectorAll('.cb-card-slot')].map((el) => el.textContent)).toEqual(before);
  });
});

describe('seat bands at five seats (§6.3 amendment 1)', () => {
  /** `duel` is a fixed 2-seat definition; only the seat-band composition is under test here, so a
   * ring of 5 is synthesized on top of it rather than authoring a second fixture. */
  function fiveSeats(overrides: Partial<PlayState> = {}): PlayState {
    const state = emptyBoard(duel, MAIN);
    return { ...state, playerCount: 5, seatOrder: [0, 1, 2, 3, 4], eliminated: [], ...overrides };
  }

  const headingsIn = (label: string) =>
    within(screen.getByLabelText(label))
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);

  it('reads left-to-right as ring order from pinned+1 — prey through predator', () => {
    table(fiveSeats(), { viewingSeat: 2 });
    // Pinned at P3 (index 2): array-order-minus-self would read P1, P2, P4, P5, which disagrees
    // with `relative`/`next`/`previous` (§4.1) at exactly the table size where they matter.
    expect(headingsIn('Opponents')).toEqual(['Player 4', 'Player 5', 'Player 1', 'Player 2']); // AC: SP12
  });

  it('re-keys the ring when the pin moves, with no special-casing', () => {
    table(fiveSeats(), { viewingSeat: 0 });
    expect(headingsIn('Opponents')).toEqual(['Player 2', 'Player 3', 'Player 4', 'Player 5']);
  });
});

describe('eliminated seats (§6.3 amendment 3)', () => {
  it('render after the live ring, greyed via data-eliminated, and still show their zones', () => {
    const state = bombBoard();
    state.seatOrder = [0];
    state.eliminated = [1];
    table(state);

    const seat2 = screen.getByLabelText('Player 2');
    expect(seat2).toHaveAttribute('data-eliminated', 'true');
    // Elimination is not deletion (§5.12): the zone still renders under the normal visibility rule.
    expect(within(seat2).getByLabelText('Hand (seat 2)')).toBeInTheDocument(); // AC: SP12
  });

  it('are never a legal drop target', async () => {
    const state = bombBoard();
    state.seatOrder = [0];
    state.eliminated = [1];
    const onPlace = vi.fn();
    const { user } = table(state, {
      destinations: held(state, 'g1'),
      placing: true,
      heldCardId: 'g1',
      onPlace,
    });

    const badge = within(screen.getByLabelText('Hand (seat 2)')).getByRole('button', {
      name: /can’t move here/i,
    });
    expect(badge).toBeDisabled();
    expect(badge).toHaveAttribute('title', 'that seat has been eliminated'); // AC: SP12

    await user.click(badge);
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('stay pinned when the pinned seat is the one eliminated — the view never jumps', () => {
    const state = bombBoard();
    state.seatOrder = [1];
    state.eliminated = [0];
    table(state, { viewingSeat: 0 });

    const ownBand = screen.getByLabelText(/your seat/i);
    expect(ownBand).toHaveTextContent('Player 1');
    expect(ownBand.querySelector('.cb-seat')).toHaveAttribute('data-eliminated', 'true'); // AC: SP12
    // One seat, one band: the ousted pin does not also show up in the opponents band's tail.
    expect(within(screen.getByLabelText('Opponents')).queryByLabelText('Player 1')).toBeNull();
  });
});

describe('legalSeats (§6.6 — the chooseSeat highlight)', () => {
  it('puts data-legal-target on exactly the candidate seats', () => {
    const { container } = table(bombBoard(), { legalSeats: new Set([1]) });

    const marked = container.querySelectorAll('.cb-seat[data-legal-target]');
    expect(marked).toHaveLength(1);
    expect(within(marked[0] as HTMLElement).getByRole('heading')).toHaveTextContent('Player 2'); // AC: SP12
  });

  it('marks nothing when no chooseSeat interaction is open', () => {
    const { container } = table(bombBoard());
    expect(container.querySelectorAll('.cb-seat[data-legal-target]')).toHaveLength(0);
  });
});
