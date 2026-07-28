import type { Interaction, PlayAction } from '../../engine/types';

/**
 * Step 36 — the priority bar (§6.5 "The priority bar"). Contrast with `PromptBar`: there the table
 * is the picker and the bar only narrates; here the choices are RULES, not things on the table, so
 * the bar **is** the picker. One button per `interaction.legal[]` entry, labelled from its
 * `activation.label`, plus `[Pass]`.
 *
 * `legal` is non-empty by construction (§4.9/§5.5's auto-pass never raises for an empty set), so
 * there is no empty state to render, and the UI does no legality filtering of its own — every entry
 * here is already legal.
 *
 * No Cancel, and `Esc` is deliberately wired to nothing: passing IS the abort path, and §5.5
 * requires a pass to get its own log entry and rewind point, which a silent Esc would skip. This is
 * a deliberate break from the habit `PromptBar` trained, so `[Pass]` is spelled out in full.
 */
export function PriorityBar({
  interaction,
  dispatch,
}: {
  interaction: Extract<Interaction, { kind: 'priority' }>;
  dispatch: (action: PlayAction) => void;
}) {
  return (
    <div className="cb-prompt-bar" role="status">
      <span aria-hidden="true">⚑</span>
      <strong>Priority — you may respond</strong>
      {interaction.legal.map((entry, i) => (
        // `cardId` is `null` for a rule with no per-instance source (§4.9) — `i` alone would still be
        // unique, but pairing it with `ruleId` keeps the key stable if the list is ever reordered.
        <button
          key={`${entry.ruleId}:${entry.cardId ?? i}`}
          type="button"
          className="cb-btn"
          onClick={() =>
            dispatch({ kind: 'activate', ruleId: entry.ruleId, cardId: entry.cardId, seat: interaction.seat })
          }
        >
          {entry.label}
        </button>
      ))}
      <button
        type="button"
        className="cb-btn"
        data-variant="ghost"
        onClick={() => dispatch({ kind: 'passPriority' })}
      >
        Pass
      </button>
    </div>
  );
}
