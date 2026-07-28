/**
 * AC: L1 — kraft palette, marker font, and NOTHING is ever downloaded.
 *
 * §9.1 files this as a level-B (build/source) assertion, not a rendering test: the automated half of
 * "does it look hand-drawn" is the half that regresses silently — a pasted `@import url(https://…)`
 * from a font service, or a raw hex in a component stylesheet that quietly forks the palette. The
 * aesthetic half stays a human glance; no screenshot diffing in v1.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jitter } from './jitter';

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, 'src');
const THEME_DIR = join(SRC_DIR, 'theme');

const cssFiles = readdirSync(SRC_DIR, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.css'))
  .map((f) => join(SRC_DIR, f));

const read = (file: string) => readFileSync(file, 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('no external requests (AC: L1)', () => {
  it('finds at least one stylesheet to check', () => {
    // Guards the whole suite: an empty glob would make every it.each below vacuously pass.
    expect(cssFiles.length).toBeGreaterThan(0);
  });

  it.each(cssFiles.map((f) => [f.slice(ROOT.length + 1), f]))(
    '%s has no absolute http(s) url()',
    (_label, file) => {
      const offenders = [...read(file).matchAll(/url\(\s*['"]?(https?:)?\/\//gi)].map((m) => m[0]);
      expect(offenders).toEqual([]);
    }
  );

  it('index.html pulls in nothing from the network', () => {
    const html = read(join(ROOT, 'index.html'));
    const remote = [...html.matchAll(/(?:href|src)\s*=\s*['"]((?:https?:)?\/\/[^'"]*)['"]/gi)].map(
      (m) => m[1]
    );
    expect(remote).toEqual([]);
  });

  it('every @font-face src resolves to a file that exists in the repo', () => {
    // Currently vacuous by design — tokens.css documents that Shantell Sans is a fallback stack
    // only, with no vendored woff2. This is the assertion that catches the day someone vendors one
    // and points `src` at a path that isn't there (or, worse, at a CDN).
    for (const file of cssFiles) {
      for (const face of read(file).matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
        for (const src of face[1].matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
          const target = resolve(dirname(file), src[1].split('?')[0]);
          expect(existsSync(target), `${file}: @font-face src ${src[1]} does not exist`).toBe(true);
        }
      }
    }
  });
});

describe('the palette lives in exactly one file (AC: L1)', () => {
  const tokens = read(join(THEME_DIR, 'tokens.css'));

  it('defines the kraft ramp and the marker stack', () => {
    for (const shade of [50, 100, 200, 300, 400, 500, 700]) {
      expect(tokens).toMatch(new RegExp(`--cb-kraft-${shade}\\s*:`));
    }
    expect(tokens).toMatch(/--cb-font-marker\s*:/);
    expect(tokens).toMatch(/--cb-fg\s*:/);
    expect(tokens).toMatch(/--cb-bg\s*:/);
  });

  it.each(cssFiles.filter((f) => f !== join(THEME_DIR, 'tokens.css')).map((f) => [f.slice(ROOT.length + 1), f]))(
    '%s contains no raw hex colour — it must read a token',
    (_label, file) => {
      const css = stripComments(read(file)).replace(/url\(\s*['"]?#[^)]*\)/g, '');
      const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
      expect(hexes).toEqual([]);
    }
  );
});

describe('the rough filters exist for every reference (§6.9)', () => {
  const source = read(join(THEME_DIR, 'RoughFilters.tsx'));
  const declared = new Set([...source.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]));
  const referenced = new Set(
    cssFiles.flatMap((f) => [...read(f).matchAll(/url\(#(cb-rough-[a-z]+)\)/g)].map((m) => m[1]))
  );

  it('declares all three sizes', () => {
    expect([...declared].sort()).toEqual(['cb-rough-lg', 'cb-rough-md', 'cb-rough-sm']);
  });

  it('every filter id the CSS points at is declared', () => {
    // A dangling url(#id) is invisible: the browser silently drops the filter and the surface just
    // looks flat, which nobody notices until a screenshot.
    expect([...referenced].filter((id) => !declared.has(id))).toEqual([]);
  });

  it('scales roughness in user space, not bounding-box units', () => {
    // Without this a 96px thumbnail is distorted far harder than a 420px zoom (§6.9).
    expect(source).toContain('primitiveUnits="userSpaceOnUse"');
  });

  it('plain mode can switch every rough surface off from one place', () => {
    const plain = read(join(THEME_DIR, 'tokens.css')).match(
      /\[data-cb-plain="1"\]\s*\{([\s\S]*?)\}/
    );
    expect(plain).not.toBeNull();
    for (const token of ['--cb-rough', '--cb-rough-sm', '--cb-rough-lg']) {
      expect(plain![1]).toMatch(new RegExp(`${token}\\s*:\\s*none`));
    }
  });
});

describe('index.css is the only entry point', () => {
  const index = join(THEME_DIR, 'index.css');
  const imported = new Set(
    [...read(index).matchAll(/@import\s+["']\.\/([^"']+)["']/g)].map((m) => m[1])
  );

  it('imports every stylesheet in src/theme', () => {
    // The failure this catches: adding table.css in step 25 and forgetting the @import, which
    // produces an unstyled play table and no error anywhere.
    const onDisk = readdirSync(THEME_DIR).filter((f) => f.endsWith('.css') && f !== 'index.css');
    expect([...imported].sort()).toEqual(onDisk.sort());
  });

  it('loads tokens first', () => {
    // Everything downstream reads the custom properties; a later token file would still work in
    // CSS, but the ordering is the documented contract and cheap to pin.
    expect([...imported][0]).toBe('tokens.css');
  });
});

describe('jitter is a hash, never random (§6.9)', () => {
  it('returns the same angle for the same id every time', () => {
    expect(jitter('card-7')).toBe(jitter('card-7'));
  });

  it('separates different ids', () => {
    expect(jitter('card-7')).not.toBe(jitter('card-8'));
  });

  it('stays inside ±scale degrees', () => {
    for (const id of ['', 'a', 'card-7', 'a-much-longer-entity-id-000000']) {
      const deg = Number.parseFloat(jitter(id, 1.4));
      expect(Number.isFinite(deg)).toBe(true);
      expect(Math.abs(deg)).toBeLessThanOrEqual(1.4);
    }
  });

  it('scales linearly, so the sm/md/lg tokens stay proportional', () => {
    const small = Number.parseFloat(jitter('card-7', 0.6));
    const large = Number.parseFloat(jitter('card-7', 2.5));
    expect(large / small).toBeCloseTo(2.5 / 0.6, 6);
  });
});
