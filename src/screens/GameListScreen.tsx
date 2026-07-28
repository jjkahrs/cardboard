import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createEmptyDefinition } from '../stores/definitionStore';
import {
  deleteGame,
  getAllGames,
  getGame,
  importJson,
  putGame,
  setLastOpenedGameId,
} from '../stores/persistence';
import { downloadDefinition, newGameId } from './gameFile';
import type { GameDefinition } from '../engine/types';

/**
 * `/` — every game in IndexedDB (§6.1).
 *
 * New / Import / Open / Duplicate / Delete / Export. Import runs the four gates in `schema.ts`
 * (§7.2) and only touches IndexedDB on `ok: true`, so a rejected file leaves the browser's games
 * byte-identical without this screen having to be careful about it.
 */
export function GameListScreen() {
  const [games, setGames] = useState<GameDefinition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Import/export problems. Separate from `error`: the list itself still loaded and still renders. */
  const [problems, setProblems] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  /** Id awaiting a second click. Inline, because window.confirm blocks the whole tab. */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      setGames(await getAllGames());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = (id: string) => {
    setLastOpenedGameId(id);
    void navigate(`/game/${id}/pools`);
  };

  const createGame = async () => {
    const id = newGameId();
    const definition = createEmptyDefinition(id, 'Untitled game', new Date().toISOString());
    await putGame(definition);
    open(id);
  };

  const duplicate = async (source: GameDefinition) => {
    await putGame({ ...structuredClone(source), id: newGameId(), name: `${source.name} copy` });
    await refresh();
  };

  const remove = async (id: string) => {
    setConfirmingDelete(null);
    await deleteGame(id);
    await refresh();
  };

  const importFile = async (file: File) => {
    setProblems([]);
    setNotice(null);
    const result = importJson(await file.text());
    if (!result.ok) {
      setProblems(result.errors);
      return;
    }
    // The file's own id is kept when it is free, so re-importing an export you took from another
    // browser stays the same game. On a collision it lands as a new game: an import that silently
    // overwrote the game you were editing would be unrecoverable.
    const collides = (await getGame(result.definition.id)) !== undefined;
    const id = collides ? newGameId() : result.definition.id;
    await putGame({ ...result.definition, id });
    setNotice(`Imported “${result.definition.name}”${collides ? ' as a new game' : ''}.`);
    await refresh();
  };

  const onFilePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so picking the same file twice in a row still fires a change event.
    event.target.value = '';
    if (file) void importFile(file);
  };

  const exportGame = (game: GameDefinition) => {
    setProblems([]);
    setNotice(null);
    try {
      downloadDefinition(game);
    } catch (e) {
      setProblems([`“${game.name}” could not be exported: ${(e as Error).message}`]);
    }
  };

  if (error !== null) {
    return (
      <main className="cb-screen">
        <h1>Games</h1>
        <p className="cb-error">Could not read your games: {error}</p>
      </main>
    );
  }

  return (
    <main className="cb-screen">
      <header className="cb-screen__head">
        <h1>Games</h1>
        {/* A real <label> around the input: no ref, no synthetic click, and the keyboard reaches it
            like any other control (the focus ring moves to the label in CSS). */}
        <label className="cb-btn">
          Import game
          <input
            type="file"
            accept="application/json,.json"
            className="cb-visually-hidden"
            onChange={onFilePicked}
          />
        </label>
        <button type="button" className="cb-btn" onClick={() => void createGame()}>
          New game
        </button>
      </header>

      {notice !== null && <p role="status">{notice}</p>}
      {problems.length > 0 && (
        <ul className="cb-list">
          {problems.map((problem) => (
            <li key={problem} className="cb-list__row cb-error">
              {problem}
            </li>
          ))}
        </ul>
      )}

      {games === null ? (
        <p>Loading…</p>
      ) : games.length === 0 ? (
        <p>No games yet. Start one with “New game”.</p>
      ) : (
        <ul className="cb-list">
          {games.map((game) => (
            <li key={game.id} className="cb-list__row">
              <Link
                to={`/game/${game.id}/pools`}
                className="cb-game-list__name"
                onClick={() => setLastOpenedGameId(game.id)}
              >
                {game.name}
              </Link>
              <span className="cb-game-list__meta">
                {game.templates.length} cards · {game.playerCount} players
              </span>
              <button type="button" className="cb-btn" onClick={() => exportGame(game)}>
                Export
              </button>
              <button type="button" className="cb-btn" onClick={() => void duplicate(game)}>
                Duplicate
              </button>
              {confirmingDelete === game.id ? (
                <>
                  <span className="cb-error">Delete “{game.name}”?</span>
                  <button
                    type="button"
                    className="cb-btn"
                    data-variant="danger"
                    onClick={() => void remove(game.id)}
                  >
                    Delete for good
                  </button>
                  <button
                    type="button"
                    className="cb-btn"
                    data-variant="ghost"
                    onClick={() => setConfirmingDelete(null)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="cb-btn"
                  data-variant="danger"
                  onClick={() => setConfirmingDelete(game.id)}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
