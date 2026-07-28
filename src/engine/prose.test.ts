import { describe, expect, it } from 'vitest';
import { describeCriteria, describeEffect, generateRulesProse } from './prose';
import { cantripRule, duel } from '../test/fixtures/duel';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
  type CardTemplate,
  type CriteriaNode,
  type Effect,
  type GameDefinition,
  type PlayZone,
  type PointPool,
  type TargetSelector,
} from './types';

// ---------------------------------------------------------------------------
// A minimal definition exercising every id kind prose.ts resolves: a game pool, a player pool,
// a shared zone, a player zone, a template with one index, and a three-state machine.
// ---------------------------------------------------------------------------

const scorePool: PointPool = { id: 'score', scope: 'game', value: { type: 'integer', name: 'Score', defaultValue: 0, min: null, max: null } };
const hpPool: PointPool = { id: 'hp', scope: 'player', value: { type: 'integer', name: 'HP', defaultValue: 20, min: 0, max: 20 } };

const battlefield: PlayZone = { id: 'bf', name: 'Battlefield', scope: 'shared', visibility: 'faceUp', layout: 'row', ordered: false, maxCapacity: null };
const hand: PlayZone = { id: 'hand', name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: null };
const discard: PlayZone = { id: 'discard', name: 'Discard', scope: 'shared', visibility: 'faceUp', layout: 'stack', ordered: true, maxCapacity: null };

const grunt: CardTemplate = {
  id: 'grunt',
  name: 'Grunt',
  marquee: 'Grunt',
  faceIcon: 'gi-shield',
  borderColor: '#000',
  tags: ['creature'],
  indexes: [{ id: 'power', value: { type: 'integer', name: 'Power', defaultValue: 1, min: 0, max: 99 }, icon: 'gi-sword', position: 'topLeft' }],
  ruleSetIds: [],
  rulesTextOverride: null,
};

const combatState = { id: 'combat', name: 'Combat', enterableFrom: [START_STATE_ID], exitableTo: [END_STATE_ID], entryCriteria: null, transitionLabel: null, priority: 0, position: { x: 0, y: 0 } };

