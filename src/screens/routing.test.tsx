/**
 * Step 19 — the router, the game list and the authoring frame.
 *
 * These tests drive `routes` itself through a memory router rather than rendering each screen in
 * isolation: the route table is the artefact under test (a redirect that stops redirecting, a rail
 * link that points at nothing), and a screen rendered without its route proves none of that.
 */

import 'fake-indexeddb/auto';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameDefinition } from '../engine/types';
import { createEmptyDefinition, useDefinitionStore } from '../stores/definitionStore';
import { deleteGame, exportJson, getAllGames, getGame, putGame } from '../stores/persistence';
import { routes } from '../routes';
import { Rail } from './AuthoringLayout';
import { GAME_LEVEL, SURFACES, bucketErrors } from './surfaces';

const at = (path: string) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return { router, ...render(<RouterProvider router={router} />) };
};

const seed = async (over: Partial<GameDefinition> = {}): Promise<GameDefinition> => {
  const game = { ...createEmptyDefinition('g1', 'Duel of Wits', '2026-01-01T00:00:00.000Z'), ...over };
  await putGame(game);
  return game;
};

beforeEach(async () => {
  for (const game of await getAllGames()) await deleteGame(game.id);
  useDefinitionStore.getState().setDefinition(createEmptyDefinition('blank', 'blank', '2026-01-01T00:00:00.000Z'));
  localStorage.clear();
});

