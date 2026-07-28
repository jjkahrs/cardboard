/**
 * The pending-action layer. TECHNICAL_DESIGN_V2.md §3.4, §4.7, §4.8, §4.2, §5.1, §5.7, §9.5 edge
 * cases 3/11/15. AC: MTG2, MTG3.
 *
 * These fixtures never fire through a real trigger — every test pushes a `resolve` frame directly
 * (via `frames.ts`'s `push`) and drives `step()` to drain it, the way `priority.ts` (step 24, not
 * yet built) eventually will in production. That is the deliberate seam: step 22/23 proves the
 * pending-action PRIMITIVES work; wiring them into an automatic priority-poll loop is step 24's job.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTINUE,
  type CriteriaNode,
  type EngineInput,
  type LogLine,
  type PlayAction,
  type PlayState,
  type RuleSet,
  type StepResult,
} from './types';
import { step } from './dispatch';
import { push } from './frames';
import { createPlayState } from './setup';
import { applyEffect, type EffectContext } from './effects';
import { evalCriteria } from './criteria';
import { zoneKey } from './valueRef';
import {
  announceAction,
  counterAction,
  resolveActionField,
  resolveActionRef,
  resolveActionSelector,
} from './pending';
import { ATTACKERS, BATTLEFIELD, duel, FIRST_BLOOD, GRUNT, HP } from '../test/fixtures/duel';
import { emptyBoard, place } from '../test/board';
import type { GameDefinition } from './types';

// ---------------------------------------------------------------------------
// Fixture RuleSets — never bound to a real trigger; every test invokes them directly through
// `announceAction`/the `resolve` frame, so `trigger` is a name nothing else in these tests fires.
// ---------------------------------------------------------------------------

const RS_ORIGINAL = 'rs_pending_original';
const RS_RESPONSE = 'rs_pending_response';
const RS_SPELL = 'rs_pending_spell';
const RS_COUNTER = 'rs_pending_counter';
const RS_DESTROY_ALL = 'rs_pending_destroyAll';
const RS_SELF_SEAT = 'rs_pending_selfSeat';

const seat0 = { kind: 'seat' as const, index: 0 };
const lit = (value: number | boolean) => ({ kind: 'literal' as const, value });

const baseRule: Omit<RuleSet, 'id' | 'name' | 'effects'> = {
  trigger: 'testAnnounced',
  stateFilter: null,
  condition: null,
  priority: 0,
  onRejection: 'continue',
  modifier: null,
  continuous: false,
  replaces: null,
  activation: null,
};

/** "Original" — HP(seat 0) -1. */
const rsOriginal: RuleSet = {
  ...baseRule,
  id: RS_ORIGINAL,
  name: 'Original',
  effects: [{ kind: 'changePool', poolId: HP, seat: seat0, op: 'subtract', amount: lit(1) }],
};

/** "Response" — Attackers(seat 0) +1. A distinct pool from `rsOriginal` so the log tells them apart. */
const rsResponse: RuleSet = {
  ...baseRule,
  id: RS_RESPONSE,
  name: 'Response',
  effects: [{ kind: 'changePool', poolId: ATTACKERS, seat: seat0, op: 'add', amount: lit(1) }],
};

/** "Spell" — HP(seat 0) -1. Reused as MTG3's countered action. */
const rsSpell: RuleSet = {
  ...baseRule,
  id: RS_SPELL,
  name: 'Spell',
  effects: [{ kind: 'changePool', poolId: HP, seat: seat0, op: 'subtract', amount: lit(1) }],
};

/** "Counter" — counters whatever is now on top of the stack once IT resolves (see MTG3's test). */
const rsCounter: RuleSet = {
  ...baseRule,
  id: RS_COUNTER,
  name: 'Counter',
  effects: [{ kind: 'counterAction', action: { kind: 'action', ref: { kind: 'topOfStack' } } }],
};

/** "Destroy All" — a target-bearing effect, for the freezing tests. */
const rsDestroyAll: RuleSet = {
  ...baseRule,
  id: RS_DESTROY_ALL,
  name: 'Destroy All',
  effects: [{ kind: 'destroyCards', target: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } } }],
};

