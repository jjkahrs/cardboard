/**
 * Regressions for the defects found in the initial-commit review. One `describe` per fix, each
 * failing against the pre-fix code — they are here to stay failing if any of it is reintroduced.
 */

import { describe, expect, it } from 'vitest';

import {
  ACTIVE_PLAYER_POOL_ID,
  CONTINUE,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
  type CardTemplate,
  type EngineInput,
  type GameDefinition,
  type Id,
  type Interaction,
  type LogLine,
  type MachineState,
  type PlayAction,
  type PlayState,
  type PlayZone,
  type RuleSet,
  type StepResult,
} from './types';
import { step } from './dispatch';
import { createPlayState } from './setup';
import { validateDefinition } from './schema';
import { findAutoTransition } from './stateMachine';
import { evalCriteria } from './criteria';
import { generateRulesProse } from './prose';
import { END_NODE, FIXTURE_UPDATED_AT, START_NODE } from '../test/fixtures/empty';

// ---------------------------------------------------------------------------
// A definition small enough that every log line in a run is one of this test's own
// ---------------------------------------------------------------------------

const N = 'pool_n';
const DECK = 'zone_deck';
const BF = 'zone_bf';
const CARD = 'tpl_card';
const GO = 'go';

const zone = (id: Id): PlayZone => ({
  id,
  name: id,
  scope: 'shared',
  visibility: 'faceUp',
  layout: 'row',
  ordered: true,
  maxCapacity: null,
});

const card = (ruleSetIds: Id[] = []): CardTemplate => ({
  id: CARD,
  name: 'Card',
  marquee: 'Card',
  faceIcon: 'gi-card',
  borderColor: '#000000',
  tags: [],
  indexes: [],
  ruleSetIds,
  rulesTextOverride: null,
});

function mk(over: Partial<GameDefinition> = {}): GameDefinition {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'game_regressions',
    name: 'Regressions',
    playerCount: 2,
    pools: [{ id: N, scope: 'game', value: { type: 'integer', name: 'n', defaultValue: 0, min: 0, max: null } }],
    zones: [zone(DECK), zone(BF)],
    templates: [card()],
    decks: [],
    customEvents: [GO],
    ruleSets: [],
    globalRuleSetIds: [],
    machine: { states: [START_NODE, END_NODE], startStateId: START_STATE_ID, endStateId: END_STATE_ID },
    limits: {
      maxDepth: DEFAULT_MAX_DEPTH,
      maxEffects: DEFAULT_MAX_EFFECTS,
      maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
      maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
    },
    updatedAt: FIXTURE_UPDATED_AT,
    ...over,
  };
}

const rule = (id: Id, trigger: string, effects: RuleSet['effects'], over: Partial<RuleSet> = {}): RuleSet => ({
  id,
  name: id,
  trigger,
  stateFilter: null,
  condition: null,
  effects,
  priority: 0,
  onRejection: 'continue',
  ...over,
});

const deckOf = (id: Id, zoneId: Id, quantity: number) => ({
  id,
  name: id,
  zoneId,
  entries: [{ templateId: CARD, quantity }],
});

/** The store's loop (§3.3), minus immer — drives one action to settlement. */
function drive(state: PlayState, def: GameDefinition, action: PlayAction): LogLine[] {
  const lines: LogLine[] = [];
  let input: EngineInput = { kind: 'action', action, override: false };
  let result: StepResult = step(state, input, lines, def);
  let steps = 1;
  while (!result.done) {
    if (++steps > 10_000) throw new Error('driver runaway');
    input = CONTINUE;
    result = step(state, input, lines, def);
  }
  return lines;
}

const fire = (state: PlayState, def: GameDefinition) =>
  drive(state, def, { kind: 'fireEvent', name: GO, seat: 0 });

const answer = (state: PlayState, def: GameDefinition, chosen: Id[]) =>
  drive(state, def, { kind: 'answerPrompt', chosen });

/**
 * v1's prompt cursor is v2's `state.interaction` narrowed to its `chooseCards` arm — the
 * same data under a new discriminant (§3.3). Returns null for any other kind, so a test asserting
 * "a prompt is up" still fails if the engine raises something that is not a card choice.
 */
const chooseCards = (state: PlayState): Extract<Interaction, { kind: 'chooseCards' }> | null =>
  state.interaction?.kind === 'chooseCards' ? state.interaction : null;

// ---------------------------------------------------------------------------

