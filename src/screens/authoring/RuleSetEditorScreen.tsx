import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RuleSetEditor } from '../../components/authoring/RuleSetEditor';
import type { RuleSet } from '../../engine/types';
import { useDefinitionStore, type EditResult } from '../../stores/definitionStore';

/**
 * `/game/:gameId/rules/:ruleSetId` — one rule, full route (§6.1).
 *
 * A route rather than a modal: the editor is large, and it is a link target from the library and
 * (in step 23) from every card that carries the rule. Modals that deep-link are a bug farm.
 */
export function RuleSetEditorScreen() {
  const { gameId, ruleSetId } = useParams();
  const navigate = useNavigate();
  const definition = useDefinitionStore((s) => s.definition);
  const addRuleSet = useDefinitionStore((s) => s.addRuleSet);
  const updateRuleSet = useDefinitionStore((s) => s.updateRuleSet);
  const removeRuleSet = useDefinitionStore((s) => s.removeRuleSet);
  const setGlobalRuleSet = useDefinitionStore((s) => s.setGlobalRuleSet);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const rule = definition.ruleSets.find((r) => r.id === ruleSetId);
  const library = `/game/${gameId}/rules`;

  const report = (result: EditResult): EditResult => {
    setErrors(result.ok ? [] : result.errors);
    return result;
  };

  if (!rule) {
    return (
      <main className="cb-screen">
        <h1>Rule not found</h1>
        <p>
          No rule with id “{ruleSetId}” is in this game — it may have been deleted in another tab.
        </p>
        <Link to={library}>Back to the rule library</Link>
      </main>
    );
  }

  const duplicate = () => {
    // structuredClone because effects nest arbitrarily deep; a shallow copy would leave the twin
    // sharing criteria nodes with the original, and editing one would silently edit both.
    const copy: Omit<RuleSet, 'id'> = {
      ...structuredClone(rule),
      name: `${rule.name} copy`,
    };
    const result = report(addRuleSet(copy));
    if (result.ok && result.id !== undefined) void navigate(`${library}/${result.id}`);
  };

  const remove = () => {
    const result = report(removeRuleSet(rule.id));
    if (result.ok) void navigate(library);
    setConfirmingDelete(false);
  };

  return (
    <main className="cb-screen">
      <header className="cb-screen__head">
        <h1>
          <Link to={library}>Rules</Link> › {rule.name}
        </h1>
        <button type="button" className="cb-btn" onClick={duplicate}>
          Duplicate
        </button>
        {confirmingDelete ? (
          <>
            <span>Delete “{rule.name}”?</span>
            <button type="button" className="cb-btn" data-variant="danger" onClick={remove}>
              Delete for good
            </button>
            <button
              type="button"
              className="cb-btn"
              data-variant="ghost"
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="cb-btn"
            data-variant="danger"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </button>
        )}
      </header>

      <RuleSetEditor
        rule={rule}
        definition={definition}
        errors={errors}
        onChange={(patch) => void report(updateRuleSet(rule.id, patch))}
        onToggleGlobal={(on) => void report(setGlobalRuleSet(rule.id, on))}
      />
    </main>
  );
}
