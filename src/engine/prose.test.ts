import { describe, expect, it } from 'vitest';
import { describeCriteria, describeEffect, describeValueRef, generateRulesProse } from './prose';
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

// ---------------------------------------------------------------------------
// §8 trap 2 — a kind with no prose arm renders BLANK on the card face and in the rule editor
// preview, and neither throws. One sample per kind, in a Record keyed by the union itself: adding a
// kind to `Effect` without a sample is a compile error here, and adding one without a prose arm is
// a compile error in `describeEffect` (its `string` return type has no `undefined` in it).
// ---------------------------------------------------------------------------

const EVERY_EFFECT: Record<Effect['kind'], Effect> = {
  moveCards: { kind: 'moveCards', target: { kind: 'triggeringCard' }, to: { zoneId: 'discard', seat: null }, position: 'top' },
  drawCards: { kind: 'drawCards', from: { zoneId: 'bf', seat: null }, to: { zoneId: 'hand', seat: { kind: 'active' } }, count: { kind: 'literal', value: 1 } },
  shuffleZone: { kind: 'shuffleZone', zone: { zoneId: 'bf', seat: null } },
  changePool: { kind: 'changePool', poolId: 'hp', seat: { kind: 'all', quantifier: 'every' }, op: 'subtract', amount: { kind: 'literal', value: 1 } },
  setCardIndex: { kind: 'setCardIndex', target: { kind: 'triggeringCard' }, indexId: 'power', op: 'add', amount: { kind: 'literal', value: 1 } },
  flipCard: { kind: 'flipCard', target: { kind: 'triggeringCard' }, to: 'toggle' },
  rotateCard: { kind: 'rotateCard', target: { kind: 'triggeringCard' }, to: 'rotated' },
  createCard: { kind: 'createCard', templateId: 'grunt', zone: { zoneId: 'bf', seat: null }, position: 'bottom', count: { kind: 'literal', value: 2 } },
  destroyCards: { kind: 'destroyCards', target: { kind: 'allInZone', zone: { zoneId: 'bf', seat: null } } },
  fireEvent: { kind: 'fireEvent', name: 'customBoom' },
  forceTransition: { kind: 'forceTransition', toStateId: 'combat' },
  setTag: { kind: 'setTag', target: { kind: 'triggeringCard' }, tag: 'blocking', on: true },
  attach: { kind: 'attach', target: { kind: 'triggeringCard' }, host: { kind: 'zoneTop', zone: { zoneId: 'bf', seat: null } } },
  detach: { kind: 'detach', target: { kind: 'triggeringCard' } },
  setController: { kind: 'setController', target: { kind: 'triggeringCard' }, seat: { kind: 'next' } },
  eliminateSeat: { kind: 'eliminateSeat', seat: { kind: 'relative', from: { kind: 'active' }, offset: -1 } },
};

describe('describeEffect — exhaustive over Effect["kind"]', () => {
  it.each(Object.entries(EVERY_EFFECT))('%s renders prose with no missing referent', (kind, effect) => {
    // Guards the samples themselves: a copy-pasted duplicate would leave a kind unexercised while
    // the Record still type-checks.
    expect(effect.kind).toBe(kind);

    const text = describeEffect(effect, def);
    expect(text).not.toBe('');
    expect(text.trim()).toBe(text);
    expect(text).not.toContain('[deleted');
  });
});

