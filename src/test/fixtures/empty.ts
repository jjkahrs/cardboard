/**
 * §9.2 `empty.ts` — the bare definition for A1/A2. Valid, 2 players, nothing authored but the
 * reserved `start` and `end` states.
 *
 * `deepFreeze` also lives here: §9.2 requires every fixture frozen, and this is the only fixture
 * file with no imports of its own, so hanging the helper here keeps the file list to the five the
 * spec names and keeps the import graph acyclic (duel/loop/malformed → empty, index → all).
 */

import type { GameDefinition, MachineState } from '../../engine/types';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
} from '../../engine/types';

/** Recursively `Object.freeze`s. Mutating tests must `structuredClone` first — §9.2. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const START_NODE: MachineState = {
  id: START_STATE_ID,
  name: 'Start',
  enterableFrom: [],
  exitableTo: [END_STATE_ID],
  entryCriteria: null,
  transitionLabel: null,
  priority: 0,
  position: { x: 0, y: 0 },
};

export const END_NODE: MachineState = {
  id: END_STATE_ID,
  name: 'End',
  enterableFrom: [START_STATE_ID],
  exitableTo: [],
  entryCriteria: null,
  transitionLabel: null,
  priority: 0,
  position: { x: 200, y: 0 },
};

/** Fixed literal — §3.6 forbids `Date.now()` anywhere a fixture can reach. */
export const FIXTURE_UPDATED_AT = '2026-01-01T00:00:00.000Z';

export const empty: GameDefinition = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: 'game_empty',
  name: 'Empty',
  playerCount: 2,
  pools: [],
  zones: [],
  templates: [],
  decks: [],
  customEvents: [],
  ruleSets: [],
  globalRuleSetIds: [],
  priorityWindows: [],
  machine: {
    states: [START_NODE, END_NODE],
    startStateId: START_STATE_ID,
    endStateId: END_STATE_ID,
  },
  limits: {
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEffects: DEFAULT_MAX_EFFECTS,
    maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
    maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
  },
  updatedAt: FIXTURE_UPDATED_AT,
});
