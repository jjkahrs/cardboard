import { describe, expect, it } from 'vitest';
import { hashSeed, random, randomInt, shuffle, shuffleWith } from './rng';

describe('random', () => {
  // LOCKS THE ALGORITHM. These are the literal outputs of random(hashSeed('12345'), 0..4) as
  // produced by this implementation. Regenerate only on a deliberate schema bump — a "harmless
  // refactor" that changes these silently invalidates every seed a designer has written down.
  it('produces the golden sequence for seed 12345 (algorithm lock)', () => {
    const h = hashSeed('12345');
    expect(random(h, 0)).toBe(0.6944016311317682);
    expect(random(h, 1)).toBe(0.7892528136726469);
    expect(random(h, 2)).toBe(0.8981668858323246);
    expect(random(h, 3)).toBe(0.4642070315312594);
    expect(random(h, 4)).toBe(0.7786719230934978);
  });

  it('is a pure function: same seed+cursor -> identical output', () => {
    const h = hashSeed('same-seed');
    expect(random(h, 5)).toBe(random(h, 5));
    expect(random(h, 100)).toBe(random(h, 100));
  });

  it('different seeds diverge', () => {
    const a = hashSeed('seed-a');
    const b = hashSeed('seed-b');
    expect(random(a, 0)).not.toBe(random(b, 0));
  });

  it('cursor is restorable: reading 0..10 then re-reading 7 matches reading 7 directly', () => {
    const h = hashSeed('12345');
    const sequence: number[] = [];
    for (let cursor = 0; cursor <= 10; cursor++) sequence.push(random(h, cursor));
    expect(random(h, 7)).toBe(sequence[7]);
  });
});

describe('shuffle', () => {
  // Golden 40-element permutation of [0..39] at seed 12345, cursor 0. Same lock rationale as above.
  it('produces the golden permutation for seed 12345, cursor 0', () => {
    const h = hashSeed('12345');
    const input = Array.from({ length: 40 }, (_, i) => i);
    const { items, cursor } = shuffle(input, h, 0);
    expect(items).toEqual([
      39, 31, 37, 11, 35, 9, 15, 38, 33, 23, 4, 26, 36, 6, 3, 32, 22, 5, 0, 12, 29, 20, 24, 13, 16,
      2, 8, 21, 7, 18, 1, 25, 10, 19, 14, 28, 17, 34, 30, 27,
    ]);
    expect(cursor).toBe(39);
  });

  it('does not mutate its input array', () => {
    const input = [0, 1, 2, 3, 4];
    const snapshot = [...input];
    shuffle(input, hashSeed('12345'), 0);
    expect(input).toEqual(snapshot);
  });

  it('shuffleWith asserts the algorithm SHAPE via a stubbed draw returning 0', () => {
    // Fisher-Yates backward loop with draw() === 0 always swaps result[i] with result[0], which
    // for a 5-element array works out to a known left-rotation. This pins the algorithm's shape,
    // not just an output produced by the real generator.
    const result = shuffleWith([0, 1, 2, 3, 4], () => 0);
    expect(result).toEqual([1, 2, 3, 4, 0]);
  });

  it('uniformity smoke: 12000 shuffles of [0,1,2] land each permutation 1700-2300 times', () => {
    const counts = new Map<string, number>();
    const seedHash = hashSeed('uniformity-check');
    for (let trial = 0; trial < 12000; trial++) {
      const { items } = shuffle([0, 1, 2], seedHash, trial * 3);
      const key = items.join(',');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThanOrEqual(1700);
      expect(count).toBeLessThanOrEqual(2300);
    }
  });
});

describe('randomInt', () => {
  it('stays within [0, maxExclusive)', () => {
    const h = hashSeed('bounds-check');
    for (let cursor = 0; cursor < 1000; cursor++) {
      const n = randomInt(h, cursor, 7);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(7);
    }
  });
});
