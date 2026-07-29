/**
 * §6.4's zone-layout math. Pure functions, so the "does a 20-card hand still fit" question is
 * answerable without a browser.
 */

import { describe, expect, it } from 'vitest';
import { GRID_MAX_COLS, STACK_VISIBLE, fanTransform, gridColumns, rowOverlap, stackOffset } from './layout';

const deg = (value: string) => Number.parseFloat(value);

describe('fanTransform', () => {
  it('is symmetric about the middle of the hand', () => {
    const n = 5;
    for (let i = 0; i < n; i++) {
      expect(deg(fanTransform(i, n).rot)).toBeCloseTo(-deg(fanTransform(n - 1 - i, n).rot), 6);
    }
  });

  it('caps the step at 5° for a small hand and floors it at 2° for a large one', () => {
    // step = clamp(2, 40/n, 5): 3 cards spread wide, 30 tighten instead of wrapping round.
    expect(deg(fanTransform(2, 3).rot) - deg(fanTransform(1, 3).rot)).toBeCloseTo(5, 6);
    expect(deg(fanTransform(2, 30).rot) - deg(fanTransform(1, 30).rot)).toBeCloseTo(2, 6);
  });

  it('lifts the outer cards more than the middle, so the fan reads as one curve', () => {
    const lifts = [0, 1, 2, 3, 4].map((i) => Number.parseFloat(fanTransform(i, 5).lift));
    expect(lifts[2]).toBe(0);
    expect(lifts[0]).toBeGreaterThan(lifts[1]);
    expect(lifts[4]).toBeGreaterThan(lifts[3]);
  });

  it('leaves a single card flat', () => {
    expect(fanTransform(0, 1)).toEqual({ rot: '0deg', lift: '0px' });
  });
});

describe('stackOffset', () => {
  it('steps right and up, so the stack reads as depth', () => {
    expect(stackOffset(0)).toEqual({ x: '0px', y: '0px' });
    expect(stackOffset(2)).toEqual({ x: '4px', y: '-4px' });
  });

  it('renders three cards at most — a 40-card deck is not 40 DOM nodes', () => {
    expect(STACK_VISIBLE).toBe(3);
  });
});

describe('gridColumns', () => {
  it('is the cards it holds plus room for one more', () => {
    expect(gridColumns(0)).toBe(1);
    expect(gridColumns(3)).toBe(4);
  });

  it('caps instead of growing without bound — a big collection wraps and scrolls', () => {
    expect(gridColumns(40)).toBe(GRID_MAX_COLS);
  });
});

describe('rowOverlap', () => {
  it('does not overlap a row that comfortably fits', () => {
    expect(rowOverlap(4)).toBe('0px');
  });

  it('tightens as cards are added, and stops before they hide each other', () => {
    const fraction = (n: number) => Number.parseFloat(rowOverlap(n).replace('calc(', ''));
    expect(fraction(8)).toBeLessThan(0);
    expect(fraction(12)).toBeLessThan(fraction(8));
    expect(fraction(200)).toBeGreaterThanOrEqual(-0.55);
  });
});
