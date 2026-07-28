/**
 * §9.1 rows A4 and R3, §5.3's shortfall/constraint asymmetry, §5.9 rows 1/1b/2/2b/3/3b/4/4b/15/16,
 * §9.3 "Clamping", §9.4 items 3, 5, 6, 14.
 *
 * `state` is a plain mutable object, not an immer draft — `applyEffect` only ever mutates its
 * argument, and keeping immer out of these tests is what keeps the engine honest about being
 * immer-agnostic (§3.2).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { applyEffect, canMove, clampValue, type EffectContext } from './effects';
import { createPlayState } from './setup';
import { zoneKey } from './valueRef';
import { controllerOf, ownerOf } from './seats';
import { evalCriteria } from './criteria';
import { effectiveTags } from './modifiers';
import { resolveTargets } from './targets';
import { ACTIVE_PLAYER_POOL_ID } from './types';
import type {
  CriteriaNode,
  Effect,
  EventName,
  GameValue,
  Id,
  InsertPosition,
  LogLine,
  PlayState,
  TriggerContext,
} from './types';
import {
  ATTACKERS,
  BATTLEFIELD,
  COMBAT,
  CREATURE_TAG,
  DECK,
  DISCARD,
  duel,
  GRUNT,
  HAND,
  HP,
  MAIN,
  POWER,
  STRIKE,
  UNTAP,
} from '../test/fixtures/duel';

const DECK0 = zoneKey(DECK, 0);
const HAND0 = zoneKey(HAND, 0);
const HAND1 = zoneKey(HAND, 1);
const FIELD = zoneKey(BATTLEFIELD, null);
const DISCARD0 = zoneKey(DISCARD, 0);

const seat = (index: number) => ({ kind: 'seat' as const, index });
const lit = (value: number | boolean) => ({ kind: 'literal' as const, value });

interface Harness {
  state: PlayState;
  ec: EffectContext;
  lines: LogLine[];
  events: { name: EventName; ctx: TriggerContext }[];
}

function harness(override = false): Harness {
  const state = createPlayState(duel, 'seed-effects');
  const lines: LogLine[] = [];
  const events: { name: EventName; ctx: TriggerContext }[] = [];
  const ec: EffectContext = {
    state,
    def: duel,
    ctx: { triggeringCardId: null, zoneKey: null, triggeringSeat: 0, promptAnswers: {} },
    depth: 0,
    override,
    log: (line) => lines.push(line),
    fireEvent: (name, ctx) => events.push({ name, ctx }),
  };
  return { state, ec, lines, events };
}

/** Deal `n` cards off the top of seat 0's Deck into `key`. Returns the moved ids. */
function deal(state: PlayState, key: string, n: number): Id[] {
  const ids = state.zones[DECK0].cardIds.splice(0, n);
  state.zones[key].cardIds.push(...ids);
  return ids;
}

const idsOfTemplate = (state: PlayState, templateId: Id) =>
  Object.keys(state.cards).filter((id) => state.cards[id].templateId === templateId);

const changeLines = (lines: LogLine[]) => lines.filter((l) => l.kind === 'change');
const eventNames = (h: Harness) => h.events.map((e) => e.name);
const messages = (lines: LogLine[]) => lines.map((l) => l.message).join('\n');

let h: Harness;
beforeEach(() => {
  h = harness();
});

// ---------------------------------------------------------------------------
// clampValue — the ONE clamp helper (§9.3)
// ---------------------------------------------------------------------------

