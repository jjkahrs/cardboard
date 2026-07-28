import type { Deck, GameDefinition } from '../../engine/types';
import { InlineNumber, SelectField } from '../ui/fields';

export interface DeckBuilderProps {
  deck: Deck;
  definition: GameDefinition;
  onChange: (patch: Partial<Omit<Deck, 'id'>>) => void;
}

/**
 * What goes in a deck, and where it starts (§4.5).
 *
 * A deck targeting a player-scoped zone is instantiated **once per seat** — that is derived from the
 * zone rather than a `perSeat` flag, so the only honest thing to do here is say so out loud with the
 * real total. "40 cards" meaning 80 is the kind of surprise that only shows up mid-playtest.
 */
export function DeckBuilder({ deck, definition, onChange }: DeckBuilderProps) {
  const zone = definition.zones.find((z) => z.id === deck.zoneId);
  const perSeat = zone?.scope === 'player';
  const total = deck.entries.reduce((sum, e) => sum + e.quantity, 0);
  const seats = perSeat ? definition.playerCount : 1;

  const setEntry = (index: number, patch: Partial<Deck['entries'][number]>) =>
    onChange({ entries: deck.entries.map((e, i) => (i === index ? { ...e, ...patch } : e)) });

  const unusedTemplate =
    definition.templates.find((t) => !deck.entries.some((e) => e.templateId === t.id)) ??
    definition.templates[0];

  return (
    <>
      <SelectField
        label="Deals into"
        value={deck.zoneId}
        options={definition.zones.map((z) => ({ value: z.id, label: z.name }))}
        onChange={(zoneId) => onChange({ zoneId })}
      />

      {definition.templates.length === 0 ? (
        <p className="cb-hint">No cards to put in it yet.</p>
      ) : (
        <>
          {deck.entries.length > 0 && (
            <ul className="cb-list" aria-label="Deck contents">
              {deck.entries.map((entry, index) => (
                <li key={`${entry.templateId}-${index}`} className="cb-list__row">
                  <InlineNumber
                    label={`Quantity of entry ${index + 1}`}
                    min={1}
                    value={entry.quantity}
                    onChange={(quantity) => setEntry(index, { quantity })}
                  />
                  {/* The schema permits any int, so a nonsense quantity is said rather than
                      silently rewritten — clamping mid-keystroke fights whoever is typing "20". */}
                  {entry.quantity < 1 && <span className="cb-error">at least 1</span>}
                  {' × '}
                  <select
                    className="cb-inline-select"
                    aria-label={`Card in entry ${index + 1}`}
                    value={entry.templateId}
                    onChange={(e) => setEntry(index, { templateId: e.target.value })}
                  >
                    {definition.templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="cb-btn"
                    data-variant="danger"
                    aria-label={`Remove entry ${index + 1}`}
                    onClick={() => onChange({ entries: deck.entries.filter((_, i) => i !== index) })}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            className="cb-btn"
            onClick={() =>
              onChange({ entries: [...deck.entries, { templateId: unusedTemplate.id, quantity: 1 }] })
            }
          >
            Add cards
          </button>
        </>
      )}

      <p className="cb-hint">
        {total} card{total === 1 ? '' : 's'}
        {perSeat && ` per player — ${total * seats} in total across ${seats} seats`}
        {zone === undefined && ' — this deck has no zone to deal into'}
      </p>
    </>
  );
}
