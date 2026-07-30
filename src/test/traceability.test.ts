/**
 * §9 — "a `// AC: R3` comment on the one test that *is* the proof is enough." Nobody had checked
 * that every agent actually left one. This scans every test file for an `AC: <id>` marker (as a
 * comment OR inside a describe/it name — both conventions are in the wild already) and asserts
 * every criterion in scope has at least one.
 *
 * A criterion whose only possible proof is an unbuilt screen goes in PENDING and is not asserted,
 * so this suite doesn't red the whole build over work nobody has started yet. Steps 21–32 landed
 * v2's pending-action/priority/activation/modifier/replacement/continuous/sealed-choice layer and
 * its two fixtures; step 33 (§8's phase-2 GATE) is what wired every criterion those steps made
 * provable into IN_SCOPE. Step 40 (§8's phase-3 GATE, part one) proved the one row PENDING held —
 * SP12, the pinned play UI — end to end from `PlayScreen` (play.test.tsx), so PENDING is empty; it
 * stays declared, and tolerated empty, for whichever criterion needs it next.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(process.cwd(), 'src');
const TAG_RE = /AC:\s*([A-Z][A-Z0-9]*)/g;

function listTestFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    // Excludes this file itself — its own doc comments quote the "AC: <id>" convention verbatim
    // (including a couple of real ids as examples), which would otherwise self-tag as proof.
    .filter((f: string) => /\.test\.tsx?$/.test(f) && !f.endsWith('traceability.test.ts'))
    .map((f: string) => join(dir, f));
}

/** file path -> every `AC: <id>` it contains, id -> the files that prove it. */
function scanTags(files: string[]): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(process.cwd(), file);
    for (const m of text.matchAll(TAG_RE)) {
      const list = byId.get(m[1]) ?? [];
      if (!list.includes(rel)) list.push(rel);
      byId.set(m[1], list);
    }
  }
  return byId;
}

interface Criterion {
  id: string;
  prose: string;
  /** TECHNICAL_DESIGN.md §9.1's "Test file" column, for a useful failure message. */
  expected: string;
}

