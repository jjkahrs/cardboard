import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import { useMemo } from 'react';
import { generateRulesProse } from '../../engine/prose';
import type { CardIndex, CardInstance, CardTemplate, GameDefinition } from '../../engine/types';
import { jitter } from '../../theme/jitter';
import { Icon } from '../icons/Icon';

export interface CardProps {
  template: CardTemplate;
  /** Absent in the catalog and the editor preview — those render the template alone. */
  instance?: CardInstance;
  /**
   * Resolved ABOVE this component, in ZoneView, via engine/visibility.ts (§6.3). Keeping the
   * zone/seat logic out of here is what lets the catalog reuse the identical component with zero
   * play-state coupling. Falls back to the instance's own flag so a caller that forgets cannot
   * accidentally expose a hidden card.
   */
  faceDown?: boolean;
  /**
   * Needed to turn ruleSetIds into prose. §6.3's prop list omits it because it lists only the props
   * that would have tempted someone into a size/variant/mode switch; the prose still has to come
   * from somewhere, and generateRulesProse needs the definition to name pools and zones.
   */
  definition: GameDefinition;
  onClick?: (e: MouseEvent | KeyboardEvent) => void;
}

/**
 * THE card renderer. Catalog, editor preview, hand, table, zoom — all one component (AC: L2).
 *
 * There is no size, variant or mode prop on purpose: size and detail level come entirely from the
 * container (`--cb-card-w` + container queries in card.css). That is what *structurally* guarantees
 * "catalog and play render identically" rather than leaving it to a convention someone breaks.
 */
export function Card({ template, instance, faceDown, definition, onClick }: CardProps) {
  const hidden = faceDown ?? instance?.faceDown ?? false;

  const rulesText = useMemo(() => {
    // The whole "override replaces the generated text without altering the RuleSet" criterion is
    // this `??` — nothing here can write back to ruleSets (AC: A3).
    if (template.rulesTextOverride !== null) return template.rulesTextOverride;
    const ruleSets = template.ruleSetIds
      .map((id) => definition.ruleSets.find((rs) => rs.id === id))
      .filter((rs) => rs !== undefined);
    return generateRulesProse(ruleSets, definition);
  }, [template.rulesTextOverride, template.ruleSetIds, definition]);

  const style = {
    '--cb-card-border': template.borderColor,
    // Deterministic per entity, so the tilt never jumps on a re-render (§6.9). An instance keeps its
    // own tilt; a template in the catalog keeps the template's.
    '--cb-jitter': jitter(instance?.id ?? template.id),
  } as CSSProperties;

  const interactive = onClick !== undefined;

  return (
    <article
      className="cb-card"
      data-face-down={hidden}
      data-rotated={instance?.rotated ?? false}
      style={style}
      // A clickable <article> is invisible to keyboards and to screen readers otherwise. The
      // catalog and editor preview pass no onClick and stay plain static content.
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault(); // Space would scroll the table
              onClick(e);
            }
          : undefined
      }
      // Face-down must not name the card, here or anywhere else in the DOM.
      aria-label={hidden ? 'Face-down card' : undefined}
    >
      <div className="cb-card__tilt">
        <div className="cb-card__rough" aria-hidden="true" />
        {hidden ? (
          // Rendered INSTEAD of the body and pips, never render-then-hide: a hidden-but-present
          // marquee leaks the opponent's hand to Ctrl-F and devtools, which defeats the point of a
          // hot-seat tool (§6.3).
          <div className="cb-card__back" />
        ) : (
          <>
            <div className="cb-card__body">
              <header className="cb-card__marquee">{template.marquee}</header>
              <div className="cb-card__face">
                <Icon id={template.faceIcon} />
              </div>
              {/* Ellipsised at small sizes and hidden below 88px by container query, so the full
                  list has to survive somewhere reachable. */}
              <div className="cb-card__tagline" title={template.tags.join(' · ')}>
                {template.tags.join(' · ')}
              </div>
              <div className="cb-card__rules">{rulesText}</div>
            </div>
            <div className="cb-card__pips">
              {template.indexes.map((index) => (
                <Pip key={index.id} index={index} instance={instance} />
              ))}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

function Pip({ index, instance }: { index: CardIndex; instance?: CardInstance }) {
  const current = instance?.indexValues[index.id] ?? index.value.defaultValue;

  // A false flag renders nothing at all. Showing a greyed "Tapped" pip on every untapped card is
  // noise on a 92px thumbnail, and there is no number to show for a boolean.
  if (index.value.type === 'boolean') {
    if (current !== true) return null;
    return (
      <span className="cb-pip" data-pos={index.position}>
        <Icon id={index.icon} label={index.value.name} />
      </span>
    );
  }

  return (
    <span className="cb-pip" data-pos={index.position}>
      <Icon id={index.icon} label={index.value.name} />
      <b>{String(current)}</b>
    </span>
  );
}
