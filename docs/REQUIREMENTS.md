# Requirements: Cardboard v1

## Goal

Cardboard lets a game designer define a card game as structured data and immediately play it out in
the browser, so mechanics can be tested in minutes instead of after a print-and-cut session. v1
targets one designer at one machine iterating on their own game. The interface is skinned to look
cut from cardboard and lettered with a marker.

## Scope

**In scope**
- **Authoring:** define Point Pools, Card Templates, Play Zones, Decks, Game Events, Rule Sets, and a
  State Machine, all through forms and visual editors.
- **Playtest:** run the defined game hot-seat in one browser — the designer operates every seat. The
  engine fires events, evaluates rules, mutates state, and enforces the state machine.
- **Persistence:** working game auto-saves to IndexedDB; whole game definition exports to / imports
  from a single `.json` file.
- **Look and feel:** cardboard-and-marker theme applied across authoring and play.

**Out of scope (v1 non-goals)**
- Networked multiplayer, remote seats, lobbies, or any server.
- AI or bot opponents, automated simulation runs, batch balance testing.
- Mobile or tablet layouts and touch drag. Desktop browser only.
- Accounts, cloud sync, published game galleries. Sharing = send the exported JSON.
- User-uploaded artwork.

## Core concepts and data model

### GameValue
`{ name, type: integer | boolean, defaultValue, min, max }`. `min`/`max` apply to integers only and
clamp on write.

### Point Pool
A named GameValue with a **scope**: `Game` (one instance) or `Player` (one instance per seat).

### GameCriteria
`{ left: ValueRef, operator: = | != | > | < | >= | <=, right: ValueRef }`, where a `ValueRef` is a
point pool, a card instance Index value, a zone card-count, or a literal constant. Criteria compose
with AND / OR into a criteria group.

A ValueRef pointing at a Player-scoped pool or zone carries a seat reference: `active`, `next`,
`previous`, `triggeringSeat`, an explicit seat index, or `all`. `triggeringSeat` is the seat that
owns the card or zone that fired the event — required because `next` / `previous` are only correct
when the acting player happens to be `activePlayer`, which any out-of-turn or reaction play violates
silently.

### Card Template (Card Catalog)
Immutable definition: face icon, border color, marquee text, tag list, Index list, and RuleSets
attached to triggers. The Catalog is the set of every card that can exist in the game.

**Index** = `{ gameValue, icon, position: topLeft | topRight | bottomLeft | bottomRight }` — the pips
on a card corner.

### Card Instance
Created when a template enters play. Owns a mutable copy of the template's Index values, plus
`faceDown: bool` and `rotated: bool`. Effects may modify all three.

### Card Appearance (render order, outer to inner)
- **Border** — hand-styled edge, color from the template.
- **Marquee** — band across the top, inside the border. Card name / marquee text.
- **Face** — art area directly under the Marquee, shows the face icon.
- **Pips** — Index icons + values in the four corners, overlaying the card.
- **Tagline** — strip directly under the Face listing the card's Tags.
- **Rules** — text block at the bottom, auto-generated prose from the card's attached RuleSets, with
  an optional manual override string per card.

### Play Zone
`{ name (unique), scope: Shared | Player, visibility: faceUp | faceDown | ownerOnly, layout: stack |
fan | row | grid, ordered: bool, maxCapacity: int | null }`. Per-Player zones are instantiated once
per seat. Capacity, when set, is enforced — a move that would overflow is rejected.

### Deck
An ordered list of `(cardTemplate, quantity)` assigned to a zone as that zone's starting contents.
Instantiated and shuffled at game start.

### Game Event
A name. **Built-in events** fire automatically from the engine:
`onGameStart`, `onGameEnd`, `onCardPlayed`, `onCardDrawn`,
`onZoneEnter`, `onZoneExit`, `onStateEnter`, `onStateExit`, `onPoolChanged`.
**Custom events** are designer-defined names, fired by a `FireEvent` effect or a manual button in the
play UI.

