/**
 * Generates the icon sprite, its catalog and its attribution from @iconify-json/game-icons.
 *
 *   npm run icons
 *
 * The package is a devDependency and is NEVER imported at runtime (§2 forbids an icon package as a
 * dependency, and AC L1 forbids downloading anything). Its output — three vendored files under
 * src/assets/icons — is what ships, and it is committed.
 *
 * Selection is by pattern, not by a hand-typed list of 300 names: a hand list silently rots when the
 * upstream set renames an icon, and every name here is resolved against the real data or the build
 * fails. PINNED names are the ones the UI itself references, so they are asserted individually.
 */

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src', 'assets', 'icons');

const data = require('@iconify-json/game-icons/icons.json');
const info = require('@iconify-json/game-icons/info.json');

/** Icons the app's own code or docs name directly. A miss here is a build failure, not a warning. */
const PINNED = [
  'broadsword', 'crossed-swords', 'shield', 'bleeding-heart', 'two-coins', 'card-draw',
  'perspective-dice-six-faces-one', 'health-potion', 'skull-crossed-bones', 'backpack', 'hourglass',
  'trophy', 'crown', 'key', 'chest', 'archery-target', 'stopwatch', 'padlock', 'swap-bag', 'cycle',
  'round-star', 'wooden-sign', 'castle', 'forest',
  // Named by the test fixtures (src/test/fixtures) and by the sample game — a card whose faceIcon
  // is not in the sprite renders an empty box, and nothing else would catch that.
  'book-cover', 'sword-clash', 'unlit-bomb',
];

/**
 * Curated spread for the picker. `limit` is per category, applied to an alphabetical sort, so the
 * same upstream version always yields the same sprite — the generated files diff cleanly.
 */
const CATEGORIES = [
  { key: 'weapons', limit: 38, match: [/sword/, /-axe$/, /^axe/, /dagger/, /spear/, /^bow/, /arrow/, /hammer/, /mace/, /crossbow/] },
  { key: 'defense', limit: 26, match: [/shield/, /helmet/, /armor/, /^barrier/, /gauntlet/, /^cuirass/] },
  { key: 'magic', limit: 26, match: [/magic/, /spell/, /wizard/, /^rune/, /^orb/, /potion/, /^wand/, /enchant/, /^scroll/] },
  { key: 'creatures', limit: 32, match: [/dragon/, /-head$/, /goblin/, /^wolf/, /spider/, /^bat-/, /zombie/, /^ghost/, /^snake/] },
  { key: 'resources', limit: 26, match: [/coin/, /^gold/, /gem/, /crystal/, /^ore/, /^wheat/, /^wood/, /^stone/, /barrel/, /^chest/] },
  { key: 'tabletop', limit: 32, match: [/^card-[a-z]/, /^dice/, /^perspective-dice/, /meeple/, /^token/, /^pawn/, /^rolling/] },
  { key: 'status', limit: 26, match: [/^heart/, /wound/, /poison/, /^stun/, /burn/, /frozen/, /^sleep/, /shield-bash/, /^blood/] },
  { key: 'actions', limit: 24, match: [/^run$/, /^jump/, /^punch/, /^throw/, /^grab/, /^move/, /^swap/, /^cycle/, /^return/, /^search/] },
  { key: 'places', limit: 24, match: [/^castle/, /tower/, /^forest/, /^cave/, /^mountain/, /village/, /^temple/, /^dungeon/, /^island/] },
  { key: 'ui', limit: 26, match: [/^round-star/, /^checkbox/, /^cancel/, /^confirmed/, /^plain-arrow/, /^lock/, /^padlock/, /^info/, /^help/, /^hourglass/, /^stopwatch/, /^trash/, /^save/, /^upgrade/, /^level-/] },
];

const TARGET_MIN = 280;
const TARGET_MAX = 340;

const available = new Set(Object.keys(data.icons));

const missingPins = PINNED.filter((n) => !available.has(n));
if (missingPins.length > 0) {
  throw new Error(
    `These pinned icons are not in @iconify-json/game-icons@${require('@iconify-json/game-icons/package.json').version}: ${missingPins.join(', ')}`
  );
}

