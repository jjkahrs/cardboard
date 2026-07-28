import { describe, expect, it } from 'vitest';
import { createPlayState } from './setup';
import {
  ACTIVE_PLAYER_POOL_ID,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
  type CardTemplate,
  type Deck,
  type GameDefinition,
  type PlayZone,
  type PointPool,
} from './types';

const cardTemplate: CardTemplate = {
  id: 'card',
  name: 'Card',
  marquee: 'Card',
  faceIcon: 'gi-card',
  borderColor: '#000000',
  tags: [],
  indexes: [
    { id: 'power', value: { type: 'integer', name: 'Power', defaultValue: 3, min: null, max: null }, icon: 'gi-sword', position: 'topLeft' },
  ],
  ruleSetIds: [],
  rulesTextOverride: null,
};

const machine = {
  states: [
    { id: START_STATE_ID, name: 'Start', enterableFrom: [], exitableTo: [END_STATE_ID], entryCriteria: null, transitionLabel: null, priority: 0, position: { x: 0, y: 0 } },
    { id: END_STATE_ID, name: 'End', enterableFrom: [START_STATE_ID], exitableTo: [], entryCriteria: null, transitionLabel: null, priority: 0, position: { x: 0, y: 0 } },
  ],
  startStateId: START_STATE_ID,
  endStateId: END_STATE_ID,
};

/** Minimal valid definition; each test overrides only the fields it cares about. */
function baseDef(overrides: Partial<GameDefinition> = {}): GameDefinition {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'test-def',
    name: 'Test',
    playerCount: 2,
    pools: [],
    zones: [],
    templates: [cardTemplate],
    decks: [],
    customEvents: [],
    ruleSets: [],
    globalRuleSetIds: [],
    machine,
    limits: { maxDepth: DEFAULT_MAX_DEPTH, maxEffects: DEFAULT_MAX_EFFECTS },
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const handZone: PlayZone = { id: 'hand', name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: null };
const battlefieldZone: PlayZone = { id: 'battlefield', name: 'Battlefield', scope: 'shared', visibility: 'faceUp', layout: 'row', ordered: false, maxCapacity: null };

describe('createPlayState', () => {
  it('AC: S1 — instances one shared zone once (seat null) and a player zone once per seat', () => {
    const def = baseDef({ playerCount: 2, zones: [handZone, battlefieldZone] });
    const state = createPlayState(def, '12345');

    const hands = Object.values(state.zones).filter((z) => z.zoneId === 'hand');
    expect(hands).toHaveLength(2);
    expect(hands.map((z) => z.seat).sort()).toEqual([0, 1]);

    const battlefields = Object.values(state.zones).filter((z) => z.zoneId === 'battlefield');
    expect(battlefields).toHaveLength(1);
    expect(battlefields[0].seat).toBeNull();
  });

  it('AC: S2 — a seeded 40-card deck matches an inlined golden id order, not just self-consistency', () => {
    const deckZone: PlayZone = { id: 'deck', name: 'Deck', scope: 'shared', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null };
    const deck: Deck = { id: 'deck40', name: 'Deck', zoneId: 'deck', entries: [{ templateId: 'card', quantity: 40 }] };
    const def = baseDef({ playerCount: 1, zones: [deckZone], decks: [deck] });

    const stateA = createPlayState(def, '12345');
    const stateB = createPlayState(def, '12345');

    // self-consistency: two independent calls with the same seed are deep-equal...
    expect(stateA).toEqual(stateB);

    // ...and locked against a golden array, so a broken PRNG that's merely self-consistent still fails.
    const golden = [
      'c39', 'c31', 'c37', 'c11', 'c35', 'c9', 'c15', 'c38', 'c33', 'c23',
      'c4', 'c26', 'c36', 'c6', 'c3', 'c32', 'c22', 'c5', 'c0', 'c12',
      'c29', 'c20', 'c24', 'c13', 'c16', 'c2', 'c8', 'c21', 'c7', 'c18',
      'c1', 'c25', 'c10', 'c19', 'c14', 'c28', 'c17', 'c34', 'c30', 'c27',
    ];
    expect(stateA.zones['deck'].cardIds).toEqual(golden);
  });

  it('§9.4 item 1 — two same-seed sessions are byte-identical, including card instance ids', () => {
    const deckZone: PlayZone = { id: 'deck', name: 'Deck', scope: 'shared', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null };
    const deck: Deck = { id: 'deck40', name: 'Deck', zoneId: 'deck', entries: [{ templateId: 'card', quantity: 40 }] };
    const def = baseDef({ playerCount: 1, zones: [deckZone], decks: [deck] });

    const a = createPlayState(def, 'same-seed');
    const b = createPlayState(def, 'same-seed');
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('auto-creates activePlayer at 0 when the definition does not declare it', () => {
    const state = createPlayState(baseDef(), '12345');
    expect(state.pools[ACTIVE_PLAYER_POOL_ID]).toBe(0);
  });

  it('leaves an authored activePlayer pool default untouched', () => {
    const authoredPool: PointPool = {
      id: ACTIVE_PLAYER_POOL_ID,
      scope: 'game',
      value: { type: 'integer', name: 'Active Player', defaultValue: 1, min: null, max: null },
    };
    const state = createPlayState(baseDef({ pools: [authoredPool] }), '12345');
    expect(state.pools[ACTIVE_PLAYER_POOL_ID]).toBe(1);
  });

  it('player-scoped deck target: each seat gets its own instances, none shared between seats', () => {
    const handDeckZone: PlayZone = { id: 'hand', name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: null };
    const deck: Deck = { id: 'starter', name: 'Starter', zoneId: 'hand', entries: [{ templateId: 'card', quantity: 3 }] };
    const def = baseDef({ playerCount: 2, zones: [handDeckZone], decks: [deck] });

    const state = createPlayState(def, '12345');
    const seat0 = state.zones[`hand#0`].cardIds;
    const seat1 = state.zones[`hand#1`].cardIds;
    expect(seat0).toHaveLength(3);
    expect(seat1).toHaveLength(3);
    expect(new Set([...seat0, ...seat1]).size).toBe(6); // no overlap
  });

  it('seeds card indexValues from the template defaults', () => {
    const deckZone: PlayZone = { id: 'deck', name: 'Deck', scope: 'shared', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null };
    const deck: Deck = { id: 'd', name: 'D', zoneId: 'deck', entries: [{ templateId: 'card', quantity: 1 }] };
    const def = baseDef({ playerCount: 1, zones: [deckZone], decks: [deck] });

    const state = createPlayState(def, '12345');
    const [cardId] = state.zones['deck'].cardIds;
    expect(state.cards[cardId].indexValues).toEqual({ power: 3 });
    expect(state.cards[cardId].faceDown).toBe(false);
    expect(state.cards[cardId].rotated).toBe(false);
  });

  it('does not mutate the input definition', () => {
    const def = baseDef({ playerCount: 2, zones: [handZone, battlefieldZone] });
    const snapshot = JSON.parse(JSON.stringify(def));
    createPlayState(def, '12345');
    expect(def).toEqual(snapshot);
  });
});
