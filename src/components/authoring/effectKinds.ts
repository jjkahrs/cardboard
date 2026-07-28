import type { Effect, GameDefinition } from '../../engine/types';
import { allIndexes } from '../criteria/isDangling';
import { defaultZoneRef } from './zoneRef';

/** §4.7's eleven kinds, in the order the picker offers them: the common ones first. */
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
];

export const effectLabel = (kind: Effect['kind']): string =>
  EFFECT_KINDS.find((k) => k.kind === kind)?.label ?? kind;

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
    // Deliberately absent from EFFECT_KINDS above: the authoring UI for §4's new unions is phase 4
    // (§6.10). This arm exists so the exhaustiveness check keeps the build honest, not so the
    // picker offers it.
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
    // v2 §4.5 — also deliberately absent from EFFECT_KINDS above: the authoring UI for these six
    // (§6.10) is phase 3/4. Same reasoning as `eliminateSeat` above — exhaustiveness only.
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

/** Why an effect kind is unavailable, for the disabled option's own explanation. */
export function missingFor(kind: Effect['kind'], definition: GameDefinition): string {
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
    default:
      return '';
  }
}
