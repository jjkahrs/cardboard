# Requirements: Cardboard

- [**v1**](#requirements-cardboard-v1) — shipped. The baseline engine.
- [**v2**](#v2--reference-games-magic-the-gathering-and-vampire-the-eternal-struggle) — what it would take to author Magic: The Gathering and Vampire: The Eternal Struggle.

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
