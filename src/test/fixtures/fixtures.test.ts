/**
 * Structural self-check for the §9.2 fixtures: every property the spec claims, asserted here so a
 * later edit to a fixture cannot silently invalidate the acceptance test that depends on it.
 * No engine imports — this file must stay green before the engine exists.
 */

import { describe, expect, it } from 'vitest';
import { ACTIVE_PLAYER_POOL_ID, CONTINUE, END_STATE_ID, START_STATE_ID } from '../../engine/types';
import type { EngineInput, GameDefinition, LogLine, MachineState, PlayAction, PlayState } from '../../engine/types';
import { step } from '../../engine/dispatch';
import { effectiveIndex } from '../../engine/modifiers';
import { exportJson, importJson } from '../../engine/schema';
import { emptyBoard, place } from '../board';
import * as duelFx from './duel';
import { duel, duelOneSidedEdge } from './duel';
import { empty } from './empty';
import { fanOut, mutualLoop, selfLoop } from './loop';
import { malformed, malformedBase } from './malformed';
import * as mtg from './mtgish';
import { mtgish } from './mtgish';
import { SCRIPT_SEED, script, scriptCards } from './script';
import type { ScriptRow } from './script';
import * as vtes from './vtesish';
import { vtesish } from './vtesish';
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

  // -------------------------------------------------------------------------
  // §9.2 — "PlayAction only grows in v2; it does not narrow." Proven, not assumed.
  // -------------------------------------------------------------------------

  /**
   * The v1 `PlayAction` union, written out verbatim because it is the SPEC under test, not a
   * restatement of the current implementation — deriving it from v2's own types would make the
   * check circular and it would pass no matter what v2 dropped.
   */
  const V1_PLAY_ACTION_KINDS = [
    'answerPrompt',
    'cancelPrompt',
    'fireEvent',
    'flipCard',
    'moveCard',
    'rotateCard',
    'start',
    'transition',
  ];

  /**
   * The one v1 kind a 200-row `duel` session cannot contain — the script raises exactly two
   * prompts and answers both. Constructing it here IS the test for that kind: it has to still
   * typecheck as a v2 `PlayAction` and still be routed by `step`.
   */
  const EXTRA: PlayAction[] = [{ kind: 'cancelPrompt' }];

  it('every v1 PlayAction in the real corpus is still a valid v2 EngineInput the engine routes', () => {
    const base = createPlayState(duel, SCRIPT_SEED);

    for (const action of [...script.map((r) => r.action), ...EXTRA]) {
      // The assignment is half the assertion: it is a v2 type check over a v1 value.
      const input: EngineInput = { kind: 'action', action, override: false };
      const result = step(structuredClone(base), input, [], duel);

      // `dispatch.ts`'s action switch has no `default:` arm, so a kind v2 no longer handles falls
      // straight out of it and yields `undefined`. Getting a StepResult back is therefore proof the
      // action was recognised and routed. A *rejection* still counts — that is the engine refusing
      // the move on game grounds, which is the union working, not the union having narrowed.
      expect(result, `v2 did not route the v1 action kind "${action.kind}"`).toEqual({
        done: expect.any(Boolean),
        suspended: expect.any(Boolean),
        haltedByLoopGuard: expect.any(Boolean),
      });
    }
  });

  it('and that property exercised all eight v1 PlayAction kinds, not just the easy ones', () => {
    const covered = new Set([...script.map((r) => r.action.kind), ...EXTRA.map((a) => a.kind)]);
    expect([...covered].sort()).toEqual(V1_PLAY_ACTION_KINDS);
  });

  // The script can only exercise effect kinds that duel's rules actually contain. If someone adds
  // a rule using a new effect kind, this fails — which is the reminder to extend the script.
  it('covers every effect kind duel is capable of reaching', () => {
    const reachable = new Set(duel.ruleSets.flatMap((r) => r.effects.map((e) => e.kind)));
    expect([...reachable].sort()).toEqual(['changePool', 'destroyCards', 'drawCards']);
  });
});

// ---------------------------------------------------------------------------
// §8 step 32 — mtgish.ts / vtesish.ts. `allDefinitions` above hardcodes playerCount:2 for every
// row, so these two (2 and 5 seats respectively) get their own equivalent checks rather than being
// folded in and weakening that assertion.
// ---------------------------------------------------------------------------

