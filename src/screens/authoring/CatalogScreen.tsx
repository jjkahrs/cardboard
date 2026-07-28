import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ICON_CATALOG } from '../../assets/icons/catalog';
import { Card } from '../../components/card/Card';
import { FormErrors } from '../../components/ui/fields';
import { DEFAULT_CARD_BORDER } from '../../theme/palette';
import { useDefinitionStore, type EditResult } from '../../stores/definitionStore';
import { uniqueName } from './uniqueName';

/**
 * `/game/:gameId/cards` — the card catalog (§6.1), a grid of `<Card>` thumbnails.
 *
 * It renders the very same component the play table renders, with no play-state coupling and no
 * size/variant prop: the thumbnail size is `--cb-card-w` on the grid. That is what makes "catalog
 * and in-play card render identically" structural rather than a convention (AC: L2).
 */
export function CatalogScreen() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const definition = useDefinitionStore((s) => s.definition);
  const addTemplate = useDefinitionStore((s) => s.addTemplate);
  const [errors, setErrors] = useState<string[]>([]);

  const open = (id: string) => void navigate(`/game/${gameId}/cards/${id}`);

  const add = () => {
    const name = uniqueName(definition.templates.map((t) => t.name), 'New card');
    const result: EditResult = addTemplate({
      name,
      marquee: name,
      faceIcon: ICON_CATALOG[0].id,
      borderColor: DEFAULT_CARD_BORDER,
      tags: [],
      indexes: [],
      ruleSetIds: [],
      rulesTextOverride: null,
    });
    setErrors(result.ok ? [] : result.errors);
    if (result.ok && result.id !== undefined) open(result.id);
  };

  return (
    <main className="cb-screen">
      <header className="cb-screen__head">
        <h1>Cards</h1>
        <button type="button" className="cb-btn" onClick={add}>
          Add card
        </button>
      </header>
      <FormErrors errors={errors} />

      {definition.templates.length === 0 ? (
        <p className="cb-hint">No cards yet. Add one and it appears here as it will look in play.</p>
      ) : (
        <ul className="cb-catalog-grid" aria-label="Cards">
          {definition.templates.map((template) => (
            <li key={template.id}>
              <Card
                template={template}
                definition={definition}
                onClick={() => open(template.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
