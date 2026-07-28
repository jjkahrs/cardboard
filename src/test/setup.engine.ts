// Belt and braces with the lint rule in §3.2: lint catches paths tests never reach,
// this trap catches paths lint cannot see through. TECHNICAL_DESIGN.md §9.3.
Object.defineProperty(Math, 'random', {
  configurable: true,
  value: () => {
    throw new Error('Math.random() called during an engine test — use src/engine/rng.ts');
  },
});
