import { useId } from 'react';
import { describeTargetSelector } from '../../engine/prose';
import type { GameDefinition, TargetSelector } from '../../engine/types';
import { ValueRefPicker } from '../criteria/ValueRefPicker';
import { ChipPopover } from '../ui/ChipPopover';
import { ZoneRefFields } from './ZoneRefChip';
import { TARGET_KINDS, danglingTarget, defaultSelector } from './targetSelector';

/**
 * The target chip (§6.8): six selectors as radio rows, parameters revealed inline only for the ones
 * that take them. One chip, not a second targeting language — `prompt` wraps another selector, so
 * "what may I click" is the same question as "what does this affect".
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

function TargetSelectorFields({
  selector,
  onChange,
  definition,
  /** A prompt inside a prompt would suspend twice for one choice; the engine allows it, sense does not. */
  allowPrompt = true,
}: {
  selector: TargetSelector;
  onChange: (next: TargetSelector) => void;
  definition: GameDefinition;
  allowPrompt?: boolean;
}) {
  const name = useId();

  return (
    <>
      <fieldset className="cb-fieldset">
        <legend>Which cards</legend>
        {TARGET_KINDS.filter(({ kind }) => allowPrompt || kind !== 'prompt').map(({ kind, label }) => {
          const fallback = defaultSelector(kind, definition, selector);
          return (
            <label key={kind} className="cb-radio">
              <input
                type="radio"
                name={name}
                checked={selector.kind === kind}
                disabled={fallback === null}
                onChange={() => fallback && onChange(fallback)}
              />
              {label}
              {fallback === null && <span className="cb-hint"> — no zones yet</span>}
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