// §9.1, restricted to what steps 1–15 (engine + stores) can prove headlessly.
const IN_SCOPE: Criterion[] = [
  { id: 'A1', prose: 'Pool created -> in list + selectable as ValueRef everywhere', expected: 'definitionStore.test.ts' },
  { id: 'A2', prose: 'Duplicate zone name rejected, no zone created', expected: 'definitionStore.test.ts' },
  { id: 'A3', prose: 'Rules prose auto-generated; override replaces text without altering the RuleSet', expected: 'prose.test.ts' },
  { id: 'A4', prose: 'min 0, subtract 5 from 3 -> 0, and the logged value is the clamped one', expected: 'effects.test.ts' },
  { id: 'P1', prose: 'Reopen browser -> loads from IndexedDB as left', expected: 'persistence.test.ts' },
  { id: 'P2', prose: 'Export -> import -> byte-identical re-export', expected: 'persistence.test.ts (or schema.test.ts)' },
  { id: 'P3', prose: 'Malformed JSON rejected naming the field, current game untouched', expected: 'schema.test.ts, definitionStore.test.ts' },
  { id: 'S1', prose: '2 players + per-player Hand -> 2 Hand instances; Shared once', expected: 'setup.test.ts' },
  { id: 'S2', prose: 'Deck 40 + seed 12345 -> identical order across sessions', expected: 'setup.test.ts' },
  { id: 'R1', prose: 'onCardPlayed -> opponent HP -1; log shows event, rule, change', expected: 'dispatch.test.ts' },
  // R2 is one criterion split across an engine half (this) and a component half (PENDING below) —
  // both rows share the id "R2" in §9.1. The component half doesn't exist yet, so any "AC: R2"
  // found right now can only be the engine half; revisit if that stops being true.
  { id: 'R2', prose: 'prompt pauses; later effects deferred then resumed in order; legal targets highlighted', expected: 'targets.test.ts, dispatch.test.ts, PlayTable.test.tsx' },
  { id: 'R3', prose: 'maxCapacity:7, 8th card rejected, nothing moved, reason logged', expected: 'effects.test.ts' },
  { id: 'R4', prose: 'Self-retriggering chain halts, logs "possible rule loop"', expected: 'dispatch.test.ts' },
  { id: 'M1', prose: 'attackers > 0 -> auto-transition, onStateEnter fires', expected: 'stateMachine.test.ts' },
  { id: 'M2', prose: 'Criteria-less transition renders a button; click performs it', expected: 'TransitionBar.test.tsx' },
  { id: 'M3', prose: 'Transition not in enterableFrom blocked, reason shown', expected: 'stateMachine.test.ts' },
  { id: 'M4', prose: 'Override forces a rejected move through, log flagged', expected: 'sessionStore.test.ts' },
  { id: 'M5', prose: 'End -> finished, onGameEnd, only rewind accepted', expected: 'stateMachine.test.ts' },
  { id: 'H1', prose: 'Rewind 20->12 restores all state; 13+ discarded', expected: 'sessionStore.test.ts' },
  { id: 'H2', prose: 'Every change logs what changed, old->new, and cause', expected: 'dispatch.test.ts' },
  // L1's automated half is level B (source assertions), so it lands with step 16's theme rather
  // than with the components. The visual half stays a manual glance per §9.1.
  { id: 'L1', prose: 'Kraft palette, marker font, no external font/image requests', expected: 'theme.test.ts' },
  { id: 'L2', prose: 'Catalog card and in-play card render identically', expected: 'Card.test.tsx' },
  // v2 §9.1 — the modifier rows, provable headlessly the moment step 13's modifiers.ts exists.
  { id: 'MTG6', prose: 'Static +1/+1 rule; new creature entering the zone reads the bonus immediately, no recalculation action', expected: 'modifiers.test.ts' },
  { id: 'MTG7', prose: '`set` modifier before `adjust` regardless of authoring order', expected: 'modifiers.test.ts' },
  // v2 §9.1 — the seat-ring rows. A criterion joins this list only once its primitive exists, so
  // an id here is always a claim that the proof is written, never that it is planned.
  { id: 'SP6', prose: '`sum` over a per-player pool resolves to one arithmetic total; a boolean pool with `sum` is rejected by the schema', expected: 'valueRef.test.ts, schema.test.ts' },
  { id: 'SP11', prose: '5 seats, seat 3 eliminated -> the seat after 2 resolves to 4, activeSeatCount reads 4, finished stays false', expected: 'seats.test.ts' },
  { id: 'V2', prose: 'Seat ousted -> leaves the order, former neighbours become adjacent, later refs correct with no restart', expected: 'seats.test.ts' },
  { id: 'V10', prose: '4-seat and 5-seat sessions both read the correct table size from one authored threshold, no config', expected: 'seats.test.ts' },
  // v2 §9.1 — the owner/controller/holder rows.
  { id: 'SP5', prose: '`setController` seat wins over the holding zone for controllerOf; ownerOf unchanged', expected: 'effects.test.ts, valueRef.test.ts' },
  { id: 'MTG8', prose: 'Card returned to its owner\'s hand after its controller changed -> owner\'s hand, not the controller\'s', expected: 'effects.test.ts' },
  { id: 'V1', prose: '5 seats; the predator of the triggering card\'s owner resolves relative to that seat, not the active seat', expected: 'seats.test.ts' },
  { id: 'V9', prose: 'Unique card contested; the controller changes without changing which zone instance holds it', expected: 'effects.test.ts' },
  // v2 §9.1 — per-instance tags.
  { id: 'SP2', prose: 'A runtime tag added by an effect and absent from the template reads true in criteria, and false once removed — asserted via effectiveTags(), not template.tags', expected: 'criteria.test.ts, effects.test.ts' },
  // v2 §9.1 — attachment. Both rows turn on attachment being a REFERENCE rather than a zone.
  { id: 'SP3', prose: 'An attached card\'s host reference survives the host moving zones — hostOf still resolves to the same host id', expected: 'effects.test.ts (attach)' },
  // v2 §9.1 — predicate targeting. The log half is as load-bearing as the selection half: a
  // predicate that silently drops a candidate is the failure mode the per-candidate line exists for.
  { id: 'SP1', prose: '`matching{where: power>2}` over a zone selects only qualifying candidates; the resolved id set excludes the power<=2 candidate and a log line exists per candidate with `criteria` kind and a boolean outcome (§5.9 row 3)', expected: 'targets.test.ts' },
  { id: 'SP4', prose: 'Host destroyed -> the attachment is not cascaded; the card stays in state.cards with attachedTo null, and the detachment logs its own change line distinct from the destroy line', expected: 'effects.test.ts (destroyCards)' },
  // §8 step 33 — the phase-2 gate. Steps 21–32 landed the pending-action/priority/activation/
  // modifier/replacement/continuous/sealed-choice layer and the two fixtures; this batch is every
  // criterion those steps made provable that hadn't yet been wired into IN_SCOPE.
  { id: 'SP7', prose: 'Cost precondition requiring 2, only 1 available -> nothing runs, nothing spent, cost named', expected: 'activation.test.ts' },
  { id: 'SP8', prose: 'Same rule with 2 available -> one transaction, rewind restores the spent total exactly', expected: 'activation.test.ts, sessionStore.test.ts' },
  { id: 'SP9', prose: "First rule's effect makes the second's condition newly true -> both fire in the same transaction", expected: 'continuous.test.ts' },
  { id: 'SP10', prose: 'chooseMode pauses showing mode labels rather than cards, no later effect has run, chosen branch runs in order', expected: 'dispatch.test.ts' },
  { id: 'MTG1', prose: 'Pending action placed -> every seat offered priority in turn order; a legal responder may respond above the original', expected: 'priority.test.ts' },
  { id: 'MTG2', prose: 'Stack of two, no further response -> most recently placed resolves first', expected: 'pending.test.ts' },
  { id: 'MTG3', prose: 'Counter resolves -> countered action removed without applying; log names both', expected: 'pending.test.ts' },
  { id: 'MTG4', prose: 'Priority round with no legal response anywhere -> collapses, no per-seat log entry', expected: 'priority.test.ts, play.test.tsx' },
  { id: 'MTG5', prose: 'A seat with a legal response passes anyway -> own log entry and rewind point', expected: 'priority.test.ts, sessionStore.test.ts, play.test.tsx' },
  { id: 'MTG9', prose: 'Continuous rule eliminates a seat at zero life; elimination lands at next settle; session continues', expected: 'continuous.test.ts, seats.test.ts' },
  { id: 'MTG10', prose: 'Replacement: a draw becomes two; substitution before any card moves; log distinguishes original from substitute', expected: 'replacement.test.ts' },
  { id: 'MTG11', prose: 'Attacker/blocker via attachment; damage resolves via the continuous-condition rule, not bespoke combat code', expected: "mtgish.ts-driven scenario in fixtures.test.ts" },
  { id: 'V3', prose: 'Announced action -> block window offers each other seat in order; closes only after all decline consecutively', expected: "priority.test.ts (vtesish block window)" },
  { id: 'V4', prose: 'One seat blocks -> resolution continues from the resulting combat, not re-offered to already-declined seats', expected: 'priority.test.ts' },
  { id: 'V5', prose: 'Two hidden strikes: first submission invisible/unlogged; second submission -> both reveal, one transaction, one log entry (engine half — the component half is the pinned play UI, Phase 3)', expected: 'dispatch.test.ts (sealedChoice), fixtures.test.ts' },
  { id: 'V6', prose: 'Vote values 1/2/1 summed -> 4; log names both resolved totals, not just the verdict', expected: 'fixtures.test.ts (vtesish scenario)' },
  { id: 'V7', prose: 'Votes-for > votes-against -> passing branch runs; votes added mid-window are included', expected: 'fixtures.test.ts (vtesish scenario)' },
  { id: 'V8', prose: "Equipment attached to a vampire; discipline-value->=2 check permitted only for that host", expected: 'fixtures.test.ts (vtesish hostOf scenario)' },
  { id: 'V11', prose: 'Influence counters reach capacity -> authored rule moves the minion to Ready, via existing v1 primitives', expected: 'fixtures.test.ts (vtesish scenario)' },
  // §8 step 40, part one (§8's phase-3 GATE) — the one row phase-2's exit criteria left PENDING for
  // Phase 3 to own. Proved end to end from `PlayScreen` against vtesish (hidden-info leak check,
  // raw HTML) and duel (the three-part explicit-switch proof from §6.1), not from a component in
  // isolation, which is the point of it being the gate.
  { id: 'SP12', prose: 'Play UI pinned to seat 2 discloses nothing hidden, log included; switching pinned seat is an explicit action', expected: 'play.test.tsx' },
  // v3 §6 — importing an exported game into the editor. Every row here is a screen-level proof, so
  // none of them could have been written before Phase 3; they land with the feature itself.
  { id: 'IM1', prose: 'Import from the list stores the file and lands in that game\'s editor, not back on the list', expected: 'routing.test.tsx' },
  { id: 'IM2', prose: 'Id collision mints a new id; the game it collided with is byte-identical afterwards', expected: 'routing.test.tsx' },
  { id: 'IM3', prose: 'Replace overwrites the open game in place — same id, same route, same list slot, file\'s content', expected: 'import.test.tsx' },
  { id: 'IM4', prose: 'Replace takes two clicks, names file and game between them, and writes nothing if cancelled', expected: 'import.test.tsx' },
  { id: 'IM5', prose: 'A file failing any gate changes nothing: open definition referentially identical, IndexedDB untouched', expected: 'import.test.tsx' },
  { id: 'IM6', prose: 'Drop on the list imports as a new game; drop in the editor offers a replace and commits nothing on its own', expected: 'import.test.tsx' },
  { id: 'IM7', prose: 'A drop on a screen that handles none is preventDefault-ed — the tab never navigates to the file', expected: 'import.test.tsx' },
  { id: 'IM8', prose: 'A file from another schema version is rejected naming both versions, from the editor surface too', expected: 'import.test.tsx' },
  { id: 'IM9', prose: 'Replace stamps its own updatedAt; the file\'s timestamp does not survive into the stored game', expected: 'import.test.tsx' },
  { id: 'IM10', prose: 'While a file drag is over the window each screen states what a drop would do, and stops when it leaves', expected: 'import.test.tsx' },
  // v4 §4.1 — derived values. Both rows are engine-level and provable headlessly the moment
  // `valueRef.ts` grows the three arms, so neither is ever a candidate for PENDING.
  { id: 'SP13', prose: 'A criterion comparing a nested arithmetic value against a literal resolves the whole expression to one number; a boolean operand is rejected as TYPE_MISMATCH rather than coerced', expected: 'valueRef.test.ts' },
  { id: 'SP14', prose: 'Five cards, three matching a predicate -> countMatching resolves to 3; sumIndex over the same set totals every modifier currently applying, not the stored base values', expected: 'valueRef.test.ts' },
  // v4 §4.2, §4.3 — self reference and player-as-a-target. Both are engine-level: SP15 needs the
  // real per-binding `sourceCardId` stamp, and SP16 needs the whole suspend/answer/resume round
  // trip, so both are proved from `dispatch.ts` rather than from a resolver in isolation.
  { id: 'SP15', prose: 'A rule attached to a card referring to itself resolves to that card instance and not to the card an event was about; the same reference in a game-level rule fails UNBOUND_REF', expected: 'dispatch.test.ts, seats.test.ts' },
  { id: 'SP16', prose: 'An effect asking a player to choose a player suspends the session on a seat choice; once answered, a later effect in the same rule resolves its seat reference to the chosen seat', expected: 'dispatch.test.ts' },
  // v4 §4.4 — per-object continuous rules. Both halves of the criterion are settle-scan behaviour, so
  // the proof sits with the scan itself and needs a real board rather than the card-less fixtures the
  // rest of `continuous.test.ts` uses.
  { id: 'SP17', prose: 'One per-object continuous rule and two creatures: the first meets the condition and is dealt with, later the second meets it and the rule fires again for the second; given neither has changed, it does not fire repeatedly for the same card', expected: 'continuous.test.ts' },
  // v4 §4.5 — the interactive cost. Three clauses, three separate tests behind the one marker: the
  // sharp edge is the cancellation, and a shared test would let the two happy paths carry it.
  { id: 'SP18', prose: 'An activation whose cost requires choosing a card to discard suspends before anything is spent; once the choice is answered the whole cost applies in one transaction; and when the choice is cancelled nothing is spent and no card moved', expected: 'activation.test.ts' },
  // v4 §4.6 — the suspendable modal branch. Proved from the dispatcher, because the whole criterion is
  // about the frame-level cursor: an `applyEffect` unit call has no frame and could not fail this.
  // `sessionStore.test.ts` carries the other half of the risk (§8) — that the branch queue rewinds —
  // under its own describe rather than a second marker.
  { id: 'SP19', prose: 'A modal effect one of whose modes targets: when that mode is chosen the session suspends for the target choice and resumes into the rest of that mode\'s effects in order, rather than failing', expected: 'dispatch.test.ts' },
  // v4 §6 — the sample game, and the only criterion in the series that is about PLAYING rather than
  // about a primitive. Proved by driving the shipped definition through the real dispatcher, because
  // a sample that validates but cannot be played would prove nothing.
  { id: 'MTG12', prose: 'Given the shipped Magic sample, when it is imported and played, then a turn completes: a land is played under a once-per-turn limit, a creature is cast through the stack, a burn spell targets a chosen player, and a "for each" spell reads a count off the board', expected: 'mtg.test.ts' },
];