describe('clampValue', () => {
  const int = (min: number | null, max: number | null): GameValue => ({
    type: 'integer',
    name: 'V',
    defaultValue: 0,
    min,
    max,
  });
  const bool: GameValue = { type: 'boolean', name: 'B', defaultValue: false };

  it.each<[string, GameValue, number | boolean, number | boolean]>([
    ['inside bounds is untouched', int(0, 20), 10, 10],
    ['above max clamps down', int(0, 20), 25, 20],
    ['below min clamps up', int(0, 20), -5, 0],
    ['at the bound is untouched', int(0, 20), 20, 20],
    ['degenerate range min === max, from above', int(5, 5), 9, 5],
    ['degenerate range min === max, from below', int(5, 5), 1, 5],
    ['null bounds do not clamp', int(null, null), -999, -999],
    ['null max clamps only the min', int(0, null), -3, 0],
    ['null min clamps only the max', int(null, 10), 99, 10],
    ['booleans ignore bounds entirely', bool, true, true],
  ])('%s', (_name, value, raw, expected) => {
    expect(clampValue(value, raw)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// canMove — the ONE capacity decision (§6.4 probe)
// ---------------------------------------------------------------------------

describe('canMove', () => {
  it('allows anything into an uncapped zone', () => {
    expect(canMove(h.state, duel, deal(h.state, DECK0, 0).concat(h.state.zones[DECK0].cardIds), FIELD)).toEqual({ ok: true });
  });

  it('refuses a batch that would exceed capacity, and names it', () => {
    const held = deal(h.state, HAND0, 5);
    const incoming = h.state.zones[DECK0].cardIds.slice(0, 3);
    expect(held).toHaveLength(5);
    const result = canMove(h.state, duel, incoming, HAND0);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toContain('capacity 7');
  });

  it('does not count cards already in the destination (this is what makes row 15 a no-op)', () => {
    const held = deal(h.state, HAND0, 7);
    expect(canMove(h.state, duel, held, HAND0)).toEqual({ ok: true });
  });

  it('reports a missing zone rather than throwing', () => {
    const result = canMove(h.state, duel, [], 'zone_nope#4');
    expect(result).toEqual({ ok: false, reason: 'MISSING_REFERENT', detail: expect.stringContaining('does not exist') });
  });
});

// ---------------------------------------------------------------------------
// moveCards
// ---------------------------------------------------------------------------

const moveTopOfDeck = (count: number, to = HAND, position: InsertPosition = 'top'): Effect => ({
  kind: 'moveCards',
  target: { kind: 'topOfZone', zone: { zoneId: DECK, seat: seat(0) }, count: lit(count) },
  to: { zoneId: to, seat: to === BATTLEFIELD ? null : seat(0) },
  position,
});

describe('moveCards', () => {
  it('moves the batch, keeping its order, and fires exit then enter per card', () => {
    const top3 = h.state.zones[DECK0].cardIds.slice(0, 3);
    expect(applyEffect(moveTopOfDeck(3), h.ec)).toEqual({ ok: true });
    expect(h.state.zones[HAND0].cardIds).toEqual(top3);
    expect(h.state.zones[DECK0].cardIds).toHaveLength(37);
    expect(eventNames(h)).toEqual(['onZoneExit', 'onZoneEnter', 'onZoneExit', 'onZoneEnter', 'onZoneExit', 'onZoneEnter']);
    // §4.7: moveCards must NEVER fire onCardDrawn — that is drawCards' whole reason to exist.
    expect(eventNames(h)).not.toContain('onCardDrawn');
  });

  // The ONLY enforcement point for "index 0 is the TOP" on this module's leg of the convention.
  // Every other 'top' assertion here moves into an EMPTY zone, where both readings produce the
  // same array — flipping insertIndex's 'top' to `length` passed the whole suite.
  it("honours 'top' as the FRONT of cardIds, not the end", () => {
    const held = deal(h.state, HAND0, 2);
    const top = h.state.zones[DECK0].cardIds[0];
    applyEffect(moveTopOfDeck(1), h.ec);
    expect(h.state.zones[HAND0].cardIds).toEqual([top, ...held]);
  });

  it("honours 'bottom' as the end of cardIds", () => {
    const held = deal(h.state, HAND0, 2);
    const top = h.state.zones[DECK0].cardIds[0];
    applyEffect(moveTopOfDeck(1, HAND, 'bottom'), h.ec);
    expect(h.state.zones[HAND0].cardIds).toEqual([...held, top]);
  });

  // AC: R3 — maxCapacity 7, the 8th card is rejected, nothing moves, the log names capacity.
  it('rejects the 8th card into a 7-capacity Hand and moves nothing', () => {
    deal(h.state, HAND0, 7);
    const deckBefore = [...h.state.zones[DECK0].cardIds];
    const handBefore = [...h.state.zones[HAND0].cardIds];

    const result = applyEffect(moveTopOfDeck(1), h.ec);

    expect(result).toEqual({ ok: false, reason: 'ZONE_FULL', detail: expect.any(String) });
    expect(h.state.zones[HAND0].cardIds).toEqual(handBefore);
    expect(h.state.zones[DECK0].cardIds).toEqual(deckBefore);
    expect(messages(h.lines)).toContain('Move 1 card → Hand (seat 0): zone at capacity (7/7). No cards moved.');
    expect(h.lines[0].level).toBe('reject');
    expect(h.events).toEqual([]);
  });

  // §5.3 effect-level atomicity, stated with the doc's own example.
  it('moves ZERO of three cards when the batch would overflow', () => {
    deal(h.state, HAND0, 5);
    const deckBefore = [...h.state.zones[DECK0].cardIds];

    expect(applyEffect(moveTopOfDeck(3), h.ec)).toMatchObject({ ok: false, reason: 'ZONE_FULL' });
    expect(h.state.zones[HAND0].cardIds).toHaveLength(5);
    expect(h.state.zones[DECK0].cardIds).toEqual(deckBefore);
    expect(messages(h.lines)).toContain('capacity 7 exceeded');
  });

  // §5.9 row 15
  it('is a silent no-op when the cards already occupy the destination', () => {
    const held = deal(h.state, FIELD, 3);
    const result = applyEffect(
      { kind: 'moveCards', target: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } }, to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' },
      h.ec
    );
    expect(result).toEqual({ ok: true });
    expect(h.state.zones[FIELD].cardIds).toEqual(held);
    expect(h.events).toEqual([]);
    expect(messages(h.lines)).toContain('already in that zone. No-op, no events fired.');
  });

  // §5.9 row 2 — the LOG SHAPE matters, not just the reason code.
  it('rejects a selector that matched nothing, naming the selector at level reject', () => {
    const result = applyEffect(
      { kind: 'moveCards', target: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } }, to: { zoneId: HAND, seat: seat(0) }, position: 'top' },
      h.ec
    );
    expect(result).toMatchObject({ ok: false, reason: 'NO_TARGETS' });
    expect(h.state.zones[HAND0].cardIds).toEqual([]);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0].level).toBe('reject');
    expect(h.lines[0].message).toBe('Selector "allInZone" matched 0 cards.');
  });

  it('inserts at an explicit index, clamping an out-of-range one to the ends', () => {
    const held = deal(h.state, HAND0, 3);
    const top = h.state.zones[DECK0].cardIds[0];
    applyEffect(moveTopOfDeck(1, HAND, { kind: 'index', index: 2 }), h.ec);
    expect(h.state.zones[HAND0].cardIds).toEqual([held[0], held[1], top, held[2]]);

    const next = h.state.zones[DECK0].cardIds[0];
    applyEffect(moveTopOfDeck(1, HAND, { kind: 'index', index: 99 }), h.ec);
    expect(h.state.zones[HAND0].cardIds[4]).toBe(next); // clamped to the end

    const third = h.state.zones[DECK0].cardIds[0];
    applyEffect(moveTopOfDeck(1, HAND, { kind: 'index', index: -5 }), h.ec);
    expect(h.state.zones[HAND0].cardIds[0]).toBe(third); // clamped to the front
  });

  it('rejects a dangling destination zone (§5.9 row 3b)', () => {
    const result = applyEffect(
      { kind: 'moveCards', target: { kind: 'topOfZone', zone: { zoneId: DECK, seat: seat(0) }, count: lit(1) }, to: { zoneId: 'zone_nope', seat: seat(0) }, position: 'top' },
      h.ec
    );
    expect(result).toMatchObject({ ok: false, reason: 'MISSING_REFERENT' });
    expect(h.lines[0].level).toBe('error');
    expect(h.state.zones[DECK0].cardIds).toHaveLength(40);
  });
});

// ---------------------------------------------------------------------------
// drawCards
// ---------------------------------------------------------------------------

const draw = (count: number, from = DECK, to = HAND): Effect => ({
  kind: 'drawCards',
  from: { zoneId: from, seat: seat(0) },
  to: { zoneId: to, seat: seat(0) },
  count: lit(count),
});

