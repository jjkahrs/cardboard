import { Fragment, type CSSProperties } from 'react';
import { resolveVisibility } from '../../engine/visibility';
import { effectiveIndex, effectiveTags } from '../../engine/modifiers';
import { evalCriteria } from '../../engine/criteria';
import { activatableRules, activationCtx, type ActivationCandidate } from '../../engine/priority';
import { controllerOf } from '../../engine/seats';
import type {
  CardTemplate,
  GameDefinition,
  Id,
  PlayState,
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
import { ChipPopover } from '../ui/ChipPopover';

export interface ZoneViewProps {
  zone: PlayZone;
  instance: ZoneInstance;
  definition: GameDefinition;
  /**
   * The whole state, not just `cards`: §5.4's `effectiveIndex` / `effectiveTags` are resolved HERE
   * and handed to `<Card>` as computed answers, and a modifier's source can be any card in any
   * zone. One source of truth, so nothing can drift from `state.cards`.
   */
  state: PlayState;
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
  /**
   * §6.7 — fired with a `perInstance` rule's id and its card when its button is clicked. Defaulted
   * to a no-op so every existing call site keeps compiling unchanged; `PlayScreen` wraps this into
   * `dispatch({ kind: 'activate', ruleId, cardId, seat: viewingSeat })`, mirroring `onPlace`/
   * `onCardClick` above — a scoped callback, not a raw `dispatch` prop, matching how this file
   * already exposes engine actions.
   */
  onActivate?: (ruleId: Id, cardId: Id) => void;
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
  state,
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
  onActivate = noop,
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

  // §6.7 — per-instance activation. `priorityOpen` is the CURRENT open window, if any; its id is
  // the `windowId` `activatableRules` probes against (null => sorcery-speed, §4.5's own meaning for
  // `activation.window`). §6.7 doesn't spell out what to do when a priority window is open for a
  // SEAT OTHER than the one we're pinned to, so this gate is a deliberate addition: `activate`
  // (`activation.ts`) rejects NOT_ACTIVATABLE unconditionally on a seat mismatch — no override
  // bypass exists for it, unlike the window-mismatch/eliminated-seat checks right next to it — so
  // rendering a button for the wrong seat would put a control on screen that always fails when
  // pressed, which is worse than no control. This mirrors `InteractionBar`'s own pinned-seat gate
  // (§6.5) and §6.5's wider "nothing on the table is an answer" principle: live only when nothing
  // is suspended, or when the ONE seat currently offered priority is the seat we're pinned to —
  // anyone else's board stays inert until the ring reaches them, exactly like drag already does.
  const priorityOpen = state.interaction?.kind === 'priority' ? state.interaction : null;
  const activationLive = state.interaction === null || priorityOpen?.seat === viewingSeat;
  const activationWindowId = priorityOpen ? priorityOpen.windowId : null;
  // One call for the whole zone, not one per card — `activatableRules` already scans every card in
  // `state.cards` internally (`priority.ts`), so a per-card call would just repeat that scan.
  const activatable = activationLive
    ? activatableRules(state, definition, viewingSeat, activationWindowId)
    : [];

  const cardNodes = (
    <>
      {count === 0 && <span className="cb-zone__empty">empty</span>}

      {visibleIds.map((cardId, i) => {
        const instanceCard = state.cards[cardId];
        if (!instanceCard) return null;
        const template = definition.templates.find((t) => t.id === instanceCard.templateId);
        if (!template) return null;

        const hidden = resolveVisibility(zone, instanceCard, viewingSeat, instance.seat, revealAll);
        // §6.8: NOT computed at all for a face-down card. The value is not in the DOM either way —
        // a hidden card renders `.cb-card__back` instead of its body — but not computing it keeps
        // the §6.2 redaction discipline honest, and skips a modifier scan per card in every
        // opponent's hand.
        const effective = hidden ? undefined : effectiveValues(state, definition, template, cardId);
        const tags = hidden ? undefined : effectiveTags(state, definition, cardId);

        const targetable = legalTargets?.has(cardId) ?? false;
        const isChosen = chosen?.has(cardId) ?? false;
        // While a prompt is open the only legal click is a candidate; otherwise every card is
        // pickable, because click-to-place is a full peer of dragging, not a fallback (§6.5).
        const clickable = legalTargets !== null ? targetable : onCardClick !== undefined;

        // §6.7 — only the pinned seat's OWN cards get activation buttons; an opponent's abilities
        // are not ours to press. This also disposes of the small-band problem for free: the buttons
        // never fit a 92px opponent card, but they're never asked to.
        //
        // `hidden` gates this exactly like `effective`/`tags` above (§6.8/§6.2) — NOT computed at
        // all for a face-down card, same reasoning, one more disclosure it applies to: a label like
        // "Use Equipment" on your own face-down library's top card names the card, and an engine
        // `costCheck` description in the disabled button's `title` can carry the raw card id. The
        // card is hidden; the whole affordance goes with it, not a sanitised version of it.
        const actions =
          !hidden && activationLive && controllerOf(state, cardId) === viewingSeat
            ? instanceActions(state, definition, viewingSeat, cardId, activationWindowId, activatable)
            : [];

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
                faceDown={hidden}
                effective={effective}
                tags={tags}
                onClick={clickable && onCardClick ? () => onCardClick(cardId) : undefined}
              />
              {actions.length > 0 && (
                // Sibling of <Card>, not inside it (§6.7) — <Card> has no size/variant/mode prop,
                // which is the whole guarantee that the catalog and the table render identically
                // (AC: L2), and a play-state-aware button baked into it would break that.
                <div
                  className="cb-card-activate"
                  // The slot above (.cb-card-slot) is the dnd-kit draggable node, so a pointerdown
                  // here would otherwise bubble to the sensor and could start a drag (§6.7). One
                  // handler on the wrapper covers every button AND the ChipPopover trigger below,
                  // which this file has no reach into to add its own.
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {actions.length >= 3 ? (
                    <ChipPopover label="Actions" ariaLabel={`${template.name} actions`}>
                      {(close) =>
                        actions.map((a) => (
                          <button
                            key={a.ruleId}
                            type="button"
                            className="cb-btn"
                            data-variant="ghost"
                            disabled={a.disabled}
                            title={a.title}
                            onClick={() => {
                              onActivate(a.ruleId, cardId);
                              close();
                            }}
                          >
                            {a.label}
                          </button>
                        ))
                      }
                    </ChipPopover>
                  ) : (
                    actions.map((a) => (
                      <button
                        key={a.ruleId}
                        type="button"
                        className="cb-btn"
                        data-variant="ghost"
                        disabled={a.disabled}
                        title={a.title}
                        onClick={() => onActivate(a.ruleId, cardId)}
                      >
                        {a.label}
                      </button>
                    ))
                  )}
                </div>
              )}
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

/** Every index the template declares, as the card currently reads (§5.4). */
function effectiveValues(
  state: PlayState,
  definition: GameDefinition,
  template: CardTemplate,
  cardId: Id
): Record<Id, number | boolean> {
  const out: Record<Id, number | boolean> = {};
  for (const index of template.indexes) {
    out[index.id] = effectiveIndex(state, definition, cardId, index.id);
  }
  return out;
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

function noop(): void {}

interface InstanceAction {
  ruleId: Id;
  label: string;
  disabled: boolean;
  title?: string;
}

/**
 * §6.7 — every `perInstance` rule attached to `cardId`'s template that matches `windowId`,
 * classified against `enabled` (this render's ONE `activatableRules` call, `ZoneView`'s own body).
 * A rule is:
 *  - absent entirely when its `condition` fails — the ability doesn't apply right now, which is a
 *    different claim from "applies but you can't currently pay for it";
 *  - enabled when `activatableRules` already returned it — the one function that decides
 *    "activatable" at all;
 *  - otherwise disabled, with the failing `costCheck` leaf's own description as its `title` — the
 *    exact leaf `evalCriteria` would hand `activation.ts` for its own COST_UNPAYABLE message
 *    (`activation.ts:178-186`), so the tooltip and the eventual rejection reason never disagree.
 *
 * This is elaboration on a "no" `activatableRules` already gave, never a second legality rule: the
 * only thing decided HERE is which of the two reasons a "no" was — condition or cost — and that
 * split uses the identical `evalCriteria` the engine itself calls, not a reimplementation of it.
 */
function instanceActions(
  state: PlayState,
  def: GameDefinition,
  seat: number,
  cardId: Id,
  windowId: Id | null,
  enabled: ActivationCandidate[]
): InstanceAction[] {
  const card = state.cards[cardId];
  const template = card && def.templates.find((t) => t.id === card.templateId);
  if (!template) return [];
  const ctx = activationCtx(seat, cardId);
  const out: InstanceAction[] = [];
  for (const rule of def.ruleSets) {
    const activation = rule.activation;
    if (!activation?.perInstance || activation.window !== windowId) continue;
    if (!template.ruleSetIds.includes(rule.id)) continue;

    if (enabled.some((c) => c.ruleId === rule.id && c.cardId === cardId)) {
      out.push({ ruleId: rule.id, label: activation.label, disabled: false });
      continue;
    }
    if (rule.condition && !evalCriteria(rule.condition, state, ctx, def).value) continue;
    const verdict = activation.costCheck ? evalCriteria(activation.costCheck, state, ctx, def) : null;
    const failing = verdict?.leaves.find((l) => !l.value);
    out.push({ ruleId: rule.id, label: activation.label, disabled: true, title: failing?.description });
  }
  return out;
}