describe('a prompt answer does not leak into the events the effect fires', () => {
  // Move one chosen card Deck -> Battlefield; a global onZoneEnter rule then prompts in turn.
  const mover = rule('rs_move', GO, [
    {
      kind: 'moveCards',
      target: {
        kind: 'prompt',
        from: { kind: 'allInZone', zone: { zoneId: DECK, seat: null } },
        count: { kind: 'literal', value: 1 },
        promptText: 'Which card moves',
      },
      to: { zoneId: BF, seat: null },
      position: 'top',
    },
  ]);
  const onArrival = rule('rs_arrival', 'onZoneEnter', [
    {
      kind: 'flipCard',
      target: {
        kind: 'prompt',
        from: { kind: 'allInZone', zone: { zoneId: BF, seat: null } },
        count: { kind: 'literal', value: 1 },
        promptText: 'Which card flips',
      },
      to: 'faceDown',
    },
  ]);

  const def = mk({
    decks: [deckOf('d', DECK, 3)],
    ruleSets: [mover, onArrival],
    globalRuleSetIds: [mover.id, onArrival.id],
  });

  it('the downstream rule raises its own prompt instead of inheriting @chosen', () => {
    const state = createPlayState(def, 'seed');
    fire(state, def);
    expect(chooseCards(state)?.promptText).toBe('Which card moves');

    const moved = chooseCards(state)!.candidates[0];
    const lines = answer(state, def, [moved]);

    expect(chooseCards(state)?.promptText).toBe('Which card flips');
    // The pre-fix symptom, in its own words.
    expect(lines.map((l) => l.message).join('\n')).not.toContain('0 legal targets');
  });
});

describe('two bindings of one prompting rule each get their own prompt', () => {
  const promptFlip = rule('rs_flip2', GO, [
    {
      kind: 'flipCard',
      target: {
        kind: 'prompt',
        from: { kind: 'allInZone', zone: { zoneId: DECK, seat: null } },
        count: { kind: 'literal', value: 1 },
        promptText: 'Pick one',
      },
      to: 'faceDown',
    },
  ]);
  // Card-attached, and GO is not one of the four card-binding events, so both copies bind.
  const def = mk({
    templates: [card([promptFlip.id])],
    decks: [deckOf('d', DECK, 2)],
    ruleSets: [promptFlip],
  });

  it('the first answer does not satisfy the second binding, which shares its promptId', () => {
    const state = createPlayState(def, 'seed');
    fire(state, def);
    expect(chooseCards(state)).not.toBeNull();

    answer(state, def, [chooseCards(state)!.candidates[0]]);

    // The second binding is still owed its own choice.
    expect(chooseCards(state)).not.toBeNull();
  });
});

describe('two decks pointed at one zone', () => {
  it('both decks are dealt; neither is minted and then orphaned', () => {
    const def = mk({ decks: [deckOf('d1', DECK, 4), deckOf('d2', DECK, 3)] });
    const state = createPlayState(def, 'seed');

    expect(state.zones[DECK].cardIds).toHaveLength(7);
    expect(Object.keys(state.cards)).toHaveLength(7);
    expect(new Set(state.zones[DECK].cardIds).size).toBe(7);
  });
});

describe('the reserved activePlayer pool is authorable', () => {
  const advance = rule('rs_advance', GO, [
    { kind: 'changePool', poolId: ACTIVE_PLAYER_POOL_ID, seat: null, op: 'add', amount: { kind: 'literal', value: 1 } },
  ]);
  const def = mk({
    ruleSets: [
      advance,
      rule('rs_read', GO, [], {
        condition: {
          kind: 'criteria',
          left: { kind: 'pool', poolId: ACTIVE_PLAYER_POOL_ID, seat: null },
          op: '=',
          right: { kind: 'literal', value: 0 },
        },
      }),
    ],
    globalRuleSetIds: [advance.id],
  });

  it('validation accepts an effect and a criterion that reference it', () => {
    expect(validateDefinition(def)).toEqual([]);
  });

  it('it renders by name, not as a deleted pool or a raw id', () => {
    const state = createPlayState(def, 'seed');
    const leaf = evalCriteria(def.ruleSets[1].condition!, state, {
      triggeringCardId: null,
      zoneKey: null,
      triggeringSeat: 0,
      promptAnswers: {},
    }, def).leaves[0];

    expect(leaf.left.label).toBe('Active Player');
    expect(generateRulesProse([advance], def)).toContain('Active Player');
    expect(generateRulesProse([advance], def)).not.toContain('[deleted pool]');
  });

  it('the effect actually advances the seat', () => {
    const state = createPlayState(def, 'seed');
    fire(state, def);
    expect(state.pools[ACTIVE_PLAYER_POOL_ID]).toBe(1);
  });
});

