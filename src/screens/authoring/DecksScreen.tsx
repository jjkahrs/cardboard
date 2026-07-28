import { useState } from 'react';
import { DeckBuilder } from '../../components/authoring/DeckBuilder';
import { EntityList } from '../../components/ui/EntityList';
import { FormErrors } from '../../components/ui/fields';
import type { Deck, GameDefinition } from '../../engine/types';
import { useDefinitionStore, type EditResult } from '../../stores/definitionStore';
import { uniqueName } from './uniqueName';

/**
 * `/game/:gameId/decks` — the starting piles (§4.5, §6.1). Master list plus the builder.
 *
 * Nothing in the definition references a Deck, so deleting one is never blocked; the referrer list
 * is still wired up because `<EntityList>` asks, and answering "nothing" honestly beats a special
 * case that would go stale the day something does point at a deck.
 */
export function DecksScreen() {
  const definition = useDefinitionStore((s) => s.definition);
  const addDeck = useDefinitionStore((s) => s.addDeck);
  const updateDeck = useDefinitionStore((s) => s.updateDeck);
  const removeDeck = useDefinitionStore((s) => s.removeDeck);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const selected = definition.decks.find((d) => d.id === selectedId) ?? null;
  const firstZone = definition.zones[0];

  const report = (result: EditResult): EditResult => {
    setErrors(result.ok ? [] : result.errors);
    return result;
  };

  const add = () => {
    if (!firstZone) return;
    const result = report(
      addDeck({
        name: uniqueName(definition.decks.map((d) => d.name), 'New deck'),
        zoneId: firstZone.id,
        entries: [],
      })
    );
    if (result.ok && result.id !== undefined) setSelectedId(result.id);
  };

  return (
    <main className="cb-screen">
      <header className="cb-screen__head">
        <h1>Decks</h1>
      </header>
      <p className="cb-hint">
        What is on the table before anyone acts. Each deck is dealt into its zone and shuffled from
        the session seed, so the same seed always deals the same order.
      </p>
      <FormErrors errors={errors} />

      {!firstZone && (
        <p className="cb-error">A deck needs a zone to deal into. Add a zone first.</p>
      )}

      <div className="cb-master-detail">
        <EntityList
          label="Decks"
          addLabel="Add deck"
          emptyHint="No decks yet."
          items={definition.decks.map((deck) => ({
            id: deck.id,
            name: deck.name,
            detail: describeDeck(deck, definition),
          }))}
          selectedId={selected?.id}
          onSelect={setSelectedId}
          onAdd={add}
          onRename={(id, name) => report(updateDeck(id, { name }))}
          onDelete={(id) => void report(removeDeck(id))}
          // Nothing in the definition points AT a deck (`walkRefs` visits no deck id), so this is
          // empty by construction rather than by omission.
          referrersOf={() => []}
        />

        <section className="cb-panel cb-detail" aria-label="Deck contents">
          <span className="cb-rough" aria-hidden="true" />
          {selected === null ? (
            <p className="cb-hint">Pick a deck to fill it.</p>
          ) : (
            <>
              <h2>{selected.name}</h2>
              <DeckBuilder
                deck={selected}
                definition={definition}
                onChange={(patch) => void report(updateDeck(selected.id, patch))}
              />
            </>
          )}
        </section>
      </div>
    </main>
  );
}

/** The list's second line: where it deals, and how much. */
function describeDeck(deck: Deck, definition: GameDefinition): string {
  const zone = definition.zones.find((z) => z.id === deck.zoneId);
  const total = deck.entries.reduce((sum, e) => sum + e.quantity, 0);
  const where = zone?.name ?? '[deleted zone]';
  const perSeat = zone?.scope === 'player' ? ' per player' : '';
  return `${total} card${total === 1 ? '' : 's'}${perSeat} into ${where}`;
}
