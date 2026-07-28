/**
 * The `Interaction` suspension lifecycle — §3.3, §4.9.
 *
 * Owns the ONE nullable suspension slot on `PlayState` and the rules around it: how a prompt id is
 * composed, how a suspension is set and cleared, which actions are legal while it is set, and
 * whether a proposed answer is legal. Phase 0 covers the `chooseCards` arm only, which is v1's
 * prompt behaviour relocated verbatim.
 *
 * This file knows nothing about frames, effects, targets, or dispatch. Resuming execution — putting
 * the answer where the suspended rule frame will find it — is dispatch's job, because only dispatch
 * knows what a frame is.
 *
 * `raise` and `clear` mutate the immer draft in place, like the rest of the engine. `validateAnswer`
 * is pure.
 */

import type { EffectResult, Id, Interaction, PlayAction, PlayState } from './types';

/**
 * `${logSeq}:${ruleId}:${effectIndex}` — stable and reproducible.
 *
 * The ONE definition of this formula. An effect that raises an interaction executes twice, and
 * dispatch computes the id on both the raising pass and the resuming pass; they must agree, which is
 * why this lives here rather than being inlined at two call sites that can drift apart.
 */
export function promptIdOf(state: PlayState, ruleId: Id, effectIndex: number): string {
  return `${state.logSeq}:${ruleId}:${effectIndex}`;
}

/**
 * Set the suspension.
 *
 * §3.3: the caller must not have mutated anything yet. The raising effect executes twice — once to
 * raise, once to complete — so everything it does before this call happens twice too.
 */
export function raise(state: PlayState, interaction: Interaction): void {
  state.interaction = interaction;
}

/** Clears the suspension. */
export function clear(state: PlayState): void {
  state.interaction = null;
}

/** True while any interaction is set. */
export function isSuspended(state: PlayState): boolean {
  return state.interaction !== null;
}

/**
 * The actions legal while an interaction is set; everything else is rejected with `AWAITING_PROMPT`.
 * Rewind never reaches the engine — it is the store's job (§5.10) — so it is not named here.
 *
 * v2 §4.9, §4.12, steps 28/29 — `answerOption`/`answerNumber`/`answerSeat` resume a `chooseOption`/
 * `chooseNumber`/`chooseSeat` interaction exactly as `answerPrompt` resumes `chooseCards`.
 * `submitSealed` is the odd one out: it must stay legal WHILE `interaction.kind === 'sealed'` for
 * BOTH submissions, not just the resuming one — the first submission leaves the interaction set
 * (§5.11 rule 2, the count must keep showing), so this predicate cannot distinguish "first" from
 * "second" and does not try to. `activate`/`passPriority` are deliberately NOT added here — that
 * pairing belongs to step 24's `priority` primitive, out of this wave's file ownership.
 */
export function isResuming(action: PlayAction): boolean {
  return (
    action.kind === 'answerPrompt' ||
    action.kind === 'cancelPrompt' ||
    action.kind === 'answerOption' ||
    action.kind === 'answerNumber' ||
    action.kind === 'answerSeat' ||
    action.kind === 'submitSealed'
  );
}

/**
 * Validate a card answer against the pinned interaction.
 *
 * PURE — mutates nothing, including `interaction.candidates`. Trust boundary: UI highlighting is not
 * enforcement, so the answer arrives unvetted and nothing may mutate until every check has passed.
 * Keeping this pure is what guarantees a rejected answer leaves the suspension untouched.
 */
