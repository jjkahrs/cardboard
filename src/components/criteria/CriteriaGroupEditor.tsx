import { useId } from 'react';
import type {
  ComparisonOp,
  CriteriaGroup,
  CriteriaNode,
  GameCriteria,
  GameDefinition,
} from '../../engine/types';
import type { RefContext } from '../authoring/refs';
import { ValueRefPicker } from './ValueRefPicker';

const OPS: { op: ComparisonOp; label: string }[] = [
  { op: '=', label: 'is' },
  { op: '!=', label: 'is not' },
  { op: '>', label: 'is above' },
  { op: '<', label: 'is below' },
  { op: '>=', label: 'is at least' },
  { op: '<=', label: 'is at most' },
];

/** Indent stops growing past depth 3; deeper groups show the number instead (§6.8). */
const MAX_INDENT_DEPTH = 3;

const newCriteria = (): GameCriteria => ({
  kind: 'criteria',
  left: { kind: 'literal', value: 0 },
  op: '=',
  right: { kind: 'literal', value: 0 },
});

const newGroup = (): CriteriaGroup => ({ kind: 'group', combinator: 'and', children: [] });

export interface CriteriaGroupEditorProps {
  node: CriteriaGroup;
  onChange: (next: CriteriaGroup) => void;
  definition: GameDefinition;
  /** Root group has no delete control — removing the condition entirely is the caller's business. */
  onDelete?: () => void;
  depth?: number;
  /**
   * §6.11 — where this tree sits, so the refs that bind only inside a `matching` subtree or a
   * replacement rule's match are offered only there. An explicit prop rather than React context:
   * this editor is used by two unrelated screens, and an implicit provider would make "why is this
   * row offering *the card under test*" invisible at the call site.
   */
  context?: RefContext;
}

/**
 * The nested AND/OR tree (§6.8). Used by the rule editor AND by state entry criteria, which is why
 * it knows nothing about either.
 *
 * The combinator is a property OF THE GROUP, shown once in its corner — never a per-row AND/OR
 * dropdown, which is the usual source of "what does this actually evaluate to".
 */
export function CriteriaGroupEditor({
  node,
  onChange,
  definition,
  onDelete,
  depth = 0,
  context,
}: CriteriaGroupEditorProps) {
  const groupId = useId();
  const combinatorLabel = node.combinator === 'and' ? 'all of' : 'any of';
  const other = node.combinator === 'and' ? 'any of' : 'all of';

  const replaceChild = (i: number, child: CriteriaNode) => {
    const children = [...node.children];
    children[i] = child;
    onChange({ ...node, children });
  };

  const removeChild = (i: number) =>
    onChange({ ...node, children: node.children.filter((_, j) => j !== i) });

  return (
    <div
      className="cb-crit"
      data-depth={Math.min(depth, MAX_INDENT_DEPTH)}
      role="group"
      aria-labelledby={groupId}
    >
      <div className="cb-crit__edge">
        <div className="cb-crit__head">
          {/* Two states, so a toggle rather than a menu: one keystroke, and the label always says
              what it currently means AND what clicking does. */}
          <button
            type="button"
            id={groupId}
            className="cb-chip"
            onClick={() => onChange({ ...node, combinator: node.combinator === 'and' ? 'or' : 'and' })}
          >
            {combinatorLabel}
            <span className="cb-visually-hidden"> — switch to {other}</span>
          </button>
          {depth > MAX_INDENT_DEPTH && <span className="cb-hint">depth {depth}</span>}
          {onDelete && (
            <button
              type="button"
              className="cb-btn"
              data-variant="ghost"
              onClick={onDelete}
              aria-label={`Remove this ${combinatorLabel} group`}
            >
              ×
            </button>
          )}
        </div>

        {node.children.length === 0 && (
          <p className="cb-hint">Empty group — it passes until you add a condition.</p>
        )}

        {node.children.map((child, i) =>
          child.kind === 'group' ? (
            <CriteriaGroupEditor
              key={i}
              node={child}
              definition={definition}
              depth={depth + 1}
              context={context}
              onChange={(next) => replaceChild(i, next)}
              onDelete={() => removeChild(i)}
            />
          ) : (
            <CriteriaRow
              key={i}
              criteria={child}
              definition={definition}
              context={context}
              onChange={(next) => replaceChild(i, next)}
              onDelete={() => removeChild(i)}
            />
          )
        )}

        <div className="cb-crit__actions">
          <button
            type="button"
            className="cb-btn"
            onClick={() => onChange({ ...node, children: [...node.children, newCriteria()] })}
          >
            + condition
          </button>
          <button
            type="button"
            className="cb-btn"
            onClick={() => onChange({ ...node, children: [...node.children, newGroup()] })}
          >
            + group
          </button>
        </div>
      </div>
    </div>
  );
}

function CriteriaRow({
  criteria,
  onChange,
  onDelete,
  definition,
  context,
}: {
  criteria: GameCriteria;
  onChange: (next: GameCriteria) => void;
  onDelete: () => void;
  definition: GameDefinition;
  context?: RefContext;
}) {
  const opId = useId();
  return (
    <div className="cb-crit__row">
      <ValueRefPicker
        ariaLabel="Left side"
        value={criteria.left}
        definition={definition}
        context={context}
        onChange={(left) => onChange({ ...criteria, left })}
      />
      {/* Six fixed values with no parameters and nothing to search: a native select beats a chip
          popover here, and it is the one control on the row a keyboard user can type into. */}
      <label className="cb-visually-hidden" htmlFor={opId}>
        Comparison
      </label>
      <select
        id={opId}
        className="cb-select"
        value={criteria.op}
        onChange={(e) => onChange({ ...criteria, op: e.target.value as ComparisonOp })}
      >
        {OPS.map(({ op, label }) => (
          <option key={op} value={op}>
            {label}
          </option>
        ))}
      </select>
      <ValueRefPicker
        ariaLabel="Right side"
        value={criteria.right}
        definition={definition}
        context={context}
        onChange={(right) => onChange({ ...criteria, right })}
      />
      <button type="button" className="cb-btn" data-variant="ghost" onClick={onDelete} aria-label="Remove condition">
        ×
      </button>
    </div>
  );
}
