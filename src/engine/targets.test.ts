import { describe, expect, it } from 'vitest';

import {
  ACTIVE_PLAYER_POOL_ID,
  type CardInstance,
  type Id,
  type PlayState,
  type TargetSelector,
  type TriggerContext,
  type ValueRef,
  type ZoneRef,
} from './types';
import { resolveTargets, type TargetResult } from './targets';
import { resolveValueRef, zoneKey } from './valueRef';
import {
  ATTACKERS,
  BATTLEFIELD,
  BOMB,
  BOMB_PROMPT_TEXT,
  CREATURE_TAG,
  DECK,
  duel,
  FIRST_BLOOD,
  GRUNT,
  HAND,
  HP,
  MAIN,
  POWER,
  STRIKE,
  bombRule,
} from '../test/fixtures/duel';

// ---------------------------------------------------------------------------
// Inline state builders
// ---------------------------------------------------------------------------

const BF = zoneKey(BATTLEFIELD, null);
const HAND_0 = zoneKey(HAND, 0);
const HAND_1 = zoneKey(HAND, 1);
const DECK_0 = zoneKey(DECK, 0);

const bfRef: ZoneRef = { zoneId: BATTLEFIELD, seat: null };
const lit = (value: number | boolean): ValueRef => ({ kind: 'literal', value });

function ctx(over: Partial<TriggerContext> = {}): TriggerContext {
  return { triggeringCardId: null, zoneKey: null, triggeringSeat: 0, promptAnswers: {}, ...over };
}

/** POWER is seeded from the numeric part of the id, so the valueRef cross-check can name a card. */
function card(id: Id, templateId: Id, over: Partial<CardInstance> = {}): CardInstance {
  return {
    id,
    templateId,
    indexValues: { [POWER]: Number(id.slice(1)) },
    faceDown: false,
    rotated: false,
    ...over,
  };
}

function makeState(cards: CardInstance[], zones: Record<string, Id[]>, over: Partial<PlayState> = {}): PlayState {
  return {
    definitionId: duel.id,
    seed: 'seed',
    rngCursor: 0,
    nextSeq: 0,
    nextWorkId: 0,
    logSeq: 0,
    playerCount: 2,
    pools: { [ACTIVE_PLAYER_POOL_ID]: 0, [FIRST_BLOOD]: false },
    playerPools: { [HP]: [20, 20], [ATTACKERS]: [2, 0] },
    cards: Object.fromEntries(cards.map((c) => [c.id, c])),
    zones: Object.fromEntries(
      Object.entries(zones).map(([key, cardIds]) => {
        const hash = key.indexOf('#');
        return [
          key,
          {
            zoneId: hash === -1 ? key : key.slice(0, hash),
            seat: hash === -1 ? null : Number(key.slice(hash + 1)),
            cardIds,
          },
        ];
      })
    ),
    currentStateId: MAIN,
    finished: false,
    stack: [],
    pending: [],
    interaction: null,
    budget: { causalDepth: 0, effectsUsed: 0, settleIterations: 0 },
    ...over,
  };
}

/** The shared fixture the top/bottom convention is asserted against. Battlefield: c1 (top) … c3. */
function board(): PlayState {
  return makeState(
    [card('c1', GRUNT), card('c2', GRUNT), card('c3', GRUNT)],
    { [BF]: ['c1', 'c2', 'c3'] }
  );
}

const run = (sel: TargetSelector, state: PlayState, c: TriggerContext = ctx()): TargetResult =>
  resolveTargets(sel, state, c, duel);

/** Narrowing helpers — keep the assertions readable without `as` casts everywhere. */
function expectCards(res: TargetResult) {
  if (!res.ok) throw new Error(`expected success, got ${res.reason}: ${res.message}`);
  if (res.kind !== 'cards') throw new Error('expected a cards result, got a prompt');
  return res;
}
function expectFail(res: TargetResult) {
  if (res.ok) throw new Error('expected a failure, got a success');
  return res;
}
function expectPrompt(res: TargetResult) {
  if (!res.ok) throw new Error(`expected a prompt, got ${res.reason}: ${res.message}`);
  if (res.kind !== 'prompt') throw new Error('expected a prompt result, got cards');
  return res;
}

