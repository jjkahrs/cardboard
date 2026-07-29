# Technical Design: Cardboard v3 — Importing an exported game into the editor

Requirements: [`docs/REQUIREMENTS.md`](./REQUIREMENTS.md) § *v3 — Importing an exported game into the editor*
Builds on: [`docs/TECHNICAL_DESIGN.md`](./TECHNICAL_DESIGN.md) (v1 §7 persistence/import), [`docs/TECHNICAL_DESIGN_V2.md`](./TECHNICAL_DESIGN_V2.md)

## 1. Overview

v3 adds no engine code, no schema code, and no dependency. Every one of the four import gates
already exists in `engine/schema.ts` and is already correct; v3 is entirely about **who can call it
and what happens to the result**.

Three changes, all at or above `src/screens/`:

1. **A file becomes a definition in one place.** `readDefinitionFile(file)` in `screens/gameFile.ts`
   is `importJson(await file.text())` and nothing else. Both surfaces call it, so the gates cannot
   drift between them.
2. **`AuthoringLayout` learns one new operation: replace.** It already owns the definition's load,
   its autosave, and the `loaded` ref that keeps the two from fighting. Replace is the fourth thing
   that touches that trio, and it belongs beside them rather than in a store action that cannot see
   the autosave.
3. **A `useFileDrop` hook plus a global drop guard.** The hook is ~40 lines of `dragenter`/`dragover`
   /`drop` listeners; the guard is a `preventDefault` on the window, mounted by a pathless root
   layout in the route table, so a drop on a screen with no handler cannot navigate the tab away
   from an unsaved playtest.

What v3 explicitly does **not** do: touch `engine/`, touch `persistence.ts`, add a store action, add
a migration path, or introduce a second definition-loading path. `definitionStore.importDefinition`
stays as it is — it is the proof site for **AC: P3** in `definitionStore.test.ts` and deleting it
would delete that proof; it is simply not what the screens call, because a replace needs the parsed
definition with an id override, not a text blob.

## 2. Context

### 2.1 Inherited unchanged

| Area | File | Status |
|---|---|---|
| Four import gates, canonical export | `src/engine/schema.ts` `importJson` / `exportJson` | **Unchanged.** Byte-identical round trip (**AC: P2**) is untouched by v3. |
| IndexedDB read/write, debounced autosave | `src/stores/persistence.ts` | **Unchanged.** No new store, no new key, no new API. |
| Definition CRUD + validation-on-write | `src/stores/definitionStore.ts` | **Unchanged.** `setDefinition` already validates and refuses. |
| Download plumbing, id minting, filename slug | `src/screens/gameFile.ts` | **Extended** by one function; existing three untouched. |
| Route table | `src/routes.tsx` | **Wrapped**, not rewritten: every existing route becomes a child of one pathless layout (§4.3). Paths, order and elements are untouched. |
| dnd-kit card dragging | `src/components/dnd/*` | **Unchanged and non-interacting.** dnd-kit is pointer-event based; native file drag emits `dragover`/`drop`, which no dnd-kit sensor listens to. |

### 2.2 Touched

| File | Change |
|---|---|
| `src/screens/gameFile.ts` | `+ readDefinitionFile(file): Promise<ImportResult>` |
| `src/screens/useFileDrop.ts` | **New.** The hook, plus `useFileDropGuard`. |
| `src/screens/AppFrame.tsx` | **New.** Pathless root layout that mounts the guard (**IM7**). |
| `src/screens/ReplaceGame.tsx` | **New.** Picker + two-click confirm + error list for the rail. |
| `src/screens/GameListScreen.tsx` | Navigate into the editor on import; wire the drop hook. The `notice` state goes: nothing sets it once the success message is the imported game's own editor. |
| `src/screens/AuthoringLayout.tsx` | Replace state + commit; render `<ReplaceGame>` in the rail; wire the drop hook. |
| `src/routes.tsx` | Existing table nested under `<AppFrame/>`. |
| `src/theme/components.css` | `.cb-dropzone` overlay. |
| `src/screens/routing.test.tsx`, `src/screens/import.test.tsx` (new) | Tests. |
| `src/test/traceability.test.ts` | `IM1`–`IM10` rows. |

