import { useId, useState } from 'react';
import { EntityList } from '../../components/ui/EntityList';
import { FormErrors, InlineNumber, SelectField } from '../../components/ui/fields';
import type { GameDefinition, PriorityWindow } from '../../engine/types';
import { findReferrers, useDefinitionStore, type EditResult } from '../../stores/definitionStore';
import { uniqueName } from './uniqueName';

const STARTS = [
  { value: 'active', label: 'The acting seat' },
  { value: 'triggeringSeat', label: 'The seat that triggered it' },
  { value: 'controllerOfAction', label: 'The controller of the action' },
];

const DIRECTIONS = [
  { value: 'forward', label: 'Forward — the usual turn order' },
  { value: 'backward', label: 'Backward — against turn order' },
];

const START_SUMMARY: Record<PriorityWindow['start'], string> = {
  active: 'from the acting seat',
  triggeringSeat: 'from the triggering seat',
  controllerOfAction: 'from the action’s controller',
};

/**
 * `/game/:gameId/priority` — priority windows (§4.6, §6.9). Master list plus a detail pane, the
 * same shape as five other authoring screens, because a `PriorityWindow` is six scalar fields and
 * references no other window: there are no edges, so there is no graph to draw.
 *
 * The one thing worth building here is `<PollOrderPreview>`, the analogue of the rule editor's
 * READS AS prose: `start` × `direction` × `includeStart` is the only combination on this screen
 * nobody can hold in their head.
 */
