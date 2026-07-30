import { beforeEach, describe, expect, it } from 'vitest';
import { produceWithPatches } from 'immer';
import { useSessionStore } from './sessionStore';
import { useUiStore } from './uiStore';
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
  type Interaction,
  type PlayState,
  type PlayZone,
  type PriorityWindow,
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
  modifier: null,
  continuous: false,
  replaces: null,
  activation: null,
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
  modifier: null,
  continuous: false,
  replaces: null,
  activation: null,
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
  modifier: null,
  continuous: false,
  replaces: null,
  activation: null,
};

/**
 * v4 §4.6 (G8) — a MODAL branch parked mid-flight. Same discipline as `midStackPromptRule` above and
 * the same shape, one level down: the prompt is branch effect 1 of 3, branch effect 0 has fired an
 * event that is still sitting in `pending`, and branch effect 2 plus the rule's own trailing effect
 * are both still owed. What is new is that the continuation now includes `RuleFrame.branch` — a field
 * rewind has to restore like any other, which is the risk §8 names for this row.
 */
const modalBranchRule: RuleSet = {
  id: 'rs_modal',
  name: 'Modal',
  trigger: 'doModal',
  stateFilter: null,
  condition: null,
  effects: [
    {
      kind: 'chooseMode',
      promptText: 'Pick a mode',
      seat: { kind: 'seat', index: 0 },
      modes: [
        {
          label: 'Targeted',
          effects: [
            { kind: 'fireEvent', name: 'doShuffle' },
            {
              kind: 'destroyCards',
              target: {
                kind: 'prompt',
                from: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } },
                count: { kind: 'literal', value: 1 },
                promptText: 'Choose one to destroy (modal)',
              },
            },
            { kind: 'flipCard', target: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } }, to: 'faceDown' },
          ],
        },
      ],
    },
    { kind: 'shuffleZone', zone: { zoneId: DECK, seat: { kind: 'active' } } },
  ],
  priority: 0,
  onRejection: 'continue',
  modifier: null,
  continuous: false,
  replaces: null,
  activation: null,
};

/**
 * v2 §5.11, §9.5 edge case 13 — a global rule reachable only via `fireEvent`, same discipline as
 * `promptRule`/`midStackPromptRule` above. Two seats, so `{kind:'all'}` resolves to exactly the pair
 * the rewind-across-an-open-sealed-choice test needs.
 */