describe('drawCards', () => {
  // §5.1: the card is settled in its destination before the semantic event's rules run. For a
  // BATCH that means the whole draw lands first, so an onCardDrawn rule sees the finished hand.
  it('fires every zone event first, then one onCardDrawn per card', () => {
    expect(applyEffect(draw(2), h.ec)).toEqual({ ok: true });
    expect(h.state.zones[HAND0].cardIds).toHaveLength(2);
    expect(eventNames(h)).toEqual([
      'onZoneExit', 'onZoneEnter',
      'onZoneExit', 'onZoneEnter',
      'onCardDrawn', 'onCardDrawn',
    ]);
    const drawn = h.events.filter((e) => e.name === 'onCardDrawn').map((e) => e.ctx.triggeringCardId);
    expect(drawn).toEqual(h.state.zones[HAND0].cardIds);
  });

  // §5.3 / §5.9 row 2b — a QUANTITY shortfall is a partial success, not a rejection.
  it('draws what exists and warns when the deck is short (§9.4 item 6)', () => {
    h.state.zones[DECK0].cardIds = h.state.zones[DECK0].cardIds.slice(0, 1);
    const only = h.state.zones[DECK0].cardIds[0];

    expect(applyEffect(draw(2), h.ec)).toEqual({ ok: true });
    expect(h.state.zones[HAND0].cardIds).toEqual([only]);
    expect(h.state.zones[DECK0].cardIds).toEqual([]);
    expect(messages(h.lines)).toContain('only 1 available. Drew 1.');
    expect(h.lines.some((l) => l.level === 'warn')).toBe(true);
    // No `undefined` instances conjured to make up the shortfall.
    expect(h.state.zones[HAND0].cardIds.every((id) => h.state.cards[id] !== undefined)).toBe(true);
    expect(Object.keys(h.state.cards)).toHaveLength(80);
  });

  it('rejects a draw from an empty zone', () => {
    h.state.zones[DECK0].cardIds = [];
    expect(applyEffect(draw(2), h.ec)).toMatchObject({ ok: false, reason: 'NO_TARGETS' });
  });

  // `count` is a ValueRef, so "draw X" with X at 0 is ordinary play, not an error — and the old
  // code rejected it with "zone is empty" about a 40-card deck.
  it('treats count 0 as a no-op, not an empty-zone rejection', () => {
    expect(applyEffect(draw(0), h.ec)).toEqual({ ok: true });
    expect(h.state.zones[DECK0].cardIds).toHaveLength(40);
    expect(h.state.zones[HAND0].cardIds).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.lines[0].level).toBe('info');
    expect(h.lines[0].message).toBe('Draw from Deck (seat 0): count 0. Nothing drawn.');
  });

  // §9.4 item 5 — capacity is a CONSTRAINT, so it is all-or-nothing even though a shortfall is not.
  it('moves zero cards when the destination has fewer free slots than the draw', () => {
    deal(h.state, HAND0, 6); // 1 free slot, drawing 2
    const deckBefore = [...h.state.zones[DECK0].cardIds];

    expect(applyEffect(draw(2), h.ec)).toMatchObject({ ok: false, reason: 'ZONE_FULL' });
    expect(h.state.zones[HAND0].cardIds).toHaveLength(6);
    expect(h.state.zones[DECK0].cardIds).toEqual(deckBefore);
    expect(h.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// shuffleZone
// ---------------------------------------------------------------------------

describe('shuffleZone', () => {
  const shuffleDeck: Effect = { kind: 'shuffleZone', zone: { zoneId: DECK, seat: seat(0) } };

  it('advances rngCursor and permutes the zone without gaining or losing cards', () => {
    const before = [...h.state.zones[DECK0].cardIds];
    const cursorBefore = h.state.rngCursor;

    expect(applyEffect(shuffleDeck, h.ec)).toEqual({ ok: true });
    expect(h.state.rngCursor).toBeGreaterThan(cursorBefore);
    expect([...h.state.zones[DECK0].cardIds].sort()).toEqual([...before].sort());
    expect(h.state.zones[DECK0].cardIds).not.toEqual(before);
  });

  it('is a pure function of (seed, cursor) — same cursor, same permutation', () => {
    const a = harness();
    const b = harness();
    applyEffect(shuffleDeck, a.ec);
    applyEffect(shuffleDeck, b.ec);
    expect(a.state.zones[DECK0].cardIds).toEqual(b.state.zones[DECK0].cardIds);
    expect(a.state.rngCursor).toBe(b.state.rngCursor);
  });

  it('shuffles every seat when the ref is `all`, threading one cursor', () => {
    const cursorBefore = h.state.rngCursor;
    applyEffect({ kind: 'shuffleZone', zone: { zoneId: DECK, seat: { kind: 'all' } } }, h.ec);
    expect(h.state.rngCursor).toBeGreaterThan(cursorBefore + 39);
    expect(h.lines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// changePool — clamping, no-op suppression, atomicity
// ---------------------------------------------------------------------------

const changeHp = (op: 'add' | 'subtract' | 'set', amount: number, index = 0): Effect => ({
  kind: 'changePool',
  poolId: HP,
  seat: seat(index),
  op,
  amount: lit(amount),
});

describe('changePool', () => {
  // AC: A4 — min 0, subtract 5 from 3 → 0, and the LOG says 0, never -2.
  it('clamps at min and logs the clamped value', () => {
    h.state.playerPools[HP][0] = 3;

    expect(applyEffect(changeHp('subtract', 5), h.ec)).toEqual({ ok: true });
    expect(h.state.playerPools[HP][0]).toBe(0);

    const line = changeLines(h.lines)[0];
    expect(line.change).toEqual({ path: `playerPools.${HP}.0`, before: 3, after: 0 });
    expect(line.change?.after).not.toBe(-2);
    expect(line.message).toContain('clamped at min 0');
    expect(eventNames(h)).toEqual(['onPoolChanged']);
  });

  // §9.3: `set` past a bound is CLAMPED, not rejected. Starting from 5 rather than the default 20
  // is what makes this bite — from 20 the write is a no-op and the test would pass against an
  // implementation that rejected instead of clamping.
  it('clamps `set` past the max and records the clamped write', () => {
    h.state.playerPools[HP][0] = 5;
    expect(applyEffect(changeHp('set', 999), h.ec)).toEqual({ ok: true });
    expect(h.state.playerPools[HP][0]).toBe(20);
    expect(changeLines(h.lines)[0].change).toEqual({ path: `playerPools.${HP}.0`, before: 5, after: 20 });
    expect(changeLines(h.lines)[0].message).toContain('clamped at max 20');
    expect(eventNames(h)).toEqual(['onPoolChanged']);
  });

  it('clamps `add` past the max', () => {
    h.state.playerPools[HP][0] = 5;
    applyEffect(changeHp('add', 999), h.ec);
    expect(h.state.playerPools[HP][0]).toBe(20);
    expect(changeLines(h.lines)[0].change).toEqual({ path: `playerPools.${HP}.0`, before: 5, after: 20 });
  });

  // The logged sign must come from the actual delta, never the operator: `subtract -5` ADDS 5.
  // A log line that disagrees with the write is only discovered when someone rewinds (§9.3).
  it('logs the real delta when a negative amount inverts the operator', () => {
    h.state.playerPools[HP][0] = 5;
    applyEffect(changeHp('subtract', -20), h.ec);
    expect(h.state.playerPools[HP][0]).toBe(20); // 5 - (-20) = 25, clamped to 20
    expect(changeLines(h.lines)[0].message).toContain('requested +20');
    expect(changeLines(h.lines)[0].message).not.toContain('requested -20');
  });

  // §9.4 item 3 / §5.9 rows 4 and 4b — all three no-op cases fire NO onPoolChanged.
  describe('no-op writes fire no onPoolChanged (§5.1)', () => {
    it('writing the value the pool already holds', () => {
      h.state.playerPools[ATTACKERS][0] = 3;
      applyEffect({ kind: 'changePool', poolId: ATTACKERS, seat: seat(0), op: 'set', amount: lit(3) }, h.ec);
      expect(h.state.playerPools[ATTACKERS][0]).toBe(3);
      expect(h.events).toEqual([]);
      expect(changeLines(h.lines)).toEqual([]);
    });

    it('a delta fully absorbed by the min clamp', () => {
      h.state.playerPools[HP][0] = 0;
      applyEffect(changeHp('subtract', 5), h.ec);
      expect(h.state.playerPools[HP][0]).toBe(0);
      expect(h.events).toEqual([]);
      expect(messages(h.lines)).toContain('already at min 0');
      expect(messages(h.lines)).toContain('No event fired.');
    });

    it('adding zero', () => {
      applyEffect(changeHp('add', 0), h.ec);
      expect(h.events).toEqual([]);
      expect(changeLines(h.lines)).toEqual([]);
    });
  });

  it('writes every seat under `all`, one event per seat that actually changed', () => {
    h.state.playerPools[HP][1] = 0; // seat 1 is pinned at min, so only seat 0 changes
    applyEffect({ kind: 'changePool', poolId: HP, seat: { kind: 'all' }, op: 'subtract', amount: lit(4) }, h.ec);
    expect(h.state.playerPools[HP]).toEqual([16, 0]);
    expect(eventNames(h)).toEqual(['onPoolChanged']);
    expect(h.events[0].ctx.triggeringSeat).toBe(0);
  });

  // §4.1: setup.ts seeds `activePlayer` even though no definition authors it, and authored effects
  // are its ONLY legal writers — so a def.pools lookup here would make turn structure unauthorable.
  it('writes the reserved activePlayer pool, which no definition authors', () => {
    expect(duel.pools.some((p) => p.id === ACTIVE_PLAYER_POOL_ID)).toBe(false);
    expect(h.state.pools[ACTIVE_PLAYER_POOL_ID]).toBe(0);

    expect(applyEffect({ kind: 'changePool', poolId: ACTIVE_PLAYER_POOL_ID, seat: null, op: 'add', amount: lit(1) }, h.ec)).toEqual({ ok: true });
    expect(h.state.pools[ACTIVE_PLAYER_POOL_ID]).toBe(1);

    // Clamps at min 0 like any other integer pool.
    applyEffect({ kind: 'changePool', poolId: ACTIVE_PLAYER_POOL_ID, seat: null, op: 'subtract', amount: lit(5) }, h.ec);
    expect(h.state.pools[ACTIVE_PLAYER_POOL_ID]).toBe(0);
  });

  it('writes a game-scoped pool at pools.<id>', () => {
    applyEffect({ kind: 'changePool', poolId: 'pool_firstBlood', seat: null, op: 'set', amount: lit(true) }, h.ec);
    expect(h.state.pools['pool_firstBlood']).toBe(true);
    expect(changeLines(h.lines)[0].change).toEqual({ path: 'pools.pool_firstBlood', before: false, after: true });
  });

  // §5.9 row 3b
  it('rejects a pool that does not exist in the definition', () => {
    const result = applyEffect({ kind: 'changePool', poolId: 'pool_mana', seat: null, op: 'add', amount: lit(1) }, h.ec);
    expect(result).toMatchObject({ ok: false, reason: 'MISSING_REFERENT' });
    expect(h.lines[0].level).toBe('error');
    expect(h.lines[0].message).toContain('pool does not exist in this definition');
  });

  it('rejects a non-integer delta rather than rounding it (§9.3)', () => {
    const result = applyEffect(changeHp('subtract', 1.5), h.ec);
    expect(result).toMatchObject({ ok: false, reason: 'TYPE_MISMATCH' });
    expect(h.state.playerPools[HP][0]).toBe(20);
  });

  it('rejects add/subtract on a boolean pool', () => {
    const result = applyEffect({ kind: 'changePool', poolId: 'pool_firstBlood', seat: null, op: 'add', amount: lit(1) }, h.ec);
    expect(result).toMatchObject({ ok: false, reason: 'TYPE_MISMATCH' });
    expect(h.state.pools['pool_firstBlood']).toBe(false);
  });

  it('is atomic across seats — one bad seat writes nothing', () => {
    delete h.state.playerPools[HP][1];
    const result = applyEffect({ kind: 'changePool', poolId: HP, seat: { kind: 'all' }, op: 'subtract', amount: lit(4) }, h.ec);
    expect(result).toMatchObject({ ok: false, reason: 'MISSING_REFERENT' });
    expect(h.state.playerPools[HP][0]).toBe(20);
    expect(h.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// setCardIndex — the SAME clamp as pools (§9.3)
// ---------------------------------------------------------------------------

describe('setCardIndex', () => {
  const bumpPower = (op: 'add' | 'subtract' | 'set', amount: number): Effect => ({
    kind: 'setCardIndex',
    target: { kind: 'taggedInZone', zone: { zoneId: BATTLEFIELD, seat: null }, tag: 'creature' },
    indexId: POWER,
    op,
    amount: lit(amount),
  });

  /** Put one Grunt (the fixture's only card with a Power index, bounds 0..99) on the Battlefield. */
  function grunt(): Id {
    const id = idsOfTemplate(h.state, GRUNT)[0];
    const from = h.state.zones[DECK0].cardIds.includes(id) ? DECK0 : zoneKey(DECK, 1);
    h.state.zones[from].cardIds.splice(h.state.zones[from].cardIds.indexOf(id), 1);
    h.state.zones[FIELD].cardIds.push(id);
    return id;
  }

  it('clamps card Index values through the same helper as pools, and logs the clamped value', () => {
    const id = grunt();
    expect(h.state.cards[id].indexValues[POWER]).toBe(1);

    applyEffect(bumpPower('subtract', 5), h.ec);
    expect(h.state.cards[id].indexValues[POWER]).toBe(0); // min 0, not -4
    expect(changeLines(h.lines)[0].change).toEqual({ path: `cards.${id}.indexValues.${POWER}`, before: 1, after: 0 });
    expect(changeLines(h.lines)[0].message).toContain('clamped at min 0');
  });

  it('clamps at max on `set` too', () => {
    const id = grunt();
    applyEffect(bumpPower('set', 500), h.ec);
    expect(h.state.cards[id].indexValues[POWER]).toBe(99);
  });

  it('writes nothing and logs no change line when already at the bound', () => {
    const id = grunt();
    h.state.cards[id].indexValues[POWER] = 0;
    applyEffect(bumpPower('subtract', 3), h.ec);
    expect(h.state.cards[id].indexValues[POWER]).toBe(0);
    expect(changeLines(h.lines)).toEqual([]);
  });

  it('rejects the whole effect when one target lacks the index (atomicity)', () => {
    const id = grunt();
    // A Strike has no Power index; tag it as a creature by moving it into the same selection.
    const strike = idsOfTemplate(h.state, STRIKE)[0];
    h.state.zones[FIELD].cardIds.push(strike);
    h.state.cards[id].indexValues[POWER] = 5;

    const result = applyEffect(
      { kind: 'setCardIndex', target: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } }, indexId: POWER, op: 'add', amount: lit(1) },
      h.ec
    );
    expect(result).toMatchObject({ ok: false, reason: 'MISSING_REFERENT' });
    expect(h.state.cards[id].indexValues[POWER]).toBe(5); // untouched
  });

  // §9.4 item 14 — a card an earlier effect destroyed is reported, never thrown on, never resurrected.
  it('reports TARGET_GONE for a card destroyed earlier in the RuleSet', () => {
    const id = grunt();
    applyEffect({ kind: 'destroyCards', target: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } } }, h.ec);
    expect(h.state.cards[id]).toBeUndefined();

    h.ec.ctx = { ...h.ec.ctx, triggeringCardId: id };
    const result = applyEffect(
      { kind: 'setCardIndex', target: { kind: 'triggeringCard' }, indexId: POWER, op: 'add', amount: lit(1) },
      h.ec
    );
    expect(result).toMatchObject({ ok: false, reason: 'TARGET_GONE' });
    expect(h.state.cards[id]).toBeUndefined(); // not resurrected
  });
});

// ---------------------------------------------------------------------------
// flipCard / rotateCard
// ---------------------------------------------------------------------------

describe('flipCard and rotateCard', () => {
  const target = { kind: 'allInZone' as const, zone: { zoneId: HAND, seat: seat(0) } };

  it.each([
    ['flipCard', 'faceDown', 'faceDown', true],
    ['flipCard', 'faceUp', 'faceDown', false],
    ['rotateCard', 'rotated', 'rotated', true],
    ['rotateCard', 'upright', 'rotated', false],
  ] as const)('%s to %s sets %s = %s', (kind, to, field, expected) => {
    const [id] = deal(h.state, HAND0, 1);
    h.state.cards[id][field] = !expected;
    applyEffect({ kind, target, to } as Effect, h.ec);
    expect(h.state.cards[id][field]).toBe(expected);
    expect(changeLines(h.lines)[0].change).toEqual({ path: `cards.${id}.${field}`, before: !expected, after: expected });
  });

  it('toggle flips each card independently', () => {
    const ids = deal(h.state, HAND0, 2);
    h.state.cards[ids[0]].faceDown = true;
    applyEffect({ kind: 'flipCard', target, to: 'toggle' }, h.ec);
    expect(h.state.cards[ids[0]].faceDown).toBe(false);
    expect(h.state.cards[ids[1]].faceDown).toBe(true);
  });

  it('logs nothing for a card already in the requested state', () => {
    const [id] = deal(h.state, HAND0, 1);
    h.state.cards[id].rotated = true;
    applyEffect({ kind: 'rotateCard', target, to: 'rotated' }, h.ec);
    expect(changeLines(h.lines)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createCard / destroyCards
// ---------------------------------------------------------------------------

describe('createCard', () => {
  const create = (count: number, to = BATTLEFIELD): Effect => ({
    kind: 'createCard',
    templateId: GRUNT,
    zone: { zoneId: to, seat: to === BATTLEFIELD ? null : seat(0) },
    position: 'top',
    count: lit(count),
  });

  it('mints deterministic c<n> ids seeded from template defaults', () => {
    const seqBefore = h.state.nextSeq;
    expect(applyEffect(create(2), h.ec)).toEqual({ ok: true });

    const ids = h.state.zones[FIELD].cardIds;
    expect(ids).toEqual([`c${seqBefore}`, `c${seqBefore + 1}`]);
    expect(h.state.nextSeq).toBe(seqBefore + 2);
    // §4.3: a created card seeds its identity fields the same way the deal does — tags copied from
    // the template, owner taken from the destination zone (FIELD is shared, hence null).
    expect(h.state.cards[ids[0]]).toEqual({
      id: ids[0],
      templateId: GRUNT,
      indexValues: { [POWER]: 1 },
      faceDown: false,
      rotated: false,
      tags: [CREATURE_TAG],
      owner: null,
      controller: null,
      attachedTo: null,
    });
    // The copy is per-instance: mutating one instance's tags must not reach the definition.
    expect(h.state.cards[ids[0]].tags).not.toBe(duel.templates.find((t) => t.id === GRUNT)!.tags);
  });

  it('is identical across two independently constructed sessions (§9.4 item 1)', () => {
    const a = harness();
    const b = harness();
    applyEffect(create(3), a.ec);
    applyEffect(create(3), b.ec);
    expect(a.state.zones[FIELD].cardIds).toEqual(b.state.zones[FIELD].cardIds);
    expect(a.state.cards).toEqual(b.state.cards);
  });

  it('checks capacity BEFORE minting, so a rejected create does not burn nextSeq', () => {
    deal(h.state, HAND0, 7);
    const seqBefore = h.state.nextSeq;

    expect(applyEffect(create(1, HAND), h.ec)).toMatchObject({ ok: false, reason: 'ZONE_FULL' });
    expect(h.state.nextSeq).toBe(seqBefore);
    expect(h.state.zones[HAND0].cardIds).toHaveLength(7);
  });

  it('fires one onZoneEnter per created card, after it is settled in the zone', () => {
    applyEffect(create(2), h.ec);
    const ids = h.state.zones[FIELD].cardIds;
    expect(eventNames(h)).toEqual(['onZoneEnter', 'onZoneEnter']);
    expect(h.events.map((e) => e.ctx.triggeringCardId)).toEqual(ids);
    expect(h.events[0].ctx.zoneKey).toBe(FIELD);
    // Settled before the enqueue — the card is already in the zone the event names.
    expect(h.state.zones[FIELD].cardIds).toContain(h.events[0].ctx.triggeringCardId);
  });

  it('fires nothing when the create is rejected', () => {
    deal(h.state, HAND0, 7);
    applyEffect(create(1, HAND), h.ec);
    expect(h.events).toEqual([]);
  });

  it('treats count 0 as a no-op without burning nextSeq', () => {
    const seqBefore = h.state.nextSeq;
    expect(applyEffect(create(0), h.ec)).toEqual({ ok: true });
    expect(h.state.nextSeq).toBe(seqBefore);
    expect(h.state.zones[FIELD].cardIds).toEqual([]);
    expect(h.lines[0].message).toBe('Create Grunt: count 0. Nothing created.');
  });

  it('rejects a template that does not exist', () => {
    const result = applyEffect({ ...create(1), templateId: 'tpl_nope' } as Effect, h.ec);
    expect(result).toMatchObject({ ok: false, reason: 'MISSING_REFERENT' });
  });
});

describe('destroyCards', () => {
  it('removes the card from state.cards AND from its zone', () => {
    const ids = deal(h.state, FIELD, 3);
    applyEffect({ kind: 'destroyCards', target: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } } }, h.ec);
    expect(h.state.zones[FIELD].cardIds).toEqual([]);
    for (const id of ids) expect(h.state.cards[id]).toBeUndefined();
  });

  it('fires one onZoneExit per destroyed card, naming the zone it left', () => {
    const ids = deal(h.state, FIELD, 2);
    applyEffect({ kind: 'destroyCards', target: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } } }, h.ec);
    expect(eventNames(h)).toEqual(['onZoneExit', 'onZoneExit']);
    expect(h.events.map((e) => e.ctx.triggeringCardId)).toEqual(ids);
    expect(h.events[0].ctx.zoneKey).toBe(FIELD);
    // The card is already gone — dispatch skips its own rule via §5.9 row 16, by design.
    expect(h.state.cards[ids[0]]).toBeUndefined();
  });

  it('leaves other zones alone', () => {
    deal(h.state, FIELD, 2);
    const kept = deal(h.state, DISCARD0, 2);
    applyEffect({ kind: 'destroyCards', target: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } } }, h.ec);
    expect(h.state.zones[DISCARD0].cardIds).toEqual(kept);
  });
});

// ---------------------------------------------------------------------------
// fireEvent / forceTransition
// ---------------------------------------------------------------------------

describe('fireEvent and forceTransition', () => {
  it('fireEvent enqueues by name and never dispatches', () => {
    expect(applyEffect({ kind: 'fireEvent', name: 'resonate' }, h.ec)).toEqual({ ok: true });
    expect(h.events.map((e) => e.name)).toEqual(['resonate']);
  });

  // §5.7 binds `triggeringCard` under exactly the four CARD_BINDING_EVENTS. A custom event fired
  // from a card's rule is the shape a designer actually hits, and it must NOT inherit the card.
  it('a custom event does not inherit triggeringCard or zoneKey, but keeps the seat', () => {
    h.ec.ctx = { triggeringCardId: 'c7', zoneKey: HAND0, triggeringSeat: 1, promptAnswers: { p: ['c7'] } };
    applyEffect({ kind: 'fireEvent', name: 'resonate' }, h.ec);
    expect(h.events[0].ctx).toEqual({
      triggeringCardId: null,
      zoneKey: null,
      triggeringSeat: 1,
      promptAnswers: { p: ['c7'] },
    });
  });

  // §5.6: forceTransition "applies at its position in the effect list", so the RuleSet's remaining
  // effects run in the NEW state. This is the footgun the rule editor is meant to warn about — the
  // test pins it rather than papering over it.
  it('forceTransition applies immediately, not as queued work', () => {
    h.state.currentStateId = MAIN;
    expect(applyEffect({ kind: 'forceTransition', toStateId: COMBAT }, h.ec)).toEqual({ ok: true });
    expect(h.state.currentStateId).toBe(COMBAT);
    // Only the two state events are owed; the transition itself already happened. The harness's
    // `fireEvent` collects into `h.events` rather than appending to `state.pending` (dispatch owns
    // that placement — §3.2), so BOTH work arrays staying empty is the real assertion here.
    expect({ stack: h.state.stack, pending: h.state.pending }).toEqual({ stack: [], pending: [] });
    expect(eventNames(h)).toEqual(['onStateExit', 'onStateEnter']);
  });

  it('a LATER effect in the same RuleSet is evaluated against the NEW state', () => {
    h.state.currentStateId = MAIN;
    // Effect 2: Main -> Combat, legal.
    expect(applyEffect({ kind: 'forceTransition', toStateId: COMBAT }, h.ec)).toEqual({ ok: true });
    // Effect 3: Combat -> Combat is NOT an edge, so this can only reject if effect 3 saw Combat.
    // Under the old enqueue behaviour both effects queued work and neither rejected here.
    expect(applyEffect({ kind: 'forceTransition', toStateId: COMBAT }, h.ec)).toMatchObject({
      ok: false,
      reason: 'ILLEGAL_TRANSITION',
    });
    expect(h.state.currentStateId).toBe(COMBAT);
  });

  it('does not bypass legality — an illegal target is rejected in place', () => {
    h.state.currentStateId = MAIN;
    expect(applyEffect({ kind: 'forceTransition', toStateId: UNTAP }, h.ec)).toMatchObject({
      ok: false,
      reason: 'ILLEGAL_TRANSITION',
    });
    expect(h.state.currentStateId).toBe(MAIN);
    expect(h.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Override — §5.9 rows 1b / 5c, and §9.4 item 8's "what it must NOT bypass"
// ---------------------------------------------------------------------------

describe('override', () => {
  it('forces a move past capacity and logs at level override', () => {
    const o = harness(true);
    deal(o.state, HAND0, 7);
    const top = o.state.zones[DECK0].cardIds[0];

    expect(applyEffect(moveTopOfDeck(1), o.ec)).toEqual({ ok: true });
    expect(o.state.zones[HAND0].cardIds).toHaveLength(8);
    expect(o.state.zones[HAND0].cardIds).toContain(top);
    expect(o.lines[0].level).toBe('override');
    expect(o.lines[0].message).toContain('capacity 7 exceeded (now 8/7)');
  });

  // §9.4 item 8: every rejection reason reachable from this module × override. "Without this,
  // override becomes 'ignore all checks' by accretion." ZONE_FULL above is the ONLY yes.
  it.each<[string, string, (o: Harness) => Effect]>([
    ['MISSING_REFERENT', 'a missing pool', () => ({ kind: 'changePool', poolId: 'pool_mana', seat: null, op: 'add', amount: lit(1) })],
    ['MISSING_REFERENT', 'a missing template', () => ({ kind: 'createCard', templateId: 'tpl_nope', zone: { zoneId: BATTLEFIELD, seat: null }, position: 'top', count: lit(1) })],
    ['MISSING_REFERENT', 'a missing zone', () => ({ kind: 'shuffleZone', zone: { zoneId: 'zone_nope', seat: seat(0) } })],
    ['TYPE_MISMATCH', 'a non-integer delta', () => ({ kind: 'changePool', poolId: HP, seat: seat(0), op: 'add', amount: lit(0.5) })],
    ['NO_TARGETS', 'an empty selector', () => ({ kind: 'destroyCards', target: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } } })],
    // The one a designer would most plausibly expect override to force through. It must not.
    ['TARGET_GONE', 'a destroyed card', (o) => {
      const [id] = deal(o.state, FIELD, 1);
      delete o.state.cards[id];
      o.ec.ctx = { ...o.ec.ctx, triggeringCardId: id };
      return { kind: 'flipCard', target: { kind: 'triggeringCard' }, to: 'faceDown' };
    }],
    ['INVALID_SEAT', 'an out-of-range seat', () => ({ kind: 'changePool', poolId: HP, seat: seat(9), op: 'add', amount: lit(1) })],
    ['UNBOUND_REF', 'an unbound triggeringCard', () => ({ kind: 'destroyCards', target: { kind: 'triggeringCard' } })],
    ['AWAITING_PROMPT', 'an unresolved prompt', (o) => {
      deal(o.state, FIELD, 2);
      return { kind: 'destroyCards', target: { kind: 'prompt', from: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } }, count: lit(1), promptText: 'Pick' } };
    }],
  ])('does not bypass %s — %s', (reason, _name, build) => {
    const o = harness(true);
    expect(applyEffect(build(o), o.ec)).toMatchObject({ ok: false, reason });
  });
});

// ---------------------------------------------------------------------------
// Prompt selectors belong to dispatch (§5.4), not here
// ---------------------------------------------------------------------------

describe('prompt selectors', () => {
  it('refuses to act on an unresolved prompt rather than guessing a selection', () => {
    deal(h.state, FIELD, 3);
    const result = applyEffect(
      {
        kind: 'destroyCards',
        target: { kind: 'prompt', from: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } }, count: lit(1), promptText: 'Pick one' },
      },
      h.ec
    );
    expect(result).toMatchObject({ ok: false, reason: 'AWAITING_PROMPT' });
    expect(h.state.zones[FIELD].cardIds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: nothing here dispatches, and every rejection leaves state alone
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// setTag, and ValueRef{kind:'cardTag'} — §4.3, §4.5. Tags are PER-INSTANCE.
// ---------------------------------------------------------------------------

describe('setTag (§4.3)', () => {
  /** Deliberately absent from every template in `duel` — SP2 is only a proof if it is. */
  const ENCHANTED = 'enchanted';

  const onField = (): Id => {
    const [id] = h.state.zones[DECK0].cardIds.splice(0, 1);
    h.state.zones[FIELD].cardIds.push(id);
    return id;
  };

  const setTag = (tag: string, on: boolean): Effect => ({
    kind: 'setTag',
    target: { kind: 'topOfZone', zone: { zoneId: BATTLEFIELD, seat: null }, count: lit(1) },
    tag,
    on,
  });

  const hasTag = (id: Id, tag: string): CriteriaNode => ({
    kind: 'criteria',
    left: { kind: 'cardTag', card: { kind: 'instance', id }, tag },
    op: '=',
    right: lit(true),
  });

  // AC: SP2 — the whole cycle in one test, read through `evalCriteria` on the criteria side and
  // `effectiveTags` on the state side. `template.tags` is asserted UNCHANGED at every step: if the
  // effect wrote there instead, both reads would still pass and every other copy of the card in the
  // definition would silently gain the tag.
  it('SP2: a tag absent from the template reads false, true once set, false once cleared', () => {
    const id = onField();
    const template = duel.templates.find((t) => t.id === h.state.cards[id].templateId);
    expect(template?.tags).not.toContain(ENCHANTED);

    const read = () => evalCriteria(hasTag(id, ENCHANTED), h.state, h.ec.ctx, duel).value;

    expect(read()).toBe(false);

    expect(applyEffect(setTag(ENCHANTED, true), h.ec)).toEqual({ ok: true });
    expect(read()).toBe(true);
    expect(effectiveTags(h.state, duel, id)).toContain(ENCHANTED);
    expect(template?.tags).not.toContain(ENCHANTED);

    expect(applyEffect(setTag(ENCHANTED, false), h.ec)).toEqual({ ok: true });
    expect(read()).toBe(false);
    expect(effectiveTags(h.state, duel, id)).not.toContain(ENCHANTED);
    expect(template?.tags).not.toContain(ENCHANTED);
  });

  it('a runtime tag makes the card selectable by taggedInZone, which reads effectiveTags', () => {
    const id = onField();
    applyEffect(setTag(ENCHANTED, true), h.ec);
    expect(
      resolveTargets({ kind: 'taggedInZone', zone: { zoneId: BATTLEFIELD, seat: null }, tag: ENCHANTED }, h.state, h.ec.ctx, duel)
    ).toMatchObject({ ok: true, cardIds: [id] });
  });

  it('logs one change line per card carrying the tag list either side', () => {
    const id = onField();
    const before = [...h.state.cards[id].tags];
    applyEffect(setTag(ENCHANTED, true), h.ec);
    expect(changeLines(h.lines)).toHaveLength(1);
    expect(changeLines(h.lines)[0].change).toEqual({
      path: `cards.${id}.tags`,
      before,
      after: [...before, ENCHANTED],
    });
    expect(messages(h.lines)).toContain(`tag "${ENCHANTED}" added`);
  });

  it('is a set, not a list: tagging twice adds one entry and one removal clears it (§5.1)', () => {
    const id = onField();
    applyEffect(setTag(ENCHANTED, true), h.ec);
    h.lines.length = 0;
    expect(applyEffect(setTag(ENCHANTED, true), h.ec)).toEqual({ ok: true });
    expect(changeLines(h.lines)).toEqual([]); // no-op write, no change line
    expect(h.state.cards[id].tags.filter((t) => t === ENCHANTED)).toHaveLength(1);

    applyEffect(setTag(ENCHANTED, false), h.ec);
    expect(h.state.cards[id].tags).not.toContain(ENCHANTED);
  });

  it('removing a tag the card never had is a no-op that logs no change', () => {
    onField();
    expect(applyEffect(setTag(ENCHANTED, false), h.ec)).toEqual({ ok: true });
    expect(changeLines(h.lines)).toEqual([]);
  });

  it('removes a tag the card inherited from its template without touching the template', () => {
    const [id] = idsOfTemplate(h.state, GRUNT);
    h.state.zones[FIELD].cardIds.push(id);
    expect(h.state.cards[id].tags).toContain(CREATURE_TAG);

    applyEffect(setTag(CREATURE_TAG, false), h.ec);

    expect(effectiveTags(h.state, duel, id)).not.toContain(CREATURE_TAG);
    // Every OTHER Grunt still reads as a creature — the seed was copied, not shared.
    const other = idsOfTemplate(h.state, GRUNT).find((o) => o !== id);
    expect(effectiveTags(h.state, duel, other as Id)).toContain(CREATURE_TAG);
    expect(duel.templates.find((t) => t.id === GRUNT)?.tags).toContain(CREATURE_TAG);
  });

  it('rejects the whole batch when a target no longer exists, tagging nothing', () => {
    const id = onField();
    const survivor = onField();
    delete h.state.cards[id];
    const result = applyEffect(
      { kind: 'setTag', target: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } }, tag: ENCHANTED, on: true },
      h.ec
    );
    expect(result).toMatchObject({ ok: false, reason: 'TARGET_GONE' });
    expect(h.state.cards[survivor].tags).not.toContain(ENCHANTED);
  });

  it('refuses an unanswered prompt rather than tagging the candidate set', () => {
    onField();
    const result = applyEffect(
      {
        kind: 'setTag',
        target: {
          kind: 'prompt',
          from: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } },
          count: lit(1),
          promptText: 'Choose',
        },
        tag: ENCHANTED,
        on: true,
      },
      h.ec
    );
    expect(result).toMatchObject({ ok: false, reason: 'AWAITING_PROMPT' });
  });
});

// ---------------------------------------------------------------------------
// setController, and the owner / controller / holder split — §4.3
// ---------------------------------------------------------------------------

describe('setController', () => {
  /** One card owned by seat 0, sitting on the shared Battlefield. */
  const onField = (): Id => {
    const [id] = h.state.zones[DECK0].cardIds.splice(0, 1);
    h.state.zones[FIELD].cardIds.push(id);
    return id;
  };

  /** `id` is unused in the selector — the Battlefield holds exactly one card in these tests. */
  const setController = (_id: Id, to: { kind: 'seat'; index: number } | null): Effect => ({
    kind: 'setController',
    target: { kind: 'topOfZone', zone: { zoneId: BATTLEFIELD, seat: null }, count: lit(1) },
    seat: to,
  });

  // AC: SP5 — the override wins over the holding zone, and it does so WITHOUT touching `owner`.
  // Three fields, three answers, from one card: that is the whole reason §4.3 splits them.
  it('SP5: an explicit controller beats the holding zone, and leaves owner alone', () => {
    const id = onField();
    h.state.zones[FIELD].cardIds = [];
    h.state.zones[HAND0].cardIds.push(id); // seat 0's Hand — zone-derived control is seat 0
    expect(controllerOf(h.state, id)).toBe(0);
    expect(ownerOf(h.state, id)).toBe(0);

    h.state.cards[id].controller = 1;

    expect(controllerOf(h.state, id)).toBe(1); // the override wins...
    expect(ownerOf(h.state, id)).toBe(0); // ...and ownership is untouched
    expect(h.state.zones[HAND0].cardIds).toContain(id); // and so is where it sits
  });

  it('null control derives from the holding zone, and follows the card between zones', () => {
    const id = onField();
    expect(h.state.cards[id].controller).toBeNull();
    expect(controllerOf(h.state, id)).toBeNull(); // shared zone: nobody

    h.state.zones[FIELD].cardIds = [];
    h.state.zones[HAND1].cardIds.push(id);
    expect(controllerOf(h.state, id)).toBe(1);
  });

  // AC: V9 — a contested unique changes hands where it stands.
  it('V9: changes the controller without changing which zone instance holds the card', () => {
    const id = onField();
    const fieldBefore = h.state.zones[FIELD].cardIds.slice();

    expect(applyEffect(setController(id, seat(1)), h.ec)).toEqual({ ok: true });

    expect(h.state.cards[id].controller).toBe(1);
    expect(controllerOf(h.state, id)).toBe(1);
    expect(h.state.zones[FIELD].cardIds).toEqual(fieldBefore);
    // No other zone instance gained it either — the card did not move anywhere at all.
    const holders = Object.keys(h.state.zones).filter((k) => h.state.zones[k].cardIds.includes(id));
    expect(holders).toEqual([FIELD]);
    expect(h.events).toEqual([]); // control is not a zone change, so no enter/exit fires
  });

  it('logs one change line naming both sides, and null reads as "zone-derived"', () => {
    const id = onField();
    applyEffect(setController(id, seat(1)), h.ec);
    expect(changeLines(h.lines)).toHaveLength(1);
    expect(changeLines(h.lines)[0].change).toEqual({ path: `cards.${id}.controller`, before: null, after: 1 });
    expect(messages(h.lines)).toContain('zone-derived → seat 1');

    applyEffect(setController(id, null), h.ec);
    expect(h.state.cards[id].controller).toBeNull();
    expect(messages(h.lines)).toContain('seat 1 → zone-derived');
  });

  it('re-setting the same controller is a no-op that logs no change (§5.1)', () => {
    const id = onField();
    applyEffect(setController(id, seat(1)), h.ec);
    h.lines.length = 0;
    expect(applyEffect(setController(id, seat(1)), h.ec)).toEqual({ ok: true });
    expect(changeLines(h.lines)).toEqual([]);
  });

  it('refuses a seat ref that resolves to more than one seat', () => {
    onField();
    const result = applyEffect(
      {
        kind: 'setController',
        target: { kind: 'topOfZone', zone: { zoneId: BATTLEFIELD, seat: null }, count: lit(1) },
        seat: { kind: 'all' },
      },
      h.ec
    );
    expect(result).toMatchObject({ ok: false, reason: 'INVALID_SEAT' });
  });
});

// AC: MTG8 — the destination is keyed by `owner`, so it is seat 0's Hand even though seat 1 has
// been controlling the card. Resolving this through `controller` instead is the bug §4.3 exists to
// make impossible to write by accident.
it('MTG8: a card returned to its owner\'s hand after a controller change lands in the OWNER\'s hand', () => {
  const [id] = h.state.zones[DECK0].cardIds.splice(0, 1);
  h.state.zones[FIELD].cardIds.push(id);
  expect(ownerOf(h.state, id)).toBe(0);

  applyEffect(
    {
      kind: 'setController',
      target: { kind: 'topOfZone', zone: { zoneId: BATTLEFIELD, seat: null }, count: lit(1) },
      seat: seat(1),
    },
    h.ec
  );
  expect(controllerOf(h.state, id)).toBe(1);

  const result = applyEffect(
    {
      kind: 'moveCards',
      target: { kind: 'topOfZone', zone: { zoneId: BATTLEFIELD, seat: null }, count: lit(1) },
      to: { zoneId: HAND, seat: { kind: 'owner', card: { kind: 'instance', id } } },
      position: 'top',
    },
    h.ec
  );

  expect(result).toEqual({ ok: true });
  expect(h.state.zones[HAND0].cardIds).toContain(id);
  expect(h.state.zones[HAND1].cardIds).not.toContain(id);
  // And the same ref spelled `controller` would have sent it the other way — asserted so the test
  // fails loudly if the two ever collapse into one lookup.
  expect(
    applyEffect(
      {
        kind: 'moveCards',
        target: { kind: 'topOfZone', zone: { zoneId: HAND, seat: seat(0) }, count: lit(1) },
        to: { zoneId: HAND, seat: { kind: 'controller', card: { kind: 'instance', id } } },
        position: 'top',
      },
      h.ec
    )
  ).toEqual({ ok: true });
  expect(h.state.zones[HAND1].cardIds).toContain(id);
});

// ---------------------------------------------------------------------------
// §5.12's other half: an ousted seat is unreachable as an effect's zone operand
// ---------------------------------------------------------------------------

describe('an eliminated seat as a zone operand', () => {
  beforeEach(() => {
    // `duel` is a two-seat game; oust seat 1 the way the effect would leave it.
    h.state.seatOrder = [0];
    h.state.eliminated = [1];
  });

  it('rejects SEAT_ELIMINATED as a move destination', () => {
    const before = h.state.zones[HAND1].cardIds.slice();
    const result = applyEffect(
      {
        kind: 'moveCards',
        target: { kind: 'topOfZone', zone: { zoneId: DECK, seat: seat(0) }, count: lit(1) },
        to: { zoneId: HAND, seat: seat(1) },
        position: 'top',
      },
      h.ec
    );
    expect(result).toMatchObject({ ok: false, reason: 'SEAT_ELIMINATED' });
    expect(h.state.zones[HAND1].cardIds).toEqual(before);
    expect(h.state.zones[DECK0].cardIds).toHaveLength(40); // nothing left the source either
  });

  it('rejects it as a draw source too — the guard is on the zone operand, not the direction', () => {
    const result = applyEffect(
      { kind: 'drawCards', from: { zoneId: DECK, seat: seat(1) }, to: { zoneId: HAND, seat: seat(0) }, count: lit(1) },
      h.ec
    );
    expect(result).toMatchObject({ ok: false, reason: 'SEAT_ELIMINATED' });
  });

  it('logs it as a REJECT, not an ERROR — acting on an ousted seat is rule-legal refusal', () => {
    applyEffect({ kind: 'shuffleZone', zone: { zoneId: DECK, seat: seat(1) } }, h.ec);
    expect(h.lines.at(-1)?.level).toBe('reject');
  });

  it('still counts the ousted seat\'s cards through a ValueRef — reading is forensics, not action', () => {
    // The asymmetry is the point of §5.12: storage is unreachable through *effects*, not invisible.
    expect(h.state.zones[zoneKey(DECK, 1)].cardIds).toHaveLength(40);
  });
});

describe('module boundaries', () => {
  it('never mutates seat 1 while acting on seat 0', () => {
    applyEffect(draw(3), h.ec);
    expect(h.state.zones[HAND1].cardIds).toEqual([]);
    expect(h.state.playerPools[HP][1]).toBe(20);
  });

  it('tags every log line with the effect kind and the context depth', () => {
    h.ec.depth = 4;
    applyEffect(draw(1), h.ec);
    expect(h.lines.every((l) => l.effectKind === 'drawCards' && l.depth === 4)).toBe(true);
  });
});
