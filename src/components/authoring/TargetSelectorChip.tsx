import { useId } from 'react';
import { describeTargetSelector } from '../../engine/prose';
import type {
  CriteriaGroup,
  CriteriaNode,
  GameDefinition,
  TargetSelector,
} from '../../engine/types';
import { CriteriaGroupEditor } from '../criteria/CriteriaGroupEditor';
import { ValueRefPicker } from '../criteria/ValueRefPicker';
import { ChipPopover } from '../ui/ChipPopover';
import { CardRefChip } from './CardRefChip';
import type { RefContext } from './refs';
import { ZoneRefFields } from './ZoneRefChip';
import { TARGET_KINDS, danglingTarget, defaultSelector } from './targetSelector';

/** A bare criteria is a legal `where`, but the editor is a group — so wrap it to edit, once. */
const asGroup = (node: CriteriaNode): CriteriaGroup =>
  node.kind === 'group' ? node : { kind: 'group', combinator: 'and', children: [node] };

/**
 * The target chip (§6.8): nine selectors as radio rows, parameters revealed inline only for the ones
 * that take them. One chip, not a second targeting language — `prompt` and `matching` both wrap
 * another selector, so "what may I click" is the same question as "what does this affect".
 *
 * `matching`'s criteria tree is NOT in here. See `TargetSelectorSubRow` below.
 */
export function TargetSelectorChip({
  selector,
  onChange,
  definition,
  ariaLabel,
}: {
  selector: TargetSelector;
  onChange: (next: TargetSelector) => void;
  definition: GameDefinition;
  ariaLabel: string;
}) {
  return (
    <ChipPopover
      label={describeTargetSelector(selector, definition)}
      ariaLabel={ariaLabel}
      danger={danglingTarget(selector, definition)}
    >
      {() => (
        <TargetSelectorFields selector={selector} onChange={onChange} definition={definition} />
      )}
    </ChipPopover>
  );
}

/**
 * §6.11 — a criteria tree nested inside a chip popover would be three groups deep in a box a few
 * centimetres wide, and shrinking it to fit is how it becomes unreadable. So it is rendered by the
 * CALLER, below the effect row at the rule editor's full column width, exactly the way §6.8 gives
 * the `⏸` note its own line beneath the sentence:
 *
 * ```tsx
 * <span className="cb-effect__sentence">… <TargetSelectorChip … /> …</span>
 * <TargetSelectorSubRow selector={effect.target} definition={definition}
 *                       onChange={(target) => onChange({ ...effect, target })} />
 * ```
 *
 * Returns `null` when there is nothing to expand, so callers render it unconditionally — no
 * `if (selector.kind === 'matching')` at any call site.
 *
 * `prompt` and `matching` compose in either order (§4.4), and either can be nested inside the
 * other's popover, so this walks the whole `from` spine rather than looking only at the outermost
 * selector: `matching(prompt(matching(…)))` yields two regions, in the order they read.
 */
export function TargetSelectorSubRow({
  selector,
  onChange,
  definition,
}: {
  selector: TargetSelector;
  onChange: (next: TargetSelector) => void;
  definition: GameDefinition;
}) {
  if (selector.kind === 'prompt' || selector.kind === 'matching') {
    const from = (
      <TargetSelectorSubRow
        selector={selector.from}
        definition={definition}
        onChange={(next) => onChange({ ...selector, from: next })}
      />
    );
    if (selector.kind === 'prompt') return from;
    return (
      <>
        <CriteriaSubRow
          node={selector.where}
          definition={definition}
          // §4.4 — `candidate` is bound once per candidate INSIDE this tree and nowhere else, so
          // this is the one place `CardRefChip` may offer it.
          context="candidate"
          onChange={(where) => onChange({ ...selector, where })}
        />
        {from}
      </>
    );
  }
  return null;
}

/**
 * The expanded region itself, shared verbatim by §6.11's two recursions — `matching.where` above and
 * `ActionSelector{allOnStack}.where` in `ActionSelectorChip`. No second design.
 *
 * `CriteriaGroupEditor`'s depth handling carries over untouched: indent stops growing past depth 3
 * and the number shows instead, which is exactly what a nested tree needs.
 */
