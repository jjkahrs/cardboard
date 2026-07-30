import type { Effect, GameDefinition, Id } from '../../engine/types';
import { moveItem } from './effectKinds';
import { EffectPicker } from './EffectPicker';
import { EffectRow } from './EffectRow';

export interface EffectListProps {
  effects: Effect[];
  definition: GameDefinition;
  /** The whole new list. Deliberately not a patch: the caller owns where the array lives. */
  onChange: (effects: Effect[]) => void;
  /** Accessible name of the `<ol>`. Two lists on one screen have to be tellable apart. */
  label?: string;
  /** Accessible name of the `[+ effect ▾]` picker, for the same reason. */
  addLabel?: string;
  /** Shown in place of the list when it is empty. */
  emptyHint?: string;
  /** §6.11 — how many effect lists deep this one sits. `chooseMode` is refused at depth 1. */
  depth?: number;
  /** v4 §4.5 — this list is a `RuleSet.activation.cost`, which still refuses three kinds. */
  inCost?: boolean;
  /** The rule this list belongs to, so an `announceAction` naming it can warn (§6.10). */
  ruleId?: Id;
}

/**
 * §6.11 recursion 3 — an ordered list of effects with its picker and its reorder controls, extracted
 * from `RuleSetEditor` so it can be used where there is no `RuleSet` at all.
 *
 * Three callers justify the extraction: the rule's THEN band, one per `chooseMode` mode, and
 * `RuleSet.activation.cost` — which is a bare `Effect[]`, hence `effects` / `onChange(Effect[])`
 * rather than a rule and a patch.
 */
export function EffectList({
  effects,
  definition,
  onChange,
  label = 'Effects',
  addLabel = 'Add an effect',
  emptyHint = 'No effects yet — this rule does nothing.',
  depth = 0,
  inCost = false,
  ruleId,
}: EffectListProps) {
  const move = (from: number, to: number) => {
    if (to < 0 || to >= effects.length) return;
    onChange(moveItem(effects, from, to));
  };

  return (
    <>
      {effects.length === 0 ? (
        <p className="cb-hint">{emptyHint}</p>
      ) : (
        <ol className="cb-list" aria-label={label}>
          {effects.map((effect, index) => (
            <EffectRow
              // Index as key: effects have no id, and the list is reordered wholesale by the ▲▼
              // buttons rather than edited in place while shifting.
              key={index}
              effect={effect}
              index={index}
              total={effects.length}
              definition={definition}
              depth={depth}
              inCost={inCost}
              ruleId={ruleId}
              onChange={(next) => onChange(effects.map((e, i) => (i === index ? next : e)))}
              onMove={move}
              onRemove={() => onChange(effects.filter((_, i) => i !== index))}
            />
          ))}
        </ol>
      )}

      <EffectPicker
        definition={definition}
        depth={depth}
        inCost={inCost}
        ariaLabel={addLabel}
        onAdd={(effect) => onChange([...effects, effect])}
      />
    </>
  );
}
