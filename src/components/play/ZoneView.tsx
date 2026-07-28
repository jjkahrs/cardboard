import { Fragment, type CSSProperties } from 'react';
import { resolveVisibility } from '../../engine/visibility';
import type {
  CardInstance,
  GameDefinition,
  Id,
  PlayZone,
  ZoneInstance,
  ZoneKey,
} from '../../engine/types';
import { zoneKey } from '../../engine/valueRef';
import { STACK_VISIBLE, fanTransform, rowOverlap, stackOffset } from '../../theme/layout';
import { Card } from '../card/Card';
import { CardDraggable } from '../dnd/CardDraggable';
import { GapDroppable } from '../dnd/GapDroppable';
import { ZoneDroppable, type DropState } from '../dnd/ZoneDroppable';
import { zoneInstanceLabel, type MoveDestination } from '../dnd/destinations';

export interface ZoneViewProps {
  zone: PlayZone;
  instance: ZoneInstance;
  definition: GameDefinition;
  cards: Record<Id, CardInstance>;
  viewingSeat: number;
  revealAll: boolean;
  /** Ids the engine would accept as a prompt answer right now; `null` when no prompt is open. */
  legalTargets?: Set<Id> | null;
  chosen?: Set<Id>;
  onCardClick?: (cardId: Id) => void;
  /** Where the carried card may go, by zone key; `null` when nothing is being carried (§6.5). */
  destinations?: Map<ZoneKey, MoveDestination> | null;
  /** Click-to-place is active — render the numbered badge. Drag styling needs no badge. */
  placing?: boolean;
  /** The tester's override flag: turns a capacity refusal from a block into a warning (AC: M4). */
  override?: boolean;
  onPlace?: (destination: MoveDestination) => void;
  /** The card picked up by click-to-place, so the table shows what is in hand. */
  heldCardId?: Id | null;
  /** False while the engine is suspended on a prompt — the only interaction then is choosing. */
  dragEnabled?: boolean;
}

/**
 * One zone instance and its cards (§6.4, §6.5).
 *
 * Visibility is resolved HERE and handed to `<Card>` as a plain boolean (§6.3) — the card renderer
 * knows nothing about zones, seats or reveal-all, which is what lets the catalog render the very
 * same component.
 */
