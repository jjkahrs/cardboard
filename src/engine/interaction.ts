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
 */
export function isResuming(action: PlayAction): boolean {
  return action.kind === 'answerPrompt' || action.kind === 'cancelPrompt';
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
