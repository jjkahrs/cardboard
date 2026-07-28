import { beforeEach, describe, expect, it } from 'vitest';
import { produceWithPatches } from 'immer';
import { useSessionStore } from './sessionStore';
import { createPlayState } from '../engine/setup';
import { zoneKey } from '../engine/valueRef';
import { duel, script, SCRIPT_SEED } from '../test/fixtures';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
  type CardTemplate,
  type Deck,
  type Frame,
  type GameDefinition,
  type PlayState,
  type PlayZone,
  type RuleSet,
} from '../engine/types';

/**
 * `src/test/fixtures/script.ts` (the ~200-action `duel` script from §9.3) hadn't landed, and
 * `dispatch.ts` bound a card-attached RuleSet to EVERY matching card on the board whenever its
 * trigger fired (not just the card that moved), when the tests below were first written — `duel`'s
 * Cantrip/Bomb/Grunt rules would have cascaded unpredictably under a hand-picked action list. So
 * this file drives a small, self-contained definition for its own rewind tests: one inert template
 * (zero attached rules, so `moveCard`/`flipCard`/`rotateCard` are side-effect-free apart from the
 * physical change) plus two GLOBAL rules reachable only via `fireEvent`, giving deterministic
 * control over exactly when a shuffle or a prompt happens.
 *
 * Both blockers are gone now (dispatch.ts self-scopes card-attached rules to the triggering card;
 * script.ts exists) — see the `script.ts`-driven `describe` block further down, which runs the SAME
 * rewind-fidelity checks against the real 200-action `duel` script. The inline definition stays: a
 * fast, focused proof of the mechanism, independent of any one fixture.
 */

const HAND = 'hand';
const DECK = 'deck';
const BATTLEFIELD = 'battlefield';
const BLANK = 'blank';
const MAIN = 'main';

const handZone: PlayZone = { id: HAND, name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: 7 };
const deckZone: PlayZone = { id: DECK, name: 'Deck', scope: 'player', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null };
const battlefieldZone: PlayZone = { id: BATTLEFIELD, name: 'Battlefield', scope: 'shared', visibility: 'faceUp', layout: 'row', ordered: false, maxCapacity: null };

const blankTemplate: CardTemplate = {
  id: BLANK,
  name: 'Blank',
  marquee: 'Blank',
  faceIcon: 'gi-card',
  borderColor: '#000',
  tags: [],
  indexes: [],
  ruleSetIds: [],
  rulesTextOverride: null,
};

const deck: Deck = { id: 'starter', name: 'Starter', zoneId: DECK, entries: [{ templateId: BLANK, quantity: 10 }] };

// Global rules — bound to no card, reachable only by explicitly firing their event, so they never
// fire as a side effect of an ordinary move (unlike duel's card-attached rules).
const shuffleRule: RuleSet = {
  id: 'rs_shuffle',
  name: 'Shuffle',
  trigger: 'doShuffle',
  stateFilter: null,
  condition: null,
  effects: [{ kind: 'shuffleZone', zone: { zoneId: DECK, seat: { kind: 'active' } } }],
  priority: 0,
  onRejection: 'continue',
};

const promptRule: RuleSet = {
  id: 'rs_prompt',
  name: 'Prompt',
  trigger: 'doPrompt',
  stateFilter: null,
  condition: null,
  effects: [
    {
      kind: 'destroyCards',
      target: {
        kind: 'prompt',
        from: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } },
        count: { kind: 'literal', value: 1 },
        promptText: 'Choose one to destroy',
      },
    },
  ],
  priority: 0,
  onRejection: 'continue',
};

/**
 * The prompt sits at effect index 1 of 3 and effect 0 fires another event. Suspending inside this
 * rule therefore parks a `rule` frame's cursor MID effect list with a sibling event still sitting in
 * `state.pending` — the v2-only shape §5.10 claims rewind restores with no special case. `rs_prompt`
 * above cannot prove that: its single effect leaves the cursor at 0 and `pending` empty.
 */
