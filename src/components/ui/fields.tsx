import { useEffect, useId, useState } from 'react';

/**
 * The two form controls the authoring screens share, plus the store-rejection readout (§8 step 21).
 *
 * `SelectField` used to live inside `ValueRefPicker`; it moved here the moment a second caller
 * appeared rather than being copied, because a forked label/id wiring is exactly the kind of drift
 * nobody notices until a screen reader user does.
 */
export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="cb-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="cb-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * A single choice that sits *inside* a sentence (§6.8): "( Subtract ▾ ) 1 from ( HP ▾ )".
 *
 * A `<select>` rather than a chip popover, styled to read as one. §6.8 asks for chips, and chips
 * earn it wherever a part has several fields behind it — but a popover to pick one of three words
 * is more clicks, more code, and less keyboard than the control the platform already ships. The
 * label is the accessible name only: a visible one would break the sentence it belongs to.
 */
export function InlineSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <select
      className="cb-inline-select"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * The sentence's inline number: "create ( 3 ) cards". Same reasoning as `InlineSelect`.
 *
 * It keeps the typed text, not `String(value)`: a field that re-derives its text from the committed
 * number cannot be cleared and retyped — emptying it commits `0`, the `0` comes straight back, and
 * the next keystroke lands *after* it, so typing "20" into a cleared field yields 20 only by luck
 * and 120 the moment anything clamps. An empty box commits nothing and waits.
 */
export function InlineNumber({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
}) {
  const [draft, setDraft] = useState(String(value));

  // Re-sync only when the committed value is genuinely something else — switching to another
  // entity, or a rejected edit snapping back — never while the draft already means that number.
  useEffect(() => {
    setDraft((current) => (Number(current) === value ? current : String(value)));
  }, [value]);

  return (
    <input
      className="cb-inline-number"
      type="number"
      min={min}
      aria-label={label}
      value={draft}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        const parsed = Number(text);
        if (text.trim() !== '' && Number.isFinite(parsed)) onChange(parsed);
      }}
    />
  );
}

/**
 * Nullable on purpose: pool `min`/`max` and zone `maxCapacity` are all "a number, or nothing at all"
 * (§4.1, §4.5), and empty-string-means-null is the only reading of a cleared number input that
 * doesn't invent a 0 the designer never typed — which for `min` would silently clamp their pool.
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  hint,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="cb-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="cb-input"
        type="number"
        min={min}
        value={value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
      {hint !== undefined && <span className="cb-hint">{hint}</span>}
    </div>
  );
}

/**
 * Every rejected edit, verbatim from `validateDefinition`. `role="alert"` because the rejection
 * happens away from the control that caused it — the field keeps the value the designer typed while
 * the store still holds the last good one, and without an announcement that reads as a dead UI.
 */
export function FormErrors({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <ul className="cb-list" role="alert">
      {errors.map((error) => (
        <li key={error} className="cb-list__row cb-error">
          {error}
        </li>
      ))}
    </ul>
  );
}
