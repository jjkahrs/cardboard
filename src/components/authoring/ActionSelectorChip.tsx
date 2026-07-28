import { useId } from 'react';
import { describeCriteria } from '../../engine/prose';
import type { ActionRef, ActionSelector, GameDefinition } from '../../engine/types';
import { danglingCriteria } from '../criteria/isDangling';
import { ChipPopover } from '../ui/ChipPopover';
import { SelectField } from '../ui/fields';
import { CriteriaSubRow } from './TargetSelectorChip';

const KINDS: { kind: ActionSelector['kind']; label: string }[] = [
  { kind: 'action', label: 'One particular action' },
  { kind: 'allOnStack', label: 'Every action on the stack' },
];

/**
 * `{kind:'action', id}` names a runtime id no author can know, so it is omitted for exactly the
 * reason `ValueRefPicker` omits it from `actionField` (§6.10).
 */
const ACTION_REFS: { value: ActionRef['kind']; label: string }[] = [
  { value: 'triggeringAction', label: 'the action this is responding to' },
  { value: 'topOfStack', label: 'the top action on the stack' },
];

/**
 * ponytail: mirrors `prose.ts`'s unexported `describeActionRef` / `describeActionSelector`, the same
 * way and for the same reason `refs.ts`'s `cardLabel` mirrors `describeCardRef` — `src/engine/**` is
 * off-limits this step. Collapse them the next time `prose.ts` is opened.
 */
const actionRefLabel = (ref: ActionRef): string =>
  ref.kind === 'triggeringAction'
    ? 'the action this is responding to'
    : ref.kind === 'topOfStack'
      ? 'the top action on the stack'
      : `action ${ref.id}`;

function actionSelectorLabel(selector: ActionSelector, def: GameDefinition): string {
  if (selector.kind === 'action') return actionRefLabel(selector.ref);
  return selector.where === null
    ? 'every action on the stack'
    : `every action on the stack where ${describeCriteria(selector.where, def)}`;
}

/** Only `allOnStack`'s tree carries authored ids; an `ActionRef` addresses a runtime action. */
const danglingAction = (selector: ActionSelector, def: GameDefinition): boolean =>
  selector.kind === 'allOnStack' &&
  selector.where !== null &&
  danglingCriteria(selector.where, def);

/**
 * "Which pending action" as a chip (§6.10). A pending action (§4.8) is not a `CardInstance` and has
 * no zone, so nothing in `TargetSelectorChip` applies to it — hence its own chip rather than another
 * row in that one.
 *
 * `allOnStack`'s filter tree is NOT in the popover. See `ActionSelectorSubRow`.
 */
export function ActionSelectorChip({
  selector,
  onChange,
  definition,
  ariaLabel,
}: {
  selector: ActionSelector;
  onChange: (next: ActionSelector) => void;
  definition: GameDefinition;
  ariaLabel: string;
}) {
  const name = useId();

  return (
    <ChipPopover
      label={actionSelectorLabel(selector, definition)}
      ariaLabel={ariaLabel}
      danger={danglingAction(selector, definition)}
    >
      {() => (
        <>
          <fieldset className="cb-fieldset">
            <legend>Which actions</legend>
            {KINDS.map(({ kind, label }) => (
              <label key={kind} className="cb-radio">
                <input
                  type="radio"
                  name={name}
                  checked={selector.kind === kind}
                  onChange={() =>
                    onChange(
                      kind === 'action'
                        ? { kind: 'action', ref: { kind: 'topOfStack' } }
                        : { kind: 'allOnStack', where: null }
                    )
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>

          {selector.kind === 'action' && (
            <SelectField
              label="Action"
              value={selector.ref.kind}
              // An imported `{kind:'action', id}` keeps its own row so the select never renders
              // blank; it is not otherwise offered.
              options={
                selector.ref.kind === 'action'
                  ? [...ACTION_REFS, { value: 'action', label: `action ${selector.ref.id}` }]
                  : ACTION_REFS
              }
              onChange={(kind) =>
                kind !== 'action' &&
                onChange({
                  kind: 'action',
                  ref: { kind: kind as 'triggeringAction' | 'topOfStack' },
                })
              }
            />
          )}

          {selector.kind === 'allOnStack' && (
            <>
              {/* `where: null` is "all of them", so it is a checkbox rather than an empty tree with
                  a magic meaning — the same call §6.9 makes for `passesToClose: null`. */}
              <label className="cb-radio">
                <input
                  type="checkbox"
                  checked={selector.where !== null}
                  onChange={(e) =>
                    onChange({
                      kind: 'allOnStack',
                      where: e.target.checked
                        ? { kind: 'group', combinator: 'and', children: [] }
                        : null,
                    })
                  }
                />
                Only the ones matching a filter
              </label>
              {selector.where !== null && (
                <p className="cb-hint">The conditions are edited below the rule, not in here.</p>
              )}
            </>
          )}
        </>
      )}
    </ChipPopover>
  );
}

/**
 * §6.11 Recursion 2 — the identical expanded-sub-row mechanism `TargetSelectorSubRow` uses, on the
 * identical seam. No second design: the caller renders this below the effect row and it returns
 * `null` when there is nothing to expand.
 *
 * No `context`: `candidate` binds only inside a `matching` selector (§4.4), and there is no card
 * under test here — an action criteria tree reads `actionField`.
 */
export function ActionSelectorSubRow({
  selector,
  onChange,
  definition,
}: {
  selector: ActionSelector;
  onChange: (next: ActionSelector) => void;
  definition: GameDefinition;
}) {
  if (selector.kind !== 'allOnStack' || selector.where === null) return null;
  return (
    <CriteriaSubRow
      node={selector.where}
      definition={definition}
      onChange={(where) => onChange({ kind: 'allOnStack', where })}
    />
  );
}
