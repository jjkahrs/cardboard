/**
 * "New zone", then "New zone 2", "New zone 3"… — a default name that is already free.
 *
 * Zone names must be unique (§4.5, enforced in `schema.ts`), so an add button that always proposed
 * "New zone" would reject its own second click. The designer renames what they just made anyway;
 * what they must never hit is a store rejection for a name they never typed.
 */
export function uniqueName(taken: readonly string[], base: string): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}