There are deliberately no `onTurnStart` / `onTurnEnd` built-ins. Turns are authored in the State
Machine (see Open questions, resolved), so the engine has no turn concept to fire them from — a
built-in that never fires would be a lie in the event picker. A designer who wants turn events
defines them as custom events and fires them from the relevant state's `onStateEnter` /
`onStateExit`.

### Rule Set
`{ trigger: GameEvent, condition: CriteriaGroup | null, effects: Effect[] }`. Effects run in order.
A null condition always passes. Effect menu:
- Move card(s) between zones (with position: top / bottom / index).
- Draw N cards from zone A to zone B.
- Shuffle a zone.
- Add / subtract / set a Point Pool value.
- Set a card instance Index value.
- Flip / rotate a card instance.
- Create a card instance from a template into a zone.
- Destroy a card instance.
- Fire a custom Game Event.
- Force a State Machine transition.

**Targeting selectors** for card effects: the triggering card, top N of a zone, bottom N of a zone,
all cards in a zone, cards in a zone matching a Tag, or **prompt player to choose** — which pauses
rule execution and asks the tester to click a card before the remaining effects resume.

### State Machine
`State = { name, enterableFrom: State[], exitableTo: State[], entryCriteria: CriteriaGroup | null }`.
Every machine contains the special `Start` and `End` states. A transition whose criteria become true
fires automatically; a transition with no criteria appears as a labeled button in the play UI.
Reaching `End` ends the session.

## Inputs

- Designer authoring actions: form entry, icon picks from the bundled set, drag-to-arrange zones.
- Imported game `.json` files (may be malformed, from an older schema, or hand-edited).
- Playtest actions: card drags between zones, transition button clicks, custom event fires, target
  choices at a prompt, designer overrides, rewind requests.
- A shuffle seed — auto-generated per session or typed in by the tester to reproduce a past game.

## Outputs

- A persisted game definition (IndexedDB) and an exported `.json` file containing the full definition
  and schema version.
- A live play state: card instances in zones, point pool values, current state, current seat.
- A visible, append-only event log naming each event, the rules it fired, the effects applied, and
  any designer override.
- Rendered cards and zones in the cardboard theme.

## Acceptance criteria

**Authoring**
- **Given** an empty game, **when** the designer creates a Point Pool named `HP` of type integer with
  default 20 / min 0 / max 20, **then** it appears in the pool list and is selectable as a ValueRef in
  every criteria and effect editor.
- **Given** an existing zone named `Hand`, **when** the designer creates another zone named `Hand`,
  **then** the save is rejected with a "zone names must be unique" message and no zone is created.
- **Given** a Card Template with a RuleSet `onCardPlayed → draw 2 from Deck to Hand`, **when** the
  card is rendered, **then** its Rules area reads a prose summary of that effect, and editing the
  manual override replaces the generated text without altering the RuleSet.
- **Given** an integer GameValue with min 0, **when** an effect subtracts 5 from a current value of 3,
  **then** the stored value is 0, not -2.

**Persistence**
- **Given** a game edited across several sessions, **when** the browser is closed and reopened,
  **then** the game loads from IndexedDB in the state it was left.
- **Given** an exported `.json`, **when** it is imported into a fresh browser profile, **then** the
  reconstructed game is byte-identical on re-export.
- **Given** a `.json` that is malformed or fails schema validation, **when** it is imported, **then**
  the import is rejected with a message naming the failing field, and the current game is untouched.

**Playtest — setup**
- **Given** a game with player count 2 and a Per-Player zone `Hand`, **when** a playtest starts,
  **then** exactly two `Hand` zone instances exist, one per seat, and Shared zones exist once.
- **Given** a Deck of 40 cards assigned to zone `Deck` and seed `12345`, **when** two separate
  sessions start with that same seed, **then** the shuffled card order is identical in both, and the
  seed is displayed in the play UI.

**Playtest — rules engine**
- **Given** a RuleSet `onCardPlayed → opponent HP -1` and a card played from `Hand`, **when** the card
  enters the play zone, **then** the opponent's HP drops by exactly 1 and the log shows the event, the
  rule, and the resulting value change.