export function validateAnswer(interaction: Interaction, chosen: Id[]): EffectResult {
  switch (interaction.kind) {
    case 'chooseCards': {
      const legal = new Set(interaction.candidates);
      const unique = new Set(chosen);
      if (unique.size !== chosen.length || chosen.some((id) => !legal.has(id))) {
        return {
          ok: false,
          reason: 'INVALID_ANSWER',
          detail: `Prompt answer invalid: selection is not a subset of the ${interaction.candidates.length} legal targets.`,
        };
      }
      if (chosen.length < interaction.min || chosen.length > interaction.max) {
        const expected =
          interaction.min === interaction.max
            ? `exactly ${interaction.min}`
            : `${interaction.min}–${interaction.max}`;
        return {
          ok: false,
          reason: 'INVALID_ANSWER',
          detail: `Prompt answer invalid: ${chosen.length} cards selected, expected ${expected}.`,
        };
      }
      return { ok: true };
    }
    // v2 §4.9 — STUB. `answerPrompt`/`chosen: Id[]` is the wrong SHAPE of answer for all five of
    // these (a chosen option id, a number, a seat, …) — their own actions (`answerOption`,
    // `answerNumber`, `answerSeat`, `passPriority`, `submitSealed`) carry the right one and get
    // their own validation when the primitive that raises the interaction lands (steps 24/28/29).
    // Reached only if `answerPrompt` is called against the wrong kind of open interaction.
    case 'chooseOption':
    case 'chooseNumber':
    case 'chooseSeat':
    case 'priority':
    case 'sealed':
      return {
        ok: false,
        reason: 'INVALID_ANSWER',
        detail: `Prompt answer invalid: a "${interaction.kind}" interaction is not answered with answerPrompt.`,
      };
  }
  // §8 structural trap: no `default:` arm and no trailing return, so a new `Interaction` arm is a
  // compile error here (TS2366) rather than a silent fall-through to "valid".
}

/**
 * Validate an `answerOption` answer — v2 §4.9, §4.12, step 28.
 *
 * PURE, same discipline as `validateAnswer`: nothing may mutate until every check passes. Only
 * `chooseOption` interactions (raised by the `chooseMode` effect) are answered this way — `priority`
 * and `sealed` have their own dedicated actions (`activate`/`passPriority`, `submitSealed`) and never
 * reach this function, matching §6.6's answer-per-kind table.
 */
export function validateOptionAnswer(interaction: Interaction, optionId: string): EffectResult {
  if (interaction.kind !== 'chooseOption') {
    return {
      ok: false,
      reason: 'INVALID_ANSWER',
      detail: `Answer invalid: a "${interaction.kind}" interaction is not answered with answerOption.`,
    };
  }
  if (!interaction.options.some((o) => o.id === optionId)) {
    return {
      ok: false,
      reason: 'INVALID_ANSWER',
      detail: `Answer invalid: "${optionId}" is not one of the ${interaction.options.length} offered options.`,
    };
  }
  return { ok: true };
}

/** Validate an `answerNumber` answer — v2 §4.9, §4.12, step 28. Bounds are `interaction.min`/`.max`. */
export function validateNumberAnswer(interaction: Interaction, value: number): EffectResult {
  if (interaction.kind !== 'chooseNumber') {
    return {
      ok: false,
      reason: 'INVALID_ANSWER',
      detail: `Answer invalid: a "${interaction.kind}" interaction is not answered with answerNumber.`,
    };
  }
  if (!Number.isInteger(value) || value < interaction.min || value > interaction.max) {
    return {
      ok: false,
      reason: 'INVALID_ANSWER',
      detail: `Answer invalid: ${value} is outside [${interaction.min}, ${interaction.max}].`,
    };
  }
  return { ok: true };
}

/**
 * Validate an `answerSeat` answer — v2 §4.9, §4.12. Nothing in this wave RAISES a `chooseSeat`
 * interaction (no effect produces one — §4.5's union has no such producer), so this is scaffolding
 * exercised only defensively today: correct machinery for a primitive step 28 does not itself add,
 * matching how `priority`/`sealed` sat unraised in earlier steps.
 */
export function validateSeatAnswer(interaction: Interaction, seat: number): EffectResult {
  if (interaction.kind !== 'chooseSeat') {
    return {
      ok: false,
      reason: 'INVALID_ANSWER',
      detail: `Answer invalid: a "${interaction.kind}" interaction is not answered with answerSeat.`,
    };
  }
  if (!interaction.candidates.includes(seat)) {
    return {
      ok: false,
      reason: 'INVALID_ANSWER',
      detail: `Answer invalid: seat ${seat} is not among the offered candidates.`,
    };
  }
  return { ok: true };
}
