import { useId } from 'react';
import type {
  ChoiceMode,
  ChoiceOption,
  Effect,
  GameDefinition,
  Id,
  InsertPosition,
  NumericOp,
  SeatRef,
} from '../../engine/types';
import { ValueRefPicker } from '../criteria/ValueRefPicker';
import { allIndexes } from '../criteria/isDangling';
import { InlineNumber, InlineSelect } from '../ui/fields';
import { ActionSelectorChip, ActionSelectorSubRow } from './ActionSelectorChip';
import { CardRefChip } from './CardRefChip';
// §6.11 recursion 3 — EffectList renders EffectRow, and a `chooseMode` row renders an EffectList per
// mode. A deliberate cycle between two hoisted function declarations, neither touched at module
// init; the alternative is a render prop threaded through every call site for one branch.
import { EffectList } from './EffectList';
import { SeatRefChip } from './SeatRefChip';
import { TargetSelectorChip, TargetSelectorSubRow } from './TargetSelectorChip';
import { ZoneRefChip } from './ZoneRefChip';
import { zoneRefFor } from './zoneRef';
import { EFFECT_KINDS, defaultEffect, missingFor, moveItem, pauses } from './effectKinds';

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
  /** §6.11 — how many effect lists deep this row sits; `chooseMode` is refused at depth 1. */
  depth?: number;
  /** v4 §4.5 — this row is in an `activation.cost` list, which still refuses three kinds. */
  inCost?: boolean;
  /** The rule this list belongs to, so an `announceAction` naming it can warn (§6.10). */
  ruleId?: Id;
}

/**
 * The `▲▼✕` trio. Keyboard-reachable by construction, which is the whole reason reordering is not a
 * drag handle only (§6.8).
 */
export function RowActions({
  noun,
  index,
  total,
  onMove,
  onRemove,
}: {
  noun: string;
  index: number;
  total: number;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
}) {
  return (
    <span className="cb-effect__actions">
      <button
        type="button"
        className="cb-btn"
        data-variant="ghost"
        aria-label={`Move ${noun} ${index + 1} up`}
        disabled={index === 0}
        onClick={() => onMove(index, index - 1)}
      >
        ▲
      </button>
      <button
        type="button"
        className="cb-btn"
        data-variant="ghost"
        aria-label={`Move ${noun} ${index + 1} down`}
        disabled={index === total - 1}
        onClick={() => onMove(index, index + 1)}
      >
        ▼
      </button>
      <button
        type="button"
        className="cb-btn"
        data-variant="danger"
        aria-label={`Remove ${noun} ${index + 1}`}
        onClick={onRemove}
      >
        ✕
      </button>
    </span>
  );
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
  depth = 0,
  inCost = false,
  ruleId,
}: EffectRowProps) {
  const stops = pauses(effect);

  return (
    <li className="cb-effect" data-prompts={stops ? '1' : undefined}>
      <span className="cb-effect__ordinal">{index + 1}.</span>

      <span className="cb-effect__sentence">
        <InlineSelect
          label={`Effect ${index + 1} kind`}
          value={effect.kind}
          options={EFFECT_KINDS.map(({ kind, label }) => {
            const missing = missingFor(kind, definition, depth, inCost);
            return { value: kind, label: missing === '' ? label : `${label} (${missing})` };
          })}
          onChange={(kind) => {
            if (missingFor(kind as Effect['kind'], definition, depth, inCost) !== '') return;
            const next = defaultEffect(kind as Effect['kind'], definition, effect);
            if (next) onChange(next);
          }}
        />
        <EffectSentence
          effect={effect}
          definition={definition}
          onChange={onChange}
          ruleId={ruleId}
        />
      </span>

      {stops && (
        <span className="cb-effect__pause">⏸ execution pauses here until the player answers</span>
      )}

      <RowActions noun="effect" index={index} total={total} onMove={onMove} onRemove={onRemove} />

      {/* §6.11 — the expanded regions, at the row's full column width. Rendered unconditionally:
          each returns null when its effect has nothing to expand. */}
      <EffectSubRows effect={effect} definition={definition} onChange={onChange} depth={depth} />
    </li>
  );
}

/**
 * The parts too big for the sentence: criteria trees, `sealedChoice`'s options, `chooseMode`'s
 * modes. Direct children of the `<li>` so `flex: 1 0 100%` gives each its own line, the same trick
 * the `⏸` note uses.
 */
