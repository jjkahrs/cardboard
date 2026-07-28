import type { GameDefinition, SeatRef } from '../../engine/types';

/** A SeatRef as one select value. `seat:2` keeps the index in the string, so there is one control. */
export const seatToOption = (seat: SeatRef): string =>
  seat.kind === 'seat' ? `seat:${seat.index}` : seat.kind;

export const optionToSeat = (option: string): SeatRef =>
  option.startsWith('seat:')
    ? { kind: 'seat', index: Number(option.slice(5)) }
    : ({ kind: option } as SeatRef);

/** The one option list, shared by the labelled field form and the inline mid-sentence form. */
export const seatOptions = (definition: GameDefinition): { value: string; label: string }[] => [
  { value: 'active', label: 'the active player' },
  { value: 'triggeringSeat', label: 'the triggering seat' },
  { value: 'next', label: 'the next player' },
  { value: 'previous', label: 'the previous player' },
  { value: 'all', label: 'every player' },
  ...Array.from({ length: definition.playerCount }, (_, i) => ({
    value: `seat:${i}`,
    label: `seat ${i}`,
  })),
];
