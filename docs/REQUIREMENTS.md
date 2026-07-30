# Requirements: Cardboard

- [**v1**](#requirements-cardboard-v1) — shipped. The baseline engine.
- [**v2**](#v2--reference-games-magic-the-gathering-and-vampire-the-eternal-struggle) — what it would take to author Magic: The Gathering and Vampire: The Eternal Struggle.
- [**v3**](#v3--importing-an-exported-game-into-the-editor) — importing an exported game into the editor.
- [**v4**](#v4--closing-the-residual-magic-gaps) — closing the residual gaps that still block ordinary Magic cards.

---

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

---

# v2 — Reference games: Magic: The Gathering and Vampire: The Eternal Struggle

## Why these two

v1 can express a large family of card games — anything whose play is *"a player acts, the engine
reacts, and it settles."* Neither reference game is in that family, and they fail it in different
directions, which is why both are named rather than one.

- **Magic: The Gathering** stresses the engine **vertically**. Its core loop is a stack of pending
  actions that other players may respond to before any of them resolve, and its cards continuously
  modify each other's characteristics rather than mutating them once.
- **VTES** stresses the engine **horizontally**. It seats four or five Methuselahs in a *ring* where
  every player has a distinct relationship to every other (prey, predator, cross-table), players are
  eliminated while the game continues, out-of-turn reactions are the normal case rather than the
  exception, and combat requires two players to commit hidden choices simultaneously.

Together they draw out the two assumptions v1 is built on: **one player is deciding at a time**, and
**a card's value is the number stored on it**. Everything below follows from relaxing those two.

These are named as *targets to design against*, not as content to ship. Cardboard remains a generic
authoring tool; neither game's card pool, deck-construction legality, nor rules text is in scope.

## Fidelity bar

**A designer can author roughly 90% of printed cards in either game and play a real, recognisable
game.** Not full rules compliance. The MTG Comprehensive Rules and the VEKN rulings both contain a
long tail of interactions whose correct resolution is judge trivia; that tail is an explicit non-goal
and the specific things that break are named in [v2 non-goals](#v2-non-goals) rather than left
implicit.

Where a rule is *approximable* by a general primitive plus authoring, the requirement is the
primitive — not the rule. Cardboard should not learn what a creature is.

## Revised scope

These v1 non-goals are **relaxed**:

- **Hidden information becomes real.** v1 renders every seat's hand to one screen, so there is no way
  to see the game as any single player sees it — and at five seats, no way to tell whether the game
  is even legible from a given position at the table. The engine must be able to answer *"what may
  seat N see"* as a first-class query, and the play UI must be able to present exactly one seat's
  view.
- **Five or more seats become a supported configuration**, including a defined seating order, seat
  references relative to any seat rather than only to the active player, and seats being removed
  mid-game.

These v1 non-goals **stand unchanged**: no networking, no server, no accounts, no bots, no mobile
layouts, no user artwork. Hidden information is delivered by partitioning the view inside a single
window — not by moving state to a server.

> **What seat partitioning is for, stated plainly.** The tester is one person, at one machine, in one
> window, who **moves from seat to seat as play progresses** in order to experience the game from
> each player's perspective. Partitioning is not a secrecy mechanism and is not trying to be one —
> that the same person eventually sees every seat is the exercise, not a leak.
>
> The requirement is that while the view is pinned to a seat, that seat's view is *complete and
> honest*: everything that seat may see, nothing it may not, including in the event log. That is what
> makes it possible to judge whether a card reads as strong from the seat holding it, whether a
> hidden zone leaves an interesting decision, and whether a five-seat board is legible from the
> middle of the ring. A global reveal-all view sits alongside the seat view for debugging, and moving
> between the two is a normal part of playtesting rather than a cheat.

## New core concepts

Written in the same conceptual voice as v1's core concepts. These describe **what the engine must be
able to express**; the type shapes and execution semantics belong to
[`docs/TECHNICAL_DESIGN.md`](./TECHNICAL_DESIGN.md).

### Pending Action

A **Pending Action** is a declared-but-unresolved effect: a spell on the stack, an announced VTES
action awaiting a block, a triggered ability waiting to go off. It is *addressable* — targeting
selectors and criteria can refer to it the way they refer to a card — and therefore other effects can
**counter, modify, or redirect it before it resolves**.

This is the single largest departure from v1. Today the engine's work queue is internal bookkeeping
that no authored rule can see or touch; a Pending Action is game state that rules can act on.

### Priority Window

A **Priority Window** is a defined point where the engine stops and offers seats, in a defined order,
the chance to act before resolution continues. A window closes when every seat has passed
consecutively. This generalises v1's single-seat target prompt — which pauses for exactly one player,
at exactly one point per rule — into *"pause, and poll the table."*

It is what MTG calls priority and what VTES calls the block/reaction window. **They are the same
primitive and the requirement is that the engine has one, not two.**

### Simultaneous Sealed Choice

A choice submitted by two or more seats where **no submission is visible to any other seat, or to the
log, until every named seat has submitted**, at which point all are revealed and resolve together.
Required by VTES combat, where both players choose a strike before either sees the other's. Distinct
from a Priority Window, which is strictly ordered and open.

### Value Modifier

A card's effective value becomes **base value plus the modifiers currently applying to it**, computed
when read rather than stored. This is what "creatures you control get +1/+1" requires: an effect that
is *continuously true while its source is in play*, not a one-time write.

Modifiers apply in a fixed, deterministic order — all *set-to* modifiers before all *adjust-by*
modifiers, ties broken by creation order — deliberately short of MTG's full layer system. See
[v2 non-goals](#v2-non-goals) for exactly which interactions this gets wrong.

### Attachment

A card instance may be **attached to another card instance** — an Aura or Equipment on a creature, a
Retainer or equipment on a Vampire, a blocker paired to an attacker. Attachment is a reference, not a
zone: the attached card travels with its host and can read its host's values. Destroying a host does
not automatically destroy what is attached to it; that cascade is authored, consistent with v1's
existing refusal to cascade destruction implicitly.

### Owner, Controller, and Holder

v1 conflates three things into one: *whose card is this* is answered entirely by which seat's zone
currently holds it. v2 separates them.

- **Owner** — set once when the instance is created, never changes. "Return it to its owner's hand."
- **Controller** — who currently makes decisions for it. Changes when a card is stolen, or when a
  unique card is contested. Defaults to the holding zone's seat.
- **Holder** — the zone instance the card physically sits in. This is v1's existing behaviour.

### Per-instance Characteristics

Tags become **mutable, per-instance**, seeded from the template at creation. v1's tags live on the
immutable template, so nothing can grant, remove, or change a card's properties at runtime. This is
the cheapest route to keyword abilities as a system: an effect adds a tag, and criteria and targeting
read it.

### Predicate Targeting

A targeting selector may carry a **criteria tree evaluated once per candidate card**, with a
reference bound to the card under test. "Every creature with power 3 or less that you control" is one
selector, not a bespoke effect. v1's selectors can only address a zone, a position in it, or a single
literal tag string.

### Continuous Condition

A rule that fires **whenever its condition becomes true**, re-checked to a fixpoint at the same
settled moment the state machine already scans for automatic transitions — repeating until no further
rule fires. This is what makes "a creature with lethal damage dies" and "a player at zero pool is
ousted" authorable as rules rather than as engine behaviour.

### Effect Replacement

A rule that registers against an effect **about to be applied**, and substitutes its own effects
before the original mutates anything. "If damage would be dealt, prevent it." "If you would draw,
draw two instead."

### Non-card Choice

A prompt may resolve to something other than a set of cards: a number, a seat, or one option from a
labelled list. Required by modal spells ("choose one —"), X costs, and every VTES choice that is not
about pointing at a card.

### Seating Order and Seat Elimination

The seats form an **explicit, mutable order** rather than an implicit `0..N-1` range.

- Seat references may be taken **relative to any seat**, not only to the active player — so "my
  predator" resolves correctly for a card owned by a seat whose turn it is not.
- A seat may be **eliminated while the session continues**. Elimination removes it from the seating
  order — closing the ring, so the neighbours of a removed seat become neighbours of each other — and
  makes its zones invalid as move and target destinations. This is distinct from the session
  finishing.
- A reserved, engine-maintained **active seat count** is readable by criteria, so thresholds that
  scale with table size stay correct after an elimination.

### Aggregation

A value reference across all seats may **sum** rather than compare, alongside v1's existing
`every` / `some` quantifiers. Vote tallies, total power, and "damage equal to the number of X" are
all one primitive.

### Cost-gated Activation

A rule may declare a **cost precondition checked before any of its effects run**, rejecting the whole
activation rather than aborting partway. v1 runs effects in order and stops on rejection, which means
a cost paid by an earlier effect is not refunded when a later one fails. Activation must also be
reachable **per card instance** in the play UI, not only as a global event button.

## Revised engine semantics

Marked by cost, because the difference is the whole planning story.

**Rewrite — the execution core.** The Pending Action layer, Priority Windows, and Effect Replacement
are not three features. They are three faces of one missing capability: an **addressable,
interruptible, multi-seat pending-action layer**. v1's engine is built on the opposite premise —
exactly one rule in flight at a time, one seat consulted at one point, resolution never interrupted —
and its suspension record is a flat cursor rather than a resumable stack. Supporting either reference
game's core loop means a new execution core, not an addition to the existing one. This should be
planned as a rewrite and estimated as one.

**Rewrite — the value read path.** Value Modifiers change *every site that reads a card's value* from
a stored-property lookup into a computed one, including rendering. Mechanically repetitive rather
than conceptually hard, but it is not additive: every read site changes together or the engine
reports inconsistent values.

**Rewrite — the seat model.** Seat elimination breaks the assumption that seats are a dense range,
which currently backs per-seat pools, per-seat zone instances, and the wrap-around arithmetic behind
`next` / `previous`.

**Additive.** Per-instance characteristics; predicate targeting; relative seat references; the sum
quantifier; the active seat count; attachment; owner/controller; continuous conditions evaluated at
the existing settled-state scan; non-card choices; cost-gated activation.

**Rewind granularity.** v1's rule — one log entry is one user action plus its entire cascade — holds,
with the definition of "requires input" widened to include Priority Windows. A seat that has a legal
response and passes anyway produces its own log entry and its own rewind point, because a real
decision was made. A seat with no legal response produces none, and collapses into the surrounding
cascade — otherwise a five-seat table generates four empty entries per window and the log becomes
unreadable.

## Acceptance criteria — shared primitives

- **Given** a targeting selector carrying the criteria `power > 2` against a zone, **when** the effect
  resolves, **then** only instances whose `power` exceeds 2 are targeted, and the log names the
  criteria that included or excluded each candidate.
- **Given** a card instance whose runtime tags include a tag added by an effect and absent from its
  template, **when** a criterion tests for that tag, **then** it evaluates true; and **when** the tag
  is later removed, **then** the same criterion evaluates false.
- **Given** a card attached to a host, **when** the host moves between zones, **then** the attached
  card's host reference still resolves to that host.
- **Given** a card attached to a host, **when** the host is destroyed, **then** the attached card is
  not automatically destroyed and the log records the detachment as its own change line.
- **Given** a card whose controller has been set to a seat other than the one whose zone holds it,
  **when** a criterion resolves that card's controller, **then** it resolves to the assigned
  controller, not the holding zone's seat.
- **Given** a per-player pool referenced across all seats with the `sum` quantifier, **when** it is
  used as an effect amount, **then** it resolves to one summed total rather than being rejected for
  resolving to multiple values.
- **Given** a rule with a cost precondition requiring 2 of a pool and effects that spend 2 and draw,
  **when** it is activated with only 1 available, **then** no effect runs, nothing is spent, and the
  log names the failing cost.
- **Given** the same rule with 2 available, **when** it is activated, **then** the spend and the draw
  land in one transaction, and rewinding to before the activation restores the original total exactly.
- **Given** two continuous-condition rules where the first rule's effect makes the second's condition
  newly true, **when** the engine settles, **then** both fire within the same transaction rather than
  only the first.
- **Given** an effect with two labelled modes, **when** it executes, **then** play pauses showing the
  mode labels rather than cards, no later effect in that rule has run, and the chosen branch's effects
  run in order once a mode is picked.
- **Given** a five-seat game with seat 3 eliminated, **when** a criterion resolves the seat after seat
  2, **then** it resolves to seat 4, and the active seat count reads 4 while the session's finished
  flag stays false.
- **Given** the play UI is pinned to seat 2, **when** it renders, **then** no zone hidden from seat 2
  discloses its contents, including in the event log, and switching the pinned seat requires an
  explicit action.

## Acceptance criteria — Magic: The Gathering

- **Given** a pending action on the stack and two seats, **when** it is placed, **then** every seat is
  offered priority in turn order before it resolves, and a seat with a legal response may respond,
  placing its response above the original.
- **Given** a stack of two pending actions, **when** no seat responds further, **then** the most
  recently placed resolves first.
- **Given** a pending action and an effect that counters it, **when** the counter resolves, **then**
  the countered action is removed from the stack without applying, and the log names both.
- **Given** a priority round in which no seat holds a legal response, **when** the round completes,
  **then** it collapses into the enclosing transaction with no per-seat log entry.
- **Given** a priority round in which a seat does hold a legal response and passes anyway, **when**
  the pass is recorded, **then** it produces its own log entry and rewind point.
- **Given** a static rule granting +1/+1 to a controller's creatures, **when** a new creature enters
  that zone under that controller, **then** its effective values include the bonus immediately, with
  no recalculation action required.
- **Given** one modifier setting a value and another adjusting it, **when** both apply, **then** the
  set is applied before the adjustment regardless of authoring order.
- **Given** a card returned to its owner's hand after its controller was changed, **when** the effect
  resolves, **then** it moves to the owner's hand, not the controller's.
- **Given** a continuous-condition rule eliminating a seat at zero life, **when** any effect drops that
  seat to zero, **then** the elimination fires at the next settled point and the session continues
  while other seats remain.
- **Given** a replacement rule stating that a draw by a seat draws two instead, **when** that seat
  would draw, **then** the substitution happens before any card moves, and the log distinguishes the
  replaced effect from the original.
- **Given** creatures declared as attacker and blocker via attachment, **when** damage resolves,
  **then** each assigns its power to the other and any creature meeting the lethal condition is
  destroyed by the continuous-condition rule, not by bespoke combat machinery.

## Acceptance criteria — Vampire: The Eternal Struggle

- **Given** a five-seat table, **when** a criterion resolves the predator of the seat that owns the
  triggering card, **then** it resolves relative to that seat, independent of which seat is active.
- **Given** a seat is ousted, **when** the elimination resolves, **then** it leaves the seating order,
  its former predator and prey become neighbours, and remaining seats' prey and predator references
  resolve correctly on the next reference without a restart.
- **Given** an announced action, **when** the block window opens, **then** each other seat is offered
  the chance to block in the defined order, and the window closes only after every seat has declined
  consecutively.
- **Given** a block window in which one seat blocks, **when** its effects finish, **then** resolution
  continues from the resulting combat rather than re-offering the window to seats that already
  declined.
- **Given** two seats each owing a hidden strike choice, **when** the first submits, **then** its
  choice is not visible to the other seat and does not appear in the log; and **when** the second
  submits, **then** both reveal and resolve in one transaction and one log entry.
- **Given** minion cards carrying vote values of 1, 2, and 1, **when** a referendum sums votes across
  them, **then** it evaluates to 4 and the log line names both resolved totals, not just the verdict.
- **Given** a referendum whose votes-for exceeds votes-against, **when** it resolves, **then** the
  passing branch runs; and **given** other seats added votes during the window, **then** those votes
  are included in the tally that decides it.
- **Given** an equipment card attached to a vampire, **when** an effect requires the host's discipline
  value to be at least 2, **then** it is permitted only for that specific host, not for any vampire in
  play.
- **Given** a unique card contested between two seats, **when** control is resolved to one seat,
  **then** the card's controller changes without the card changing zones.
- **Given** a four-seat and a five-seat game both authoring a threshold against the active seat count,
  **when** each session starts, **then** the threshold reflects the correct table size with no manual
  per-game configuration.
- **Given** a vampire in the uncontrolled region accumulating influence counters over successive
  turns, **when** the counters reach its capacity, **then** the authored rule moves it into the ready
  region — using existing v1 primitives, requiring no new engine capability.

## Revised constraints & dependencies

Everything in v1's constraints still holds. Added:

- **Schema migration becomes a real capability.** v1 detects a schema version mismatch and rejects the
  file. Nearly every v2 primitive changes the exported definition shape, so an actual migration path
  from v1 definitions must exist rather than a version gate that refuses them.
- **Determinism is non-negotiable and gets harder.** Priority windows, seating-order mutation, and
  modifier ordering each introduce a new place where ordering must be total and reproducible.
  Simultaneous sealed choices must resolve identically regardless of submission order.
- **Log volume needs a budget.** v1 deliberately logs every evaluated criterion leaf with no
  short-circuiting, for debuggability. Multiplied by per-candidate predicate targeting and
  fixpoint continuous-condition scanning across a wide board, this grows faster than the board does
  and needs a verbosity control.
- **Rule execution limits need genre-appropriate defaults.** v1's depth and effect ceilings are sized
  for games that settle quickly. Long legitimate response chains will trip them.
- **Authoring UX for the new concepts is not a chip in the existing rule editor.** Priority windows
  and pending-action manipulation are global structure a designer reasons about across the whole
  game, closer to the state machine — which already earned its own visual editor — than to a rule's
  effect list.

## v2 non-goals

Named explicitly so their absence is a decision rather than a bug.

- **MTG's full layer system, with dependency ordering and timestamps.** The reduced modifier model
  gets ordinary static effects right. It gets wrong: interactions where two effects' correct order
  depends on each other's outcome rather than on creation order, counter-versus-effect ordering in
  overlap cases, and characteristic-defining abilities that must evaluate before other modifiers.
  These are the famously tricky minority, and they are accepted as wrong.
- **Combat as bespoke engine machinery.** No declare-attackers phase, no damage assignment order, no
  first-strike sub-steps built into the engine. Ordinary combat is approximated with attachment for
  pairing, tags for combat state, predicate targeting for restrictions, and continuous conditions for
  death. Multi-blocker damage-ordering judgement calls are out.
- **Zone-change object identity.** MTG treats a card changing zones as a new object with no memory.
  Cardboard instances keep their identity. Cards whose text depends on that distinction will behave
  differently.
- **Legend rule / uniqueness constraints, and copy effects.** Niche relative to cost, and both
  compound badly with the reduced modifier model.
- **Deck-construction legality** for either game — crypt group adjacency, singleton limits, format
  legality. Playtest starts from an assembled deck, as in v1.
- **Real-time limits.** VTES tournament timing is table administration, not game state, and the engine
  has no clock by design.
- **Hard-coded reference-game rules.** "You may only oust your prey" is authored as a criterion over
  the seating-order primitive, not baked into the engine. Cardboard stays a generic tool; if a
  reference game's rule cannot be authored, the missing thing is a primitive, not a special case.
- **Networked play and bots** — see [Revised scope](#revised-scope). **Secrecy against the operator
  is not a non-goal so much as a non-concept**: the tester is meant to see every seat, one at a time.
  What must not happen is a seat's view disclosing what that seat may not see *while it is pinned* —
  which is a requirement, not an exclusion, and is stated as one above.

## Open questions — v2

- **Does the pending-action rewrite land as a second engine or a replacement?** Every v1 game works
  under the current core, and the rewrite is invasive. Running both is a maintenance cost; replacing
  outright risks regressing the games v1 already runs. Unresolved.
- **Is the reduced modifier model's failure mode acceptable in practice, or only on paper?** It is
  defensible per-card and may still feel wrong across a whole board. Worth revisiting once a real
  static-effect-heavy board is authored.
- **How much of VTES combat is authorable content versus a required primitive?** Simultaneous sealed
  choice is clearly a primitive. Ranges, maneuvers, presses, and torpor are believed authorable on top
  of it, but that has not been demonstrated end to end.

---

# v3 — Importing an exported game into the editor

## Why

v1 shipped export and a one-way import: a `.json` file dropped into the game list becomes a *new*
game. That covers "give me a copy of your game" and nothing else. The two things a designer actually
does with an exported file are not covered:

- **Pull a build back into the game you are already editing.** The file came from your own export an
  hour ago, or from a coauthor working on the same game. Today the only way in is a second game in
  the list with the same name, which you then have to keep straight by eye and delete by hand.
- **Get to work.** Importing lands you on the list, looking at a link you now have to click.

v3 makes an exported file a first-class way *into* the editor, on both surfaces, without changing
what a file is or what the four import gates do.

## Baseline — what already exists

Stated so v3's scope is only the delta.

| Exists | Where |
|---|---|
| Canonical export, byte-identical round trip | `engine/schema.ts` `exportJson` / `importJson` (§7.1) |
| Four import gates: JSON parse → schemaVersion → shape → referential integrity | `engine/schema.ts` `importJson` (§7.2) |
| Import a file as a new game, id collision mints a new id | `screens/GameListScreen.tsx` |
| Export from the list, and from the authoring rail | `screens/gameFile.ts`, `screens/AuthoringLayout.tsx` |
| Store-level `importDefinition(text)` | `stores/definitionStore.ts` — written, never called by a screen |

## Scope

**In scope**

- **Import → editor.** Importing from the game list opens the imported game in the editor rather
  than returning to the list.
- **Replace in place.** From inside the editor, replace the open game's whole definition with a
  file, keeping that game's `id`, its URL, and its slot in the list. Destructive, so it is confirmed.
- **Drag and drop a `.json`.** Onto the game list = import as a new game. Onto the editor = replace
  the open game. Same outcomes as the buttons on those screens, same confirmation.
- **A drop is never a navigation.** Dropping a file anywhere in the app must not make the browser
  leave the app to display that file.

**Out of scope (v3 non-goals)**

- **Selective / partial import.** No "pull just the card catalog" or "merge these three rule sets".
  Import is whole-definition, always.
- **Migration.** Only a `schemaVersion` equal to the version this build reads is accepted. v1 files
  stay unconvertible, and a newer file is still a clear rejection, not a best-effort load. Reaffirms
  TECHNICAL_DESIGN_V2 §2.3 item 6.
- **Undo of a replace.** The confirmation is the safety. No automatic backup download, no in-memory
  undo buffer.
- **Importing during a playtest.** Replace is reachable from the authoring rail only. The play screen
  has no import affordance and does not gain one.
- **Multi-file import**, folder import, import from a URL, or any server round trip.
- **Conflict resolution between two versions of the same game.** Replace is wholesale. Diffing and
  three-way merge are a different feature and not this one.

## Concepts

### Start from a template
"New game" on the list opens a chooser: a blank definition, or one of the games bundled under
`samples/` (`src/screens/templates.ts`). A template goes through the same four gates a picked file
does — it is an import whose source happens to ship with the app — but always lands under a freshly
minted id, since the same template can be started from any number of times. The created game keeps
the sample's own name; it is a starting point to edit, not a linked copy, and nothing about it stays
attached to the template afterwards.

### Import as a new game
File → four gates → a new row in the game list. The file's own `id` is kept when free, so
re-importing your own export in a second browser stays the same game; on collision a fresh id is
minted rather than overwriting an existing game. Unchanged from v1, with one addition: on success the
editor for that game opens.

### Replace in place
File → four gates → the *open* game's definition becomes the file's, except that the open game's
`id` is kept. The URL does not change, the list does not gain a row, nothing else in the browser is
touched. `updatedAt` becomes the time of the replace, because a replace is an edit to that game like
any other, not a restoration of the file's history.

### Drop target
A dragged `.json` means "do what this screen's import control does". The screen states which that is
while the drag is over the window, before the drop commits anything.

## Acceptance criteria

Ids are `IM*` and are traced by `src/test/traceability.test.ts` like every other criterion.

| Id | Criterion |
|---|---|
| **IM1** | Importing a valid file from the game list stores it and lands the browser in that game's editor (`/game/<id>/pools`), with the rail showing the imported game's name — not back on the list. |
| **IM2** | A file whose `id` matches a stored game is imported under a newly minted id; the stored game it collided with is byte-identical afterwards. |
| **IM3** | While editing game *G*, choosing a file and confirming the replace leaves the route on *G*, leaves *G*'s `id` unchanged and the list at the same number of games, and makes *G*'s name, cards, zones, decks, rules, priority windows and state machine those of the file. Re-reading *G* from IndexedDB after the replace returns the imported content, not the old content. |
| **IM4** | Replace takes two deliberate clicks. Between them the app names both the incoming file and the game that would be overwritten. Cancelling leaves the definition referentially identical and writes nothing. |
| **IM5** | A file rejected by any of the four gates changes nothing: the open game and every stored game are untouched, and the failure is reported as the list of messages `importJson` produced, field paths included. |
| **IM6** | A `.json` dropped on the game list behaves exactly as IM1. A `.json` dropped inside the editor behaves exactly as IM3/IM4, confirmation included — a drop alone never overwrites a game. |
| **IM7** | Dropping a file — of any type, on any screen — never navigates the tab away from the app. |
| **IM8** | A file whose `schemaVersion` is absent, `1`, or any value other than the one this build reads is rejected from both surfaces with a message naming the file's version and the build's. |
| **IM9** | A replace sets the game's `updatedAt` to the time of the replace; the file's own `updatedAt` does not survive into the stored game. `importJson` itself still writes no timestamp — the round trip in **P2** stays byte-identical. |
| **IM10** | While a file drag is over the window, the app states what a drop would do — "import as a new game" on the list, "replace *<game name>*" in the editor — and that affordance disappears when the drag leaves or the drop completes. |

## Inputs

A single `.json` file, chosen with a file picker or dropped on the window, containing exactly what
`exportJson` writes: one `GameDefinition`, no envelope, no metadata wrapper.

## Outputs

Either a stored game and a route change (import), or a rewritten stored game at the same id
(replace), or an unchanged browser and a list of gate errors (rejection). There is no fourth outcome.

## Constraints & dependencies

- **No new dependencies.** The picker is an `<input type="file">` like the one that already exists;
  drag and drop is the platform's HTML5 drop events. No file-drop library.
- **The gates are not reimplemented.** Both surfaces call `importJson`; a rule that holds for one
  holds for the other because it is the same function.
- **The engine does not learn about files.** Everything v3 adds lives at or above `src/screens/`.
- **Determinism rules are untouched.** Ids minted for imported games remain a browser concern, not an
  engine one.
- **Accessible without a mouse.** Drag and drop is an addition to the picker, never a replacement:
  every v3 outcome is reachable by keyboard.

## Open questions — resolved

- **Is v3 more than import?** No. v3 is this feature and ships alone.
- **Does replace keep the open game's name?** No — everything but `id` comes from the file.
- **Does a drop mean the same thing everywhere?** No, it means what the screen's own import control
  means: new game on the list, replace in the editor, always confirmed there.
- **Is there a migration path for older files?** No. Version equality, as before.

---

# v4 — Closing the residual Magic gaps

## Why

v2 named Magic: The Gathering as a reference game and built the hard machinery for it — the stack,
priority windows, replacement effects, computed card values, cost-gated activation, sealed choice.
That work shipped: all eleven [MTG acceptance criteria](#acceptance-criteria--magic-the-gathering)
are proved, and `mtgish.ts` drives them.

What v2 did *not* do is check the fidelity bar it set for itself — *"a designer can author roughly
90% of printed cards and play a real, recognisable game"* — against the actual shape of ordinary
card text. Doing that now turns up a short list of gaps that are not in the
[v2 non-goals](#v2-non-goals), are not judge trivia, and block a large fraction of perfectly
ordinary cards. Most of them are small. Two are already half-built.

The evidence is not speculative. The engine documents these gaps against itself, in the two places
someone tried to author a real game with it:

- `src/samples/holdem.ts:9-43` — the shipped Texas Hold'em sample's header, which lists six things
  it could not express. Two are general-purpose: *"no `ValueRef` folds a card index across a set of
  cards"* and *"No arithmetic on `ValueRef`s"*. The first is why the sample's showdown is judged by
  eye rather than by rule.
- `src/test/fixtures/mtgish.ts:10-13` — *"TWO PLACES this fixture could not satisfy §9.3's prose
  literally — both are gaps in the engine's addressing primitives, not shortcuts here."*
- `src/engine/continuous.ts:50-64` — *"'Each creature with lethal damage dies' is therefore only
  correct authored as a card-attached rule."*
- `src/engine/dispatch.ts:1234` — *"Nothing in this wave RAISES a `chooseSeat` interaction."*
- `src/engine/effects.ts:1171` — a `chooseMode` branch that needs a prompt *"fails `AWAITING_PROMPT`
  rather than suspending re-entrantly."*

v4 closes that list. It adds no new subsystem: every item is an arm on an existing union, or the
missing producer for a consumer that already exists.

## Fidelity bar

**Unchanged from v2.** Roughly 90% of printed cards, a real and recognisable game, not rules
compliance. v4 does not raise the bar; it removes the things standing between the current engine and
the bar v2 already claimed.

Where a rule is approximable by a general primitive plus authoring, the requirement stays the
primitive. Cardboard still does not learn what a creature is.

## Scope

**In scope** — the eight gaps below, and one sample game that proves them.

**Out of scope** — every [v2 non-goal](#v2-non-goals), restated as still closed: the full layer
system, combat as engine machinery, zone-change object identity, the legend rule, copy effects,
deck-construction legality, real-time limits, hard-coded reference-game rules, networking and bots.
Added to that list in v4:

- **Simultaneous-trigger ordering by player choice.** Triggers stay auto-ordered by v2 §5.1's fixed
  total order. No APNAP, no controller-chooses-the-order.
- **Resolution-time target legality.** Targets stay frozen at announce and are never rechecked, so
  there is no fizzling and no hexproof/protection hook.
- **Effect duration as a primitive** — see [G7](#g7-no-effect-duration) below, which is named as a
  gap and then deliberately deferred rather than solved.

## What is already sufficient

Recorded so v4 does not re-litigate it, and so the gap list below is read as short *because it is*,
not because it is incomplete.

| Magic concept | Expressed today as |
|---|---|
| The stack, LIFO and addressable | `PlayState.actionStack` + `announceAction` + `Frame{kind:'resolve'}` |
| Priority, instant speed, sorcery speed | `PriorityWindow`; `activation.window: null` is sorcery speed |
| Counterspells | `counterAction` + `PendingAction.countered` |
| Replacement effects | `RuleSet.replaces` |
| Static buffs ("creatures you control get +1/+1") | `RuleSet.modifier`, derived on every read |
| Auras and Equipment | `CardInstance.attachedTo` + `attach`/`detach` + `attachedTo`/`hostOf` |
| Control ≠ ownership | `CardInstance.owner`/`.controller` + `setController` |
| Activated abilities | `RuleSet.activation`, `perInstance` for a per-card button |
| Tapping | `CardInstance.rotated` |
| Counters of every kind | `CardIndex` integers |
| Card types, subtypes, keyword *names* | per-instance `tags` |
| Keyword *behaviour* | one shared `RuleSet`, referenced by id from many templates |
| Zones | authored `PlayZone`s — none are hard-coded |
| Mana | one integer `PointPool` per colour; costs are `changePool` effects |
| Turn structure | `StateMachine` + the reserved `activePlayer` pool |

Three things that look like gaps and are not:

- **Negation in criteria.** There is no `not` node, but every `ComparisonOp` has its inverse in the
  set, so De Morgan pushes any negation down to negated leaves. An ergonomics cost, not an
  expressiveness one.
- **Keyword abilities.** Rule sets are top-level and shared by id, so "flying" is authored once.
- **A turn/phase entity.** The state machine plus `activePlayer` is the documented way, and Hold'em's
  nine states demonstrate it at scale.

## New core concepts

### Derived Value

A `ValueRef` may be **computed from other `ValueRef`s** rather than read from exactly one place.
Two forms: arithmetic over two values, and a fold over a set of cards.

Today the value language is nine leaves and no combinators, so *"deals damage equal to the number of
creatures you control"*, *"gets +1/+0 for each Mountain"*, and *"X plus one"* have no expression at
all. This is the single most-cited gap in the codebase and the one that blocks the largest number of
ordinary cards.

A derived value is **read-only and total**: it never asks a question, never mutates, and answers
with a degraded value rather than recursing if it is asked about itself — the discipline
`modifiers.ts` already established for computed card values.

### Self Reference

A rule may refer to **the card carrying it**. Today it can refer to the card an event was about
(`triggering`), the card it is attached to (`host`), and the card under test in a predicate
(`candidate`) — but not to itself, which is what almost all printed rules text means by "this
creature". The value already exists in the engine as `TriggerContext.sourceCardId`; nothing exposes
it to authors.

### Player as a Target

A player may be **chosen** rather than derived from a fixed relationship. Today `SeatRef` offers only
structural positions — active, next, previous, the owner or controller of a card — so *"target
player"* and *"target opponent"* cannot be authored at all. The interaction that asks the question
already exists and is fully validated; no effect raises it.

### Per-object Continuous Condition

A continuous rule may arm **once per card** rather than once per source. v2's continuous rules fire
on a false→true transition keyed by the source card, which means a game-level rule with no source
fires once for the whole session. Magic's state-based actions are per-object and repeating —
*"each creature with lethal damage is destroyed"* is checked against every creature, every time.

### Interactive Cost

An activation cost may **ask a question**. Costs today are forbidden from prompting, because a
suspension commits the transaction and would publish a half-paid cost. That closes off *"sacrifice a
creature"*, *"discard a card"*, *"tap an untapped creature you control"*, and every {X} cost —
between them a large share of Magic's cost lines. The engine already solves this exact shape
elsewhere: `announceAction` freezes prompted targets across suspensions and commits only on the
final non-suspending pass.

### Suspendable Branch

A chosen mode's effects may **pause**. A `chooseMode` branch runs inline today, so a branch that
targets fails rather than prompting. Modal cards are common and most modes target, so in practice
modal-plus-targeting is unauthorable.

## The gaps, named

| Id | Gap | Evidence |
|---|---|---|
| G1 | No arithmetic in `ValueRef` | `holdem.ts:20`, `types.ts:142-178` |
| G2 | No fold of a card index across a card set | `holdem.ts:15` |
| G3 | `chooseSeat` interaction has no producer | `dispatch.ts:1234` |
| G4 | No `CardRef` for "the card carrying this rule" | `mtgish.ts:282` |
| G5 | Activation costs may not prompt | `schema.ts:503`, `activation.ts` |
| G6 | Game-level continuous rules fire once, ever | `continuous.ts:50-64` |
| G7 | No effect duration ("until end of turn") | — *deferred, see below* |
| G8 | `chooseMode` branches cannot suspend | `effects.ts:1171` |
| G9 | `CardRef{self}` can be read but **never targeted** — no `TargetSelector` consumes a `CardRef` | found by authoring `src/samples/mtg.ts`; see TECHNICAL_DESIGN_V4 §8.1 |

**G9 was discovered after this section was written**, by authoring the sample game rather than by
reading the engine — which is why it is listed here but has no v4 acceptance criterion. It is the
single largest remaining gap for Magic: "{T}: add {G}", "Sacrifice this creature:", and "this creature
gets +1/+1" are all unauthorable without it. The fix is one `TargetSelector` arm
(`{kind:'card'; card: CardRef}`) and it should lead any v5.

<a id="g7-no-effect-duration"></a>
### G7, and why it is deferred rather than solved

*"Until end of turn"* has no expression. A `modifier` lasts exactly as long as its source card sits
in an active zone; a one-shot `setCardIndex` never expires. Every combat trick lands here.

It is authorable, badly: tag the affected cards, then run a cleanup rule in an end-of-turn state that
reverses the change and clears the tag — one rule per magnitude, which does not scale.

It is not solved in v4 because both clean fixes are expensive in a way the others are not. A
duration field needs an engine concept of a turn, which deliberately does not exist. A floating
modifier list materialized into `PlayState` contradicts TECHNICAL_DESIGN_V2 §5.4's central decision
that modifiers are *derived, never materialized* — the decision that removed a whole class of
forgotten-teardown bugs. Reopening it is a design question, not an implementation task, and it is
recorded here as an open question rather than a requirement.

## Acceptance criteria

Ids continue the existing series and are traced by `src/test/traceability.test.ts` like every other
criterion.

| Id | Criterion |
|---|---|
| **SP13** | **Given** a criterion comparing a nested arithmetic value against a literal, **when** it is evaluated, **then** it resolves the whole expression to one number; and **given** either operand is a boolean, **then** it is rejected as `TYPE_MISMATCH` rather than coerced. |
| **SP14** | **Given** a board of five cards of which three match a predicate, **when** a `countMatching` value is read, **then** it resolves to 3; and **when** a `sumIndex` value over the same set is read, **then** the total includes every modifier currently applying, not the stored base values. |
| **SP15** | **Given** a rule attached to a card, **when** it refers to itself, **then** the reference resolves to that card instance and not to the card an event was about; and **given** the same reference in a game-level rule, **then** it fails `UNBOUND_REF`. |
| **SP16** | **Given** an effect that asks a player to choose a player, **when** it runs, **then** the session suspends on a seat choice; and **when** the choice is answered, **then** a later effect in the same rule resolves its seat reference to the chosen seat. |
| **SP17** | **Given** one per-object continuous rule and two creatures, **when** the first meets the condition and is dealt with, and later the second meets it, **then** the rule fires again for the second — and **given** neither has changed, **then** it does not fire repeatedly for the same card. |
| **SP18** | **Given** an activation whose cost requires choosing a card to discard, **when** it is activated, **then** the session suspends before anything is spent; **when** the choice is answered, **then** the whole cost applies in one transaction; and **when** the choice is cancelled, **then** nothing is spent and no card moved. |
| **SP19** | **Given** a modal effect one of whose modes targets, **when** that mode is chosen, **then** the session suspends for the target choice and resumes into the rest of that mode's effects in order, rather than failing. |
| **MTG12** | **Given** the shipped Magic sample, **when** it is imported and played, **then** a turn completes: a land is played under a once-per-turn limit, a creature is cast through the stack, a burn spell targets a chosen player, and a "for each" spell reads a count off the board. |

## Constraints & dependencies

- **No `SCHEMA_VERSION` bump.** Every v4 change is an added union arm or an added optional field.
  Existing v2 files keep parsing unchanged, and `src/test/fixtures/parity-baseline.v1.json` keeps
  round-tripping byte-identically. A file that *uses* a v4 arm is simply not readable by a v2 build,
  which is the same one-way situation every prior version had and needs no new machinery.
- **The zod mirror is the export format.** Declaration order in `schema.ts` is key order in the
  exported file, so new fields append rather than insert.
- **Determinism is untouched.** Nothing in v4 introduces a new ordering. The one new fold
  (`sumIndex`) sums over a selector result that is already resolved in a defined order.
- **No new dependencies.**
- **Every new arm must render.** `prose.ts` has an arm per kind and an exhaustiveness test; a missing
  arm renders a card face blank rather than failing loudly, which is why the test exists.
- **Reference-walking must keep up.** `definitionStore.ts`'s `walkRefs`/`findReferrers` must learn
  every new reference kind, or deleting a pool or index stops being safe.

## Open questions — v4

- **Does G7 (effect duration) justify materializing modifiers?** Recorded above as deferred. It is
  the one v4 gap with no cheap answer, and the answer changes TECHNICAL_DESIGN_V2 §5.4 rather than
  extending it.
- **Does the reduced modifier model survive a static-heavy board?** Inherited unresolved from v2, and
  the Magic sample in MTG12 is the first board with enough static effects on it to find out.
- **Is per-object continuous scanning affordable at real board sizes?** v2 left the cost of derived
  modifiers explicitly unmeasured. G6 multiplies the settle-time scan by the number of candidate
  cards, which is the first change in this engine with a plausible performance ceiling.
