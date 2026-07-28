/**
 * Step 24 — the browser half of import/export. The *rules* (validation, canonical serialisation)
 * live in `engine/schema.ts` and are not restated here; this file is only file-picker plumbing
 * plus the id minting the game list and the importer share.
 */

import { exportJson } from '../stores/persistence';
import type { GameDefinition } from '../engine/types';

/**
 * Ids only have to be unique inside this browser, and they must not collide with the definition
 * store's `pool_1`-style counters. Time + a random suffix is enough and needs no dependency; the
 * engine's determinism rules are about play, not about which file you opened.
 */
export function newGameId(): string {
  return `game_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** `Duel of Wits` -> `duel-of-wits.json`. Anything unnameable falls back to `game.json`. */
export function fileNameFor(d: GameDefinition): string {
  const slug = d.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'game'}.json`;
}

/**
 * Saves the definition as JSON via a synthetic `<a download>`. No dependency and no
 * `showSaveFilePicker` — the anchor works in every browser this ships to.
 *
 * `exportJson` runs the definition back through Zod, so a stored file that has rotted throws here
 * rather than writing a half-valid export; callers surface that as an error.
 */
export function downloadDefinition(d: GameDefinition): void {
  const url = URL.createObjectURL(new Blob([exportJson(d)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileNameFor(d);
  anchor.click();
  // Revoked on the next tick, not inline: the download reads the blob after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