## 3. Decisions taken before this document

Settled with the project owner; each one closes a fork the code would otherwise have to keep open.

1. **v3 is this feature alone.** No other release content.
2. **Replace keeps the open game's `id` and nothing else from the open game.** Name, contents,
   everything else comes from the file. The `id` is kept because it is the URL and the list slot.
3. **A drop means what the screen's own import button means** — new game on the list, replace in the
   editor. Not a chooser, not "always new".
4. **Two-click inline confirm, matching the existing Delete pattern.** No auto-backup download, no
   undo buffer. `window.confirm` is not used anywhere in this app and is not introduced here.
5. **Version equality only.** No migration chain (reaffirms TECHNICAL_DESIGN_V2 §2.3 item 6).

## 4. Design

### 4.1 `readDefinitionFile` — the single seam between a File and a definition

```ts
// src/screens/gameFile.ts
import { importJson, type ImportResult } from '../stores/persistence';

/**
 * The only place a File becomes a definition. Both import surfaces call it, so "what counts as a
 * valid game file" cannot drift between the list and the editor — it is `importJson`'s four gates
 * (§7.2), reached the same way from both.
 */
export async function readDefinitionFile(file: File): Promise<ImportResult> {
  return importJson(await file.text());
}
```

`file.text()` rejects only if the file was moved or unreadable since the picker handed it over.
Callers wrap it (§4.6, row 7) rather than this function inventing a fifth gate.

### 4.2 `useFileDrop` — the drop half

```ts
// src/screens/useFileDrop.ts
/**
 * Window-level file drop. Window rather than a wrapper element because the drop target the user
 * aims at is "the app", and a bounded div means a drop two pixels outside it silently navigates
 * the tab to the file instead.
 *
 * Returns whether a file drag is currently over the window, so the caller can say what a drop
 * would do (IM10) BEFORE it happens — which is the only warning a destructive drop gets.
 */
export function useFileDrop(onFile: (file: File) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const handler = useRef(onFile);
  handler.current = onFile;              // no re-subscribe when the caller re-renders

  useEffect(() => {
    // A counter, not a boolean: dragleave fires every time the pointer crosses a child element,
    // so `setDragging(false)` on any dragleave makes the overlay strobe.
    let depth = 0;
    const isFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;

    const onEnter = (e: DragEvent) => { if (isFiles(e)) { depth += 1; setDragging(true); } };
    const onLeave = (e: DragEvent) => { if (isFiles(e)) { depth -= 1; if (depth <= 0) setDragging(false); } };
    // preventDefault on dragover is what makes the window a drop target at all; without it the
    // browser refuses the drop and then navigates to the file on release.
    const onOver = (e: DragEvent) => { if (isFiles(e)) e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      // First file only. A multi-file drop is not an error worth a message — it is a slip, and
      // importing one game is the outcome the user was reaching for.
      if (file) handler.current(file);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => { /* symmetric removeEventListener */ };
  }, []);

  return dragging;
}
```

No extension filter. A `.json` file dropped as `game.txt` is still a valid export, and a file that
is not one is rejected by gate 1 with a message — filtering by name would replace a real error with
silence.

### 4.3 The global drop guard (IM7)

The hook only runs on the two screens that handle drops. On `PlayScreen` a stray drop would navigate
the tab to the file, and **play sessions are not persisted** — the playtest would be gone.
`useFileDropGuard()` is the four-line `preventDefault` that closes it, and it is mounted by a
pathless root layout in the route table rather than by `App`:

```tsx
// src/screens/AppFrame.tsx — renders nothing, adds no URL segment.
export function AppFrame() {
  useFileDropGuard();
  return <Outlet />;
}

// src/routes.tsx
export const routes: RouteObject[] = [{ element: <AppFrame />, children: screens }];
```

