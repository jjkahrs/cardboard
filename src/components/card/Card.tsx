import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import { Fragment, useMemo } from 'react';
import { generateRulesProse } from '../../engine/prose';
import type { CardIndex, CardInstance, CardTemplate, GameDefinition, Id } from '../../engine/types';
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
  /**
   * §5.4/§6.8. Effective values per index id, from `effectiveIndex()`, resolved in `ZoneView`
   * exactly as `faceDown` already is. Absent in the catalog and the editor preview — a template has
   * no instance and therefore no modifiers to apply — and absent for a face-down card, which
   * renders no values at all. A COMPUTED ANSWER, never state: `<Card>` has no `PlayState` and must
   * not acquire one, or v1 §6.3's "catalog and play render identically" stops being structural.
   */
  effective?: Record<Id, number | boolean>;
  /** §5.4/§6.8. From `effectiveTags()`. Defaults to `template.tags`. */
  tags?: string[];
  onClick?: (e: MouseEvent | KeyboardEvent) => void;
}

/**
 * THE card renderer. Catalog, editor preview, hand, table, zoom — all one component (AC: L2).
 *
 * There is no size, variant or mode prop on purpose: size and detail level come entirely from the
 * container (`--cb-card-w` + container queries in card.css). That is what *structurally* guarantees
 * "catalog and play render identically" rather than leaving it to a convention someone breaks.
 */
export function Card({
  template,
  instance,
  faceDown,
  definition,
  effective,
  tags,
  onClick,
}: CardProps) {
  const hidden = faceDown ?? instance?.faceDown ?? false;
  // The catalog passes nothing and reads the template, which is the whole point of §6.8's default.
  const shownTags = tags ?? template.tags;

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
                  list has to survive somewhere reachable. Per-tag spans rather than one join,
                  because §6.8 wants a tag a rule ADDED at runtime distinguishable from a printed
                  one — the same distinction the boolean pip makes, and by shape, not by colour. */}
              <div className="cb-card__tagline" title={shownTags.join(' · ')}>
                {shownTags.map((tag, i) => (
                  <Fragment key={`${i}-${tag}`}>
                    {i > 0 && ' · '}
                    <span
                      className="cb-card__tag"
                      data-granted={template.tags.includes(tag) ? undefined : true}
                    >
                      {tag}
                    </span>
                  </Fragment>
                ))}
              </div>
              <div className="cb-card__rules">{rulesText}</div>
              {/* Inside the body grid so the overlay can be pinned below the marquee row — a pip
                  anchored to the whole card lands on the title. */}
              <div className="cb-card__pips">
                {template.indexes.map((index) => (
                  <Pip key={index.id} index={index} instance={instance} effective={effective} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </article>
  );
}

/**
 * One index, as the card currently reads (§6.8).
 *
 * The pip cannot name WHICH rule modified it: §5.4 returns a value with no provenance and modifiers
 * are derived at read time, so there is no log line to look it up in. `title` says `base 3` and
 * stops; the answer lives in the Rules library, filtered to rules with a modifier.
 */
function Pip({
  index,
  instance,
  effective,
}: {
  index: CardIndex;
  instance?: CardInstance;
  effective?: Record<Id, number | boolean>;
}) {
  const base = instance?.indexValues[index.id] ?? index.value.defaultValue;
  const current = effective?.[index.id] ?? base;

  if (index.value.type === 'boolean') {
    // An unmodified false flag renders nothing at all. Showing a greyed "Tapped" pip on every
    // untapped card is noise on a 92px thumbnail, and there is no number to show for a boolean.
    if (current !== true && base !== true) return null;
    // Granted reads as a dashed outline, removed as a struck-through pip — SHAPE, so it survives a
    // monochrome print. A removed keyword that simply vanished would be indistinguishable from a
    // card that never had it, so it stays on the card, crossed out.
    const modified = current === base ? undefined : current === true ? 'granted' : 'removed';
    return (
      <span
        className="cb-pip"
        data-pos={index.position}
        data-modified={modified}
        title={modified === undefined ? undefined : `base ${String(base)}`}
      >
        <Icon
          id={index.icon}
          // The outline and the strike are invisible to a screen reader, and announcing a removed
          // keyword by its bare name would state the opposite of the truth.
          label={modified === undefined ? index.value.name : `${index.value.name} (${modified})`}
        />
      </span>
    );
  }

  const delta = typeof current === 'number' && typeof base === 'number' ? current - base : 0;

  return (
    <span
      className="cb-pip"
      data-pos={index.position}
      data-modified={delta === 0 ? undefined : delta > 0 ? 'up' : 'down'}
      title={delta === 0 ? undefined : `base ${String(base)}`}
    >
      <Icon id={index.icon} label={index.value.name} />
      <b>{String(current)}</b>
      {/* The TEXT is the carrier; the green/red tint is redundant reinforcement (§6.9 — colour is
          never the sole carrier of meaning). */}
      {delta !== 0 && <sup className="cb-pip__delta">{delta > 0 ? `+${delta}` : delta}</sup>}
    </span>
  );
}
