import { useId } from 'react';
import type { GameValue } from '../../engine/types';
import { NumberField, SelectField } from '../ui/fields';

export interface GameValueFieldsProps {
  value: GameValue;
  onChange: (value: GameValue) => void;
  /** Pools rename through the list, so they hide this; a card number has nowhere else to be named. */
  showName?: boolean;
}

/**
 * The editor for §4.1's `GameValue` — the same shape whether it is a point pool or the number in a
 * card's corner, so it is the same six controls in both places.
 *
 * Switching type rebuilds the value rather than carrying fields across: a bound of 20 means nothing
 * on a flag, and `defaultValue` cannot be both `0` and `false`. The name is the one thing kept.
 */
export function GameValueFields({ value, onChange, showName = true }: GameValueFieldsProps) {
  const nameId = useId();

  return (
    <>
      {showName && (
        <div className="cb-field">
          <label htmlFor={nameId}>Name</label>
          <input
            id={nameId}
            className="cb-input"
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </div>
      )}

      <SelectField
        label="Type"
        value={value.type}
        options={[
          { value: 'integer', label: 'Whole number' },
          { value: 'boolean', label: 'True / false' },
        ]}
        onChange={(type) =>
          onChange(
            type === 'integer'
              ? { type: 'integer', name: value.name, defaultValue: 0, min: null, max: null }
              : { type: 'boolean', name: value.name, defaultValue: false }
          )
        }
      />

      {value.type === 'integer' ? (
        <>
          <NumberField
            label="Starting value"
            value={value.defaultValue}
            onChange={(v) => onChange({ ...value, defaultValue: v ?? 0 })}
          />
          <NumberField
            label="Minimum"
            value={value.min}
            hint="Leave empty for no floor. Effects clamp to it instead of failing."
            onChange={(min) => onChange({ ...value, min })}
          />
          <NumberField
            label="Maximum"
            value={value.max}
            hint="Leave empty for no ceiling."
            onChange={(max) => onChange({ ...value, max })}
          />
        </>
      ) : (
        <SelectField
          label="Starting value"
          value={String(value.defaultValue)}
          options={[
            { value: 'false', label: 'false' },
            { value: 'true', label: 'true' },
          ]}
          onChange={(v) => onChange({ ...value, defaultValue: v === 'true' })}
        />
      )}
    </>
  );
}
