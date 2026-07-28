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
  type PriorityWindow,
  type RuleSet,
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

/** Referenced by EVERY_EFFECT's `announceAction`/`openPriority` samples so their prose resolves a
 *  real name instead of the `[deleted …]` placeholder the missing-referent tests exercise on purpose. */
const referencedRule: RuleSet = {
  id: 'rs-referenced',
  name: 'Referenced Rule',
  trigger: 'onGameStart',
  stateFilter: null,
  condition: null,
  effects: [],
  priority: 0,
  onRejection: 'continue',
  modifier: null,
  continuous: false,
  replaces: null,
  activation: null,
};

const referencedWindow: PriorityWindow = {
  id: 'window-referenced',
  name: 'Referenced Window',
  start: 'active',
  direction: 'forward',
  includeStart: true,
  passesToClose: null,
  collapseEmptyOffers: true,
};

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
    ruleSets: [referencedRule],
    globalRuleSetIds: [],
    priorityWindows: [referencedWindow],
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
          continuous: false,
          replaces: null,
          activation: null,
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
      continuous: false,
      replaces: null,
      activation: null,
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
  announceAction: { kind: 'announceAction', ruleId: 'rs-referenced', window: 'window-referenced' },
  counterAction: { kind: 'counterAction', action: { kind: 'action', ref: { kind: 'topOfStack' } } },
  openPriority: { kind: 'openPriority', window: 'window-referenced' },
  sealedChoice: {
    kind: 'sealedChoice',
    choiceId: 'choice1',
    seats: { kind: 'all' },
    options: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }],
  },
  chooseMode: {
    kind: 'chooseMode',
    promptText: 'Choose a mode',
    seat: { kind: 'active' },
    modes: [{ label: 'Mode A', effects: [] }, { label: 'Mode B', effects: [] }],
  },
  chooseNumber: {
    kind: 'chooseNumber',
    promptText: 'Choose a number',
    seat: { kind: 'active' },
    min: { kind: 'literal', value: 0 },
    max: { kind: 'literal', value: 5 },
    key: 'chosenNumber',
  },
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

  it('deleted rule (announceAction.ruleId)', () => {
    expect(describeEffect({ kind: 'announceAction', ruleId: 'ghost-rule', window: null }, def)).toBe(
      'announce [deleted rule]'
    );
  });

  it('deleted priority window (openPriority.window)', () => {
    expect(describeEffect({ kind: 'openPriority', window: 'ghost-window' }, def)).toBe(
      'open [deleted window]'
    );
  });
});

// ---------------------------------------------------------------------------
// v2 §4.5 — the six new effect kinds, locked exactly (not just the exhaustiveness table above)
// ---------------------------------------------------------------------------

describe('describeEffect — the six v2 phase-2 kinds', () => {
  it('announceAction — with and without a window', () => {
    expect(describeEffect({ kind: 'announceAction', ruleId: 'rs-referenced', window: null }, def)).toBe(
      'announce Referenced Rule'
    );
    expect(
      describeEffect({ kind: 'announceAction', ruleId: 'rs-referenced', window: 'window-referenced' }, def)
    ).toBe('announce Referenced Rule and open Referenced Window');
  });

  it('counterAction — a single action and allOnStack, with and without a where', () => {
    expect(
      describeEffect({ kind: 'counterAction', action: { kind: 'action', ref: { kind: 'topOfStack' } } }, def)
    ).toBe('counter the top action on the stack');
    expect(
      describeEffect({ kind: 'counterAction', action: { kind: 'allOnStack', where: null } }, def)
    ).toBe('counter every action on the stack');
  });

  it('openPriority', () => {
    expect(describeEffect({ kind: 'openPriority', window: 'window-referenced' }, def)).toBe(
      'open Referenced Window'
    );
  });

  it('sealedChoice', () => {
    expect(
      describeEffect(
        {
          kind: 'sealedChoice',
          choiceId: 'c1',
          seats: { kind: 'all' },
          options: [{ id: 'a', label: 'Attack' }, { id: 'b', label: 'Block' }],
        },
        def
      )
    ).toBe('have each player simultaneously choose one of: Attack, Block');
  });

  it('chooseMode', () => {
    expect(
      describeEffect(
        {
          kind: 'chooseMode',
          promptText: 'Pick one',
          seat: { kind: 'active' },
          modes: [{ label: 'Draw a card', effects: [] }, { label: 'Gain a point', effects: [] }],
        },
        def
      )
    ).toBe('have the active player choose one of: Draw a card, Gain a point');
  });

  it('chooseNumber', () => {
    expect(
      describeEffect(
        {
          kind: 'chooseNumber',
          promptText: 'Pick a number',
          seat: { kind: 'active' },
          min: { kind: 'literal', value: 0 },
          max: { kind: 'literal', value: 5 },
          key: 'k',
        },
        def
      )
    ).toBe('have the active player choose a number from 0 to 5');
  });
});

