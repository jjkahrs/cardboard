/**
 * Structural self-check for the §9.2 fixtures: every property the spec claims, asserted here so a
 * later edit to a fixture cannot silently invalidate the acceptance test that depends on it.
 * No engine imports — this file must stay green before the engine exists.
 */

import { describe, expect, it } from 'vitest';
import { ACTIVE_PLAYER_POOL_ID, END_STATE_ID, START_STATE_ID } from '../../engine/types';
import type { GameDefinition, MachineState } from '../../engine/types';
import * as duelFx from './duel';
import { duel, duelOneSidedEdge } from './duel';
import { empty } from './empty';
import { fanOut, mutualLoop, selfLoop } from './loop';
import { malformed, malformedBase } from './malformed';
import { SCRIPT_SEED, script, scriptCards } from './script';
import type { ScriptRow } from './script';
import { createPlayState } from '../../engine/setup';

const byId = (states: MachineState[], id: string): MachineState => {
  const s = states.find((x) => x.id === id);
  if (!s) throw new Error(`no state ${id}`);
  return s;
};

/** Every A→B where B lists A in enterableFrom, and every A→B where A lists B in exitableTo. */
const oneSidedEdges = (d: GameDefinition): string[] => {
  const ids = new Set(d.machine.states.map((s) => s.id));
  const out: string[] = [];
  for (const b of d.machine.states) {
    for (const a of b.enterableFrom) {
      if (!ids.has(a)) out.push(`${a}->${b.id} (unknown source)`);
      else if (!byId(d.machine.states, a).exitableTo.includes(b.id)) out.push(`${a}->${b.id}`);
    }
    for (const t of b.exitableTo) {
      if (!ids.has(t)) out.push(`${b.id}->${t} (unknown target)`);
      else if (!byId(d.machine.states, t).enterableFrom.includes(b.id)) out.push(`${b.id}->${t}`);
    }
  }
  return out;
};

const allDefinitions: [string, GameDefinition][] = [
  ['duel', duel],
  ['empty', empty],
  ['selfLoop', selfLoop],
  ['mutualLoop', mutualLoop],
  ['fanOut', fanOut],
  ['malformedBase', malformedBase],
];

