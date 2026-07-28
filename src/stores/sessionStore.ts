/**
 * The transaction loop, log, patch history, and rewind. TECHNICAL_DESIGN.md §3.3, §3.5, §5.8.
 *
 * `HistoryFrame`/`PlaySession` live here rather than in `engine/types.ts` because they reference
 * immer's `Patch`, and §3.2 forbids the engine importing immer at all.
 */

import { create } from 'zustand';
import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import { step } from '../engine/dispatch';
import { isResuming, isSuspended } from '../engine/interaction';
import { createPlayState } from '../engine/setup';
import {
  type EngineInput,
  type GameDefinition,
  type LogEntry,
  type LogLine,
  type PlayAction,
  type PlayState,
  type StepResult,
} from '../engine/types';
import { useUiStore } from './uiStore';

// `main.tsx` calls this once at app boot. A test that imports this module directly never goes
// through main.tsx, so it is called here too — a second call is a documented immer no-op, an
// omitted one makes produceWithPatches silently return empty patch arrays and every rewind test
// pass vacuously against nothing (§3.3).
enablePatches();

export interface HistoryFrame {
  forward: Patch[];
  inverse: Patch[];
}

/** `state.definitionId` frozen alongside — editing the card mid-session must not reach in here. */
export interface PlaySession {
  definition: GameDefinition;
  state: PlayState;
  log: LogEntry[];
  history: HistoryFrame[];
}

interface SessionStore {
  session: PlaySession | null;
  startSession(def: GameDefinition, seed: string): void;
  /** Runs one full transaction (§3.3) and appends exactly one log entry + history frame. */
  dispatch(action: PlayAction, override?: boolean): void;
  /** Keep first `length` entries; undo everything after via stored inverse patches. No redo. */
  rewind(length: number): void;
}

