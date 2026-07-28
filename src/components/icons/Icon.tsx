import type { IconId } from '../../engine/types';

export interface IconProps {
  /** Sprite symbol id, e.g. "gi-broadsword". Comes straight off a card or pool definition. */
  id: IconId;
  /**
   * Accessible name. Omit for decoration — the icon then reports as hidden, which is right whenever
   * an adjacent label already says the same thing. Passing a label makes it an image with a name.
   */
  label?: string;
  className?: string;
}

/**
 * One glyph from the sprite. Size and colour come from CSS (`.cb-icon` is 1em square,
 * `fill: currentColor`), so an icon inherits whatever type context it sits in — a pip, a button, a
 * card face at 62% width — without a size prop anywhere.
 */
export function Icon({ id, label, className }: IconProps) {
  return (
    <svg
      className={className ? `cb-icon ${className}` : 'cb-icon'}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      // SVG is focusable by default in some engines; nothing here is interactive.
      focusable="false"
      data-icon={id}
    >
      {/* The symbol carries the viewBox, so this <svg> deliberately has none. */}
      <use href={`#${id}`} />
    </svg>
  );
}
