import type { Effect, GameDefinition, TargetSelector } from '../../engine/types';
import { allIndexes } from '../criteria/isDangling';
import { defaultZoneRef } from './zoneRef';

/** §4.7's eleven kinds plus §4.5's eleven, in the order the picker offers them: common ones first. */
export const EFFECT_KINDS: { kind: Effect['kind']; label: string }[] = [
  { kind: 'drawCards', label: 'Draw' },
  { kind: 'moveCards', label: 'Move' },
  { kind: 'changePool', label: 'Change a pool' },
  { kind: 'setCardIndex', label: 'Change a card number' },
  { kind: 'shuffleZone', label: 'Shuffle' },
  { kind: 'flipCard', label: 'Flip' },
  { kind: 'rotateCard', label: 'Rotate' },
  { kind: 'createCard', label: 'Create' },
  { kind: 'destroyCards', label: 'Destroy' },
  { kind: 'fireEvent', label: 'Fire event' },
  { kind: 'forceTransition', label: 'Go to state' },
  // v2 §4.5 / §6.10 — cards and control.
  { kind: 'setTag', label: 'Tag' },
  { kind: 'attach', label: 'Attach' },
  { kind: 'detach', label: 'Detach' },
  { kind: 'setController', label: 'Change control' },
  { kind: 'eliminateSeat', label: 'Eliminate a player' },
  // v2 §4.5 / §4.8 — the stack.
  { kind: 'announceAction', label: 'Announce an action' },
  { kind: 'counterAction', label: 'Counter an action' },
  { kind: 'openPriority', label: 'Open a priority window' },
  // v2 §4.5 / §4.12 — the three that ask a player something.
  { kind: 'chooseMode', label: 'Choose a mode' },
  { kind: 'chooseNumber', label: 'Choose a number' },
  { kind: 'sealedChoice', label: 'Sealed choice' },
];

export const effectLabel = (kind: Effect['kind']): string =>
  EFFECT_KINDS.find((k) => k.kind === kind)?.label ?? kind;

/**
 * Reordering, shared by the effect list and `sealedChoice`'s option list. Lives here rather than
 * next to the `▲▼✕` buttons that call it because those are in a component file, and exporting a
 * plain function from one costs the fast-refresh boundary.
 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

const one = { kind: 'literal', value: 1 } as const;

/**
 * A ready-to-run effect of `kind`, or `null` when the definition has nothing for it to point at —
 * "Draw" before any zone exists, "Change a pool" before any pool does.
 *
 * Null is the whole point: the picker disables the option and says why, which is the only way to
 * offer eleven effect kinds without letting a designer author a dangling reference. `current` is the
 * effect being replaced, so switching kind keeps the target the designer already chose.
 */