function EffectSubRows({
  effect,
  definition,
  onChange,
  depth,
}: {
  effect: Effect;
  definition: GameDefinition;
  onChange: (effect: Effect) => void;
  depth: number;
}) {
  if (effect.kind === 'counterAction')
    return (
      <ActionSelectorSubRow
        selector={effect.action}
        definition={definition}
        onChange={(action) => onChange({ ...effect, action })}
      />
    );

  if (effect.kind === 'sealedChoice')
    return (
      <ChoiceOptionList
        options={effect.options}
        onChange={(options) => onChange({ ...effect, options })}
      />
    );

  if (effect.kind === 'chooseMode')
    return (
      <ModeList
        modes={effect.modes}
        definition={definition}
        depth={depth}
        onChange={(modes) => onChange({ ...effect, modes })}
      />
    );

  if ('target' in effect)
    return (
      <TargetSelectorSubRow
        selector={effect.target}
        definition={definition}
        onChange={(target) => onChange({ ...effect, target })}
      />
    );

  return null;
}

/**
 * The parts after the verb, per kind. A `switch` over the same cases the engine applies and
 * `prose.ts` describes: when a twenty-third effect lands, all three fail to compile together.
 */
function EffectSentence({
  effect,
  definition,
  onChange,
  ruleId,
}: {
  effect: Effect;
  definition: GameDefinition;
  onChange: (effect: Effect) => void;
  ruleId?: Id;
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
              <SeatRefChip
                ariaLabel="Whose"
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

    // ── v2 §4.5 ────────────────────────────────────────────────────────────────────────────────

    case 'setTag':
      return (
        <>
          <TargetSelectorChip
            selector={effect.target}
            definition={definition}
            ariaLabel="Which cards"
            onChange={(target) => onChange({ ...effect, target })}
          />
          <InlineSelect
            label="Add or remove"
            value={effect.on ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'gains the tag' },
              { value: 'off', label: 'loses the tag' },
            ]}
            onChange={(on) => onChange({ ...effect, on: on === 'on' })}
          />
          <input
            className="cb-inline-input"
            aria-label="Tag"
            value={effect.tag}
            onChange={(e) => onChange({ ...effect, tag: e.target.value })}
          />
          {effect.tag.trim() === '' && <span className="cb-error">name the tag</span>}
        </>
      );

    case 'detach':
      return (
        <TargetSelectorChip
          selector={effect.target}
          definition={definition}
          ariaLabel="Which cards"
          onChange={(target) => onChange({ ...effect, target })}
        />
      );

    case 'attach':
      return (
        <>
          <TargetSelectorChip
            selector={effect.target}
            definition={definition}
            ariaLabel="Which cards"
            onChange={(target) => onChange({ ...effect, target })}
          />
          {' to '}
          <CardRefChip
            card={effect.host}
            definition={definition}
            ariaLabel="Attach to"
            onChange={(host) => onChange({ ...effect, host })}
          />
        </>
      );

    case 'setController':
      return (
        <>
          <TargetSelectorChip
            selector={effect.target}
            definition={definition}
            ariaLabel="Which cards"
            onChange={(target) => onChange({ ...effect, target })}
          />
          {' is controlled by '}
          <ControllerControl
            seat={effect.seat}
            definition={definition}
            onChange={(seat) => onChange({ ...effect, seat })}
          />
        </>
      );

    case 'eliminateSeat':
      return (
        <SeatRefChip
          seat={effect.seat}
          definition={definition}
          ariaLabel="Which player"
          onChange={(seat) => onChange({ ...effect, seat })}
        />
      );

    case 'openPriority':
      return (
        <>
          <InlineSelect
            label="Priority window"
            value={effect.window}
            options={definition.priorityWindows.map((w) => ({ value: w.id, label: w.name }))}
            onChange={(window) => onChange({ ...effect, window })}
          />
          {!definition.priorityWindows.some((w) => w.id === effect.window) && (
            <span className="cb-error">this window was deleted</span>
          )}
        </>
      );

    case 'announceAction':
      return (
        <>
          <InlineSelect
            label="Rule"
            value={effect.ruleId}
            options={definition.ruleSets.map((r) => ({ value: r.id, label: r.name }))}
            onChange={(id) => onChange({ ...effect, ruleId: id })}
          />
          {' and open '}
          <InlineSelect
            label="Priority window"
            value={effect.window ?? ''}
            options={[
              { value: '', label: 'no response window' },
              ...definition.priorityWindows.map((w) => ({ value: w.id, label: w.name })),
            ]}
            onChange={(id) => onChange({ ...effect, window: id === '' ? null : id })}
          />
          {!definition.ruleSets.some((r) => r.id === effect.ruleId) && (
            <span className="cb-error">this rule was deleted</span>
          )}
          {/* §6.10 — the first rule-to-rule reference, so the first way to write a loop. The engine's
              loop guard only catches it mid-playtest; `machineWarnings` sets the precedent for
              saying it at authoring time instead of failing a save. */}
          {effect.ruleId === ruleId && (
            <span className="cb-warning">
              ⚠ Warning: this rule announces itself. The loop guard stops it at run time, but it will
              never do what it reads as.
            </span>
          )}
        </>
      );

    case 'counterAction':
      return (
        <ActionSelectorChip
          selector={effect.action}
          definition={definition}
          ariaLabel="Which actions"
          onChange={(action) => onChange({ ...effect, action })}
        />
      );

    case 'sealedChoice':
      return (
        <>
          <SeatRefChip
            seat={effect.seats}
            definition={definition}
            ariaLabel="Who chooses"
            onChange={(seats) => onChange({ ...effect, seats })}
          />
          {' — remembered as '}
          <input
            className="cb-inline-input"
            aria-label="Choice key"
            value={effect.choiceId}
            onChange={(e) => onChange({ ...effect, choiceId: e.target.value })}
          />
          {effect.choiceId.trim() === '' && <span className="cb-error">name the choice</span>}
        </>
      );

    case 'chooseMode':
      return (
        <>
          <SeatRefChip
            seat={effect.seat}
            definition={definition}
            ariaLabel="Who chooses"
            onChange={(seat) => onChange({ ...effect, seat })}
          />
          <input
            className="cb-inline-input"
            aria-label="Prompt text"
            value={effect.promptText}
            onChange={(e) => onChange({ ...effect, promptText: e.target.value })}
          />
        </>
      );

    case 'chooseNumber':
      return (
        <>
          <SeatRefChip
            seat={effect.seat}
            definition={definition}
            ariaLabel="Who chooses"
            onChange={(seat) => onChange({ ...effect, seat })}
          />
          <input
            className="cb-inline-input"
            aria-label="Prompt text"
            value={effect.promptText}
            onChange={(e) => onChange({ ...effect, promptText: e.target.value })}
          />
          {' — a number from '}
          <ValueRefPicker
            value={effect.min}
            definition={definition}
            ariaLabel="Lowest"
            onChange={(min) => onChange({ ...effect, min })}
          />
          {' to '}
          <ValueRefPicker
            value={effect.max}
            definition={definition}
            ariaLabel="Highest"
            onChange={(max) => onChange({ ...effect, max })}
          />
          {', remembered as '}
          <input
            className="cb-inline-input"
            aria-label="Answer key"
            value={effect.key}
            onChange={(e) => onChange({ ...effect, key: e.target.value })}
          />
          {effect.key.trim() === '' && <span className="cb-error">name the key</span>}
        </>
      );

    // v4 §4.3 — `chooseNumber` without the bounds: who is asked, what they are asked, and the key a
    // later `SeatRef{kind:'promptSeat'}` reads the answer back under.
    case 'chooseSeat':
      return (
        <>
          <SeatRefChip
            seat={effect.seat}
            definition={definition}
            ariaLabel="Who chooses"
            onChange={(seat) => onChange({ ...effect, seat })}
          />
          <input
            className="cb-inline-input"
            aria-label="Prompt text"
            value={effect.promptText}
            onChange={(e) => onChange({ ...effect, promptText: e.target.value })}
          />
          {' — remembered as '}
          <input
            className="cb-inline-input"
            aria-label="Answer key"
            value={effect.key}
            onChange={(e) => onChange({ ...effect, key: e.target.value })}
          />
          {effect.key.trim() === '' && <span className="cb-error">name the key</span>}
        </>
      );
  }
}

