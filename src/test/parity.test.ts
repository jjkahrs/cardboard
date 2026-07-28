/**
 * §8 Phase 0 exit criterion 3 — "`script.ts`'s 200-row scripted session and its rewind points
 * `[0, 1, 12, 99, 198]` produce identical canonical snapshots to the pre-rewrite run."
 *
 * `sessionStore.test.ts`'s rewind-fidelity block proves the session is self-consistent: rewinding
 * to n reproduces the snapshot recorded at n *in this build*. That is a different and weaker claim
 * than the one Phase 0 makes, which is cross-version — that the v2 core lands the game in the same
 * place the v1 core did. Self-consistency survives a uniform behavioural regression; this does not.
 *
 * So the baseline is generated from the last v1 commit (`9a450fa~1`) by running THIS FILE there,
 * with `WRITE_PARITY_BASELINE` set, and checked in as `fixtures/parity-baseline.v1.json`. The file
 * is deliberately version-agnostic: it touches only names present in both `PlayState` shapes.
 *
 *   git worktree add <dir> 9a450fa~1
 *   # junction/symlink node_modules into <dir>
 *   cp src/test/parity.test.ts <dir>/src/test/
 *   cd <dir> && WRITE_PARITY_BASELINE=<repo>/src/test/fixtures/parity-baseline.v1.json \
 *     npx vitest run src/test/parity.test.ts
 *
 * WHAT IS AND IS NOT COMPARED. `PlayState`'s shape changed by design (§3.2, §3.3): `queue` became
 * `stack` + `pending`, `pendingPrompt` became `interaction`, `budget` gained `settleIterations`.
 * Those are the machine's internals — a byte-comparison of the whole state cannot hold and is not
 * what Phase 0 claims. What must be identical is the GAME-OBSERVABLE state, which is every field a
 * player or the UI can see, plus the log. Both lists are spelled out below rather than derived by
 * key-subtraction, so a field added to `PlayState` later is opted in by a human, not silently.
 */

import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { duel, script, SCRIPT_SEED } from './fixtures';
import { useSessionStore } from '../stores/sessionStore';
import baseline from './fixtures/parity-baseline.v1.json';

/** The rewind points §8 names, plus 200 — the settled end of the session. */
const POINTS = [0, 1, 12, 99, 198, 200];

/**
 * Everything a player can observe. NOT `stack`/`pending`/`queue`/`interaction`/`pendingPrompt`/
 * `budget`/`nextWorkId`/`logSeq` — those are the continuation machine's bookkeeping and are
 * expected to differ between v1 and v2. `rngCursor` and `nextSeq` are in because they are the two
 * determinism counters: equal observable boards reached via a different number of PRNG draws would
 * be a real divergence, not an internals difference.
 */
function observable(state: Record<string, unknown>): unknown {
  const { cards, zones, pools, playerPools, currentStateId, finished, rngCursor, nextSeq } = state;
  return { cards: v1Cards(cards), zones, pools, playerPools, currentStateId, finished, rngCursor, nextSeq };
}

/**
 * `PlayState.seatOrder` and `eliminated` (§3.5) are excluded by the destructure above simply by not
 * being named. `CardInstance`'s four v2 identity fields (§4.3 — `tags`, `owner`, `controller`,
 * `attachedTo`) need this explicit strip instead, because `cards` is compared wholesale. They have
 * no v1 counterpart at all, so there is nothing here they could agree or disagree with; a card's v1
 * observable state is its id, template, index values and its two flags, and those are named below
 * rather than subtracted, so a field added to `CardInstance` later is opted IN by a human.
 */
function v1Cards(cards: unknown): unknown {
  return Object.fromEntries(
    Object.entries(cards as Record<string, Record<string, unknown>>).map(([key, card]) => {
      const { id, templateId, indexValues, faceDown, rotated } = card;
      return [key, { id, templateId, indexValues, faceDown, rotated }];
    }),
  );
}

/**
 * The log's shape, in full — every line's level, kind, message, change tuple, rule id, effect kind
 * and causal depth. Compared verbatim rather than summarised: §5.9's log IS the user-visible
 * account of what the engine did, so "same board, different story" is a parity failure.
 *
 * v2 §4.10, §6.2 add `LogLine.visibility` / `LogEntry.cause.visibility` — hidden-information
 * redaction has no v1 counterpart, so (same reasoning as `v1Cards` above) they are stripped here
 * rather than compared: a field added to the log later is opted OUT of this v1 comparison by a
 * human, not silently.
 */
function withoutVisibility(o: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...o };
  delete copy.visibility;
  return copy;
}

function logShape(log: readonly unknown[]): unknown {
  return (log as { cause: Record<string, unknown>; lines: Record<string, unknown>[] }[]).map((entry) => ({
    ...entry,
    cause: withoutVisibility(entry.cause),
    lines: entry.lines.map(withoutVisibility),
  }));
}

/** Recursive key sort — the same canonicalisation `sessionStore.test.ts` uses (§7.1's spirit). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as object)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/**
 * Drives the full script, then rewinds to each point in turn and records the observable snapshot
 * there — i.e. the snapshots are taken through `rewind`, the operation Phase 0 has to preserve,
 * not merely on the way past.
 */
function run(): Record<string, unknown> {
  const store = () => useSessionStore.getState();
  store().startSession(duel, SCRIPT_SEED);

  const apply = (from: number) => {
    for (let i = from; i < script.length; i++) store().dispatch(script[i].action, script[i].override ?? false);
  };
  apply(0);

  const at: Record<string, unknown> = {};
  for (const n of POINTS) {
    store().rewind(n);
    const s = store().session!;
    at[String(n)] = canonical({ state: observable(s.state as unknown as Record<string, unknown>), log: logShape(s.log) });
    apply(n); // restore to 200 for the next point
  }
  return at;
}

// ---------------------------------------------------------------------------

describe('Phase 0 parity — the scripted session against the pre-rewrite baseline', () => {
  it('reaches the same observable state and log at rewind points [0, 1, 12, 99, 198] and at the end', () => {
    const actual = run();

    if (process.env.WRITE_PARITY_BASELINE) {
      writeFileSync(process.env.WRITE_PARITY_BASELINE, JSON.stringify(actual, null, 1));
      return; // generating, not asserting — only ever true in the v1 worktree
    }

    // Point-by-point rather than one deep-equal over the whole map, so a failure names the row.
    for (const n of POINTS) {
      expect(actual[String(n)], `rewind point ${n} diverges from the v1 baseline`).toEqual(
        (baseline as Record<string, unknown>)[String(n)],
      );
    }
  });

  it('covers every rewind point §8 names', () => {
    expect(POINTS).toEqual(expect.arrayContaining([0, 1, 12, 99, 198]));
    expect(Object.keys(baseline as object).sort()).toEqual(POINTS.map(String).sort());
  });
});
