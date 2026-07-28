import type { CardRef, GameDefinition, SeatRef, ValueRef, ZoneRef } from '../../engine/types';

/** Every card index in the definition, with the template that declares it (ids are template-scoped). */
export function allIndexes(def: GameDefinition) {
  return def.templates.flatMap((t) => t.indexes.map((i) => ({ template: t, index: i })));
}

/**
 * §4.1 made the three ref unions mutually recursive: a `SeatRef` can be `owner` of a `CardRef`,
 * which can be the top of a `ZoneRef`, which is seated. So the dangling check descends the same way
 * `schema.ts`'s `checkSeatRef`/`checkCardRef` do — a shallow check on the outermost id leaves a
 * zone deleted from under `SeatRef{kind:'owner'}.card.zone` looking perfectly healthy in the editor.
 */
export const danglingCard = (card: CardRef, def: GameDefinition): boolean =>
  card.kind === 'zoneTop' && danglingZone(card.zone, def);

export const danglingSeat = (seat: SeatRef, def: GameDefinition): boolean => {
  switch (seat.kind) {
    case 'owner':
    case 'controller':
      return danglingCard(seat.card, def);
    case 'relative':
      return danglingSeat(seat.from, def);
    default:
      // active / next / previous / triggeringSeat / seat / all carry no id.
      return false;
  }
};

export const danglingZone = (zone: ZoneRef, def: GameDefinition): boolean =>
  !def.zones.some((z) => z.id === zone.zoneId) ||
  (zone.seat !== null && danglingSeat(zone.seat, def));

/**
 * True when the ref points at something that no longer exists. `describeValueRef` already renders
 * "[deleted pool]"; this is what turns the chip red and strikes it through, so a dangling reference
 * is visible before the designer plays the game (§6.8).
 */
export function isDangling(ref: ValueRef, def: GameDefinition): boolean {
  switch (ref.kind) {
    case 'literal':
      return false;
    case 'pool':
      return (
        !def.pools.some((p) => p.id === ref.poolId) ||
        (ref.seat !== null && danglingSeat(ref.seat, def))
      );
    case 'zoneCount':
      return danglingZone(ref.zone, def);
    case 'cardIndex':
      return (
        !allIndexes(def).some(({ index }) => index.id === ref.indexId) ||
        danglingCard(ref.card, def)
      );
    // A tag is a free-form string declared nowhere (§4.3), so only the card it reads from can dangle.
    case 'cardTag':
      return danglingCard(ref.card, def);
    // `activeSeatCount` reads `seatOrder.length`. `replacedAmount` (v2 §4.2, §5.7) is bound at
    // replacement time. `actionField`'s `ActionRef` (v2 §4.2) addresses a runtime `PendingAction`,
    // not a `GameDefinition` entity. `promptNumber.key` (v2 §4.2, §8 step 28) is free-form like
    // `chooseNumber.key` itself. None of the four carries an authored id, so none can dangle.
    case 'activeSeatCount':
    case 'replacedAmount':
    case 'actionField':
    case 'promptNumber':
      return false;
  }
}
