/**
 * Cross-agent seam checks. Every fixture is authored in one module and validated in another;
 * these assertions are the only place the two meet, so a drift between them fails HERE rather
 * than three steps later inside a dispatch test nobody can read.
 */
import { describe, expect, it } from 'vitest';
import { ICON_CATALOG } from '../assets/icons/catalog';
import { exportJson, importJson, validateDefinition } from '../engine/schema';
import { duel } from './fixtures/duel';
import { empty } from './fixtures/empty';
import { selfLoop, mutualLoop, fanOut } from './fixtures/loop';
import { malformed } from './fixtures/malformed';

const validDefinitions = { duel, empty, selfLoop, mutualLoop, fanOut };

describe('every fixture is a schema-valid definition', () => {
  for (const [name, def] of Object.entries(validDefinitions)) {
    it(`${name} passes shape and referential validation`, () => {
      expect(validateDefinition(def)).toEqual([]);
    });

    // AC: P2 — round-trip identity, over every fixture rather than one hand-picked case.
    it(`${name} round-trips byte-identically`, () => {
      const once = exportJson(def);
      const back = importJson(once);
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      expect(exportJson(back.definition)).toBe(once);
    });
  }
});

describe('every icon a fixture names is actually in the sprite', () => {
  // The sprite ships a ~300-icon SUBSET of game-icons.net (step 17), so an id that is perfectly
  // valid upstream can still render an empty box here. Nothing else fails when that happens —
  // <use> on a missing symbol is silent. Pin new ids in scripts/gen-icons.mjs and regenerate.
  const known = new Set(ICON_CATALOG.map((icon) => icon.id));

  for (const [name, def] of Object.entries(validDefinitions)) {
    it(`${name}'s card icons all resolve`, () => {
      const used = def.templates.flatMap((t) => [t.faceIcon, ...t.indexes.map((i) => i.icon)]);
      expect(used.filter((id) => !known.has(id))).toEqual([]);
    });
  }
});

describe('malformed fixtures actually fail, at the field they claim', () => {
  for (const row of malformed) {
    it(`${row.label} is rejected naming ${row.expectedError}`, () => {
      const result = importJson(row.json);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.join('\n')).toContain(row.expectedError);
    });
  }
});
