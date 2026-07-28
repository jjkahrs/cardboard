import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAutosave,
  deleteGame,
  exportJson,
  getAllGames,
  getGame,
  importJson,
  lastOpenedGameId,
  openDb,
  putGame,
  setLastOpenedGameId,
} from './persistence';
import type { GameDefinition } from '../engine/types';
import { duel, empty, fanOut, malformed, malformedBase, mutualLoop, selfLoop } from '../test/fixtures';

// fake-indexeddb keeps its database in module-level memory across tests — start every test clean.
beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('cardboard');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('IndexedDB round trip (AC: P1)', () => {
  // Proves the module's contract, not Chrome's — a real browser restart is a manual smoke test
  // per TECHNICAL_DESIGN.md §9.1 row P1.
  it('a fresh connection reads back what an earlier connection wrote', async () => {
    await putGame(duel);

    const db = await openDb();
    db.close(); // the "old" connection goes away

    const loaded = await getGame(duel.id); // getGame opens its own new connection internally
    expect(loaded).toEqual(duel);
  });
});

describe('getAllGames / deleteGame', () => {
  it('getAllGames returns everything; deleteGame removes one and leaves the rest', async () => {
    await putGame(duel);
    await putGame(empty);

    const all = await getAllGames();
    expect(all.map((d) => d.id).sort()).toEqual([duel.id, empty.id].sort());

    await deleteGame(duel.id);
    const remaining = await getAllGames();
    expect(remaining.map((d) => d.id)).toEqual([empty.id]);
    expect(await getGame(duel.id)).toBeUndefined();
  });
});

describe('export/import round trip (AC: P2)', () => {
  const fixtures: [string, GameDefinition][] = [
    ['duel', duel],
    ['empty', empty],
    ['selfLoop', selfLoop],
    ['mutualLoop', mutualLoop],
    ['fanOut', fanOut],
    ['malformedBase', malformedBase],
  ];

  it.each(fixtures)('%s: exportJson(importJson(exportJson(d)).definition) === exportJson(d)', (_name, d) => {
    const first = exportJson(d);
    const imported = importJson(first);
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(exportJson(imported.definition)).toBe(first);
  });

  it('a scrambled top-level key order re-exports to the identical canonical string', () => {
    const canonical = exportJson(duel);
    const obj = JSON.parse(canonical) as Record<string, unknown>;
    const scrambled: Record<string, unknown> = {};
    for (const key of Object.keys(obj).reverse()) scrambled[key] = obj[key];

    const imported = importJson(JSON.stringify(scrambled));
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(exportJson(imported.definition)).toBe(canonical);
  });
});

describe('malformed import never touches IndexedDB (AC: P3)', () => {
  it('every malformed case is rejected and the persisted blob is byte-identical afterward', async () => {
    await putGame(malformedBase);
    const before = await getGame(malformedBase.id);

    for (const m of malformed) {
      const result = importJson(m.json);
      expect(result.ok, m.label).toBe(false);

      const after = await getGame(malformedBase.id);
      expect(after, m.label).toEqual(before);
    }
  });
});

describe('createAutosave debounce (§9.4 item 12)', () => {
  // fake-indexeddb schedules its request/transaction callbacks via the real `setImmediate`
  // (see node_modules/fake-indexeddb's scheduling.ts) — faking it alongside setTimeout hangs
  // every IDB operation forever, so only setTimeout/clearTimeout (what our own debounce uses)
  // are faked here.
  const useFakeDebounceTimer = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  it('coalesces two saves inside the debounce window into one put of the later definition', async () => {
    useFakeDebounceTimer();
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    const auto = createAutosave(500);
    const a: GameDefinition = { ...duel, name: 'A' };
    const b: GameDefinition = { ...duel, name: 'B' };

    auto.save(a);
    await vi.advanceTimersByTimeAsync(10); // well inside the window — resets the timer, not fires it
    auto.save(b);
    await vi.advanceTimersByTimeAsync(500);
    await auto.flush();

    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy.mock.calls[0][0]).toMatchObject({ name: 'B' });
    expect((await getGame(duel.id))?.name).toBe('B');
  });

  it('a save that lands while an earlier write may still be in flight never gets overtaken', async () => {
    // No fake timers here — `flush()` is the deterministic escape hatch the API offers for
    // exactly this: force the pending debounce to fire NOW without waiting out real or fake
    // time, so two writes can be made to genuinely overlap.
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    const auto = createAutosave(500);
    const a: GameDefinition = { ...duel, name: 'A' };
    const b: GameDefinition = { ...duel, name: 'B' };

    auto.save(a);
    const firstFlush = auto.flush(); // starts A's write; not yet awaited, so it may still be in flight
    auto.save(b);
    const secondFlush = auto.flush(); // B's debounce fires immediately too, chained after A
    await Promise.all([firstFlush, secondFlush]);

    // Writes land in enqueue order — B can never complete before A because every put is chained
    // onto the previous write's promise (persistence.ts's `writeChain`).
    expect(putSpy.mock.calls.map((call) => (call[0] as GameDefinition).name)).toEqual(['A', 'B']);
    expect((await getGame(duel.id))?.name).toBe('B');
  });

  it('cancel() drops a pending save without writing', async () => {
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    const auto = createAutosave(500);

    auto.save(duel);
    auto.cancel();
    await auto.flush(); // nothing pending — resolves without ever calling put

    expect(putSpy).not.toHaveBeenCalled();
  });
});

describe('lastOpenedGameId', () => {
  it('degrades to null without throwing when localStorage is unavailable', () => {
    // The engine vitest project runs in a node environment — no localStorage global.
    expect(typeof localStorage).toBe('undefined');
    expect(() => lastOpenedGameId()).not.toThrow();
    expect(lastOpenedGameId()).toBeNull();
  });

  it('round-trips through a stubbed localStorage', () => {
    const store = new Map<string, string>();
    // Minimal Storage stub — just enough for get/set.
    (globalThis as any).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    try {
      expect(lastOpenedGameId()).toBeNull();
      setLastOpenedGameId('game_duel');
      expect(lastOpenedGameId()).toBe('game_duel');
    } finally {
      delete (globalThis as any).localStorage;
    }
  });
});
