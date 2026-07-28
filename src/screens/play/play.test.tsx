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
import { ACTIVE_PLAYER_POOL_ID } from '../../engine/types';
import { BATTLEFIELD, BOMB, DECK, GRUNT, HAND, duel } from '../../test/fixtures/duel';
import { UNCONTROLLED, VTES_LIBRARY, vtesish } from '../../test/fixtures/vtesish';
import { BOLT, LIFE, MTG_HAND, mtgish } from '../../test/fixtures/mtgish';
import { place } from '../../test/board';
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

/**
 * Step 40, part one — the SP12 gate, end to end from `PlayScreen` rather than from a component in
 * isolation. §6.1's criterion is met by three things together (nothing writes `viewingSeat` but the
 * switch, the view never follows the active seat, an interaction elsewhere gates rather than
 * answering in place) — each proven here as its own test rather than folded into one.
 */
describe('the pinned seat discloses nothing hidden (§6.1, §6.2, AC: SP12)', () => {
  it('leaks no hidden card id or name into the DOM, log included, when pinned to seat 2', async () => {
    // vtesish: 5 seats, Library visibility:'faceDown' — hidden from EVERY seat, even its own owner
    // (§6.1's table). Nothing has moved to a public zone yet, so the just-dealt Library IS the
    // entire card pool: a real end-to-end leak check, not a synthesized one.
    await putGame(vtesish);
    const { user, container } = at(`/game/${vtesish.id}/play`);
    await start(user);
    await user.click(screen.getByRole('button', { name: 'P3' })); // seat index 2
    expect(useUiStore.getState().viewingSeat).toBe(2);

    const cards = Object.values(session()!.state.cards);
    expect(cards.length).toBeGreaterThan(0); // sanity: the deck really did deal
    const marquees = new Set(vtesish.templates.map((t) => t.marquee));

    // The raw HTML, not queries — a `title`, an `aria-label`, or a stray `data-*` is exactly the
    // leak this criterion exists to catch, and only a raw-HTML assertion sees those.
    const html = container.innerHTML;
    // Word-boundary, not plain substring: ids are "c3"/"c31"/"c312"-shaped, and a plain `.toContain`
    // reports a false "c3 leaked" the moment "c31" is anywhere in the markup.
    for (const card of cards) expect(html).not.toMatch(new RegExp(`\\b${card.id}\\b`)); // AC: SP12
    for (const marquee of marquees) expect(html).not.toContain(marquee); // AC: SP12
  });

  it('does show a card once it turns public, so the check above is not vacuously true', async () => {
    await putGame(vtesish);
    const { user, container } = at(`/game/${vtesish.id}/play`);
    await start(user);
    await user.click(screen.getByRole('button', { name: 'P3' }));

    // Move one of seat 0's Library cards into Uncontrolled — visibility:'faceUp' — which must
    // reveal it regardless of who is pinned or who owns it.
    const cardId = session()!.state.zones[zoneKey(VTES_LIBRARY, 0)].cardIds[0];
    const marquee = vtesish.templates.find(
      (t) => t.id === session()!.state.cards[cardId].templateId
    )!.marquee;
    act(() =>
      useSessionStore.getState().dispatch(
        { kind: 'moveCard', cardId, to: { zoneId: UNCONTROLLED, seat: { kind: 'seat', index: 0 } }, position: 'top' },
        false
      )
    );

    expect(container.innerHTML).toContain(marquee);
  });

  it('does not follow the active seat when it changes', async () => {
    const { user } = at(`/game/${duel.id}/play`);
    await start(user);
    await user.click(screen.getByRole('button', { name: 'P2' }));
    expect(useUiStore.getState().viewingSeat).toBe(1);

    // Flip whose turn it is — the ONLY thing the toolbar's "Active" readout follows (§6.1 rule 2) —
    // nowhere near uiStore.
    act(() =>
      useSessionStore.setState((s) => {
        const sess = s.session!;
        const state = structuredClone(sess.state);
        state.pools[ACTIVE_PLAYER_POOL_ID] = 0;
        return { session: { ...sess, state } };
      })
    );

    expect(screen.getByText('Active').parentElement).toHaveTextContent('P1');
    // The view stayed on the seat that was explicitly pinned, not the one that just became active.
    expect(useUiStore.getState().viewingSeat).toBe(1); // AC: SP12
    expect(screen.getByLabelText(/your seat/i)).toHaveTextContent('Player 2');
  });

  it('does not move on rewind either', async () => {
    const { user } = at(`/game/${duel.id}/play`);
    await start(user);
    await user.click(screen.getByRole('button', { name: 'P2' }));

    // A second entry, built entirely through the UI, then discarded through the real rewind control.
    const deck = screen.getByLabelText('Deck (seat 1)');
    await user.click(within(deck).getAllByRole('button')[0]);
    await user.click(await screen.findByRole('button', { name: /move here: Hand \(seat 1\)/i }));
    expect(session()!.log).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Rewind to entry 1' }));
    await user.click(screen.getByRole('button', { name: /discard 1 entry/i }));
    expect(session()!.log).toHaveLength(1);

    expect(useUiStore.getState().viewingSeat).toBe(1); // AC: SP12
  });

  it('gates an interaction raised for another seat instead of answering it in place', async () => {
    const { user } = at(`/game/${duel.id}/play`);
    await start(user);

    // Seed a board where seat 0 can play a Bomb at a Grunt — bombRule's `chooseCards` prompt —
    // directly into the running session, the same technique the click-to-place tests above use.
    act(() =>
      useSessionStore.setState((s) => {
        const sess = s.session!;
        const state = structuredClone(sess.state);
        place(state, duel, zoneKey(HAND, 0), BOMB, 'bomb1');
        place(state, duel, zoneKey(BATTLEFIELD, null), GRUNT, 'grunt1');
        return { session: { ...sess, state } };
      })
    );

    // Pinned to seat 1 BEFORE the prompt exists — the interaction is raised for seat 0 and must not
    // answer in place for a viewer who was never asked.
    await user.click(screen.getByRole('button', { name: 'P2' }));

    act(() =>
      useSessionStore.getState().dispatch(
        { kind: 'moveCard', cardId: 'bomb1', to: { zoneId: BATTLEFIELD, seat: null }, position: 'bottom' },
        false
      )
    );
    expect(session()!.state.interaction).toMatchObject({ kind: 'chooseCards', seat: 0 });

    // The gate: names the seat that must answer, offers the explicit switch, and the real answer
    // surface (PromptBar's Confirm) is not rendered — don't reach into InteractionBar beyond that.
    expect(screen.getByText(/P1 must answer/i)).toBeInTheDocument(); // AC: SP12
    expect(screen.getByRole('button', { name: 'View as P1' })).toBeInTheDocument(); // AC: SP12
    expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull(); // AC: SP12
  });
});

