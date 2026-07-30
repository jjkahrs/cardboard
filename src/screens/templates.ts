/**
 * The games "New game" can start from, beyond a blank definition.
 *
 * A template is nothing but a bundled sample fed through the ordinary import path — `importJson`'s
 * four gates, then `putGame` — so there is no second notion of "a valid game" here and no
 * definition-construction code of its own. `GameListScreen` does that wiring; this file is only the
 * table.
 *
 * The JSON is reached through a dynamic `import(… '?raw')` so Vite code-splits it: the ~165 KB of
 * sample text is fetched when someone picks a template and never sits in the initial bundle. Both
 * files are generated from `src/samples/*.ts` by their tests, which is why `cards`/`players` are
 * declared here rather than derived — the dialog stays synchronous, and `templates.test.ts` asserts
 * the declared numbers against the real JSON so a regenerated sample cannot silently make them lie.
 */

export interface GameTemplate {
  /** Stable key for React and for tests; not shown. */
  key: string;
  /** The option's label. NOT the created game's name — that comes from the JSON itself. */
  name: string;
  blurb: string;
  cards: number;
  players: number;
  /** Raw JSON text, code-split. */
  load: () => Promise<string>;
}

export const TEMPLATES: GameTemplate[] = [
  {
    key: 'sparkbloom',
    name: 'Sparkbloom Duel',
    blurb: 'A two-seat Magic-alike: mana pools, a stack, creatures and combat.',
    cards: 12,
    players: 2,
    load: async () => (await import('../../samples/magic.json?raw')).default,
  },
  {
    key: 'holdem',
    name: 'Texas Hold’em',
    blurb: 'A six-seat poker table: blinds, betting rounds, community cards.',
    cards: 52,
    players: 6,
    load: async () => (await import('../../samples/texas-holdem.json?raw')).default,
  },
];
