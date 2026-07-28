import { useId } from 'react';
import { BUILTIN_EVENTS } from '../../engine/types';
import type {
  CriteriaGroup,
  CriteriaNode,
  Effect,
  GameDefinition,
  RuleSet,
} from '../../engine/types';
import { CriteriaGroupEditor } from '../criteria/CriteriaGroupEditor';
import { allIndexes } from '../criteria/isDangling';
import { ValueRefPicker } from '../criteria/ValueRefPicker';
import { FormErrors, InlineNumber, InlineSelect, SelectField } from '../ui/fields';
import { effectLabel } from './effectKinds';
import { EffectList } from './EffectList';
import { RulesProsePreview } from './RulesProsePreview';
import { CriteriaSubRow, TargetSelectorChip, TargetSelectorSubRow } from './TargetSelectorChip';

/** Only these two triggers can be narrowed to one state; for the rest `stateFilter` is ignored (§4.7). */
const STATE_TRIGGERS = ['onStateEnter', 'onStateExit'];

/** A bare criteria is a legal condition, but the editor is a group — so wrap it to edit, once. */
const asGroup = (node: CriteriaNode): CriteriaGroup =>
  node.kind === 'group' ? node : { kind: 'group', combinator: 'and', children: [node] };

const emptyGroup = (): CriteriaGroup => ({ kind: 'group', combinator: 'and', children: [] });

/**
 * §4.5, §6.10 — the five things a rule can be, as ONE choice.
 *
 * `continuous` / `modifier` / `replaces` / `activation` are mutually exclusive and a zod refinement
 * rejects any combination of them. Four independent checkboxes would let a designer author the
 * rejected shape and then be told off for it; a single-select cannot express it at all. Same
 * argument `StateMachineScreen.tsx:16-20` makes for mirrored transition lists.
 */
type RuleMode = 'trigger' | 'continuous' | 'modifier' | 'replacement' | 'activation';

const MODES: { mode: RuleMode; label: string }[] = [
  { mode: 'trigger', label: 'trigger' },
  { mode: 'continuous', label: 'continuous condition' },
  { mode: 'modifier', label: 'value modifier' },
  { mode: 'replacement', label: 'replacement' },
  { mode: 'activation', label: 'activation' },
];

/**
 * §5.7 — the only five effect kinds a replacement can meaningfully intercept.
 *
 * ponytail: mirrors `schema.ts`'s `REPLACEABLE_EFFECT_KINDS`, which is not exported; export it and
 * delete this the next time `src/engine/**` is open. The exhaustiveness gate is the refinement
 * itself — an extra kind here is rejected by the store on the very next edit.
 */
const REPLACEABLE_KINDS: Effect['kind'][] = [
  'drawCards',
  'changePool',
  'moveCards',
  'destroyCards',
  'setCardIndex',
];

const modeOf = (rule: RuleSet): RuleMode =>
  rule.continuous
    ? 'continuous'
    : rule.modifier !== null
      ? 'modifier'
      : rule.replaces !== null
        ? 'replacement'
        : rule.activation !== null
          ? 'activation'
          : 'trigger';

/** Every mode switch sends all four fields, not just the new one — a patch that only sets the new
 *  panel leaves the old one beside it and the refinement rejects the next edit the designer makes. */
const CLEARED = {
  continuous: false,
  modifier: null,
  replaces: null,
  activation: null,
} satisfies Partial<RuleSet>;

export interface RuleSetEditorProps {
  rule: RuleSet;
  definition: GameDefinition;
  /** Patches are applied by the caller through the store, so a rejected one changes nothing. */
  onChange: (patch: Partial<Omit<RuleSet, 'id'>>) => void;
  onToggleGlobal: (on: boolean) => void;
  errors: string[];
}

