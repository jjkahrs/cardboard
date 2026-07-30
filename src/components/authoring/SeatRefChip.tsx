import { useId } from 'react';
import type { GameDefinition, SeatQuantifier, SeatRef } from '../../engine/types';
import { danglingSeat } from '../criteria/isDangling';
import { ChipPopover } from '../ui/ChipPopover';
import { NumberField, SelectField } from '../ui/fields';
import { CardRefChip } from './CardRefChip';
import { seatLabel, type RefContext } from './refs';

/**
 * One row per thing an author can mean. Not one row per `SeatRef['kind']`: §4.1's single `all` kind
 * asks three different questions depending on its quantifier, and "every player" / "any player" /
 * "all players, summed" are three different sentences.
 */
type SeatRow = Exclude<SeatRef['kind'], 'all'> | SeatQuantifier;

const ROWS: { row: SeatRow; label: string }[] = [
  { row: 'active', label: 'The active player' },
  { row: 'triggeringSeat', label: 'The player who played this' },
  { row: 'next', label: 'The next player' },
  { row: 'previous', label: 'The previous player' },
  { row: 'seat', label: 'A specific seat' },
  { row: 'relative', label: 'Counted from another player' },
  { row: 'owner', label: "A card's owner" },
  { row: 'controller', label: "A card's controller" },
  { row: 'every', label: 'Every player' },
  { row: 'some', label: 'Any player' },
  { row: 'sum', label: 'All players, summed' },
  /** v4 §4.3 (G3) — "target player": whoever a `chooseSeat` effect earlier in the rule picked. */
  { row: 'promptSeat', label: 'The player chosen earlier' },
];

/** `{kind:'all'}` with no quantifier means `every` (§4.1), so it checks the same row. */
const rowOf = (seat: SeatRef): SeatRow =>
  seat.kind === 'all' ? (seat.quantifier ?? 'every') : seat.kind;

/** Switching row keeps whatever the old ref already answered, rather than resetting the author. */
const seatFor = (row: SeatRow, current: SeatRef): SeatRef => {
  switch (row) {
    case 'seat':
      return { kind: 'seat', index: current.kind === 'seat' ? current.index : 0 };
    case 'relative':
      return { kind: 'relative', from: { kind: 'active' }, offset: 1 };
    case 'owner':
    case 'controller':
      return { kind: row, card: 'card' in current ? current.card : { kind: 'triggering' } };
    case 'every':
    case 'some':
    case 'sum':
      return { kind: 'all', quantifier: row };
    case 'promptSeat':
      return { kind: 'promptSeat', key: current.kind === 'promptSeat' ? current.key : '' };
    default:
      return { kind: row };
  }
};

export interface SeatRefChipProps {
  seat: SeatRef;
  onChange: (seat: SeatRef) => void;
  definition: GameDefinition;
  ariaLabel: string;
  /**
   * §4.1 — `sum` is an arithmetic total, not a fold to a boolean, so it is legal only where the ref
   * is consumed as a number. The caller knows which position this is; the zod refinement
   * (`schema.ts`'s `checkValueRef`) and the runtime `TYPE_MISMATCH` are the backstops behind it.
   */
  numeric?: boolean;
  /** §6.11 — threaded on to the `CardRef` that `owner`/`controller` carry. */
  context?: RefContext;
}

/**
 * "Whose?" as a chip (§6.10), replacing `SeatSelect` and its `seatToOption`/`optionToSeat` string
 * encoding. §4.1's `relative` nests another `SeatRef` and `owner`/`controller` each carry a
 * `CardRef`; neither fits a flat `{value,label}[]` fed to a native select, which was the only reason
 * that encoding existed.
 */
export function SeatRefChip({
  seat,
  onChange,
  definition,
  ariaLabel,
  numeric,
  context,
}: SeatRefChipProps) {
  return (
    <ChipPopover
      label={seatLabel(definition, seat)}
      ariaLabel={ariaLabel}
      danger={danglingSeat(seat, definition)}
    >
      {() => (
        <SeatRefFields
          seat={seat}
          onChange={onChange}
          definition={definition}
          numeric={numeric}
          context={context}
        />
      )}
    </ChipPopover>
  );
}

/**
 * The rows and their parameters. Recurses for `relative.from` INLINE rather than through a second
 * chip — a popover inside a popover is two Escape presses to leave one control, which is the same
 * reason `TargetSelectorFields` renders its wrapped selector inline (`TargetSelectorChip.tsx:120`).
 */
function SeatRefFields({
  seat,
  onChange,
  definition,
  numeric = false,
  context,
  depth = 0,
}: {
  seat: SeatRef;
  onChange: (seat: SeatRef) => void;
  definition: GameDefinition;
  numeric?: boolean;
  context?: RefContext;
  depth?: number;
}) {
  const name = useId();
  const keyId = useId();

  return (
    <>
      <fieldset className="cb-fieldset">
        <legend>Whose</legend>
        {ROWS.filter(({ row }) => numeric || row !== 'sum').map(({ row, label }) => {
          // An editor restriction, not a schema one: relative-to-a-relative is arithmetic the author
          // can do in the offset field, and the nesting is unreadable (§6.10).
          const blocked =
            row === 'relative' && depth > 0 ? 'do the arithmetic in the offset instead' : null;
          return (
            <label key={row} className="cb-radio">
              <input
                type="radio"
                name={name}
                checked={rowOf(seat) === row}
                disabled={blocked !== null}
                onChange={() => onChange(seatFor(row, seat))}
              />
              {label}
              {blocked !== null && <span className="cb-hint"> — {blocked}</span>}
            </label>
          );
        })}
      </fieldset>

      {seat.kind === 'seat' && (
        <SelectField
          label="Seat"
          value={String(seat.index)}
          options={Array.from({ length: definition.playerCount }, (_, i) => ({
            value: String(i),
            label: `player ${i + 1}`,
          }))}
          onChange={(index) => onChange({ kind: 'seat', index: Number(index) })}
        />
      )}

      {seat.kind === 'relative' && (
        <>
          <NumberField
            label="Seats along"
            value={seat.offset}
            hint="Negative counts backwards. Eliminated seats are skipped."
            onChange={(offset) => onChange({ ...seat, offset: offset ?? 0 })}
          />
          <fieldset className="cb-fieldset">
            <legend>Counted from</legend>
            <SeatRefFields
              seat={seat.from}
              definition={definition}
              context={context}
              depth={depth + 1}
              onChange={(from) => onChange({ ...seat, from })}
            />
          </fieldset>
        </>
      )}

      {/* v4 §4.3 — the key is the whole ref: it has to match the `chooseSeat` that asked, and there
          is nothing declared to offer in a select (keys are free-form, like `chooseNumber.key`). */}
      {seat.kind === 'promptSeat' && (
        <div className="cb-field">
          <label htmlFor={keyId}>Remembered as</label>
          <input
            id={keyId}
            className="cb-input"
            value={seat.key}
            onChange={(e) => onChange({ kind: 'promptSeat', key: e.target.value })}
          />
          <span className="cb-hint">Must match the key on the "Choose a player" effect above.</span>
        </div>
      )}

      {(seat.kind === 'owner' || seat.kind === 'controller') && (
        <div className="cb-field">
          <span>Of which card</span>
          <CardRefChip
            card={seat.card}
            definition={definition}
            ariaLabel="Of which card"
            context={context}
            onChange={(card) => onChange({ ...seat, card })}
          />
        </div>
      )}
    </>
  );
}
