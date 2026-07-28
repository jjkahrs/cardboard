import { generateRulesProse } from '../../engine/prose';
import type { GameDefinition, RuleSet } from '../../engine/types';

/**
 * READS AS (§6.8) — the designer's proof that they built what they meant.
 *
 * It calls the same `generateRulesProse` that fills the card's Rules layer, so the two can never
 * disagree. That is the entire value of this component; anything cleverer here would break it.
 *
 * There is deliberately no "preview as card X" switcher: the generated string does not depend on
 * which card a rule hangs on, so a switcher would imply a difference that does not exist. The cards
 * it is attached to are listed instead, since that is the real question behind asking.
 */
export function RulesProsePreview({
  rule,
  definition,
}: {
  rule: RuleSet;
  definition: GameDefinition;
}) {
  const attached = definition.templates.filter((t) => t.ruleSetIds.includes(rule.id));
  const global = definition.globalRuleSetIds.includes(rule.id);

  // §5.4 — a modifier rule never fires an effect; its whole text comes from the panel. Gating the
  // preview on `effects.length` alone rendered every modifier-only rule as "Nothing yet", i.e. as
  // blank, which is exactly the failure §8's trap 2 is about. The other three panels do read
  // `effects`, so for them an empty list really is nothing yet.
  const nothingYet = rule.effects.length === 0 && rule.modifier === null;

  return (
    <section className="cb-panel cb-prose" aria-label="Reads as">
      <span className="cb-rough" aria-hidden="true" />
      <h3>Reads as</h3>
      {nothingYet ? (
        <p className="cb-hint">Nothing yet — add an effect and this fills in.</p>
      ) : (
        <p className="cb-prose__text">{generateRulesProse([rule], definition)}</p>
      )}
      <p className="cb-hint">
        {global && 'Game-level rule. '}
        {attached.length === 0
          ? global
            ? 'Runs for the game itself, not from a card.'
            : 'Not attached to any card yet, so nothing triggers it.'
          : `On ${attached.length} card${attached.length === 1 ? '' : 's'}: ${attached
              .map((t) => t.name)
              .join(', ')}.`}
      </p>
    </section>
  );
}
