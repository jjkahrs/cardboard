import { describe, expect, it } from 'vitest';
import { createPlayState } from './setup';
import {
  ACTIVE_PLAYER_POOL_ID,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
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
    priorityWindows: [],
    machine,
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

  // -------------------------------------------------------------------------
  // The seat ring (§3.5) and the card identity fields (§4.3)
  // -------------------------------------------------------------------------

  it('initialises the seat ring to 0..playerCount-1 with nothing eliminated', () => {
    const state = createPlayState(baseDef({ playerCount: 4 }), '12345');
    expect(state.seatOrder).toEqual([0, 1, 2, 3]);
    expect(state.eliminated).toEqual([]);
  });

  it('keeps per-seat storage dense and full-length — one zone instance and one pool slot per seat', () => {
    const pool: PointPool = { id: 'hp', scope: 'player', value: { type: 'integer', name: 'HP', defaultValue: 20, min: null, max: null } };
    const state = createPlayState(baseDef({ playerCount: 3, zones: [handZone], pools: [pool] }), '12345');
    expect(state.playerPools.hp).toEqual([20, 20, 20]);
    expect(Object.keys(state.zones).sort()).toEqual(['hand#0', 'hand#1', 'hand#2']);
  });

  it('seeds tags from the template as a per-instance COPY, and leaves controller/attachedTo null', () => {
    const tagged: CardTemplate = { ...cardTemplate, tags: ['creature', 'token'] };
    const deckZone: PlayZone = { id: 'deck', name: 'Deck', scope: 'shared', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null };
    const deck: Deck = { id: 'd', name: 'D', zoneId: 'deck', entries: [{ templateId: 'card', quantity: 2 }] };
    const def = baseDef({ playerCount: 1, zones: [deckZone], decks: [deck], templates: [tagged] });

    const state = createPlayState(def, '12345');
    const [a, b] = state.zones['deck'].cardIds;
    expect(state.cards[a].tags).toEqual(['creature', 'token']);
    expect(state.cards[a].controller).toBeNull();
    expect(state.cards[a].attachedTo).toBeNull();

    // Two instances of one template must not share the array, and neither may alias the definition:
    // a `setTag` on one instance would otherwise silently retag every card in the game.
    expect(state.cards[a].tags).not.toBe(tagged.tags);
    expect(state.cards[a].tags).not.toBe(state.cards[b].tags);
    state.cards[a].tags.push('enchanted');
    expect(state.cards[b].tags).toEqual(['creature', 'token']);
    expect(tagged.tags).toEqual(['creature', 'token']);
  });

  it('sets owner at deal time: the seat of the player-scoped zone dealt into, null for a shared one', () => {
    const sharedZone: PlayZone = { id: 'deck', name: 'Deck', scope: 'shared', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null };
    const def = baseDef({
      playerCount: 2,
      zones: [sharedZone, handZone],
      decks: [
        { id: 'shared', name: 'Shared', zoneId: 'deck', entries: [{ templateId: 'card', quantity: 2 }] },
        { id: 'perSeat', name: 'Per seat', zoneId: 'hand', entries: [{ templateId: 'card', quantity: 2 }] },
      ],
    });

    const state = createPlayState(def, '12345');
    const owners = (key: string) => state.zones[key].cardIds.map((id) => state.cards[id].owner);
    expect(owners('deck')).toEqual([null, null]);
    expect(owners('hand#0')).toEqual([0, 0]);
    expect(owners('hand#1')).toEqual([1, 1]);
  });

  it('does not mutate the input definition', () => {
    const def = baseDef({ playerCount: 2, zones: [handZone, battlefieldZone] });
    const snapshot = JSON.parse(JSON.stringify(def));
    createPlayState(def, '12345');
    expect(def).toEqual(snapshot);
  });

  // -------------------------------------------------------------------------
  // v2 §4.8, §4.10 — the pending-action layer's four new PlayState fields, seeded empty
  // -------------------------------------------------------------------------

  it('seeds the pending-action layer empty: no pending actions, no stack, no continuous firings, zero priority rounds', () => {
    const state = createPlayState(baseDef(), '12345');
    expect(state.pendingActions).toEqual({});
    expect(state.actionStack).toEqual([]);
    expect(state.continuousFired).toEqual({});
    expect(state.budget.priorityRounds).toBe(0);
  });
});
