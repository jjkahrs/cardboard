import type { Effect, GameDefinition, InsertPosition, NumericOp, SeatRef } from '../../engine/types';
import { optionToSeat, seatOptions, seatToOption } from '../criteria/seatRef';
import { ValueRefPicker } from '../criteria/ValueRefPicker';
import { allIndexes } from '../criteria/isDangling';
import { InlineNumber, InlineSelect } from '../ui/fields';
import { TargetSelectorChip } from './TargetSelectorChip';
import { prompts } from './targetSelector';
import { ZoneRefChip } from './ZoneRefChip';
import { zoneRefFor } from './zoneRef';
import { EFFECT_KINDS, defaultEffect, missingFor } from './effectKinds';

const OPS: { value: NumericOp; label: string }[] = [
  { value: 'add', label: 'Add' },
  { value: 'subtract', label: 'Subtract' },
  { value: 'set', label: 'Set' },
];

/** "add 1 **to** HP" but "subtract 1 **from** HP" — the sentence has to survive the op change. */
const opPreposition = (op: NumericOp): string => (op === 'subtract' ? 'from' : 'to');

const POSITIONS = [
  { value: 'top', label: 'the top' },
  { value: 'bottom', label: 'the bottom' },
  { value: 'index', label: 'a position' },
];

const positionValue = (p: InsertPosition): string => (typeof p === 'string' ? p : 'index');

export interface EffectRowProps {
  effect: Effect;
  index: number;
  total: number;
  definition: GameDefinition;
  onChange: (effect: Effect) => void;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
}

/**
 * One effect as one line of prose whose variable parts are controls (§6.8) — the designer reads the
 * rule instead of decoding a form.
 *
 * Reordering is `▲`/`▼` buttons: they are the keyboard-reachable mechanism, and §6.8's drag handle
 * reuses `GapDroppable`, which arrives with the dnd wiring in step 26.
 */
export function EffectRow({
  effect,
  index,
  total,
  definition,
  onChange,
  onMove,
  onRemove,
}: EffectRowProps) {
  const pauses = 'target' in effect && prompts(effect.target);

  return (
    <li className="cb-effect" data-prompts={pauses ? '1' : undefined}>
      <span className="cb-effect__ordinal">{index + 1}.</span>

      <span className="cb-effect__sentence">
        <InlineSelect
          label={`Effect ${index + 1} kind`}
          value={effect.kind}
          options={EFFECT_KINDS.map(({ kind, label }) => {
            const missing = missingFor(kind, definition);
            return { value: kind, label: missing === '' ? label : `${label} (${missing})` };
          })}
          onChange={(kind) => {
            const next = defaultEffect(kind as Effect['kind'], definition, effect);
            if (next) onChange(next);
          }}
        />
        <EffectSentence effect={effect} definition={definition} onChange={onChange} />
      </span>

      {pauses && (
        <span className="cb-effect__pause">⏸ execution pauses here until the player answers</span>
      )}

      <span className="cb-effect__actions">
        <button
          type="button"
          className="cb-btn"
          data-variant="ghost"
          aria-label={`Move effect ${index + 1} up`}
          disabled={index === 0}
          onClick={() => onMove(index, index - 1)}
        >
          ▲
        </button>
        <button
          type="button"
          className="cb-btn"
          data-variant="ghost"
          aria-label={`Move effect ${index + 1} down`}
          disabled={index === total - 1}
          onClick={() => onMove(index, index + 1)}
        >
          ▼
        </button>
        <button
          type="button"
          className="cb-btn"
          data-variant="danger"
          aria-label={`Remove effect ${index + 1}`}
          onClick={onRemove}
        >
          ✕
        </button>
      </span>
    </li>
  );
}

/**
 * The parts after the verb, per kind. A `switch` over the same eleven cases the engine applies and
 * `prose.ts` describes: when a twelfth effect lands, all three fail to compile together.
 */
