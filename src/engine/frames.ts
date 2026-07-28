/**
 * The continuation stack and the pending-event queue — §3.2, §4.7.
 *
 * Frame bookkeeping ONLY. This file knows nothing about rules, effects, criteria, the game
 * definition, logging, or budgets; it just moves `Frame`s in and out of two arrays and hands out
 * deterministic ids. Dispatch logic lives in `dispatch.ts`.
 *
 * Every function mutates the immer draft in place, like the rest of the engine.
 */

import type { Frame, PlayState } from './types';

/** Distributes over the union — a plain `Omit<Frame,'id'>` collapses it to the common keys. */
export type NewFrame = Frame extends infer T ? (T extends Frame ? Omit<T, 'id'> : never) : never;

/**
 * `id` comes from `state.nextWorkId++` and nothing else — deterministic, part of the rewound
 * domain, and drawn from ONE counter shared by both arrays (v1's `enqueue`/`enqueueFront`
 * discipline, preserved exactly). Ids are therefore in creation order across `stack` and `pending`
 * alike, not per-array.
 *
 * `parentId` and `depth` are always supplied by the caller and NEVER inferred here: the rules
 * differ per call site (an `event` frame's child `rule` frames keep the SAME depth, while a fired
 * event is `depth + 1`), so a guess made in this file would be wrong for half the callers.
 */
function assignId(state: PlayState, frame: NewFrame): Frame {
  return { ...frame, id: state.nextWorkId++ } as Frame;
}

/** Push onto the LIFO stack. Assigns `id` from `state.nextWorkId++`. Returns the created frame. */
export function push(state: PlayState, frame: NewFrame): Frame {
  const created = assignId(state, frame);
  state.stack.push(created);
  return created;
}

/** Remove and return the top frame. */
export function pop(state: PlayState): Frame | undefined {
  return state.stack.pop();
}

/** The top frame without removing it. */
export function top(state: PlayState): Frame | undefined {
  return state.stack[state.stack.length - 1];
}

/** Append to the FIFO `pending` queue — where fired events go (§3.2). Same id discipline. */
export function appendPending(state: PlayState, frame: NewFrame): Frame {
  const created = assignId(state, frame);
  state.pending.push(created);
  return created;
}

/** Take the oldest pending frame. */
export function shiftPending(state: PlayState): Frame | undefined {
  return state.pending.shift();
}
