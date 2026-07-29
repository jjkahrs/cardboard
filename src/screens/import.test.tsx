/**
 * v3 — importing an exported game into the editor.
 *
 * The list-side rows (IM1, IM2) live in `routing.test.tsx` beside the import/export block they
 * amend. Everything here is the editor side and the drop layer: replace-in-place, its confirm, and
 * the guarantee that a dropped file never navigates the tab away from the app.
 *
 * Drops are `fireEvent` with a plain object for `dataTransfer` — jsdom implements no `DataTransfer`
 * constructor, and `user-event` v14 has no file-drop API. The hook reads only `types` and `files`,
 * so the stand-in is the whole contract.
 */

import 'fake-indexeddb/auto';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { GameDefinition } from '../engine/types';
import { createEmptyDefinition, useDefinitionStore } from '../stores/definitionStore';
import { deleteGame, exportJson, getAllGames, getGame, putGame } from '../stores/persistence';
import { routes } from '../routes';
import { readDefinitionFile } from './gameFile';

const at = (path: string) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return { router, ...render(<RouterProvider router={router} />) };
};

const seed = async (over: Partial<GameDefinition> = {}): Promise<GameDefinition> => {
  const game = { ...createEmptyDefinition('g1', 'Duel of Wits', '2026-01-01T00:00:00.000Z'), ...over };
  await putGame(game);
  return game;
};

/** A valid export of some OTHER game, as a file. */
const incoming = (over: Partial<GameDefinition> = {}, name = 'skirmish.json'): File => {
  const text = exportJson({
    ...createEmptyDefinition('g9', 'Skirmish', '2026-02-02T00:00:00.000Z'),
    ...over,
  });
  return new File([text], name, { type: 'application/json' });
};

const definition = (): GameDefinition => useDefinitionStore.getState().definition;

/** Opens the editor and waits for the layout's load to land. */
const openEditor = async (path = '/game/g1/pools') => {
  const handle = at(path);
  await waitFor(() => expect(definition().id).toBe('g1'));
  return handle;
};

const pick = async (user: ReturnType<typeof userEvent.setup>, file: File) => {
  await user.upload(screen.getByLabelText(/replace from file/i), file);
};

/** Fires a real drop and hands back the event, so `defaultPrevented` can be asserted. */
const drop = (files: File[]) => {
  const event = createEvent.drop(document.body, {
    dataTransfer: { types: ['Files'], files },
  });
  fireEvent(document.body, event);
  return event;
};

const dragEnter = () =>
  fireEvent.dragEnter(document.body, { dataTransfer: { types: ['Files'], files: [] } });
const dragLeave = () =>
  fireEvent.dragLeave(document.body, { dataTransfer: { types: ['Files'], files: [] } });

beforeEach(async () => {
  for (const game of await getAllGames()) await deleteGame(game.id);
  useDefinitionStore
    .getState()
    .setDefinition(createEmptyDefinition('blank', 'blank', '2026-01-01T00:00:00.000Z'));
  localStorage.clear();
});

describe('readDefinitionFile (v3 §4.1)', () => {
  it('runs a file through the same four gates as the game list', async () => {
    const result = await readDefinitionFile(incoming());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.name).toBe('Skirmish');
  });

  it('reports a file that is not JSON rather than throwing', async () => {
    const result = await readDefinitionFile(new File(['not json{'], 'x.json'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/not valid JSON/);
  });
});

