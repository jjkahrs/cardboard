import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `.claude/worktrees` holds transient agent worktrees — checkouts of this same repo, not source.
  // Linting them double-reports every file, and the nested path misses the `src/test/**` override
  // below, so identical code lints clean at the root and errors inside a worktree.
  { ignores: ['dist', 'coverage', '.claude'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Every exhaustive `switch` in the engine groups the no-op kinds and annotates WHY each one is
      // a no-op (see `walkSeatRef`/`walkCardRef` in definitionStore.ts). `no-fallthrough` exempts
      // empty cases by default but NOT ones with a comment between the labels, so the house style
      // was an error and the fix would have been to delete the comments. The rule still reports the
      // bug it exists for — a case with statements falling into the next one.
      'no-fallthrough': ['error', { allowEmptyCase: true }],
    },
  },

  // The engine boundary is lint-enforced, not conventional. TECHNICAL_DESIGN.md §3.2
  {
    files: ['src/engine/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['react', 'react-*', 'zustand*', 'immer', '../stores/*', '../components/*'] },
      ],
    },
  },

  {
    files: ['src/engine/**', 'src/stores/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use the seeded PRNG (src/engine/rng.ts). Math.random breaks replay and rewind.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'crypto', message: 'crypto.randomUUID is nondeterministic — use the seeded id counter.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Date.now breaks byte-identical export — inject a clock if you truly need time.',
        },
      ],
    },
  },

  // Tests legitimately stub Date.now / crypto to assert they are never called.
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
