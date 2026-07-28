import { useState, type FormEvent } from 'react';
import { FormErrors } from '../../components/ui/fields';
import { BUILTIN_EVENTS, CARD_BINDING_EVENTS } from '../../engine/types';
import type { GameDefinition } from '../../engine/types';
import { useDefinitionStore } from '../../stores/definitionStore';

/** What each built-in means, in the designer's language rather than the engine's (§4.6). */
const BUILTIN_PROSE: Record<string, string> = {
  onGameStart: 'Once, when the playtest begins.',
  onGameEnd: 'Once, when the game reaches End.',
  onCardPlayed: 'A card is played.',
  onCardDrawn: 'A card is drawn — moving one by hand does not count.',
  onZoneEnter: 'A card arrives in a zone.',
  onZoneExit: 'A card leaves a zone.',
  onStateEnter: 'A state is entered. Narrow it to one state on the rule.',
  onStateExit: 'A state is left.',
  onPoolChanged: 'A pool’s value changes.',
};

/**
 * `/game/:gameId/events` — the built-ins, read-only, plus the custom names (§4.6, §6.1).
 *
 * Custom events are bare strings with no id, so there is deliberately **no rename**: a RuleSet's
 * trigger is matched by string equality, and renaming here would leave every listener pointing at a
 * name the picker no longer offers, silently and with nothing to click on. Delete, then retype the
 * trigger on the rules that need it — the referrer counts below say which those are.
 *
 * Removal itself cannot dangle for the same reason (a rule triggering on a gone name simply never
 * fires), so it is confirmed rather than blocked, and the confirmation states the consequence.
 *
 * `onTurnStart`/`onTurnEnd` are absent on purpose (§4.6) — turns are authored in the state machine,
 * and a built-in the engine never fires would be a lie in the picker.
 */
export function EventsScreen() {
  const definition = useDefinitionStore((s) => s.definition);
  const addCustomEvent = useDefinitionStore((s) => s.addCustomEvent);
  const removeCustomEvent = useDefinitionStore((s) => s.removeCustomEvent);

  const [draft, setDraft] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = draft.trim();
    // Three refusals the store cannot make for us: it dedupes silently, and it has no opinion on a
    // custom name that shadows a built-in — which would look like a second, separate event in the
    // picker while the engine treats the two as one.
    const refusal =
      name === ''
        ? 'Give the event a name.'
        : definition.customEvents.includes(name)
          ? `“${name}” is already an event.`
          : (BUILTIN_EVENTS as readonly string[]).includes(name)
            ? `“${name}” is a built-in event — rules can already trigger on it.`
            : null;
    if (refusal !== null) {
      setErrors([refusal]);
      return;
    }
    const result = addCustomEvent(name);
    setErrors(result.ok ? [] : result.errors);
    if (result.ok) setDraft('');
  };

  const remove = (name: string) => {
    setConfirming(null);
    setErrors([]);
    const result = removeCustomEvent(name);
    if (!result.ok) setErrors(result.errors);
  };

  return (
    <main className="cb-screen">
      <header className="cb-screen__head">
        <h1>Events</h1>
      </header>
      <p className="cb-hint">
        What rules listen for. The built-ins are fired by the engine; your own are fired by a “fire
        event” effect, which is how turn structure is expressed.
      </p>

      <div className="cb-master-detail">
        <section aria-label="Built-in events">
          <h2>Built in</h2>
          <ul className="cb-list">
            {BUILTIN_EVENTS.map((name) => (
              <li key={name} className="cb-list__row">
                <span className="cb-entity-list__name">{name}</span>
                <span className="cb-hint">
                  {BUILTIN_PROSE[name]}
                  {CARD_BINDING_EVENTS.includes(name) && ' Binds the triggering card.'}
                </span>
                <span className="cb-hint">{usage(definition, name)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Custom events">
          <div className="cb-entity-list__head">
            <h2>Yours</h2>
          </div>

          <form className="cb-field" onSubmit={submit}>
            <label htmlFor="cb-new-event">New event</label>
            <input
              id="cb-new-event"
              className="cb-input"
              value={draft}
              placeholder="onTurnStart"
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className="cb-btn">
              Add event
            </button>
          </form>
          <FormErrors errors={errors} />

          {definition.customEvents.length === 0 ? (
            <p className="cb-hint">
              None yet. Most games want a turn event — fire it from a state’s onStateEnter rule.
            </p>
          ) : (
            <ul className="cb-list" aria-label="Custom events">
              {definition.customEvents.map((name) => {
                const listeners = definition.ruleSets.filter((rs) => rs.trigger === name);
                return (
                  <li key={name} className="cb-list__row">
                    <span className="cb-entity-list__name">{name}</span>
                    <span className="cb-hint">{usage(definition, name)}</span>
                    {confirming === name ? (
                      <>
                        <span className={listeners.length > 0 ? 'cb-error' : undefined}>
                          {listeners.length > 0
                            ? `Removing “${name}” leaves ${listeners.length} rule set${
                                listeners.length === 1 ? '' : 's'
                              } (${listeners.map((rs) => rs.name).join(', ')}) triggering on a name the pickers no longer offer.`
                            : `Remove “${name}”?`}
                        </span>
                        <button
                          type="button"
                          className="cb-btn"
                          data-variant="danger"
                          onClick={() => remove(name)}
                        >
                          Remove for good
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="cb-btn"
                      data-variant="danger"
                      onClick={() => setConfirming(confirming === name ? null : name)}
                    >
                      {confirming === name ? 'Cancel' : 'Remove'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

/**
 * Both directions, because they answer different questions: who *listens* tells you what breaks if
 * the name goes away, who *fires* tells you whether anything reaches the listeners at all.
 */
function usage(definition: GameDefinition, name: string): string {
  const listeners = definition.ruleSets.filter((rs) => rs.trigger === name).length;
  const senders = definition.ruleSets.filter((rs) =>
    rs.effects.some((e) => e.kind === 'fireEvent' && e.name === name)
  ).length;
  const parts = [`${listeners} listening`];
  if (senders > 0) parts.push(`${senders} firing`);
  return parts.join(' · ');
}
