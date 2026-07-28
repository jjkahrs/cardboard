import { useId, useState, type JSX } from 'react';
import type { Id, Interaction, PlayAction, SeatId } from '../../engine/types';
import { useUiStore } from '../../stores/uiStore';
import { PriorityBar } from './PriorityBar';
import { PromptBar } from './PromptBar';

/**
 * Step 38 — the interaction bar (§6.5–6.6). `PromptBar` is not extended (§6.5's own words): this
 * switches on `interaction.kind` and renders `PromptBar` unchanged for `chooseCards`, adding a
 * sibling surface per kind rather than growing five branches into a component that already has
 * passing tests of its own.
 *
 * The pinned-seat gate lives here, above every per-kind branch, so that answering a question a
 * seat cannot legally see is structurally unreachable rather than merely unlikely (§6.1, §6.2).
 */
export function InteractionBar({
  interaction,
  chosen,
  dispatch,
}: {
  interaction: Interaction;
  chosen: Id[];
  dispatch: (action: PlayAction) => void;
}): JSX.Element | null {
  const viewingSeat = useUiStore((s) => s.viewingSeat);
  const setViewingSeat = useUiStore((s) => s.setViewingSeat);
  const revealAll = useUiStore((s) => s.revealAll);

  // `sealed` carries `seats: SeatId[]`, not a single `seat` (§4.9) — §6.6 doesn't spell this case
  // out, so the gate is read as "pinned seat participates at all" rather than "pinned seat is THE
  // seat." Below, membership is re-checked so a participating seat still sees its own panel.
  if (interaction.kind === 'sealed') {
    if (!revealAll && !interaction.seats.includes(viewingSeat)) {
      return (
        <div className="cb-prompt-bar" role="status">
          <span aria-hidden="true">⏸</span>
          <strong>
            {Object.keys(interaction.submitted).length} of {interaction.seats.length} submitted.
          </strong>
          <button
            type="button"
            className="cb-btn"
            onClick={() => setViewingSeat(interaction.seats[0])}
          >
            View as P{interaction.seats[0] + 1}
          </button>
        </div>
      );
    }
  } else if (!revealAll && interaction.seat !== viewingSeat) {
    return (
      <div className="cb-prompt-bar" role="status">
        <span aria-hidden="true">⏸</span>
        <strong>P{interaction.seat + 1} must answer.</strong>
        <button
          type="button"
          className="cb-btn"
          onClick={() => setViewingSeat(interaction.seat)}
        >
          View as P{interaction.seat + 1}
        </button>
      </div>
    );
  }

  // No `default:` — a new `Interaction` kind is a compile error here (§8, `interactionSurface` in
  // `PlayScreen.tsx` is the precedent for the discipline).
  switch (interaction.kind) {
    case 'chooseCards':
      return (
        <PromptBar
          prompt={interaction}
          chosen={chosen}
          onConfirm={() => dispatch({ kind: 'answerPrompt', chosen })}
          onCancel={() => dispatch({ kind: 'cancelPrompt' })}
        />
      );

    case 'chooseOption':
      // §6.6: labels only. `option.id` is the payload and never appears on screen.
      return (
        <div className="cb-prompt-bar" role="status">
          <span aria-hidden="true">⚑</span>
          <strong>{interaction.promptText}</strong>
          {interaction.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="cb-btn"
              onClick={() => dispatch({ kind: 'answerOption', optionId: option.id })}
            >
              {option.label}
            </button>
          ))}
        </div>
      );

    case 'chooseNumber':
      return <ChooseNumberBar interaction={interaction} dispatch={dispatch} />;

    case 'chooseSeat':
      return (
        <div className="cb-prompt-bar" role="status">
          <span aria-hidden="true">⚑</span>
          <strong>{interaction.promptText}</strong>
          {interaction.candidates.map((seat) => (
            <button
              key={seat}
              type="button"
              className="cb-btn"
              onClick={() => dispatch({ kind: 'answerSeat', seat })}
            >
              P{seat + 1}
            </button>
          ))}
        </div>
      );

    case 'sealed':
      return <SealedBar interaction={interaction} viewingSeat={viewingSeat} dispatch={dispatch} />;

    case 'priority':
      // Step 36 — a rule is not a thing on the table, so the priority bar is its own picker rather
      // than reusing anything above. The pinned-seat gate already covers it (§6.5).
      return <PriorityBar interaction={interaction} dispatch={dispatch} />;
  }
}

/**
 * `<input type="number" min max>` (§6.6) — the browser's own validity handling does the
 * constraining, so `[Confirm]` just mirrors it rather than reimplementing range-checking.
 * ponytail: no stepper, no slider, per §6.6's own call ("a slider for 0–20 is worse than typing 7").
 */
function ChooseNumberBar({
  interaction,
  dispatch,
}: {
  interaction: Extract<Interaction, { kind: 'chooseNumber' }>;
  dispatch: (action: PlayAction) => void;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  const n = Number(value);
  const valid = value.trim() !== '' && Number.isInteger(n) && n >= interaction.min && n <= interaction.max;

  return (
    <div className="cb-prompt-bar" role="status">
      <span aria-hidden="true">⚑</span>
      <strong>{interaction.promptText}</strong>
      <div className="cb-field">
        <label htmlFor={id}>Choose a number</label>
        <input
          id={id}
          type="number"
          className="cb-input"
          min={interaction.min}
          max={interaction.max}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <button
        type="button"
        className="cb-btn"
        disabled={!valid}
        onClick={() => dispatch({ kind: 'answerNumber', value: n })}
      >
        Confirm
      </button>
    </div>
  );
}

/**
 * §6.6, §5.11 rule 2 — the pinned seat's own options until it submits, then a count. Another
 * seat's submitted option id is never read here: `resolveSealedSubmission` exists for exactly this
 * refusal and this component doesn't even call it, since only the pinned seat's own membership in
 * `submitted` is ever checked.
 */
function SealedBar({
  interaction,
  viewingSeat,
  dispatch,
}: {
  interaction: Extract<Interaction, { kind: 'sealed' }>;
  viewingSeat: SeatId;
  dispatch: (action: PlayAction) => void;
}) {
  const submittedCount = Object.keys(interaction.submitted).length;
  const iHaveSubmitted = viewingSeat in interaction.submitted;

  if (iHaveSubmitted) {
    return (
      <div className="cb-prompt-bar" role="status">
        <span aria-hidden="true">⚑</span>
        <strong>
          you have submitted — waiting for {interaction.seats.length - submittedCount} others
        </strong>
      </div>
    );
  }

  // No cancel (§6.6): one seat withdrawing would strand the rest of the table on a frame nobody
  // can complete.
  return (
    <div className="cb-prompt-bar" role="status">
      <span aria-hidden="true">⚑</span>
      <strong>
        {submittedCount} of {interaction.seats.length} submitted
      </strong>
      {interaction.options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="cb-btn"
          onClick={() => dispatch({ kind: 'submitSealed', seat: viewingSeat, optionId: option.id })}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