describe('the game list (/)', () => {
  it('says so when there are no games', async () => {
    at('/');
    expect(await screen.findByText(/no games yet/i)).toBeInTheDocument();
  });

  it('lists what is in IndexedDB', async () => {
    await seed({ id: 'g1', name: 'Duel of Wits' });
    await seed({ id: 'g2', name: 'Skirmish' });
    at('/');

    expect(await screen.findByRole('link', { name: 'Duel of Wits' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skirmish' })).toBeInTheDocument();
  });

  it('creates a game and opens it', async () => {
    const user = userEvent.setup();
    const { router } = at('/');
    await screen.findByText(/no games yet/i);

    await user.click(screen.getByRole('button', { name: /new game/i }));

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/game\/game_.+\/pools$/));
    expect(await getAllGames()).toHaveLength(1);
  });

  it('duplicates a game under a new id, leaving the original alone', async () => {
    await seed({ id: 'g1', name: 'Duel of Wits' });
    const user = userEvent.setup();
    at('/');

    await user.click(await screen.findByRole('button', { name: /duplicate/i }));

    await waitFor(async () => expect(await getAllGames()).toHaveLength(2));
    const games = await getAllGames();
    expect(games.map((g) => g.name).sort()).toEqual(['Duel of Wits', 'Duel of Wits copy']);
    expect(new Set(games.map((g) => g.id)).size).toBe(2);
  });

  it('asks before deleting, and deletes nothing until the second click', async () => {
    // Inline confirmation, not window.confirm: a modal dialog blocks the whole tab.
    await seed({ id: 'g1', name: 'Duel of Wits' });
    const user = userEvent.setup();
    at('/');

    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    expect(screen.getByText(/delete “Duel of Wits”\?/i)).toBeInTheDocument();
    expect(await getAllGames()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(await getAllGames()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await user.click(screen.getByRole('button', { name: /delete for good/i }));
    await waitFor(async () => expect(await getAllGames()).toHaveLength(0));
  });

  it('remembers which game was opened last', async () => {
    await seed({ id: 'g1', name: 'Duel of Wits' });
    const user = userEvent.setup();
    at('/');

    await user.click(await screen.findByRole('link', { name: 'Duel of Wits' }));
    expect(localStorage.getItem('cardboard:lastOpenedGameId')).toBe('g1');
  });
});

describe('import / export (step 24)', () => {
  /** Every download this describe triggered: the JSON that was handed to the blob, and the name. */
  let downloads: { name: string; text: string }[];

  beforeEach(() => {
    downloads = [];
    const blobs: Blob[] = [];
    // jsdom implements neither of these; a real anchor click would navigate nowhere either.
    URL.createObjectURL = vi.fn((blob: Blob) => `blob:${blobs.push(blob) - 1}`);
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      const blob = blobs[Number(this.href.replace('blob:', ''))];
      downloads.push({ name: this.download, text: '' });
      void blob.text().then((text) => {
        downloads[downloads.length - 1].text = text;
      });
    });
  });

  afterEach(() => vi.restoreAllMocks());

  const upload = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
    await user.upload(
      screen.getByLabelText(/import game/i),
      new File([text], 'game.json', { type: 'application/json' })
    );
  };

  // AC: IM1 — v3 changed this. Import used to stay on the list; it now opens what it imported, so
  // the assertion that this test made in v1 ("without leaving the game list") is the current bug.
  it('imports a valid file and opens it in the editor', async () => {
    const user = userEvent.setup();
    const { router } = at('/');
    await screen.findByText(/no games yet/i);

    await upload(user, exportJson(createEmptyDefinition('g9', 'Skirmish', '2026-01-01T00:00:00.000Z')));

    await waitFor(() => expect(router.state.location.pathname).toBe('/game/g9/pools'));
    // The rail, not the list: proof the definition actually loaded under that route.
    expect(await screen.findByRole('heading', { name: 'Skirmish' })).toBeInTheDocument();
    expect((await getAllGames()).map((g) => g.id)).toEqual(['g9']);
    expect(localStorage.getItem('cardboard:lastOpenedGameId')).toBe('g9');
  });

  it('rejects a malformed file naming the field, leaving stored games untouched (AC: P3)', async () => {
    const stored = await seed({ id: 'g1', name: 'Duel of Wits' });
    const user = userEvent.setup();
    at('/');
    await screen.findByRole('link', { name: 'Duel of Wits' });

    // Structurally valid JSON, one bad field — the gate-3 path, not the JSON.parse one.
    await upload(user, JSON.stringify({ ...stored, playerCount: 'two' }));

    expect(await screen.findByText(/playerCount:/)).toBeInTheDocument();
    expect(await getAllGames()).toEqual([stored]);
  });

  it('rejects a file that is not JSON at all', async () => {
    const user = userEvent.setup();
    at('/');
    await screen.findByText(/no games yet/i);

    await upload(user, 'not json{');

    expect(await screen.findByText(/File is not valid JSON/)).toBeInTheDocument();
    expect(await getAllGames()).toHaveLength(0);
  });

  // AC: IM2
  it('gives an imported game a new id rather than overwriting the game it collides with', async () => {
    const stored = await seed({ id: 'g1', name: 'Duel of Wits' });
    const user = userEvent.setup();
    const { router } = at('/');
    await screen.findByRole('link', { name: 'Duel of Wits' });

    await upload(user, exportJson({ ...stored, name: 'Duel of Wits, remixed' }));

    await waitFor(async () => expect(await getAllGames()).toHaveLength(2));
    const games = await getAllGames();
    // The game it collided with is byte-identical, and the import opened the copy, not the original.
    expect(games.find((g) => g.id === 'g1')).toEqual(stored);
    const minted = games.find((g) => g.id !== 'g1');
    expect(minted?.name).toBe('Duel of Wits, remixed');
    expect(router.state.location.pathname).toBe(`/game/${minted?.id ?? ''}/pools`);
  });

  it('exports a game from the list as canonical JSON under a filename from its name', async () => {
    const stored = await seed({ id: 'g1', name: 'Duel of Wits' });
    const user = userEvent.setup();
    at('/');

    await user.click(await screen.findByRole('button', { name: /export/i }));

    await waitFor(() => expect(downloads[0]?.text).toBe(exportJson(stored)));
    expect(downloads[0].name).toBe('duel-of-wits.json');
  });

  it('exports the game being edited from the rail', async () => {
    const stored = await seed({ id: 'g1', name: 'Duel of Wits' });
    const user = userEvent.setup();
    at('/game/g1/pools');

    await user.click(await screen.findByRole('button', { name: /export game/i }));

    await waitFor(() => expect(downloads[0]?.text).toBe(exportJson(stored)));
  });
});

