/**
 * The positional math CSS can't express, written to inline custom properties by `ZoneView`
 * (TECHNICAL_DESIGN.md §6.4). Pure functions of (index, count) — no DOM, no measurement, so the
 * same card lands in the same place on every render and the rules are unit-testable.
 */

/** A 40-card deck must not be 40 DOM nodes: only the top three are rendered, plus a count badge. */
export const STACK_VISIBLE = 3;

/** Offset of the i-th visible card in a stack, deepest card at i = 0. */
export function stackOffset(i: number): { x: string; y: string } {
  return { x: `${i * 2}px`, y: `${i * -2}px` };
}

/**
 * Fan rotation and lift. `step` is `clamp(2, 40/n, 5)` degrees per §6.4: a 3-card hand spreads at
 * the 5° cap, a 20-card hand tightens to 2° instead of wrapping around itself.
 *
 * Lift is the arc that follows from the rotation — outer cards drop, so the fan reads as one curve
 * rather than a row of tilted cards.
 */
export function fanTransform(i: number, n: number): { rot: string; lift: string } {
  if (n <= 1) return { rot: '0deg', lift: '0px' };
  const step = Math.min(5, Math.max(2, 40 / n));
  const offset = i - (n - 1) / 2;
  return { rot: `${(offset * step).toFixed(2)}deg`, lift: `${(offset * offset * 1.6).toFixed(1)}px` };
}

/**
 * How far each card after the first slides back over its neighbour in a `row` zone, as a fraction
 * of the card width. Cards compress into a shingle instead of scrolling (§6.4).
 *
 * ponytail: a count heuristic, not §6.4's `ResizeObserver` measurement — it cannot know the zone is
 * unusually narrow or wide. Upgrade path if a row ever overflows in practice: observe the zone's
 * inline size and solve `overlap` for it; every consumer already reads `--cb-overlap`, so the swap
 * is this function's body plus the observer.
 */
/** How many cards a `grid` zone fits per row: the cards it holds plus room for one more (§6.4). */
export const GRID_MAX_COLS = 6;

/**
 * Column count for a `grid` zone. The zone is shrink-to-fit, so CSS `auto-fill` cannot count tracks
 * for itself (an indefinite width resolves every `auto-fill` repeat to 1) — the count comes from
 * here instead and the zone is exactly `n + 1` cards wide until it hits the cap and wraps.
 *
 * ponytail: a fixed cap, not a viewport measurement. Upgrade path if a wide screen should fit more:
 * solve the cap against the band's inline size; the CSS already reads whatever `--cb-cols` says.
 */
export function gridColumns(n: number): number {
  return Math.max(1, Math.min(GRID_MAX_COLS, n + 1));
}

export function rowOverlap(n: number): string {
  if (n <= 4) return '0px';
  // 5 cards -> -8%, tightening to the -55% floor around 20 cards; beyond that they'd hide each
  // other's marquee, which is worse than a scrollbar.
  const fraction = Math.min(0.55, (n - 4) * 0.035);
  return `calc(${-fraction} * var(--cb-card-w))`;
}
