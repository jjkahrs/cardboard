import { describeZoneRef } from '../../engine/prose';
import type { GameDefinition, ZoneRef } from '../../engine/types';
import { ChipPopover } from '../ui/ChipPopover';
import { SelectField } from '../ui/fields';
import { SeatRefChip } from './SeatRefChip';
import { isDanglingZone, zoneRefFor } from './zoneRef';

/**
 * The zone half of a sentence, as fields. Split from the chip because the target selector needs the
 * same two questions *inside its own popover*, and a popover nested in a popover is two Escape
 * presses to leave one control.
 */
export function ZoneRefFields({
  zone,
  onChange,
  definition,
  label,
}: {
  zone: ZoneRef;
  onChange: (zone: ZoneRef) => void;
  definition: GameDefinition;
  label: string;
}) {
  return (
    <>
      <SelectField
        label={label}
        value={zone.zoneId}
        options={definition.zones.map((z) => ({ value: z.id, label: z.name }))}
        onChange={(zoneId) => onChange(zoneRefFor(definition, zoneId, zone.seat))}
      />
      {zone.seat !== null && (
        <div className="cb-field">
          <span>Owned by</span>
          <SeatRefChip
            ariaLabel="Owned by"
            seat={zone.seat}
            definition={definition}
            onChange={(seat) => onChange({ ...zone, seat })}
          />
        </div>
      )}
    </>
  );
}

/** The chip itself: reads as prose, opens the two fields (§6.8). */
export function ZoneRefChip({
  zone,
  onChange,
  definition,
  ariaLabel,
}: {
  zone: ZoneRef;
  onChange: (zone: ZoneRef) => void;
  definition: GameDefinition;
  ariaLabel: string;
}) {
  return (
    <ChipPopover
      label={describeZoneRef(zone, definition)}
      ariaLabel={ariaLabel}
      danger={isDanglingZone(zone, definition)}
    >
      {() => <ZoneRefFields zone={zone} onChange={onChange} definition={definition} label="Zone" />}
    </ChipPopover>
  );
}