describe('a state whose entry criteria has no criteria yet', () => {
  it('is not auto-entered — an empty AND is true, but an unauthored state is not eligible', () => {
    const target: MachineState = {
      id: 'state_auto',
      name: 'Auto',
      enterableFrom: [START_STATE_ID],
      exitableTo: [],
      // Exactly what StateMachineScreen writes on "Enter automatically instead".
      entryCriteria: { kind: 'group', combinator: 'and', children: [] },
      transitionLabel: null,
      priority: 0,
      position: { x: 0, y: 0 },
    };
    const def = mk({
      machine: {
        states: [{ ...START_NODE, exitableTo: [target.id] }, target, END_NODE],
        startStateId: START_STATE_ID,
        endStateId: END_STATE_ID,
      },
    });
    const state = createPlayState(def, 'seed');

    expect(
      findAutoTransition(state, def, { triggeringCardId: null, zoneKey: null, triggeringSeat: 0, promptAnswers: {} })
    ).toBeNull();

    // …and one real criterion makes it eligible again, so the guard is about emptiness only.
    const armed = mk({
      machine: {
        ...def.machine,
        states: def.machine.states.map((s) =>
          s.id === target.id
            ? {
                ...s,
                entryCriteria: {
                  kind: 'group' as const,
                  combinator: 'and' as const,
                  children: [
                    {
                      kind: 'criteria' as const,
                      left: { kind: 'pool' as const, poolId: N, seat: null },
                      op: '=' as const,
                      right: { kind: 'literal' as const, value: 0 },
                    },
                  ],
                },
              }
            : s
        ),
      },
    });
    expect(
      findAutoTransition(createPlayState(armed, 'seed'), armed, {
        triggeringCardId: null,
        zoneKey: null,
        triggeringSeat: 0,
        promptAnswers: {},
      })
    ).toEqual({ toStateId: target.id, eligible: [target.id] });
  });
});

describe('onStateExit stateFilter matches the state that was left', () => {
  const A = 'state_a';
  const B = 'state_b';
  const machine = {
    states: [
      { ...START_NODE, exitableTo: [A] },
      { id: A, name: 'A', enterableFrom: [START_STATE_ID], exitableTo: [B], entryCriteria: null, transitionLabel: 'A', priority: 0, position: { x: 0, y: 0 } },
      { id: B, name: 'B', enterableFrom: [A], exitableTo: [], entryCriteria: null, transitionLabel: 'B', priority: 0, position: { x: 1, y: 0 } },
      END_NODE,
    ],
    startStateId: START_STATE_ID,
    endStateId: END_STATE_ID,
  };
  const bump = (id: Id, stateFilter: Id) =>
    rule(id, 'onStateExit', [{ kind: 'changePool', poolId: N, seat: null, op: 'add', amount: { kind: 'literal', value: 1 } }], { stateFilter });

  it('fires the rule filtered to the source state, not the one filtered to the destination', () => {
    const onLeavingA = bump('rs_leaveA', A);
    const def = mk({ machine, ruleSets: [onLeavingA], globalRuleSetIds: [onLeavingA.id] });
    const state = createPlayState(def, 'seed');
    state.currentStateId = A;

    drive(state, def, { kind: 'transition', toStateId: B });
    expect(state.pools[N]).toBe(1);
  });

  it('does not fire a rule filtered to the destination state', () => {
    const onLeavingB = bump('rs_leaveB', B);
    const def = mk({ machine, ruleSets: [onLeavingB], globalRuleSetIds: [onLeavingB.id] });
    const state = createPlayState(def, 'seed');
    state.currentStateId = A;

    drive(state, def, { kind: 'transition', toStateId: B });
    expect(state.pools[N]).toBe(0);
  });
});

describe('a draw whose source is its destination', () => {
  // The editor's default drawCards is `{ from: zone, to: zone }` — this is the untouched default.
  const selfDraw = rule('rs_draw', GO, [
    {
      kind: 'drawCards',
      from: { zoneId: DECK, seat: null },
      to: { zoneId: DECK, seat: null },
      count: { kind: 'literal', value: 1 },
    },
  ]);
  const def = mk({ decks: [deckOf('d', DECK, 3)], ruleSets: [selfDraw], globalRuleSetIds: [selfDraw.id] });

  it('is reported instead of logging as a draw that moved nothing', () => {
    const state = createPlayState(def, 'seed');
    const lines = fire(state, def);

    const drawLine = lines.find((l) => l.effectKind === 'drawCards');
    expect(drawLine?.level).toBe('reject');
    expect(drawLine?.message).toContain('same zone');
  });
});
