/**
 * Step 13 — the authoring store. AC: A1, A2, plus the store half of P3 and §9.4 item 2.
 *
 * Runs under the `engine` vitest project: node, no DOM, `Math.random` trapped. Both injected
 * dependencies (clock, id source) are deterministic here, so `updatedAt` and every generated id are
 * exact-comparable rather than "some string".
 */

import { describe, expect, it } from 'vitest';
import { exportJson, validateDefinition } from '../engine/schema';
import type { GameDefinition, PointPool, PlayZone } from '../engine/types';
import {
  createDefinitionStore,
  createEmptyDefinition,
  findReferrers,
  type DefinitionStore,
} from './definitionStore';
import {
  ATTACKERS,
  BATTLEFIELD,
  COMBAT,
  DECK,
  duel,
  HAND,
  HP,
  MAIN,
  malformed,
  POWER,
  RS_STRIKE,
  STARTER_DECK,
  STRIKE,
  empty,
  UNTAP,
} from '../test/fixtures';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Injected clock: a counter, not a time source. Makes `updatedAt` an exact assertion. */
function testClock() {
  let n = 0;
  return {
    now: () => `t${n}`,
    /** advance so the next accepted edit writes a distinguishable stamp */
    tick: () => `t${++n}`,
  };
}

function storeWith(definition: GameDefinition) {
  const clock = testClock();
  let seq = 0;
  const store = createDefinitionStore({
    definition,
    now: clock.now,
    nextId: (prefix) => `${prefix}_${++seq}`,
  });
  return { store, clock };
}