- **Given** an effect targeting "prompt player to choose", **when** it executes, **then** play pauses
  with the legal targets highlighted, no later effect in that RuleSet has run yet, and the remaining
  effects run in order once a target is clicked.
- **Given** a zone with `maxCapacity: 7`, **when** an effect would move an 8th card in, **then** the
  move is rejected, no card is moved, and the log records the rejection with its reason.
- **Given** a rule chain that fires an event which re-triggers itself, **when** it executes, **then**
  the engine halts the chain at a fixed depth limit and logs a "possible rule loop" error rather than
  hanging the browser.

**Playtest — state machine and enforcement**
- **Given** the current state is `Main` and `Combat` lists `Main` in `enterableFrom` with entry
  criteria `attackers > 0`, **when** `attackers` becomes 1, **then** the game transitions to `Combat`
  automatically and `onStateEnter` fires.
- **Given** a transition from `Main` to `End Turn` with no criteria, **when** the play UI renders,
  **then** a labeled button for that transition is shown and clicking it performs the transition.
- **Given** the current state is `Main` and `Untap` does not list `Main` in `enterableFrom`, **when**
  the tester attempts that transition, **then** it is blocked and the reason is shown.
- **Given** a move the engine rejects, **when** the tester enables designer override and repeats it,
  **then** the move succeeds and the log entry is flagged as an override.
- **Given** the game reaches the `End` state, **when** the transition completes, **then** the session
  is marked finished, `onGameEnd` fires, and no further play actions are accepted except rewind.

**Playtest — history**
- **Given** a session with 20 logged entries, **when** the tester rewinds to entry 12, **then** every
  zone, card instance, point pool, and the current state match their values at entry 12, and play
  continues forward from there with entries 13+ discarded.
- **Given** any state change, **when** it is applied, **then** a log entry names what changed, its old
  and new value, and the rule or manual action that caused it.

**Look and feel**
- **Given** any screen in the app, **when** it renders, **then** panels and cards use the kraft-paper
  palette with rough-edged borders and the bundled marker font, with no external font or image
  requests.
- **Given** a card in the Catalog and the same card in play, **when** both render, **then** they use
  the identical card component and appearance.

## Constraints & dependencies

- **Stack:** TypeScript, React, Vite (per `CLAUDE.md`). Desktop browser, current Chrome/Firefox/Edge.
- **No backend.** Everything runs client-side. IndexedDB for working state, File System / download +
  file input for JSON export/import.
- **Seeded RNG** — a small deterministic PRNG; the shuffle must never call `Math.random`.
- **Icons:** one bundled open-licensed SVG icon set (e.g. game-icons.net, CC BY 3.0), searchable by
  name. Attribution shipped with the app.
- **Marker font:** one bundled open-licensed webfont, self-hosted.
- **Exported JSON carries a schema version** so future versions can detect and reject or migrate.
- Rule execution depth is capped to prevent infinite trigger loops.
- Per `CLAUDE.md`: all changes tested against acceptance criteria; stop any dev server when done.

## Open questions — resolved

All three are settled. See [`docs/TECHNICAL_DESIGN.md`](./TECHNICAL_DESIGN.md) for the mechanics.

- **Turn / seat advancement.** → **Authored entirely in the State Machine.** The engine auto-creates a
  Game-scoped integer pool `activePlayer` and *never* writes it; only designer effects and transitions
  do. Turn passing is one "set activePlayer to next" effect placed wherever the designer wants. This
  is why `onTurnStart` / `onTurnEnd` no longer exist.
- **Rewind storage.** → **Immer inverse patches**, one frame per log entry. Smaller than snapshots and
  no per-effect inverse to hand-write, since Immer emits both directions from the same `produce`.
- **Icon set license and size.** → **A curated ~300-icon subset of game-icons.net** (CC BY 3.0),
  shipped as one inlined SVG sprite with attribution. The full ~4000-icon set stays available as a
  later expansion.