function EffectSentence({
  effect,
  definition,
  onChange,
}: {
  effect: Effect;
  definition: GameDefinition;
  onChange: (effect: Effect) => void;
}) {
  switch (effect.kind) {
    case 'moveCards':
      return (
        <>
          <TargetSelectorChip
            selector={effect.target}
            definition={definition}
            ariaLabel="Which cards"
            onChange={(target) => onChange({ ...effect, target })}
          />
          {' to '}
          <PositionControl
            position={effect.position}
            onChange={(position) => onChange({ ...effect, position })}
          />
          {' of '}
          <ZoneRefChip
            zone={effect.to}
            definition={definition}
            ariaLabel="Destination zone"
            onChange={(to) => onChange({ ...effect, to })}
          />
        </>
      );

    case 'drawCards':
      return (
        <>
          <ValueRefPicker
            value={effect.count}
            definition={definition}
            ariaLabel="How many cards"
            onChange={(count) => onChange({ ...effect, count })}
          />
          {' cards from '}
          <ZoneRefChip
            zone={effect.from}
            definition={definition}
            ariaLabel="Source zone"
            onChange={(from) => onChange({ ...effect, from })}
          />
          {' to '}
          <ZoneRefChip
            zone={effect.to}
            definition={definition}
            ariaLabel="Destination zone"
            onChange={(to) => onChange({ ...effect, to })}
          />
        </>
      );

    case 'shuffleZone':
      return (
        <ZoneRefChip
          zone={effect.zone}
          definition={definition}
          ariaLabel="Zone to shuffle"
          onChange={(zone) => onChange({ ...effect, zone })}
        />
      );

    case 'changePool': {
      const pool = definition.pools.find((p) => p.id === effect.poolId);
      return (
        <>
          <InlineSelect
            label="Operation"
            value={effect.op}
            options={OPS}
            onChange={(op) => onChange({ ...effect, op: op as NumericOp })}
          />
          <ValueRefPicker
            value={effect.amount}
            definition={definition}
            ariaLabel="Amount"
            onChange={(amount) => onChange({ ...effect, amount })}
          />
          {` ${opPreposition(effect.op)} `}
          <InlineSelect
            label="Pool"
            value={effect.poolId}
            options={definition.pools.map((p) => ({ value: p.id, label: p.value.name }))}
            onChange={(poolId) => {
              const next = definition.pools.find((p) => p.id === poolId);
              // A game-scoped pool holds one value; keeping a seat on it would be a lie the engine
              // has to guess its way out of.
              onChange({
                ...effect,
                poolId,
                seat: next?.scope === 'player' ? (effect.seat ?? { kind: 'active' }) : null,
              });
            }}
          />
          {effect.seat !== null && (
            <>
              {' of '}
              <SeatInline
                seat={effect.seat}
                definition={definition}
                onChange={(seat) => onChange({ ...effect, seat })}
              />
            </>
          )}
          {pool === undefined && <span className="cb-error">this pool was deleted</span>}
        </>
      );
    }

    case 'setCardIndex':
      return (
        <>
          <InlineSelect
            label="Operation"
            value={effect.op}
            options={OPS}
            onChange={(op) => onChange({ ...effect, op: op as NumericOp })}
          />
          <ValueRefPicker
            value={effect.amount}
            definition={definition}
            ariaLabel="Amount"
            onChange={(amount) => onChange({ ...effect, amount })}
          />
          {` ${opPreposition(effect.op)} `}
          <InlineSelect
            label="Card number"
            value={effect.indexId}
            options={allIndexes(definition).map(({ template, index }) => ({
              value: index.id,
              label: `${index.value.name} (${template.name})`,
            }))}
            onChange={(indexId) => onChange({ ...effect, indexId })}
          />
          {' of '}
          <TargetSelectorChip
            selector={effect.target}
            definition={definition}
            ariaLabel="Which cards"
            onChange={(target) => onChange({ ...effect, target })}
          />
        </>
      );

    case 'flipCard':
      return (
        <>
          <TargetSelectorChip
            selector={effect.target}
            definition={definition}
            ariaLabel="Which cards"
            onChange={(target) => onChange({ ...effect, target })}
          />
          <InlineSelect
            label="Facing"
            value={effect.to}
            options={[
              { value: 'faceUp', label: 'face up' },
              { value: 'faceDown', label: 'face down' },
              { value: 'toggle', label: 'over' },
            ]}
            onChange={(to) => onChange({ ...effect, to: to as typeof effect.to })}
          />
        </>
      );

    case 'rotateCard':
      return (
        <>
          <TargetSelectorChip
            selector={effect.target}
            definition={definition}
            ariaLabel="Which cards"
            onChange={(target) => onChange({ ...effect, target })}
          />
          <InlineSelect
            label="Rotation"
            value={effect.to}
            options={[
              { value: 'rotated', label: 'sideways' },
              { value: 'upright', label: 'upright' },
              { value: 'toggle', label: 'the other way' },
            ]}
            onChange={(to) => onChange({ ...effect, to: to as typeof effect.to })}
          />
        </>
      );

    case 'createCard':
      return (
        <>
          <ValueRefPicker
            value={effect.count}
            definition={definition}
            ariaLabel="How many cards"
            onChange={(count) => onChange({ ...effect, count })}
          />
          {' copies of '}
          <InlineSelect
            label="Card"
            value={effect.templateId}
            options={definition.templates.map((t) => ({ value: t.id, label: t.name }))}
            onChange={(templateId) => onChange({ ...effect, templateId })}
          />
          {' in '}
          <PositionControl
            position={effect.position}
            onChange={(position) => onChange({ ...effect, position })}
          />
          {' of '}
          <ZoneRefChip
            zone={effect.zone}
            definition={definition}
            ariaLabel="Destination zone"
            onChange={(zone) => onChange({ ...effect, zone: zoneRefFor(definition, zone.zoneId, zone.seat) })}
          />
        </>
      );

    case 'destroyCards':
      return (
        <TargetSelectorChip
          selector={effect.target}
          definition={definition}
          ariaLabel="Which cards"
          onChange={(target) => onChange({ ...effect, target })}
        />
      );

    case 'fireEvent':
      return (
        <>
          <input
            className="cb-inline-input"
            aria-label="Event name"
            list="cb-event-names"
            value={effect.name}
            onChange={(e) => onChange({ ...effect, name: e.target.value })}
          />
          <datalist id="cb-event-names">
            {definition.customEvents.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {effect.name.trim() === '' && <span className="cb-error">name the event</span>}
        </>
      );

    case 'forceTransition':
      return (
        <InlineSelect
          label="State"
          value={effect.toStateId}
          options={definition.machine.states.map((s) => ({ value: s.id, label: s.name }))}
          onChange={(toStateId) => onChange({ ...effect, toStateId })}
        />
      );
  }
}

/** top / bottom / an explicit index — the third reveals its number only when chosen (§4.7). */
function PositionControl({
  position,
  onChange,
}: {
  position: InsertPosition;
  onChange: (position: InsertPosition) => void;
}) {
  return (
    <>
      <InlineSelect
        label="Position"
        value={positionValue(position)}
        options={POSITIONS}
        onChange={(value) =>
          onChange(value === 'index' ? { kind: 'index', index: 0 } : (value as InsertPosition))
        }
      />
      {typeof position !== 'string' && (
        <InlineNumber
          label="Index"
          min={0}
          value={position.index}
          onChange={(index) => onChange({ kind: 'index', index })}
        />
      )}
    </>
  );
}

/** The seat, mid-sentence. `SeatSelect` is the labelled-field form; both read the same option list. */
function SeatInline({
  seat,
  definition,
  onChange,
}: {
  seat: SeatRef;
  definition: GameDefinition;
  onChange: (seat: SeatRef) => void;
}) {
  return (
    <InlineSelect
      label="Whose"
      value={seatToOption(seat)}
      options={seatOptions(definition)}
      onChange={(value) => onChange(optionToSeat(value))}
    />
  );
}
