import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EntityList } from '../../components/ui/EntityList';
import { FormErrors } from '../../components/ui/fields';
import type { GameDefinition, RuleSet } from '../../engine/types';
import { findReferrers, useDefinitionStore, type EditResult } from '../../stores/definitionStore';
import { uniqueName } from './uniqueName';

/**
 * `/game/:gameId/rules` — the RuleSet library (§4.7, §6.1).
 *
 * Rules are top-level entities, not card properties: one "deal 1 damage on play" can hang on twelve
 * cards and editing it updates all twelve. So this list is the library, and a row opens the full
 * editor route — not a modal, because the editor is large and is a link target from elsewhere.
 */
export function RuleSetsScreen() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const definition = useDefinitionStore((s) => s.definition);
  const addRuleSet = useDefinitionStore((s) => s.addRuleSet);
  const updateRuleSet = useDefinitionStore((s) => s.updateRuleSet);
  const removeRuleSet = useDefinitionStore((s) => s.removeRuleSet);
  const [errors, setErrors] = useState<string[]>([]);

  const report = (result: EditResult): EditResult => {
    setErrors(result.ok ? [] : result.errors);
    return result;
  };

  const open = (id: string) => void navigate(`/game/${gameId}/rules/${id}`);

  const add = () => {
    const result = report(
      addRuleSet({
        name: uniqueName(definition.ruleSets.map((r) => r.name), 'New rule'),
        trigger: 'onCardPlayed',
        stateFilter: null,
        condition: null,
        effects: [],
        priority: 0,
        onRejection: 'continue',
        modifier: null,
      })
    );
    if (result.ok && result.id !== undefined) open(result.id);
  };

  return (
    <main className="cb-screen">
      <header className="cb-screen__head">
        <h1>Rules</h1>
      </header>
      <p className="cb-hint">
        Every rule lives here and cards borrow it by name. Edit one and every card carrying it
        changes with it.
      </p>
      <FormErrors errors={errors} />

      <EntityList
        label="Rules"
        addLabel="Add rule"
        emptyHint="No rules yet. A rule is a trigger, an optional condition, and a list of effects."
        items={definition.ruleSets.map((rule) => ({
          id: rule.id,
          name: rule.name,
          detail: describeRuleSet(rule, definition),
        }))}
        onSelect={open}
        onAdd={add}
        onRename={(id, name) => report(updateRuleSet(id, { name }))}
        onDelete={(id) => void report(removeRuleSet(id))}
        referrersOf={(id) => findReferrers(definition, 'ruleSet', id)}
      />
    </main>
  );
}

/** The list's second line: what fires it, how much it does, and where it hangs. */
function describeRuleSet(rule: RuleSet, definition: GameDefinition): string {
  const cards = definition.templates.filter((t) => t.ruleSetIds.includes(rule.id)).length;
  const parts = [
    rule.trigger,
    `${rule.effects.length} effect${rule.effects.length === 1 ? '' : 's'}`,
  ];
  if (rule.priority !== 0) parts.push(`priority ${rule.priority}`);
  if (definition.globalRuleSetIds.includes(rule.id)) parts.push('game-level');
  parts.push(cards === 0 ? 'on no cards' : `on ${cards} card${cards === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