export function CriteriaSubRow({
  node,
  onChange,
  definition,
  context,
}: {
  node: CriteriaNode;
  onChange: (next: CriteriaNode) => void;
  definition: GameDefinition;
  context?: RefContext;
}) {
  return (
    <div className="cb-subrow" role="group" aria-label="where">
      <span className="cb-hint">where</span>
      <CriteriaGroupEditor
        node={asGroup(node)}
        definition={definition}
        context={context}
        onChange={onChange}
      />
    </div>
  );
}

function TargetSelectorFields({
  selector,
  onChange,
  definition,
  /** A prompt inside a prompt would suspend twice for one choice; the engine allows it, sense does not. */
  allowPrompt = true,
  /** A filter of a filter is one filter with more conditions; same reasoning, same mechanism. */
  allowMatching = true,
}: {
  selector: TargetSelector;
  onChange: (next: TargetSelector) => void;
  definition: GameDefinition;
  allowPrompt?: boolean;
  allowMatching?: boolean;
}) {
  const name = useId();

  return (
    <>
      <fieldset className="cb-fieldset">
        <legend>Which cards</legend>
        {TARGET_KINDS.map(({ kind, label }) => {
          const fallback = defaultSelector(kind, definition, selector);
          // Disabled with the reason, never hidden — the same discipline as `CardRefChip`.
          const blocked =
            kind === 'prompt' && !allowPrompt
              ? 'one question per choice'
              : kind === 'matching' && !allowMatching
                ? 'add the conditions to the filter above instead'
                : fallback === null
                  ? 'no zones yet'
                  : null;
          return (
            <label key={kind} className="cb-radio">
              <input
                type="radio"
                name={name}
                checked={selector.kind === kind}
                disabled={blocked !== null}
                onChange={() => fallback && onChange(fallback)}
              />
              {label}
              {blocked !== null && <span className="cb-hint"> — {blocked}</span>}
            </label>
          );
        })}
      </fieldset>

      {'zone' in selector && (
        <ZoneRefFields
          zone={selector.zone}
          definition={definition}
          label="Zone"
          onChange={(zone) => onChange({ ...selector, zone })}
        />
      )}

      {selector.kind === 'taggedInZone' && (
        <div className="cb-field">
          <label htmlFor={`${name}-tag`}>Tag</label>
          <input
            id={`${name}-tag`}
            className="cb-input"
            value={selector.tag}
            onChange={(e) => onChange({ ...selector, tag: e.target.value })}
          />
        </div>
      )}

      {/* §4.4 — the attachment relation read in either direction. Neither consults a zone. */}
      {selector.kind === 'attachedTo' && (
        <div className="cb-field">
          <span>Attached to</span>
          <CardRefChip
            card={selector.host}
            definition={definition}
            ariaLabel="Host card"
            onChange={(host) => onChange({ ...selector, host })}
          />
        </div>
      )}

      {selector.kind === 'hostOf' && (
        <div className="cb-field">
          <span>Host of</span>
          <CardRefChip
            card={selector.card}
            definition={definition}
            ariaLabel="Attached card"
            onChange={(card) => onChange({ ...selector, card })}
          />
        </div>
      )}

      {'count' in selector && (
        <div className="cb-field">
          <span>How many</span>
          <ValueRefPicker
            value={selector.count}
            definition={definition}
            ariaLabel="How many cards"
            onChange={(count) => onChange({ ...selector, count })}
          />
        </div>
      )}

      {selector.kind === 'matching' && (
        <>
          <fieldset className="cb-fieldset">
            <legend>Out of</legend>
            <TargetSelectorFields
              selector={selector.from}
              definition={definition}
              allowMatching={false}
              onChange={(from) => onChange({ ...selector, from })}
            />
          </fieldset>
          <p className="cb-hint">The conditions are edited below the rule, not in here.</p>
        </>
      )}

      {selector.kind === 'prompt' && (
        <>
          <div className="cb-field">
            <label htmlFor={`${name}-prompt`}>Ask</label>
            <input
              id={`${name}-prompt`}
              className="cb-input"
              value={selector.promptText}
              onChange={(e) => onChange({ ...selector, promptText: e.target.value })}
            />
          </div>
          <fieldset className="cb-fieldset">
            <legend>Choosing from</legend>
            <TargetSelectorFields
              selector={selector.from}
              definition={definition}
              allowPrompt={false}
              onChange={(from) => onChange({ ...selector, from })}
            />
          </fieldset>
          <p className="cb-hint">
            The rule pauses here until the player answers. Effects after this one run afterwards.
          </p>
        </>
      )}
    </>
  );
}
