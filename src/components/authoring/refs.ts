import { describeZoneRef } from '../../engine/prose';
import type { CardRef, GameDefinition, SeatRef } from '../../engine/types';

/**
 * The vocabulary §4.2's ref chips share: what a ref reads as, and where in a rule it sits.
 *
 * Its own module rather than living in either chip, because `SeatRefChip` needs `cardLabel` and
 * `CardRefChip` sits under `SeatRefChip` — one plain module is cheaper than a cycle between two
 * component files, and it keeps both of those exporting components only.
 */

/**
 * §6.11 — where in the rule an editor sits, threaded from the call site rather than through React
 * context: `CriteriaGroupEditor` is used by two unrelated screens, and an implicit provider makes
 * "why is this row offering *the card under test*" invisible where it matters.
 */
export type RefContext = 'candidate' | 'replacement';

/**
 * ponytail: mirrors `prose.ts`'s unexported `describeCardRef`. `src/engine/**` is off-limits this
 * step; collapse the two into one export the next time prose.ts is opened.
 */
export function cardLabel(def: GameDefinition, card: CardRef): string {
  switch (card.kind) {
    case 'triggering':
      return 'this card';
    case 'zoneTop':
      return `the top card of ${describeZoneRef(card.zone, def)}`;
    case 'promptAnswer':
      return 'the chosen card';
    case 'instance':
      return `card ${card.id}`;
    case 'host':
      return 'the card this is attached to';
    case 'candidate':
      return 'the card';
    case 'replacedTarget':
      return 'the replaced target';
    case 'self':
      return 'this card itself';
  }
}

/** ponytail: mirrors `prose.ts`'s unexported `seatNoun`, for the same reason as `cardLabel`. */
export function seatLabel(def: GameDefinition, seat: SeatRef): string {
  switch (seat.kind) {
    case 'active':
      return 'the active player';
    case 'next':
      return 'the next player';
    case 'previous':
      return 'the previous player';
    case 'triggeringSeat':
      return 'the player who played this';
    case 'seat':
      return `player ${seat.index + 1}`;
    case 'relative': {
      const n = Math.abs(seat.offset);
      const seats = `${n} ${n === 1 ? 'seat' : 'seats'}`;
      return `the player ${seats} ${seat.offset >= 0 ? 'after' : 'before'} ${seatLabel(def, seat.from)}`;
    }
    case 'owner':
      return `the owner of ${cardLabel(def, seat.card)}`;
    case 'controller':
      return `the controller of ${cardLabel(def, seat.card)}`;
    case 'all':
      if (seat.quantifier === 'some') return 'any player';
      if (seat.quantifier === 'sum') return 'all players combined';
      return 'each player';
    case 'promptSeat':
      return `the player chosen for "${seat.key}"`;
  }
}