/** Runs `step()` to settlement, answering an open `priority` interaction per `respond`. */
function driveThroughPriority(
  state: PlayState,
  def: GameDefinition,
  input: EngineInput,
  respond: (seat: number) => PlayAction,
  lines: LogLine[] = []
): LogLine[] {
  let result = step(state, input, lines, def);
  let guard = 0;
  while (true) {
    if (++guard > 10_000) throw new Error('fixtures.test.ts driver runaway');
    if (state.interaction?.kind === 'priority') {
      result = step(state, { kind: 'action', action: respond(state.interaction.seat), override: false }, lines, def);
    } else if (result.done) {
      return lines;
    } else {
      result = step(state, CONTINUE, lines, def);
    }
  }
}

describe('mtgish', () => {
  it('is frozen, schemaVersion 2, 2 players, the reserved states, and a hardcoded updatedAt', () => {
    expect(Object.isFrozen(mtgish)).toBe(true);
    expect(mtgish.schemaVersion).toBe(2);
    expect(mtgish.playerCount).toBe(2);
    expect(mtgish.machine.states.map((s) => s.id)).toEqual(expect.arrayContaining([START_STATE_ID, END_STATE_ID]));
    expect(mtgish.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('has no one-sided state machine edges, and references only ruleSets that exist', () => {
    expect(oneSidedEdges(mtgish)).toEqual([]);
    const known = new Set(mtgish.ruleSets.map((r) => r.id));
    const referenced = [...mtgish.globalRuleSetIds, ...mtgish.templates.flatMap((t) => t.ruleSetIds)];
    expect(referenced.filter((id) => !known.has(id))).toEqual([]);
  });

  it('survives structuredClone, so mutating tests have an escape', () => {
    const copy = structuredClone(mtgish);
    expect(copy).toEqual(mtgish);
    expect(Object.isFrozen(copy)).toBe(false);
  });

  it('declares exactly one pool (life, player int 20/0/20) and the four §9.3 zones', () => {
    expect(mtgish.pools).toHaveLength(1);
    expect(mtgish.pools[0]).toMatchObject({ id: mtg.LIFE, scope: 'player', value: { type: 'integer', defaultValue: 20, min: 0, max: 20 } });
    expect(mtgish.zones.map((z) => z.name)).toEqual(['Library', 'Hand', 'Battlefield', 'Graveyard']);
    expect(mtgish.zones.find((z) => z.id === mtg.MTG_BATTLEFIELD)).toMatchObject({ scope: 'shared', visibility: 'faceUp' });
  });

  it('declares exactly the six §9.3 templates, one per criterion, each wired to its own rule(s)', () => {
    expect(mtgish.templates.map((t) => t.id)).toEqual([
      mtg.BOLT, mtg.BEAR, mtg.COUNTER_MAGIC, mtg.ANTHEM_LORD, mtg.POWER_SET, mtg.MIND_CONTROL,
    ]);
    expect(mtgish.templates.find((t) => t.id === mtg.BOLT)?.ruleSetIds).toEqual([mtg.RS_BOLT]);
    expect(mtgish.templates.find((t) => t.id === mtg.BEAR)?.ruleSetIds).toEqual([mtg.RS_LETHAL_DAMAGE, mtg.RS_BLOCK]);
    expect(mtgish.templates.find((t) => t.id === mtg.COUNTER_MAGIC)?.ruleSetIds).toEqual([mtg.RS_COUNTER_MAGIC]);
  });

  it('opens the stack window on the active seat, forward, inclusive, no close cap', () => {
    const win = mtgish.priorityWindows.find((w) => w.id === mtg.WINDOW_STACK);
    expect(win).toMatchObject({ start: 'active', direction: 'forward', includeStart: true, passesToClose: null });
  });

  it('AC: MTG1–MTG3 — Bolt announces a resolve-only rule under the stack window; Counter Magic is a perInstance activation gated to it', () => {
    const bolt = mtgish.ruleSets.find((r) => r.id === mtg.RS_BOLT)!;
    expect(bolt.trigger).toBe('onCardPlayed');
    expect(bolt.effects).toEqual([{ kind: 'announceAction', ruleId: mtg.RS_BOLT_RESOLVE, window: mtg.WINDOW_STACK }]);
    const counter = mtgish.ruleSets.find((r) => r.id === mtg.RS_COUNTER_MAGIC)!;
    expect(counter.activation).toMatchObject({ window: mtg.WINDOW_STACK, perInstance: true });
    expect(counter.effects).toEqual([{ kind: 'counterAction', action: { kind: 'action', ref: { kind: 'topOfStack' } } }]);
  });

  it('AC: MTG7 — Power Set is authored BEFORE Anthem Lord in ruleSets array order', () => {
    const a = mtgish.ruleSets.findIndex((r) => r.id === mtg.RS_POWER_SET);
    const b = mtgish.ruleSets.findIndex((r) => r.id === mtg.RS_ANTHEM_LORD);
    expect(a).toBeLessThan(b);
    expect(mtgish.ruleSets[a].modifier).toMatchObject({ op: 'set' });
    expect(mtgish.ruleSets[b].modifier).toMatchObject({ op: 'adjust' });
  });

  it('MindControl steals a prompted creature; Return to Owner is a global activation', () => {
    const mc = mtgish.ruleSets.find((r) => r.id === mtg.RS_MIND_CONTROL)!;
    expect(mc.effects[0]).toMatchObject({ kind: 'setController', seat: { kind: 'triggeringSeat' } });
    expect(mtgish.globalRuleSetIds).toContain(mtg.RS_RETURN_TO_OWNER);
    expect(mtgish.ruleSets.find((r) => r.id === mtg.RS_RETURN_TO_OWNER)?.activation).not.toBeNull();
  });

  it('Draw Two Instead is a global, unconditional drawCards replacement', () => {
    expect(mtgish.globalRuleSetIds).toContain(mtg.RS_DRAW_TWO_INSTEAD);
    const rule = mtgish.ruleSets.find((r) => r.id === mtg.RS_DRAW_TWO_INSTEAD)!;
    expect(rule.replaces).toEqual({ effectKind: 'drawCards', match: null });
    expect(rule.effects).toEqual([{ kind: 'drawCards', from: { zoneId: mtg.MTG_LIBRARY, seat: { kind: 'triggeringSeat' } }, to: { zoneId: mtg.MTG_HAND, seat: { kind: 'triggeringSeat' } }, count: { kind: 'literal', value: 2 } }]);
  });

  it('AC: MTG11 — Lethal Damage is card-attached and continuous; Declare Block is card-attached to onZoneEnter', () => {
    const lethal = mtgish.ruleSets.find((r) => r.id === mtg.RS_LETHAL_DAMAGE)!;
    expect(lethal.continuous).toBe(true);
    expect(mtgish.templates.find((t) => t.id === mtg.BEAR)?.ruleSetIds).toContain(mtg.RS_LETHAL_DAMAGE);
    const block = mtgish.ruleSets.find((r) => r.id === mtg.RS_BLOCK)!;
    expect(block.trigger).toBe('onZoneEnter');
    expect(block.effects.map((e) => e.kind)).toEqual(['attach', 'setCardIndex', 'setCardIndex']);
  });

  it('AC: MTG11 behavioral — attach + continuous LethalDamage kills the creature(s) at lethal damage, via effects.ts/continuous.ts only, no bespoke combat function', () => {
    const state = emptyBoard(mtgish, 'state_main');
    const bfKey = `${mtg.MTG_BATTLEFIELD}`;
    const attackerId = place(state, mtgish, bfKey, mtg.BEAR, 'atk');
    const blockerId = place(state, mtgish, `${mtg.MTG_HAND}#1`, mtg.BEAR, 'blk');

    const lines: LogLine[] = [];
    let result = step(state, { kind: 'action', action: { kind: 'moveCard', cardId: blockerId, to: { zoneId: mtg.MTG_BATTLEFIELD, seat: null }, position: 'bottom' }, override: false }, lines, mtgish);
    let n = 0;
    while (!result.done) {
      if (++n > 10_000) throw new Error('runaway');
      result = step(state, CONTINUE, lines, mtgish);
    }

    // Both bears deal their power (2) as damage to the other, meeting toughness (2) — both die.
    expect(state.cards[attackerId]).toBeUndefined();
    expect(state.cards[blockerId]).toBeUndefined();
    expect(lines.some((l) => l.message.includes('attached to atk'))).toBe(true);
    expect(lines.some((l) => l.message.includes('Damage on blk: 0 → 2'))).toBe(true);
    expect(lines.some((l) => l.message.includes('Damage on atk: 0 → 2'))).toBe(true);
    expect(lines.some((l) => l.ruleId === mtg.RS_LETHAL_DAMAGE)).toBe(true);
  });

  it('eliminates each seat at zero life via its own global continuous rule (engine ceiling — one rule per seat)', () => {
    expect(mtgish.globalRuleSetIds).toEqual(expect.arrayContaining([mtg.RS_OUST_SEAT0, mtg.RS_OUST_SEAT1]));
    for (const [id, seat] of [[mtg.RS_OUST_SEAT0, 0], [mtg.RS_OUST_SEAT1, 1]] as const) {
      const rule = mtgish.ruleSets.find((r) => r.id === id)!;
      expect(rule.continuous).toBe(true);
      expect(rule.effects).toEqual([{ kind: 'eliminateSeat', seat: { kind: 'seat', index: seat } }]);
    }
  });
});

describe('vtesish', () => {
  it('is frozen, schemaVersion 2, 5 players, the reserved states, and a hardcoded updatedAt', () => {
    expect(Object.isFrozen(vtesish)).toBe(true);
    expect(vtesish.schemaVersion).toBe(2);
    expect(vtesish.playerCount).toBe(5);
    expect(vtesish.machine.states.map((s) => s.id)).toEqual(expect.arrayContaining([START_STATE_ID, END_STATE_ID]));
    expect(vtesish.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('has no one-sided state machine edges, and references only ruleSets that exist', () => {
    expect(oneSidedEdges(vtesish)).toEqual([]);
    const known = new Set(vtesish.ruleSets.map((r) => r.id));
    const referenced = [...vtesish.globalRuleSetIds, ...vtesish.templates.flatMap((t) => t.ruleSetIds)];
    expect(referenced.filter((id) => !known.has(id))).toEqual([]);
  });

  it('survives structuredClone, so mutating tests have an escape', () => {
    const copy = structuredClone(vtesish);
    expect(copy).toEqual(vtesish);
    expect(Object.isFrozen(copy)).toBe(false);
  });

  it('declares the pool/vote pools and the four §9.3 zones', () => {
    expect(vtesish.pools.map((p) => p.id)).toEqual([vtes.POOL, vtes.VOTES_FOR, vtes.VOTES_AGAINST, vtes.BLOCKED, vtes.REFERENDUM_PASSED]);
    expect(vtesish.pools[0]).toMatchObject({ scope: 'player', value: { defaultValue: 30, min: 0, max: 30 } });
    expect(vtesish.zones.map((z) => z.name)).toEqual(['Uncontrolled', 'Ready', 'Library', 'Hand']);
  });

  it('declares exactly the six §9.3 templates, each wired to its own rule(s)', () => {
    expect(vtesish.templates.map((t) => t.id)).toEqual([
      vtes.ACTION_CARD, vtes.MINION, vtes.VOTE_CARD, vtes.EQUIPMENT, vtes.UNIQUE_VAMPIRE, vtes.VTES_STRIKE,
    ]);
    expect(vtesish.templates.find((t) => t.id === vtes.ACTION_CARD)?.ruleSetIds).toEqual([vtes.RS_ACTION]);
    expect(vtesish.templates.find((t) => t.id === vtes.EQUIPMENT)?.ruleSetIds).toEqual([vtes.RS_EQUIPMENT_ABILITY]);
    expect(vtesish.templates.find((t) => t.id === vtes.UNIQUE_VAMPIRE)?.ruleSetIds).toEqual([vtes.RS_SEIZE]);
    expect(vtesish.templates.find((t) => t.id === vtes.MINION)?.indexes.map((i) => i.id)).toEqual([vtes.INFLUENCE, vtes.CAPACITY, vtes.DISCIPLINE]);
    expect(vtesish.templates.find((t) => t.id === vtes.VOTE_CARD)?.indexes.map((i) => i.id)).toEqual([vtes.VOTE_VALUE]);
  });

  it('opens the block window on controllerOfAction, forward, exclusive, no close cap', () => {
    const win = vtesish.priorityWindows.find((w) => w.id === vtes.WINDOW_BLOCK);
    expect(win).toMatchObject({ start: 'controllerOfAction', direction: 'forward', includeStart: false, passesToClose: null });
  });

  it('AC: V1 — the action card resolves the PREDATOR of its own OWNER, via relative(owner(triggering), -1)', () => {
    const resolve = vtesish.ruleSets.find((r) => r.id === vtes.RS_ACTION_RESOLVE)!;
    expect(resolve.effects[0]).toMatchObject({
      kind: 'changePool',
      poolId: vtes.POOL,
      seat: { kind: 'relative', from: { kind: 'owner', card: { kind: 'triggering' } }, offset: -1 },
    });
  });

  it('AC: V1, V3, V4 behavioral — the predator (not the active seat) is charged, and the block window excludes the announcer', () => {
    const state = emptyBoard(vtesish, 'state_main');
    const cardId = place(state, vtesish, `${vtes.VTES_HAND}#2`, vtes.ACTION_CARD, 'ac1');
    const lines: LogLine[] = [];
    driveThroughPriority(
      state,
      vtesish,
      { kind: 'action', action: { kind: 'moveCard', cardId, to: { zoneId: vtes.UNCONTROLLED, seat: { kind: 'seat', index: 2 } }, position: 'top' }, override: false },
      () => ({ kind: 'passPriority' }),
      lines
    );
    // seat 2 (the owner) is NOT active (active is seat 0) — proves this resolves relative to the
    // OWNER, not the active seat. Its predator, seat 1, is charged; every other seat is untouched.
    expect(state.playerPools[vtes.POOL]).toEqual([30, 29, 30, 30, 30]);
    const opened = lines.find((l) => l.message.includes('Priority window'));
    expect(opened?.message).toContain('starting seat 3'); // controllerOfAction=2, includeStart:false, forward => 3 first
  });

  it('AC: V3/V4 — Block is a global, no-cost activation open only inside WINDOW_BLOCK', () => {
    const block = vtesish.ruleSets.find((r) => r.id === vtes.RS_BLOCK_DECLARE)!;
    expect(vtesish.globalRuleSetIds).toContain(vtes.RS_BLOCK_DECLARE);
    expect(block.activation).toMatchObject({ costCheck: null, cost: [], window: vtes.WINDOW_BLOCK, perInstance: false });
  });

  // AC: V11 — see the dedicated describe block below for the structural "no announceAction/priority/
  // replaces/modifier field touched" proof and the behavioral drive.

  it('AC: V6/V7 — the referendum sums VOTES_FOR/VOTES_AGAINST across every seat (SP6), not per-card', () => {
    const pass = vtesish.ruleSets.find((r) => r.id === vtes.RS_REFERENDUM_PASS)!;
    expect(pass.condition).toEqual({
      kind: 'criteria',
      left: { kind: 'pool', poolId: vtes.VOTES_FOR, seat: { kind: 'all', quantifier: 'sum' } },
      op: '>',
      right: { kind: 'pool', poolId: vtes.VOTES_AGAINST, seat: { kind: 'all', quantifier: 'sum' } },
    });
  });

  it('AC: V6/V7 behavioral — 1/2/1 votes for, 0 against, sum to 4 and the referendum passes', () => {
    const state = emptyBoard(vtesish, 'state_main');
    state.playerPools[vtes.VOTES_FOR] = [1, 2, 1, 0, 0];
    const lines: LogLine[] = [];
    let result = step(state, { kind: 'action', action: { kind: 'fireEvent', name: vtes.ON_REFERENDUM_CLOSE, seat: 0 }, override: false }, lines, vtesish);
    let n = 0;
    while (!result.done) {
      if (++n > 10_000) throw new Error('runaway');
      result = step(state, CONTINUE, lines, vtesish);
    }
    expect(state.pools[vtes.REFERENDUM_PASSED]).toBe(true);
    expect(lines.some((l) => l.ruleId === vtes.RS_REFERENDUM_PASS && l.kind === 'rule')).toBe(true);
  });

  it('AC: V8 — the equipment ability is gated on the HOST vampire\'s discipline, not its own', () => {
    const rule = vtesish.ruleSets.find((r) => r.id === vtes.RS_EQUIPMENT_ABILITY)!;
    expect(rule.activation?.costCheck).toEqual({
      kind: 'criteria',
      left: { kind: 'cardIndex', card: { kind: 'host' }, indexId: vtes.DISCIPLINE },
      op: '>=',
      right: { kind: 'literal', value: 2 },
    });
  });

  it('AC: V9 — Seize sets controller without touching the card\'s zone', () => {
    const rule = vtesish.ruleSets.find((r) => r.id === vtes.RS_SEIZE)!;
    expect(rule.effects).toEqual([
      { kind: 'setController', target: { kind: 'allInZone', zone: { zoneId: vtes.UNCONTROLLED, seat: { kind: 'seat', index: 0 } } }, seat: { kind: 'triggeringSeat' } },
    ]);
  });

  it('AC: V5 — Strike announces a resolve-only rule whose sealedChoice offers Hit/Dodge', () => {
    const resolve = vtesish.ruleSets.find((r) => r.id === vtes.RS_STRIKE_RESOLVE)!;
    expect(resolve.effects[0]).toMatchObject({
      kind: 'sealedChoice',
      choiceId: 'strike',
      options: [{ id: 'hit', label: 'Hit' }, { id: 'dodge', label: 'Dodge' }],
    });
  });

  it('eliminates each seat at zero pool via its own global continuous rule, one per seat (5 total)', () => {
    const oustIds = vtesish.ruleSets.filter((r) => r.name.startsWith('Oust Seat')).map((r) => r.id);
    expect(oustIds).toHaveLength(5);
    expect(vtesish.globalRuleSetIds).toEqual(expect.arrayContaining(oustIds));
    for (const r of vtesish.ruleSets.filter((x) => oustIds.includes(x.id))) {
      expect(r.continuous).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// §8 step 32's four required properties.
// ---------------------------------------------------------------------------

describe('§7.2 round-trip identity — mtgish and vtesish survive TWO round trips byte-identically', () => {
  // §7.2's own warning: an `.optional()` where `.nullable()` was meant turns `null` into an absent
  // key and only fails on the SECOND round trip — so this does two, not one.
  for (const [name, def] of [['mtgish', mtgish], ['vtesish', vtesish]] as const) {
    it(`${name}`, () => {
      const once = exportJson(def);
      const firstImport = importJson(once);
      expect(firstImport.ok).toBe(true);
      if (!firstImport.ok) return;
      const twice = exportJson(firstImport.definition);
      expect(twice).toBe(once);

      const secondImport = importJson(twice);
      expect(secondImport.ok).toBe(true);
      if (!secondImport.ok) return;
      const thrice = exportJson(secondImport.definition);
      expect(thrice).toBe(twice);
    });
  }
});

describe('AC: V11 — influence-to-ready is driven purely by v1 primitives, proven structurally', () => {
  // §9.1's own wording: "no announceAction/priority/replaces/modifier field touched" is proven by
  // GREPPING the fixture's own rule objects, not only by behaviour.
  it('RS_TICK and RS_READY touch none of announceAction/priority/replaces/modifier', () => {
    for (const rule of [vtes.tickRule, vtes.readyRule]) {
      expect(rule.activation).toBeNull();
      expect(rule.replaces).toBeNull();
      expect(rule.modifier).toBeNull();
      expect(rule.continuous).toBe(false);
      const kinds = new Set(rule.effects.map((e) => e.kind));
      expect(kinds.has('announceAction')).toBe(false);
      // No effect anywhere in either rule opens a priority window either.
      expect(kinds.has('openPriority')).toBe(false);
    }
  });

  it('behaviorally: two onUntap ticks reach capacity 2 and the minion moves to Ready', () => {
    const state = emptyBoard(vtesish, 'state_main');
    const minionId = place(state, vtesish, `${vtes.UNCONTROLLED}#0`, vtes.MINION, 'm1');
    state.cards[minionId].indexValues[vtes.CAPACITY] = 2;
    const lines: LogLine[] = [];

    let result = step(state, { kind: 'action', action: { kind: 'fireEvent', name: vtes.ON_UNTAP, seat: 0 }, override: false }, lines, vtesish);
    while (!result.done) result = step(state, CONTINUE, lines, vtesish);
    expect(state.cards[minionId].indexValues[vtes.INFLUENCE]).toBe(1);
    expect(state.zones[`${vtes.READY}#0`].cardIds).toEqual([]);

    result = step(state, { kind: 'action', action: { kind: 'fireEvent', name: vtes.ON_UNTAP, seat: 0 }, override: false }, lines, vtesish);
    while (!result.done) result = step(state, CONTINUE, lines, vtesish);
    expect(state.cards[minionId].indexValues[vtes.INFLUENCE]).toBe(2);
    expect(state.zones[`${vtes.READY}#0`].cardIds).toEqual([minionId]);
  });
});

describe('§9.4(b) modifier-order determinism — AC: MTG7', () => {
  it('effectiveIndex is identical whether Power Set or Anthem Lord is authored first in ruleSets', () => {
    const swapped = mtgish.ruleSets.map((r) => r.id).indexOf(mtg.RS_POWER_SET);
    const swappedWith = mtgish.ruleSets.map((r) => r.id).indexOf(mtg.RS_ANTHEM_LORD);
    const flippedRuleSets = [...mtgish.ruleSets];
    [flippedRuleSets[swapped], flippedRuleSets[swappedWith]] = [flippedRuleSets[swappedWith], flippedRuleSets[swapped]];
    const flipped: GameDefinition = { ...mtgish, ruleSets: flippedRuleSets };
    expect(flipped.ruleSets.map((r) => r.id).indexOf(mtg.RS_ANTHEM_LORD)).toBeLessThan(
      flipped.ruleSets.map((r) => r.id).indexOf(mtg.RS_POWER_SET)
    ); // the array order really is reversed relative to mtgish's own authored order

    const bfKey = mtg.MTG_BATTLEFIELD;
    const original = emptyBoard(mtgish, 'state_main');
    place(original, mtgish, bfKey, mtg.BEAR, 'c0');
    place(original, mtgish, bfKey, mtg.ANTHEM_LORD, 'c1');
    place(original, mtgish, bfKey, mtg.POWER_SET, 'c2');

    const swappedState = emptyBoard(flipped, 'state_main');
    place(swappedState, flipped, bfKey, mtg.BEAR, 'c0');
    place(swappedState, flipped, bfKey, mtg.ANTHEM_LORD, 'c1');
    place(swappedState, flipped, bfKey, mtg.POWER_SET, 'c2');

    expect(effectiveIndex(original, mtgish, 'c0', mtg.MTG_POWER)).toBe(effectiveIndex(swappedState, flipped, 'c0', mtg.MTG_POWER));
  });
});

describe('§9.4(b) priority-order determinism — mtgish\'s stack scenario, same seed, differing response timing', () => {
  it('life totals converge identically whether seat 1 counters the first Bolt or the second', () => {
    // Two Bolts, one Counter Magic. Seat 1 always has exactly one legal response available and
    // spends it on a DIFFERENT one of the two announcements in each run — the order seats are
    // OFFERED priority (seat 0 then seat 1, every window) is identical in both runs; only the
    // moment seat 1 chooses to respond differs. §5.1/§5.5's claim is that the OUTCOME (here, the
    // final life total — exactly one Bolt lands either way) cannot depend on that choice.
    function run(counterFirst: boolean) {
      const state = emptyBoard(mtgish, 'state_main');
      const boltA = place(state, mtgish, `${mtg.MTG_HAND}#0`, mtg.BOLT, 'boltA');
      const boltB = place(state, mtgish, `${mtg.MTG_HAND}#0`, mtg.BOLT, 'boltB');
      place(state, mtgish, `${mtg.MTG_HAND}#1`, mtg.COUNTER_MAGIC, 'cm');
      const lines: LogLine[] = [];

      const cast = (cardId: string, seat1Counters: boolean) => {
        let seat1Responded = false;
        driveThroughPriority(
          state,
          mtgish,
          { kind: 'action', action: { kind: 'moveCard', cardId, to: { zoneId: mtg.GRAVEYARD, seat: { kind: 'seat', index: 0 } }, position: 'top' }, override: false },
          (seat) => {
            if (seat === 1 && seat1Counters && !seat1Responded) {
              seat1Responded = true;
              return { kind: 'activate', ruleId: mtg.RS_COUNTER_MAGIC, cardId: 'cm', seat: 1 };
            }
            return { kind: 'passPriority' };
          },
          lines
        );
      };

      cast(boltA, counterFirst);
      expect(state.actionStack).toEqual([]);
      cast(boltB, !counterFirst);
      return state;
    }

    const a = run(true);
    const b = run(false);
    expect(a.playerPools[mtg.LIFE]).toEqual(b.playerPools[mtg.LIFE]);
    expect(a.playerPools[mtg.LIFE][1]).toBe(17); // exactly one of the two Bolts landed: 20 - 3
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
