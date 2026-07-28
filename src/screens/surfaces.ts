import type { GameDefinition } from '../engine/types';

export interface Surface {
  /** Route segment under /game/:gameId. */
  path: string;
  label: string;
  count: (d: GameDefinition) => number;
  /** First segment of a validation error path that belongs to this surface. */
  errorKeys: string[];
}

/** The rail, in authoring order. §6.1's route table, minus /play which is not a surface. */
export const SURFACES: Surface[] = [
  { path: 'pools', label: 'Pools', count: (d) => d.pools.length, errorKeys: ['pools'] },
  { path: 'cards', label: 'Cards', count: (d) => d.templates.length, errorKeys: ['templates'] },
  { path: 'zones', label: 'Zones', count: (d) => d.zones.length, errorKeys: ['zones'] },
  { path: 'decks', label: 'Decks', count: (d) => d.decks.length, errorKeys: ['decks'] },
  { path: 'events', label: 'Events', count: (d) => d.customEvents.length, errorKeys: ['customEvents'] },
  {
    path: 'rules',
    label: 'Rules',
    count: (d) => d.ruleSets.length,
    errorKeys: ['ruleSets', 'globalRuleSetIds'],
  },
  {
    path: 'priority',
    label: 'Priority',
    count: (d) => d.priorityWindows.length,
    errorKeys: ['priorityWindows'],
  },
  { path: 'states', label: 'States', count: (d) => d.machine.states.length, errorKeys: ['machine'] },
];

/** Anything not owned by a rail surface — name, playerCount, limits, schemaVersion. */
export const GAME_LEVEL = 'game';

/**
 * Groups `validateDefinition` output by rail surface. Errors read `zones.1.maxCapacity: message`,
 * so the owning surface is the first path segment; anything unrecognised is game-level rather than
 * silently dropped — an error nobody can see is worse than one on the wrong badge.
 */
export function bucketErrors(errors: string[]): Record<string, string[]> {
  const byKey = new Map(SURFACES.flatMap((s) => s.errorKeys.map((k) => [k, s.path] as const)));
  const buckets: Record<string, string[]> = {};
  for (const error of errors) {
    const head = error.split(/[.:]/, 1)[0];
    const surface = byKey.get(head) ?? GAME_LEVEL;
    (buckets[surface] ??= []).push(error);
  }
  return buckets;
}
