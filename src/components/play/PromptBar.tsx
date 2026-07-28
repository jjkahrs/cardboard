import { useEffect } from 'react';
import type { Id, Interaction } from '../../engine/types';

/**
 * The one `Interaction` arm phase 0 can raise. This bar takes the ARM, not the union: phase 3 adds
 * sibling surfaces for the other kinds (§6.6) rather than growing six branches in here.
 */
export type ChooseCardsInteraction = Extract<Interaction, { kind: 'chooseCards' }>;

/**
 * The bar that appears while the engine is suspended on a prompt (§6.7).
 *
 * It names the paused rule's question and how many legal targets there are; the cards themselves
 * are the picker (highlighted by `ZoneView`), which is why there is no list of names here. `Esc`
 * and `[Cancel]` are the same abort path (§5.4).
 */
export function PromptBar({
  prompt,
  chosen,
  onConfirm,
  onCancel,
}: {
  prompt: ChooseCardsInteraction;
  chosen: Id[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const enough = chosen.length >= prompt.min && chosen.length <= prompt.max;

  return (
    <div className="cb-prompt-bar" role="status">
      <span aria-hidden="true">⚑</span>
      <strong>{prompt.promptText}</strong>
      <span>
        P{prompt.seat + 1} chooses {prompt.min === prompt.max ? prompt.min : `${prompt.min}–${prompt.max}`} of{' '}
        {prompt.candidates.length} legal targets ({chosen.length} chosen)
      </span>
      <button type="button" className="cb-btn" disabled={!enough} onClick={onConfirm}>
        Confirm
      </button>
      <button type="button" className="cb-btn" data-variant="ghost" onClick={onCancel}>
        Cancel (Esc)
      </button>
    </div>
  );
}