// ---------------------------------------------------------------------------
// v2 §4.2 — the new CardRef/ValueRef kinds and ActionRef/ActionSelector
// ---------------------------------------------------------------------------

describe('the v2 phase-2 vocabulary — §4.2', () => {
  it('replacedTarget and replacedAmount', () => {
    expect(describeValueRef({ kind: 'cardTag', card: { kind: 'replacedTarget' }, tag: 'x' }, def)).toBe(
      'whether the replaced target is tagged "x"'
    );
    expect(describeValueRef({ kind: 'replacedAmount' }, def)).toBe('the replaced amount');
  });

  it('actionField reads a PendingAction characteristic off an ActionRef', () => {
    expect(
      describeValueRef({ kind: 'actionField', action: { kind: 'triggeringAction' }, field: 'controller' }, def)
    ).toBe('the controller of the action this is responding to');
    expect(
      describeValueRef({ kind: 'actionField', action: { kind: 'topOfStack' }, field: 'targetCount' }, def)
    ).toBe('the targetCount of the top action on the stack');
  });
});

// ---------------------------------------------------------------------------
// v2 §4.5, §6.10 — the four new RuleSet panels: continuous / modifier / replaces / activation
// ---------------------------------------------------------------------------

describe('generateRulesProse — the four new RuleSet panels', () => {
  const baseRule = {
    id: 'r1',
    name: 'R',
    trigger: 'onGameStart' as const,
    stateFilter: null,
    effects: [{ kind: 'changePool' as const, poolId: 'score', seat: null, op: 'add' as const, amount: { kind: 'literal' as const, value: 1 } }],
    priority: 0,
    onRejection: 'continue' as const,
    modifier: null,
    continuous: false,
    replaces: null,
    activation: null,
  };

  it('continuous ignores trigger and reads "Whenever"', () => {
    const condition: CriteriaNode = { kind: 'criteria', left: { kind: 'pool', poolId: 'score', seat: null }, op: '>=', right: { kind: 'literal', value: 10 } };
    const prose = generateRulesProse([{ ...baseRule, continuous: true, condition }], def);
    expect(prose).toBe('Whenever Score is at least 10 becomes true: add 1 to Score.');
  });

  it('modifier — set vs adjust, and the active-zones clause', () => {
    const setMod = generateRulesProse(
      [{ ...baseRule, condition: null, effects: [], modifier: { scope: { kind: 'triggeringCard' }, indexId: 'power', op: 'set' as const, amount: { kind: 'literal', value: 3 }, activeZones: [] } }],
      def
    );
    expect(setMod).toBe('this card: Power is set to 3.');

    const adjustMod = generateRulesProse(
      [{ ...baseRule, condition: null, effects: [], modifier: { scope: { kind: 'triggeringCard' }, indexId: 'power', op: 'adjust' as const, amount: { kind: 'literal', value: 1 }, activeZones: ['bf'] } }],
      def
    );
    expect(adjustMod).toBe('this card: Power is adjusted by 1 while its source is in Battlefield.');
  });

  it('replaces — with and without a match', () => {
    const noMatch = generateRulesProse(
      [{ ...baseRule, condition: null, replaces: { effectKind: 'drawCards' as const, match: null } }],
      def
    );
    expect(noMatch).toBe('If a "drawCards" effect would apply, instead: add 1 to Score.');

    const withMatch: CriteriaNode = { kind: 'criteria', left: { kind: 'replacedAmount' }, op: '>', right: { kind: 'literal', value: 1 } };
    const matched = generateRulesProse(
      [{ ...baseRule, condition: null, replaces: { effectKind: 'drawCards' as const, match: withMatch } }],
      def
    );
    expect(matched).toBe('If a "drawCards" effect would apply, where the replaced amount is above 1, instead: add 1 to Score.');
  });

  it('activation — cost, costCheck, window and the "outside a priority window" fallback', () => {
    const noCost = generateRulesProse(
      [{ ...baseRule, condition: null, activation: { costCheck: null, cost: [], window: null, perInstance: false, label: 'Zap' } }],
      def
    );
    expect(noCost).toBe('Activate "Zap" (cost: no cost; outside a priority window): add 1 to Score.');

    const withCostAndWindow = generateRulesProse(
      [
        {
          ...baseRule,
          condition: null,
          activation: {
            costCheck: { kind: 'criteria', left: { kind: 'pool', poolId: 'score', seat: null }, op: '>', right: { kind: 'literal', value: 0 } },
            cost: [{ kind: 'changePool' as const, poolId: 'score', seat: null, op: 'subtract' as const, amount: { kind: 'literal', value: 1 } }],
            window: 'window-referenced',
            perInstance: true,
            label: 'Zap',
          },
        },
      ],
      def
    );
    expect(withCostAndWindow).toBe(
      'Activate "Zap" (cost: subtract 1 from Score, if Score is above 0; Referenced Window): add 1 to Score.'
    );
  });
});

