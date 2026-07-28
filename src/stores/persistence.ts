/**
 * Raw IndexedDB persistence + debounced autosave. TECHNICAL_DESIGN.md §7.
 *
 * One object store, no indexes (§7.3) — `getAll()` and filter is plenty for a handful of games.
 * No `idb` package: this is the ~30 lines of promise-wrapping it would save maybe fifteen of.
 *
 * Import/export is NOT reimplemented here — `schema.ts` owns Zod validation and the canonical,
 * byte-identical serialisation (§7.1). This module only re-exports it so callers have one place
 * to import persistence-related functions from.
 */

import type { GameDefinition, Id } from '../engine/types';
export { exportJson, importJson, type ImportResult, validateDefinition } from '../engine/schema';

const DB_NAME = 'cardboard';
const DB_VERSION = 1;
const STORE_NAME = 'games';

/**
 * Opens a fresh connection every call — no cached singleton. v1 has a handful of games and calls
 * are infrequent (autosave, game-list load), so the simplicity is worth more than the connection
 * reuse. Each read/write function below closes the connection it opens when done.
 */
export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/**
 * Every autosave write chains here, module-wide, and every read waits behind it. A route change
 * unmounts the authoring layout and its `flush()` is fire-and-forget: the put is only scheduled, so
 * PlayScreen's `getGame` would otherwise open its own connection first and load the pre-edit
 * definition — the tester playtests rules they just changed, minus the change.
 */
let writeChain: Promise<void> = Promise.resolve();

export async function getGame(id: Id): Promise<GameDefinition | undefined> {
  await writeChain;
  return withDb(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result as GameDefinition | undefined);
        req.onerror = () => reject(req.error);
      })
  );
}

export async function getAllGames(): Promise<GameDefinition[]> {
  await writeChain;
  return withDb(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result as GameDefinition[]);
        req.onerror = () => reject(req.error);
      })
  );
}

export function putGame(d: GameDefinition): Promise<void> {
  return withDb(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(d);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export function deleteGame(id: Id): Promise<void> {
  return withDb(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

// ---------------------------------------------------------------------------
// Last-opened game id — a single string, not a reason for a second object store (§7.3).
// ---------------------------------------------------------------------------

const LAST_OPENED_KEY = 'cardboard:lastOpenedGameId';

/** `localStorage` doesn't exist under the engine test project's node environment — degrade to
 * null/no-op rather than throw. */
export function lastOpenedGameId(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(LAST_OPENED_KEY);
  } catch {
    return null;
  }
}

export function setLastOpenedGameId(id: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LAST_OPENED_KEY, id);
  } catch {
    // storage unavailable/full — last-opened is a convenience, not state worth failing over
  }
}

// ---------------------------------------------------------------------------
// Autosave — definitionStore.subscribe -> 500ms debounce -> putGame (§7.3).
// `updatedAt` is bumped by the CRUD actions, NEVER here.
// ---------------------------------------------------------------------------

export interface Autosave {
  save(d: GameDefinition): void;
  flush(): Promise<void>;
  cancel(): void;
}

/**
 * §9.4 item 12: two `save()` calls inside the debounce window coalesce into one `put` of the
 * LATER definition (plain debounce). An in-flight write must not be overtaken by a stale one —
 * every put is chained onto `writeChain`, a single serialised promise, so writes land in the
 * order their debounce windows closed, never out of order and never in parallel.
 */
export function createAutosave(delayMs = 500): Autosave {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: GameDefinition | null = null;

  const enqueue = (d: GameDefinition): void => {
    // Both arms run `putGame` regardless of whether the prior write settled or rejected, so one
    // failed autosave can't wedge every write after it.
    writeChain = writeChain.then(
      () => putGame(d),
      () => putGame(d)
    );
  };

  const fireNow = (): void => {
    timer = null;
    const d = pending;
    pending = null;
    if (d) enqueue(d);
  };

  return {
    save(d: GameDefinition): void {
      pending = d;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fireNow, delayMs);
    },
    async flush(): Promise<void> {
      if (timer !== null) {
        clearTimeout(timer);
        fireNow();
      }
      await writeChain;
    },
    cancel(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

// ponytail: play sessions are not persisted (§7.4) — a refresh ends the playtest, on purpose.
// Upgrade path when that changes: a second object store ("sessions", keyPath "definitionId") plus
// a putSession(state, history) alongside putGame above. PlayState and HistoryFrame[] are already
// plain serializable JSON, so it's the same ~10 lines this file already has, not a rewrite.
