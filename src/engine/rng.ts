/**
 * Counter-based PRNG. TECHNICAL_DESIGN.md §3.6.
 *
 * NEVER stateful — no class, no closure holding a cursor. `seed` and `rngCursor` are fields of
 * `PlayState` and every draw advances the cursor inside an immer produce, so a stateful generator
 * (`new Rng(seed)`) would sit outside the patch stream and desync on the first rewind. `random` is a
 * pure function of (seedHash, cursor): same inputs, same output, forever.
 */

/** xmur3 string hash, run once. Turns an arbitrary seed string into a 32-bit hash. */
export function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/** splitmix32(seedHash ^ cursor) -> [0, 1). Pure — no shared state, safe to call in any order. */
export function random(seedHash: number, cursor: number): number {
  let a = (seedHash ^ cursor) >>> 0;
  a = (a + 0x9e3779b9) >>> 0;
  let t = a ^ (a >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t = t ^ (t >>> 15);
  t = Math.imul(t, 0x735a2d97);
  t = t ^ (t >>> 15);
  return (t >>> 0) / 4294967296;
}

/** Integer in [0, maxExclusive). Exported so callers/tests can hit it directly. */
export function randomInt(seedHash: number, cursor: number, maxExclusive: number): number {
  return Math.floor(random(seedHash, cursor) * maxExclusive);
}

/**
 * The Fisher-Yates core, decoupled from the cursor-advancing draw. `draw` returns a value in
 * [0, 1) per swap, same contract as `random`. Exported as a seam so tests can inject a stub
 * (e.g. one that always returns 0) and assert the algorithm's SHAPE, not just its output.
 */
export function shuffleWith<T>(items: T[], draw: () => number): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(draw() * (i + 1));
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}

/** Unbiased Fisher-Yates. Does not mutate `items`. Returns the advanced cursor to store back. */
export function shuffle<T>(
  items: T[],
  seedHash: number,
  cursor: number
): { items: T[]; cursor: number } {
  let c = cursor;
  const shuffled = shuffleWith(items, () => random(seedHash, c++));
  return { items: shuffled, cursor: c };
}