describe('replacing the open game with a file (v3 §4.5)', () => {
  // AC: IM3
  it('overwrites the open game in place, keeping its id, its route and its list slot', async () => {
    await seed({ id: 'g1', name: 'Duel of Wits' });
    const user = userEvent.setup();
    const { router } = await openEditor();

    await pick(user, incoming());
    await user.click(await screen.findByRole('button', { name: /replace for good/i }));

    await waitFor(async () => expect((await getGame('g1'))?.name).toBe('Skirmish'));
    const stored = await getGame('g1');
    expect(stored?.id).toBe('g1');
    // The file's own id is discarded — g9 never becomes a game of its own.
    expect((await getAllGames()).map((g) => g.id)).toEqual(['g1']);
    expect(router.state.location.pathname).toBe('/game/g1/pools');
    expect(await screen.findByRole('heading', { name: 'Skirmish' })).toBeInTheDocument();
  });

  // AC: IM4
  it('takes two clicks, names both file and game, and writes nothing if cancelled', async () => {
    const original = await seed({ id: 'g1', name: 'Duel of Wits' });
    const user = userEvent.setup();
    await openEditor();
    const before = definition();

    await pick(user, incoming({}, 'skirmish.json'));

    const confirm = await screen.findByRole('status');
    expect(confirm).toHaveTextContent(/Duel of Wits/);
    expect(confirm).toHaveTextContent(/skirmish\.json/);
    // Nothing written on the first click.
    expect(await getGame('g1')).toEqual(original);

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(await getGame('g1')).toEqual(original);
    // Referentially identical, not merely equal: a rejected/cancelled edit must not re-render the
    // whole authoring tree.
    expect(definition()).toBe(before);
    expect(screen.queryByRole('button', { name: /replace for good/i })).not.toBeInTheDocument();
  });

  // AC: IM5
  it('rejects a malformed file, leaving the open game and IndexedDB untouched', async () => {
    const original = await seed({ id: 'g1', name: 'Duel of Wits' });
    const user = userEvent.setup();
    await openEditor();
    const before = definition();

    await pick(user, new File([JSON.stringify({ ...original, playerCount: 'two' })], 'bad.json'));

    expect(await screen.findByText(/playerCount:/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /replace for good/i })).not.toBeInTheDocument();
    expect(await getGame('g1')).toEqual(original);
    expect(definition()).toBe(before);
  });

  // AC: IM8
  it('rejects a file from another schema version, naming both versions', async () => {
    const original = await seed({ id: 'g1', name: 'Duel of Wits' });
    const user = userEvent.setup();
    await openEditor();

    await pick(user, new File([JSON.stringify({ ...original, schemaVersion: 1 })], 'old.json'));

    expect(await screen.findByText(/Unsupported schema version 1.*reads version 2/)).toBeInTheDocument();
    expect(await getGame('g1')).toEqual(original);
  });

  // AC: IM9
  it('stamps the replace with its own updatedAt rather than inheriting the file’s', async () => {
    await seed({ id: 'g1', name: 'Duel of Wits' });
    const user = userEvent.setup();
    await openEditor();

    await pick(user, incoming({ updatedAt: '2020-01-01T00:00:00.000Z' }));
    await user.click(await screen.findByRole('button', { name: /replace for good/i }));

    await waitFor(async () => expect((await getGame('g1'))?.name).toBe('Skirmish'));
    expect((await getGame('g1'))?.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('dropping a file (v3 §4.2–§4.3)', () => {
  // AC: IM6 — the list half.
  it('imports as a new game when dropped on the game list, and opens it', async () => {
    const { router } = at('/');
    await screen.findByText(/no games yet/i);

    drop([incoming()]);

    await waitFor(() => expect(router.state.location.pathname).toBe('/game/g9/pools'));
    expect((await getAllGames()).map((g) => g.name)).toEqual(['Skirmish']);
  });

  // AC: IM6 — the editor half. A drop is an OFFER; it commits nothing on its own.
  it('offers a replace when dropped in the editor, writing nothing until confirmed', async () => {
    const original = await seed({ id: 'g1', name: 'Duel of Wits' });
    const user = userEvent.setup();
    await openEditor();

    drop([incoming()]);

    expect(await screen.findByRole('button', { name: /replace for good/i })).toBeInTheDocument();
    expect(await getGame('g1')).toEqual(original);

    await user.click(screen.getByRole('button', { name: /replace for good/i }));
    await waitFor(async () => expect((await getGame('g1'))?.name).toBe('Skirmish'));
  });

  // AC: IM7 — the guard in AppFrame, proved on a route that handles no drops at all.
  it('never lets a drop navigate the tab away from the app', async () => {
    const { router } = at('/nope');
    await screen.findByText(/no such page/i);

    const event = drop([new File(['whatever'], 'notes.txt', { type: 'text/plain' })]);

    expect(event.defaultPrevented).toBe(true);
    expect(router.state.location.pathname).toBe('/nope');
    expect(await getAllGames()).toHaveLength(0);
  });

  // AC: IM10
  it('says what a drop would do while the drag is over the window, per screen', async () => {
    at('/');
    await screen.findByText(/no games yet/i);

    dragEnter();
    expect(await screen.findByText(/import it as a new game/i)).toBeInTheDocument();

    dragLeave();
    await waitFor(() => expect(screen.queryByText(/import it as a new game/i)).not.toBeInTheDocument());
  });

  // AC: IM10 — same drag, different answer, which is the whole point of a per-screen drop target.
  it('offers to replace, not to import, while dragging over the editor', async () => {
    await seed({ id: 'g1', name: 'Duel of Wits' });
    await openEditor();

    dragEnter();

    expect(await screen.findByText(/replace “Duel of Wits”/i)).toBeInTheDocument();
    expect(screen.queryByText(/import it as a new game/i)).not.toBeInTheDocument();
  });
});
