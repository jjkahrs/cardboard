/**
 * Rendering a screen at its real route, with a real game in IndexedDB.
 *
 * The authoring screens are reached through `AuthoringLayout`, which loads the definition from
 * IndexedDB and refuses an invalid one — so a screen rendered in isolation proves neither its route
 * nor that the definition it edits ever got loaded. This is what `routing.test.tsx` and
 * `rules.test.tsx` each did inline; it moved here the second time it was needed.
 */

import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect } from 'vitest';
import type { GameDefinition } from '../engine/types';
import { createEmptyDefinition, useDefinitionStore } from '../stores/definitionStore';
import { deleteGame, getAllGames, putGame } from '../stores/persistence';
import { routes } from '../routes';

export const TEST_GAME_ID = 'g1';

export const definition = (): GameDefinition => useDefinitionStore.getState().definition;

/** A valid game with the given overrides, stored where the layout will find it. */
export async function seedGame(over: Partial<GameDefinition> = {}): Promise<GameDefinition> {
  const game: GameDefinition = {
    ...createEmptyDefinition(TEST_GAME_ID, 'Duel', '2026-01-01T00:00:00.000Z'),
    ...over,
  };
  await putGame(game);
  return game;
}

/** Empty IndexedDB and park the store on a definition that is nobody's game. */
export async function resetGames(): Promise<void> {
  for (const game of await getAllGames()) await deleteGame(game.id);
  useDefinitionStore
    .getState()
    .setDefinition(createEmptyDefinition('blank', 'blank', '2026-01-01T00:00:00.000Z'));
  localStorage.clear();
}

/** Renders the real route table at `path` and waits for the layout's load to land. */
export async function openRoute(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const handle = { router, user: userEvent.setup(), ...render(<RouterProvider router={router} />) };
  await waitFor(() => expect(definition().id).toBe(TEST_GAME_ID));
  return handle;
}