function describeCause(action: PlayAction): LogEntry['cause'] {
  // v2 §4.10, §6.2 — `visibility` defaults to public; `submitSealed` is the one cause that names a
  // seat's own private choice (`action.optionId`) directly in its description, so it is the one case
  // restricted to the submitter alone. Everything else here names ids/state, not secret choices.
  switch (action.kind) {
    case 'start':
      return { kind: 'userAction', description: 'Start game', seat: null, visibility: null };
    case 'moveCard':
      return { kind: 'userAction', description: `Move card ${action.cardId}`, seat: null, visibility: null };
    case 'flipCard':
      return { kind: 'userAction', description: `Flip card ${action.cardId}`, seat: null, visibility: null };
    case 'rotateCard':
      return { kind: 'userAction', description: `Rotate card ${action.cardId}`, seat: null, visibility: null };
    case 'transition':
      return { kind: 'userAction', description: `Transition to ${action.toStateId}`, seat: null, visibility: null };
    case 'fireEvent':
      return { kind: 'userAction', description: `Fire event "${action.name}"`, seat: action.seat, visibility: null };
    case 'answerPrompt':
      return { kind: 'userAction', description: 'Answer prompt', seat: null, visibility: null };
    case 'cancelPrompt':
      return { kind: 'userAction', description: 'Cancel prompt', seat: null, visibility: null };
    // v2 §4.12 — STUB. dispatch.ts rejects every one of these outright (nothing in this wave raises
    // the interaction they answer, or runs the primitive they drive), but the cause line is still
    // written for the log entry that rejection produces — see the step named in each case there.
    case 'activate':
      return { kind: 'userAction', description: `Activate rule ${action.ruleId}`, seat: action.seat, visibility: null };
    case 'passPriority':
      return { kind: 'userAction', description: 'Pass priority', seat: null, visibility: null };
    case 'answerOption':
      return { kind: 'userAction', description: `Answer option ${action.optionId}`, seat: null, visibility: null };
    case 'answerNumber':
      return { kind: 'userAction', description: `Answer number ${action.value}`, seat: null, visibility: null };
    case 'answerSeat':
      return { kind: 'userAction', description: `Answer seat ${action.seat}`, seat: null, visibility: null };
    // v2 §5.11 rule 2 — this description names the SUBMITTER'S OWN CHOICE (`action.optionId`)
    // before the reveal. Restricting it to the submitting seat is what makes that fact true of the
    // cause too, not just of the (already-empty, per rule 1) lines array.
    case 'submitSealed':
      return {
        kind: 'userAction',
        description: `Submit sealed choice ${action.optionId}`,
        seat: action.seat,
        visibility: [action.seat],
      };
  }
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  session: null,

  startSession(def, seed) {
    // ponytail: structuredClone is enough to stop a later definition edit reaching into this
    // session — no deep-freeze, nothing here mutates it in place.
    set({
      session: {
        definition: structuredClone(def),
        state: createPlayState(def, seed),
        log: [],
        history: [],
      },
    });
  },

  dispatch(action, override = false) {
    const session = get().session;
    if (!session) return;

    const seq = session.log.length;
    const lines: LogLine[] = [];
    let result: StepResult = { done: false, suspended: false, haltedByLoopGuard: false };

    // A resume continues an already-open transaction: dispatch.ts builds the prompt's id from
    // state.logSeq when it first raises the interaction, and looks it up again by recomputing the
    // SAME formula on resume. Bumping logSeq on the resuming call would change that lookup key out
    // from under it and the answer would never match. Mirrors dispatch.ts's own
    // `if (!resuming) state.budget = ...` treatment of the budget field.
    //
    // `isResuming` rather than an inline kind test: dispatch.ts routes its AWAITING_PROMPT gate
    // through the same predicate, and a second copy of "which actions resume" here is exactly the
    // drift §3.3 puts that predicate in one file to prevent.
    const resuming = isResuming(action);
    // v2 §5.9 — read once per dispatch, not per step(): verbosity is a property of THIS transaction,
    // not of any one re-entry. `EngineInput` carries it on both arms (below) since most lines are
    // emitted during CONTINUE re-entry, not on the initiating action.
    const level = useUiStore.getState().logVerbosity;

    // The WHOLE transaction — every step() call until settlement — runs inside ONE
    // produceWithPatches. That makes each HistoryFrame a single atomic immer diff, which is what
    // makes "apply this frame's inverse patches" safe: immer's own inverse patches for one produce
    // call are guaranteed correct applied as given. Concatenating patches from several SEPARATE
    // produceWithPatches calls (one per step()) and reversing that flat list — the design doc's
    // literal skeleton — corrupts array fields that more than one step() call touched (the frame
    // arrays `state.stack` and `state.pending` above all, which every step() pushes to, pops from or
    // promotes between): reversal mangles the internal order of index-based patches from different
    // calls. Confirmed by reproduction; see the report to team-lead.
    const [next, forward, inverse] = produceWithPatches(session.state, (draft) => {
      // Also held while an interaction is set: such an action is either the resume itself (excluded
      // above) or is rejected AWAITING_PROMPT without running an effect — but it still appends a log
      // entry, so bumping logSeq would move promptIdOf() out from under the suspended effect and the
      // tester's answer would be filed under an id nothing reads.
      if (!resuming && !isSuspended(session.state)) draft.logSeq = seq;
      let input: EngineInput = { kind: 'action', action, override, level };
      for (;;) {
        result = step(draft, input, lines, session.definition);
        if (result.done) break;
        input = { kind: 'continue', level };
      }
    });

    const entry: LogEntry = {
      seq,
      cause: describeCause(action),
      lines,
      flags: {
        ...(override && { override: true }),
        ...(result.suspended && { suspended: true }),
        ...(result.haltedByLoopGuard && { haltedByLoopGuard: true }),
      },
    };

    set({
      session: {
        ...session,
        state: next,
        log: [...session.log, entry],
        history: [...session.history, { forward, inverse }],
      },
    });
  },

  rewind(length) {
    const session = get().session;
    if (!session) return;
    if (length < 0 || length > session.log.length) return;

    // Newest frame first (§5.8). Each frame is now the result of ONE produceWithPatches call
    // (see dispatch()), so its own inverse array is a single atomic immer diff — immer guarantees
    // applying it AS GIVEN reconstructs that frame's base state; no additional reversal needed or
    // safe (reversing an index-based array patch like a queue splice can corrupt it).
    let state = session.state;
    for (let i = session.history.length - 1; i >= length; i--) {
      state = applyPatches(state, session.history[i].inverse);
    }

    set({
      session: {
        ...session,
        state,
        log: session.log.slice(0, length),
        history: session.history.slice(0, length),
      },
    });
  },
}));
