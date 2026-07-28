import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CardAppearanceForm } from '../../components/authoring/CardAppearanceForm';
import { IndexEditor } from '../../components/authoring/IndexEditor';
import { Card } from '../../components/card/Card';
import { FormErrors } from '../../components/ui/fields';
import { generateRulesProse } from '../../engine/prose';
import { ICON_CATALOG } from '../../assets/icons/catalog';
import { useDefinitionStore, type EditResult } from '../../stores/definitionStore';

/**
 * `/game/:gameId/cards/:cardId` — one card, full route (§6.1).
 *
 * The preview is the same `<Card>` the catalog and the table render, sized only by the container.
 * The rules layer is `rulesTextOverride ?? generateRulesProse(...)` inside that component, so the
 * override this screen writes is proved to replace the text *without touching the RuleSets* by the
 * card itself rather than by anything here (AC: A3).
 */
export function CardEditorScreen() {
  const { gameId, cardId } = useParams();
  const navigate = useNavigate();
  const definition = useDefinitionStore((s) => s.definition);
  const updateTemplate = useDefinitionStore((s) => s.updateTemplate);
  const removeTemplate = useDefinitionStore((s) => s.removeTemplate);
  const addCardIndex = useDefinitionStore((s) => s.addCardIndex);
  const updateCardIndex = useDefinitionStore((s) => s.updateCardIndex);
  const removeCardIndex = useDefinitionStore((s) => s.removeCardIndex);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const template = definition.templates.find((t) => t.id === cardId);
  const catalog = `/game/${gameId}/cards`;

  const report = (result: EditResult): EditResult => {
    setErrors(result.ok ? [] : result.errors);
    return result;
  };

  if (!template) {
    return (
      <main className="cb-screen">
        <h1>Card not found</h1>
        <p>No card with id “{cardId}” is in this game.</p>
        <Link to={catalog}>Back to the catalog</Link>
      </main>
    );
  }

  const attached = template.ruleSetIds
    .map((id) => definition.ruleSets.find((rs) => rs.id === id))
    .filter((rs) => rs !== undefined);

  const toggleRule = (id: string, on: boolean) =>
    report(
      updateTemplate(template.id, {
        ruleSetIds: on
          ? [...template.ruleSetIds, id]
          : template.ruleSetIds.filter((existing) => existing !== id),
      })
    );

  const remove = () => {
    const result = report(removeTemplate(template.id));
    if (result.ok) void navigate(catalog);
    setConfirmingDelete(false);
  };

  return (
    <main className="cb-screen">
      <header className="cb-screen__head">
        <h1>
          <Link to={catalog}>Cards</Link> › {template.name}
        </h1>
        {confirmingDelete ? (
          <>
            <span>Delete “{template.name}”?</span>
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
          <>
            <button
              type="button"
              className="cb-btn"
              data-variant="danger"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </button>
            {/* Edits write straight to the store, so Done is just navigation. */}
            <button type="button" className="cb-btn" onClick={() => void navigate(catalog)}>
              Done
            </button>
          </>
        )}
      </header>

      <FormErrors errors={errors} />

      <div className="cb-master-detail">
        <div className="cb-detail">
          <section className="cb-panel cb-detail" aria-label="Appearance">
            <span className="cb-rough" aria-hidden="true" />
            <h2>Appearance</h2>
            <CardAppearanceForm
              template={template}
              onChange={(patch) => void report(updateTemplate(template.id, patch))}
            />
          </section>

          <section className="cb-panel cb-detail" aria-label="Numbers">
            <span className="cb-rough" aria-hidden="true" />
            <h2>Numbers</h2>
            <IndexEditor
              template={template}
              onAdd={() =>
                void report(
                  addCardIndex(template.id, {
                    value: { type: 'integer', name: 'New number', defaultValue: 0, min: null, max: null },
                    icon: ICON_CATALOG[0].id,
                    position: 'topLeft',
                  })
                )
              }
              onUpdate={(indexId, patch) =>
                void report(updateCardIndex(template.id, indexId, patch))
              }
              // Refused when a rule still reads this number, listing what reads it — the delete
              // gate is the store's one `findReferrers` walk, not a second copy here.
              onRemove={(indexId) => void report(removeCardIndex(template.id, indexId))}
            />
          </section>

          <section className="cb-panel cb-detail" aria-label="Rules">
            <span className="cb-rough" aria-hidden="true" />
            <h2>Rules</h2>
            {definition.ruleSets.length === 0 ? (
              <p className="cb-hint">
                No rules in the library yet. <Link to={`/game/${gameId}/rules`}>Write one</Link> and
                it can hang on this card.
              </p>
            ) : (
              <ul className="cb-list" aria-label="Rule library">
                {definition.ruleSets.map((rule) => (
                  <li key={rule.id} className="cb-list__row">
                    <label className="cb-radio">
                      <input
                        type="checkbox"
                        checked={template.ruleSetIds.includes(rule.id)}
                        onChange={(e) => toggleRule(rule.id, e.target.checked)}
                      />
                      {rule.name}
                    </label>
                    <span className="cb-hint">{rule.trigger}</span>
                    <Link to={`/game/${gameId}/rules/${rule.id}`}>Edit</Link>
                  </li>
                ))}
              </ul>
            )}

            <h3>Rules text</h3>
            {template.rulesTextOverride === null ? (
              <>
                <p className="cb-hint">
                  Written from the attached rules:{' '}
                  {attached.length === 0 ? '(nothing yet)' : generateRulesProse(attached, definition)}
                </p>
                <button
                  type="button"
                  className="cb-btn"
                  onClick={() =>
                    void report(
                      updateTemplate(template.id, {
                        // Seeded with the generated text so the designer edits rather than retypes.
                        // The RuleSets are untouched either way.
                        rulesTextOverride: generateRulesProse(attached, definition),
                      })
                    )
                  }
                >
                  Write my own text
                </button>
              </>
            ) : (
              <>
                <div className="cb-field">
                  <label htmlFor="cb-rules-override">Custom rules text</label>
                  <textarea
                    id="cb-rules-override"
                    className="cb-input"
                    rows={3}
                    value={template.rulesTextOverride}
                    onChange={(e) =>
                      void report(updateTemplate(template.id, { rulesTextOverride: e.target.value }))
                    }
                  />
                </div>
                <span className="cb-hint">
                  Shown instead of the generated text. The rules themselves still run exactly as
                  written.
                </span>
                <button
                  type="button"
                  className="cb-btn"
                  data-variant="ghost"
                  onClick={() =>
                    void report(updateTemplate(template.id, { rulesTextOverride: null }))
                  }
                >
                  Back to the generated text
                </button>
              </>
            )}
          </section>
        </div>

        <section className="cb-panel cb-card-preview" aria-label="Preview">
          <span className="cb-rough" aria-hidden="true" />
          <h2>Preview</h2>
          <Card template={template} definition={definition} />
        </section>
      </div>
    </main>
  );
}