function baseDef(overrides: Partial<GameDefinition> = {}): GameDefinition {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'prose-test-def',
    name: 'Prose Test',
    playerCount: 2,
    pools: [scorePool, hpPool],
    zones: [battlefield, hand, discard],
    templates: [grunt],
    decks: [],
    customEvents: [],
    ruleSets: [],
    globalRuleSetIds: [],
    machine: {
      states: [
        { id: START_STATE_ID, name: 'Start', enterableFrom: [], exitableTo: ['combat'], entryCriteria: null, transitionLabel: null, priority: 0, position: { x: 0, y: 0 } },
        combatState,
        { id: END_STATE_ID, name: 'End', enterableFrom: ['combat'], exitableTo: [], entryCriteria: null, transitionLabel: null, priority: 0, position: { x: 0, y: 0 } },
      ],
      startStateId: START_STATE_ID,
      endStateId: END_STATE_ID,
    },
    limits: {
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEffects: DEFAULT_MAX_EFFECTS,
    maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
    maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
  },
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const def = baseDef();

describe('generateRulesProse', () => {
  // AC: A3 — exact string equality on the duel fixture's Cantrip rule (onCardPlayed -> draw 2 from Deck to Hand).
  it('matches the locked Cantrip prose', () => {
    expect(generateRulesProse([cantripRule], duel)).toBe(
      'When this card is played: draw 2 cards from their Deck to their Hand.'
    );
  });

  it('is deterministic: same input twice, same string', () => {
    const a = generateRulesProse([cantripRule], duel);
    const b = generateRulesProse([cantripRule], duel);
    expect(a).toBe(b);
  });

  it('renders the condition clause and joins multiple effects in order', () => {
    const condition: CriteriaNode = {
      kind: 'criteria',
      left: { kind: 'pool', poolId: 'hp', seat: { kind: 'active' } },
      op: '<',
      right: { kind: 'literal', value: 5 },
    };
    const prose = generateRulesProse(
      [
        {
          id: 'r1',
          name: 'Test',
          trigger: 'onCardPlayed',
          stateFilter: null,
          condition,
          effects: [
            { kind: 'drawCards', from: { zoneId: 'discard', seat: null }, to: { zoneId: 'bf', seat: null }, count: { kind: 'literal', value: 1 } },
            { kind: 'changePool', poolId: 'score', seat: null, op: 'add', amount: { kind: 'literal', value: 1 } },
          ],
          priority: 0,
          onRejection: 'continue',
          modifier: null,
        },
      ],
      def
    );
    expect(prose).toBe(
      'When this card is played, if HP of the active player is below 5: draw 1 card from Discard to Battlefield; add 1 to Score.'
    );
  });

  it('joins multiple rule sets with a space, one sentence each', () => {
    const rule = (id: string, effect: Effect) => ({
      id,
      name: id,
      trigger: 'onGameStart' as const,
      stateFilter: null,
      condition: null,
      effects: [effect],
      priority: 0,
      onRejection: 'continue' as const,
      modifier: null,
    });
    const prose = generateRulesProse(
      [
        rule('a', { kind: 'shuffleZone', zone: { zoneId: 'bf', seat: null } }),
        rule('b', { kind: 'shuffleZone', zone: { zoneId: 'discard', seat: null } }),
      ],
      def
    );
    expect(prose).toBe('When the game starts: shuffle Battlefield. When the game starts: shuffle Discard.');
  });
});

describe('describeEffect — all eleven kinds', () => {
  const targetTop: TargetSelector = { kind: 'topOfZone', zone: { zoneId: 'bf', seat: null }, count: { kind: 'literal', value: 1 } };

  it('moveCards', () => {
    expect(describeEffect({ kind: 'moveCards', target: targetTop, to: { zoneId: 'discard', seat: null }, position: 'top' }, def)).toBe(
      'move 1 card from the top of Battlefield to the top of Discard'
    );
  });

  it('drawCards', () => {
    expect(
      describeEffect({ kind: 'drawCards', from: { zoneId: 'bf', seat: null }, to: { zoneId: 'hand', seat: { kind: 'active' } }, count: { kind: 'literal', value: 2 } }, def)
    ).toBe('draw 2 cards from Battlefield to the active player\'s Hand');
  });

  it('shuffleZone', () => {
    expect(describeEffect({ kind: 'shuffleZone', zone: { zoneId: 'bf', seat: null } }, def)).toBe('shuffle Battlefield');
  });

  it('changePool — add/subtract/set', () => {
    expect(describeEffect({ kind: 'changePool', poolId: 'score', seat: null, op: 'add', amount: { kind: 'literal', value: 3 } }, def)).toBe('add 3 to Score');
    expect(describeEffect({ kind: 'changePool', poolId: 'hp', seat: { kind: 'next' }, op: 'subtract', amount: { kind: 'literal', value: 1 } }, def)).toBe(
      'subtract 1 from HP of the next player'
    );
    expect(describeEffect({ kind: 'changePool', poolId: 'score', seat: null, op: 'set', amount: { kind: 'literal', value: 0 } }, def)).toBe('set Score to 0');
  });

  it('setCardIndex', () => {
    expect(
      describeEffect({ kind: 'setCardIndex', target: { kind: 'triggeringCard' }, indexId: 'power', op: 'add', amount: { kind: 'literal', value: 1 } }, def)
    ).toBe('add 1 to Power of this card');
  });

  it('flipCard — faceUp/faceDown/toggle', () => {
    expect(describeEffect({ kind: 'flipCard', target: { kind: 'triggeringCard' }, to: 'faceUp' }, def)).toBe('flip this card face up');
    expect(describeEffect({ kind: 'flipCard', target: { kind: 'triggeringCard' }, to: 'faceDown' }, def)).toBe('flip this card face down');
    expect(describeEffect({ kind: 'flipCard', target: { kind: 'triggeringCard' }, to: 'toggle' }, def)).toBe('flip this card over');
  });

  it('rotateCard — rotated/upright/toggle', () => {
    expect(describeEffect({ kind: 'rotateCard', target: { kind: 'triggeringCard' }, to: 'rotated' }, def)).toBe('rotate this card sideways');
    expect(describeEffect({ kind: 'rotateCard', target: { kind: 'triggeringCard' }, to: 'upright' }, def)).toBe('rotate this card upright');
    expect(describeEffect({ kind: 'rotateCard', target: { kind: 'triggeringCard' }, to: 'toggle' }, def)).toBe('rotate this card');
  });

  it('createCard', () => {
    expect(
      describeEffect({ kind: 'createCard', templateId: 'grunt', zone: { zoneId: 'bf', seat: null }, position: 'top', count: { kind: 'literal', value: 1 } }, def)
    ).toBe('create 1 card of Grunt in the top of Battlefield');
  });

  it('destroyCards', () => {
    expect(describeEffect({ kind: 'destroyCards', target: { kind: 'triggeringCard' } }, def)).toBe('destroy this card');
  });

  it('fireEvent', () => {
    expect(describeEffect({ kind: 'fireEvent', name: 'customBoom' }, def)).toBe('fire the "customBoom" event');
  });

  it('forceTransition', () => {
    expect(describeEffect({ kind: 'forceTransition', toStateId: 'combat' }, def)).toBe('transition to Combat');
  });
});

describe('describeEffect — all six target selectors (via destroyCards)', () => {
  it('triggeringCard', () => {
    expect(describeEffect({ kind: 'destroyCards', target: { kind: 'triggeringCard' } }, def)).toBe('destroy this card');
  });

  it('topOfZone', () => {
    expect(
      describeEffect({ kind: 'destroyCards', target: { kind: 'topOfZone', zone: { zoneId: 'bf', seat: null }, count: { kind: 'literal', value: 1 } } }, def)
    ).toBe('destroy 1 card from the top of Battlefield');
  });

  it('bottomOfZone', () => {
    expect(
      describeEffect({ kind: 'destroyCards', target: { kind: 'bottomOfZone', zone: { zoneId: 'bf', seat: null }, count: { kind: 'literal', value: 2 } } }, def)
    ).toBe('destroy 2 cards from the bottom of Battlefield');
  });

  it('allInZone', () => {
    expect(describeEffect({ kind: 'destroyCards', target: { kind: 'allInZone', zone: { zoneId: 'bf', seat: null } } }, def)).toBe(
      'destroy all cards in Battlefield'
    );
  });

  it('taggedInZone', () => {
    expect(describeEffect({ kind: 'destroyCards', target: { kind: 'taggedInZone', zone: { zoneId: 'bf', seat: null }, tag: 'creature' } }, def)).toBe(
      'destroy all cards tagged "creature" in Battlefield'
    );
  });

  it('prompt', () => {
    expect(
      describeEffect(
        {
          kind: 'destroyCards',
          target: { kind: 'prompt', from: { kind: 'allInZone', zone: { zoneId: 'bf', seat: null } }, count: { kind: 'literal', value: 1 }, promptText: 'Choose one' },
        },
        def
      )
    ).toBe('destroy 1 card chosen by the player from all cards in Battlefield');
  });
});

describe('describeCriteria', () => {
  it('renders a single comparison', () => {
    const node: CriteriaNode = { kind: 'criteria', left: { kind: 'pool', poolId: 'score', seat: null }, op: '>=', right: { kind: 'literal', value: 10 } };
    expect(describeCriteria(node, def)).toBe('Score is at least 10');
  });

  it('renders a group with its combinator, parenthesized', () => {
    const node: CriteriaNode = {
      kind: 'group',
      combinator: 'or',
      children: [
        { kind: 'criteria', left: { kind: 'pool', poolId: 'score', seat: null }, op: '=', right: { kind: 'literal', value: 0 } },
        { kind: 'criteria', left: { kind: 'zoneCount', zone: { zoneId: 'hand', seat: { kind: 'active' } } }, op: '>', right: { kind: 'literal', value: 0 } },
      ],
    };
    expect(describeCriteria(node, def)).toBe("(Score is 0 or the number of cards in the active player's Hand is above 0)");
  });

  it('degrades a deleted pool referent to a placeholder instead of throwing', () => {
    const node: CriteriaNode = { kind: 'criteria', left: { kind: 'pool', poolId: 'ghost', seat: null }, op: '=', right: { kind: 'literal', value: 1 } };
    expect(() => describeCriteria(node, def)).not.toThrow();
    expect(describeCriteria(node, def)).toBe('[deleted pool] is 1');
  });
});

describe('missing-referent placeholders', () => {
  it('deleted zone', () => {
    expect(describeEffect({ kind: 'shuffleZone', zone: { zoneId: 'ghost-zone', seat: null } }, def)).toBe('shuffle [deleted zone]');
  });

  it('deleted template', () => {
    expect(
      describeEffect({ kind: 'createCard', templateId: 'ghost-tpl', zone: { zoneId: 'bf', seat: null }, position: 'top', count: { kind: 'literal', value: 1 } }, def)
    ).toBe('create 1 card of [deleted card] in the top of Battlefield');
  });

  it('deleted state', () => {
    expect(describeEffect({ kind: 'forceTransition', toStateId: 'ghost-state' }, def)).toBe('transition to [deleted state]');
  });

  it('deleted index', () => {
    expect(
      describeEffect({ kind: 'setCardIndex', target: { kind: 'triggeringCard' }, indexId: 'ghost-idx', op: 'add', amount: { kind: 'literal', value: 1 } }, def)
    ).toBe('add 1 to [deleted index] of this card');
  });
});
