/**
 * §9.2 `loop.ts` — the three loop-guard fixtures for R4 (§5.5).
 *
 * All three are card-less: the rules are bound through `globalRuleSetIds`, so a test only has to
 * fire the event. All three keep the DEFAULT limits (256 / 50 000) — the point of each fixture is
 * which of the two counters trips first, so overriding them would defeat it.
 *
 * Frozen (§9.2). Mutating tests must `structuredClone` first.
 */

import type { GameDefinition, PointPool, RuleSet } from '../../engine/types';
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

/** The game-scoped counter every variant bumps, so a test can see how far the chain got. */
export const N = 'pool_n';

export const ECHO = 'Echo';
export const PING = 'Ping';
export const PONG = 'Pong';
export const BURST = 'Burst';

export const RS_ECHO = 'rs_echo';
export const RS_PING = 'rs_ping';
export const RS_PONG = 'rs_pong';
export const RS_BURST_A = 'rs_burst_a';
export const RS_BURST_B = 'rs_burst_b';
export const RS_BURST_C = 'rs_burst_c';

const nPool: PointPool = {
  id: N,
  scope: 'game',
  value: { type: 'integer', name: 'n', defaultValue: 0, min: 0, max: null },
};

/** `n += 1` then re-fire `event` — the smallest body that both loops and leaves evidence. */
const echoRule = (id: string, name: string, trigger: string, refires: string): RuleSet => ({
  id,
  name,
  trigger,
  stateFilter: null,
  condition: null,
  effects: [
    { kind: 'changePool', poolId: N, seat: null, op: 'add', amount: { kind: 'literal', value: 1 } },
    { kind: 'fireEvent', name: refires },
  ],
  priority: 0,
  onRejection: 'continue',
  modifier: null,
});

const base = (id: string, name: string, customEvents: string[], ruleSets: RuleSet[]): GameDefinition => ({
  schemaVersion: SCHEMA_VERSION,
  id,
  name,
  playerCount: 2,
  pools: [nPool],
  zones: [],
  templates: [],
  decks: [],
  customEvents,
  ruleSets,
  globalRuleSetIds: ruleSets.map((r) => r.id),
  machine: { states: [START_NODE, END_NODE], startStateId: START_STATE_ID, endStateId: END_STATE_ID },
  limits: {
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEffects: DEFAULT_MAX_EFFECTS,
    maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
    maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
  },
  updatedAt: FIXTURE_UPDATED_AT,
});

/** `Echo → [n +1, fireEvent Echo]`. Linear; the DEPTH counter should trip at 65. */
export const selfLoop: GameDefinition = deepFreeze(
  base('game_selfLoop', 'Self Loop', [ECHO], [echoRule(RS_ECHO, 'Echo', ECHO, ECHO)]),
);

/**
 * `Ping → Pong`, `Pong → Ping`. Also linear, but no event name repeats consecutively — this is the
 * one that catches a depth counter keyed on the event NAME. Such a bug passes `selfLoop` and hangs
 * here.
 */
export const mutualLoop: GameDefinition = deepFreeze(
  base('game_mutualLoop', 'Mutual Loop', [PING, PONG], [
    echoRule(RS_PING, 'Ping', PING, PONG),
    echoRule(RS_PONG, 'Pong', PONG, PING),
  ]),
);

/**
 * ONE event, three RuleSets, each re-firing it: 3^d events at depth d. Flat and wide rather than
 * deep — the effect budget (10 000) is exhausted around depth 9, long before `maxDepth` 64, so a
 * depth-only guard never fires and the browser hangs. This is the fixture that proves both counters
 * are live (§5.5).
 */
export const fanOut: GameDefinition = deepFreeze(
  base('game_fanOut', 'Fan Out', [BURST], [
    echoRule(RS_BURST_A, 'Burst A', BURST, BURST),
    echoRule(RS_BURST_B, 'Burst B', BURST, BURST),
    echoRule(RS_BURST_C, 'Burst C', BURST, BURST),
  ]),
);
