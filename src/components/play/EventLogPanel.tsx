import { useEffect, useRef, useState } from 'react';
import type { LogEntry, LogLine } from '../../engine/types';

/**
 * The right rail (§6.6): every entry, its lines, and rewind.
 *
 * Hovering (or focusing) an entry's rewind control dims and strikes through every LATER entry —
 * a live preview of exactly what would be discarded, before the click. Confirmation is inline
 * rather than a modal because rewind is frequent during a playtest.
 */
export function EventLogPanel({
  log,
  onRewind,
}: {
  log: LogEntry[];
  onRewind: (length: number) => void;
}) {
  /** Entry seq whose rewind is being previewed, and the one awaiting confirmation. */
  const [preview, setPreview] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  /** "↺ rewound to 12" notes, so the history OF rewinding is itself visible (§6.6). */
  const [rewinds, setRewinds] = useState<number[]>([]);
  const tail = useRef<HTMLDivElement>(null);
  const atTail = useRef(true);

  useEffect(() => {
    // Auto-scroll to the newest entry, unless the tester has scrolled up to read something.
    // Assignment rather than `scrollTo`: same effect, and jsdom implements the property but not
    // the method, so this stays exercisable in tests.
    if (atTail.current && tail.current) tail.current.scrollTop = tail.current.scrollHeight;
  }, [log.length]);

  const rewindTo = (seq: number) => {
    setConfirming(null);
    setPreview(null);
    setRewinds((previous) => [...previous, seq]);
    onRewind(seq); // keep entries [0, seq) — the entry hovered is itself discarded
  };

  return (
    <aside className="cb-panel cb-log" aria-label="Event log">
      <span className="cb-rough" aria-hidden="true" />
      <h2>Log</h2>

      <div
        className="cb-log__entries"
        ref={tail}
        onScroll={(e) => {
          const el = e.currentTarget;
          atTail.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {log.length === 0 && <p className="cb-log__empty">Nothing has happened yet.</p>}

        {log.map((entry) => (
          <article
            key={entry.seq}
            className="cb-log__entry"
            data-doomed={preview !== null && entry.seq >= preview}
            aria-label={`Entry ${entry.seq}`}
          >
            <header className="cb-log__head">
              <span className="cb-log__seq">{entry.seq}</span>
              <span>▸ {entry.cause.description}</span>
              {entry.flags.override && <span title="Designer override">⚑</span>}
              {entry.flags.haltedByLoopGuard && <span title="Halted by the loop guard">⚠</span>}
              {entry.flags.suspended && <span title="Waiting for a prompt answer">⏸</span>}
            </header>

            {entry.lines.map((line, i) => (
              // Lines are display-only detail inside one entry and never reorder — index keys are
              // exactly right here, unlike the card slots on the table (§9.4 item 16).
              <p key={i} className="cb-log__line" data-level={line.level} data-kind={line.kind}>
                <span aria-hidden="true">{glyph(line)}</span>
                <span>{line.message}</span>
                {line.change && (
                  <span>
                    {' '}
                    {String(line.change.before)} → {String(line.change.after)}
                  </span>
                )}
              </p>
            ))}

            {confirming === entry.seq ? (
              <span>
                <button type="button" className="cb-btn" data-variant="danger" onClick={() => rewindTo(entry.seq)}>
                  Discard {log.length - entry.seq}{' '}
                  {log.length - entry.seq === 1 ? 'entry' : 'entries'}?
                </button>
                <button type="button" className="cb-btn" data-variant="ghost" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="cb-btn"
                data-variant="ghost"
                aria-label={`Rewind to entry ${entry.seq}`}
                onMouseEnter={() => setPreview(entry.seq)}
                onMouseLeave={() => setPreview(null)}
                onFocus={() => setPreview(entry.seq)}
                onBlur={() => setPreview(null)}
                onClick={() => setConfirming(entry.seq)}
              >
                ↩ rewind to here
              </button>
            )}
          </article>
        ))}

        {rewinds.map((seq, i) => (
          <p key={`${seq}-${i}`} className="cb-log__marker">
            ↺ rewound to {seq}
          </p>
        ))}
      </div>
    </aside>
  );
}

/** §6.6's glyph vocabulary. Level wins over kind: a rejected move is a rejection first. */
function glyph(line: LogLine): string {
  if (line.level === 'reject' || line.level === 'error') return '✖';
  if (line.level === 'override') return '⚑';
  if (line.level === 'warn') return '⚠';
  switch (line.kind) {
    case 'event':
      return '▸';
    case 'rule':
      return '⤷';
    case 'transition':
      return '⟳';
    case 'prompt':
      return '⏸';
    default:
      return '·';
  }
}

// ponytail: no [filter ▾] control (§6.4's sketch shows one). Every line is rendered and Ctrl-F
// finds it; add a level filter the first time a real playtest log is too noisy to read.
