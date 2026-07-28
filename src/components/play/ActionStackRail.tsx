import { useState } from 'react';
import type { GameDefinition, Id, PlayState, PlayZone, ZoneInstance } from '../../engine/types';
import { parseZoneKey } from '../../engine/valueRef';
import { resolveVisibility } from '../../engine/visibility';
import { useUiStore } from '../../stores/uiStore';

/**
 * Step 36 — the pending-action rail (§6.4). Above `EventLogPanel` in the right rail, reading
 * `viewingSeat`/`revealAll` from `useUiStore` itself, same precedent as `InteractionBar`.
 *
 * **Renders nothing when `state.actionStack` is empty** — every v1-shaped game (nothing ever
 * announces an action) sees precisely the v1 right rail, at zero cost.
 */
export function ActionStackRail({ definition, state }: { definition: GameDefinition; state: PlayState }) {
  const viewingSeat = useUiStore((s) => s.viewingSeat);
  const revealAll = useUiStore((s) => s.revealAll);
  // The one piece of hover state (§6.4): holds the id of the ACTION a hovered target note points
  // at, so that row alone picks up `data-targeted`. No SVG connectors.
  const [targetedId, setTargetedId] = useState<Id | null>(null);

  if (state.actionStack.length === 0) return null;

  // "last placed, first resolved" (§4.10) — reversed is resolution order, top-down.
  const order = [...state.actionStack].reverse();

  return (
    <aside className="cb-panel cb-action-rail" aria-label="Pending actions">
      <span className="cb-rough" aria-hidden="true" />
      <h2>Pending actions</h2>

      {order.map((actionId, i) => {
        const action = state.pendingActions[actionId];
        if (!action) return null; // defensive — actionStack should never name a missing record

        const rule = definition.ruleSets.find((r) => r.id === action.ruleId);
        const sourceCard = action.sourceCardId ? state.cards[action.sourceCardId] : null;
        const sourceTemplate = sourceCard
          ? definition.templates.find((t) => t.id === sourceCard.templateId)
          : null;
        const targetIds = Object.values(action.targets).flat();

        return (
          <article
            key={actionId}
            className="cb-action-rail__row"
            data-action-id={actionId}
            data-countered={action.countered}
            data-targeted={actionId === targetedId}
          >
            <header className="cb-action-rail__head">
              <span className="cb-action-rail__ordinal">{rowLabel(i)}</span>
              <strong>P{action.controller + 1}</strong>
              <span className="cb-action-rail__name">{rule?.name ?? action.ruleId}</span>
              {/* "the source card's template marquee, or nothing when sourceCardId is null" (§6.4) —
                  `template.marquee` IS that literal string (types.ts's own name for the field), not a
                  separate rendered widget. */}
              {sourceTemplate && <em>{sourceTemplate.marquee}</em>}
            </header>

            {targetIds.length > 0 && (
              <p className="cb-action-rail__targets">
                Targets:{' '}
                {targetIds.map((id, ti) => {
                  const comma = ti < targetIds.length - 1 ? ', ' : '';
                  // "an entry whose target id matches another entry's id" (§6.4) — the countering
                  // action targeting the countered one. Checked against THIS row set, not a second
                  // `state.pendingActions` lookup, so a resolved-and-popped action degrades to "a
                  // card" (below) rather than pointing at a row that no longer exists.
                  const refIndex = order.indexOf(id);
                  if (refIndex !== -1) {
                    return (
                      <span
                        key={id}
                        onMouseEnter={() => setTargetedId(id)}
                        onMouseLeave={() => setTargetedId(null)}
                      >
                        ↑ targets {rowLabel(refIndex)}
                        {comma}
                      </span>
                    );
                  }
                  return (
                    <span key={id}>
                      {targetLabel(id, state, definition, viewingSeat, revealAll)}
                      {comma}
                    </span>
                  );
                })}
              </p>
            )}

            {action.tags.length > 0 && (
              <p className="cb-action-rail__tags">
                {action.tags.map((tag) => (
                  <span key={tag} className="cb-chip">
                    {tag}
                  </span>
                ))}
              </p>
            )}

            {/* Stays visible until the `resolve` frame removes it (§4.10/§3.4) — this component does
                no filtering of its own. The strikethrough is CSS keyed off `data-countered` above. */}
            {action.countered && (
              <p className="cb-action-rail__countered">
                <span aria-hidden="true">✖</span> countered — removed without applying
              </p>
            )}
          </article>
        );
      })}
    </aside>
  );
}

/** ①…⑳ (U+2460..U+2473); the top of resolution order is spelled out instead (§6.4). */
function rowLabel(i: number): string {
  if (i === 0) return 'resolves next';
  // ponytail: a rail of >20 stacked actions is already an authoring smell — falls back to "(n)"
  // rather than growing a second numbering scheme past the circled-digit block.
  return i <= 20 ? String.fromCodePoint(0x2460 + i - 1) : `(${i})`;
}

/**
 * Redaction reuses `resolveVisibility` (§6.4) — the same call `ZoneView` makes — rather than a
 * second rule. `id` may be a target that no longer exists (the card was destroyed after the
 * action froze it): that degrades to "a card" the same as a hidden one, never to a crash.
 */
function targetLabel(
  id: Id,
  state: PlayState,
  definition: GameDefinition,
  viewingSeat: number,
  revealAll: boolean
): string {
  const card = state.cards[id];
  if (!card) return 'a card';
  const template = definition.templates.find((t) => t.id === card.templateId);
  if (!template) return 'a card';
  const located = findCardZone(state, definition, id);
  // No located zone is treated as hidden, not visible — redact by default rather than leak.
  const hidden = located === null || resolveVisibility(located.zone, card, viewingSeat, located.instance.seat, revealAll);
  return hidden ? 'a card' : template.name;
}

/**
 * ponytail: linear scan of every zone, same shape and same justification as `effects.ts`'s
 * `zoneKeyOf` — a `cardId -> ZoneKey` index would be a second source of truth to keep in sync with
 * `PlayState.zones`, and at playtest sizes the scan is free. Add the index if a profile says
 * otherwise.
 */
function findCardZone(
  state: PlayState,
  definition: GameDefinition,
  cardId: Id
): { zone: PlayZone; instance: ZoneInstance } | null {
  for (const key of Object.keys(state.zones)) {
    const instance = state.zones[key];
    if (!instance.cardIds.includes(cardId)) continue;
    const zone = definition.zones.find((z) => z.id === parseZoneKey(key).zoneId);
    return zone ? { zone, instance } : null;
  }
  return null;
}
