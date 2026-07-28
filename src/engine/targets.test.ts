import { describe, expect, it } from 'vitest';

import {
  ACTIVE_PLAYER_POOL_ID,
  type CardInstance,
  type CriteriaNode,
  type Id,
  type PlayState,
  type TargetSelector,
  type TriggerContext,
  type ValueRef,
  type ZoneRef,
} from './types';
import { type CandidateLine, resolveTargets, type TargetResult } from './targets';
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
  return { triggeringCardId: null, zoneKey: null, triggeringSeat: 0, promptAnswers: {}, sourceCardId: null, ...over };
}

/** POWER is seeded from the numeric part of the id, so the valueRef cross-check can name a card. */
function card(id: Id, templateId: Id, over: Partial<CardInstance> = {}): CardInstance {
  return {
    id,
    templateId,
    indexValues: { [POWER]: Number(id.slice(1)) },
    faceDown: false,
    rotated: false,
    tags: [...(duel.templates.find((t) => t.id === templateId)?.tags ?? [])],
    owner: null,
    controller: null,
    attachedTo: null,
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
    seatOrder: [0, 1],
    eliminated: [],
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
    pendingActions: {},
    actionStack: [],
    continuousFired: {},
    budget: { causalDepth: 0, effectsUsed: 0, settleIterations: 0, priorityRounds: 0 },
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

// ---------------------------------------------------------------------------
// attachedTo / hostOf — §4.4. Attachment is a REFERENCE, so neither reads a zone.
// ---------------------------------------------------------------------------

describe('attachedTo / hostOf', () => {
  /** c1 is the host on the Battlefield; c2 and c3 hang off it from seat 0's Hand. */
  const attached = (): PlayState =>
    makeState(
      [card('c1', GRUNT), card('c2', GRUNT, { attachedTo: 'c1' }), card('c3', GRUNT, { attachedTo: 'c1' })],
      { [BF]: ['c1'], [HAND_0]: ['c2', 'c3'] }
    );

  it('attachedTo collects every card hanging off the host, in sorted id order', () => {
    const res = expectCards(run({ kind: 'attachedTo', host: { kind: 'instance', id: 'c1' } }, attached()));
    expect(res.cardIds).toEqual(['c2', 'c3']);
  });

  it('hostOf resolves the other direction', () => {
    expect(expectCards(run({ kind: 'hostOf', card: { kind: 'instance', id: 'c2' } }, attached())).cardIds).toEqual(['c1']);
  });

  it('crosses zones freely — the attachments are in a Hand, the host on the Battlefield', () => {
    const state = attached();
    expect(state.zones[BF].cardIds).toEqual(['c1']);
    expect(state.zones[HAND_0].cardIds).toEqual(['c2', 'c3']);
    // Neither selector consults a zone at all, which is what makes SP3 hold for free.
    expect(expectCards(run({ kind: 'attachedTo', host: { kind: 'instance', id: 'c1' } }, state)).cardIds).toHaveLength(2);
  });

  it('a host with nothing attached is NO_TARGETS, and so is an unattached card', () => {
    expect(expectFail(run({ kind: 'attachedTo', host: { kind: 'instance', id: 'c2' } }, board())).reason).toBe('NO_TARGETS');
    expect(expectFail(run({ kind: 'hostOf', card: { kind: 'instance', id: 'c1' } }, board())).reason).toBe('NO_TARGETS');
  });

  it('propagates the inner CardRef failure rather than matching nothing', () => {
    expect(expectFail(run({ kind: 'hostOf', card: { kind: 'triggering' } }, board())).reason).toBe('UNBOUND_REF');
    expect(expectFail(run({ kind: 'attachedTo', host: { kind: 'instance', id: 'ghost' } }, board())).reason).toBe('TARGET_GONE');
  });

  it('reads host through CardRef{kind:"host"}, which follows the RULE\'s card and not the trigger', () => {
    // c2 is the equipment whose rule is running; c1 is its host; c3 is what set the event off.
    const res = run({ kind: 'hostOf', card: { kind: 'instance', id: 'c2' } }, attached(), ctx({ sourceCardId: 'c2', triggeringCardId: 'c3' }));
    expect(expectCards(res).cardIds).toEqual(['c1']);
    // …and the same selector spelled through `host` picks up c1's own host, of which there is none.
    expect(expectFail(run({ kind: 'hostOf', card: { kind: 'host' } }, attached(), ctx({ sourceCardId: 'c2' }))).reason).toBe('NO_TARGETS');
  });
});

// ---------------------------------------------------------------------------
// matching — §4.4. Predicate targeting: `where` evaluated once per candidate with
// CardRef{kind:'candidate'} bound to the card under test.
// ---------------------------------------------------------------------------

describe('matching', () => {
  /** `board()` seeds POWER from the id, so c1/c2/c3 have power 1/2/3 — c3 alone clears `> 2`. */
  const powerAbove = (n: number): CriteriaNode => ({
    kind: 'criteria',
    left: { kind: 'cardIndex', card: { kind: 'candidate' }, indexId: POWER },
    op: '>',
    right: lit(n),
  });

  const overBattlefield = (where: CriteriaNode): TargetSelector => ({
    kind: 'matching',
    from: { kind: 'allInZone', zone: bfRef },
    where,
  });

  /** Collects the §5.9 level-3 sink exactly as effects.ts's `candidateLog` feeds the real log. */
  function runLogged(sel: TargetSelector, state: PlayState, c: TriggerContext = ctx()) {
    const lines: CandidateLine[] = [];
    return { res: resolveTargets(sel, state, c, duel, (line) => lines.push(line)), lines };
  }

  // AC: SP1 — only instances whose power exceeds 2 are targeted, and the log names the criteria
  // that included or excluded each candidate (§9.1 SP1, §5.9 row 3).
  it('selects only the qualifying candidates and logs one criteria line per candidate', () => {
    const { res, lines } = runLogged(overBattlefield(powerAbove(2)), board());

    // The power<=2 candidates are absent from the resolved id set; the power-3 one is not.
    expect(expectCards(res).cardIds).toEqual(['c3']);

    // One line per CANDIDATE, not per match: the excluded ones are the whole point of the level.
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.kind)).toEqual(['criteria', 'criteria', 'criteria']);
    expect(lines.map((l) => /\b(included|excluded)\b/.exec(l.message)?.[1])).toEqual([
      'excluded',
      'excluded',
      'included',
    ]);
    // …and each line names the criterion with its RESOLVED values, not just its verdict.
    expect(lines[1].message).toContain('c2');
    expect(lines[1].message).toContain('not > 2');
    expect(lines[2].message).toContain(`${POWER}(candidate) = 3 > 2`);
  });

  it('evaluates every candidate — no short-circuit once the verdict is decided (§5.7)', () => {
    // An `or` whose first leaf already passes for c3 still logs both leaves' resolved values.
    const where: CriteriaNode = {
      kind: 'group',
      combinator: 'or',
      children: [powerAbove(2), powerAbove(99)],
    };
    const { res, lines } = runLogged(overBattlefield(where), board());
    expect(expectCards(res).cardIds).toEqual(['c3']);
    expect(lines).toHaveLength(3);
    expect(lines[2].message).toContain('> 2');
    expect(lines[2].message).toContain('not > 99');
  });

  it('a `where` that excludes everything is the ordinary NO_TARGETS, not a new failure', () => {
    const { res, lines } = runLogged(overBattlefield(powerAbove(99)), board());
    expect(expectFail(res).reason).toBe('NO_TARGETS');
    expect(lines).toHaveLength(3); // still evaluated and still logged
  });

  it('propagates the wrapped selector s failure rather than matching nothing', () => {
    const sel: TargetSelector = { kind: 'matching', from: { kind: 'triggeringCard' }, where: powerAbove(0) };
    expect(expectFail(run(sel, board(), ctx({ triggeringCardId: null }))).reason).toBe('UNBOUND_REF');
  });

  it('a `where` whose refs are broken excludes the candidate instead of throwing', () => {
    const where: CriteriaNode = {
      kind: 'criteria',
      left: { kind: 'cardIndex', card: { kind: 'candidate' }, indexId: 'idx_deleted' },
      op: '>',
      right: lit(0),
    };
    const { res, lines } = runLogged(overBattlefield(where), board());
    expect(expectFail(res).reason).toBe('NO_TARGETS');
    expect(lines[0].message).toContain('excluded');
  });

  // §4.4 — "matching wraps like prompt does, and the two compose in either order".
  describe('composition with prompt', () => {
    it('prompt(matching(…)) offers exactly the matching cards as the legal set', () => {
      const sel: TargetSelector = {
        kind: 'prompt',
        from: overBattlefield(powerAbove(1)),
        count: lit(1),
        promptText: 'Choose a creature with power 2 or more',
      };
      const res = expectPrompt(run(sel, board()));
      expect(res.candidates).toEqual(['c2', 'c3']);
      expect([res.min, res.max]).toEqual([1, 1]);
    });

    it('matching(prompt(…)) narrows the SAME highlighted set — no second targeting language', () => {
      const sel: TargetSelector = {
        kind: 'matching',
        from: {
          kind: 'prompt',
          from: { kind: 'allInZone', zone: bfRef },
          count: lit(1),
          promptText: 'Choose a creature with power 2 or more',
        },
        where: powerAbove(1),
      };
      const res = expectPrompt(run(sel, board()));
      // Same candidates, same min/max, same promptText as the other nesting order above.
      expect(res.candidates).toEqual(['c2', 'c3']);
      expect([res.min, res.max]).toEqual([1, 1]);
      expect(res.promptText).toBe('Choose a creature with power 2 or more');
    });

    it('filtering a prompt down to nothing is NO_TARGETS, so the prompt is never raised', () => {
      const sel: TargetSelector = {
        kind: 'matching',
        from: { kind: 'prompt', from: { kind: 'allInZone', zone: bfRef }, count: lit(1), promptText: 'pick' },
        where: powerAbove(99),
      };
      expect(expectFail(run(sel, board())).reason).toBe('NO_TARGETS');
    });
  });

  describe('the candidate binding', () => {
    it('is unbound outside a matching — an ordinary UNBOUND_REF, never a silent fallback', () => {
      // Same criterion, same board, reached through a rule condition rather than a `where`.
      const res = resolveValueRef(
        { kind: 'cardIndex', card: { kind: 'candidate' }, indexId: POWER },
        board(),
        ctx({ triggeringCardId: 'c1', sourceCardId: 'c1' }),
        duel
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('UNBOUND_REF');
    });

    it('is not left behind on the caller s context', () => {
      const c = ctx();
      run(overBattlefield(powerAbove(2)), board(), c);
      expect(c.candidateCardId ?? null).toBeNull();
    });

    it('nests without clobbering: each level reads its own candidate', () => {
      // matching(matching(all)) — the inner narrows to power>1, the outer to power>2 over that.
      const sel: TargetSelector = {
        kind: 'matching',
        from: overBattlefield(powerAbove(1)),
        where: powerAbove(2),
      };
      const { res, lines } = runLogged(sel, board());
      expect(expectCards(res).cardIds).toEqual(['c3']);
      // Inner ran over all three, outer over the two it kept: five lines, none of them confused
      // about which card it was testing.
      expect(lines).toHaveLength(5);
      expect(lines.map((l) => l.message.slice(0, 14))).toEqual([
        'Candidate "c1"',
        'Candidate "c2"',
        'Candidate "c3"',
        'Candidate "c2"',
        'Candidate "c3"',
      ]);
    });
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
