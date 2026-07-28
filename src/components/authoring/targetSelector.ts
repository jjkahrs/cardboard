import type { GameDefinition, TargetSelector } from '../../engine/types';
import { danglingCard, danglingCriteria } from '../criteria/isDangling';
import { defaultZoneRef, isDanglingZone } from './zoneRef';

export const TARGET_KINDS: { kind: TargetSelector['kind']; label: string }[] = [
  { kind: 'triggeringCard', label: 'This card' },
  { kind: 'topOfZone', label: 'From the top of a zone' },
  { kind: 'bottomOfZone', label: 'From the bottom of a zone' },
  { kind: 'allInZone', label: 'Every card in a zone' },
  { kind: 'taggedInZone', label: 'Cards with a tag, in a zone' },
  { kind: 'attachedTo', label: 'Everything attached to a card' },
  { kind: 'hostOf', label: 'The card another card is attached to' },
  { kind: 'matching', label: 'Cards matching a filter' },
  { kind: 'prompt', label: 'Cards the player chooses' },
];

/** Whether this selector suspends the rule to ask the player a question (§5.4). */
export const prompts = (selector: TargetSelector): boolean => selector.kind === 'prompt';

/** Points at something deleted — what turns the chip red instead of silently breaking at play. */
export function danglingTarget(selector: TargetSelector, definition: GameDefinition): boolean {
  switch (selector.kind) {
    case 'triggeringCard':
      return false;
    case 'prompt':
      return danglingTarget(selector.from, definition);
    // §4.4's attachment selectors name a card, not a zone — but the CardRef they name can still
    // carry a deleted zone through `zoneTop`, so the descent is `danglingCard`'s, not a zone check.
    case 'attachedTo':
      return danglingCard(selector.host, definition);
    case 'hostOf':
      return danglingCard(selector.card, definition);
    // §4.4's predicate selector wraps another one AND holds a criteria tree; either half can dangle,
    // and the tree is collapsed to a summary on the chip, so nothing else would show it.
    case 'matching':
      return (
        danglingTarget(selector.from, definition) ||
        danglingCriteria(selector.where, definition)
      );
    default:
      return isDanglingZone(selector.zone, definition);
  }
}

/**
 * A starting selector of `kind` that points at something real, or `null` when nothing exists to
 * point at. Returning null rather than a half-built selector is what lets the chip *disable* the
 * option with a reason instead of writing a dangling reference (the rule `ValueRefPicker` uses).
 *
 * `current` is the selector being replaced, so switching kind keeps the zone and count already
 * chosen rather than resetting the designer's work.
 */
export function defaultSelector(
  kind: TargetSelector['kind'],
  definition: GameDefinition,
  current?: TargetSelector
): TargetSelector | null {
  const zone = (current && 'zone' in current ? current.zone : null) ?? defaultZoneRef(definition);
  const count =
    current && 'count' in current ? current.count : { kind: 'literal' as const, value: 1 };
  switch (kind) {
    case 'triggeringCard':
      return { kind: 'triggeringCard' };
    case 'topOfZone':
    case 'bottomOfZone':
      return zone ? { kind, zone, count } : null;
    case 'allInZone':
      return zone ? { kind, zone } : null;
    case 'taggedInZone':
      return zone ? { kind, zone, tag: current && 'tag' in current ? current.tag : '' } : null;
    case 'prompt': {
      // A prompt WRAPS a selector: the wrapped one is the legal set to highlight (§4.7). Wrapping
      // the selector already chosen is what the designer means by "…but let them pick".
      const from =
        current && current.kind !== 'prompt' ? current : ({ kind: 'triggeringCard' } as const);
      return { kind: 'prompt', from, count, promptText: 'Choose a card' };
    }
    case 'attachedTo':
      return { kind, host: { kind: 'triggering' } };
    case 'hostOf':
      return { kind, card: { kind: 'triggering' } };
    // An empty AND is true (criteria.ts), so the default predicate filters nothing out — the
    // designer narrows it, and a half-built `where` never silently drops every candidate.
    case 'matching':
      return {
        kind,
        from: current && current.kind !== 'matching' ? current : { kind: 'triggeringCard' },
        where: { kind: 'group', combinator: 'and', children: [] },
      };
  }
}
