import { useId } from 'react';
import type { CardRef, GameDefinition } from '../../engine/types';
import { danglingCard } from '../criteria/isDangling';
import { ChipPopover } from '../ui/ChipPopover';
import { cardLabel, type RefContext } from './refs';
import { ZoneRefFields } from './ZoneRefChip';
import { defaultZoneRef } from './zoneRef';

const KINDS: { kind: CardRef['kind']; label: string }[] = [
  { kind: 'triggering', label: 'This card' },
  { kind: 'host', label: 'The card this is attached to' },
  { kind: 'zoneTop', label: 'The top card of a zone' },
  { kind: 'candidate', label: 'The card under test' },
  { kind: 'replacedTarget', label: 'The replaced target' },
];

/**
 * Why a row cannot be picked here, or null. Disabled-with-a-reason rather than hidden, the same
 * discipline `effectKinds.ts:29` and `ValueRefPicker.tsx:79-83` already use: an author who cannot
 * find "the card under test" has learnt nothing about why it is not offered.
 */
function blockedFor(
  kind: CardRef['kind'],
  definition: GameDefinition,
  context: RefContext | undefined
): string | null {
  if (kind === 'candidate' && context !== 'candidate')
    return 'only inside a "cards matching…" filter';
  if (kind === 'replacedTarget' && context !== 'replacement')
    return 'only inside a replacement rule';
  if (kind === 'zoneTop' && defaultZoneRef(definition) === null) return 'no zones yet';
  return null;
}

const cardFor = (kind: CardRef['kind'], definition: GameDefinition): CardRef | null => {
  if (kind !== 'zoneTop') return { kind } as CardRef;
  const zone = defaultZoneRef(definition);
  return zone ? { kind: 'zoneTop', zone } : null;
};

export interface CardRefChipProps {
  card: CardRef;
  onChange: (card: CardRef) => void;
  definition: GameDefinition;
  ariaLabel: string;
  /** §6.11 — gates `candidate` / `replacedTarget`, which bind nowhere else. */
  context?: RefContext;
}

/**
 * "Which card" as a chip (§6.10). `CardRef` was not editable anywhere before this — every consumer
 * hard-coded `{kind:'triggering'}`.
 *
 * `promptAnswer` and `instance` are deliberately not offered, for the reason `ValueRefPicker` gives
 * for the same two: both only exist during a running session, so there is nothing to pick at
 * authoring time.
 */
export function CardRefChip({ card, onChange, definition, ariaLabel, context }: CardRefChipProps) {
  const name = useId();

  return (
    <ChipPopover
      label={cardLabel(definition, card)}
      ariaLabel={ariaLabel}
      danger={danglingCard(card, definition)}
    >
      {() => (
        <>
          <fieldset className="cb-fieldset">
            <legend>Which card</legend>
            {KINDS.map(({ kind, label }) => {
              const blocked = blockedFor(kind, definition, context);
              return (
                <label key={kind} className="cb-radio">
                  <input
                    type="radio"
                    name={name}
                    checked={card.kind === kind}
                    disabled={blocked !== null}
                    onChange={() => {
                      const next = cardFor(kind, definition);
                      if (next) onChange(next);
                    }}
                  />
                  {label}
                  {blocked !== null && <span className="cb-hint"> — {blocked}</span>}
                </label>
              );
            })}
          </fieldset>

          {card.kind === 'zoneTop' && (
            <ZoneRefFields
              zone={card.zone}
              definition={definition}
              label="Zone"
              onChange={(zone) => onChange({ kind: 'zoneTop', zone })}
            />
          )}
        </>
      )}
    </ChipPopover>
  );
}
