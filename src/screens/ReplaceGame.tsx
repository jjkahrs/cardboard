/**
 * v3 §4.5 — the rail's "replace this game with a file" control.
 *
 * Presentational, like `Rail` and for the same reason: every decision (gate the file, keep the id,
 * bump `updatedAt`, coordinate with autosave) lives in `AuthoringLayout`, so the confirm can be
 * rendered and driven here without a route, a store, or IndexedDB.
 *
 * The confirm is the two-click inline pattern the game list already uses for Delete — one
 * destructive-confirm pattern in the app, not two, and no `window.confirm`, which blocks the tab.
 */

import type { GameDefinition } from '../engine/types';

export interface PendingReplace {
  fileName: string;
  definition: GameDefinition;
}

export function ReplaceGame({
  gameName,
  pending,
  problems,
  onFilePicked,
  onConfirm,
  onCancel,
}: {
  gameName: string;
  /** Gated and waiting for the second click. `null` = idle. */
  pending: PendingReplace | null;
  problems: string[];
  onFilePicked: (file: File) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="cb-rail__replace">
      {pending === null ? (
        // A real <label> around the input, as on the game list: no ref, no synthetic click, and the
        // keyboard reaches it like any other control.
        <label className="cb-btn">
          Replace from file…
          <input
            type="file"
            accept="application/json,.json"
            className="cb-visually-hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so picking the same file twice in a row still fires a change event.
              event.target.value = '';
              if (file) onFilePicked(file);
            }}
          />
        </label>
      ) : (
        <>
          <p className="cb-error" role="status">
            Replace “{gameName}” with {pending.fileName}? The current game is overwritten and cannot
            be recovered.
          </p>
          <button type="button" className="cb-btn" data-variant="danger" onClick={onConfirm}>
            Replace for good
          </button>
          <button type="button" className="cb-btn" data-variant="ghost" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}

      {problems.length > 0 && (
        <ul className="cb-list">
          {problems.map((problem) => (
            <li key={problem} className="cb-list__row cb-error">
              {problem}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