// Nothing lands here right now. A criterion goes in PENDING only when its sole possible proof is a
// screen or component that doesn't exist yet — SP12 was the last one (Phase 3's UI), and step 40
// proved it. `[...IN_SCOPE, ...PENDING]` below tolerates PENDING being empty with no special case.
const PENDING: Criterion[] = [];

const tags = scanTags(listTestFiles(SRC_DIR));

describe('acceptance-criteria traceability (TECHNICAL_DESIGN.md §9.1)', () => {
  it.each(IN_SCOPE)('$id has a tagged proof — $prose', ({ id, prose, expected }) => {
    const proofs = tags.get(id) ?? [];
    if (proofs.length === 0) {
      throw new Error(
        `No "AC: ${id}" marker found anywhere under src/**/*.test.ts(x).\n` +
          `Criterion: ${prose}\n` +
          `TECHNICAL_DESIGN.md §9.1 expects this proved in: ${expected}`
      );
    }
    expect(proofs.length).toBeGreaterThan(0);
  });

  it('prints the criterion -> proof-file table', () => {
    const allIds = [...IN_SCOPE, ...PENDING].map((c) => c.id);
    const rows = [...new Set(allIds)].map((id) => {
      const proofs = tags.get(id);
      const status = proofs ? proofs.join(', ') : IN_SCOPE.some((c) => c.id === id) ? 'MISSING' : 'pending (UI)';
      return `${id.padEnd(5)} ${status}`;
    });
    console.info(['\nAC -> proof file(s):', ...rows].join('\n'));
    expect(rows.length).toBe(new Set(allIds).size); // always true — this test exists to print, not assert
  });
});