// ---------------------------------------------------------------------------
// Step 46 — the panel half of §8's trap 2. `EVERY_EFFECT` above proves no effect kind renders
// blank; a rule can also take ALL of its text from a panel, and a `modifier` rule takes it with
// `effects` empty, which is the shape most likely to come out blank somewhere. Keyed by the four
// panel names so a fifth panel has to be added here deliberately rather than slip through.
// ---------------------------------------------------------------------------

const PANEL_BASE: RuleSet = {
  id: 'r-panel',
  name: 'Panel',
  trigger: 'onGameStart',
  stateFilter: null,
  condition: null,
  effects: [{ kind: 'changePool', poolId: 'score', seat: null, op: 'add', amount: { kind: 'literal', value: 1 } }],
  priority: 0,
  onRejection: 'continue',
  modifier: null,
  continuous: false,
  replaces: null,
  activation: null,
};

const PANEL_RULE: Record<'continuous' | 'modifier' | 'replaces' | 'activation', RuleSet> = {
  continuous: {
    ...PANEL_BASE,
    continuous: true,
    condition: { kind: 'criteria', left: { kind: 'pool', poolId: 'score', seat: null }, op: '>=', right: { kind: 'literal', value: 10 } },
  },
  // Effects deliberately empty: §5.4 says a modifier rule never fires one, so this is the real shape.
  modifier: {
    ...PANEL_BASE,
    effects: [],
    modifier: { scope: { kind: 'triggeringCard' }, indexId: 'power', op: 'adjust', amount: { kind: 'literal', value: 1 }, activeZones: ['bf'] },
  },
  replaces: {
    ...PANEL_BASE,
    replaces: { effectKind: 'drawCards', match: { kind: 'criteria', left: { kind: 'replacedAmount' }, op: '>', right: { kind: 'literal', value: 1 } } },
  },
  activation: {
    ...PANEL_BASE,
    activation: {
      costCheck: { kind: 'criteria', left: { kind: 'pool', poolId: 'score', seat: null }, op: '>', right: { kind: 'literal', value: 0 } },
      cost: [{ kind: 'changePool', poolId: 'score', seat: null, op: 'subtract', amount: { kind: 'literal', value: 1 } }],
      window: 'window-referenced',
      perInstance: true,
      label: 'Zap',
    },
  },
};

describe('generateRulesProse — exhaustive over the four RuleSet panels', () => {
  it.each(Object.entries(PANEL_RULE))('%s renders prose with no missing referent', (panel, rule) => {
    // Guards the samples: the panel a row claims to exercise must be the one that is actually set.
    const set = (['continuous', 'modifier', 'replaces', 'activation'] as const).filter(
      (k) => rule[k] !== false && rule[k] !== null
    );
    expect(set).toEqual([panel]);

    const text = generateRulesProse([rule], def);
    expect(text).not.toBe('');
    expect(text.trim()).toBe(text);
    expect(text).not.toContain('[deleted');
    // A panel that fell through to the ordinary trigger sentence would still be non-empty.
    expect(text.startsWith('When ')).toBe(false);
  });
});