/**
 * WHEN / IF / THEN / READS AS (§6.8), with the WHEN row swapping on the rule's mode (§6.10).
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
  const modeName = useId();
  const activationLabelId = useId();

  // A trigger imported from a file the picker doesn't list still has to be selectable, or opening
  // the rule would silently rewrite it to something else.
  const triggerOptions = [...new Set([...BUILTIN_EVENTS, ...definition.customEvents, rule.trigger])];

  const mode = modeOf(rule);
  const indexes = allIndexes(definition);

  /** The whole four-field shape for a mode, or null when the game has nothing for it to point at. */
  const patchFor = (next: RuleMode): Partial<Omit<RuleSet, 'id'>> | null => {
    switch (next) {
      case 'trigger':
        return CLEARED;
      case 'continuous':
        return { ...CLEARED, continuous: true };
      case 'modifier': {
        const first = indexes[0];
        if (!first) return null;
        return {
          ...CLEARED,
          modifier: {
            scope: { kind: 'triggeringCard' },
            indexId: first.index.id,
            op: 'adjust',
            amount: { kind: 'literal', value: 1 },
            activeZones: [],
          },
        };
      }
      case 'replacement':
        return { ...CLEARED, replaces: { effectKind: 'drawCards', match: null } };
      case 'activation':
        return {
          ...CLEARED,
          activation: { costCheck: null, cost: [], window: null, perInstance: false, label: 'Activate' },
        };
    }
  };

  const modifier = rule.modifier;
  const replaces = rule.replaces;
  const activation = rule.activation;

  // §5.4 a modifier does its whole job with no effects at all, and §5.7 an empty replacement is
  // "instead, nothing happens" — the prevention case. Only the other three read `effects` as the
  // whole rule, so only for them is an empty list really nothing. (Step 46 fixed the same gate in
  // `RulesProsePreview`.)
  const emptyHint =
    mode === 'modifier'
      ? 'A modifier needs no effects — the panel above is the whole rule.'
      : mode === 'replacement'
        ? 'No effects — the replaced effect is simply prevented.'
        : 'No effects yet — this rule does nothing.';

  return (
    <div className="cb-rule">
      <FormErrors errors={errors} />

      <section className="cb-rule__band" aria-label="Kind">
        <h3>Kind</h3>
        <fieldset className="cb-fieldset">
          <legend>This rule is a</legend>
          {MODES.map(({ mode: value, label }) => {
            const patch = patchFor(value);
            // Disabled with the reason, never hidden — the same discipline as `CardRefChip`.
            const blocked = patch === null ? 'no card indexes yet' : null;
            return (
              <label key={value} className="cb-radio">
                <input
                  type="radio"
                  name={modeName}
                  checked={mode === value}
                  disabled={blocked !== null}
                  onChange={() => patch && onChange(patch)}
                />
                {label}
                {blocked !== null && <span className="cb-hint"> — {blocked}</span>}
              </label>
            );
          })}
        </fieldset>
      </section>

      <section className="cb-rule__band" aria-label="When">
        <h3>When</h3>

        {mode === 'trigger' && (
          <>
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
          </>
        )}

        {/* §4.5 — `trigger` is IGNORED for a continuous rule, so the select is gone rather than
            disabled: a select that does nothing is a worse lie than no select. */}
        {mode === 'continuous' && (
          <span className="cb-hint">whenever the condition below becomes true</span>
        )}

        {modifier !== null && (
          <>
            <span>while</span>
            <TargetSelectorChip
              selector={modifier.scope}
              definition={definition}
              ariaLabel="Which cards are modified"
              onChange={(scope) => onChange({ modifier: { ...modifier, scope } })}
            />
            <InlineSelect
              label="Index"
              value={modifier.indexId}
              // An index deleted out from under an imported rule keeps its own row, so opening the
              // rule cannot silently repoint it at the first index in the game.
              options={
                indexes.some(({ index }) => index.id === modifier.indexId)
                  ? indexes.map(({ template, index }) => ({
                      value: index.id,
                      label: `${index.value.name} (${template.name})`,
                    }))
                  : [{ value: modifier.indexId, label: `${modifier.indexId} (deleted)` }]
              }
              onChange={(indexId) => onChange({ modifier: { ...modifier, indexId } })}
            />
            <InlineSelect
              label="Set or adjust"
              value={modifier.op}
              options={[
                { value: 'adjust', label: 'is adjusted by' },
                { value: 'set', label: 'is set to' },
              ]}
              onChange={(op) =>
                onChange({ modifier: { ...modifier, op: op as 'set' | 'adjust' } })
              }
            />
            <ValueRefPicker
              value={modifier.amount}
              definition={definition}
              ariaLabel="Amount"
              onChange={(amount) => onChange({ modifier: { ...modifier, amount } })}
            />
            <TargetSelectorSubRow
              selector={modifier.scope}
              definition={definition}
              onChange={(scope) => onChange({ modifier: { ...modifier, scope } })}
            />
            <fieldset className="cb-fieldset">
              <legend>Applies while its source is in</legend>
              {definition.zones.length === 0 ? (
                <p className="cb-hint">No zones yet — it applies wherever the source is.</p>
              ) : (
                definition.zones.map((z) => (
                  <label key={z.id} className="cb-radio">
                    <input
                      type="checkbox"
                      checked={modifier.activeZones.includes(z.id)}
                      onChange={(e) =>
                        onChange({
                          modifier: {
                            ...modifier,
                            activeZones: e.target.checked
                              ? [...modifier.activeZones, z.id]
                              : modifier.activeZones.filter((id) => id !== z.id),
                          },
                        })
                      }
                    />
                    {z.name}
                  </label>
                ))
              )}
              <span className="cb-hint">None ticked — applies wherever the source is.</span>
            </fieldset>
          </>
        )}

        {replaces !== null && (
          <>
            <span>a</span>
            <InlineSelect
              label="Replaced effect"
              value={replaces.effectKind}
              // §5.7 — the other kinds are not offered at all: replacing "fire an event" has no
              // meaning the engine could honour, and the refinement rejects it anyway.
              options={REPLACEABLE_KINDS.map((kind) => ({ value: kind, label: effectLabel(kind) }))}
              onChange={(kind) =>
                onChange({ replaces: { ...replaces, effectKind: kind as Effect['kind'] } })
              }
            />
            <span>would apply</span>
            {/* §6.11 — `replacedAmount` / `replacedTarget` bind HERE and nowhere else, which is
                exactly what `context` gates in `ValueRefPicker` and `CardRefChip`. */}
            <CriteriaSubRow
              node={replaces.match ?? emptyGroup()}
              definition={definition}
              context="replacement"
              onChange={(match) => onChange({ replaces: { ...replaces, match } })}
            />
          </>
        )}

        {activation !== null && (
          <>
            <div className="cb-field">
              <label htmlFor={activationLabelId}>Button label</label>
              <input
                id={activationLabelId}
                className="cb-input"
                value={activation.label}
                onChange={(e) => onChange({ activation: { ...activation, label: e.target.value } })}
              />
            </div>

            {/* null means "only outside a window" (§4.5), so with no windows authored there is
                nothing to choose — disabled with the reason rather than a select of one lie. */}
            {definition.priorityWindows.length === 0 ? (
              <span className="cb-rule__meta">
                <select className="cb-inline-select" aria-label="Priority window" disabled />
                <span className="cb-hint">
                  no priority windows yet — usable only outside a window
                </span>
              </span>
            ) : (
              <InlineSelect
                label="Priority window"
                value={activation.window ?? ''}
                options={[
                  { value: '', label: 'only outside a window' },
                  ...definition.priorityWindows.map((w) => ({ value: w.id, label: w.name })),
                ]}
                onChange={(id) =>
                  onChange({ activation: { ...activation, window: id === '' ? null : id } })
                }
              />
            )}

            <span className="cb-rule__meta">
              <label className="cb-radio">
                <input
                  type="checkbox"
                  checked={activation.perInstance}
                  onChange={(e) =>
                    onChange({ activation: { ...activation, perInstance: e.target.checked } })
                  }
                />
                A button on each card carrying this
              </label>
            </span>

            <div className="cb-subrow" role="group" aria-label="Cost check">
              <span className="cb-hint">only if</span>
              <CriteriaGroupEditor
                node={asGroup(activation.costCheck ?? emptyGroup())}
                definition={definition}
                onChange={(costCheck) => onChange({ activation: { ...activation, costCheck } })}
                onDelete={
                  activation.costCheck === null
                    ? undefined
                    : () => onChange({ activation: { ...activation, costCheck: null } })
                }
              />
            </div>

            {/* §5.8 — a bare `Effect[]`, which is precisely why `EffectList` takes one. */}
            <EffectList
              effects={activation.cost}
              definition={definition}
              ruleId={rule.id}
              label="Cost"
              addLabel="Add a cost effect"
              emptyHint="Free — no cost effects yet."
              onChange={(cost) => onChange({ activation: { ...activation, cost } })}
            />
          </>
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
          emptyHint={emptyHint}
          onChange={(effects) => onChange({ effects })}
        />
      </section>

      <RulesProsePreview rule={rule} definition={definition} />
    </div>
  );
}