const midStackPromptRule: RuleSet = {
  id: 'rs_midprompt',
  name: 'Mid-list Prompt',
  trigger: 'doMidPrompt',
  stateFilter: null,
  condition: null,
  effects: [
    { kind: 'fireEvent', name: 'doShuffle' },
    {
      kind: 'destroyCards',
      target: {
        kind: 'prompt',
        from: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } },
        count: { kind: 'literal', value: 1 },
        promptText: 'Choose one to destroy (mid-list)',
      },
    },
    { kind: 'shuffleZone', zone: { zoneId: DECK, seat: { kind: 'active' } } },
  ],
  priority: 0,
  onRejection: 'continue',
};

const testDef: GameDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: 'test-session-def',
  name: 'Session Test',
  playerCount: 2,
  pools: [],
  zones: [handZone, deckZone, battlefieldZone],
  templates: [blankTemplate],
  decks: [deck],
  customEvents: ['doShuffle', 'doPrompt', 'doMidPrompt'],
  ruleSets: [shuffleRule, promptRule, midStackPromptRule],
  globalRuleSetIds: ['rs_shuffle', 'rs_prompt', 'rs_midprompt'],
  machine: {
    states: [
      { id: START_STATE_ID, name: 'Start', enterableFrom: [], exitableTo: [MAIN], entryCriteria: null, transitionLabel: null, priority: 0, position: { x: 0, y: 0 } },
      { id: MAIN, name: 'Main', enterableFrom: [START_STATE_ID], exitableTo: [END_STATE_ID], entryCriteria: null, transitionLabel: 'Main', priority: 0, position: { x: 0, y: 0 } },
      { id: END_STATE_ID, name: 'End', enterableFrom: [MAIN], exitableTo: [], entryCriteria: null, transitionLabel: null, priority: 0, position: { x: 0, y: 0 } },
    ],
    startStateId: START_STATE_ID,
    endStateId: END_STATE_ID,
  },
  limits: {
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEffects: DEFAULT_MAX_EFFECTS,
    maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
    maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
  },
  updatedAt: new Date(0).toISOString(),
};

const SEED = '12345';

function fresh() {
  useSessionStore.getState().startSession(testDef, SEED);
}

function session() {
  const s = useSessionStore.getState().session;
  if (!s) throw new Error('no session');
  return s;
}

/** First `n` card ids currently in `zoneId` for `seat` — order doesn't matter, moveCard finds the
 * card wherever it sits. */
function cardsIn(zoneId: string, seat: number | null, n: number): string[] {
  return session().state.zones[zoneKey(zoneId, seat)].cardIds.slice(0, n);
}

/**
 * `state.interaction`, asserted to be the one arm phase 0 can raise before it is read as one.
 * §9.2: v1's prompt slot's data under a discriminant, so every assertion below is the v1 assertion
 * — but the discriminant is checked rather than assumed, so a later arm raised where `chooseCards`
 * is expected fails here instead of silently reading `undefined` off a different shape.
 */
function interaction() {
  const i = session().state.interaction;
  if (i === null) return null;
  expect(i.kind).toBe('chooseCards');
  return i;
}

/** Sorts object keys recursively before stringifying — the same spirit as `exportJson`'s canonical
 * key ordering (§7.1), reimplemented locally because `exportJson` is bound to `GameDefinitionSchema`
 * and cannot serialize a `PlayState`. */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

beforeEach(fresh);

// ---------------------------------------------------------------------------

describe('startSession', () => {
  it('creates a settled initial session with an empty log and history', () => {
    const s = session();
    expect(s.log).toEqual([]);
    expect(s.history).toEqual([]);
    expect(s.state.currentStateId).toBe(START_STATE_ID);
    expect(s.state.finished).toBe(false);
  });

  it('snapshots the definition — editing the caller-held object after start does not reach the session', () => {
    const mutableDef: GameDefinition = structuredClone(testDef);
    useSessionStore.getState().startSession(mutableDef, SEED);
    mutableDef.name = 'Mutated After Start';
    expect(session().definition.name).toBe('Session Test');
  });
});