**Why the route table and not `App`:** `App` builds its own hash router, so nothing that drives
`routes` through a memory router — which is every screen test in this repo — would mount a guard
living there, and **IM7** would be untestable at the route level. Under the layout it covers every
route, including the ones that do not exist yet.

Both listeners coexist with the hook's: `preventDefault` from either is enough, and neither stops
propagation, so ordering does not matter.

### 4.4 Game list — import then open (IM1)

`GameListScreen.importFile` is unchanged through the gates and the collision check; only its tail
changes.

```tsx
const importFile = async (file: File) => {
  setProblems([]); setNotice(null);
  const result = await readDefinitionFile(file);
  if (!result.ok) { setProblems(result.errors); return; }
  const collides = (await getGame(result.definition.id)) !== undefined;
  const id = collides ? newGameId() : result.definition.id;
  await putGame({ ...result.definition, id });
  open(id);                       // was: setNotice(...) + refresh()
};

const dragging = useFileDrop((file) => void importFile(file));
```

`open()` already sets last-opened and navigates to `/game/<id>/pools`. The success notice and the
`refresh()` go with the navigation — the imported game's editor, with its name in the rail, is a
stronger confirmation than a sentence on a screen the user has left. `problems` and the failure path
are untouched: a rejected file leaves the user on the list, looking at the errors (**IM5**).

The overlay, rendered when `dragging`:

```tsx
{dragging && <div className="cb-dropzone" role="status">Drop a game file to import it as a new game</div>}
```

### 4.5 Editor — replace in place (IM3, IM4, IM9)

**State** lives in `AuthoringLayout`, beside the autosave it must coordinate with:

```tsx
const [pending, setPending] = useState<{ fileName: string; definition: GameDefinition } | null>(null);
const [problems, setProblems] = useState<string[]>([]);

/** Gate the file, then WAIT. Nothing is written until the second click. */
const offerReplace = async (file: File) => {
  const result = await readDefinitionFile(file);
  if (!result.ok) { setProblems(result.errors); setPending(null); return; }
  setProblems([]);
  setPending({ fileName: file.name, definition: result.definition });
};

const dragging = useFileDrop((file) => void offerReplace(file));
```

**Commit**, on the second click:

```tsx
const commitReplace = async () => {
  if (pending === null || gameId === undefined) return;
  const next: GameDefinition = {
    ...pending.definition,
    id: gameId,                                 // the URL and the list slot survive; nothing else does
    updatedAt: new Date().toISOString(),        // IM9 — a replace is an edit to this game
  };
  const result = setDefinition(next);           // validates again; a store that refuses cannot be bypassed
  if (!result.ok) { setProblems(result.errors); setPending(null); return; }

  // Ordering, and why each line is where it is:
  autosave.cancel();        // pending edits belong to the definition being overwritten — moot, and
                            // if they landed after the replace they would resurrect the old game.
  loaded.current = next;    // suppresses the autosave effect's own save(): it compares against this
                            // ref. Without it the replace is written twice.
  autosave.save(next);
  await autosave.flush();   // a destructive write is not left sitting in a 500ms debounce window.
  setPending(null);
};
```

`autosave.cancel()` clears only the debounce timer; any in-flight write is already chained onto
`persistence.ts`'s module-wide `writeChain`, and `flush()` awaits that chain — so an old-definition
put that was already enqueued lands *before* the replacement, never after it. This is the same
serialisation the autosave itself relies on (v1 §7.3), reused rather than re-argued.

**Markup** is a small self-contained component so the confirm can be tested without a route, matching
how `Rail` was split out for the same reason:

```tsx
// src/screens/ReplaceGame.tsx — presentational; every decision above it in the tree.
export function ReplaceGame({ gameName, pending, problems, onFilePicked, onConfirm, onCancel }: {
  gameName: string;
  pending: { fileName: string } | null;
  problems: string[];
  onFilePicked: (file: File) => void;
  onConfirm: () => void;
  onCancel: () => void;
})
```

