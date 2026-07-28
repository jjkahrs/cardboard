import { useId } from 'react';
import { describeValueRef } from '../../engine/prose';
import type { ActionRef, GameDefinition, ValueRef } from '../../engine/types';
import { CardRefChip } from '../authoring/CardRefChip';
import type { RefContext } from '../authoring/refs';
import { SeatRefChip } from '../authoring/SeatRefChip';
import { ChipPopover } from '../ui/ChipPopover';
import { SelectField } from '../ui/fields';
import { allIndexes, isDangling } from './isDangling';

export interface ValueRefPickerProps {
  value: ValueRef;
  onChange: (next: ValueRef) => void;
  definition: GameDefinition;
  /** Which half of the sentence this is ("left side", "amount") — the chip text alone is a value. */
  ariaLabel?: string;
  /** §6.11 — gates `replacedAmount` here, and the `candidate` row of the `CardRef`s below. */
  context?: RefContext;
}

const KINDS: { kind: ValueRef['kind']; label: string }[] = [
  { kind: 'literal', label: 'A number' },
  { kind: 'pool', label: 'A pool' },
  { kind: 'cardIndex', label: 'A card index' },
  { kind: 'zoneCount', label: 'Cards in a zone' },
  { kind: 'cardTag', label: 'Whether a card has a tag' },
  { kind: 'activeSeatCount', label: 'Players still in the game' },
  { kind: 'actionField', label: 'Something about a pending action' },
  { kind: 'replacedAmount', label: 'The replaced amount' },
];

/**
 * `{kind:'action', id}` names a runtime id no author can know, so it is omitted for exactly the
 * reason `promptAnswer` and `instance` are omitted from `CardRefChip` — nothing to pick at edit time.
 */
const ACTION_REFS: { value: ActionRef['kind']; label: string }[] = [
  { value: 'triggeringAction', label: 'the action this is responding to' },
  { value: 'topOfStack', label: 'the top action on the stack' },
];

const ACTION_FIELDS = [
  { value: 'controller', label: 'who controls it' },
  { value: 'targetCount', label: 'how many targets it has' },
];

/**
 * The chip popover that resolves a ValueRef: literal, pool, card index or zone count (§6.2).
 *
 * `promptAnswer` and `instance` card refs are deliberately not offered — both only exist during a
 * running session, so there is nothing an author could pick here. `triggering` and "top of zone"
 * are the two an author can actually mean.
 */
export function ValueRefPicker({
  value,
  onChange,
  definition,
  ariaLabel,
  context,
}: ValueRefPickerProps) {
  const kindName = useId();
  const tagId = useId();
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
      case 'activeSeatCount':
        return { kind: 'activeSeatCount' };
      case 'cardTag':
        return { kind: 'cardTag', card: { kind: 'triggering' }, tag: '' };
      case 'replacedAmount':
        return { kind: 'replacedAmount' };
      case 'actionField':
        return { kind: 'actionField', action: { kind: 'topOfStack' }, field: 'controller' };
      // v2 §4.2, §8 step 28 — same reasoning: not offered here, arm exists for exhaustiveness only.
      case 'promptNumber':
        return { kind: 'promptNumber', key: '' };
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
              // Nothing to point at yet, or nothing this ref could bind to here (§6.11): disabled
              // with the reason, rather than an option that silently produces a broken reference.
              const blocked =
                kind === 'replacedAmount' && context !== 'replacement'
                  ? 'only inside a replacement rule'
                  : fallback === null
                    ? 'none defined yet'
                    : null;
              return (
                <label key={kind} className="cb-radio">
                  <input
                    type="radio"
                    name={kindName}
                    checked={value.kind === kind}
                    disabled={blocked !== null}
                    onChange={() => fallback && onChange(fallback)}
                  />
                  {label}
                  {blocked !== null && <span className="cb-hint"> — {blocked}</span>}
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
                <div className="cb-field">
                  <span>Of</span>
                  <SeatRefChip
                    ariaLabel="Of"
                    seat={value.seat}
                    definition={definition}
                    context={context}
                    // Mirrors `schema.ts`'s refinement rather than restating it: `sum` needs a total,
                    // and a boolean pool has none.
                    numeric={
                      definition.pools.find((p) => p.id === value.poolId)?.value.type !== 'boolean'
                    }
                    onChange={(seat) => onChange({ ...value, seat })}
                  />
                </div>
              )}
            </>
          )}

          {/* Both refs that carry a card ask the same question, so they share one control. This is
              what replaces `cardIndex`'s hard-coded `{kind:'triggering'}` (§6.10). */}
          {'card' in value && (
            <div className="cb-field">
              <span>Card</span>
              <CardRefChip
                ariaLabel="Card"
                card={value.card}
                definition={definition}
                context={context}
                onChange={(card) => onChange({ ...value, card })}
              />
            </div>
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

          {value.kind === 'cardTag' && (
            <div className="cb-field">
              <label htmlFor={tagId}>Tag</label>
              <input
                id={tagId}
                className="cb-input"
                value={value.tag}
                onChange={(e) => onChange({ ...value, tag: e.target.value })}
              />
            </div>
          )}

          {value.kind === 'actionField' && (
            <>
              <SelectField
                label="Action"
                value={value.action.kind}
                // An imported `{kind:'action', id}` keeps its own row so the select never renders
                // blank; it is not otherwise offered.
                options={
                  value.action.kind === 'action'
                    ? [...ACTION_REFS, { value: 'action', label: `action ${value.action.id}` }]
                    : ACTION_REFS
                }
                onChange={(kind) =>
                  kind !== 'action' &&
                  onChange({ ...value, action: { kind: kind as 'triggeringAction' | 'topOfStack' } })
                }
              />
              <SelectField
                label="Field"
                value={value.field}
                options={ACTION_FIELDS}
                onChange={(field) =>
                  onChange({ ...value, field: field as 'controller' | 'targetCount' })
                }
              />
            </>
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
                <div className="cb-field">
                  <span>Owned by</span>
                  <SeatRefChip
                    ariaLabel="Owned by"
                    seat={value.zone.seat}
                    definition={definition}
                    context={context}
                    // A card count is always a number, so `sum` is legal here unconditionally.
                    numeric
                    onChange={(seat) =>
                      onChange({ kind: 'zoneCount', zone: { ...value.zone, seat } })
                    }
                  />
                </div>
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