describe('dispatch — a rejected action while an interaction is set', () => {
  it('keeps the pending prompt answerable (logSeq must not move under it)', () => {
    // promptId is `${logSeq}:${ruleId}:${effectIndex}`. A rejected action still appends a log entry,
    // so bumping logSeq for it files the tester's answer under an id runEffects never reads: the
    // answer vanishes and the identical prompt is re-raised. PlayToolbar/TransitionBar stay enabled
    // during a prompt, so this is one stray click away in the real UI.
    const [cardId] = cardsIn(DECK, 0, 1);
    const dispatch = useSessionStore.getState().dispatch;
    dispatch({ kind: 'moveCard', cardId, to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' });
    dispatch({ kind: 'fireEvent', name: 'doPrompt', seat: 0 });

    const raised = interaction();
    expect(raised?.candidates).toEqual([cardId]);

    dispatch({ kind: 'transition', toStateId: MAIN }); // rejected AWAITING_PROMPT — but logged
    expect(interaction()?.promptId).toBe(raised!.promptId);

    dispatch({ kind: 'answerPrompt', chosen: [cardId] });

    expect(interaction()).toBeNull();
    expect(session().state.cards[cardId]).toBeUndefined(); // the destroy actually ran
  });
});

describe('dispatch — transaction loop basics', () => {
  it('one action produces exactly one log entry and one history frame with non-empty patches', () => {
    const [cardId] = cardsIn(DECK, 0, 1);
    useSessionStore.getState().dispatch({ kind: 'moveCard', cardId, to: { zoneId: HAND, seat: { kind: 'seat', index: 0 } }, position: 'top' });

    const s = session();
    expect(s.log).toHaveLength(1);
    expect(s.history).toHaveLength(1);
    expect(s.history[0].forward.length).toBeGreaterThan(0);
    expect(s.history[0].inverse.length).toBeGreaterThan(0);
    expect(s.log[0].seq).toBe(0);
    expect(s.state.zones[zoneKey(HAND, 0)].cardIds).toContain(cardId);
  });
});

describe('dispatch — AC: M4 override', () => {
  it('a capacity-rejected move fails cleanly; the same move with override succeeds, flagged', () => {
    const ids = cardsIn(DECK, 0, 8);
    const moveToHand = (cardId: string, override: boolean) =>
      useSessionStore.getState().dispatch({ kind: 'moveCard', cardId, to: { zoneId: HAND, seat: { kind: 'seat', index: 0 } }, position: 'top' }, override);

    for (const id of ids.slice(0, 7)) moveToHand(id, false);
    expect(session().state.zones[zoneKey(HAND, 0)].cardIds).toHaveLength(7);

    // 8th, no override: rejected, count unchanged.
    moveToHand(ids[7], false);
    expect(session().state.zones[zoneKey(HAND, 0)].cardIds).toHaveLength(7);
    const rejectedEntry = session().log.at(-1)!;
    expect(rejectedEntry.flags.override).toBeUndefined();

    // Same move, with override: succeeds, count 8, flagged.
    moveToHand(ids[7], true);
    expect(session().state.zones[zoneKey(HAND, 0)].cardIds).toHaveLength(8);
    const overrideEntry = session().log.at(-1)!;
    expect(overrideEntry.flags.override).toBe(true);
  });
});

describe('rewind — AC: H1', () => {
  it('20 entries; rewind to 12 restores state and truncates; one more action is entry 13, not a resurrection', () => {
    const [cardId] = cardsIn(DECK, 0, 1);
    for (let i = 0; i < 20; i++) {
      useSessionStore.getState().dispatch({ kind: 'flipCard', cardId, to: 'toggle' });
    }
    expect(session().log).toHaveLength(20);
    const discardedEntry = session().log[12]; // the 13th entry, about to be undone and dropped

    useSessionStore.getState().rewind(12);
    expect(session().log).toHaveLength(12);
    expect(session().history).toHaveLength(12);

    // A different action kind so the new entry 13 cannot coincidentally match the discarded one.
    useSessionStore.getState().dispatch({ kind: 'rotateCard', cardId, to: 'toggle' });
    expect(session().log).toHaveLength(13);
    const newEntry = session().log[12];
    expect(newEntry.cause.description).not.toBe(discardedEntry.cause.description);
    expect(newEntry).not.toEqual(discardedEntry);
  });
});

describe('rewind — across a prompt', () => {
  it('rewinding past the suspending entry clears the interaction; rewinding TO it restores the original frozen prompt', () => {
    const [a, b] = cardsIn(DECK, 0, 2);
    useSessionStore.getState().dispatch({ kind: 'moveCard', cardId: a, to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' });
    useSessionStore.getState().dispatch({ kind: 'moveCard', cardId: b, to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' });
    const beforePrompt = session().log.length; // 2

    useSessionStore.getState().dispatch({ kind: 'fireEvent', name: 'doPrompt', seat: null });
    const suspendedPrompt = interaction();
    expect(suspendedPrompt).not.toBeNull();
    expect(session().log.at(-1)!.flags.suspended).toBe(true);
    const promptAt = session().log.length; // 3

    // Answer it — the suspension resolves and clears.
    useSessionStore.getState().dispatch({ kind: 'answerPrompt', chosen: [suspendedPrompt!.candidates[0]] });
    expect(interaction()).toBeNull();

    // Rewind TO the suspending entry (keep it, undo only the answer): the ORIGINAL frozen prompt
    // comes back, so the tester could answer differently and branch.
    useSessionStore.getState().rewind(promptAt);
    expect(interaction()).toEqual(suspendedPrompt);

    // Rewind PAST the suspending entry entirely: no special case needed, it's just gone.
    useSessionStore.getState().rewind(beforePrompt);
    expect(interaction()).toBeNull();
  });
});

describe('rewind — across a suspension parked MID stack (§5.10, v2-only)', () => {
  it('restores stack, pending, interaction and budget together — including the rule cursor mid effect list', () => {
    // §5.10's whole claim is that a suspended v2 state needs no special case in rewind because
    // `stack`, `pending`, `interaction` and `budget` are all fields of `PlayState`. A v1 suspension
    // could not test that: it was one queued `effect` work item with no cursor. `rs_midprompt`
    // suspends at effect 1 of 3, with effect 0's fired event still waiting in `pending`, so there is
    // a real continuation to lose.
    const [a, b] = cardsIn(DECK, 0, 2);
    useSessionStore.getState().dispatch({ kind: 'moveCard', cardId: a, to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' });
    useSessionStore.getState().dispatch({ kind: 'moveCard', cardId: b, to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' });
    const beforePrompt = session().log.length;

    useSessionStore.getState().dispatch({ kind: 'fireEvent', name: 'doMidPrompt', seat: null });
    const promptAt = session().log.length;

    // The suspended shape, captured by value — `session()` hands back the live object, and the
    // answer below mutates the very frames we are about to compare against.
    const suspended = structuredClone(session().state);
    const ruleFrameOf = (s: PlayState) =>
      s.stack.find((f): f is Extract<Frame, { kind: 'rule' }> => f.kind === 'rule');

    // Preconditions: if any of these are wrong the restoration assertions below prove nothing.
    expect(suspended.interaction).not.toBeNull();
    expect(suspended.stack.map((f) => f.kind)).toEqual(['event', 'rule']);
    expect(suspended.pending.map((f) => f.kind)).toEqual(['event']); // effect 0's fired doShuffle
    expect(ruleFrameOf(suspended)?.ruleId).toBe('rs_midprompt');
    // Parked ON the prompt effect, with effect 2 still owed — not 0, not past the end.
    expect(ruleFrameOf(suspended)?.cursor).toBe(1);
    expect(midStackPromptRule.effects).toHaveLength(3);
    expect(suspended.budget.effectsUsed).toBeGreaterThan(0); // effect 0 ran and was counted

    // Answer it: the stack drains, the queued doShuffle runs, the transaction settles.
    useSessionStore.getState().dispatch({ kind: 'answerPrompt', chosen: [interaction()!.candidates[0]] });
    expect(interaction()).toBeNull();
    expect(session().state.stack).toEqual([]);
    expect(session().state.pending).toEqual([]);

    // Rewind TO the suspending entry: every part of the continuation comes back at once.
    useSessionStore.getState().rewind(promptAt);
    const back = session().state;
    expect(back.interaction).toEqual(suspended.interaction);
    expect(back.stack).toEqual(suspended.stack);
    expect(back.pending).toEqual(suspended.pending);
    expect(back.budget).toEqual(suspended.budget);
    // Asserted by VALUE, not by deep-equality alone: `stack`/`pending` deep-equal would also pass if
    // both sides were `[]`, which is exactly the vacuous pass this test exists to rule out.
    expect(ruleFrameOf(back)?.cursor).toBe(1);
    expect(back.stack).toHaveLength(2);
    expect(back.pending).toHaveLength(1);

    // And the restored continuation is live, not a corpse: answering again completes it.
    useSessionStore.getState().dispatch({ kind: 'answerPrompt', chosen: [interaction()!.candidates[0]] });
    expect(interaction()).toBeNull();
    expect(session().state.stack).toEqual([]);

    // Rewind PAST it: the whole continuation is gone, with no special case in rewind().
    useSessionStore.getState().rewind(beforePrompt);
    expect(session().state.interaction).toBeNull();
    expect(session().state.stack).toEqual([]);
    expect(session().state.pending).toEqual([]);
  });
});

describe('rewind — past End', () => {
  it('finished flips back to false', () => {
    useSessionStore.getState().dispatch({ kind: 'transition', toStateId: MAIN });
    const beforeEnd = session().log.length;
    useSessionStore.getState().dispatch({ kind: 'transition', toStateId: END_STATE_ID });
    expect(session().state.finished).toBe(true);

    useSessionStore.getState().rewind(beforeEnd);
    expect(session().state.finished).toBe(false);
  });
});

describe('rewind fidelity — point rewinds, rngCursor, replay equivalence', () => {
  it('matches recorded snapshots at several points, restores rngCursor, and replays identically after a rewind', () => {
    const deckSeat0 = cardsIn(DECK, 0, 6);
    const deckSeat1 = cardsIn(DECK, 1, 2);

    const actions: Array<() => void> = [
      () => useSessionStore.getState().dispatch({ kind: 'transition', toStateId: MAIN }),
      () => useSessionStore.getState().dispatch({ kind: 'moveCard', cardId: deckSeat0[0], to: { zoneId: HAND, seat: { kind: 'seat', index: 0 } }, position: 'top' }),
      () => useSessionStore.getState().dispatch({ kind: 'moveCard', cardId: deckSeat0[1], to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' }),
      () => useSessionStore.getState().dispatch({ kind: 'flipCard', cardId: deckSeat0[1], to: 'faceUp' }),
      () => useSessionStore.getState().dispatch({ kind: 'rotateCard', cardId: deckSeat0[1], to: 'rotated' }),
      () => useSessionStore.getState().dispatch({ kind: 'fireEvent', name: 'doShuffle', seat: null }),
      () => useSessionStore.getState().dispatch({ kind: 'moveCard', cardId: deckSeat0[2], to: { zoneId: HAND, seat: { kind: 'seat', index: 0 } }, position: 'bottom' }),
      () => useSessionStore.getState().dispatch({ kind: 'moveCard', cardId: deckSeat1[0], to: { zoneId: HAND, seat: { kind: 'seat', index: 1 } }, position: 'top' }),
      () => useSessionStore.getState().dispatch({ kind: 'flipCard', cardId: deckSeat0[0], to: 'toggle' }),
      () => useSessionStore.getState().dispatch({ kind: 'moveCard', cardId: deckSeat0[3], to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' }),
      () => useSessionStore.getState().dispatch({ kind: 'fireEvent', name: 'doShuffle', seat: null }),
      () => useSessionStore.getState().dispatch({ kind: 'rotateCard', cardId: deckSeat0[2], to: 'toggle' }),
      () => useSessionStore.getState().dispatch({ kind: 'moveCard', cardId: deckSeat1[1], to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' }),
      () => useSessionStore.getState().dispatch({ kind: 'flipCard', cardId: deckSeat0[3], to: 'faceDown' }),
    ];

    const snapshots: string[] = [canonicalJson(session().state)];
    const rngCursors: number[] = [session().state.rngCursor];
    for (const act of actions) {
      act();
      snapshots.push(canonicalJson(session().state));
      rngCursors.push(session().state.rngCursor);
    }

    // Point rewinds: full-state equality, not spot checks.
    for (const n of [3, 7, 11]) {
      useSessionStore.getState().rewind(n);
      expect(canonicalJson(session().state)).toBe(snapshots[n]);
      // Explicitly assert rngCursor — the field that gets missed because it feels like infrastructure.
      expect(session().state.rngCursor).toBe(rngCursors[n]);
      // restore for the next iteration
      for (let i = n; i < actions.length; i++) actions[i]();
    }
    expect(session().log).toHaveLength(actions.length);

    // Replay equivalence, the strong test: rewind to 7, re-apply actions 7..end, compare snapshots.
    useSessionStore.getState().rewind(7);
    const replayed: string[] = [];
    for (let i = 7; i < actions.length; i++) {
      actions[i]();
      replayed.push(canonicalJson(session().state));
    }
    expect(replayed).toEqual(snapshots.slice(8));
  });
});

describe('rewind fidelity — script.ts (duel, seed 12345, 200 real actions)', () => {
  it('point rewinds at [0, 1, 12, 99, 198] match recorded snapshots (incl. rngCursor), and replay from 99 matches element-wise', () => {
    useSessionStore.getState().startSession(duel, SCRIPT_SEED);

    const snapshots: string[] = [canonicalJson(session().state)];
    const rngCursors: number[] = [session().state.rngCursor];
    for (const r of script) {
      useSessionStore.getState().dispatch(r.action, r.override ?? false);
      snapshots.push(canonicalJson(session().state));
      rngCursors.push(session().state.rngCursor);
    }
    expect(session().log).toHaveLength(200);

    for (const n of [0, 1, 12, 99, 198]) {
      useSessionStore.getState().rewind(n);
      expect(canonicalJson(session().state)).toBe(snapshots[n]);
      expect(session().state.rngCursor).toBe(rngCursors[n]);
      // restore to 200 for the next point rewind
      for (let i = n; i < script.length; i++) {
        useSessionStore.getState().dispatch(script[i].action, script[i].override ?? false);
      }
    }

    // Replay equivalence, the strong test: rewind to 99, re-apply rows 99..199, compare snapshots.
    useSessionStore.getState().rewind(99);
    const replayed: string[] = [];
    for (let i = 99; i < script.length; i++) {
      useSessionStore.getState().dispatch(script[i].action, script[i].override ?? false);
      replayed.push(canonicalJson(session().state));
    }
    expect(replayed).toEqual(snapshots.slice(100));
  });
});

describe('§9.4 item 13 — immer patch coverage over every top-level PlayState slice', () => {
  it('mutating each field produces a non-empty inverse patch array', () => {
    const base = createPlayState(testDef, SEED);
    const someCardId = Object.keys(base.cards)[0];
    const someZoneKey = Object.keys(base.zones)[0];
    const emptyCtx = () => ({ triggeringCardId: null, zoneKey: null, triggeringSeat: null, promptAnswers: {} });

    const mutators: Array<[string, (d: PlayState) => void]> = [
      ['definitionId', (d) => { d.definitionId = 'other'; }],
      ['seed', (d) => { d.seed = 'other-seed'; }],
      ['rngCursor', (d) => { d.rngCursor += 1; }],
      ['nextSeq', (d) => { d.nextSeq += 1; }],
      ['nextWorkId', (d) => { d.nextWorkId += 1; }],
      ['logSeq', (d) => { d.logSeq += 1; }],
      ['playerCount', (d) => { d.playerCount += 1; }],
      ['pools', (d) => { d.pools.newPool = 1; }],
      ['playerPools', (d) => { d.playerPools.newPool = [0, 0]; }],
      ['cards', (d) => { d.cards[someCardId].rotated = !d.cards[someCardId].rotated; }],
      ['zones', (d) => { d.zones[someZoneKey].cardIds.push('extra'); }],
      ['currentStateId', (d) => { d.currentStateId = 'somewhere-else'; }],
      ['finished', (d) => { d.finished = true; }],
      // v1's single `queue` row splits in two: `stack` and `pending` are independent fields, and a
      // rewind that restored one but not the other would still pass a single-field check.
      ['stack', (d) => { d.stack.push({ kind: 'rule', id: 0, parentId: null, depth: 0, ruleId: 'rs_shuffle', sourceCardId: null, ctx: emptyCtx(), cursor: 0, aborted: false }); }],
      ['pending', (d) => { d.pending.push({ kind: 'event', id: 0, parentId: null, depth: 0, name: 'x', ctx: emptyCtx(), bindings: [], cursor: -1 }); }],
      ['interaction', (d) => { d.interaction = { kind: 'chooseCards', promptId: 'p', promptText: 't', seat: 0, candidates: [], min: 0, max: 1 }; }],
      ['budget', (d) => { d.budget.effectsUsed += 1; }],
    ];

    for (const [name, mutate] of mutators) {
      const [, , inverse] = produceWithPatches(base, mutate);
      expect(inverse.length, `${name} produced no inverse patches`).toBeGreaterThan(0);
    }
  });
});

describe('performance budget', () => {
  it('200 actions + 5 rewinds finish under 2s, and patch-log growth is sub-linear', () => {
    const [cardId] = cardsIn(DECK, 0, 1);
    const start = Date.now();

    for (let i = 0; i < 200; i++) {
      useSessionStore.getState().dispatch({ kind: 'flipCard', cardId, to: 'toggle' });
    }
    const avgBytesAt = (n: number) => JSON.stringify(session().history.slice(0, n)).length / n;
    const avg10 = avgBytesAt(10);
    const avg200 = avgBytesAt(200);

    for (const n of [190, 150, 100, 50, 0]) useSessionStore.getState().rewind(n);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    // The invariant §9.3 actually cares about: PER-ENTRY cost must not grow with total state (a
    // snapshot-in-disguise). Confirmed by inspecting an actual frame: each flipCard here is two
    // small `replace` patches (the field flip and `nextWorkId`, bumped by the settle frame's id),
    // never a whole-array/whole-state dump. `stack` and `pending` cost nothing here even though v2
    // pushes a settle frame per transaction: the push and the pop both happen inside the SAME
    // produceWithPatches, so both arrays start and end empty and immer records no patch for them.
    // If this assertion ever fails, the settle frame has started leaking patches into every history
    // frame — a real regression in rewind cost, not a multiplier that needs raising. Average bytes/entry
    // does drift a little (logSeq grows from 1 to 3 JSON digits over 200 entries, a bounded,
    // one-time log-scale effect) but nowhere near doubling, so 2x is generous and unambiguous, not
    // a constant tuned to clear the observed number.
    expect(avg200).toBeLessThan(2 * avg10);
  });
});