/**
 * §9.5 edge case 3 — one game-scoped effect (no seat involved) and one that resolves
 * `SeatRef{kind:'triggeringSeat'}`, i.e. the announcing seat.
 */
const rsSelfSeat: RuleSet = {
  ...baseRule,
  id: RS_SELF_SEAT,
  name: 'Self Seat',
  effects: [
    { kind: 'changePool', poolId: FIRST_BLOOD, seat: null, op: 'set', amount: lit(true) },
    { kind: 'changePool', poolId: HP, seat: { kind: 'triggeringSeat' }, op: 'subtract', amount: lit(1) },
  ],
};

function pendingDef(extra: RuleSet[]): GameDefinition {
  return { ...duel, ruleSets: [...duel.ruleSets, ...extra] };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function ec(state: PlayState, def: GameDefinition, lines: LogLine[], seat: number | null = 0): EffectContext {
  return {
    state,
    def,
    ctx: { triggeringCardId: null, zoneKey: null, triggeringSeat: seat, promptAnswers: {}, sourceCardId: null },
    depth: 0,
    override: false,
    log: (l) => lines.push(l),
    fireEvent: () => {},
  };
}

/** Drives `step()` with CONTINUE until the transaction settles. */
function drive(state: PlayState, def: GameDefinition, lines: LogLine[]): StepResult {
  const input: EngineInput = CONTINUE;
  let result = step(state, input, lines, def);
  let guard = 0;
  while (!result.done) {
    if (++guard > 100_000) throw new Error('pending.test.ts driver runaway — a resolve/rule frame never settled');
    result = step(state, input, lines, def);
  }
  return result;
}

/** Pushes a `resolve` frame for the CURRENT top of `actionStack` and drains it. */
function resolveTop(state: PlayState, def: GameDefinition, lines: LogLine[]): void {
  const actionId = state.actionStack[state.actionStack.length - 1];
  push(state, { kind: 'resolve', actionId, parentId: null, depth: 0 });
  drive(state, def, lines);
}

// ---------------------------------------------------------------------------
// announceAction — §4.5, §4.8
// ---------------------------------------------------------------------------

describe('announceAction', () => {
  it('writes a PendingAction with a deterministic id and pushes it onto actionStack', () => {
    const def = pendingDef([rsOriginal]);
    const state = createPlayState(def, 'seed-announce');
    const lines: LogLine[] = [];
    const before = state.nextSeq;

    const result = announceAction(ec(state, def, lines, 1), {
      kind: 'announceAction',
      ruleId: RS_ORIGINAL,
      window: null,
    });

    expect(result.ok).toBe(true);
    const id = `a${before}`;
    expect(state.actionStack).toEqual([id]);
    expect(state.pendingActions[id]).toMatchObject({
      id,
      ruleId: RS_ORIGINAL,
      controller: 1,
      countered: false,
      tags: [],
    });
  });

  it('rejects MISSING_REFERENT for a ruleId that does not exist, mutating nothing', () => {
    const def = pendingDef([]);
    const state = createPlayState(def, 'seed-announce-bad');
    const lines: LogLine[] = [];
    const before = JSON.stringify(state);

    const result = announceAction(ec(state, def, lines), {
      kind: 'announceAction',
      ruleId: 'no_such_rule',
      window: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('MISSING_REFERENT');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('freezes a target-bearing effect at announce time; a target destroyed before resolve is skipped and logged (§9.5 edge case 15)', () => {
    const def = pendingDef([rsDestroyAll]);
    const state = emptyBoard(def);
    const battlefield = zoneKey(BATTLEFIELD, null);
    const g1 = place(state, def, battlefield, GRUNT, 'g1');
    const g2 = place(state, def, battlefield, GRUNT, 'g2');
    const lines: LogLine[] = [];
    const context = ec(state, def, lines);
    const before = state.nextSeq;

    announceAction(context, { kind: 'announceAction', ruleId: RS_DESTROY_ALL, window: null });
    const id = `a${before}`;
    expect(state.pendingActions[id].targets).toEqual({ '0': [g1, g2] });

    // A response destroys g1 between announce and resolve — the frozen list still names it.
    state.zones[battlefield].cardIds = state.zones[battlefield].cardIds.filter((c) => c !== g1);
    delete state.cards[g1];

    resolveTop(state, def, lines);

    expect(lines.some((l) => l.kind === 'skip' && l.message.includes(g1))).toBe(true);
    // The surviving frozen target still resolves against the FROZEN set, not a live re-resolve
    // (which would have found only g2 in the first place and produced no "skipped" line at all).
    expect(state.cards[g2]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The `resolve` frame — §4.7. AC: MTG2.
// ---------------------------------------------------------------------------

describe('the resolve frame — actionStack ordering', () => {
  // AC: MTG2
  it('a stack of two pending actions resolves most-recently-placed first', () => {
    const def = pendingDef([rsOriginal, rsResponse]);
    const state = createPlayState(def, 'seed-mtg2');
    const lines: LogLine[] = [];
    const context = ec(state, def, lines);

    expect(announceAction(context, { kind: 'announceAction', ruleId: RS_ORIGINAL, window: null }).ok).toBe(true);
    const originalId = state.actionStack[0];
    expect(announceAction(context, { kind: 'announceAction', ruleId: RS_RESPONSE, window: null }).ok).toBe(true);
    const responseId = state.actionStack[1];
    expect(state.actionStack).toEqual([originalId, responseId]);

    // Nothing further responds — resolve the top of the stack, then whatever is on top next.
    resolveTop(state, def, lines);
    expect(state.actionStack).toEqual([originalId]); // the response resolved and left the stack
    resolveTop(state, def, lines);
    expect(state.actionStack).toEqual([]);

    // Proof is the LOG's resolution sequence, not `actionStack` alone: the response's own effect
    // (Attackers) must be logged before the original's (HP).
    const changes = lines.filter((l) => l.change !== null);
    const attackersIndex = changes.findIndex((l) => l.change!.path.includes(ATTACKERS));
    const hpIndex = changes.findIndex((l) => l.change!.path.includes(HP));
    expect(attackersIndex).toBeGreaterThanOrEqual(0);
    expect(hpIndex).toBeGreaterThanOrEqual(0);
    expect(attackersIndex).toBeLessThan(hpIndex);
  });
});

// ---------------------------------------------------------------------------
// counterAction — §4.5, §5.7. AC: MTG3.
// ---------------------------------------------------------------------------

describe('counterAction', () => {
  // AC: MTG3
  it('a countered action leaves the stack without applying, and the log names both', () => {
    const def = pendingDef([rsSpell, rsCounter]);
    const state = createPlayState(def, 'seed-mtg3');
    const lines: LogLine[] = [];
    const context = ec(state, def, lines);

    announceAction(context, { kind: 'announceAction', ruleId: RS_SPELL, window: null });
    const spellId = state.actionStack[0];
    announceAction(context, { kind: 'announceAction', ruleId: RS_COUNTER, window: null });
    const counterId = state.actionStack[1];

    const hpBefore = state.playerPools[HP][0];

    // The counter resolves first (MTG2), running its own `counterAction` effect. At that moment
    // its own id has already left the stack, so `{kind:'topOfStack'}` correctly names the spell.
    resolveTop(state, def, lines);

    expect(state.pendingActions[spellId].countered).toBe(true);
    // Only marked so far — still on the stack until ITS OWN resolve frame sweeps it (pending.ts's
    // counterAction doc comment explains the two-step split).
    expect(state.actionStack).toEqual([spellId]);

    resolveTop(state, def, lines);

    expect(state.actionStack).toEqual([]);
    expect(state.pendingActions[counterId]).toBeDefined(); // never deleted — still addressable
    expect(state.pendingActions[spellId]).toBeDefined();
    expect(state.playerPools[HP][0]).toBe(hpBefore); // the countered spell's effect never ran

    const counterLine = lines.find((l) => l.message.includes('counters'));
    expect(counterLine?.message).toContain('Counter');
    expect(counterLine?.message).toContain('Spell');
    expect(counterLine?.message).toContain(spellId);
  });

  it('rejects TARGET_GONE when the selected action is no longer on the stack', () => {
    const def = pendingDef([rsSpell]);
    const state = createPlayState(def, 'seed-mtg3b');
    const lines: LogLine[] = [];
    const context = ec(state, def, lines);

    announceAction(context, { kind: 'announceAction', ruleId: RS_SPELL, window: null });
    const spellId = state.actionStack[0];
    resolveTop(state, def, lines); // resolves normally, leaves the stack

    const result = counterAction(context, {
      kind: 'counterAction',
      action: { kind: 'action', ref: { kind: 'action', id: spellId } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('TARGET_GONE');
  });

  it('rejects NO_TARGETS when the selector matches nothing', () => {
    const def = pendingDef([]);
    const state = createPlayState(def, 'seed-mtg3c');
    const lines: LogLine[] = [];
    const result = counterAction(ec(state, def, lines), {
      kind: 'counterAction',
      action: { kind: 'allOnStack', where: null },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NO_TARGETS');
  });
});

// ---------------------------------------------------------------------------
// ActionRef / ActionSelector / actionField addressability — §4.2
// ---------------------------------------------------------------------------

describe('ActionRef / ActionSelector / actionField', () => {
  it('{kind:"action", id} and {kind:"topOfStack"} resolve the same action', () => {
    const def = pendingDef([rsSpell]);
    const state = createPlayState(def, 'seed-addr');
    const lines: LogLine[] = [];
    const context = ec(state, def, lines);
    announceAction(context, { kind: 'announceAction', ruleId: RS_SPELL, window: null });
    const id = state.actionStack[0];

    expect(resolveActionRef({ kind: 'topOfStack' }, state, context.ctx)).toMatchObject({ ok: true, action: { id } });
    expect(resolveActionRef({ kind: 'action', id }, state, context.ctx)).toMatchObject({ ok: true, action: { id } });
  });

  it('a dangling {kind:"action", id} is TARGET_GONE, never undefined', () => {
    const def = pendingDef([]);
    const state = createPlayState(def, 'seed-addr2');
    const result = resolveActionRef({ kind: 'action', id: 'ghost' }, state, ec(state, def, []).ctx);
    expect(result).toMatchObject({ ok: false, reason: 'TARGET_GONE' });
  });

  it('resolveActionField reads controller and targetCount off a frozen action', () => {
    const def = pendingDef([rsDestroyAll]);
    const state = emptyBoard(def);
    const battlefield = zoneKey(BATTLEFIELD, null);
    place(state, def, battlefield, GRUNT, 'g1');
    place(state, def, battlefield, GRUNT, 'g2');
    const lines: LogLine[] = [];
    const context = ec(state, def, lines, 1);
    announceAction(context, { kind: 'announceAction', ruleId: RS_DESTROY_ALL, window: null });
    const id = state.actionStack[0];

    expect(resolveActionField({ action: { kind: 'action', id }, field: 'controller' }, state, context.ctx)).toEqual({
      ok: true,
      values: [1],
      quantifier: 'every',
    });
    expect(resolveActionField({ action: { kind: 'action', id }, field: 'targetCount' }, state, context.ctx)).toEqual({
      ok: true,
      values: [2],
      quantifier: 'every',
    });
  });

  it('allOnStack orders bottom-of-stack first and filters by `where`', () => {
    const def = pendingDef([rsSpell, rsCounter]);
    const state = createPlayState(def, 'seed-addr3');
    const lines: LogLine[] = [];

    announceAction(ec(state, def, lines, 0), { kind: 'announceAction', ruleId: RS_SPELL, window: null });
    const spellId = state.actionStack[0];
    announceAction(ec(state, def, lines, 1), { kind: 'announceAction', ruleId: RS_COUNTER, window: null });
    const counterId = state.actionStack[1];

    const anyCtx = ec(state, def, lines).ctx;
    const all = resolveActionSelector({ kind: 'allOnStack', where: null }, state, anyCtx, def);
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.actions.map((a) => a.id)).toEqual([spellId, counterId]);

    // The per-candidate binding reuses `triggeringAction` (see pending.ts's file header) — this
    // criterion reads whichever action `allOnStack` is currently testing.
    const controllerIsZero: CriteriaNode = {
      kind: 'criteria',
      left: { kind: 'actionField', action: { kind: 'triggeringAction' }, field: 'controller' },
      op: '=',
      right: { kind: 'literal', value: 0 },
    };
    const filtered = resolveActionSelector({ kind: 'allOnStack', where: controllerIsZero }, state, anyCtx, def);
    expect(filtered.ok).toBe(true);
    if (filtered.ok) expect(filtered.actions.map((a) => a.id)).toEqual([spellId]);
  });

  it('triggeringAction is UNBOUND_REF outside a pending action\'s own resolution', () => {
    const def = pendingDef([]);
    const state = createPlayState(def, 'seed-addr4');
    const result = resolveActionRef({ kind: 'triggeringAction' }, state, ec(state, def, []).ctx);
    expect(result).toMatchObject({ ok: false, reason: 'UNBOUND_REF' });
  });
});

// ---------------------------------------------------------------------------
// §9.5 edge case 11 — {kind:'topOfStack'} / {kind:'actionField'} against an EMPTY actionStack
// ---------------------------------------------------------------------------

describe('§9.5 edge case 11 — empty actionStack', () => {
  it('{kind:"topOfStack"} fails MISSING_REFERENT, not undefined', () => {
    const def = pendingDef([]);
    const state = createPlayState(def, 'seed-11a');
    const result = resolveActionRef({ kind: 'topOfStack' }, state, ec(state, def, []).ctx);
    expect(result).toMatchObject({ ok: false, reason: 'MISSING_REFERENT' });
  });

  it('an actionField criterion against an empty stack evaluates false via a named error, never a silent NaN/false', () => {
    const def = pendingDef([]);
    const state = createPlayState(def, 'seed-11b');
    const context = ec(state, def, []);
    const criterion: CriteriaNode = {
      kind: 'criteria',
      left: { kind: 'actionField', action: { kind: 'topOfStack' }, field: 'targetCount' },
      op: '>',
      right: { kind: 'literal', value: 0 },
    };
    const result = evalCriteria(criterion, state, context.ctx, def);
    expect(result.value).toBe(false);
    expect(result.leaves[0].error?.reason).toBe('MISSING_REFERENT');
  });
});

// ---------------------------------------------------------------------------
// §9.5 edge case 3 — an eliminated seat still holding a pending action it announced
// ---------------------------------------------------------------------------

describe('§9.5 edge case 3 — an eliminated seat still holding a pending action', () => {
  it('the action resolves normally; a sub-effect resolving the now-eliminated controller fails SEAT_ELIMINATED', () => {
    const def = pendingDef([rsSelfSeat]);
    const state = createPlayState(def, 'seed-3');
    const lines: LogLine[] = [];
    const context = ec(state, def, lines, 1); // seat 1 announces and controls

    announceAction(context, { kind: 'announceAction', ruleId: RS_SELF_SEAT, window: null });
    const id = state.actionStack[0];

    // The controller is eliminated between announce and resolve. §5.12: elimination never touches
    // `pendingActions`.
    const elimResult = applyEffect(
      { kind: 'eliminateSeat', seat: { kind: 'seat', index: 1 } },
      ec(state, def, lines, 0)
    );
    expect(elimResult.ok).toBe(true);
    expect(state.eliminated).toContain(1);
    expect(state.pendingActions[id]).toBeDefined(); // untouched by elimination

    resolveTop(state, def, lines);

    // Half 1 — the action still resolves: the game-scoped effect (no seat involved) ran.
    expect(state.pools[FIRST_BLOOD]).toBe(true);
    // Half 2 — the seat-targeting sub-effect is rejected, not thrown and not silently no-opped.
    expect(
      lines.some((l) => l.level === 'reject' && l.message.toLowerCase().includes('eliminated'))
    ).toBe(true);
    expect(state.playerPools[HP][1]).toBe(20); // the subtract never applied
  });
});

// ---------------------------------------------------------------------------
// §4.8's carried-over fix (§8 step 24) — a target selector that resolves to an unanswered PROMPT at
// announce time suspends `announceAction` itself, rather than being left unfrozen. Driven through the
// REAL `step()`/`dispatch.ts` machinery (unlike every other test above) because that is the only way
// to exercise the raise/resume cycle honestly — `announceAction` called directly, once, cannot show
// that it re-enters correctly.
// ---------------------------------------------------------------------------

describe('announceAction — the announce-time prompt suspend (§4.8 carried-over fix)', () => {
  const RS_PROMPT_TARGET = 'rs_pending_promptTarget';
  const RS_ANNOUNCE_PROMPT = 'rs_pending_announcePrompt';

  const rsPromptTarget: RuleSet = {
    ...baseRule,
    id: RS_PROMPT_TARGET,
    name: 'Prompt Target',
    effects: [
      {
        kind: 'destroyCards',
        target: {
          kind: 'prompt',
          from: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } },
          count: lit(1),
          promptText: 'Choose a target',
        },
      },
    ],
  };

  const rsAnnouncePrompt: RuleSet = {
    ...baseRule,
    id: RS_ANNOUNCE_PROMPT,
    name: 'Announce Prompt Target',
    trigger: 'doAnnouncePrompt',
    effects: [{ kind: 'announceAction', ruleId: RS_PROMPT_TARGET, window: null }],
  };

  function promptDef() {
    return {
      ...pendingDef([rsPromptTarget, rsAnnouncePrompt]),
      globalRuleSetIds: [RS_ANNOUNCE_PROMPT],
    };
  }

  function drive2(state: PlayState, def: GameDefinition, action: PlayAction, lines: LogLine[]) {
    let input: EngineInput = { kind: 'action', action, override: false };
    let result = step(state, input, lines, def);
    let guard = 0;
    while (!result.done) {
      if (++guard > 100_000) throw new Error('drive2 runaway');
      input = CONTINUE;
      result = step(state, input, lines, def);
    }
    return result;
  }

  it('suspends at announce time with nothing mutated, then freezes the answer into PendingAction.targets on resume', () => {
    const def = promptDef();
    const state = emptyBoard(def);
    const battlefield = zoneKey(BATTLEFIELD, null);
    const g1 = place(state, def, battlefield, GRUNT, 'g1');
    const g2 = place(state, def, battlefield, GRUNT, 'g2');
    const lines: LogLine[] = [];

    const result = drive2(state, def, { kind: 'fireEvent', name: 'doAnnouncePrompt', seat: 0 }, lines);

    expect(result.suspended).toBe(true);
    expect(state.interaction).toMatchObject({ kind: 'chooseCards', candidates: [g1, g2], min: 1, max: 1 });
    // Nothing was mutated by the raise — no PendingAction exists yet (§3.3's raise-before-mutate,
    // reused here rather than just claimed).
    expect(state.pendingActions).toEqual({});
    expect(state.actionStack).toEqual([]);

    const answer = drive2(state, def, { kind: 'answerPrompt', chosen: [g1] }, lines);
    expect(answer.suspended).toBe(false);
    expect(state.interaction).toBeNull();
    expect(state.actionStack).toHaveLength(1);
    const id = state.actionStack[0];
    expect(state.pendingActions[id].targets).toEqual({ '0': [g1] });

    // A later "effect" moves the frozen target between announce and resolve — resolution must still
    // destroy g1, not silently re-aim at whatever the live board now shows.
    const battlefieldInst = state.zones[battlefield];
    battlefieldInst.cardIds = battlefieldInst.cardIds.filter((c) => c !== g1);

    const resolveLines: LogLine[] = [];
    push(state, { kind: 'resolve', actionId: id, parentId: null, depth: 0 });
    let resolveResult = step(state, CONTINUE, resolveLines, def);
    let guard = 0;
    while (!resolveResult.done) {
      if (++guard > 100_000) throw new Error('resolve drive runaway');
      resolveResult = step(state, CONTINUE, resolveLines, def);
    }

    expect(state.cards[g1]).toBeUndefined(); // destroyed — the FROZEN target, not a re-aimed one
    expect(state.cards[g2]).toBeDefined(); // g2 was never the target and is untouched
  });
});