export function defaultEffect(
  kind: Effect['kind'],
  definition: GameDefinition,
  current?: Effect
): Effect | null {
  const zone =
    (current && 'zone' in current ? current.zone : null) ??
    (current && 'to' in current && typeof current.to !== 'string' ? current.to : null) ??
    defaultZoneRef(definition);
  const target = current && 'target' in current ? current.target : ({ kind: 'triggeringCard' } as const);
  const pool = definition.pools[0];
  const index = allIndexes(definition)[0]?.index;
  const template = definition.templates[0];

  switch (kind) {
    case 'moveCards':
      return zone ? { kind, target, to: zone, position: 'top' } : null;
    case 'drawCards':
      return zone ? { kind, from: zone, to: zone, count: one } : null;
    case 'shuffleZone':
      return zone ? { kind, zone } : null;
    case 'changePool':
      return pool
        ? {
            kind,
            poolId: pool.id,
            seat: pool.scope === 'player' ? { kind: 'active' } : null,
            op: 'subtract',
            amount: one,
          }
        : null;
    case 'setCardIndex':
      return index ? { kind, target, indexId: index.id, op: 'set', amount: one } : null;
    case 'flipCard':
      return { kind, target, to: 'faceUp' };
    case 'rotateCard':
      return { kind, target, to: 'toggle' };
    case 'createCard':
      return template && zone ? { kind, templateId: template.id, zone, position: 'top', count: one } : null;
    case 'destroyCards':
      return { kind, target };
    case 'fireEvent':
      return { kind, name: definition.customEvents[0] ?? '' };
    // `machine.states` always holds the reserved Start and End, so this one can never be null.
    case 'forceTransition':
      return { kind, toStateId: definition.machine.endStateId };
    case 'eliminateSeat':
      return { kind, seat: { kind: 'active' } };
    case 'setController':
      return { kind, target, seat: { kind: 'active' } };
    case 'setTag':
      return { kind, target, tag: '', on: true };
    case 'attach':
      return { kind, target, host: { kind: 'triggering' } };
    case 'detach':
      return { kind, target };
    case 'announceAction': {
      const rule = definition.ruleSets[0];
      return rule ? { kind, ruleId: rule.id, window: null } : null;
    }
    case 'counterAction':
      return { kind, action: { kind: 'action', ref: { kind: 'topOfStack' } } };
    case 'openPriority': {
      const window = definition.priorityWindows[0];
      return window ? { kind, window: window.id } : null;
    }
    case 'sealedChoice':
      return { kind, choiceId: '', seats: { kind: 'all' }, options: [] };
    case 'chooseMode':
      return { kind, promptText: '', seat: { kind: 'active' }, modes: [] };
    case 'chooseNumber':
      return { kind, promptText: '', seat: { kind: 'active' }, min: one, max: one, key: '' };
  }
}

/**
 * Why an effect kind is unavailable, for the disabled option's own explanation.
 *
 * `depth` is how many effect lists deep this picker sits (§6.11): 0 in a rule's THEN band, 1 inside
 * a `chooseMode` mode.
 */
export function missingFor(
  kind: Effect['kind'],
  definition: GameDefinition,
  depth = 0
): string {
  const needsZone = definition.zones.length === 0;
  switch (kind) {
    case 'moveCards':
    case 'drawCards':
    case 'shuffleZone':
      return needsZone ? 'needs a zone' : '';
    case 'createCard':
      return needsZone ? 'needs a zone' : definition.templates.length === 0 ? 'needs a card' : '';
    case 'changePool':
      return definition.pools.length === 0 ? 'needs a pool' : '';
    case 'setCardIndex':
      return allIndexes(definition).length === 0 ? 'needs a card with a number on it' : '';
    case 'openPriority':
      return definition.priorityWindows.length === 0 ? 'needs a priority window' : '';
    case 'announceAction':
      return definition.ruleSets.length === 0 ? 'needs a rule to announce' : '';
    // §6.11 — an editor restriction, not a schema one: nested modes are authorable as a second rule
    // and are unreadable inline.
    case 'chooseMode':
      return depth > 0 ? 'author it as a second rule instead' : '';
    default:
      return '';
  }
}

/**
 * ponytail: mirrors `schema.ts`'s unexported `selectorSuspends`, the same way `refs.ts` mirrors
 * `prose.ts`'s label helpers — `src/engine/**` is off-limits this step. `targetSelector.ts`'s
 * `prompts` only looks at the outermost selector, and §4.4 lets `matching` wrap a `prompt`.
 */
const promptsDeep = (selector: TargetSelector): boolean =>
  selector.kind === 'prompt' || (selector.kind === 'matching' && promptsDeep(selector.from));

/**
 * §6.11 — does running this effect raise an `Interaction`, i.e. does the rule stop here?
 *
 * The same four kinds `schema.ts`'s `costEffectSuspends` names, plus any prompting target. Exported
 * rather than inlined in `EffectRow` because it is the predicate behind the `⏸` note, and every
 * future caller that needs to say "this pauses" needs the same answer.
 */
export function pauses(effect: Effect): boolean {
  switch (effect.kind) {
    case 'chooseMode':
    case 'chooseNumber':
    case 'sealedChoice':
    case 'openPriority':
      return true;
    default:
      return 'target' in effect && promptsDeep(effect.target);
  }
}