describe('every fixture definition', () => {
  it.each(allDefinitions)('%s is deeply frozen', (_name, d) => {
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.machine)).toBe(true);
    expect(Object.isFrozen(d.machine.states)).toBe(true);
    expect(d.machine.states.every(Object.isFrozen)).toBe(true);
  });

  it.each(allDefinitions)('%s has 2 players, schemaVersion 2 and the reserved states', (_name, d) => {
    expect(d.playerCount).toBe(2);
    expect(d.schemaVersion).toBe(2);
    expect(d.machine.startStateId).toBe(START_STATE_ID);
    expect(d.machine.endStateId).toBe(END_STATE_ID);
    expect(d.machine.states.map((s) => s.id)).toEqual(expect.arrayContaining([START_STATE_ID, END_STATE_ID]));
  });

  it.each(allDefinitions)('%s carries a hardcoded updatedAt, never a live clock', (_name, d) => {
    expect(d.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it.each(allDefinitions)('%s has no one-sided state machine edges', (_name, d) => {
    expect(oneSidedEdges(d)).toEqual([]);
  });

  it.each(allDefinitions)('%s references only ruleSets that exist', (_name, d) => {
    const known = new Set(d.ruleSets.map((r) => r.id));
    const referenced = [...d.globalRuleSetIds, ...d.templates.flatMap((t) => t.ruleSetIds)];
    expect(referenced.filter((id) => !known.has(id))).toEqual([]);
  });

  it.each(allDefinitions)('%s survives structuredClone, so mutating tests have an escape', (_name, d) => {
    const copy = structuredClone(d);
    expect(copy).toEqual(d);
    expect(Object.isFrozen(copy)).toBe(false);
  });
});

describe('duel', () => {
  it('holds exactly 40 cards: 10 of each of 4 templates', () => {
    expect(duel.templates).toHaveLength(4);
    expect(duel.decks).toHaveLength(1);
    expect(duel.decks[0].entries.reduce((n, e) => n + e.quantity, 0)).toBe(40);
    expect(duel.decks[0].entries.every((e) => e.quantity === 10)).toBe(true);
  });

  it('targets a player-scoped zone with its deck, so it instantiates once per seat', () => {
    const target = duel.zones.find((z) => z.id === duel.decks[0].zoneId);
    expect(target?.scope).toBe('player');
  });

  it('declares the four zones with Hand capped at 7 and Battlefield shared', () => {
    expect(duel.zones.map((z) => z.name)).toEqual(['Deck', 'Hand', 'Battlefield', 'Discard']);
    expect(duel.zones.find((z) => z.id === duelFx.HAND)).toMatchObject({
      scope: 'player',
      visibility: 'ownerOnly',
      layout: 'fan',
      ordered: true,
      maxCapacity: 7,
    });
    expect(duel.zones.find((z) => z.id === duelFx.BATTLEFIELD)).toMatchObject({
      scope: 'shared',
      visibility: 'faceUp',
      layout: 'row',
      ordered: false,
    });
    expect(new Set(duel.zones.map((z) => z.name)).size).toBe(duel.zones.length);
  });

  it('does NOT author an activePlayer pool — the engine auto-creates it', () => {
    expect(duel.pools.map((p) => p.id)).toEqual([duelFx.HP, duelFx.ATTACKERS, duelFx.FIRST_BLOOD]);
    expect(duel.pools.some((p) => p.id === ACTIVE_PLAYER_POOL_ID)).toBe(false);
  });

  it('gives HP a min of 0, which is what A4 clamps against', () => {
    const hp = duel.pools.find((p) => p.id === duelFx.HP);
    expect(hp).toMatchObject({ scope: 'player', value: { type: 'integer', defaultValue: 20, min: 0, max: 20 } });
  });

  it('attaches exactly one RuleSet to each template', () => {
    expect(duel.templates.map((t) => t.ruleSetIds)).toEqual([
      [duelFx.RS_STRIKE],
      [duelFx.RS_CANTRIP],
      [duelFx.RS_GRUNT],
      [duelFx.RS_BOMB],
    ]);
    expect(duel.ruleSets).toHaveLength(4);
  });

  it('tags Grunt as a creature, which is what Bomb prompts over', () => {
    expect(duel.templates.find((t) => t.id === duelFx.GRUNT)?.tags).toContain(duelFx.CREATURE_TAG);
    const from = duelFx.bombRule.effects[0];
    expect(from).toMatchObject({
      kind: 'destroyCards',
      target: { kind: 'prompt', from: { kind: 'taggedInZone', tag: duelFx.CREATURE_TAG } },
    });
  });

  it("orders Bomb's effects prompt-first, so the HP loss is the one still pending at the pause", () => {
    expect(duelFx.bombRule.effects.map((e) => e.kind)).toEqual(['destroyCards', 'changePool']);
    expect(duelFx.bombRule.effects[1]).toMatchObject({ poolId: duelFx.HP, op: 'subtract' });
  });

  it('keeps Cantrip to a single draw effect, since A3 asserts its prose verbatim', () => {
    expect(duelFx.cantripRule.effects).toHaveLength(1);
    expect(duelFx.cantripRule.effects[0]).toMatchObject({
      kind: 'drawCards',
      from: { zoneId: duelFx.DECK },
      to: { zoneId: duelFx.HAND },
      count: { kind: 'literal', value: 2 },
    });
  });

  it('wires Combat behind attackers > 0 and EndTurn behind a labeled button', () => {
    expect(byId(duel.machine.states, duelFx.COMBAT).entryCriteria).toMatchObject({
      kind: 'criteria',
      left: { kind: 'pool', poolId: duelFx.ATTACKERS },
      op: '>',
      right: { kind: 'literal', value: 0 },
    });
    const endTurn = byId(duel.machine.states, duelFx.END_TURN);
    expect(endTurn.entryCriteria).toBeNull();
    expect(endTurn.transitionLabel).toBe('End Turn');
  });

  it('leaves Main → Untap illegal from both sides — that is M3', () => {
    expect(byId(duel.machine.states, duelFx.UNTAP).enterableFrom).toEqual([START_STATE_ID]);
    expect(byId(duel.machine.states, duelFx.MAIN).exitableTo).not.toContain(duelFx.UNTAP);
  });

  it('keeps the deliberate one-sided edge out of duel and in its own export', () => {
    expect(oneSidedEdges(duel)).toEqual([]);
    expect(oneSidedEdges(duelOneSidedEdge)).toEqual([`${duelFx.MAIN}->${duelFx.UNTAP}`]);
    expect(duelOneSidedEdge.id).not.toBe(duel.id);
  });

  it('offers exactly one criteria-less exit from Main, so M2 finds one button', () => {
    const main = byId(duel.machine.states, duelFx.MAIN);
    const manual = main.exitableTo.filter((id) => byId(duel.machine.states, id).entryCriteria === null);
    expect(manual).toEqual([duelFx.END_TURN]);
  });

  it('exposes one card index so setCardIndex has a real target', () => {
    expect(duel.templates.find((t) => t.id === duelFx.GRUNT)?.indexes.map((i) => i.id)).toEqual([duelFx.POWER]);
  });
});

describe('empty', () => {
  it('authors nothing but the two reserved states', () => {
    expect(empty.pools).toEqual([]);
    expect(empty.zones).toEqual([]);
    expect(empty.templates).toEqual([]);
    expect(empty.decks).toEqual([]);
    expect(empty.ruleSets).toEqual([]);
    expect(empty.customEvents).toEqual([]);
    expect(empty.machine.states.map((s) => s.id)).toEqual([START_STATE_ID, END_STATE_ID]);
  });
});

describe('loop', () => {
  it('binds every loop rule globally, since none of them hang on a card', () => {
    for (const d of [selfLoop, mutualLoop, fanOut]) {
      expect(d.templates).toEqual([]);
      expect(d.globalRuleSetIds).toEqual(d.ruleSets.map((r) => r.id));
      expect(d.ruleSets.every((r) => r.effects.some((e) => e.kind === 'fireEvent'))).toBe(true);
      expect(d.limits).toEqual({
        maxDepth: 256,
        maxEffects: 50_000,
        maxSettleIterations: 64,
        maxPriorityRounds: 256,
      });
    }
  });

  it('selfLoop re-fires its own event name', () => {
    expect(selfLoop.customEvents).toEqual(['Echo']);
    expect(selfLoop.ruleSets).toHaveLength(1);
    expect(selfLoop.ruleSets[0].trigger).toBe('Echo');
    expect(selfLoop.ruleSets[0].effects[1]).toEqual({ kind: 'fireEvent', name: 'Echo' });
  });

  it('mutualLoop alternates names, so a per-name depth counter never repeats', () => {
    expect(mutualLoop.ruleSets.map((r) => r.trigger)).toEqual(['Ping', 'Pong']);
    expect(mutualLoop.ruleSets.map((r) => r.effects[1])).toEqual([
      { kind: 'fireEvent', name: 'Pong' },
      { kind: 'fireEvent', name: 'Ping' },
    ]);
  });

  it('fanOut is wide, not deep: three rules on one event, each re-firing it', () => {
    expect(fanOut.customEvents).toEqual(['Burst']);
    expect(fanOut.ruleSets).toHaveLength(3);
    expect(fanOut.ruleSets.every((r) => r.trigger === 'Burst')).toBe(true);
    expect(fanOut.ruleSets.map((r) => r.effects[1])).toEqual([
      { kind: 'fireEvent', name: 'Burst' },
      { kind: 'fireEvent', name: 'Burst' },
      { kind: 'fireEvent', name: 'Burst' },
    ]);
  });
});

describe('malformed', () => {
  it('covers all 9 P3 rows, each with a distinct label', () => {
    expect(malformed).toHaveLength(9);
    expect(new Set(malformed.map((m) => m.label)).size).toBe(9);
    expect(Object.isFrozen(malformed)).toBe(true);
  });

  it('ships raw file TEXT, so gate 1 has something to parse', () => {
    expect(malformed.every((m) => typeof m.json === 'string')).toBe(true);
  });

  it('makes exactly one row fail JSON.parse', () => {
    const unparseable = malformed.filter((m) => {
      try {
        JSON.parse(m.json);
        return false;
      } catch {
        return true;
      }
    });
    expect(unparseable.map((m) => m.label)).toEqual(['not JSON at all']);
    expect(unparseable[0].expectedPath).toBe('');
  });

  it('names a field path for every row that does parse', () => {
    for (const m of malformed.slice(1)) {
      expect(m.expectedPath, m.label).not.toBe('');
    }
  });

  it('breaks exactly the field its expectedPath names, and nothing else', () => {
    const base = JSON.parse(JSON.stringify(malformedBase));
    for (const m of malformed.slice(1)) {
      const parsed = JSON.parse(m.json);
      const diffs = pathsThatDiffer(base, parsed);
      expect(diffs, m.label).toEqual([m.expectedPath]);
    }
  });
});

describe('script', () => {
  const opening = createPlayState(duel, SCRIPT_SEED);
  const movesTo = (r: ScriptRow, zoneId: string): string | null =>
    r.action.kind === 'moveCard' && r.action.to.zoneId === zoneId ? r.action.cardId : null;
  const templateOf = (cardId: string) => opening.cards[cardId]?.templateId;

  it('is 200 frozen rows, so §9.3 can point-rewind to 198', () => {
    expect(script).toHaveLength(200);
    expect(Object.isFrozen(script)).toBe(true);
    expect(script.every(Object.isFrozen)).toBe(true);
  });

  it('names only cards the seeded opening state actually minted', () => {
    const unknown = script
      .flatMap((r) => (r.action.kind === 'moveCard' || r.action.kind === 'flipCard' || r.action.kind === 'rotateCard'
        ? [r.action.cardId]
        : r.action.kind === 'answerPrompt' ? r.action.chosen : []))
      .filter((id) => !(id in opening.cards));
    expect(unknown).toEqual([]);
  });

  it('opens with start and closes by entering End', () => {
    expect(script[0].action).toEqual({ kind: 'start' });
    expect(script[198].action).toEqual({ kind: 'transition', toStateId: END_STATE_ID });
  });

  it('covers every PlayAction kind except cancelPrompt', () => {
    const kinds = new Set(script.map((r) => r.action.kind));
    expect([...kinds].sort()).toEqual([
      'answerPrompt',
      'fireEvent',
      'flipCard',
      'moveCard',
      'rotateCard',
      'start',
      'transition',
    ]);
  });

  it('pauses on exactly two prompts, each answered on the very next row', () => {
    const answers = script.flatMap((r, i) => (r.action.kind === 'answerPrompt' ? [i] : []));
    expect(answers).toHaveLength(2);
    for (const i of answers) {
      const played = movesTo(script[i - 1], duelFx.BATTLEFIELD);
      expect(templateOf(played!), `row ${i - 1} must be the Bomb play that raised the prompt`).toBe(duelFx.BOMB);
      const chosen = script[i].action.kind === 'answerPrompt' ? script[i].action.chosen : [];
      expect(chosen).toHaveLength(1);
      expect(templateOf(chosen[0])).toBe(duelFx.GRUNT);
    }
  });

  it('has exactly one capacity rejection, repeated on the next row as the one override', () => {
    const rejected = script.filter((r) => r.expectRejected === 'ZONE_FULL');
    expect(rejected).toHaveLength(1);
    const overrides = script.flatMap((r, i) => (r.override ? [i] : []));
    expect(overrides).toHaveLength(1);
    const i = script.indexOf(rejected[0]);
    expect(overrides[0]).toBe(i + 1);
    expect(script[i + 1].action).toEqual(script[i].action);
    expect(script[i + 1].expectRejected).toBeUndefined();
  });

  it('plays 21 Strikes into a 20-point pool, so exactly the last one clamps at 0', () => {
    const strikePlays = script.filter((r) => templateOf(movesTo(r, duelFx.BATTLEFIELD) ?? '') === duelFx.STRIKE);
    expect(strikePlays).toHaveLength(21);
    const hp = duel.pools.find((p) => p.id === duelFx.HP)?.value;
    expect(hp).toMatchObject({ type: 'integer', defaultValue: 20, min: 0 });
  });

  it('plays 20 Bombs into a 20-point pool, so HP(active) lands on 0 without a second clamp', () => {
    const bombPlays = script.filter((r) => templateOf(movesTo(r, duelFx.BATTLEFIELD) ?? '') === duelFx.BOMB);
    expect(bombPlays).toHaveLength(20);
  });

  it('annotates every row it expects to be refused, and nothing else', () => {
    expect(script.filter((r) => r.expectRejected).map((r) => r.expectRejected)).toEqual([
      'ILLEGAL_TRANSITION',
      'ZONE_FULL',
      'SESSION_FINISHED',
    ]);
  });

  it('gives every row a note, because row 137 has to be readable', () => {
    expect(script.filter((r) => !r.note?.trim())).toEqual([]);
  });

  it('derives its card ids from the seeded deck, 10 of each template per seat', () => {
    for (const pile of [scriptCards.strike, scriptCards.cantrip, scriptCards.grunt, scriptCards.bomb]) {
      expect(pile.map((seat) => seat.length)).toEqual([10, 10]);
    }
    const all = Object.values(scriptCards).flat(2);
    expect(new Set(all).size).toBe(80);
  });

  // The script can only exercise effect kinds that duel's rules actually contain. If someone adds
  // a rule using a new effect kind, this fails — which is the reminder to extend the script.
  it('covers every effect kind duel is capable of reaching', () => {
    const reachable = new Set(duel.ruleSets.flatMap((r) => r.effects.map((e) => e.kind)));
    expect([...reachable].sort()).toEqual(['changePool', 'destroyCards', 'drawCards']);
  });
});

/** Recursive path diff — proves each malformed row changed one field and only one. */
function pathsThatDiffer(a: unknown, b: unknown, prefix = ''): string[] {
  if (a === b) return [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  if (!isObj(a) || !isObj(b)) return [prefix];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!(k in a) || !(k in b)) out.push(path);
    else out.push(...pathsThatDiffer(a[k], b[k], path));
  }
  return out;
}