describe('describeEffect — the phase-1 kinds', () => {
  it('setTag — added and removed', () => {
    expect(describeEffect({ kind: 'setTag', target: { kind: 'triggeringCard' }, tag: 'blocking', on: true }, def)).toBe('tag this card "blocking"');
    expect(describeEffect({ kind: 'setTag', target: { kind: 'triggeringCard' }, tag: 'blocking', on: false }, def)).toBe(
      'remove the "blocking" tag from this card'
    );
  });

  it('attach and detach', () => {
    expect(
      describeEffect({ kind: 'attach', target: { kind: 'triggeringCard' }, host: { kind: 'zoneTop', zone: { zoneId: 'bf', seat: null } } }, def)
    ).toBe('attach this card to the top card of Battlefield');
    expect(describeEffect({ kind: 'detach', target: { kind: 'triggeringCard' } }, def)).toBe('detach this card');
  });

  it('setController — granted and cleared', () => {
    expect(describeEffect({ kind: 'setController', target: { kind: 'triggeringCard' }, seat: { kind: 'next' } }, def)).toBe(
      'give control of this card to the next player'
    );
    expect(describeEffect({ kind: 'setController', target: { kind: 'triggeringCard' }, seat: null }, def)).toBe('give up control of this card');
  });

  it('eliminateSeat', () => {
    expect(describeEffect({ kind: 'eliminateSeat', seat: { kind: 'seat', index: 1 } }, def)).toBe('eliminate player 2');
  });
});

describe('the phase-1 vocabulary — §4.1, §4.2, §4.4', () => {
  it('relative counts round the ring in both directions, singular at one seat', () => {
    const at = (offset: number) => describeEffect({ kind: 'eliminateSeat', seat: { kind: 'relative', from: { kind: 'active' }, offset } }, def);
    expect(at(2)).toBe('eliminate the player 2 seats after the active player');
    expect(at(-1)).toBe('eliminate the player 1 seat before the active player');
  });

  it('sum reads as one total rather than as a quantifier', () => {
    expect(describeValueRef({ kind: 'pool', poolId: 'hp', seat: { kind: 'all', quantifier: 'sum' } }, def)).toBe('HP of all players combined');
    expect(describeValueRef({ kind: 'pool', poolId: 'hp', seat: { kind: 'all', quantifier: 'every' } }, def)).toBe('HP of each player');
    expect(describeValueRef({ kind: 'pool', poolId: 'hp', seat: { kind: 'all', quantifier: 'some' } }, def)).toBe('HP of any player');
  });

  it('owner and controller name the card they are read from', () => {
    const card = { kind: 'zoneTop', zone: { zoneId: 'hand', seat: { kind: 'active' } } } as const;
    expect(describeValueRef({ kind: 'pool', poolId: 'hp', seat: { kind: 'owner', card } }, def)).toBe(
      "HP of the owner of the top card of the active player's Hand"
    );
    expect(describeValueRef({ kind: 'pool', poolId: 'hp', seat: { kind: 'controller', card: { kind: 'triggering' } } }, def)).toBe(
      'HP of the controller of this card'
    );
  });

  it('activeSeatCount and cardTag', () => {
    expect(describeValueRef({ kind: 'activeSeatCount' }, def)).toBe('the number of players still in the game');
    expect(describeValueRef({ kind: 'cardTag', card: { kind: 'host' }, tag: 'vampire' }, def)).toBe(
      'whether the card this is attached to is tagged "vampire"'
    );
  });

  it('matching wraps its selector and spells out the predicate', () => {
    const target: TargetSelector = {
      kind: 'matching',
      from: { kind: 'allInZone', zone: { zoneId: 'bf', seat: null } },
      where: { kind: 'criteria', left: { kind: 'cardIndex', card: { kind: 'candidate' }, indexId: 'power' }, op: '>', right: { kind: 'literal', value: 2 } },
    };
    expect(describeEffect({ kind: 'destroyCards', target }, def)).toBe(
      'destroy all cards in Battlefield where Power of the card is above 2'
    );
  });

  it('attachedTo and hostOf read the relation in both directions', () => {
    expect(describeEffect({ kind: 'destroyCards', target: { kind: 'attachedTo', host: { kind: 'triggering' } } }, def)).toBe(
      'destroy everything attached to this card'
    );
    expect(describeEffect({ kind: 'destroyCards', target: { kind: 'hostOf', card: { kind: 'triggering' } } }, def)).toBe(
      'destroy the card this card is attached to'
    );
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
