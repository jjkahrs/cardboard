import { useState } from 'react';
import type { EditResult, Referrer } from '../../stores/definitionStore';

export interface EntityListItem {
  id: string;
  name: string;
  /** Optional second line: "player · face down", "12 cards". */
  detail?: string;
}

export interface EntityListProps {
  items: EntityListItem[];
  /** Highlighted row — the screens that pair this with a detail pane pass their selection. */
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** Returns the store's EditResult so a rejected rename (duplicate name) shows where it happened. */
  onRename: (id: string, name: string) => EditResult;
  onDelete: (id: string) => void;
  /** Everything that would break if this item went away (§6.2). */
  referrersOf: (id: string) => Referrer[];
  onAdd: () => void;
  addLabel: string;
  emptyHint?: string;
  /** Names the list for assistive tech: "Pools", "Zones". */
  label: string;
}

/**
 * Master list with inline rename and delete-with-referrer-check. Drives five authoring screens
 * (§6.2), which is why it takes callbacks rather than touching the store itself.
 *
 * Deleting something that is referenced is REFUSED, not confirmed: the store's referential gate
 * would reject the resulting definition anyway, so an "are you sure" that leads to a rejected edit
 * is a worse version of the same answer.
 */
export function EntityList({
  items,
  selectedId,
  onSelect,
  onRename,
  onDelete,
  referrersOf,
  onAdd,
  addLabel,
  emptyHint,
  label,
}: EntityListProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const startRename = (item: EntityListItem) => {
    setRenamingId(item.id);
    setDraft(item.name);
    setRenameError(null);
  };

  const commitRename = (id: string) => {
    const result = onRename(id, draft.trim());
    if (!result.ok) {
      setRenameError(result.errors[0]);
      return;
    }
    setRenamingId(null);
    setRenameError(null);
  };

  return (
    <div className="cb-entity-list">
      <div className="cb-entity-list__head">
        <h2>{label}</h2>
        <button type="button" className="cb-btn" onClick={onAdd}>
          {addLabel}
        </button>
      </div>

      {items.length === 0 ? (
        <p className="cb-hint">{emptyHint ?? 'Nothing here yet.'}</p>
      ) : (
        <ul className="cb-list" aria-label={label}>
          {items.map((item) => {
            const referrers = referrersOf(item.id);
            const blocked = referrers.length > 0;
            return (
              <li
                key={item.id}
                className="cb-list__row"
                aria-current={item.id === selectedId ? 'true' : undefined}
              >
                {renamingId === item.id ? (
                  <>
                    <input
                      className="cb-input"
                      aria-label={`Rename ${item.name}`}
                      aria-invalid={renameError !== null}
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(item.id);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                    />
                    <button type="button" className="cb-btn" onClick={() => commitRename(item.id)}>
                      Save
                    </button>
                    <button
                      type="button"
                      className="cb-btn"
                      data-variant="ghost"
                      onClick={() => setRenamingId(null)}
                    >
                      Cancel
                    </button>
                    {renameError !== null && <span className="cb-error">{renameError}</span>}
                  </>
                ) : (
                  <>
                    {onSelect ? (
                      <button
                        type="button"
                        className="cb-entity-list__name"
                        onClick={() => onSelect(item.id)}
                      >
                        {item.name}
                      </button>
                    ) : (
                      <span className="cb-entity-list__name">{item.name}</span>
                    )}
                    {item.detail !== undefined && <span className="cb-hint">{item.detail}</span>}
                    <button type="button" className="cb-btn" onClick={() => startRename(item)}>
                      Rename
                    </button>
                    {confirmingId === item.id ? (
                      blocked ? (
                        <span className="cb-error">
                          Used by {referrers.map((r) => `${r.ownerName} (${r.path})`).join(', ')} —
                          remove those first.
                        </span>
                      ) : (
                        <>
                          <span>Delete “{item.name}”?</span>
                          <button
                            type="button"
                            className="cb-btn"
                            data-variant="danger"
                            onClick={() => {
                              setConfirmingId(null);
                              onDelete(item.id);
                            }}
                          >
                            Delete for good
                          </button>
                        </>
                      )
                    ) : null}
                    <button
                      type="button"
                      className="cb-btn"
                      data-variant="danger"
                      onClick={() => setConfirmingId(confirmingId === item.id ? null : item.id)}
                    >
                      {confirmingId === item.id ? 'Cancel' : 'Delete'}
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
