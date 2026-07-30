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

## Guide

A game is one **definition**: pools, cards, zones, decks, events, rules, priority windows and a
state machine. The engine runs that definition and nothing else — every move it makes is because a
rule you wrote matched, and the play log says which one, with what values, and why anything it
refused was refused.

The left rail in the editor is also a reasonable build order.

### Pools

Counters the game tracks: a player's life, a shared round number, a "first blood" flag. Each pool is
either **game**-scoped (one value) or **player**-scoped (one per seat), and holds an integer (with
optional min/max clamps) or a boolean. Every pool is offered wherever a value is picked, so pools are
what conditions and effects mostly read and write.

`activePlayer` is reserved. The engine creates and seeds it but never writes it — your rules move it
(`Change a pool` → set/add), and the play toolbar shows whose turn it currently claims to be.

### Cards

A card **template** is name, the title printed on the card, a face icon from the bundled game-icons
sprite, a border colour, tags, up to four corner **indexes**, and the rules attached to it.

- **Indexes** are the numbers and flags in the corners — attack, cost, "tapped". Each has its own
  icon, its own corner, and is an integer or boolean with a default. Rules read and write them.
- **Tags** are free strings (`creature, fire`). The template's tags seed each instance, and
  `Tag` on an instance changes only that copy.
- **Rules text** is generated from the attached rules by default; the editor will render a custom
  text instead, which changes what is printed and nothing about what the card does.

At the table each copy is an instance with its own index values, tags, face-up/rotated state, owner,
controller, and what it is attached to.

### Zones

Where cards live. A zone is **shared** or **one per player**; visible **face up**, **face down**, or
**owner only** (a hand); laid out as a **stack**, **fan**, **row** or **grid**; ordered or not; with
an optional maximum capacity that the table enforces when you drag into it.

### Decks

What is on the table before anyone acts: a list of *template × quantity* entries dealt into one zone
at start and shuffled from the session seed. A deck pointed at a player-scoped zone is dealt once per
seat.

### Events

Nine built-ins — `onGameStart`, `onGameEnd`, `onCardPlayed`, `onCardDrawn`, `onZoneEnter`,
`onZoneExit`, `onStateEnter`, `onStateExit`, `onPoolChanged` — plus any custom names you add here,
which rules trigger on and the `Fire event` effect raises. There is deliberately no `onTurnStart`:
turn structure is the state machine, and a built-in the engine never fires would be a lie in the
picker.

### Rules

The bulk of a game. A rule is **one of five kinds**, chosen on the rule itself:

| Kind | Fires when | Typical use |
| --- | --- | --- |
| **trigger** | an event fires (optionally narrowed to one state) | "when this enters play, draw a card" |
| **continuous condition** | its condition goes false → true | "when a player is at 0 life, they lose" |
| **value modifier** | never — it is re-derived on every read | "other creatures you control get +1/+1" |
| **replacement** | an effect is about to apply | "if you would draw, draw two instead" — or nothing, which prevents it |
| **activation** | the tester presses its button | an ability with a cost |

Each rule reads **WHEN / IF / THEN**, with a *READS AS* prose preview underneath so you can check
that what you assembled says what you meant.

- **IF** is a condition: nested and/or groups of comparisons. Either side of a comparison can be a
  literal, a pool, a card's index, the number of cards in a zone, whether a card has a tag, the
  number of live seats, arithmetic (`add`/`subtract`/`multiply`/`min`/`max`), or a fold over a set of
  cards (count them, or total one index across them). Null condition means "always".
- **THEN** is an ordered list of effects — draw, move, shuffle, change a pool, change a card number,
  flip, rotate, create, destroy, fire an event, go to a state, tag, attach/detach, change control,
  eliminate a player, announce/counter an action, open a priority window, and the four that ask a
  player something (choose a mode, a number, a player, or a sealed choice). Effects that stop the
  rule to ask a question are marked `⏸` in the list. `If an effect is refused` decides whether the
  rest of the rule still runs.
- **Targets** are selectors: the triggering card, the top/bottom/all/tagged cards of a zone, what is
  attached to a card or what it is attached to, `matching` (a predicate evaluated per candidate), and
  `prompt`, which wraps any other selector to make the player pick from it. `prompt(matching(…))` is
  "choose a creature with power 3 or more".
- **Priority** on a rule breaks ties — higher runs first.

Rules live in one library. Attach them to cards in the card editor, or tick **Game-level rule** to
run one from the game itself (setup, win checks). A modifier rule needs no effects at all; a
replacement with no effects is prevention.

### Priority

