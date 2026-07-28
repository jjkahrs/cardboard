import type { GameDefinition, ValueRef } from '../../engine/types';

/** Every card index in the definition, with the template that declares it (ids are template-scoped). */
export function allIndexes(def: GameDefinition) {
  return def.templates.flatMap((t) => t.indexes.map((i) => ({ template: t, index: i })));
}

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
      return !def.pools.some((p) => p.id === ref.poolId);
    case 'zoneCount':
      return !def.zones.some((z) => z.id === ref.zone.zoneId);
    case 'cardIndex':
      return !allIndexes(def).some(({ index }) => index.id === ref.indexId);
    // `activeSeatCount` reads `seatOrder.length`; a tag is a free-form string declared nowhere
    // (§4.3). `replacedAmount` (v2 §4.2, §5.7) is bound at replacement time. `actionField`'s
    // `ActionRef` (v2 §4.2) addresses a runtime `PendingAction`, not a `GameDefinition` entity.
    // None of the four carries an authored id, so none can dangle.
    case 'activeSeatCount':
    case 'cardTag':
    case 'replacedAmount':
    case 'actionField':
      return false;
  }
}
