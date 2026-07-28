/**
 * §9.2 `malformed.ts` — the 9-row bad-input table for P3 (§7.2's four import gates).
 *
 * `json` is RAW FILE TEXT, not an object, because gate 1 is `JSON.parse` and row 0 must fail there.
 * `expectedPath` is the structural claim (which field this row breaks); `expectedError` is the
 * behavioural one (what the importer's message must say). They differ for gates 1 and 2.
 *
 * Every row is `malformedBase` with exactly ONE thing wrong, so a failure can only be the named
 * fault. `malformedBase` itself is valid — `fixtures.test.ts` parses it back to prove that.
 */

import type { GameDefinition } from '../../engine/types';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
} from '../../engine/types';
import { deepFreeze, END_NODE, FIXTURE_UPDATED_AT, START_NODE } from './empty';

export const MB_POOL = 'pool_mana';
export const MB_DECK_ZONE = 'zone_deck';
export const MB_HAND_ZONE = 'zone_hand';
export const MB_RULESET = 'rs_shuffle';

/** Valid on purpose. Zone index 0 is Deck, index 1 is Hand — the rows below depend on that order. */
export const malformedBase: GameDefinition = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  id: 'game_malformedBase',
  name: 'Malformed Base',
  playerCount: 2,
  pools: [
    { id: MB_POOL, scope: 'player', value: { type: 'integer', name: 'Mana', defaultValue: 0, min: 0, max: 99 } },
  ],
  zones: [
    {
      id: MB_DECK_ZONE,
      name: 'Deck',
      scope: 'player',
      visibility: 'faceDown',
      layout: 'stack',
      ordered: true,
      maxCapacity: null,
    },
    {
      id: MB_HAND_ZONE,
      name: 'Hand',
      scope: 'player',
      visibility: 'ownerOnly',
      layout: 'fan',
      ordered: true,
      maxCapacity: 7,
    },
  ],
  templates: [],
  decks: [],
  customEvents: [],
  ruleSets: [
    {
      id: MB_RULESET,
      name: 'Shuffle Up',
      trigger: 'onGameStart',
      stateFilter: null,
      condition: null,
      effects: [{ kind: 'shuffleZone', zone: { zoneId: MB_DECK_ZONE, seat: { kind: 'all' } } }],
      priority: 0,
      onRejection: 'continue',
    },
  ],
  globalRuleSetIds: [MB_RULESET],
  machine: { states: [START_NODE, END_NODE], startStateId: START_STATE_ID, endStateId: END_STATE_ID },
  limits: {
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEffects: DEFAULT_MAX_EFFECTS,
    maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
    maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
  },
  updatedAt: FIXTURE_UPDATED_AT,
});

export interface MalformedCase {
  label: string;
  /** raw file text — gate 1 (`JSON.parse`) must be able to fail on it */
  json: string;
  /**
   * The JSON path this row breaks relative to `malformedBase` — a STRUCTURAL claim, proven by
   * `fixtures.test.ts` diffing the two objects. Empty for the row that never parses.
   */
  expectedPath: string;
  /**
   * The substring the importer's rendered error must contain — a BEHAVIOURAL claim, proven by
   * `src/test/integrity.test.ts`. Usually equals `expectedPath`, but gates 1 and 2 deliberately
   * produce one message about the FILE rather than a field path (§7.2), so those two rows name a
   * phrase from that message instead. Kept separate from `expectedPath` because an empty or
   * path-shaped expectation would make the behavioural assertion vacuous.
   */
  expectedError: string;
}

/**
 * `JSON.parse` returns `any`, which is the whole point here: these objects are deliberately not
 * `GameDefinition`s, so there is nothing honest to type them as.
 */
const broken = (mutate: (d: any) => void): string => {
  const d = JSON.parse(JSON.stringify(malformedBase));
  mutate(d);
  return JSON.stringify(d, null, 2);
};

export const malformed: MalformedCase[] = deepFreeze([
  {
    label: 'not JSON at all',
    json: '{ "schemaVersion": 1, "name": "Truncated",',
    // Gate 1 fails before any field is read, so there is no path to name. §7.2's message for this
    // gate is about the file, not a field.
    expectedPath: '',
    expectedError: 'not valid JSON',
  },
  {
    label: 'zone missing name',
    json: broken((d) => {
      delete d.zones[0].name;
    }),
    expectedPath: 'zones.0.name',
    expectedError: 'zones.0.name',
  },
  {
    label: 'negative maxCapacity',
    json: broken((d) => {
      d.zones[1].maxCapacity = -1;
    }),
    expectedPath: 'zones.1.maxCapacity',
    expectedError: 'zones.1.maxCapacity',
  },
  {
    label: 'maxCapacity is a string',
    json: broken((d) => {
      d.zones[1].maxCapacity = 'seven';
    }),
    expectedPath: 'zones.1.maxCapacity',
    expectedError: 'zones.1.maxCapacity',
  },
  {
    label: 'pool of unknown type',
    json: broken((d) => {
      d.pools[0].value.type = 'string';
    }),
    expectedPath: 'pools.0.value.type',
    expectedError: 'pools.0.value.type',
  },
  {
    label: 'effect of unknown kind',
    json: broken((d) => {
      d.ruleSets[0].effects[0].kind = 'teleport';
    }),
    expectedPath: 'ruleSets.0.effects.0.kind',
    expectedError: 'ruleSets.0.effects.0.kind',
  },
  {
    label: 'future schema version',
    json: broken((d) => {
      d.schemaVersion = 999;
    }),
    expectedPath: 'schemaVersion',
    // Gate 2 runs BEFORE the shape parse and returns one clear message rather than a field path —
    // §7.2 ("One clear message beats forty field errors from a future format"), and §9.4 item 10
    // requires only that it names the version.
    expectedError: 'Unsupported schema version 999',
  },
  {
    // Structurally valid — as a v1 file. v1 is a live input this build will actually receive,
    // unlike an arbitrarily future version, so §7.1 names it and says WHY there is no migration.
    // Distinct row from `999` on purpose (§9.2).
    label: 'v1 schema version',
    json: broken((d) => {
      d.schemaVersion = 1;
    }),
    expectedPath: 'schemaVersion',
    expectedError: 'v1 definitions are not convertible',
  },
  {
    // Shape-valid; only gate 4 catches it.
    label: 'RuleSet references a nonexistent zone',
    json: broken((d) => {
      d.ruleSets[0].effects[0].zone.zoneId = 'zone_does_not_exist';
    }),
    expectedPath: 'ruleSets.0.effects.0.zone.zoneId',
    expectedError: 'ruleSets.0.effects.0.zone.zoneId',
  },
]);
