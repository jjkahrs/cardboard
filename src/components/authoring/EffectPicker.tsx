import type { Effect, GameDefinition } from '../../engine/types';
import { ChipPopover } from '../ui/ChipPopover';
import { EFFECT_KINDS, defaultEffect, missingFor } from './effectKinds';

/**
 * "+ effect ▾" (§6.8). A popover of the eleven kinds rather than a select, because each row carries
 * a reason when it is unavailable — and an option you cannot pick with no explanation attached is
 * the worst of both.
 */
export function EffectPicker({
  definition,
  onAdd,
}: {
  definition: GameDefinition;
  onAdd: (effect: Effect) => void;
}) {
  return (
    <ChipPopover label="+ effect" ariaLabel="Add an effect">
      {(close) => (
        <ul className="cb-list">
          {EFFECT_KINDS.map(({ kind, label }) => {
            const missing = missingFor(kind, definition);
            return (
              <li key={kind} className="cb-list__row">
                <button
                  type="button"
                  className="cb-btn"
                  disabled={missing !== ''}
                  onClick={() => {
                    const effect = defaultEffect(kind, definition);
                    if (effect) onAdd(effect);
                    close();
                  }}
                >
                  {label}
                </button>
                {missing !== '' && <span className="cb-hint">{missing}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </ChipPopover>
  );
}
