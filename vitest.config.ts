import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Two projects so the Math.random trap (setup.engine.ts) applies to the engine only —
// jsdom, React and third-party libs legitimately call it. See TECHNICAL_DESIGN.md §9.
export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'engine',
          globals: true,
          include: ['src/{engine,stores,theme,test}/**/*.test.ts', 'src/*.test.ts'],
          environment: 'node',
          setupFiles: ['src/test/setup.engine.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'ui',
          globals: true,
          // `src/*.test.tsx` catches App.test.tsx / routes.test.tsx, which sit at the src root and
          // would otherwise match neither project's include and silently never run.
          include: ['src/{components,screens}/**/*.test.{ts,tsx}', 'src/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['src/test/setup.dom.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      thresholds: {
        'src/engine/**': { branches: 90, lines: 90 },
        global: { lines: 70 },
      },
    },
  },
});