export function ZoneView({
  zone,
  instance,
  definition,
  cards,
  viewingSeat,
  revealAll,
  legalTargets = null,
  chosen,
  onCardClick,
  destinations = null,
  placing = false,
  override = false,
  onPlace,
  heldCardId = null,
  dragEnabled = false,
}: ZoneViewProps) {
  const count = instance.cardIds.length;
  const full = zone.maxCapacity !== null && count >= zone.maxCapacity;
  // A stack renders only its top three; the count in the header carries the truth, so a 40-card
  // deck is three DOM nodes rather than forty (§6.4).
  const visibleIds =
    zone.layout === 'stack' ? instance.cardIds.slice(0, STACK_VISIBLE) : instance.cardIds;

  const key = zoneKey(zone.id, instance.seat);
  const label = zoneInstanceLabel(zone.name, instance.seat);

  const destination = destinations?.get(key) ?? null;
  const drop: DropState | undefined = destination
    ? destination.blocked === null
      ? 'ok'
      : override
        ? 'override'
        : 'reject'
    : undefined;
  // A refused drop is refused in the UI, not dispatched and bounced: the tester sees the red
  // dashed edge and the capacity in the tooltip rather than hunting for a rejection in the log.
  // Turning override on re-opens it, and the engine still writes the ⚑ flag (AC: M4).
  const dropDisabled = destination === null || drop === 'reject';

  // Ordered zones get the n+1 gap droppables so the insert index is explicit; a stack gets exactly
  // two, its top and bottom edges. Everything else is one droppable over the zone (§6.5).
  // ponytail: `grid` is excluded even when ordered — thin gap items would break its auto-fill
  // tracks. Upgrade path if an ordered grid zone ever needs precise inserts: absolutely position
  // the gaps over the grid instead of making them children of it.
  const useGaps = zone.ordered && zone.layout !== 'grid';
  const gapIndices =
    count === 0 ? [0] : zone.layout === 'stack' ? [0, count] : rangeInclusive(count);

  const cardNodes = (
    <>
      {count === 0 && <span className="cb-zone__empty">empty</span>}

      {visibleIds.map((cardId, i) => {
        const instanceCard = cards[cardId];
        if (!instanceCard) return null;
        const template = definition.templates.find((t) => t.id === instanceCard.templateId);
        if (!template) return null;

        const targetable = legalTargets?.has(cardId) ?? false;
        const isChosen = chosen?.has(cardId) ?? false;
        // While a prompt is open the only legal click is a candidate; otherwise every card is
        // pickable, because click-to-place is a full peer of dragging, not a fallback (§6.5).
        const clickable = legalTargets !== null ? targetable : onCardClick !== undefined;

        return (
          // Keyed by card id, NEVER by array index: an unordered zone reorders on unrelated
          // state changes and index keys make React reconcile the wrong nodes (§9.4 item 16).
          <Fragment key={cardId}>
            <CardDraggable
              cardId={cardId}
              disabled={!dragEnabled}
              className="cb-card-slot"
              style={slotStyle(zone.layout, i, visibleIds.length)}
              data-legal-target={targetable ? true : undefined}
              data-chosen={isChosen}
              data-held={cardId === heldCardId || undefined}
            >
              <Card
                template={template}
                instance={instanceCard}
                definition={definition}
                faceDown={resolveVisibility(zone, instanceCard, viewingSeat, instance.seat, revealAll)}
                onClick={clickable && onCardClick ? () => onCardClick(cardId) : undefined}
              />
            </CardDraggable>
            {/* A stack is one pile with two edges, so it gets its two gaps outside this map —
                emitting a per-card gap here as well would mint a SECOND droppable with the same id
                as its bottom edge, and duplicate ids are undefined behaviour in dnd-kit. */}
            {useGaps && zone.layout !== 'stack' && (
              <GapDroppable zoneKey={key} index={i + 1} drop={drop} disabled={dropDisabled} />
            )}
          </Fragment>
        );
      })}
    </>
  );

  const cardsStyle = { '--cb-overlap': rowOverlap(count) } as CSSProperties;

  return (
    <section className="cb-zone" data-full={full} aria-label={label}>
      <header className="cb-zone__head">
        <span className="cb-zone__name">{label}</span>
        <span className="cb-zone__count" data-full={full}>
          {zone.maxCapacity === null ? count : `${count}/${zone.maxCapacity}`}
        </span>
        {placing && destination && (
          <button
            type="button"
            className="cb-drop-badge"
            data-drop={drop}
            disabled={drop === 'reject'}
            title={destination.blocked ?? undefined}
            aria-label={
              destination.blocked === null
                ? `Move here: ${label} (press ${destination.ordinal})`
                : `Can’t move here: ${label} — ${destination.blocked}`
            }
            onClick={() => onPlace?.(destination)}
          >
            {destination.ordinal}
          </button>
        )}
      </header>

      {useGaps ? (
        <div className="cb-zone__cards" data-layout={zone.layout} style={cardsStyle}>
          <GapDroppable zoneKey={key} index={gapIndices[0]} drop={drop} disabled={dropDisabled} />
          {cardNodes}
          {/* A stack shows only its top three, so its bottom-edge gap cannot be interleaved with
              the cards — it is the zone's real length, appended once. */}
          {zone.layout === 'stack' && gapIndices.length > 1 && (
            <GapDroppable zoneKey={key} index={gapIndices[1]} drop={drop} disabled={dropDisabled} />
          )}
        </div>
      ) : (
        <ZoneDroppable
          zoneKey={key}
          drop={drop}
          disabled={dropDisabled}
          className="cb-zone__cards"
          data-layout={zone.layout}
          style={cardsStyle}
        >
          {cardNodes}
        </ZoneDroppable>
      )}
    </section>
  );
}

function rangeInclusive(n: number): number[] {
  return Array.from({ length: n + 1 }, (_, i) => i);
}

function slotStyle(layout: PlayZone['layout'], i: number, n: number): CSSProperties {
  if (layout === 'stack') {
    const { x, y } = stackOffset(n - 1 - i); // index 0 is the top card, so it sits highest
    return { '--cb-stack-x': x, '--cb-stack-y': y, zIndex: n - i } as CSSProperties;
  }
  if (layout === 'fan') {
    const { rot, lift } = fanTransform(i, n);
    return { '--cb-fan-rot': rot, '--cb-fan-lift': lift } as CSSProperties;
  }
  return {};
}
