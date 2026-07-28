import { useId } from 'react';
import { BUILTIN_EVENTS } from '../../engine/types';
import type { CriteriaGroup, CriteriaNode, GameDefinition, RuleSet } from '../../engine/types';
import { CriteriaGroupEditor } from '../criteria/CriteriaGroupEditor';
import { FormErrors, InlineNumber, InlineSelect, SelectField } from '../ui/fields';
import { EffectList } from './EffectList';
import { RulesProsePreview } from './RulesProsePreview';

/** Only these two triggers can be narrowed to one state; for the rest `stateFilter` is ignored (§4.7). */
const STATE_TRIGGERS = ['onStateEnter', 'onStateExit'];

/** A bare criteria is a legal condition, but the editor is a group — so wrap it to edit, once. */
const asGroup = (node: CriteriaNode): CriteriaGroup =>
  node.kind === 'group' ? node : { kind: 'group', combinator: 'and', children: [node] };

export interface RuleSetEditorProps {
  rule: RuleSet;
  definition: GameDefinition;
  /** Patches are applied by the caller through the store, so a rejected one changes nothing. */
  onChange: (patch: Partial<Omit<RuleSet, 'id'>>) => void;
  onToggleGlobal: (on: boolean) => void;
  errors: string[];
}

/**
 * WHEN / IF / THEN / READS AS (§6.8).
 *
 * Presentational: it holds no draft state at all. Every control writes through `onChange` to the
 * store and re-renders from what the store accepted, so a rejected edit can never leave the screen
 * showing a rule the definition does not contain.
 */
export function RuleSetEditor({
  rule,
  definition,
  onChange,
  onToggleGlobal,
  errors,
}: RuleSetEditorProps) {
  const globalId = useId();

  // A trigger imported from a file the picker doesn't list still has to be selectable, or opening
  // the rule would silently rewrite it to something else.
  const triggerOptions = [...new Set([...BUILTIN_EVENTS, ...definition.customEvents, rule.trigger])];

  return (
    <div className="cb-rule">
      <FormErrors errors={errors} />

      <section className="cb-rule__band" aria-label="When">
        <h3>When</h3>
        <InlineSelect
          label="Trigger"
          value={rule.trigger}
          options={triggerOptions.map((name) => ({ value: name, label: name }))}
          onChange={(trigger) => onChange({ trigger })}
        />
        {STATE_TRIGGERS.includes(rule.trigger) && (
          <InlineSelect
            label="State"
            value={rule.stateFilter ?? ''}
            options={[
              { value: '', label: 'any state' },
              ...definition.machine.states.map((s) => ({ value: s.id, label: s.name })),
            ]}
            onChange={(id) => onChange({ stateFilter: id === '' ? null : id })}
          />
        )}

        <span className="cb-rule__meta">
          {'priority '}
          <InlineNumber
            label="Priority"
            value={rule.priority}
            onChange={(priority) => onChange({ priority })}
          />
          <span className="cb-hint">higher runs first</span>
        </span>

        <span className="cb-rule__meta">
          <input
            id={globalId}
            type="checkbox"
            checked={definition.globalRuleSetIds.includes(rule.id)}
            onChange={(e) => onToggleGlobal(e.target.checked)}
          />
          <label htmlFor={globalId}>Game-level rule</label>
          <span className="cb-hint">runs from the game itself, before card rules</span>
        </span>
      </section>

      <section className="cb-rule__band" aria-label="If">
        <h3>If</h3>
        {rule.condition === null ? (
          <>
            <span className="cb-hint">Always runs.</span>
            <button
              type="button"
              className="cb-btn"
              onClick={() => onChange({ condition: { kind: 'group', combinator: 'and', children: [] } })}
            >
              Add a condition
            </button>
          </>
        ) : (
          <CriteriaGroupEditor
            node={asGroup(rule.condition)}
            definition={definition}
            onChange={(condition) => onChange({ condition })}
            onDelete={() => onChange({ condition: null })}
          />
        )}
      </section>

      <section className="cb-rule__band" aria-label="Then">
        <h3>Then</h3>
        <SelectField
          label="If an effect is refused"
          value={rule.onRejection}
          options={[
            { value: 'continue', label: 'carry on with the rest' },
            { value: 'abort', label: 'stop the rest of this rule' },
          ]}
          onChange={(onRejection) =>
            onChange({ onRejection: onRejection as RuleSet['onRejection'] })
          }
        />

        <EffectList
          effects={rule.effects}
          definition={definition}
          ruleId={rule.id}
          onChange={(effects) => onChange({ effects })}
        />
      </section>

      <RulesProsePreview rule={rule} definition={definition} />
    </div>
  );
}
