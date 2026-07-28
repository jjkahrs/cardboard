import { useEffect, useId, useState } from 'react';
import type { CardTemplate } from '../../engine/types';
import { CARD_BORDER_COLORS } from '../../theme/palette';
import { IconPicker } from '../icons/IconPicker';
import { ChipPopover } from '../ui/ChipPopover';
import { Icon } from '../icons/Icon';

/** Tags are a flat list of words; a comma is how everyone already types one (§4.4, `taggedInZone`). */
const parseTags = (text: string): string[] =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');

export interface CardAppearanceFormProps {
  template: CardTemplate;
  onChange: (patch: Partial<Omit<CardTemplate, 'id'>>) => void;
}

/**
 * Name, marquee, face icon, border colour, tags — everything the card *looks* like (§6.3).
 *
 * `marquee` is stored explicitly rather than defaulting at render time, so export stays lossless;
 * the field says what it falls back to instead of silently mirroring the name.
 */
export function CardAppearanceForm({ template, onChange }: CardAppearanceFormProps) {
  const nameId = useId();
  const marqueeId = useId();
  const tagsId = useId();
  const colorName = useId();

  /**
   * The typed text, not `tags.join(', ')`. Round-tripping through the parsed array eats the comma
   * the moment it is typed — "creature," parses to `['creature']`, renders back as "creature", and
   * the next word lands glued to the last one. The array stays the stored truth; this is the text.
   */
  const [tagText, setTagText] = useState(template.tags.join(', '));
  useEffect(() => {
    // Only when a different card is loaded into the form — never while it is being typed in.
    setTagText(template.tags.join(', '));
  }, [template.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="cb-field">
        <label htmlFor={nameId}>Name</label>
        <input
          id={nameId}
          className="cb-input"
          value={template.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </div>

      <div className="cb-field">
        <label htmlFor={marqueeId}>Title on the card</label>
        <input
          id={marqueeId}
          className="cb-input"
          value={template.marquee}
          onChange={(e) => onChange({ marquee: e.target.value })}
        />
        <button
          type="button"
          className="cb-btn"
          data-variant="ghost"
          disabled={template.marquee === template.name}
          onClick={() => onChange({ marquee: template.name })}
        >
          Use the name
        </button>
      </div>

      <div className="cb-field">
        <span>Face</span>
        <ChipPopover label={template.faceIcon} ariaLabel="Face icon">
          {(close) => (
            <IconPicker
              value={template.faceIcon}
              onSelect={(faceIcon) => {
                onChange({ faceIcon });
                close();
              }}
            />
          )}
        </ChipPopover>
        <Icon id={template.faceIcon} />
      </div>

      <fieldset className="cb-fieldset cb-swatches">
        <legend>Border</legend>
        {CARD_BORDER_COLORS.map(({ hex, name }) => (
          <label key={hex} className="cb-swatch" style={{ '--cb-swatch': hex } as React.CSSProperties}>
            <input
              type="radio"
              name={colorName}
              className="cb-visually-hidden"
              checked={template.borderColor === hex}
              onChange={() => onChange({ borderColor: hex })}
            />
            {/* The name is the label, not the colour: a swatch grid is unusable without it. */}
            <span className="cb-swatch__chip" aria-hidden="true" />
            <span>{name}</span>
          </label>
        ))}
      </fieldset>

      <div className="cb-field">
        <label htmlFor={tagsId}>Tags</label>
        <input
          id={tagsId}
          className="cb-input"
          value={tagText}
          placeholder="creature, fire"
          onChange={(e) => {
            setTagText(e.target.value);
            onChange({ tags: parseTags(e.target.value) });
          }}
        />
        {/* §4.3 — these seed each copy; `setTag` then edits that copy's list, not this one. */}
        <span className="cb-hint">
          Comma separated. Rules can target "all cards tagged X". Every copy dealt into play starts
          with these tags and keeps its own list from then on, so a rule can tag or untag one copy
          without touching the others.
        </span>
      </div>
    </>
  );
}