// ---------------------------------------------------------------------------

describe('triggeringCard', () => {
  it('resolves to the bound card', () => {
    const res = expectCards(run({ kind: 'triggeringCard' }, board(), ctx({ triggeringCardId: 'c2' })));
    expect(res.cardIds).toEqual(['c2']);
    expect([res.requested, res.actual]).toEqual([1, 1]);
  });

  it('fails UNBOUND_REF when the event binds no card (§5.9 row 13)', () => {
    const res = expectFail(run({ kind: 'triggeringCard' }, board(), ctx({ triggeringCardId: null })));
    expect(res.reason).toBe('UNBOUND_REF');
  });

  it('fails TARGET_GONE when the bound card was destroyed', () => {
    const res = expectFail(run({ kind: 'triggeringCard' }, board(), ctx({ triggeringCardId: 'c99' })));
    expect(res.reason).toBe('TARGET_GONE');
  });
});

describe('topOfZone / bottomOfZone', () => {
  it('takes the first N in zone order', () => {
    const res = expectCards(run({ kind: 'topOfZone', zone: bfRef, count: lit(2) }, board()));
    expect(res.cardIds).toEqual(['c1', 'c2']);
  });

  it('takes the last N, still in zone order', () => {
    const res = expectCards(run({ kind: 'bottomOfZone', zone: bfRef, count: lit(2) }, board()));
    expect(res.cardIds).toEqual(['c2', 'c3']);
  });

  it('agrees with valueRef.ts about which end is the top', () => {
    // Both readings run against ONE state. If either flips its convention, this fails.
    const state = board();
    const viaTargets = expectCards(run({ kind: 'topOfZone', zone: bfRef, count: lit(1) }, state));
    const viaValueRef = resolveValueRef(
      { kind: 'cardIndex', card: { kind: 'zoneTop', zone: bfRef }, indexId: POWER },
      state,
      ctx(),
      duel
    );
    expect(viaValueRef.ok).toBe(true);
    if (!viaValueRef.ok) return;
    expect(viaValueRef.values).toEqual([state.cards[viaTargets.cardIds[0]].indexValues[POWER]]);
    expect(viaTargets.cardIds).toEqual(['c1']);
  });

  it('resolves count lazily through a ValueRef', () => {
    const state = board();
    const count: ValueRef = { kind: 'pool', poolId: ATTACKERS, seat: { kind: 'seat', index: 0 } }; // 2
    expect(expectCards(run({ kind: 'topOfZone', zone: bfRef, count }, state)).cardIds).toEqual(['c1', 'c2']);
  });

  it('is a PARTIAL success when the zone holds fewer than N (§5.3 shortfall)', () => {
    const state = makeState([card('c1', GRUNT)], { [BF]: ['c1'] });
    const res = expectCards(run({ kind: 'topOfZone', zone: bfRef, count: lit(2) }, state));
    expect(res.cardIds).toEqual(['c1']);
    expect(res.requested).toBe(2);
    expect(res.actual).toBe(1);
    expect(res.requested > res.actual).toBe(true); // what the caller logs [WARN] on
  });

  it('is a FULL failure when the zone is missing — not a shortfall', () => {
    const state = makeState([], {});
    const res = expectFail(run({ kind: 'topOfZone', zone: bfRef, count: lit(2) }, state));
    expect(res.reason).toBe('MISSING_REFERENT');
  });

  it('rejects a zone ref that names more than one seat', () => {
    const state = makeState([card('c1', GRUNT)], { [HAND_0]: ['c1'], [HAND_1]: [] });
    const sel: TargetSelector = {
      kind: 'topOfZone',
      zone: { zoneId: HAND, seat: { kind: 'all' } },
      count: lit(1),
    };
    expect(expectFail(run(sel, state)).reason).toBe('INVALID_SEAT');
  });

  it('rejects a boolean count', () => {
    const res = expectFail(run({ kind: 'topOfZone', zone: bfRef, count: lit(true) }, board()));
    expect(res.reason).toBe('TYPE_MISMATCH');
  });

  it('a count of 0 matches nothing', () => {
    expect(expectFail(run({ kind: 'topOfZone', zone: bfRef, count: lit(0) }, board())).reason).toBe('NO_TARGETS');
  });
});

