# Technical Design: Cardboard v4 — Closing the residual Magic gaps

Implements [`REQUIREMENTS.md` § v4](./REQUIREMENTS.md#v4--closing-the-residual-magic-gaps).
Section numbers here are cited from code comments the same way v1/v2/v3 sections are.

## 1. Overview

v4 adds **no subsystem**. Every item is one of three shapes:

1. **A new arm on an existing union** — `ValueRef`, `CardRef`, `SeatRef`, `Effect`.
2. **The missing producer for a consumer that already exists** — the `chooseSeat` interaction is
   fully built and unreachable.
3. **A restriction lifted by giving an existing mechanism a second pass** — prompting costs, and
   suspendable modal branches.

That shape is what keeps v4 small. It is also what makes it dangerous in one specific way: the
engine's exhaustive `switch`es have had their `default:` arms deliberately deleted, so adding a union
arm is a *compile error in every file that must learn about it*. **`npm run typecheck` is the work
list.** Do not add a `default:` to silence it.

**No `SCHEMA_VERSION` bump.** See §3.

## 2. Context

### 2.1 Inherited unchanged

The whole v2 execution model. Nothing in v4 changes frame scheduling, binding order, the settle
fixpoint, replacement, priority windows, rewind, visibility, or determinism. In particular:

- `PlayState` gains no field except where §4.5 and §4.6 say so.
- Every sort key stays total; no new ordering is introduced.
- The engine still imports neither immer nor React (§3.2 of v1).
- Criteria evaluation still never short-circuits — the log's reason-for-every-leaf guarantee holds.

### 2.2 Touched

| File | Why |
|---|---|
| `src/engine/types.ts` | every new union arm |
| `src/engine/schema.ts` | the zod mirror; `REPLACEABLE_EFFECT_KINDS`; `costEffectSuspends` |
| `src/engine/valueRef.ts` | G1, G2 resolvers |
| `src/engine/seats.ts` | G3, G4 resolvers |
| `src/engine/effects.ts` | G3 producer, G8 branch execution |
| `src/engine/continuous.ts` | G6 binding key and scan |
| `src/engine/activation.ts` | G5 two-pass cost |
| `src/engine/dispatch.ts` | G5/G8 suspension plumbing |
| `src/engine/prose.ts` | an arm per new kind — the exhaustiveness test is the gate |
| `src/stores/definitionStore.ts` | `walkRefs` / `findReferrers` per new reference kind |
| `src/components/criteria/ValueRefPicker.tsx` | G1, G2 authoring |
| `src/components/authoring/CardRefChip.tsx`, `SeatRefChip.tsx`, `effectKinds.ts` | G3, G4 authoring |
| `src/test/traceability.test.ts` | one `IN_SCOPE` row per new criterion |

## 3. Decisions taken before this document

1. **No `SCHEMA_VERSION` bump.** Every change is additive — a new union arm or a new optional field.
   A v2 file parses unchanged under v4. A v4 file does not parse under a v2 build, which is the same
   one-way relationship every prior version had; v3 already reaffirmed "version equality, no
   migration chain". `src/test/parity.test.ts` against `parity-baseline.v1.json` is the proof
   obligation, not an assumption.
2. **Declaration order in `schema.ts` is export key order.** New optional fields append to the end of
   their object schema. Inserting one silently changes every exported file's bytes.
3. **G7 (effect duration) is deferred, not solved.** See REQUIREMENTS § v4. It is the only gap whose
   fix would edit TECHNICAL_DESIGN_V2 §5.4 rather than extend it.
4. **A read never asks a question.** G2's new folds run during renders and criteria evaluation. A
   `prompt` selector inside one resolves to nothing, exactly as `modifiers.ts:194` already handles a
   `prompt` scope during a modifier read. This is a semantic rule, not an oversight to fix later.
5. **`continuous: boolean` stays valid.** G6 widens the field rather than replacing it; every
   existing fixture and the shipped Hold'em sample author the boolean form.

## 4. Design

### 4.1 Derived values — G1, G2

Three arms on `ValueRef`:

```ts
| { kind: 'arith'; op: 'add' | 'subtract' | 'multiply' | 'min' | 'max'; left: ValueRef; right: ValueRef }
| { kind: 'countMatching'; from: TargetSelector }
| { kind: 'sumIndex'; from: TargetSelector; indexId: Id }
```

**Recursion.** `ValueRef` is already reached recursively through `SeatRef`→`CardRef`→`ZoneRef`; the
zod mirrors already use `z.lazy` with explicit `z.ZodType` annotations. `arith` makes `ValueRef`
directly self-recursive, and `countMatching`/`sumIndex` make it mutually recursive with
`TargetSelector`. Both need the same `z.lazy` treatment.

**Typing.** Integers only. A boolean on either side of `arith` is `TYPE_MISMATCH` — the same refusal
`modifiers.ts:277` already makes rather than coercing a boolean into an `adjust`. `min`/`max` are
included because they are what a cost clamp ("pay up to X") needs and cost nothing to add alongside.

**Depth.** `arith` nests without bound in authored JSON. Count depth against `limits.maxDepth` in the
resolver, the same ceiling every other recursion answers to.

**`sumIndex` reads through `effectiveIndex`,** never `card.indexValues`. Reading the base value would
make "total power of your creatures" blind to every anthem on the board — the exact bug MTG6 exists
to prevent for single cards.

**The new recursion path is the real hazard.** `valueRef → resolveTargets → evalCriteria →
resolveValueRef` is a cycle that authored input can close ("creatures get +1/+1 while the total power
of your creatures is 5 or more"). Reuse the discipline `modifiers.ts:56-79` already established and
documented:

- answer with a degraded value rather than recursing;
- never memoize a degraded answer;
- make the degraded answer independent of evaluation order, so replays cannot diverge.

Do not invent a second guard mechanism. If the existing `inFlight` set can be shared, share it.

### 4.2 Self reference — G4

One arm:

```ts
| { kind: 'self' }
```

Resolves to `TriggerContext.sourceCardId`. `UNBOUND_REF` when it is null — the discipline `candidate`
and `replacedTarget` already use for "bound nowhere else", and the right answer for a game-level rule
that has no card to mean.

`sourceCardId` is already stamped per binding by `dispatch.ts`, already carried on `PendingAction.ctx`,
and already set by `modifiers.ts` when it evaluates a modifier's scope. So `self` is correct inside
triggers, activations, modifiers and resolutions with no new plumbing.

**Follow-up once this lands:** `mtgish.ts`'s `lethalDamageRule` has a deliberately one-sided `host`
condition documented as a workaround for `self`'s absence. Revisit it — but as a separate change with
its own test run, because MTG11 depends on that fixture.

### 4.3 Player as a target — G3

An effect and a reference, mirroring the existing `chooseNumber` / `ValueRef{kind:'promptNumber'}`
pair exactly:

```ts
// Effect
| { kind: 'chooseSeat'; promptText: string; seat: SeatRef; key: string }

// SeatRef
| { kind: 'promptSeat'; key: string }
```

`seat` is *who is asked*; `key` is how a later effect reads the answer back. Candidates are the live
`seatOrder`.

Almost everything downstream exists already and must not be rebuilt:
`Interaction{kind:'chooseSeat'}` (`types.ts:778`), `PlayAction{kind:'answerSeat'}`,
`interaction.ts`'s `chooseSeat` validation arm (`:112`, `:177`), and `dispatch.ts`'s handler
(`:396`). The only reason none of it runs today is that nothing produces the interaction
(`dispatch.ts:1234`).

Follow `chooseNumber`'s raise/hold split verbatim: raise **before** any mutation, let the effect
execute twice, do not advance the cursor. Persist the answer into the **rule frame's**
`ctx.promptAnswers`, not the per-call copy — `runEffect`'s `effectCtx` construction is the precedent
and the trap.

`chooseSeat` joins `costEffectSuspends`' banned list when it is added, and comes off that list in
§4.6 along with the others.

### 4.4 Per-object continuous rules — G6

Today `continuousFired` is keyed `` `${ruleId}:${sourceCardId ?? ''}` ``. A game-level rule has one
key forever, so it fires once per session.

Widen the field:

```ts
continuous: boolean | { over: TargetSelector };
```

For the object form, `continuous.ts` resolves `over` at each settle scan and produces **one arm per
resolved card**, evaluating `condition` with `CardRef{kind:'candidate'}` bound to that card and
keying `continuousFired` as `` `${ruleId}:${cardId}` ``.

That reuses two mechanisms already built and tested rather than inventing anything: `candidate`
binding is exactly what `targets.ts` does for `matching`, and per-card `continuousFired` keys are
exactly what a card-attached continuous rule already produces.

**Constraints:**

- The boolean form must behave identically to today. Every existing fixture and the Hold'em sample
  depend on it, and `schema.ts`'s mode-exclusivity refinement reads it as a boolean.
- `over` may not contain a `prompt` at any depth — the settle scan is a read (§3 decision 4).
- Arms must be produced in a total, reproducible order. Reuse `continuous.ts`'s existing §5.1
  comparator; add the candidate card id as the final tiebreak.
- The false→true edge semantics are unchanged: fire on the transition, clear the key when the
  condition goes false so the card can re-arm.
- This multiplies the settle scan by candidate count. It is the first change in this engine with a
  plausible performance ceiling — leave a `ponytail:` comment naming it, as the codebase does
  elsewhere for the linear zone scans.

### 4.5 Interactive costs — G5

> **Revised after implementation analysis.** The first draft of this section said "copy
> `announceAction`'s freeze pattern" and stopped there. Three things it got wrong are corrected
> below, in place; the corrections are the load-bearing part of this section.

Remove the blanket ban in `costEffectSuspends` (`schema.ts:426-438`) and its runtime twin in
`activation.ts`, and replace it with a **two-pass cost**.

#### 4.5.0 Three corrections to the original plan

**(a) A suspended cost has no frame to resume into. A new `Frame` kind is required.**

Every answer handler in `dispatch.ts`'s `applyAction` — `answerPrompt`, `cancelPrompt`,
`answerOption`, `answerNumber`, `answerSeat` — does `const head = top(state); if (head?.kind !==
'rule') return reject('INVALID_ANSWER', 'the suspended effect is gone')` and writes the answer into
that frame's `ctx.promptAnswers`. `announceAction`'s freeze pattern works *because it runs inside a
rule frame whose cursor does not advance*. `activateRule` is single-shot: it is called from
`applyAction`, runs its checks, and pushes a `rule` frame only for the ability's *effects*. There is
no frame for the activation itself, so a cost that suspends can never be resumed.

Therefore:

```ts
| (FrameBase & { kind: 'activation'; ruleId: Id; sourceCardId: Id | null; seat: SeatId;
                 ctx: TriggerContext; windowId: Id | null })
```

`activateRule` keeps every legality check it has today (window match plus override, seat eliminated,
`costCheck`) — those still reject with nothing attempted — then pushes this frame and returns MORE.
A new `advanceActivation` owns the rest. The five answer handlers route through one shared helper
that accepts `rule` **or** `activation`; do not copy the check five times.

`cancelPrompt` on an `activation` frame means **pop the frame and spend nothing**: there is no
`onRejection` to consult, and resuming at the same point would re-raise the prompt. That is
acceptance criterion SP18(c), so it is the behaviour, not a fallback.

**(b) The speculative legality probe is already safe — no work needed.**

The original plan flagged `priority.ts`'s `activatableRules` as a risk, on the theory that it runs
cost effects speculatively for every seat and would start raising interactions. It does not.
`passesActivationGates` (`priority.ts:172`) evaluates only `activation.costCheck` and
`rule.condition` as *criteria*. It never applies a cost effect. MTG1/MTG4/MTG5 are not at risk from
this change and the probe needs no non-suspending mode.

**(c) `chooseMode` inside a cost is recursive, and stays banned.**

Freezing a `prompt` selector or a `chooseNumber`/`chooseSeat` is flat: raise, record the answer under
a key, move on. `chooseMode` is not — *which branch is chosen determines which sub-effects exist*,
and those sub-effects may themselves prompt, to arbitrary depth. Freezing it means recursively
freezing a tree whose shape is not known until the answers arrive.

So the ban narrows rather than lifting entirely:

| Effect in a cost | v2 | v4 |
|---|---|---|
| `prompt` target selector | banned | **allowed** |
| `chooseNumber` | banned | **allowed** ({X} costs) |
| `chooseSeat` | banned | **allowed** |
| `chooseMode` | banned | **still banned** — recursive freeze (this section) |
| `sealedChoice` | banned | **still banned** — needs several seats to submit; one seat's cost payment cannot drive it |
| `openPriority` | banned | **still banned** — a priority window inside a cost has no defensible resolution point |

That covers "sacrifice a creature", "discard a card", "tap an untapped creature you control" and
every {X} cost — the cases G5 was raised for. A modal cost is rare, and row 5 (SP19) is separately
making `chooseMode` branches suspendable; combining modal branching with cost atomicity is a
compounding risk and belongs after both have landed independently.

**(d) The frozen-target channel would collide with `announceAction`'s. Use a separate key.**

The good news: the plumbing for handing a frozen selection to an effect already exists and the cost
path already feeds it. `effects.ts`'s `resolveEffectTargets` reads
`ctx.promptAnswers[actionTargetKey(ec.effectIndex)]` (`effects.ts:530`), and `activateRule`'s existing
probe/replay loops already pass `i` as `effectIndex` to `makeEc`. So a frozen cost target is consumed
for free.

The trap: `activateRule` pushes the ability's `rule` frame with **the same `ctx` object** the cost
used. `activation.cost` and `rule.effects` are different lists both indexed from zero, so a cost
target frozen under `actionTargetKey(0)` would be read back by `rule.effects[0]` as *its* frozen
target — silently aiming the ability's first effect at whatever the cost selected.

Fix: freeze cost answers under their own reserved key (`@costTarget:<i>`, parallel to
`pending.ts`'s `@actionTarget:<i>` and `targets.ts`'s `@chosen`, neither of which can collide with an
authored id). At apply time, translate per effect into a **one-effect copy** of the context:

```ts
const ec = makeEc(..., { ...ctx, promptAnswers: { ...ctx.promptAnswers, [actionTargetKey(i)]: frozen } }, ...);
```

so nothing cost-shaped ever reaches the `rule` frame's own `promptAnswers`. `runEffect` builds a
per-effect `effectCtx` copy for exactly this class of reason; this is the same discipline.

#### 4.5.1 The two passes

The ban exists for a real reason, stated at `schema.ts:505`: suspending commits the transaction,
which would publish a half-applied cost, and the discard-on-rejection path could not then take it
back. Deleting the check without restructuring reintroduces exactly that bug.

The structure to copy is already in this repo. `pending.ts`'s `announceAction` (`:295-372`) handles
the identical shape for targets:

1. **Freeze pass** — walk the cost effects, raise any interaction they need, record each answer into
   `ctx.promptAnswers` under a reserved key, and **mutate nothing**. Re-entrant across suspend and
   resume: an already-answered prompt is skipped on the next pass (`pending.ts:305`).
2. **Apply pass** — once nothing further suspends, run the whole cost under the existing
   all-or-nothing probe (`activation.ts`'s deep-copy probe-then-replay, which stands in for the
   nested immer produce §5.8 describes because §3.2 bans immer in the engine).

`COST_UNPAYABLE` semantics are unchanged. A cancelled prompt must leave nothing spent — that is the
sharp edge of SP18 and deserves its own test rather than a shared one.

Keep a *narrowed* runtime re-check for imported JSON. Imported files never passed through the editor,
and whatever restriction survives (for example: a cost may still not open a priority window) must be
enforced in both places, as every other dual-checked rule in this engine is.

`{X}` costs depend on §4.1 for the amount arithmetic.

### 4.6 Suspendable modal branches — G8

`effects.ts:1171` states the problem and prescribes the fix:

> a branch effect that itself needs a FRESH Interaction … fails `AWAITING_PROMPT` rather than
> suspending re-entrantly, because there is no frame slot tracking "which branch effect was
> mid-flight" the way a rule frame's own cursor does. Upgrade this to a frame-level effects queue on
> `RuleFrame` if a branch ever needs to suspend for real.

Do that. The chosen branch's effects become queued work on the `rule` frame with a cursor of their
own, instead of a synchronous `for` loop inside the `chooseMode` arm.

**This is the deepest change in v4 and it lands alone.** It touches frame scheduling, which
everything else in the engine sits on top of. Two details the current code already flags:

- `effectIndex: undefined` for branch effects must be preserved — it is what stops two branch effects
  aliasing one frozen announce-target key.
- Nested `chooseMode` inside a branch must keep working; the existing arm has a defensive path for it.

Rewind is the acceptance risk here: one user action must still equal one transaction, one `LogEntry`
and one `HistoryFrame`. Verify against `sessionStore.test.ts`, not only `dispatch.test.ts`.

### 4.7 Authoring surface

Each new arm needs a picker entry, or it is unreachable from the editor and only authorable as
imported JSON:

- `ValueRefPicker.tsx` — `arith` (a recursive two-operand row), `countMatching` and `sumIndex` (each
  embedding a `TargetSelectorChip`).
- `CardRefChip.tsx` — `self`, with `refs.ts`'s `cardLabel` arm.
- `SeatRefChip.tsx` — `promptSeat`, with `seatLabel`.
- `effectKinds.ts` — `chooseSeat`: a label, a `defaultEffect()` that returns `null` when the
  definition has nothing to point at, a `missingFor()` explanation, and a `pauses()` entry so the
  `⏸` marker shows.
- `RuleSetEditor.tsx` — the continuous panel gains the optional "for each card matching …" selector.

`RulesProsePreview` and the card face both render from `prose.ts`, so a missing prose arm shows up in
both.

## 5. Task plan

One agent per row, run **sequentially**. Rows 1 and 2 both touch `types.ts`, `schema.ts`, `prose.ts`
and `definitionStore.ts`, so running them concurrently would collide. Each row is gated on
`npm run typecheck && npm test` before the next begins.

| # | Work | Criteria | Primary files |
|---|---|---|---|
| 1 | Derived values — `arith`, `countMatching`, `sumIndex` (§4.1) | SP13, SP14 | `valueRef.ts` |
| 2 | `CardRef{self}` (§4.2) and the `chooseSeat`/`promptSeat` pair (§4.3) | SP15, SP16 | `seats.ts`, `effects.ts` |
| 3 | Per-object continuous rules (§4.4) | SP17 | `continuous.ts` |
| 4 | Two-pass interactive costs (§4.5) | SP18 | `activation.ts`, `schema.ts` |
| 5 | Frame-level branch queue (§4.6) | SP19 | `dispatch.ts`, `effects.ts` |
| 6 | The Magic sample (§6) | MTG12 | `src/samples/mtg.ts`, `src/test/mtg.test.ts` |

Every row also: adds its `IN_SCOPE` entry to `src/test/traceability.test.ts`, adds the matching
`// AC: <id>` marker on the proving test, and adds its `prose.ts` arm.

## 6. The sample game

`src/samples/mtg.ts`, emitted to `samples/magic.json` by `src/test/mtg.test.ts`, following the
Hold'em pattern exactly — *"52 templates plus ~40 effects of dealing plumbing is not something anyone
should type twice"* (`holdem.ts:5`). It is imported through the ordinary game-list importer; there is
no in-app "load sample" affordance and v4 does not add one.

Scope it to a small but genuinely playable two-colour pool, not to fixture minimalism. It must
exercise every v4 primitive, because that is what makes it a proof rather than a demo:

| Card shape | Exercises |
|---|---|
| Lands and a mana pool per colour | existing pools; the once-per-turn land drop |
| A creature cast through the stack | existing `announceAction` + priority |
| A burn spell hitting *target player* | G3 |
| A "deals damage equal to the number of creatures you control" spell | G2 |
| An {X} spell | G1 + G5 |
| A "sacrifice a creature:" activated ability | G5 |
| A lord with a static buff, plus a creature reading its own power | G4, existing modifiers |
| Lethal damage destroying any creature that has it | G6 |
| A modal spell one of whose modes targets | G8 |
| A combat trick | G7's authoring workaround — **document it in the header** |

**The header is a deliverable.** `holdem.ts:9-43` is the most useful single artifact in this repo for
understanding the rule language's ceiling, precisely because it says what it could not do and what it
did instead. The Magic sample's header must do the same, and G7's workaround is the first entry.

## 7. Test plan

Per row: `npm run typecheck`, then `npm test` (58 files, 1632 tests green at the v4 baseline).

Beyond the co-located unit tests, four suites catch this design's likeliest breakages:

| Suite | What it catches here |
|---|---|
| `src/test/parity.test.ts` | an additive schema change that disturbed byte-identical round-tripping (§3 decision 1) |
| `src/engine/prose.test.ts` | a missing prose arm — which renders a card face blank rather than throwing |
| `src/test/traceability.test.ts` | a criterion documented but never proved |
| `src/test/holdem.test.ts` | a schema change that leaked into existing shipped content |

**Coverage.** The gate is `src/engine/**` at 90% branches and lines (`vitest.config.ts:35`). The
step-47 commit reports engine branch coverage at **88.84%** — worst in `replacement.ts` at 65.62% —
so this gate is believed to be **already failing before any v4 work**. Establish the baseline with
`npm run coverage` before attributing a failure to a v4 change.

**End to end**, after row 6: `npm run dev`, import `samples/magic.json` from the game list, play a
turn through the priority windows, and read the event log at verbosity 3 to confirm each rule fired
for the reason it should have.

## 8. Findings from actually authoring the sample

Row 6 (`src/samples/mtg.ts`, "Sparkbloom Duel") is the first thing to *author* with the v4 primitives
rather than test them, and it found things the design above did not anticipate. Its file header
carries all fourteen in full; these are the ones that are **engine gaps rather than sample
workarounds**, and they are the v5 candidates.

### 8.1 G9 — `CardRef{self}` can be read but never targeted. **The biggest miss in v4.**

§4.2 said `self` was "one arm in `seats.ts`'s resolver". That was true and it was not enough.
**No `TargetSelector` arm consumes a `CardRef`**, so a rule can *test* the card carrying it, and read
its indexes as an amount, but **nothing can tap, sacrifice, pump, or move itself.** In Magic that is
most of what a permanent's own ability does: "{T}: add {G}", "Sacrifice this creature:", "this
creature gets +1/+1 until end of turn".

The sample is visibly bent around it — a land has no ability of its own (tapping for mana is a
*global* activation that prompts over your own untapped lands), a creature cannot tap to attack (it
spends a pool instead), and `Bone Altar` sacrifices a *chosen* creature rather than itself. The only
workaround that exists is to `attach` a card to itself and address it as
`attachedTo{host:{kind:'self'}}`, which works, is unreadable, and burns the attachment field.

**Fix, and it is small:** one `TargetSelector` arm, `{ kind: 'card'; card: CardRef }` — a one-card
selector over any `CardRef`. It closes self-targeting completely and subsumes the special-cased
`attachedTo`/`hostOf` pair. This should be the first item of any v5.

### 8.2 Three things nothing can read

Each of these forced a pool that exists purely as plumbing, and each is a candidate `ValueRef` arm:

| Nothing reads | Sample's workaround | Consequence |
|---|---|---|
| **Which zone a card is in** | a `Ready` index set only by the untap step, which only touches the battlefield | without it, a `perInstance` ability is offered on cards still in the library — `activatableRules` walks all of `state.cards` |
| **The current machine state** | a `Phase` pool written by each state's `onStateEnter` | "sorcery speed" is `Phase = Main` in a `costCheck`; `stateFilter` narrows a state *event* and does nothing for an activation |
| **The seat asking the question** | a `Seat` pool seeded per seat at game start | `Seat(me) = activePlayer` is the only way to write "it is my turn", and `Seat(controller-of-self) = Seat(me)` the only way to write "I control this card" |

### 8.3 No selector filters by controller

"Creatures you control" is expressible only as a *zone*, so the sample makes the Battlefield
**player-scoped** — diverging from Magic's single shared battlefield, and from `mtgish.ts`, whose
Anthem Lord consequently buffs *everyone's* creatures. Price of the workaround: any board-wide sweep
needs `seat: {kind:'all'}`. A `matching` predicate that compared a card's controller to a seat would
remove the need.

### 8.4 Smaller ones, each with a stated reason in the header

- **`activation.window` is a single id**, so an ability cannot be legal both inside a window and
  outside one. Everything in the sample lives in one window and speed is a phase check instead.
- **`destroyCards` deletes outright**, so a dead creature never reaches the graveyard.
- **One `modifier` per `RuleSet`**, so +1/+1 is two rules.
- **A sweep over an empty set is a rejection, not a no-op** (`NO_TARGETS`), so an untap step logs
  refusals on an empty board unless every sweep is guarded by a `countMatching >= 1` condition.
- **G7 confirmed as bad as predicted.** "Until end of turn" is one rule *per magnitude*, a boolean tag
  cannot count (two pumps on one creature take 6 and give back 3), and one line of card text became
  six effects. This is the strongest argument yet for revisiting §5.4's no-materialization rule.

## 9. Risks

- **G8 is the one that can break rewind.** A frame-level branch queue changes how work is scheduled,
  and the one-action-one-transaction-one-`HistoryFrame` invariant is what rewind is built on. It
  lands alone, behind the full suite, with `sessionStore.test.ts` as the real gate.
- **G5 can publish a half-paid cost** if the ban is lifted without the two-pass restructure. The
  check is not bureaucracy; it is load-bearing.
- **G2 can hang a render.** The `valueRef → targets → criteria → valueRef` cycle is reachable from
  ordinary authored text. The re-entrancy guard is not optional, and the degraded answer must not
  depend on which card the UI read first.
- **G6 has an unmeasured performance ceiling.** Per-candidate arms multiply the settle scan. v2 left
  derived-modifier cost explicitly unmeasured on a 30-permanent board; the Magic sample is the first
  thing that will put real pressure on it.
- **Silently unreachable primitives.** An arm added to the engine but not to a picker is authorable
  only by hand-editing JSON. §4.7 is part of the work, not a follow-up.