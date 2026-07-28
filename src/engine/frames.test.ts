import { describe, expect, it } from 'vitest';
import { appendPending, pop, push, shiftPending, top, type NewFrame } from './frames';
import { createPlayState } from './setup';
import { empty } from '../test/fixtures';
import type { PlayState, TriggerContext } from './types';

const EMPTY_CTX: TriggerContext = {
  triggeringCardId: null,
  zoneKey: null,
  triggeringSeat: null,
  promptAnswers: {},
  sourceCardId: null,
};

/** A `settle` frame is the smallest arm of the union — use it wherever the payload is irrelevant. */
function settle(parentId: number | null = null, depth = 0, iteration = 0): NewFrame {
  return { kind: 'settle', parentId, depth, iteration };
}

function state(): PlayState {
  return createPlayState(empty, 'frames-seed');
}

describe('id assignment', () => {
  it('draws ids from nextWorkId and advances the counter', () => {
    const s = state();
    expect(s.nextWorkId).toBe(0);

    expect(push(s, settle()).id).toBe(0);
    expect(push(s, settle()).id).toBe(1);
    expect(s.nextWorkId).toBe(2);
  });

  it('shares ONE counter across stack and pending, in creation order', () => {
    const s = state();

    expect(push(s, settle()).id).toBe(0);
    expect(appendPending(s, settle()).id).toBe(1);
    expect(appendPending(s, settle()).id).toBe(2);
    expect(push(s, settle()).id).toBe(3);

    expect(s.stack.map((f) => f.id)).toEqual([0, 3]);
    expect(s.pending.map((f) => f.id)).toEqual([1, 2]);
    expect(s.nextWorkId).toBe(4);
  });

  it('continues from a non-zero nextWorkId', () => {
    const s = state();
    s.nextWorkId = 17;
    expect(push(s, settle()).id).toBe(17);
    expect(appendPending(s, settle()).id).toBe(18);
  });

  it('returns the very object that landed in the array', () => {
    const s = state();
    const pushed = push(s, settle());
    const appended = appendPending(s, settle());

    expect(s.stack[0]).toBe(pushed);
    expect(s.pending[0]).toBe(appended);
  });
});

describe('stack (LIFO)', () => {
  it('pops the most recently pushed frame', () => {
    const s = state();
    const a = push(s, settle());
    const b = push(s, settle());

    expect(pop(s)).toBe(b);
    expect(pop(s)).toBe(a);
    expect(s.stack).toEqual([]);
  });

  it('top peeks without removing', () => {
    const s = state();
    push(s, settle());
    const b = push(s, settle());

    expect(top(s)).toBe(b);
    expect(top(s)).toBe(b);
    expect(s.stack).toHaveLength(2);
  });

  it('pop and top return undefined when empty', () => {
    const s = state();
    expect(pop(s)).toBeUndefined();
    expect(top(s)).toBeUndefined();
  });
});

describe('pending (FIFO)', () => {
  it('shifts the oldest appended frame', () => {
    const s = state();
    const a = appendPending(s, settle());
    const b = appendPending(s, settle());

    expect(shiftPending(s)).toBe(a);
    expect(shiftPending(s)).toBe(b);
    expect(s.pending).toEqual([]);
  });

  it('shiftPending returns undefined when empty', () => {
    expect(shiftPending(state())).toBeUndefined();
  });
});

describe('stack and pending are independent', () => {
  it('a push leaves pending untouched and vice versa', () => {
    const s = state();

    push(s, settle());
    expect(s.pending).toEqual([]);

    appendPending(s, settle());
    expect(s.stack).toHaveLength(1);

    expect(pop(s)).toBeDefined();
    expect(s.pending).toHaveLength(1);

    expect(shiftPending(s)).toBeDefined();
    expect(s.stack).toEqual([]);
  });
});

describe('caller-supplied lineage', () => {
  it('round-trips parentId and depth exactly, including null', () => {
    const s = state();

    expect(push(s, settle(null, 0))).toMatchObject({ parentId: null, depth: 0 });
    expect(push(s, settle(0, 7))).toMatchObject({ parentId: 0, depth: 7 });
    expect(appendPending(s, settle(1, 3))).toMatchObject({ parentId: 1, depth: 3 });
  });

  it('preserves every field of a non-settle arm', () => {
    const s = state();
    const frame = push(s, {
      kind: 'event',
      name: 'onCardPlayed',
      ctx: EMPTY_CTX,
      stateId: 'main',
      bindings: [{ ruleId: 'r1', sourceCardId: 'c1', ctx: EMPTY_CTX }],
      cursor: 0,
      parentId: 4,
      depth: 2,
    });

    expect(frame).toEqual({
      kind: 'event',
      name: 'onCardPlayed',
      ctx: EMPTY_CTX,
      stateId: 'main',
      bindings: [{ ruleId: 'r1', sourceCardId: 'c1', ctx: EMPTY_CTX }],
      cursor: 0,
      parentId: 4,
      depth: 2,
      id: 0,
    });
  });
});
