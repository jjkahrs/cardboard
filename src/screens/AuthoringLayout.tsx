import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router-dom';
import { validateDefinition } from '../engine/schema';
import type { GameDefinition } from '../engine/types';
import { GAME_LEVEL, SURFACES, bucketErrors } from './surfaces';
import { useDefinitionStore } from '../stores/definitionStore';
import { createAutosave, getGame, setLastOpenedGameId } from '../stores/persistence';
import { downloadDefinition } from './gameFile';

/**
 * The persistent authoring frame (§6.1): left rail plus `<Outlet/>`.
 *
 * The rail's per-surface badge is the app's ONLY error surface, so it has to be right and it has to
 * be visible from every screen — which is exactly why validation runs here, on the whole definition,
 * rather than inside each screen where a screen nobody opened would hide its own errors.
 */
export function AuthoringLayout() {
  const { gameId } = useParams();
  const definition = useDefinitionStore((s) => s.definition);
  const setDefinition = useDefinitionStore((s) => s.setDefinition);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'invalid'>('loading');
  const [loadErrors, setLoadErrors] = useState<string[]>([]);

  // One autosave per mounted layout; the debounce window is what coalesces a burst of edits.
  const autosave = useRef(createAutosave()).current;
  /** The definition as loaded. Saving it straight back would be a pointless write on every open. */
  const loaded = useRef<GameDefinition | null>(null);

  useEffect(() => {
    if (gameId === undefined) return;
    let cancelled = false;
    void getGame(gameId).then((found) => {
      if (cancelled) return;
      if (!found) {
        setStatus('missing');
        return;
      }
      // setDefinition validates and REFUSES an invalid definition (§7.2 gates, same code the
      // importer runs). Ignoring that result would leave the previous game in the store while the
      // rail claimed to be showing this one — silently editing the wrong file.
      const result = setDefinition(found);
      if (!result.ok) {
        setLoadErrors(result.errors);
        setStatus('invalid');
        return;
      }
      loaded.current = found;
      setLastOpenedGameId(gameId);
      setStatus('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [gameId, setDefinition]);

  useEffect(() => {
    // Only persist edits to the game this route is actually showing: the store is global and still
    // holds the previous game between mount and load.
    if (status !== 'ready' || definition.id !== gameId) return;
    if (definition === loaded.current) return;
    autosave.save(definition);
  }, [definition, gameId, status, autosave]);

  useEffect(() => () => void autosave.flush(), [autosave]);

  const errors = useMemo(
    () => (status === 'ready' ? bucketErrors(validateDefinition(definition)) : {}),
    [definition, status]
  );

  if (status === 'missing') {
    return (
      <main className="cb-screen">
        <h1>Game not found</h1>
        <p>No game with id “{gameId}” is stored in this browser.</p>
        <Link to="/">Back to your games</Link>
      </main>
    );
  }

  if (status === 'invalid') {
    return (
      <main className="cb-screen">
        <h1>This game can’t be opened</h1>
        <p className="cb-error">
          The stored file fails validation, so it was not loaded — whatever you had open is
          untouched.
        </p>
        <ul className="cb-list">
          {loadErrors.map((error) => (
            <li key={error} className="cb-list__row">
              {error}
            </li>
          ))}
        </ul>
        <Link to="/">Back to your games</Link>
      </main>
    );
  }

  if (status === 'loading') {
    return (
      <main className="cb-screen">
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <div className="cb-shell">
      <Rail definition={definition} errors={errors} />
      <Outlet />
    </div>
  );
}

/**
 * The rail itself, presentational. Split out because the store REFUSES to hold an invalid
 * definition, so the only way to prove the error badge renders is to hand it errors directly.
 */
export function Rail({
  definition,
  errors,
}: {
  definition: GameDefinition;
  errors: Record<string, string[]>;
}) {
  const gameErrors = errors[GAME_LEVEL] ?? [];

  return (
    <nav className="cb-rail" aria-label="Authoring">
      <Link to="/" className="cb-rail__home">
        ← Games
      </Link>
      <h2 className="cb-rail__title">{definition.name}</h2>
      {gameErrors.length > 0 && (
        <p className="cb-error" role="status">
          {gameErrors[0]}
        </p>
      )}

      {SURFACES.map((surface) => {
        const surfaceErrors = errors[surface.path] ?? [];
        const broken = surfaceErrors.length > 0;
        return (
          <NavLink key={surface.path} to={surface.path} className="cb-rail__link">
            <span>{surface.label}</span>
            <span
              className={broken ? 'cb-badge cb-badge--error' : 'cb-badge'}
              // Colour is never the sole carrier: the badge takes the marker slash in CSS, and the
              // count alone would read the same broken or not.
              title={broken ? surfaceErrors.join('\n') : undefined}
            >
              {surface.count(definition)}
            </span>
            {broken && (
              <span className="cb-visually-hidden">
                {surfaceErrors.length} problem{surfaceErrors.length === 1 ? '' : 's'}
              </span>
            )}
          </NavLink>
        );
      })}

      <NavLink to="play" className="cb-rail__link">
        Play
      </NavLink>

      {/* No try/catch: the store refuses to hold a definition that fails validation, so what the
          rail is showing is exactly what `exportJson` will re-serialise. */}
      <button type="button" className="cb-btn" onClick={() => downloadDefinition(definition)}>
        Export game
      </button>
    </nav>
  );
}