const strikeRule: RuleSet = {
  id: 'rs_strike',
  name: 'Strike',
  trigger: 'doStrike',
  stateFilter: null,
  condition: null,
  effects: [
    {
      kind: 'sealedChoice',
      choiceId: 'strike',
      seats: { kind: 'all' },
      options: [
        { id: 'hit', label: 'Hit' },
        { id: 'dodge', label: 'Dodge' },
      ],
    },
  ],
  priority: 0,
  onRejection: 'continue',
  modifier: null,
  continuous: false,
  replaces: null,
  activation: null,
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
  customEvents: ['doShuffle', 'doPrompt', 'doMidPrompt', 'doStrike', 'doModal'],
  ruleSets: [shuffleRule, promptRule, midStackPromptRule, strikeRule, modalBranchRule],
  globalRuleSetIds: ['rs_shuffle', 'rs_prompt', 'rs_midprompt', 'rs_strike', 'rs_modal'],
  priorityWindows: [],
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
function interaction(): Extract<Interaction, { kind: 'chooseCards' }> | null {
  const i = session().state.interaction;
  if (i === null) return null;
  expect(i.kind).toBe('chooseCards');
  return i as Extract<Interaction, { kind: 'chooseCards' }>;
}

/** Same narrowing as `interaction()` above, for `rs_strike`'s `sealedChoice` — §9.5 edge case 13. */
function sealedInteraction(): Extract<Interaction, { kind: 'sealed' }> | null {
  const i = session().state.interaction;
  if (i === null) return null;
  expect(i.kind).toBe('sealed');
  return i as Extract<Interaction, { kind: 'sealed' }>;
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

  // v2 §5.9 — "uiStore gains logVerbosity, and sessionStore passes it through on every action."
  it('reads uiStore.logVerbosity on dispatch and gates line emission with it', () => {
    const before = useUiStore.getState().logVerbosity;
    try {
      const [cardId] = cardsIn(DECK, 0, 1);
      const to = { zoneId: HAND, seat: { kind: 'seat' as const, index: 0 } };

      useUiStore.getState().setLogVerbosity(1);
      useSessionStore.getState().dispatch({ kind: 'moveCard', cardId, to, position: 'top' });
      const atLevel1 = session().log.at(-1)!.lines;

      const [cardId2] = cardsIn(DECK, 0, 1);
      useUiStore.getState().setLogVerbosity(2);
      useSessionStore.getState().dispatch({ kind: 'moveCard', cardId: cardId2, to, position: 'top' });
      const atLevel2 = session().log.at(-1)!.lines;

      // Same shape of action (a real move each time); level 2 shows the event/rule/change cascade
      // level 1 doesn't.
      expect(atLevel1.length).toBeLessThan(atLevel2.length);
    } finally {
      useUiStore.getState().setLogVerbosity(before);
    }
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

// ---------------------------------------------------------------------------
// v4 §4.6 (G8), §8's first risk — rewind across a suspension parked inside a MODAL BRANCH. The branch
// queue is new scheduling state on the `rule` frame, and the invariant it could have broken is the one
// rewind is built on: one user action = one transaction = one `LogEntry` = one `HistoryFrame`.
// `dispatch.test.ts` proves the branch resumes; only this file can prove it rewinds.
// ---------------------------------------------------------------------------

describe('rewind — across a suspension parked inside a modal branch (v4 §4.6)', () => {
  it('restores the branch path along with stack, pending, interaction and budget; resuming matches a session that never rewound', () => {
    const [a, b] = cardsIn(DECK, 0, 2);
    useSessionStore.getState().dispatch({ kind: 'moveCard', cardId: a, to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' });
    useSessionStore.getState().dispatch({ kind: 'moveCard', cardId: b, to: { zoneId: BATTLEFIELD, seat: null }, position: 'top' });
    const beforeModal = session().log.length;

    // Three dispatches, three entries, three history frames — asserted rather than assumed, because
    // "one action, one transaction" is exactly what a frame-level queue could have broken by
    // suspending somewhere the store did not expect.
    useSessionStore.getState().dispatch({ kind: 'fireEvent', name: 'doModal', seat: null });
    expect(session().state.interaction?.kind).toBe('chooseOption');
    useSessionStore.getState().dispatch({ kind: 'answerOption', optionId: '0' });
    expect(session().log.length).toBe(beforeModal + 2);
    expect(session().history.length).toBe(session().log.length);

    // Parked on branch effect 1 of 3, with branch effect 0's fired `doShuffle` still in `pending` and
    // branch effect 2 (plus the rule's own trailing shuffle) still owed.
    const suspended = structuredClone(session().state);
    const ruleFrameOf = (s: PlayState) =>
      s.stack.find((f): f is Extract<Frame, { kind: 'rule' }> => f.kind === 'rule');
    expect(interaction()?.promptText).toBe('Choose one to destroy (modal)');
    expect(suspended.pending.map((f) => f.kind)).toEqual(['event']);
    expect(ruleFrameOf(suspended)?.cursor).toBe(0); // still ON the chooseMode
    expect(ruleFrameOf(suspended)?.branch).toEqual([{ mode: 0, cursor: 1 }]);
    // Branch effect 2 has demonstrably not run — otherwise the restoration below proves nothing.
    expect(Object.values(suspended.cards).some((c) => c.faceDown)).toBe(false);

    const modalAt = session().log.length;
    useSessionStore.getState().dispatch({ kind: 'answerPrompt', chosen: [interaction()!.candidates[0]] });
    expect(interaction()).toBeNull();
    expect(session().state.stack).toEqual([]);
    expect(session().log.length).toBe(modalAt + 1); // the resume is ONE entry, not one per step()
    const finishedState = session().state;
    const finishedLog = session().log;

    // Rewind TO the suspending entry: the whole continuation comes back, branch path included.
    useSessionStore.getState().rewind(modalAt);
    const back = session().state;
    expect(back.interaction).toEqual(suspended.interaction);
    expect(back.stack).toEqual(suspended.stack);
    expect(back.pending).toEqual(suspended.pending);
    expect(back.budget).toEqual(suspended.budget);
    expect(ruleFrameOf(back)?.branch).toEqual([{ mode: 0, cursor: 1 }]);
    expect(back.stack).toHaveLength(2);

    // Live, not a corpse: answering again finishes the branch and the rule, identically.
    useSessionStore.getState().dispatch({ kind: 'answerPrompt', chosen: [interaction()!.candidates[0]] });
    expect(interaction()).toBeNull();
    expect(canonicalJson(session().state)).toBe(canonicalJson(finishedState));
    expect(canonicalJson(session().log)).toBe(canonicalJson(finishedLog));

    // Rewind PAST it: `branch` is gone with the rest of the continuation, no special case.
    useSessionStore.getState().rewind(beforeModal);
    expect(session().state.stack).toEqual([]);
    expect(session().state.pending).toEqual([]);
    expect(session().state.interaction).toBeNull();
    expect(Object.values(session().state.cards).some((c) => c.faceDown)).toBe(false);
  });
});

describe('rewind — into the middle of an open sealed choice (§9.5 edge case 13)', () => {
  it('rewinding to between the two submissions restores exactly seat 0\'s entry; resuming from there matches a session that never rewound', () => {
    // Session A — rewinds mid-choice, then finishes it.
    useSessionStore.getState().dispatch({ kind: 'fireEvent', name: 'doStrike', seat: null });
    expect(sealedInteraction()?.choiceId).toBe('strike');

    useSessionStore.getState().dispatch({ kind: 'submitSealed', seat: 0, optionId: 'hit' });
    const midChoice = session().log.length; // right after seat 0's submission, before seat 1's
    // §5.11 rule 1 — the submission itself added a LogEntry (sessionStore appends one per dispatch),
    // but that entry carries no LINES: `interaction.submitted` is what changed, not the log.
    expect(session().log.at(-1)!.lines).toEqual([]);

    useSessionStore.getState().dispatch({ kind: 'submitSealed', seat: 1, optionId: 'dodge' });
    expect(sealedInteraction()).toBeNull(); // resolved

    // Rewind to BETWEEN the two submissions.
    useSessionStore.getState().rewind(midChoice);
    const reopened = sealedInteraction();
    expect(reopened).not.toBeNull();
    // Exactly seat 0's entry — not seat 1's (not yet submitted at this point), not both.
    expect(reopened!.submitted).toEqual({ 0: 'hit' });
    expect(reopened!.seats).toEqual([0, 1]);

    // Resume from the rewound point.
    useSessionStore.getState().dispatch({ kind: 'submitSealed', seat: 1, optionId: 'dodge' });
    expect(sealedInteraction()).toBeNull();
    const resumedState = session().state;
    const resumedLog = session().log;

    // Session B — the SAME sequence, never rewound. §9.5 edge case 13's replay-equivalence claim,
    // extended from v1's H1 (which only covered PlayState's "static" fields) to `interaction`.
    fresh();
    useSessionStore.getState().dispatch({ kind: 'fireEvent', name: 'doStrike', seat: null });
    useSessionStore.getState().dispatch({ kind: 'submitSealed', seat: 0, optionId: 'hit' });
    useSessionStore.getState().dispatch({ kind: 'submitSealed', seat: 1, optionId: 'dodge' });
    const neverRewoundState = session().state;
    const neverRewoundLog = session().log;

    expect(canonicalJson(resumedState)).toBe(canonicalJson(neverRewoundState));
    expect(canonicalJson(resumedLog)).toBe(canonicalJson(neverRewoundLog));
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
    const emptyCtx = () => ({ triggeringCardId: null, zoneKey: null, triggeringSeat: null, promptAnswers: {}, sourceCardId: null });

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

// ---------------------------------------------------------------------------
// v2 §4.6, §5.5, §8 step 24 — priority windows through the real transaction loop. `priority.test.ts`
// owns the engine-level mechanism; this file's job is only the store-level half of MTG5: a seat that
// passes gets its OWN LogEntry/rewind point, distinct from the one that raised the interaction.
// ---------------------------------------------------------------------------

describe('rewind — priority (AC: MTG5)', () => {
  const POOL_ID = 'pool_mtg_session';
  const WIN_ID = 'win_mtg_session';

  const rsOriginalMtg: RuleSet = {
    id: 'rs_original_mtg_session',
    name: 'Original',
    trigger: 'never_original_mtg_session',
    stateFilter: null,
    condition: null,
    effects: [{ kind: 'changePool', poolId: POOL_ID, seat: { kind: 'triggeringSeat' }, op: 'subtract', amount: { kind: 'literal', value: 3 } }],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: false,
    replaces: null,
    activation: null,
  };

  const rsAnnounceMtg: RuleSet = {
    id: 'rs_announce_mtg_session',
    name: 'AnnounceMtg',
    trigger: 'doAnnounceMtg',
    stateFilter: null,
    condition: null,
    effects: [{ kind: 'announceAction', ruleId: rsOriginalMtg.id, window: WIN_ID }],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: false,
    replaces: null,
    activation: null,
  };

  // Freely activatable by any seat (no costCheck) — this test is about the REWIND/log-entry shape
  // of a pass, not about per-seat legality, which `priority.test.ts` already covers thoroughly.
  const rsRespondMtg: RuleSet = {
    id: 'rs_respond_mtg_session',
    name: 'Respond',
    trigger: 'never_respond_mtg_session',
    stateFilter: null,
    condition: null,
    effects: [],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: false,
    replaces: null,
    activation: { costCheck: null, cost: [], window: WIN_ID, perInstance: false, label: 'Respond' },
  };

  const winMtgSession: PriorityWindow = {
    id: WIN_ID,
    name: 'MTG',
    start: 'active',
    direction: 'forward',
    includeStart: true,
    passesToClose: null,
    collapseEmptyOffers: true,
  };

  const priorityDef: GameDefinition = {
    ...testDef,
    id: 'test-session-def-priority',
    pools: [{ id: POOL_ID, scope: 'player', value: { type: 'integer', name: 'Pool', defaultValue: 20, min: 0, max: 20 } }],
    customEvents: [...testDef.customEvents, 'doAnnounceMtg'],
    ruleSets: [...testDef.ruleSets, rsOriginalMtg, rsAnnounceMtg, rsRespondMtg],
    globalRuleSetIds: [...testDef.globalRuleSetIds, rsAnnounceMtg.id],
    priorityWindows: [winMtgSession],
  };

  // AC: MTG5
  it('passPriority is a fresh, own LogEntry; rewinding to before it restores the original raised interaction', () => {
    useSessionStore.getState().startSession(priorityDef, SEED);

    useSessionStore.getState().dispatch({ kind: 'fireEvent', name: 'doAnnounceMtg', seat: 0 });
    const announceEntry = session().log.at(-1)!;
    expect(announceEntry.flags.suspended).toBe(true);
    expect(session().state.interaction?.kind).toBe('priority');
    const beforePass = session().log.length;
    const rawInteraction = session().state.interaction;

    useSessionStore.getState().dispatch({ kind: 'passPriority' });
    expect(session().log).toHaveLength(beforePass + 1); // its OWN entry, not folded into the raise
    const passEntry = session().log.at(-1)!;
    expect(passEntry.cause.kind).toBe('userAction');
    expect(passEntry).not.toEqual(announceEntry);
    // Seat 0 declined; the round continues to seat 1 (also freely activatable), offering a NEW,
    // distinct interaction — proof this pass genuinely advanced the round rather than reopening the
    // same one.
    expect(session().state.interaction).toMatchObject({ kind: 'priority', seat: 1 });
    expect(session().state.interaction).not.toEqual(rawInteraction);

    // Rewind TO the point before the pass: the ORIGINAL raised interaction comes back exactly.
    useSessionStore.getState().rewind(beforePass);
    expect(session().state.interaction).toEqual(rawInteraction);

    // Rewind PAST the announce entirely: no interaction, nothing pending.
    useSessionStore.getState().rewind(beforePass - 1);
    expect(session().state.interaction).toBeNull();
    expect(session().state.actionStack).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v2 §4.5, §5.8, §8 step 25 — AC: SP8, §9.4(e) case 3. `activation.test.ts` owns the engine-level
// discard/replay mechanism; this file's job is the store-level half: one activation is one
// LogEntry/one HistoryFrame, so rewinding past it is a single step with no partial-restore point
// reachable in between (there is no "in between" — only one new index exists at all).
// ---------------------------------------------------------------------------

describe('rewind — activation (AC: SP8, §9.4(e) case 3)', () => {
  const ACT_POOL_ID = 'pool_activation_session';
  const MARKER_POOL_ID = 'pool_activation_marker';

  const rsAbilitySession: RuleSet = {
    id: 'rs_ability_session',
    name: 'Ability',
    trigger: 'never_ability_session',
    stateFilter: null,
    condition: null,
    effects: [{ kind: 'changePool', poolId: MARKER_POOL_ID, seat: { kind: 'triggeringSeat' }, op: 'add', amount: { kind: 'literal', value: 1 } }],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: false,
    replaces: null,
    activation: {
      costCheck: { kind: 'criteria', left: { kind: 'pool', poolId: ACT_POOL_ID, seat: { kind: 'triggeringSeat' } }, op: '>=', right: { kind: 'literal', value: 2 } },
      cost: [{ kind: 'changePool', poolId: ACT_POOL_ID, seat: { kind: 'triggeringSeat' }, op: 'subtract', amount: { kind: 'literal', value: 2 } }],
      window: null,
      perInstance: false,
      label: 'Ability',
    },
  };

  const activationDef: GameDefinition = {
    ...testDef,
    id: 'test-session-def-activation',
    pools: [
      { id: ACT_POOL_ID, scope: 'player', value: { type: 'integer', name: 'Pool', defaultValue: 5, min: 0, max: 99 } },
      { id: MARKER_POOL_ID, scope: 'player', value: { type: 'integer', name: 'Marker', defaultValue: 0, min: 0, max: 99 } },
    ],
    ruleSets: [...testDef.ruleSets, rsAbilitySession],
  };

  // AC: SP8
  // AC: §9.4(e) case 3 — see activation.test.ts for cases 1/2 of the same scenario.
  it('one activation is one LogEntry/HistoryFrame; rewinding past it restores the pool in one step', () => {
    useSessionStore.getState().startSession(activationDef, SEED);
    const before = session().log.length;

    useSessionStore.getState().dispatch({ kind: 'activate', ruleId: rsAbilitySession.id, cardId: null, seat: 0 });

    expect(session().state.playerPools[ACT_POOL_ID][0]).toBe(3); // 5 - 2
    expect(session().state.playerPools[MARKER_POOL_ID][0]).toBe(1); // the ability's own effect ran
    // One transaction, one entry, one history frame — cost AND effects together.
    expect(session().log).toHaveLength(before + 1);
    expect(session().history).toHaveLength(before + 1);

    useSessionStore.getState().rewind(before);

    expect(session().state.playerPools[ACT_POOL_ID][0]).toBe(5); // restored to the PRE-spend value
    expect(session().state.playerPools[MARKER_POOL_ID][0]).toBe(0);
    // No partial-restore state is reachable from any rewind point: there is only ONE new index this
    // activation could ever be rewound to either side of.
    expect(session().history).toHaveLength(before);
  });

  // v4 §4.5 (AC SP18) — the same claim, now that a cost can SUSPEND and therefore spans two entries.
  // The spend has moved out of the `activate` transaction and into the ANSWER transaction, so "rewind
  // restores the spent total exactly" has two boundaries to hold at instead of one, and the interesting
  // one is the middle: rewinding to the suspended point must give back a board where nothing is spent
  // and the question is still open.
  const rsPromptingCost: RuleSet = {
    ...rsAbilitySession,
    id: 'rs_ability_prompt_cost',
    trigger: 'never_ability_prompt_cost',
    activation: {
      costCheck: null,
      cost: [
        { kind: 'changePool', poolId: ACT_POOL_ID, seat: { kind: 'triggeringSeat' }, op: 'subtract', amount: { kind: 'literal', value: 2 } },
        {
          kind: 'moveCards',
          target: {
            kind: 'prompt',
            from: { kind: 'allInZone', zone: { zoneId: DECK, seat: { kind: 'seat', index: 0 } } },
            count: { kind: 'literal', value: 1 },
            promptText: 'Exile a card from your deck',
          },
          to: { zoneId: BATTLEFIELD, seat: null },
          position: 'top',
        },
      ],
      window: null,
      perInstance: false,
      label: 'Ability',
    },
  };

  const promptingCostDef: GameDefinition = {
    ...activationDef,
    id: 'test-session-def-activation-prompt',
    ruleSets: [...activationDef.ruleSets, rsPromptingCost],
  };

  // AC: SP18
  it('an interactive cost is two entries, and rewinding to either boundary restores the spend exactly', () => {
    useSessionStore.getState().startSession(promptingCostDef, SEED);
    const before = session().log.length;
    const deckKey = zoneKey(DECK, 0);
    const chosen = session().state.zones[deckKey].cardIds[0];
    const deckBefore = [...session().state.zones[deckKey].cardIds];

    useSessionStore.getState().dispatch({ kind: 'activate', ruleId: rsPromptingCost.id, cardId: null, seat: 0 });

    // Entry 1 — the question, and NOTHING else. The pool spend sits at cost index 0, ahead of the
    // prompting effect, and is still unspent.
    expect(session().state.interaction?.kind).toBe('chooseCards');
    expect(session().state.playerPools[ACT_POOL_ID][0]).toBe(5);
    expect(session().log).toHaveLength(before + 1);

    useSessionStore.getState().dispatch({ kind: 'answerPrompt', chosen: [chosen] });

    // Entry 2 — the whole cost, plus the ability's own effect, in one transaction.
    expect(session().state.playerPools[ACT_POOL_ID][0]).toBe(3);
    expect(session().state.playerPools[MARKER_POOL_ID][0]).toBe(1);
    expect(session().state.zones[BATTLEFIELD].cardIds).toEqual([chosen]);
    expect(session().log).toHaveLength(before + 2);
    expect(session().history).toHaveLength(before + 2);

    // Rewind to the SUSPENDED boundary: unspent, unmoved, and still asking.
    useSessionStore.getState().rewind(before + 1);
    expect(session().state.playerPools[ACT_POOL_ID][0]).toBe(5);
    expect(session().state.playerPools[MARKER_POOL_ID][0]).toBe(0);
    expect(session().state.zones[deckKey].cardIds).toEqual(deckBefore);
    expect(session().state.interaction?.kind).toBe('chooseCards');
    expect(session().state.stack.map((f) => f.kind)).toEqual(['activation']);

    // And past the activation entirely: no frame, no question, nothing spent.
    useSessionStore.getState().rewind(before);
    expect(session().state.playerPools[ACT_POOL_ID][0]).toBe(5);
    expect(session().state.interaction).toBeNull();
    expect(session().state.stack).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §9.4(a) — nested suspension, rewind half. `dispatch.test.ts` proves the stack shape while
// suspended (a chooseNumber suspends a fresh rule frame stacked directly above an open priority
// window, and answering pops it and resumes the round in place, not restarted). This is the rewind
// half: §5.10 claims rewinding across all three suspension layers (pending action -> priority window
// -> chooseNumber) needs no special case — the stack is just frames, so unwinding it is the same
// mechanism H1 already proves for one layer. This is the test that actually drives three layers deep
// rather than asserting the claim by quoting it.
// ---------------------------------------------------------------------------

describe('rewind — §9.4(a) nested suspension (chooseNumber inside an open priority window)', () => {
  const N_ID = 'pool_nested_session';
  const WIN_ID = 'win_nested_session';

  const rsOriginalNested: RuleSet = {
    id: 'rs_original_nested_session',
    name: 'Original',
    trigger: 'never_original_nested_session',
    stateFilter: null,
    condition: null,
    effects: [{ kind: 'changePool', poolId: N_ID, seat: null, op: 'add', amount: { kind: 'literal', value: 100 } }],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: false,
    replaces: null,
    activation: null,
  };

  const rsAnnounceNested: RuleSet = {
    id: 'rs_announce_nested_session',
    name: 'AnnounceNested',
    trigger: 'doAnnounceNested',
    stateFilter: null,
    condition: null,
    effects: [{ kind: 'announceAction', ruleId: rsOriginalNested.id, window: WIN_ID }],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: false,
    replaces: null,
    activation: null,
  };

  // Freely activatable (no costCheck) — the same simplification `rsRespondMtg` above makes: this
  // test is about the REWIND shape across a nested suspension, not per-seat legality (priority.test.ts
  // already covers legality thoroughly).
  const rsRespondNested: RuleSet = {
    id: 'rs_respond_nested_session',
    name: 'RespondNested',
    trigger: 'never_respond_nested_session',
    stateFilter: null,
    condition: null,
    effects: [
      { kind: 'chooseNumber', promptText: 'Pick a number', seat: { kind: 'seat', index: 0 }, min: { kind: 'literal', value: 0 }, max: { kind: 'literal', value: 5 }, key: 'x' },
      { kind: 'changePool', poolId: N_ID, seat: null, op: 'add', amount: { kind: 'promptNumber', key: 'x' } },
    ],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: false,
    replaces: null,
    activation: { costCheck: null, cost: [], window: WIN_ID, perInstance: false, label: 'Respond' },
  };

  const winNestedSession: PriorityWindow = {
    id: WIN_ID,
    name: 'Nested',
    start: 'active',
    direction: 'forward',
    includeStart: true,
    passesToClose: null,
    collapseEmptyOffers: true,
  };

  const nestedDef: GameDefinition = {
    ...testDef,
    id: 'test-session-def-nested',
    pools: [{ id: N_ID, scope: 'game', value: { type: 'integer', name: 'N', defaultValue: 0, min: 0, max: null } }],
    customEvents: [...testDef.customEvents, 'doAnnounceNested'],
    ruleSets: [...testDef.ruleSets, rsOriginalNested, rsAnnounceNested, rsRespondNested],
    globalRuleSetIds: [...testDef.globalRuleSetIds, rsAnnounceNested.id],
    priorityWindows: [winNestedSession],
  };

  it('rewinds across all three suspension layers with no special case: to the pre-answer chooseNumber, and to before the response ever happened', () => {
    useSessionStore.getState().startSession(nestedDef, SEED);

    useSessionStore.getState().dispatch({ kind: 'fireEvent', name: 'doAnnounceNested', seat: 0 });
    expect(session().state.interaction?.kind).toBe('priority');
    const afterAnnounce = session().log.length;
    const stackAfterAnnounce = session().state.stack;
    const actionStackAfterAnnounce = session().state.actionStack;
    const pendingActionsAfterAnnounce = session().state.pendingActions;
    expect(actionStackAfterAnnounce).toHaveLength(1); // RS_ORIGINAL, the one pending action

    useSessionStore.getState().dispatch({ kind: 'activate', ruleId: rsRespondNested.id, cardId: null, seat: 0 });
    expect(session().state.interaction?.kind).toBe('chooseNumber');
    // Same shape `dispatch.test.ts` pins directly: a fresh rule frame stacked above the (untouched)
    // priority frame.
    expect(session().state.stack.map((f: Frame) => f.kind).slice(-2)).toEqual(['priority', 'rule']);
    const beforeAnswer = session().log.length;
    const interactionBeforeAnswer = session().state.interaction;
    const stackBeforeAnswer = session().state.stack;

    useSessionStore.getState().dispatch({ kind: 'answerNumber', value: 3 });
    // Whatever this settles into (the round may re-offer priority, since the response is freely
    // repeatable) is provably DIFFERENT from the pre-answer suspension — the baseline assertion 3
    // needs before rewinding away from it.
    expect(session().state.interaction).not.toEqual(interactionBeforeAnswer);

    // Assertion 3 (§9.4(a)) — rewinding to the point before the number was asked restores the EXACT
    // pre-answer suspension: the same chooseNumber interaction, the same stack (['priority','rule'],
    // rule frame cursor un-advanced) — not popped, not advanced.
    useSessionStore.getState().rewind(beforeAnswer);
    expect(session().state.interaction).toEqual(interactionBeforeAnswer);
    expect(session().state.stack).toEqual(stackBeforeAnswer);

    // Assertion 4 (§9.4(a)) — rewinding to before seat 0 ever responded restores EXACTLY the open
    // priority window, the one original pending action, and nothing about the response left over —
    // the whole nested frame is gone, per §5.10's "no special case" claim, not merely popped once.
    useSessionStore.getState().rewind(afterAnnounce);
    expect(session().state.interaction?.kind).toBe('priority');
    expect(session().state.stack).toEqual(stackAfterAnnounce);
    expect(session().state.actionStack).toEqual(actionStackAfterAnnounce);
    expect(session().state.pendingActions).toEqual(pendingActionsAfterAnnounce);
  });
});