export function PriorityWindowsScreen() {
  const definition = useDefinitionStore((s) => s.definition);
  const addPriorityWindow = useDefinitionStore((s) => s.addPriorityWindow);
  const updatePriorityWindow = useDefinitionStore((s) => s.updatePriorityWindow);
  const removePriorityWindow = useDefinitionStore((s) => s.removePriorityWindow);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const includeStartId = useId();
  const wholeTableId = useId();
  const collapseId = useId();

  const selected = definition.priorityWindows.find((w) => w.id === selectedId) ?? null;

  const report = (result: EditResult): EditResult => {
    setErrors(result.ok ? [] : result.errors);
    return result;
  };

  const add = () => {
    const result = report(
      addPriorityWindow({
        name: uniqueName(definition.priorityWindows.map((w) => w.name), 'New window'),
        start: 'active',
        direction: 'forward',
        includeStart: true,
        passesToClose: null,
        collapseEmptyOffers: true,
      })
    );
    if (result.ok && result.id !== undefined) setSelectedId(result.id);
  };

  const patch = (patch: Partial<Omit<PriorityWindow, 'id'>>) => {
    if (selected) report(updatePriorityWindow(selected.id, patch));
  };

  return (
    <main className="cb-screen">
      <header className="cb-screen__head">
        <h1>Priority</h1>
      </header>
      <p className="cb-hint">
        A priority window is the poll that runs when something is announced: who gets offered a
        response, in what order, and what closes it. Rules and effects point at a window by name.
      </p>

      <div className="cb-master-detail">
        <EntityList
          label="Windows"
          addLabel="Add window"
          emptyHint="No windows yet. One “anyone may respond” window covers most games."
          items={definition.priorityWindows.map((window) => ({
            id: window.id,
            name: window.name,
            detail: describeWindow(window),
          }))}
          selectedId={selected?.id}
          onSelect={setSelectedId}
          onAdd={add}
          onRename={(id, name) => report(updatePriorityWindow(id, { name }))}
          onDelete={(id) => void report(removePriorityWindow(id))}
          referrersOf={(id) => findReferrers(definition, 'priorityWindow', id)}
        />

        <section className="cb-panel cb-detail" aria-label="Window settings">
          <span className="cb-rough" aria-hidden="true" />
          {selected === null ? (
            <p className="cb-hint">Pick a window to edit it.</p>
          ) : (
            <>
              <h2>{selected.name}</h2>
              <FormErrors errors={errors} />

              <SelectField
                label="Poll starts at"
                value={selected.start}
                options={STARTS}
                onChange={(start) => patch({ start: start as PriorityWindow['start'] })}
              />
              <SelectField
                label="Direction"
                value={selected.direction}
                options={DIRECTIONS}
                onChange={(direction) =>
                  patch({ direction: direction as PriorityWindow['direction'] })
                }
              />

              <div className="cb-field">
                <label htmlFor={includeStartId}>Include the starting seat</label>
                <input
                  id={includeStartId}
                  type="checkbox"
                  checked={selected.includeStart}
                  onChange={(e) => patch({ includeStart: e.target.checked })}
                />
                <span className="cb-hint">
                  Off means the starting seat is skipped — you do not get to respond to your own
                  action.
                </span>
              </div>

              <div className="cb-field">
                <label htmlFor={wholeTableId}>Poll the whole table instead</label>
                <input
                  id={wholeTableId}
                  type="checkbox"
                  checked={selected.passesToClose === null}
                  // The `null` of `passesToClose` is a checkbox, not an empty number box: an empty
                  // box that silently means "every live seat" is a magic state nobody would guess.
                  onChange={(e) => patch({ passesToClose: e.target.checked ? null : 1 })}
                />
                <span className="cb-hint">
                  Closes once every seat still in the game has passed in a row — the count is read
                  live, so an elimination mid-window shortens it.
                </span>
              </div>

              {selected.passesToClose !== null && (
                <div className="cb-field">
                  <span>
                    Closes after{' '}
                    <InlineNumber
                      label="Consecutive passes to close"
                      min={1}
                      value={selected.passesToClose}
                      onChange={(passesToClose) => patch({ passesToClose })}
                    />{' '}
                    consecutive passes
                  </span>
                </div>
              )}

              <div className="cb-field">
                <label htmlFor={collapseId}>Skip seats with no legal response</label>
                <input
                  id={collapseId}
                  type="checkbox"
                  checked
                  disabled
                  readOnly
                  aria-describedby={`${collapseId}-why`}
                />
                <span className="cb-hint" id={`${collapseId}-why`}>
                  Always on, and not editable. A seat with nothing it could legally do auto-passes
                  and writes no log entry — an offer nobody could take is noise, not a decision.
                </span>
              </div>

              <PollOrderPreview window={selected} playerCount={definition.playerCount} />

              <p className="cb-hint">
                Used by {findReferrers(definition, 'priorityWindow', selected.id).length} place(s).
              </p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

/** The list's second line. */
function describeWindow(window: PriorityWindow): string {
  const parts = [
    START_SUMMARY[window.start],
    window.direction,
    window.includeStart ? 'includes the start' : 'skips the start',
    window.passesToClose === null
      ? 'closes on a full table pass'
      : `closes after ${window.passesToClose} pass${window.passesToClose === 1 ? '' : 'es'}`,
  ];
  return parts.join(' · ');
}

/**
 * Who gets asked, in what order (§6.9) — a row of divs with ordinals and arrows, no canvas.
 *
 * It mirrors `resolveWindowOrder` (`priority.ts:147`) exactly: step the ring from the starting seat
 * in `direction`, then drop the first entry when `includeStart` is false. What it CANNOT mirror is
 * the ring itself, so the hint says so rather than implying otherwise: this is a nominal table of
 * `playerCount` seats with nobody eliminated, and the live poll runs over `seatOrder` (§5.5), which
 * is shorter after an oust. All three `start` values land on the same nominal seat — P1 here is
 * "whichever seat that rule picks", which is why the label says it.
 */
export function PollOrderPreview({
  window,
  playerCount,
}: {
  window: PriorityWindow;
  playerCount: GameDefinition['playerCount'];
}) {
  const n = Math.max(1, playerCount);
  const stepped = Array.from({ length: n }, (_, i) =>
    window.direction === 'forward' ? i % n : (n - i) % n
  );
  const asked = window.includeStart ? stepped : stepped.slice(1);

  return (
    <div className="cb-field">
      <span>Polls as</span>
      {/* ponytail: .cb-effect is already "flex row, wrap, centred, gapped" — no new class for a
          second thing shaped like a row. */}
      <ol className="cb-effect" aria-label="Poll order">
        {stepped.map((seat, i) => {
          const at = asked.indexOf(seat);
          return (
            <li key={seat}>
              {i > 0 && (
                <span className="cb-effect__ordinal" aria-hidden="true">
                  {'→ '}
                </span>
              )}
              P{seat + 1}
              <span className="cb-effect__ordinal">
                {i === 0 && ' start'}
                {at === -1 ? ' · skipped' : ` · #${at + 1}`}
              </span>
            </li>
          );
        })}
      </ol>
      <span className="cb-hint">
        A nominal table of {n} seat{n === 1 ? '' : 's'} with nobody eliminated, starting at{' '}
        {START_SUMMARY[window.start]} — shown as P1. The live order comes from the seats still in
        the game when the window opens, so after an elimination the real poll is shorter.
      </span>
    </div>
  );
}
