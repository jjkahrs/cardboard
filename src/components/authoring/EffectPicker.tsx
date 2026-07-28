import type { Effect, GameDefinition } from '../../engine/types';
import { ChipPopover } from '../ui/ChipPopover';
import { EFFECT_KINDS, defaultEffect, missingFor } from './effectKinds';

/**
 * "+ effect ▾" (§6.8). A popover of the kinds rather than a select, because each row carries a
 * reason when it is unavailable — and an option you cannot pick with no explanation attached is the
 * worst of both.
 */
export function EffectPicker({
  definition,
  onAdd,
  depth = 0,
  ariaLabel = 'Add an effect',
}: {
  definition: GameDefinition;
  onAdd: (effect: Effect) => void;
  /** §6.11 — how many effect lists deep this picker sits; `chooseMode` is refused at depth 1. */
  depth?: number;
  ariaLabel?: string;
}) {
  return (
    <ChipPopover label="+ effect" ariaLabel={ariaLabel}>
      {(close) => (
        <ul className="cb-list">
          {EFFECT_KINDS.map(({ kind, label }) => {
            const missing = missingFor(kind, definition, depth);
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