Priority windows are the "does anyone respond?" polls. A window says where polling starts (acting
seat / triggering seat / the action's controller), which way it goes round, whether the starting seat
is included, and how many consecutive passes close it. `Open a priority window` and
`Announce an action` open them, and an activation can be restricted to one. A seat with no legal
response passes automatically and silently. The editor previews the resulting poll order.

### States

Turns, phases, steps — whatever structure the game has. `Start` and `End` always exist. Transitions
are edited as "can go to" / "can come from" and both sides are written together, so a half-connected
edge is unrepresentable. A state with **no entry criteria** is a labelled button on the play toolbar;
a state **with** entry criteria is entered on its own as soon as they hold and nothing is mid-rule.
Priority breaks ties between two eligible transitions. Drag nodes (or use the arrow keys) to arrange
the graph; the layout is part of the definition and survives export.

### Putting one together

1. **New game** → blank, or from a bundled sample. Start from a sample if anything below sounds
   abstract — they are ordinary games with nothing privileged about them.
2. **Pools** for whatever the game counts, plus `activePlayer` handling if it has turns.
3. **Zones** — deck, hand, discard, board.
4. **Cards** — appearance and corner numbers first; rules come later.
5. **Decks** so there is something on the table at start.
6. **States** for turn structure, then a game-level `onStateEnter` rule per phase to do that phase's
   work (draw a card, pass the turn, check a win).
7. **Rules** on the cards, attached in the card editor.
8. **Play** it. The rail's badges carry a count per surface, and turn red with the reason when
   something in that surface does not validate — an invalid game refuses to start a playtest.

### Playtesting

`Play` starts a session against a snapshot of the definition, so editing in another tab cannot reach
into a running game.

- **Seed.** Same seed, same shuffle. It is shown in the toolbar with a copy button, so you can replay
  a game by typing its seed back in.
- **Viewing as / Reveal all.** Pin a seat to see the table as that seat does; reveal all overrides
  hidden zones and unredacts the log.
- **Designer override.** Turns a refusal (a full zone, an illegal transition) into a warning, flagged
  in the log.
- **Log verbosity.** *Actions* / *Rules* / *Criteria* — the last shows per-leaf criteria evaluation.
  It gates what is written, so raising it does not recover detail from earlier entries.
- **Rewind.** Every log entry is one user action plus its entire cascade, and rewinding to one
  discards everything after it. Hovering the control previews exactly what would go.
- **Moving cards.** Drag, or click a card and press the number badge on the destination (`Esc` puts
  it down). Legal destinations light up; blocked ones stay blocked unless override is on.
- **Answering.** One bar handles every kind of pause — pick cards on the table, choose an option, a
  number, a player, submit a sealed choice, or respond in a priority window. Pending actions stack in
  the right rail.
- **Activations** appear as buttons on each card carrying them, or in the toolbar for game-level
  ones, disabled with the failing cost check as the tooltip.

Play sessions are **not persisted** — refreshing ends one. The definition itself is saved
continuously as you edit.

### Files

Games live in this browser's IndexedDB. From the game list: **New** (blank or from a sample),
**Import**, **Duplicate**, **Export**, **Delete**. Inside a game, the rail has **Export game** and
**Replace** (overwrite this game from a file, keeping its slot). Dropping a `.json` file anywhere
means the same thing the current screen's button means. Import runs the same validation gates the
editor does, so a bad file changes nothing.

`samples/` holds the two games "New game" starts from, and both can equally be imported as files.
`samples/texas-holdem.json` is a six-seat Texas Hold'em table, generated from `src/samples/holdem.ts`
by `src/test/holdem.test.ts` (so `npm test` regenerates it); that file's header documents what the
engine can and cannot enforce for poker — hand ranking and pot splitting are human-judged.
`samples/magic.json` is a two-seat Magic-alike ("Sparkbloom Duel"), generated the same way from
`src/samples/mtg.ts` by `src/test/mtg.test.ts`; its header is the fullest account in the repo of
where the rule language's edges are, since every card in it sits against one.

### Known gaps

- **A game's name, player count and engine limits have no editor screen.** A blank game is
  "Untitled game" with 2 players. To change any of them, export the game, edit the JSON, and bring it
  back with **Replace**.
- **Custom events cannot be renamed**, because rules match a trigger by string equality and a rename
  would silently orphan every listener. Delete and retype the trigger on the rules the referrer count
  names.
- Some rarely-needed shapes are authorable only by hand-editing exported JSON — addressing a specific
  pending action by id is the main one.

## Notes

- **Icons are committed, not fetched.** `src/assets/icons` is generated from the
  `@iconify-json/game-icons` devDependency and checked in, so a normal install and build never
  download icon data. Run `npm run icons` only when changing which icons ship.
- Design docs live in `docs/` — `REQUIREMENTS.md`, `TECHNICAL_DESIGN.md`,
  `TECHNICAL_DESIGN_V2.md` (the v2 rules engine: modifiers, replacements, activations, priority
  windows), `TECHNICAL_DESIGN_V3.md` (importing an exported game into the editor), and
  `TECHNICAL_DESIGN_V4.md` (derived values, self reference, target player, per-object continuous
  rules, interactive costs).