const ok = (r: ReturnType<DefinitionStore['addPool']>): string | undefined => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.errors.join(' | ')}`);
  return r.id;
};

const errorsOf = (r: { ok: boolean; errors?: string[] }): string[] => {
  expect(r.ok).toBe(false);
  return r.errors ?? [];
};

const HP_POOL: Omit<PointPool, 'id'> = {
  scope: 'player',
  value: { type: 'integer', name: 'HP', defaultValue: 20, min: 0, max: 20 },
};

const handZone: Omit<PlayZone, 'id'> = {
  name: 'Hand',
  scope: 'player',
  visibility: 'ownerOnly',
  layout: 'fan',
  ordered: true,
  maxCapacity: 7,
};

// ---------------------------------------------------------------------------

describe('createEmptyDefinition', () => {
  it('produces a definition that passes the shared validator', () => {
    expect(validateDefinition(createEmptyDefinition('game_1', 'Untitled', 't0'))).toEqual([]);
  });

  it('is what a default store starts from', () => {
    const store = createDefinitionStore({ now: () => 't0', nextId: (p) => `${p}_1` });
    expect(store.getState().definition.id).toBe('game_1');
    expect(store.getState().definition.machine.states.map((s) => s.id)).toEqual(['start', 'end']);
  });
});

describe('pools', () => {
  // AC: A1
  it('creates an integer pool with a default, min and max, and makes it selectable as a ValueRef', () => {
    const { store } = storeWith(empty);

    const id = ok(store.getState().addPool(HP_POOL));

    // In the list a pool picker reads.
    const pools = store.getState().definition.pools;
    expect(pools).toHaveLength(1);
    expect(pools[0]).toEqual({
      id,
      scope: 'player',
      value: { type: 'integer', name: 'HP', defaultValue: 20, min: 0, max: 20 },
    });

    // Structurally selectable: a rule built on `{kind:'pool', poolId}` resolves under the same
    // referential-integrity gate the importer runs. Before the pool exists it does not.
    const usesHp = (poolId: string): GameDefinition => ({
      ...store.getState().definition,
      ruleSets: [
        {
          id: 'rs_probe',
          name: 'Probe',
          trigger: 'onGameStart',
          stateFilter: null,
          condition: {
            kind: 'criteria',
            left: { kind: 'pool', poolId, seat: { kind: 'active' } },
            op: '>',
            right: { kind: 'literal', value: 0 },
          },
          effects: [],
          priority: 0,
          onRejection: 'continue',
        },
      ],
    });
    expect(validateDefinition(usesHp(id!))).toEqual([]);
    expect(validateDefinition(usesHp('pool_nope')).join('\n')).toContain('Unknown pool id');
  });

  it('rejects a pool whose min exceeds its max, using the schema rule rather than its own', () => {
    const { store } = storeWith(empty);
    const before = store.getState();

    const errors = errorsOf(
      store.getState().addPool({
        scope: 'game',
        value: { type: 'integer', name: 'Broken', defaultValue: 0, min: 10, max: 0 },
      })
    );

    expect(errors.join('\n')).toContain('must be less than or equal to max');
    expect(store.getState()).toBe(before);
  });

  it('generates ids that do not collide with ids already in the definition', () => {
    const { store } = storeWith({
      ...empty,
      pools: [{ id: 'pool_1', ...HP_POOL }],
    });
    expect(ok(store.getState().addPool(HP_POOL))).not.toBe('pool_1');
  });
});

describe('zones', () => {
  // AC: A2
  it('rejects a second zone named Hand, creates nothing, and leaves the state referentially unchanged', () => {
    const { store } = storeWith(empty);
    ok(store.getState().addZone(handZone));

    const before = store.getState();
    const beforeDefinition = before.definition;
    expect(beforeDefinition.zones).toHaveLength(1);
    // Guards the identity assertion below from being vacuous: an ACCEPTED edit does replace both.
    ok(store.getState().addZone({ ...handZone, name: 'Scratch' }));
    expect(store.getState()).not.toBe(before);
    ok(store.getState().removeZone(store.getState().definition.zones[1].id));
    const settled = store.getState();

    const errors = errorsOf(store.getState().addZone({ ...handZone, name: 'Hand' }));

    expect(errors.join('\n').toLowerCase()).toContain('zone names must be unique');
    expect(store.getState().definition.zones).toHaveLength(1);
    // Identity, not deep equality: nothing was written, so nothing was rebuilt.
    expect(store.getState()).toBe(settled);
    expect(store.getState().definition).toBe(settled.definition);
  });

  it('accepts a second zone with a different name', () => {
    const { store } = storeWith(empty);
    ok(store.getState().addZone(handZone));
    ok(store.getState().addZone({ ...handZone, name: 'Discard' }));
    expect(store.getState().definition.zones.map((z) => z.name)).toEqual(['Hand', 'Discard']);
  });

  it('rejects renaming a zone onto another zone name', () => {
    const { store } = storeWith(duel);
    const before = store.getState();
    errorsOf(store.getState().updateZone(HAND, { name: 'Deck' }));
    expect(store.getState()).toBe(before);
  });

  it('rejects maxCapacity 0, which the schema calls an unusable zone', () => {
    const { store } = storeWith(empty);
    const errors = errorsOf(store.getState().addZone({ ...handZone, maxCapacity: 0 }));
    expect(errors.join('\n')).toContain('maxCapacity');
  });
});

// ---------------------------------------------------------------------------
// §9.4 item 2 / §5.9 row 3b — delete is blocked and names the referrers
// ---------------------------------------------------------------------------

describe('deleting a referenced entity', () => {
  it('blocks deleting a pool and names every rule that reads it', () => {
    const { store } = storeWith(duel);
    const before = store.getState();

    const errors = errorsOf(store.getState().removePool(HP));

    expect(errors[0]).toContain('Cannot delete pool');
    // Strike subtracts HP; Bomb subtracts HP.
    expect(errors.join('\n')).toContain('Rule set "Strike"');
    expect(errors.join('\n')).toContain('Rule set "Bomb"');
    expect(errors.some((e) => e.includes('poolId'))).toBe(true);
    expect(store.getState()).toBe(before);
    expect(store.getState().definition.pools.map((p) => p.id)).toContain(HP);
  });

  it('blocks deleting a zone and names both the rule and the deck that point at it', () => {
    const { store } = storeWith(duel);

    const errors = errorsOf(store.getState().removeZone(DECK));

    expect(errors.join('\n')).toContain('Rule set "Cantrip"');
    expect(errors.join('\n')).toContain('Deck "Starter"');
    expect(errors.join('\n')).toContain(`decks.0.zoneId`);
  });

  it('blocks deleting a rule set and names the card it is attached to', () => {
    const { store } = storeWith(duel);

    const errors = errorsOf(store.getState().removeRuleSet(RS_STRIKE));

    expect(errors.join('\n')).toContain('Card "Strike"');
    expect(errors.join('\n')).toContain('templates.0.ruleSetIds.0');
  });

  it('blocks deleting a card template that a deck lists', () => {
    const { store } = storeWith(duel);
    expect(errorsOf(store.getState().removeTemplate(STRIKE)).join('\n')).toContain('Deck "Starter"');
  });

  it('blocks deleting a card index a rule reads', () => {
    const { store } = storeWith({
      ...duel,
      ruleSets: [
        ...duel.ruleSets,
        {
          id: 'rs_pump',
          name: 'Pump',
          trigger: 'onCardPlayed',
          stateFilter: null,
          condition: null,
          effects: [
            {
              kind: 'setCardIndex',
              target: { kind: 'triggeringCard' },
              indexId: POWER,
              op: 'add',
              amount: { kind: 'literal', value: 1 },
            },
          ],
          priority: 0,
          onRejection: 'continue',
        },
      ],
    });

    expect(errorsOf(store.getState().removeCardIndex('tpl_grunt', POWER)).join('\n')).toContain(
      'Rule set "Pump"'
    );
  });

  it('blocks deleting a machine state other states can reach', () => {
    const { store } = storeWith(duel);

    const errors = errorsOf(store.getState().removeState(MAIN));

    expect(errors.join('\n')).toContain('State "Combat"');
    expect(errors.join('\n')).toContain('enterableFrom');
  });

  it('allows deleting an unreferenced entity', () => {
    const { store } = storeWith(duel);
    const spare = ok(store.getState().addPool({ scope: 'game', value: { type: 'boolean', name: 'Spare', defaultValue: false } }));

    expect(findReferrers(store.getState().definition, 'pool', spare!)).toEqual([]);
    ok(store.getState().removePool(spare!));
    expect(store.getState().definition.pools.map((p) => p.id)).not.toContain(spare);
  });

  it('allows deleting a state once its edges are disconnected, and blocks it before', () => {
    const { store } = storeWith(duel);
    // Untap is reachable only from `start`.
    errorsOf(store.getState().removeState(UNTAP));
    ok(store.getState().disconnectStates('start', UNTAP));
    ok(store.getState().removeState(UNTAP));
    expect(store.getState().definition.machine.states.map((s) => s.id)).not.toContain(UNTAP);
  });

  it('does not count an entity referencing itself as a referrer', () => {
    // Combat lists Main in enterableFrom; Main is not its own referrer through that edge.
    const refs = findReferrers(duel, 'state', COMBAT);
    expect(refs.every((r) => r.ownerId !== COMBAT)).toBe(true);
  });
});

describe('findReferrers', () => {
  it('finds a zone referenced from inside a nested prompt selector', () => {
    const refs = findReferrers(duel, 'zone', BATTLEFIELD);
    expect(refs.map((r) => r.path)).toContain('ruleSets.3.effects.0.target.from.zone.zoneId');
  });

  it('finds a pool referenced from a state entry criterion', () => {
    const refs = findReferrers(duel, 'pool', ATTACKERS);
    expect(refs.map((r) => r.path)).toContain('machine.states.2.entryCriteria.left.poolId');
    expect(refs.find((r) => r.ownerKind === 'state')?.ownerName).toBe('Combat');
  });

  it('returns nothing for an id no one references', () => {
    expect(findReferrers(duel, 'zone', 'zone_nonexistent')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Renaming — names are display-only, so nothing can dangle
// ---------------------------------------------------------------------------

describe('renaming', () => {
  it('renames a pool without dangling any rule that references it', () => {
    const { store } = storeWith(duel);
    const hp = duel.pools.find((p) => p.id === HP)!;

    ok(store.getState().updatePool(HP, { value: { ...hp.value, name: 'Life Total' } }));

    const after = store.getState().definition;
    expect(after.pools.find((p) => p.id === HP)!.value.name).toBe('Life Total');
    // Every referrer still points at the same id, and the whole definition still validates.
    expect(findReferrers(after, 'pool', HP)).toEqual(findReferrers(duel, 'pool', HP));
    expect(validateDefinition(after)).toEqual([]);
  });

  it('renames a zone and a rule set without dangling anything', () => {
    const { store } = storeWith(duel);
    ok(store.getState().updateZone(DECK, { name: 'Library' }));
    ok(store.getState().updateRuleSet(RS_STRIKE, { name: 'Bolt' }));

    const after = store.getState().definition;
    expect(validateDefinition(after)).toEqual([]);
    expect(after.decks.find((d) => d.id === STARTER_DECK)!.zoneId).toBe(DECK);
    expect(after.templates.find((t) => t.id === STRIKE)!.ruleSetIds).toEqual([RS_STRIKE]);
    // The blocked-delete message now shows the new name, still against the same id.
    expect(errorsOf(store.getState().removeRuleSet(RS_STRIKE)).join('\n')).toContain('Card "Strike"');
  });
});

// ---------------------------------------------------------------------------
// updatedAt — bumped by the CRUD actions, from the injected clock only (§7.3)
// ---------------------------------------------------------------------------

describe('updatedAt', () => {
  it('bumps on an accepted edit, using the injected clock', () => {
    const { store, clock } = storeWith(empty);
    expect(store.getState().definition.updatedAt).toBe(empty.updatedAt);

    ok(store.getState().addZone(handZone));
    expect(store.getState().definition.updatedAt).toBe('t0');

    clock.tick();
    ok(store.getState().setName('Renamed'));
    expect(store.getState().definition.updatedAt).toBe('t1');
  });

  it('does not bump on a rejected edit', () => {
    const { store, clock } = storeWith(empty);
    ok(store.getState().addZone(handZone));
    const stamped = store.getState().definition.updatedAt;

    clock.tick();
    errorsOf(store.getState().addZone(handZone));

    expect(store.getState().definition.updatedAt).toBe(stamped);
  });

  it('is not written by an import — the file owns its own timestamp (§4.9)', () => {
    const { store, clock } = storeWith(empty);
    clock.tick();

    ok(store.getState().importDefinition(exportJson(duel)));

    expect(store.getState().definition.updatedAt).toBe(duel.updatedAt);
  });

  it('is not written by setDefinition either', () => {
    const { store } = storeWith(empty);
    ok(store.getState().setDefinition(duel));
    expect(store.getState().definition.updatedAt).toBe(duel.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// AC: P3 (store half) — a failed import touches nothing
// ---------------------------------------------------------------------------

describe('import', () => {
  it.each(malformed.map((m) => [m.label, m] as const))(
    'leaves the store referentially unchanged after importing %s',
    (_label, row) => {
      const { store } = storeWith(duel);
      const before = store.getState();
      const beforeDefinition = before.definition;

      const errors = errorsOf(store.getState().importDefinition(row.json));

      expect(errors.join('\n')).toContain(row.expectedError);
      expect(store.getState()).toBe(before);
      expect(store.getState().definition).toBe(beforeDefinition);
    }
  );

  it('replaces the definition when every gate passes', () => {
    const { store } = storeWith(empty);
    const id = ok(store.getState().importDefinition(exportJson(duel)));

    expect(id).toBe(duel.id);
    expect(store.getState().definition).toEqual(duel);
  });

  it('rejects a structurally valid definition with dangling references via setDefinition', () => {
    const { store } = storeWith(empty);
    const before = store.getState();

    const errors = errorsOf(
      store.getState().setDefinition({ ...duel, pools: duel.pools.filter((p) => p.id !== HP) })
    );

    expect(errors.join('\n')).toContain('Unknown pool id');
    expect(store.getState()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The rest of the CRUD surface
// ---------------------------------------------------------------------------

describe('CRUD surface', () => {
  it('reports a missing id rather than silently succeeding', () => {
    const { store } = storeWith(duel);
    const before = store.getState();

    for (const r of [
      store.getState().updatePool('nope', {}),
      store.getState().updateZone('nope', {}),
      store.getState().updateTemplate('nope', {}),
      store.getState().updateDeck('nope', {}),
      store.getState().updateRuleSet('nope', {}),
      store.getState().updateState('nope', {}),
      store.getState().updateCardIndex('nope', 'nope', {}),
      store.getState().addCardIndex('nope', {
        value: { type: 'boolean', name: 'X', defaultValue: false },
        icon: 'gi-x',
        position: 'topLeft',
      }),
      store.getState().connectStates(MAIN, 'nope'),
    ]) {
      expect(errorsOf(r).join('\n')).toContain('No ');
    }
    expect(store.getState()).toBe(before);
  });

  it('adds and removes card indexes, decks, custom events and global rule sets', () => {
    const { store } = storeWith(duel);

    const idx = ok(
      store.getState().addCardIndex(STRIKE, {
        value: { type: 'integer', name: 'Cost', defaultValue: 1, min: 0, max: 9 },
        icon: 'gi-coins',
        position: 'topLeft',
      })
    );
    expect(store.getState().definition.templates[0].indexes.map((i) => i.id)).toEqual([idx]);
    ok(store.getState().updateCardIndex(STRIKE, idx!, { position: 'topRight' }));
    expect(store.getState().definition.templates[0].indexes[0].position).toBe('topRight');
    ok(store.getState().removeCardIndex(STRIKE, idx!));
    expect(store.getState().definition.templates[0].indexes).toEqual([]);

    const deck = ok(store.getState().addDeck({ name: 'Side', zoneId: HAND, entries: [] }));
    ok(store.getState().removeDeck(deck!));
    expect(store.getState().definition.decks.map((d) => d.id)).toEqual([STARTER_DECK]);

    ok(store.getState().addCustomEvent('resonate'));
    ok(store.getState().addCustomEvent('resonate'));
    expect(store.getState().definition.customEvents).toEqual(['resonate']);
    ok(store.getState().removeCustomEvent('resonate'));
    expect(store.getState().definition.customEvents).toEqual([]);

    ok(store.getState().setGlobalRuleSet(RS_STRIKE, true));
    ok(store.getState().setGlobalRuleSet(RS_STRIKE, true));
    expect(store.getState().definition.globalRuleSetIds).toEqual([RS_STRIKE]);
    ok(store.getState().setGlobalRuleSet(RS_STRIKE, false));
    expect(store.getState().definition.globalRuleSetIds).toEqual([]);
  });

  it('writes both sides of a state edge, so a connect never produces a one-sided edge', () => {
    const { store } = storeWith(duel);

    ok(store.getState().connectStates(MAIN, UNTAP));

    const states = store.getState().definition.machine.states;
    expect(states.find((s) => s.id === MAIN)!.exitableTo).toContain(UNTAP);
    expect(states.find((s) => s.id === UNTAP)!.enterableFrom).toContain(MAIN);
    expect(validateDefinition(store.getState().definition)).toEqual([]);
  });

  it('rejects a hand-written one-sided edge, naming the missing side', () => {
    const { store } = storeWith(duel);
    const before = store.getState();

    const errors = errorsOf(
      store.getState().updateState(MAIN, { exitableTo: [COMBAT, 'state_endTurn', UNTAP] })
    );

    expect(errors.join('\n')).toContain('One-sided edge');
    expect(store.getState()).toBe(before);
  });

  it('adds a state and keeps the definition valid', () => {
    const { store } = storeWith(duel);
    const id = ok(
      store.getState().addState({
        name: 'Upkeep',
        enterableFrom: [],
        exitableTo: [],
        entryCriteria: null,
        transitionLabel: 'Upkeep',
        priority: 0,
        position: { x: 0, y: 200 },
      })
    );
    ok(store.getState().connectStates(MAIN, id!));
    expect(validateDefinition(store.getState().definition)).toEqual([]);
  });

  it('rejects a player count below 1', () => {
    const { store } = storeWith(duel);
    const before = store.getState();
    errorsOf(store.getState().setPlayerCount(0));
    expect(store.getState()).toBe(before);
    ok(store.getState().setPlayerCount(4));
    expect(store.getState().definition.playerCount).toBe(4);
  });
});
