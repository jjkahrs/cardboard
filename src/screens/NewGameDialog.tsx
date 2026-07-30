/**
 * The "New game" chooser: a blank definition, or one of the bundled samples in `templates.ts`.
 *
 * Presentational, like `ReplaceGame` and for the same reason: every decision (load the JSON, gate
 * it, mint an id, write it, navigate) lives in `GameListScreen`, so this renders and reports and
 * nothing else. `onPick(null)` is the blank game, so the parent has one handler for both outcomes.
 *
 * A real `<dialog>` + `showModal()`, not a hand-rolled overlay: Esc-to-close, the focus trap, focus
 * restored to the "New game" button on close, and the rest of the page made inert are all platform
 * behaviour here, and none of them are worth reimplementing. This is the one modal in the app —
 * transient and unlinkable, so it is not the thing §6 warns about (an editor that should have been a
 * route), nor a `window.confirm`, which would block the tab.
 */

import { useId } from 'react';
import { TEMPLATES, type GameTemplate } from './templates';

export function NewGameDialog({
  onPick,
  onCancel,
}: {
  /** `null` = blank game. */
  onPick: (template: GameTemplate | null) => void;
  onCancel: () => void;
}) {
  const headingId = useId();

  return (
    <dialog
      className="cb-dialog"
      aria-labelledby={headingId}
      ref={(node) => {
        if (node && !node.open) node.showModal();
      }}
      // Esc closes the dialog itself; `onClose` is where that becomes the parent's business.
      onClose={onCancel}
      // A click whose target is the dialog element is a click on the backdrop — the content sits in
      // children, so it can never be the target. Native `<dialog>` does not do this for us.
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <h2 id={headingId}>Start a new game</h2>

      <ul className="cb-list">
        <li className="cb-list__row">
          <button type="button" className="cb-dialog__option" onClick={() => onPick(null)}>
            <span className="cb-dialog__option-name">Blank game</span>
            <span className="cb-dialog__option-blurb">
              An empty definition — 2 players and nothing else.
            </span>
          </button>
        </li>
        {TEMPLATES.map((template) => (
          <li key={template.key} className="cb-list__row">
            <button type="button" className="cb-dialog__option" onClick={() => onPick(template)}>
              <span className="cb-dialog__option-name">{template.name}</span>
              <span className="cb-dialog__option-blurb">{template.blurb}</span>
              <span className="cb-game-list__meta">
                {template.cards} cards · {template.players} players
              </span>
            </button>
          </li>
        ))}
      </ul>

      <button type="button" className="cb-btn" data-variant="ghost" onClick={onCancel}>
        Cancel
      </button>
    </dialog>
  );
}
