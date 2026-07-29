# Cardboard

A tool for creating and playtesting card games. Author a game — pools, zones, cards, decks, rules,
a turn state machine — then play it and read a log of exactly why every rule fired.

Everything runs in the browser. There is no backend and no account: games are stored in the
browser's IndexedDB, and moving one between machines means exporting a `.json` file and importing it
on the other side.

## Requirements

- **Node.js 20.19+ or 22.12+** (Vite 7). Developed on Node 22.
- **npm** (ships with Node). The lockfile is `package-lock.json` — use npm, not yarn or pnpm.
- A modern browser with IndexedDB. In a private/incognito window storage may be cleared when the
  window closes, so your games go with it.

## Install

```sh
git clone <repo-url>
cd cardboard
npm install
```

That's the whole setup. There is nothing to configure, no `.env`, and no services to start.

## Run

```sh
npm run dev
```

Vite prints a local URL (`http://localhost:5173/` by default) — open it. Edits hot-reload.

To stop it, press `Ctrl+C` in that terminal.

## Other commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload. |
| `npm run build` | Typechecks (`tsc -b`) and builds to `dist/`. |
| `npm run preview` | Serves the built `dist/` locally — use it to check a production build. |
| `npm test` | Runs the whole suite once (Vitest, both the `engine` and `ui` projects). |
| `npm run test:watch` | Same suite, re-running on change. |
| `npm run coverage` | Test run with a V8 coverage report. |
| `npm run typecheck` | Types only, no build output. |
| `npm run lint` | ESLint over the repo. |
| `npm run icons` | Regenerates the vendored icon sprite (see below). |

## Deploying

`npm run build` produces a fully static `dist/` — drop it on any static host. The app uses hash
routing (`#/game/...`) precisely so it needs no SPA fallback rule on the server.

It must be served from the root of a host, not opened from `file://`: Vite emits absolute asset
paths (`/assets/…`). To host it under a subpath, or to open the build directly off disk, set `base`
in `vite.config.ts` (`base: './'` for `file://`) and rebuild.

## Notes

- **Icons are committed, not fetched.** `src/assets/icons` is generated from the
  `@iconify-json/game-icons` devDependency and checked in, so a normal install and build never
  download icon data. Run `npm run icons` only when changing which icons ship.
- **Play sessions are not persisted.** Refreshing the page during a playtest ends it; the game
  definition itself is saved continuously as you edit.
- **`samples/` holds importable games.** `samples/texas-holdem.json` is a six-seat Texas Hold'em
  table — import it from the game list. It is generated from `src/samples/holdem.ts` by
  `src/test/holdem.test.ts`, so `npm test` regenerates it; that file's header documents what the
  rules engine can and cannot enforce for poker (hand ranking and pot splitting are human-judged).
- Design docs live in `docs/` — `REQUIREMENTS.md`, `TECHNICAL_DESIGN.md`,
  `TECHNICAL_DESIGN_V2.md` (the v2 rules engine: modifiers, replacements, activations, priority
  windows), and `TECHNICAL_DESIGN_V3.md` (importing an exported game into the editor).