/**
 * Step 40, part two — MTG4/MTG5's priority-round log criteria, proved against `mtgish` (the
 * fixture §9.1 writes them for: one counterspell, one instant, the stack window) through the real
 * route rather than only `priority.test.ts`'s bare `step()` driver. Casting Bolt is `moveCard` from
 * Hand straight to Graveyard — `boltRule`'s own doc comment: mtgish has no visual "stack" zone, so
 * the physical card is already discarded by the time `onCardPlayed` announces the resolve.
 */
describe('the priority round in the rendered log (§5.5, AC: MTG4, AC: MTG5)', () => {
  /** Casts `cardId` from seat 0's hand by clicking it, then the Graveyard (seat 0) destination
   * badge — same click-to-place path the duel tests above already exercise. */
  async function castBolt(user: ReturnType<typeof userEvent.setup>, cardId: string) {
    const hand = screen.getByLabelText('Hand (seat 1)');
    await user.click(within(hand).getAllByRole('button')[0]);
    await user.click(await screen.findByRole('button', { name: /move here: graveyard \(seat 1\)/i }));
    return cardId;
  }

  it('MTG4 — nobody anywhere has a legal response: the round collapses, no per-seat log entry', async () => {
    await putGame(mtgish);
    const { user, container } = at(`/game/${mtgish.id}/play`);
    await start(user);

    // Strip the whole deal (both seats' Counter Magic copies included — `activatableRules` has no
    // ownership check, §8 step 24's own comment: "NOT ownership", so ANY Counter Magic anywhere on
    // the board, not just the acting seat's, would make this a legal-response round instead) and
    // place a lone Bolt in seat 0's hand — the same seeding technique the click-to-place tests above
    // use, just clearing first.
    act(() =>
      useSessionStore.setState((s) => {
        const sess = s.session!;
        const state = structuredClone(sess.state);
        state.cards = {};
        for (const key of Object.keys(state.zones)) state.zones[key].cardIds = [];
        return { session: { ...sess, state } };
      })
    );
    const cardId = 'bolt1';
    act(() =>
      useSessionStore.setState((s) => {
        const sess = s.session!;
        const state = structuredClone(sess.state);
        place(state, mtgish, zoneKey(MTG_HAND, 0), BOLT, cardId);
        return { session: { ...sess, state } };
      })
    );

    const entriesBefore = session()!.log.length;
    await castBolt(user, cardId);

    // The whole round collapsed inside the ONE dispatch the click made — exactly one new entry, not
    // one per seat's silent auto-pass. A broken collapse (each seat suspending on its own empty
    // offer) would show up here as more than one new entry, so this fails if the collapse breaks.
    expect(session()!.log).toHaveLength(entriesBefore + 1);
    expect(session()!.state.interaction).toBeNull();
    expect(session()!.state.playerPools[LIFE][1]).toBe(17); // Bolt's effect ran: 20 - 3

    const entry = screen.getByLabelText(`Entry ${entriesBefore}`);
    expect(entry).not.toHaveTextContent(/offered priority|passes priority/i); // AC: MTG4
    // No priority bar was ever mounted — the DOM never had a legal-response offer to answer.
    expect(container.innerHTML).not.toMatch(/priority.{0,20}you may respond/i); // AC: MTG4
  });

  it('MTG5 — a seat that can respond passes anyway: its own log entry and rewind point', async () => {
    await putGame(mtgish);
    const { user } = at(`/game/${mtgish.id}/play`);
    await start(user);

    // Only ADDS a Bolt to seat 0's hand — the default deal already left each seat's Library holding
    // 2 Counter Magic copies, which is enough for `activatableRules` to offer a legal response.
    const cardId = 'bolt1';
    act(() =>
      useSessionStore.setState((s) => {
        const sess = s.session!;
        const state = structuredClone(sess.state);
        place(state, mtgish, zoneKey(MTG_HAND, 0), BOLT, cardId);
        return { session: { ...sess, state } };
      })
    );

    const entriesBefore = session()!.log.length;
    await castBolt(user, cardId);
    // Seat 0 (active, offered first) has a legal response and is suspended on it — the announce is
    // its own entry, flagged suspended, not yet MTG5's own criterion.
    expect(session()!.state.interaction).toMatchObject({ kind: 'priority', seat: 0 });
    expect(session()!.log).toHaveLength(entriesBefore + 1);

    // The real button, not a direct dispatch — this is the half of MTG5 that must hold through the UI.
    await user.click(screen.getByRole('button', { name: /^pass$/i }));

    // Its own entry (a second, separate dispatch — every top-level dispatch is one LogEntry) …
    expect(session()!.log).toHaveLength(entriesBefore + 2);
    const passSeq = entriesBefore + 1;
    const passEntry = screen.getByLabelText(`Entry ${passSeq}`); // AC: MTG5
    expect(passEntry).toHaveTextContent('Pass priority');
    // … and its own rewind point — the same control every other entry gets, targeting this seq.
    expect(screen.getByRole('button', { name: `Rewind to entry ${passSeq}` })).toBeInTheDocument(); // AC: MTG5
  });
});