/** name -> category, first writer wins so an icon is never listed twice. */
const chosen = new Map();
for (const name of PINNED) chosen.set(name, 'core');

for (const { key, limit, match } of CATEGORIES) {
  const hits = [...available]
    .filter((n) => !chosen.has(n) && match.some((re) => re.test(n)))
    .sort();
  for (const name of hits.slice(0, limit)) chosen.set(name, key);
}

if (chosen.size < TARGET_MIN || chosen.size > TARGET_MAX) {
  throw new Error(`Selected ${chosen.size} icons; §8 step 17 wants ~300 (${TARGET_MIN}-${TARGET_MAX}).`);
}

const GRID_W = data.width ?? 512;
const GRID_H = data.height ?? 512;

/** Humanise "skull-crossed-bones" -> "Skull crossed bones". */
const title = (name) => name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
/** Search tags: every word of the name plus the category. Numbers stay (card-10-hearts). */
const tagsFor = (name, category) => [...new Set([...name.split('-'), category])].filter(Boolean);

const entries = [...chosen.entries()].sort(([a], [b]) => a.localeCompare(b));

mkdirSync(OUT_DIR, { recursive: true });

const symbols = entries.map(([name]) => {
  const icon = data.icons[name];
  const w = icon.width ?? GRID_W;
  const h = icon.height ?? GRID_H;
  const left = icon.left ?? 0;
  const top = icon.top ?? 0;
  // hFlip/vFlip/rotate would need a wrapping <g transform>; this set uses none, so fail loudly
  // rather than emit a silently wrong glyph if that ever changes upstream.
  for (const key of ['hFlip', 'vFlip', 'rotate']) {
    if (icon[key]) throw new Error(`${name} needs an unsupported transform: ${key}`);
  }
  return `    <symbol id="gi-${name}" viewBox="${left} ${top} ${w} ${h}">${icon.body}</symbol>`;
});

const header = `/* GENERATED by scripts/gen-icons.mjs — do not edit by hand. Regenerate with \`npm run icons\`.
   Source: ${info.name} (${info.author.url}), ${info.license.title}. See ATTRIBUTION.md. */`;

writeFileSync(
  join(OUT_DIR, 'sprite.tsx'),
  `${header}

/* One <symbol> per icon, injected once by <IconSprite/>. The markup is a build-time constant from a
   vendored, licence-checked dataset — no user input reaches it — which is why the innerHTML is safe
   here and nowhere else in the app. */
export const SPRITE_MARKUP = \`
${symbols.join('\n').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}
\`;

export const SPRITE_ICON_COUNT = ${entries.length};
`,
  'utf8'
);

writeFileSync(
  join(OUT_DIR, 'catalog.ts'),
  `${header}

import type { IconId } from '../../engine/types';

export interface IconMeta {
  /** Sprite symbol id, e.g. "gi-broadsword" — what an IconId actually holds. */
  id: IconId;
  /** Human label shown under the glyph in the picker. */
  name: string;
  /** Lowercase search terms: every word of the upstream name, plus its category. */
  tags: string[];
  category: string;
}

export const ICON_CATALOG: readonly IconMeta[] = [
${entries
  .map(
    ([name, category]) =>
      `  { id: 'gi-${name}', name: ${JSON.stringify(title(name))}, tags: ${JSON.stringify(tagsFor(name, category))}, category: '${category}' },`
  )
  .join('\n')}
];
`,
  'utf8'
);

writeFileSync(
  join(OUT_DIR, 'ATTRIBUTION.md'),
  `# Icon attribution

<!-- GENERATED by scripts/gen-icons.mjs — do not edit by hand. -->

${entries.length} icons in \`sprite.tsx\` are a curated subset of **${info.name}**
(<${info.author.url}>), licensed **${info.license.title}** (${info.license.spdx}).

License text: <${info.license.url}>

CC BY 3.0 requires the attribution to travel with the work, so \`<IconPicker>\` renders this credit
line in its footer — shipping this file alone would not satisfy it.

The icons are vendored as an inlined SVG sprite. Nothing is fetched at runtime (AC: L1).
`,
  'utf8'
);

console.info(`Wrote ${entries.length} icons to src/assets/icons/{sprite.tsx,catalog.ts,ATTRIBUTION.md}`);
