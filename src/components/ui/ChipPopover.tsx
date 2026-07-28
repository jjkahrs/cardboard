import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface ChipPopoverProps {
  /** The chip's own text — the sentence part the designer reads (§6.8). */
  label: string;
  /** Accessible name, when the label alone is ambiguous out of context ("2", "Deck"). */
  ariaLabel?: string;
  /** Points at something deleted: red + strikethrough, never colour alone (§6.8). */
  danger?: boolean;
  disabled?: boolean;
  /** Popover body. Called with `close` so a committing control can dismiss itself. */
  children: (close: () => void) => ReactNode;
}

/**
 * The inline "sentence part" control: a chip that opens a small popover (§6.8).
 *
 * A popover, never a modal — the designer has to keep reading the sentence the chip sits in, and a
 * modal both hides it and traps focus away from it.
 */
export function ChipPopover({ label, ariaLabel, danger, disabled, children }: ChipPopoverProps) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = () => {
    setOpen(false);
    // Focus goes back where it came from, or the designer is stranded at the top of the document
    // after every edit.
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <span className="cb-chip-wrap" ref={wrapper}>
      <button
        type="button"
        ref={trigger}
        className="cb-chip"
        data-danger={danger ? '1' : undefined}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <span className="cb-popover" id={panelId} role="dialog" aria-label={ariaLabel ?? label}>
          {children(close)}
        </span>
      )}
    </span>
  );
}