describe('allInZone', () => {
  it('returns the zone ids in zone order', () => {
    expect(expectCards(run({ kind: 'allInZone', zone: bfRef }, board())).cardIds).toEqual(['c1', 'c2', 'c3']);
  });

  it('requested equals actual — no quantity was asked for', () => {
    const res = expectCards(run({ kind: 'allInZone', zone: bfRef }, board()));
    expect(res.requested).toBe(res.actual);
  });

  it('unions seated zones in ascending seat order', () => {
    const state = makeState(
      [card('c1', GRUNT), card('c2', GRUNT)],
      { [HAND_0]: ['c1'], [HAND_1]: ['c2'] }
    );
    const sel: TargetSelector = { kind: 'allInZone', zone: { zoneId: HAND, seat: { kind: 'all' } } };
    expect(expectCards(run(sel, state)).cardIds).toEqual(['c1', 'c2']);
  });

  it('an empty zone is NO_TARGETS (§5.9 row 2)', () => {
    const state = makeState([], { [BF]: [] });
    expect(expectFail(run({ kind: 'allInZone', zone: bfRef }, state)).reason).toBe('NO_TARGETS');
  });

  it('a dangling id in the zone is TARGET_GONE', () => {
    const state = makeState([card('c1', GRUNT)], { [BF]: ['c1', 'c9'] });
    expect(expectFail(run({ kind: 'allInZone', zone: bfRef }, state)).reason).toBe('TARGET_GONE');
  });

  it('an unresolvable seat ref propagates its failure', () => {
    const state = makeState([], { [DECK_0]: [] }, { pools: { [ACTIVE_PLAYER_POOL_ID]: 7 } });
    const sel: TargetSelector = { kind: 'allInZone', zone: { zoneId: DECK, seat: { kind: 'active' } } };
    expect(expectFail(run(sel, state)).reason).toBe('INVALID_SEAT');
  });

  it('face-down cards are still targetable — visibility is rendering only', () => {
    const state = makeState(
      [card('c1', GRUNT, { faceDown: true }), card('c2', GRUNT)],
      { [BF]: ['c1', 'c2'] }
    );
    expect(expectCards(run({ kind: 'allInZone', zone: bfRef }, state)).cardIds).toEqual(['c1', 'c2']);
  });

  it('returns a frozen list', () => {
    const res = expectCards(run({ kind: 'allInZone', zone: bfRef }, board()));
    expect(Object.isFrozen(res.cardIds)).toBe(true);
  });
});

describe('taggedInZone', () => {
  const state = () =>
    makeState(
      [card('c1', STRIKE), card('c2', GRUNT), card('c3', BOMB), card('c4', GRUNT)],
      { [BF]: ['c1', 'c2', 'c3', 'c4'] }
    );

  it('filters by TEMPLATE tag, in zone order', () => {
    const sel: TargetSelector = { kind: 'taggedInZone', zone: bfRef, tag: CREATURE_TAG };
    expect(expectCards(run(sel, state())).cardIds).toEqual(['c2', 'c4']);
  });

  it('matches on the template, not on anything carried by the instance', () => {
    // Same template, one instance mutated every way an instance can be: still tagged.
    const s = makeState(
      [card('c1', GRUNT, { faceDown: true, rotated: true, indexValues: {} })],
      { [BF]: ['c1'] }
    );
    const sel: TargetSelector = { kind: 'taggedInZone', zone: bfRef, tag: CREATURE_TAG };
    expect(expectCards(run(sel, s)).cardIds).toEqual(['c1']);
  });

  it('a tag nothing carries is NO_TARGETS', () => {
    const sel: TargetSelector = { kind: 'taggedInZone', zone: bfRef, tag: 'artifact' };
    expect(expectFail(run(sel, state())).reason).toBe('NO_TARGETS');
  });

  it('a card whose template is gone is MISSING_REFERENT', () => {
    const s = makeState([card('c1', 'tpl_deleted')], { [BF]: ['c1'] });
    const sel: TargetSelector = { kind: 'taggedInZone', zone: bfRef, tag: CREATURE_TAG };
    expect(expectFail(run(sel, s)).reason).toBe('MISSING_REFERENT');
  });
});