- Idle: a `<label className="cb-btn">Replace from file…<input type="file" accept="application/json,.json" className="cb-visually-hidden" …/></label>` — the same real-`<label>` pattern the game list uses, so the keyboard reaches it with no ref and no synthetic click.
- Pending: `Replace “{gameName}” with {pending.fileName}? This cannot be undone.` plus **Replace for good** (`data-variant="danger"`) and **Cancel** — the shape of the existing delete confirm, so the destructive-confirm pattern in this app stays one pattern (**IM4**).
- Problems: the same `cb-error` list the game list renders.

It renders inside `Rail`, directly under the existing **Export game** button: export and replace are
the two file operations on the open game and belong together.

### 4.6 Edge cases

| # | Case | Behaviour |
|---|---|---|
| 1 | File's `id` equals the open game's id | Replace as normal. Same outcome as any other file; nothing special-cases it. |
| 2 | File's `id` equals a *different* stored game | Replace still writes to the open game's id. The other game is untouched — the file's id is discarded, not honoured. |
| 3 | Any gate fails, from either surface | Nothing written, nothing navigated, errors listed. The open definition is referentially identical (**IM5**). |
| 4 | Drop while a confirm is already pending | The new file replaces the pending offer; still one confirm, now naming the newer file. |
| 5 | Cancel | `pending` cleared, `problems` cleared, no write, no `updatedAt` bump. |
| 6 | Multi-file drop | First file only (§4.2). |
| 7 | `file.text()` rejects (file moved/unreadable) | Caught by `offerReplace` / `importFile` and surfaced in the same `problems` list as a gate error. |
| 8 | Drop on `PlayScreen` or `NotFoundScreen` | Nothing happens, and the tab does not navigate (§4.3). |
| 9 | Replace to a definition the store refuses | Cannot happen — `importJson` ran the same `GameDefinitionSchema` — but it is handled (`result.ok` checked) rather than asserted, because "cannot happen" is what the `loaded`-ref bug in v1 also said. |
| 10 | Route unmounts mid-replace (user clicks away) | `flush()` on unmount already awaits the chain; the write lands. |

## 5. Task plan

Ordered so every step is independently testable and nothing is left half-wired.

| # | Step | Files | Done when |
|---|---|---|---|
| 1 | `readDefinitionFile` | `screens/gameFile.ts` | Unit test: valid file → `ok`, garbage → gate-1 error. |
| 2 | `useFileDrop` + guard | `screens/useFileDrop.ts`, `screens/AppFrame.tsx`, `routes.tsx` | `dragging` flips on enter/leave; a drop on a route that handles none has `defaultPrevented` (**IM7**). |
| 3 | List: import opens the editor | `screens/GameListScreen.tsx` | **IM1**. Existing test `imports a valid file and lists it, without leaving the game list` is rewritten — the old assertion is now the wrong behaviour, and this is the one intentional behaviour change in v3. |
| 4 | List: drop wiring + overlay | `screens/GameListScreen.tsx`, `theme/components.css` | **IM6** (list half), **IM10** (list half). |
| 5 | `ReplaceGame` component | `screens/ReplaceGame.tsx` | Rendered standalone: picker fires `onFilePicked`, confirm needs two clicks, cancel fires `onCancel`. |
| 6 | Layout: replace state + commit + rail slot | `screens/AuthoringLayout.tsx` | **IM3**, **IM4**, **IM5**, **IM9**. |
| 7 | Layout: drop wiring + overlay | `screens/AuthoringLayout.tsx` | **IM6** (editor half), **IM10** (editor half). |
| 8 | Traceability + docs | `test/traceability.test.ts`, `README.md`, this file | `IM1`–`IM10` rows added to `IN_SCOPE`; suite green. |

Steps 1–2 are a prerequisite for everything after; 3–4 and 5–7 are independent of each other.

## 6. Test plan

