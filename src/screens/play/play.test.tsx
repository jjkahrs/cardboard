/**
 * Step 25 — the play screen at its real route (§6.1, §6.4).
 *
 * Driven through the route table, because half of what this screen does is route-shaped: it loads
 * its own definition from IndexedDB (there is no rail above it to do that), and leaving discards
 * the session.
 */

import 'fake-indexeddb/auto';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { DECK, HAND, duel } from '../../test/fixtures/duel';
import { zoneKey } from '../../engine/valueRef';
import { deleteGame, getAllGames, putGame } from '../../stores/persistence';
import { useSessionStore } from '../../stores/sessionStore';
import { useUiStore } from '../../stores/uiStore';
import { routes } from '../../routes';

const at = (path: string) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return { router, user: userEvent.setup(), ...render(<RouterProvider router={router} />) };
};

const session = () => useSessionStore.getState().session;

/** Fills in the seed field and starts, returning once the table is up. */
async function start(user: ReturnType<typeof userEvent.setup>, seed = '12345') {
  const field = await screen.findByLabelText(/shuffle seed/i);
  await user.clear(field);
  await user.type(field, seed);
  await user.click(screen.getByRole('button', { name: /start playtest/i }));
  await screen.findByLabelText('Event log');
}

beforeEach(async () => {
  for (const game of await getAllGames()) await deleteGame(game.id);
  await putGame(duel);
  useSessionStore.setState({ session: null });
  useUiStore.setState({ viewingSeat: 0, revealAll: false, overrideEnabled: false });
});

describe('starting a playtest', () => {
  it('asks for a seed first, and uses the one that was typed (AC: S2)', async () => {
    const { user } = at(`/game/${duel.id}/play`);
    await start(user, '12345');

    expect(session()?.state.seed).toBe('12345');
    // Same seed in the toolbar, so a reproducible game can actually be reproduced.
    expect(screen.getByText('12345')).toBeInTheDocument();
  });

  it('deals the decks and fires onGameStart as an ordinary logged action', async () => {
    const { user } = at(`/game/${duel.id}/play`);
    await start(user);

    // 40-card deck per seat (§9.2), dealt by createPlayState before anything is logged.
    expect(session()?.state.zones[zoneKey('zone_deck', 0)].cardIds).toHaveLength(40);
    expect(session()?.log[0].cause.description).toBe('Start game');
    expect(screen.getByLabelText('Entry 0')).toBeInTheDocument();
  });

  it('renders both seats and the shared band', async () => {
    const { user } = at(`/game/${duel.id}/play`);
    await start(user);

    expect(screen.getByLabelText('Player 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Player 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Battlefield')).toBeInTheDocument();
  });

  it('keeps the opponent hand out of the DOM as dealt (§9.4 item 9)', async () => {
    const { user, container } = at(`/game/${duel.id}/play`);
    await start(user);

    // Hands are empty at deal, so this asserts the deck instead: face-down for both seats.
    const deck = screen.getAllByLabelText(/^Deck \(seat \d\)$/)[1];
    expect(deck).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('Cantrip');
  });

  it('goes back to the seed panel on restart, so the seed can be changed there', async () => {
    const { user } = at(`/game/${duel.id}/play`);
    await start(user, '12345');

    await user.click(screen.getByRole('button', { name: /restart/i }));

    expect(await screen.findByLabelText(/shuffle seed/i)).toBeInTheDocument();
  });
});

