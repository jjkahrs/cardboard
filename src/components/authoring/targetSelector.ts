import type { GameDefinition, TargetSelector } from '../../engine/types';
import { defaultZoneRef, isDanglingZone } from './zoneRef';

export const TARGET_KINDS: { kind: TargetSelector['kind']; label: string }[] = [
  { kind: 'triggeringCard', label: 'This card' },
  { kind: 'topOfZone', label: 'From the top of a zone' },
  { kind: 'bottomOfZone', label: 'From the bottom of a zone' },
  { kind: 'allInZone', label: 'Every card in a zone' },
  { kind: 'taggedInZone', label: 'Cards with a tag, in a zone' },
  { kind: 'prompt', label: 'Cards the player chooses' },
];

/** Whether this selector suspends the rule to ask the player a question (§5.4). */
export const prompts = (selector: TargetSelector): boolean => selector.kind === 'prompt';

/** Points at something deleted — what turns the chip red instead of silently breaking at play. */
export function danglingTarget(selector: TargetSelector, definition: GameDefinition): boolean {
  if (selector.kind === 'prompt') return danglingTarget(selector.from, definition);
  if (selector.kind === 'triggeringCard') return false;
  // §4.4's attachment selectors name a card, not a zone. The CardRef inside can still carry a
  // deleted zone via `zoneTop`; descending into it is step 19's pass, not this chip's.
  if (selector.kind === 'attachedTo' || selector.kind === 'hostOf') return false;
  // §4.4's predicate selector wraps another one; the `where` can dangle too, and descending into
  // it is step 19's pass along with the CardRefs above.
  if (selector.kind === 'matching') return danglingTarget(selector.from, definition);
  return isDanglingZone(selector.zone, definition);
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
    // Deliberately absent from TARGET_KINDS above: authoring UI for §4's new unions is phase 4
    // (§6.10). These arms exist so the exhaustiveness check keeps the build honest.
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
