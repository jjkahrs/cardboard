import { useId } from 'react';
import type { GameDefinition, SeatRef } from '../../engine/types';
import { optionToSeat, seatOptions, seatToOption } from './seatRef';

/**
 * "Whose?" — the one control for §4.2's `SeatRef`. Its own module because the value chip, the zone
 * chip and the effect sentences all ask the same question, and three copies of this list is three
 * places for `triggeringSeat` to go missing.
 */
export function SeatSelect({
  seat,
  onChange,
  definition,
  label,
}: {
  seat: SeatRef;
  onChange: (seat: SeatRef) => void;
  definition: GameDefinition;
  label: string;
}) {
  const id = useId();
  return (
    <div className="cb-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="cb-select"
        value={seatToOption(seat)}
        onChange={(e) => onChange(optionToSeat(e.target.value))}
      >
        {seatOptions(definition).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