/**
 * §4.3's nullable controller. `null` is not a `SeatRef`, so it cannot be a row inside `SeatRefChip`
 * — it is the choice of whether there is a controller at all, which is a question the sentence asks
 * before the chip does.
 */
function ControllerControl({
  seat,
  definition,
  onChange,
}: {
  seat: SeatRef | null;
  definition: GameDefinition;
  onChange: (seat: SeatRef | null) => void;
}) {
  const name = useId();
  return (
    <>
      <label className="cb-radio">
        <input
          type="radio"
          name={name}
          checked={seat !== null}
          onChange={() => onChange({ kind: 'active' })}
        />
        a player
      </label>
      {seat !== null && (
        <SeatRefChip
          seat={seat}
          definition={definition}
          ariaLabel="Controller"
          onChange={onChange}
        />
      )}
      <label className="cb-radio">
        <input type="radio" name={name} checked={seat === null} onChange={() => onChange(null)} />
        no explicit controller
      </label>
    </>
  );
}

/**
 * §4.5's `sealedChoice` options: a repeatable id/label list on the same `▲▼✕` trio the effect list
 * uses, because it is the same question ("which of these, in what order") in a smaller box.
 */
function ChoiceOptionList({
  options,
  onChange,
}: {
  options: ChoiceOption[];
  onChange: (options: ChoiceOption[]) => void;
}) {
  const set = (i: number, patch: Partial<ChoiceOption>) =>
    onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  return (
    <div className="cb-subrow" role="group" aria-label="Options">
      <div>
        <ol className="cb-list" aria-label="Options">
          {options.map((option, i) => (
            <li key={i} className="cb-list__row">
              <input
                className="cb-inline-input"
                aria-label={`Option ${i + 1} id`}
                value={option.id}
                onChange={(e) => set(i, { id: e.target.value })}
              />
              <input
                className="cb-inline-input"
                aria-label={`Option ${i + 1} label`}
                value={option.label}
                onChange={(e) => set(i, { label: e.target.value })}
              />
              <RowActions
                noun="option"
                index={i}
                total={options.length}
                onMove={(from, to) =>
                  to >= 0 && to < options.length && onChange(moveItem(options, from, to))
                }
                onRemove={() => onChange(options.filter((_, j) => j !== i))}
              />
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="cb-btn"
          onClick={() => onChange([...options, { id: '', label: '' }])}
        >
          + option
        </button>
      </div>
    </div>
  );
}

/**
 * §6.11 recursion 3 — one labelled box per mode, each holding its own effect list.
 *
 * The boxes borrow `CriteriaGroupEditor`'s `.cb-crit` / `.cb-crit__edge` pair verbatim, so the edge
 * colour alternates by nesting depth exactly as a criteria tree's does: a rule with both a mode list
 * and a filter tree stays scannable, and no new theme token appears (§6.13).
 */
function ModeList({
  modes,
  definition,
  depth,
  onChange,
}: {
  modes: ChoiceMode[];
  definition: GameDefinition;
  depth: number;
  onChange: (modes: ChoiceMode[]) => void;
}) {
  const set = (i: number, patch: Partial<ChoiceMode>) =>
    onChange(modes.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  return (
    <div className="cb-subrow" role="group" aria-label="Modes">
      <div>
        {modes.map((mode, i) => (
          <div key={i} className="cb-crit" data-depth={1}>
            <div className="cb-crit__edge">
              <div className="cb-crit__head">
                <span className="cb-hint">mode {i + 1}</span>
                <input
                  className="cb-inline-input"
                  aria-label={`Mode ${i + 1} label`}
                  value={mode.label}
                  onChange={(e) => set(i, { label: e.target.value })}
                />
                <button
                  type="button"
                  className="cb-btn"
                  data-variant="ghost"
                  aria-label={`Remove mode ${i + 1}`}
                  onClick={() => onChange(modes.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
              <EffectList
                effects={mode.effects}
                definition={definition}
                depth={depth + 1}
                label={`Effects for mode ${i + 1}`}
                addLabel={`Add an effect to mode ${i + 1}`}
                emptyHint="No effects yet — this mode does nothing."
                onChange={(effects) => set(i, { effects })}
              />
            </div>
          </div>
        ))}
        <button
          type="button"
          className="cb-btn"
          onClick={() => onChange([...modes, { label: '', effects: [] }])}
        >
          + mode
        </button>
      </div>
    </div>
  );
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
