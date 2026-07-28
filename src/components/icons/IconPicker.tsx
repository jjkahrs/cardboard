import { useId, useMemo, useState } from 'react';
import { ICON_CATALOG } from '../../assets/icons/catalog';
import type { IconId } from '../../engine/types';
import { Icon } from './Icon';

export interface IconPickerProps {
  /** Currently chosen icon, if any. Rendered as the pressed button. */
  value?: IconId;
  onSelect: (id: IconId) => void;
  /** Visible label for the search box. */
  label?: string;
}

/**
 * Searchable grid over the bundled subset of game-icons.net.
 *
 * The CC BY 3.0 footer is not decoration: the licence requires the credit to travel with the work,
 * and this is the only place a user ever sees the icon set as a set. ATTRIBUTION.md alone would not
 * satisfy it — see src/assets/icons/ATTRIBUTION.md.
 */
export function IconPicker({ value, onSelect, label = 'Search icons' }: IconPickerProps) {
  const [query, setQuery] = useState('');
  const inputId = useId();

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return ICON_CATALOG;
    // Every space-separated word must match something — "red card" narrows, it doesn't widen.
    const words = q.split(/\s+/);
    return ICON_CATALOG.filter((icon) => {
      const haystack = `${icon.name.toLowerCase()} ${icon.tags.join(' ')}`;
      return words.every((w) => haystack.includes(w));
    });
    // ponytail: 296 icons, plain filter on every keystroke. Measure before reaching for an index.
  }, [query]);

  return (
    <div className="cb-icon-picker">
      <div className="cb-field">
        <label htmlFor={inputId}>{label}</label>
        <input
          id={inputId}
          className="cb-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="sword, coin, dragon…"
        />
      </div>

      {results.length === 0 ? (
        <p className="cb-icon-picker__empty">No icon matches “{query.trim()}”.</p>
      ) : (
        <ul className="cb-icon-picker__grid">
          {results.map((icon) => (
            <li key={icon.id}>
              <button
                type="button"
                className="cb-icon-picker__cell"
                // aria-pressed, not a checkbox role: this is a toggle-looking button in a grid, and
                // pressed state is what screen readers announce for "currently chosen".
                aria-pressed={icon.id === value}
                onClick={() => onSelect(icon.id)}
              >
                <Icon id={icon.id} />
                <span className="cb-icon-picker__name">{icon.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="cb-icon-picker__credit">
        Icons from{' '}
        <a href="https://game-icons.net" target="_blank" rel="noreferrer noopener">
          game-icons.net
        </a>{' '}
        — CC BY 3.0
      </p>
    </div>
  );
}
