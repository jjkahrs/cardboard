import type {
  CardRef,
  CriteriaNode,
  GameDefinition,
  SeatRef,
  TargetSelector,
  ValueRef,
  ZoneRef,
} from '../../engine/types';

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
    // v4 §4.1 — both sub-trees are collapsed into the chip's one-line label when the popover is
    // shut, so a pool deleted from under `arith.right` or a zone deleted from under a fold's
    // selector is invisible until play unless the descent happens here. Same argument, and the same
    // answer, as `danglingCriteria` below.
    case 'arith':
      return isDangling(ref.left, def) || isDangling(ref.right, def);
    case 'countMatching':
      return danglingTarget(ref.from, def);
    case 'sumIndex':
      return (
        !allIndexes(def).some(({ index }) => index.id === ref.indexId) ||
        danglingTarget(ref.from, def)
      );
  }
}

/**
 * §6.11 — a whole criteria tree, for the two places one is nested inside a chip
 * (`TargetSelector{matching}.where`, `ActionSelector{allOnStack}.where`). The chip is red when
 * ANY ref anywhere in the tree dangles, because the tree is collapsed into a one-line summary and
 * a broken ref three groups deep is otherwise invisible until play.
 */
export const danglingCriteria = (node: CriteriaNode, def: GameDefinition): boolean =>
  node.kind === 'group'
    ? node.children.some((child) => danglingCriteria(child, def))
    : isDangling(node.left, def) || isDangling(node.right, def);

/**
 * Points at something deleted — what turns the target chip red instead of silently breaking at play.
 *
 * Lives here rather than in `targetSelector.ts` (which re-exports it, so no call site moved) because
 * v4 §4.1 gave `ValueRef` two arms that hold a `TargetSelector`: with it there, `isDangling` above
 * had to import it, and `isDangling.ts -> targetSelector.ts -> zoneRef.ts -> isDangling.ts` is a
 * cycle whose middle link is an `export const` alias — evaluated, not hoisted, so it snapshots
 * `undefined`. Every dependency this function has was already in this file.
 */
export function danglingTarget(selector: TargetSelector, definition: GameDefinition): boolean {
  switch (selector.kind) {
    case 'triggeringCard':
      return false;
    case 'prompt':
      return danglingTarget(selector.from, definition);
    // §4.4's attachment selectors name a card, not a zone — but the CardRef they name can still
    // carry a deleted zone through `zoneTop`, so the descent is `danglingCard`'s, not a zone check.
    case 'attachedTo':
      return danglingCard(selector.host, definition);
    case 'hostOf':
      return danglingCard(selector.card, definition);
    // §4.4's predicate selector wraps another one AND holds a criteria tree; either half can dangle,
    // and the tree is collapsed to a summary on the chip, so nothing else would show it.
    case 'matching':
      return (
        danglingTarget(selector.from, definition) ||
        danglingCriteria(selector.where, definition)
      );
    default:
      return danglingZone(selector.zone, definition);
  }
}
