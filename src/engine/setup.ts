import type { CardInstance, GameDefinition, Id, PlayState, ZoneInstance } from './types';
import { ACTIVE_PLAYER_POOL_ID } from './types';
import { zoneKey } from './valueRef';
import { hashSeed, shuffle } from './rng';

/** Builds the settled initial `PlayState`. Does not fire onGameStart or enqueue anything — dispatch owns that. */
export function createPlayState(def: GameDefinition, seed: string): PlayState {
  const { playerCount } = def;

  // --- zone instancing: one per shared zone, one per seat for player-scoped zones ---
  const zones: Record<string, ZoneInstance> = {};
  for (const zone of def.zones) {
    if (zone.scope === 'shared') {
      zones[zoneKey(zone.id, null)] = { zoneId: zone.id, seat: null, cardIds: [] };
    } else {
      for (let seat = 0; seat < playerCount; seat++) {
        zones[zoneKey(zone.id, seat)] = { zoneId: zone.id, seat, cardIds: [] };
      }
    }
  }

  // --- pool defaults ---
  const pools: Record<Id, number | boolean> = {};
  const playerPools: Record<Id, (number | boolean)[]> = {};
  for (const pool of def.pools) {
    if (pool.scope === 'game') {
      pools[pool.id] = pool.value.defaultValue;
    } else {
      playerPools[pool.id] = Array.from({ length: playerCount }, () => pool.value.defaultValue);
    }
  }
  // activePlayer: engine-owned, created only if the definition didn't author one itself.
  if (!(ACTIVE_PLAYER_POOL_ID in pools)) {
    pools[ACTIVE_PLAYER_POOL_ID] = 0;
  }

  // --- deck instantiation + seeded shuffle ---
  const templatesById = new Map(def.templates.map((t) => [t.id, t] as const));
  const zonesById = new Map(def.zones.map((z) => [z.id, z] as const));
  const cards: Record<Id, CardInstance> = {};
  let nextSeq = 0;
  const seedHash = hashSeed(seed);
  let cursor = 0;

  for (const deck of def.decks) {
    const targetZone = zonesById.get(deck.zoneId);
    if (!targetZone) continue; // dangling ref: import validation's job, not setup's
    const seats: (number | null)[] =
      targetZone.scope === 'shared' ? [null] : Array.from({ length: playerCount }, (_, i) => i);

    for (const seat of seats) {
      const instanceIds: Id[] = [];
      for (const entry of deck.entries) {
        const template = templatesById.get(entry.templateId);
        if (!template) continue;
        for (let i = 0; i < entry.quantity; i++) {
          const id = `c${nextSeq++}`;
          const indexValues: Record<Id, number | boolean> = {};
          for (const index of template.indexes) {
            indexValues[index.id] = index.value.defaultValue;
          }
          cards[id] = { id, templateId: template.id, indexValues, faceDown: false, rotated: false };
          instanceIds.push(id);
        }
      }
      const shuffled = shuffle(instanceIds, seedHash, cursor);
      cursor = shuffled.cursor;
      // Append, never assign: two decks may target the same zone (DecksScreen defaults every new
      // deck to the first zone), and assigning would orphan the earlier deck's already-minted cards
      // in `state.cards` with no zone holding them.
      zones[zoneKey(deck.zoneId, seat)].cardIds.push(...shuffled.items);
    }
  }

  return {
    definitionId: def.id,
    seed,
    rngCursor: cursor,
    nextSeq,
    nextWorkId: 0,
    logSeq: 0,
    playerCount,
    // The ring starts full and in seat order; SeatIds are the indices themselves (§3.5). Storage
    // below is dense and full-length forever — elimination edits this array, never the storage.
    seatOrder: Array.from({ length: playerCount }, (_, i) => i),
    eliminated: [],
    pools,
    playerPools,
    cards,
    zones,
    currentStateId: def.machine.startStateId,
    finished: false,
    stack: [],
    pending: [],
    interaction: null,
    budget: { causalDepth: 0, effectsUsed: 0, settleIterations: 0 },
  };
}
