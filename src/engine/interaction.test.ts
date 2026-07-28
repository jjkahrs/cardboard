import { describe, expect, it } from 'vitest';
import { clear, isResuming, isSuspended, promptIdOf, raise, validateAnswer } from './interaction';
import { createPlayState } from './setup';
import { duel } from '../test/fixtures';
import type { Interaction, PlayAction, PlayState } from './types';

function state(): PlayState {
  return createPlayState(duel, 'interaction-seed');
}

/** Real card ids from the fixture — nothing here looks them up, but nor should it have to. */
const [a, b, c] = Object.keys(state().cards);

function chooseCards(candidates: string[], min: number, max: number): Extract<Interaction, { kind: 'chooseCards' }> {
  return {
    kind: 'chooseCards',
    promptId: '0:rule_x:0',
    promptText: 'Choose a card',
    seat: 0,
    candidates,
    min,
    max,
  };
}

describe('promptIdOf', () => {
  it('composes from logSeq, ruleId and effectIndex', () => {
    const s = state();
    s.logSeq = 7;
    expect(promptIdOf(s, 'rule_draw', 2)).toBe('7:rule_draw:2');
  });

  it('is stable across two calls with the same inputs', () => {
    const s = state();
    expect(promptIdOf(s, 'rule_draw', 2)).toBe(promptIdOf(s, 'rule_draw', 2));
  });

  it('changes with logSeq — the raising and resuming passes share one transaction seq', () => {
    const s = state();
    const before = promptIdOf(s, 'rule_draw', 2);
    s.logSeq += 1;
    expect(promptIdOf(s, 'rule_draw', 2)).not.toBe(before);
  });
});

describe('raise / clear / isSuspended', () => {
  it('raise sets state.interaction and isSuspended tracks it', () => {
    const s = state();
    expect(s.interaction).toBeNull();
    expect(isSuspended(s)).toBe(false);

    const pending = chooseCards([a, b, c], 1, 1);
    raise(s, pending);

    expect(s.interaction).toEqual(pending);
    expect(isSuspended(s)).toBe(true);
  });

  it('clear nulls it', () => {
    const s = state();
    raise(s, chooseCards([a, b, c], 1, 1));
    clear(s);

    expect(s.interaction).toBeNull();
    expect(isSuspended(s)).toBe(false);
  });

  it('clear on an unsuspended state is a no-op', () => {
    const s = state();
    clear(s);
    expect(isSuspended(s)).toBe(false);
  });
});

describe('isResuming', () => {
  /**
   * Keyed by kind so the type checker forces this list to stay complete: a new `PlayAction` arm is a
   * compile error here, not a silently unexercised branch.
   */
  const ACTIONS: Record<PlayAction['kind'], PlayAction> = {
    start: { kind: 'start' },
    moveCard: {
      kind: 'moveCard',
      cardId: 'card_1',
      to: { zoneId: 'zone_hand', seat: { kind: 'seat', index: 0 } },
      position: 'top',
    },
    flipCard: { kind: 'flipCard', cardId: 'card_1', to: 'toggle' },
    rotateCard: { kind: 'rotateCard', cardId: 'card_1', to: 'toggle' },
    transition: { kind: 'transition', toStateId: 'state_end' },
    fireEvent: { kind: 'fireEvent', name: 'onDraw', seat: null },
    answerPrompt: { kind: 'answerPrompt', chosen: ['card_1'] },
    cancelPrompt: { kind: 'cancelPrompt' },
    activate: { kind: 'activate', ruleId: 'rule_x', cardId: null, seat: 0 },
    passPriority: { kind: 'passPriority' },
    answerOption: { kind: 'answerOption', optionId: 'opt' },
    answerNumber: { kind: 'answerNumber', value: 1 },
    answerSeat: { kind: 'answerSeat', seat: 0 },
    submitSealed: { kind: 'submitSealed', seat: 0, optionId: 'opt' },
  };

  // v2 §8 steps 28/29 — `answerOption`/`answerNumber`/`answerSeat`/`submitSealed` resume their own
  // interaction kinds exactly as `answerPrompt` resumes `chooseCards` (see `isResuming`'s own doc
  // comment for why `activate`/`passPriority` are deliberately NOT here — step 24, out of scope).
  const RESUMING: PlayAction['kind'][] = [
    'answerPrompt',
    'cancelPrompt',
    'answerOption',
    'answerNumber',
    'answerSeat',
    'submitSealed',
  ];

  for (const [kind, action] of Object.entries(ACTIONS)) {
    const expected = RESUMING.includes(kind as PlayAction['kind']);
    it(`is ${expected} for ${kind}`, () => {
      expect(isResuming(action)).toBe(expected);
    });
  }
});