New file `src/screens/import.test.tsx` for the editor-side and drop behaviour; the existing
`describe('import / export (step 24)')` block in `src/screens/routing.test.tsx` gains the list-side
rows. Both use the existing `routeHarness` (`seedGame`, `openRoute`) and `fake-indexeddb`.

| AC | Proof |
|---|---|
| IM1 | Upload a valid export on `/`; assert `router.state.location.pathname === '/game/<id>/pools'` and the rail shows the imported name. |
| IM2 | Existing test retained (`gives an imported game a new id rather than overwriting…`), plus assert the collided game still `toEqual` its stored value. |
| IM3 | Seed `g1`; open `/game/g1/pools`; replace with an export of a different game; assert route unchanged, `getAllGames()` length unchanged, `getGame('g1')` returns the file's content under id `g1`. |
| IM4 | One click → confirm text naming both file and game, nothing written; Cancel → `getGame('g1')` still the original and `definition()` referentially identical. |
| IM5 | Replace with `{...stored, playerCount: 'two'}` → `playerCount:` error rendered, `getGame('g1')` unchanged. |
| IM6 | `fireEvent.drop(window, { dataTransfer: { types: ['Files'], files: [file] } })` on `/` → imported + navigated; the same drop on `/game/g1/pools` → confirm shown and **nothing written yet**. |
| IM7 | Drop on a route that handles no drops at all (`/nope` → `NotFoundScreen`); assert `defaultPrevented` and that the route did not change. |
| IM8 | `{...stored, schemaVersion: 1}` from the editor surface → the version message; `getGame('g1')` unchanged. |
| IM9 | Replace with a file whose `updatedAt` is `'2020-01-01T00:00:00.000Z'`; assert the stored game's `updatedAt` is not that value. |
| IM10 | `fireEvent.dragEnter(window, {dataTransfer:{types:['Files']}})` → overlay text differs between the two screens; `dragLeave` removes it. |

Notes on mechanics, so the implementer does not discover them the hard way:

- **`user-event` v14 has no file-drop API.** Drops are `createEvent.drop` / `fireEvent` with a plain
  object for `dataTransfer` — jsdom has no `DataTransfer` constructor, and RTL assigns the property
  through. Confirmed working in this jsdom; `createEvent` rather than `fireEvent.drop` because the
  test needs the event object back to read `defaultPrevented` (**IM7**). Events are fired on
  `document.body` and reach the window listeners by bubbling.
- Existing download-spy `beforeEach` in `routing.test.tsx` is reused as-is for anything asserting
  export alongside import.
- `traceability.test.ts` `IN_SCOPE` gains ten rows; each proof carries an `// AC: IMn` marker.

## 7. Risks and deviations

- **One intentional behaviour change:** list import no longer stays on the list (step 3). Called out
  because a passing-test-turned-failing is otherwise indistinguishable from a regression.
- **`updatedAt` on replace deviates from the v1 note** on `GameDefinition.updatedAt` ("import never
  writes it"). That note governs `importJson`, which still writes no timestamp — **AC: P2**'s
  byte-identical round trip is unaffected. The bump happens in the screen, which is where every other
  `updatedAt` write in this app happens.
- **Window-level listeners are global state.** Two screens mounting the hook simultaneously cannot
  happen with this route table (list and authoring layout are never both mounted), but the hook does
  not enforce it. If that ever changes, both handlers fire on the same drop — a chooser, or a single
  app-level owner, is the fix. Not built now (§3 decision 3).
- **Two screens now render `role="status"` for the drop affordance**, alongside the rail's
  game-level error and the confirm. They are never simultaneous in practice, but a test that reaches
  for `getByRole('status')` on a game that *does* have a game-level error will find two.
- **No undo.** Accepted per §3 decision 4. If the confirm proves insufficient in use, the cheapest
  upgrade is holding the pre-replace definition in a ref and offering "Undo replace" until the route
  unmounts — roughly ten lines, and no schema or storage change, because the old definition is
  already in memory at commit time.
