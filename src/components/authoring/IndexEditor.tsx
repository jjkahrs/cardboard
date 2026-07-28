import type { CardIndex, CardTemplate, IndexPosition } from '../../engine/types';
import { IconPicker } from '../icons/IconPicker';
import { Icon } from '../icons/Icon';
import { ChipPopover } from '../ui/ChipPopover';
import { SelectField } from '../ui/fields';
import { GameValueFields } from './GameValueFields';

const POSITIONS: { value: IndexPosition; label: string }[] = [
  { value: 'topLeft', label: 'Top left' },
  { value: 'topRight', label: 'Top right' },
  { value: 'bottomLeft', label: 'Bottom left' },
  { value: 'bottomRight', label: 'Bottom right' },
];

export interface IndexEditorProps {
  template: CardTemplate;
  onAdd: () => void;
  onUpdate: (indexId: string, patch: Partial<Omit<CardIndex, 'id'>>) => void;
  onRemove: (indexId: string) => void;
}

/**
 * The numbers in a card's corners (§4.4) — attack, cost, a "tapped" flag.
 *
 * There are exactly four corners, so two indexes sharing one is a collision the card silently
 * stacks. It is a warning rather than a block: the designer may be mid-rearrangement, and a refused
 * edit there would mean shuffling through a free corner to swap two.
 */
export function IndexEditor({ template, onAdd, onUpdate, onRemove }: IndexEditorProps) {
  const taken = new Map<IndexPosition, number>();
  for (const index of template.indexes) {
    taken.set(index.position, (taken.get(index.position) ?? 0) + 1);
  }

  return (
    <>
      {template.indexes.length === 0 ? (
        <p className="cb-hint">
          No numbers on this card yet. Add one for a cost, a power, or a flag a rule can flip.
        </p>
      ) : (
        <ul className="cb-list" aria-label="Card numbers">
          {template.indexes.map((index) => (
            <li key={index.id} className="cb-index">
              <div className="cb-index__head">
                <Icon id={index.icon} />
                <strong>{index.value.name}</strong>
                <button
                  type="button"
                  className="cb-btn"
                  data-variant="danger"
                  onClick={() => onRemove(index.id)}
                >
                  Remove
                </button>
              </div>

              <GameValueFields
                value={index.value}
                onChange={(value) => onUpdate(index.id, { value })}
              />

              <SelectField
                label="Corner"
                value={index.position}
                options={POSITIONS.map((p) => ({ value: p.value, label: p.label }))}
                onChange={(position) => onUpdate(index.id, { position: position as IndexPosition })}
              />
              {(taken.get(index.position) ?? 0) > 1 && (
                <p className="cb-error">
                  Another number sits in this corner — they will overlap on the card.
                </p>
              )}

              <div className="cb-field">
                <span>Icon</span>
                <ChipPopover label={index.icon} ariaLabel={`Icon for ${index.value.name}`}>
                  {(close) => (
                    <IconPicker
                      value={index.icon}
                      onSelect={(icon) => {
                        onUpdate(index.id, { icon });
                        close();
                      }}
                    />
                  )}
                </ChipPopover>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="cb-btn" onClick={onAdd}>
        Add a number
      </button>
    </>
  );
}