describe('validateAnswer', () => {
  it('accepts a legal subset of the right size', () => {
    expect(validateAnswer(chooseCards([a, b, c], 2, 2), [a, c])).toEqual({ ok: true });
  });

  it('accepts an empty answer when min is 0', () => {
    expect(validateAnswer(chooseCards([a, b], 0, 2), [])).toEqual({ ok: true });
  });

  it('rejects a card that is not a candidate', () => {
    expect(validateAnswer(chooseCards([a, b], 1, 1), [c])).toEqual({
      ok: false,
      reason: 'INVALID_ANSWER',
      detail: 'Prompt answer invalid: selection is not a subset of the 2 legal targets.',
    });
  });

  it('rejects a duplicated selection even though every id is legal', () => {
    expect(validateAnswer(chooseCards([a, b, c], 2, 2), [a, a])).toEqual({
      ok: false,
      reason: 'INVALID_ANSWER',
      detail: 'Prompt answer invalid: selection is not a subset of the 3 legal targets.',
    });
  });

  it('rejects too few, with the min === max message form', () => {
    expect(validateAnswer(chooseCards([a, b, c], 2, 2), [a])).toEqual({
      ok: false,
      reason: 'INVALID_ANSWER',
      detail: 'Prompt answer invalid: 1 cards selected, expected exactly 2.',
    });
  });

  it('rejects too many, with the min !== max message form (en dash)', () => {
    expect(validateAnswer(chooseCards([a, b, c], 1, 2), [a, b, c])).toEqual({
      ok: false,
      reason: 'INVALID_ANSWER',
      detail: 'Prompt answer invalid: 3 cards selected, expected 1–2.',
    });
  });

  it('checks subset BEFORE cardinality — an illegal id wins over a wrong count', () => {
    const result = validateAnswer(chooseCards([a], 1, 1), [b, c]);
    expect(result).toEqual({
      ok: false,
      reason: 'INVALID_ANSWER',
      detail: 'Prompt answer invalid: selection is not a subset of the 1 legal targets.',
    });
  });

  it('mutates neither the interaction nor its candidates array', () => {
    const interaction = chooseCards([a, b, c], 1, 1);
    const snapshot = structuredClone(interaction);
    const candidates = interaction.candidates;

    validateAnswer(interaction, [a]);
    validateAnswer(interaction, [a, b]);
    validateAnswer(interaction, ['card_not_a_candidate']);

    expect(interaction).toEqual(snapshot);
    expect(interaction.candidates).toBe(candidates);
  });

  // v2 §4.9 — STUB. `answerPrompt`/`chosen: Id[]` is the wrong answer shape for all five; each gets
  // its own action and its own validation when the primitive that raises it lands (steps 24/28/29).
  it.each([
    ['chooseOption', { kind: 'chooseOption', promptId: 'p', promptText: 'x', seat: 0, options: [] } as Interaction],
    ['chooseNumber', { kind: 'chooseNumber', promptId: 'p', promptText: 'x', seat: 0, min: 0, max: 1 } as Interaction],
    ['chooseSeat', { kind: 'chooseSeat', promptId: 'p', promptText: 'x', seat: 0, candidates: [0, 1] } as Interaction],
    ['priority', { kind: 'priority', promptId: 'p', windowId: 'w', seat: 0, legal: [] } as Interaction],
    ['sealed', { kind: 'sealed', promptId: 'p', choiceId: 'c', seats: [0, 1], options: [], submitted: {} } as Interaction],
  ])('rejects answerPrompt against a %s interaction with INVALID_ANSWER', (kind, interaction) => {
    const result = validateAnswer(interaction, [a]);
    expect(result).toMatchObject({ ok: false, reason: 'INVALID_ANSWER' });
    expect((result as { detail: string }).detail).toContain(kind);
  });
});