describe('routing (§6.1)', () => {
  it('redirects /game/:id to its pools screen', async () => {
    await seed();
    const { router } = at('/game/g1');
    await waitFor(() => expect(router.state.location.pathname).toBe('/game/g1/pools'));
  });

  it('renders the not-found screen for an unknown path', () => {
    at('/nope');
    expect(screen.getByRole('heading', { name: /no such page/i })).toBeInTheDocument();
  });

  it('says so when the game id is not in this browser', async () => {
    at('/game/ghost/pools');
    expect(await screen.findByRole('heading', { name: /game not found/i })).toBeInTheDocument();
  });

  it('renders play outside the authoring frame, with no rail', async () => {
    await seed();
    at('/game/g1/play');
    // The play route opens on its seed panel; the table itself is `screens/play/play.test.tsx`.
    expect(await screen.findByRole('heading', { name: /^Play Duel of Wits$/ })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Authoring' })).not.toBeInTheDocument();
  });
});

describe('the authoring rail', () => {
  it('loads the game into the definition store', async () => {
    await seed({ id: 'g1', name: 'Duel of Wits' });
    at('/game/g1/pools');

    expect(await screen.findByRole('heading', { name: 'Duel of Wits' })).toBeInTheDocument();
    await waitFor(() => expect(useDefinitionStore.getState().definition.id).toBe('g1'));
  });

  it('links to every surface and carries a live count on each', async () => {
    await seed({
      id: 'g1',
      pools: [{ id: 'p1', scope: 'game', value: { type: 'integer', name: 'HP', defaultValue: 20, min: 0, max: null } }],
      zones: [
        { id: 'z1', name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', maxCapacity: null, ordered: true },
        { id: 'z2', name: 'Table', scope: 'shared', visibility: 'faceUp', layout: 'grid', maxCapacity: null, ordered: false },
      ],
    });
    at('/game/g1/pools');

    const rail = await screen.findByRole('navigation', { name: 'Authoring' });
    for (const surface of SURFACES) {
      expect(within(rail).getByRole('link', { name: new RegExp(surface.label) })).toBeInTheDocument();
    }
    expect(within(rail).getByRole('link', { name: /Pools/ })).toHaveTextContent('1');
    expect(within(rail).getByRole('link', { name: /Zones/ })).toHaveTextContent('2');
    expect(within(rail).getByRole('link', { name: /Cards/ })).toHaveTextContent('0');
  });

  it('marks the surface that owns a validation error, and only that one', () => {
    // The store REFUSES to hold an invalid definition, so the rail is driven directly here — this
    // is the badge's markup under test, not the store's gates.
    const definition = createEmptyDefinition('g1', 'Duel of Wits', '2026-01-01T00:00:00.000Z');
    render(
      <MemoryRouter>
        <Rail
          definition={definition}
          errors={{ zones: ['zones.1.name: Zone names must be unique; "Hand" is used more than once'] }}
        />
      </MemoryRouter>
    );

    const rail = screen.getByRole('navigation', { name: 'Authoring' });
    const zones = within(rail).getByRole('link', { name: /Zones/ });
    expect(zones.querySelector('.cb-badge')).toHaveClass('cb-badge--error');
    // The error is announced in words too — the count reads the same broken or not.
    expect(zones).toHaveTextContent(/1 problem/);
    expect(zones.querySelector('.cb-badge')).toHaveAttribute('title', expect.stringContaining('unique'));
    expect(
      within(rail).getByRole('link', { name: /Pools/ }).querySelector('.cb-badge')
    ).not.toHaveClass('cb-badge--error');
  });

  it('shows a game-level error above the surfaces, where no badge owns it', () => {
    render(
      <MemoryRouter>
        <Rail
          definition={createEmptyDefinition('g1', 'Duel of Wits', '2026-01-01T00:00:00.000Z')}
          errors={{ [GAME_LEVEL]: ['playerCount: Number must be greater than or equal to 1'] }}
        />
      </MemoryRouter>
    );
    expect(screen.getByRole('status')).toHaveTextContent(/playerCount/);
  });

  it('refuses to open a stored game that fails validation, leaving the store alone', async () => {
    // Only reachable by a hand-edited or foreign file, but silently showing the PREVIOUS game's
    // data under this game's name is the worst possible outcome.
    const hand = { name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', maxCapacity: null, ordered: true } as const;
    await seed({ id: 'g1', name: 'Broken', zones: [{ id: 'z1', ...hand }, { id: 'z2', ...hand }] });
    at('/game/g1/zones');

    expect(await screen.findByRole('heading', { name: /can’t be opened/i })).toBeInTheDocument();
    expect(screen.getByText(/Zone names must be unique/)).toBeInTheDocument();
    expect(useDefinitionStore.getState().definition.id).toBe('blank');
  });

  it('marks the current surface for the reader, not just visually', async () => {
    await seed();
    at('/game/g1/zones');
    const rail = await screen.findByRole('navigation', { name: 'Authoring' });
    expect(within(rail).getByRole('link', { name: /Zones/ })).toHaveAttribute('aria-current', 'page');
    expect(within(rail).getByRole('link', { name: /Pools/ })).not.toHaveAttribute('aria-current');
  });

  it('persists an edit made while the layout is mounted (AC: P1)', async () => {
    await seed({ id: 'g1', name: 'Duel of Wits' });
    const { unmount } = at('/game/g1/pools');
    await waitFor(() => expect(useDefinitionStore.getState().definition.id).toBe('g1'));

    act(() => void useDefinitionStore.getState().setName('Renamed'));
    // Let the layout re-render and schedule the save before leaving; unmount then flushes the
    // debounce rather than dropping it — leaving a screen must not lose an edit.
    await screen.findByRole('heading', { name: 'Renamed' });
    unmount();

    await waitFor(async () => expect((await getGame('g1'))?.name).toBe('Renamed'));
  });

  it('does not write the game straight back just for opening it', async () => {
    const game = await seed({ id: 'g1', name: 'Duel of Wits' });
    const { unmount } = at('/game/g1/pools');
    await waitFor(() => expect(useDefinitionStore.getState().definition.id).toBe('g1'));
    unmount();

    expect(await getGame('g1')).toEqual(game);
  });
});

describe('bucketErrors', () => {
  it('routes each error to the surface that owns it', () => {
    expect(
      bucketErrors([
        'zones.1.name: Zone names must be unique',
        'pools.0.value.min: min (5) must be less than or equal to max (1)',
        'templates.2.faceIcon: Required',
        'machine.states.0.name: Required',
        'ruleSets.0.effects.1: Required',
      ])
    ).toEqual({
      zones: ['zones.1.name: Zone names must be unique'],
      pools: ['pools.0.value.min: min (5) must be less than or equal to max (1)'],
      cards: ['templates.2.faceIcon: Required'],
      states: ['machine.states.0.name: Required'],
      rules: ['ruleSets.0.effects.1: Required'],
    });
  });

  it('keeps an error nobody claims rather than dropping it', () => {
    // An error on a badge nobody expects is recoverable; an invisible one is not.
    expect(bucketErrors(['playerCount: Number must be greater than or equal to 1'])).toEqual({
      [GAME_LEVEL]: ['playerCount: Number must be greater than or equal to 1'],
    });
  });

  it('handles a top-level message with no path at all', () => {
    expect(bucketErrors(['Expected object, received string'])[GAME_LEVEL]).toHaveLength(1);
  });
});
