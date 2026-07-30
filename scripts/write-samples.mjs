// Regenerates the bundled `samples/*.json`. The definitions are authored in TypeScript
// (`src/samples/*.ts`) and this repo has no TS runner outside vitest, so the emit lives inside the
// sample tests, gated on WRITE_SAMPLES. This wrapper exists only to set that env var portably —
// `WRITE_SAMPLES=1 npm test` is bash-only and this repo is developed on Windows.
import { spawnSync } from 'node:child_process';

const { status } = spawnSync(
  'npx',
  ['vitest', 'run', 'src/test/mtg.test.ts', 'src/test/holdem.test.ts'],
  { stdio: 'inherit', shell: true, env: { ...process.env, WRITE_SAMPLES: '1' } }
);
process.exit(status ?? 1);