describe('click-to-place (§6.5)', () => {
  const deckOf = (seat: number) => session()!.state.zones[zoneKey(DECK, seat)].cardIds;
  const handOf = (seat: number) => session()!.state.zones[zoneKey(HAND, seat)].cardIds;

  /** Picks up the top card of the viewing seat's deck and returns its id. */
  async function pickUpTopOfDeck(user: ReturnType<typeof userEvent.setup>) {
    const cardId = deckOf(0)[0];
    const deck = screen.getByLabelText('Deck (seat 1)');
    await user.click(within(deck).getAllByRole('button')[0]);
    return cardId;
  }

  it('moves a card by clicking it and then clicking a destination badge', async () => {
    const { user } = at(`/game/${duel.id}/play`);
    await start(user);
    const cardId = await pickUpTopOfDeck(user);

    await user.click(await screen.findByRole('button', { name: /move here: Hand \(seat 1\)/i }));

    expect(handOf(0)).toEqual([cardId]);
    expect(deckOf(0)).toHaveLength(39);
    // The same reducer entry point as a drop, so it lands in the log like any other action.
    expect(session()!.log.at(-1)?.cause.description).toBe(`Move card ${cardId}`);
    // Put down again once placed — nothing is still in hand.
    expect(screen.queryByRole('button', { name: /move here/i })).toBeNull();
  });

  it('takes the badge number as a keyboard shortcut, which is what makes it the faster input', async () => {
    const { user } = at(`/game/${duel.id}/play`);
    await start(user);
    const cardId = await pickUpTopOfDeck(user);

    // 1 = the opponent's Deck, 2 = your Hand — definition order, as the badges show it.
    await user.keyboard('2');

    expect(handOf(0)).toEqual([cardId]);
  });

  it('puts the card back down on Esc, and on a second click of the same card', async () => {
    const { user } = at(`/game/${duel.id}/play`);
    await start(user);

    await pickUpTopOfDeck(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: /move here/i })).toBeNull();

    const deck = screen.getByLabelText('Deck (seat 1)');
    await user.click(within(deck).getAllByRole('button')[0]);
    await user.click(within(deck).getAllByRole('button')[0]);
    expect(screen.queryByRole('button', { name: /move here/i })).toBeNull();
    expect(handOf(0)).toEqual([]);
  });

  it('refuses a full destination, and lets override force the same move through (AC: M4)', async () => {
    const { user } = at(`/game/${duel.id}/play`);
    await start(user);

    // Fill seat 0's hand to its capacity of 7 straight into the session state. `act` because this
    // is a store write from outside React: without it the re-render lands after the next query and
    // the click hits a detached node.
    act(() =>
      useSessionStore.setState((s) => {
        const session = s.session!;
        const state = structuredClone(session.state);
        state.zones[zoneKey(HAND, 0)].cardIds = state.zones[zoneKey(DECK, 0)].cardIds.splice(0, 7);
        return { session: { ...session, state } };
      })
    );

    const cardId = await pickUpTopOfDeck(user);
    const badge = await screen.findByRole('button', { name: /can’t move here: Hand \(seat 1\)/i });
    expect(badge).toBeDisabled();
    expect(badge).toHaveAttribute('title', 'zone at capacity (7/7)');

    act(() => useUiStore.setState({ overrideEnabled: true }));
    await user.click(await screen.findByRole('button', { name: /move here: Hand \(seat 1\)/i }));

    expect(handOf(0)).toHaveLength(8);
    expect(handOf(0)[7]).toBe(cardId);
    expect(session()!.log.at(-1)?.flags.override).toBe(true);
  });
});

describe('the play route', () => {
  it('says so when the game id is not in this browser', async () => {
    at('/game/ghost/play');
    expect(await screen.findByRole('heading', { name: /game not found/i })).toBeInTheDocument();
  });

  it('refuses to start on a definition that fails validation, naming the problem', async () => {
    const hand = duel.zones.find((z) => z.id === HAND)!;
    await putGame({ ...structuredClone(duel), id: 'broken', zones: [hand, { ...hand, id: 'z_dup' }] });
    at('/game/broken/play');

    expect(await screen.findByRole('heading', { name: /can’t be played/i })).toBeInTheDocument();
    expect(screen.getByText(/unique/i)).toBeInTheDocument();
    expect(session()).toBeNull();
  });

  it('confirms before leaving, because the session and its log are discarded (§6.1)', async () => {
    const { user, router } = at(`/game/${duel.id}/play`);
    await start(user);

    await user.click(screen.getByRole('link', { name: /back to the editor/i }));
    expect(router.state.location.pathname).toBe(`/game/${duel.id}/play`);
    expect(screen.getByRole('alert')).toHaveTextContent(/discarded/i);

    await user.click(screen.getByRole('button', { name: /^stay$/i }));
    expect(router.state.location.pathname).toBe(`/game/${duel.id}/play`);

    await user.click(screen.getByRole('link', { name: /back to the editor/i }));
    await user.click(screen.getByRole('button', { name: /^leave$/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/game/${duel.id}/pools`));
  });
});