describe('prompt', () => {
  /** The Bomb board: creatures and non-creatures on the Battlefield, plus a creature in Hand. */
  const bombBoard = () =>
    makeState(
      [card('c1', GRUNT), card('c2', STRIKE), card('c3', GRUNT), card('c4', BOMB), card('c5', GRUNT)],
      { [BF]: ['c1', 'c2', 'c3', 'c4'], [HAND_0]: ['c5'] }
    );

  const bombSelector = (bombRule.effects[0] as { target: TargetSelector }).target;

  it("candidates are exactly the Battlefield's creatures — no Hand, no untagged", () => {
    const res = expectPrompt(run(bombSelector, bombBoard()));
    expect(res.candidates).toEqual(['c1', 'c3']);
    expect(res.promptText).toBe(BOMB_PROMPT_TEXT);
  });

  it('does not pre-select: the result carries candidates, never cardIds', () => {
    const res = run(bombSelector, bombBoard());
    expect(res.ok && res.kind).toBe('prompt');
    expect(res).not.toHaveProperty('cardIds');
  });

  it('count is both min and max', () => {
    const res = expectPrompt(run(bombSelector, bombBoard()));
    expect([res.min, res.max]).toEqual([1, 1]);
  });

  it('freezes the candidate set', () => {
    expect(Object.isFrozen(expectPrompt(run(bombSelector, bombBoard())).candidates)).toBe(true);
  });

  it('zero legal targets is NO_TARGETS — the prompt is never raised (§5.9 row 8)', () => {
    const s = makeState([card('c1', STRIKE)], { [BF]: ['c1'] });
    expect(expectFail(run(bombSelector, s)).reason).toBe('NO_TARGETS');
  });

  it('propagates the wrapped selector s failure', () => {
    const sel: TargetSelector = {
      kind: 'prompt',
      from: { kind: 'triggeringCard' },
      count: lit(1),
      promptText: 'pick',
    };
    expect(expectFail(run(sel, board(), ctx({ triggeringCardId: null }))).reason).toBe('UNBOUND_REF');
  });

  it('wraps a shortfall selector by offering what exists', () => {
    const sel: TargetSelector = {
      kind: 'prompt',
      from: { kind: 'topOfZone', zone: bfRef, count: lit(5) },
      count: lit(2),
      promptText: 'pick two',
    };
    const res = expectPrompt(run(sel, board()));
    expect(res.candidates).toEqual(['c1', 'c2', 'c3']);
    expect([res.min, res.max]).toEqual([2, 2]);
  });

  it('rejects a prompt wrapping a prompt', () => {
    const sel: TargetSelector = {
      kind: 'prompt',
      from: { kind: 'prompt', from: { kind: 'allInZone', zone: bfRef }, count: lit(1), promptText: 'inner' },
      count: lit(1),
      promptText: 'outer',
    };
    expect(expectFail(run(sel, board())).reason).toBe('TYPE_MISMATCH');
  });
});

describe('purity', () => {
  it('does not mutate the state or alias the zone array', () => {
    const state = board();
    const before = JSON.stringify(state);
    const res = expectCards(run({ kind: 'allInZone', zone: bfRef }, state));
    expect(JSON.stringify(state)).toBe(before);
    expect(res.cardIds).not.toBe(state.zones[BF].cardIds);
  });
});
