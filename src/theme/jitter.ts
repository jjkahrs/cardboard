/* Deterministic per-entity tilt. TECHNICAL_DESIGN.md §6.9.
   A random rotation would visibly jump on every re-render, so this is a hash of the id (FNV-1a),
   not Math.random — which the engine/store lint rule and the engine test setup both forbid anyway.

   The returned angle goes on `.cb-card__tilt`, NEVER on the dnd-kit draggable node: dnd-kit writes
   `transform: translate3d(...)` onto that node and would clobber the rotation on drag start. */

export function jitter(id: string, scale = 1.4): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(((h >>> 0) / 0xffffffff) * 2 - 1) * scale}deg`;
}
