import { useId } from 'react';
import { describeValueRef } from '../../engine/prose';
import type { GameDefinition, ValueRef } from '../../engine/types';
import { ChipPopover } from '../ui/ChipPopover';
import { SelectField } from '../ui/fields';
import { SeatSelect } from './SeatSelect';
import { allIndexes, isDangling } from './isDangling';

export interface ValueRefPickerProps {
  value: ValueRef;
  onChange: (next: ValueRef) => void;
  definition: GameDefinition;
  /** Which half of the sentence this is ("left side", "amount") — the chip text alone is a value. */
  ariaLabel?: string;
}

const KINDS: { kind: ValueRef['kind']; label: string }[] = [
  { kind: 'literal', label: 'A number' },
  { kind: 'pool', label: 'A pool' },
  { kind: 'cardIndex', label: 'A card index' },
  { kind: 'zoneCount', label: 'Cards in a zone' },
];

/**
 * The chip popover that resolves a ValueRef: literal, pool, card index or zone count (§6.2).
 *
 * `promptAnswer` and `instance` card refs are deliberately not offered — both only exist during a
 * running session, so there is nothing an author could pick here. `triggering` and "top of zone"
 * are the two an author can actually mean.
 */
export function ValueRefPicker({ value, onChange, definition, ariaLabel }: ValueRefPickerProps) {
  const kindName = useId();
  const indexes = allIndexes(definition);

  /** Sensible starting point per kind, so switching kind never yields a dangling ref. */
  const defaultFor = (kind: ValueRef['kind']): ValueRef | null => {
    switch (kind) {
      case 'literal':
        return { kind: 'literal', value: 0 };
      case 'pool': {
        const pool = definition.pools[0];
        if (!pool) return null;
        return { kind: 'pool', poolId: pool.id, seat: pool.scope === 'player' ? { kind: 'active' } : null };
      }
      case 'cardIndex': {
        const first = indexes[0];
        if (!first) return null;
        return { kind: 'cardIndex', card: { kind: 'triggering' }, indexId: first.index.id };
      }
      case 'zoneCount': {
        const zone = definition.zones[0];
        if (!zone) return null;
        return {
          kind: 'zoneCount',
          zone: { zoneId: zone.id, seat: zone.scope === 'player' ? { kind: 'active' } : null },
        };
      }
      // Not offered in VALUE_REF_KINDS — authoring for §4's new refs is phase 4 (§6.10). The arm is
      // here for the exhaustiveness check alone.
      case 'activeSeatCount':
        return { kind: 'activeSeatCount' };
      case 'cardTag':
        return { kind: 'cardTag', card: { kind: 'triggering' }, tag: '' };
      // v2 §4.2 — same reasoning: not offered here (§6.10's own new `ActionSelectorChip`/`CardRefChip`
      // widgets land in phase 4), arm exists for exhaustiveness only.
      case 'replacedAmount':
        return { kind: 'replacedAmount' };
      case 'actionField':
        return { kind: 'actionField', action: { kind: 'topOfStack' }, field: 'controller' };
    }
  };

  return (
    <ChipPopover
      label={describeValueRef(value, definition)}
      ariaLabel={ariaLabel}
      danger={isDangling(value, definition)}
    >
      {() => (
        <>
          <fieldset className="cb-fieldset">
            <legend>Value</legend>
            {KINDS.map(({ kind, label }) => {
              const fallback = defaultFor(kind);
              return (
                <label key={kind} className="cb-radio">
                  <input
                    type="radio"
                    name={kindName}
                    checked={value.kind === kind}
                    // Nothing to point at yet: disabled with the reason, rather than an option that
                    // silently produces a broken reference.
                    disabled={fallback === null}
                    onChange={() => fallback && onChange(fallback)}
                  />
                  {label}
                  {fallback === null && <span className="cb-hint"> — none defined yet</span>}
                </label>
              );
            })}
          </fieldset>

          {value.kind === 'literal' && (
            <LiteralFields value={value} onChange={onChange} />
          )}

          {value.kind === 'pool' && (
            <>
              <SelectField
                label="Pool"
                value={value.poolId}
                options={definition.pools.map((p) => ({ value: p.id, label: p.value.name }))}
                onChange={(poolId) => {
                  const pool = definition.pools.find((p) => p.id === poolId);
                  onChange({
                    kind: 'pool',
                    poolId,
                    // A game-scoped pool has exactly one value; carrying a seat would be a lie.
                    seat: pool?.scope === 'player' ? (value.seat ?? { kind: 'active' }) : null,
                  });
                }}
              />
              {value.seat !== null && (
                <SeatSelect
                  label="Of"
                  seat={value.seat}
                  definition={definition}
                  onChange={(seat) => onChange({ ...value, seat })}
                />
              )}
            </>
          )}

          {value.kind === 'cardIndex' && (
            <SelectField
              label="Index"
              value={value.indexId}
              options={indexes.map(({ template, index }) => ({
                value: index.id,
                label: `${index.value.name} (${template.name})`,
              }))}
              onChange={(indexId) => onChange({ ...value, indexId })}
            />
          )}

          {value.kind === 'zoneCount' && (
            <>
              <SelectField
                label="Zone"
                value={value.zone.zoneId}
                options={definition.zones.map((z) => ({ value: z.id, label: z.name }))}
                onChange={(zoneId) => {
                  const zone = definition.zones.find((z) => z.id === zoneId);
                  onChange({
                    kind: 'zoneCount',
                    zone: {
                      zoneId,
                      seat: zone?.scope === 'player' ? (value.zone.seat ?? { kind: 'active' }) : null,
                    },
                  });
                }}
              />
              {value.zone.seat !== null && (
                <SeatSelect
                  label="Owned by"
                  seat={value.zone.seat}
                  definition={definition}
                  onChange={(seat) => onChange({ kind: 'zoneCount', zone: { ...value.zone, seat } })}
                />
              )}
            </>
          )}
        </>
      )}
    </ChipPopover>
  );
}

function LiteralFields({
  value,
  onChange,
}: {
  value: Extract<ValueRef, { kind: 'literal' }>;
  onChange: (next: ValueRef) => void;
}) {
  const id = useId();
  const isBoolean = typeof value.value === 'boolean';

  return (
    <>
      <SelectField
        label="Type"
        value={isBoolean ? 'boolean' : 'number'}
        options={[
          { value: 'number', label: 'Number' },
          { value: 'boolean', label: 'True / false' },
        ]}
        onChange={(type) =>
          onChange({ kind: 'literal', value: type === 'boolean' ? true : Number(value.value) || 0 })
        }
      />
      {isBoolean ? (
        <SelectField
          label="Value"
          value={String(value.value)}
          options={[
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' },
          ]}
          onChange={(v) => onChange({ kind: 'literal', value: v === 'true' })}
        />
      ) : (
        <div className="cb-field">
          <label htmlFor={id}>Value</label>
          <input
            id={id}
            className="cb-input"
            type="number"
            value={String(value.value)}
            onChange={(e) => onChange({ kind: 'literal', value: Number(e.target.value) })}
          />
        </div>
      )}
    </>
  );
}
