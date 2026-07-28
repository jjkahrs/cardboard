/**
 * Criteria evaluation. TECHNICAL_DESIGN.md §5.7, §5.9 rows 11/12/13/17.
 *
 * Pure, never throws. Every leaf is evaluated — always, with no short-circuiting — because the log
 * needs each leaf's resolved values: "condition was false" is useless, `HP(seat 1) = 12, not < 10`
 * is the whole reason the tool exists (§5.7, §5.9 row 17).
 *
 * A `null` condition is the caller's problem: §4.7 says null always passes.
 */

import {
  type CardRef,
  type ComparisonOp,
  type CriteriaNode,
  type GameCriteria,
  type GameDefinition,
  type PlayState,
  type RejectReason,
  type SeatRef,
  type TriggerContext,
  type ValueRef,
} from './types';
import { resolvePoolDef, resolveValueRef } from './valueRef';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface CriteriaSide {
  /** Human-readable ref, e.g. `HP(seat 1)` or the literal itself. */
  label: string;
  /** Resolved values in ascending seat order; null when resolution failed. */
  values: (number | boolean)[] | null;
}

export interface CriteriaLeaf {
  left: CriteriaSide;
  op: ComparisonOp;
  right: CriteriaSide;
  value: boolean;
  /** Log-ready sentence, minus the trailing period — §5.9 rows 11/12/13/17. */
  description: string;
  /** Set when the leaf was forced false by a bad ref or a type mismatch. */
  error: { reason: RejectReason; message: string } | null;
}

export interface CriteriaResult {
  value: boolean;
  /** Every leaf under the node, in depth-first order. Never pruned. */
  leaves: CriteriaLeaf[];
}

// ---------------------------------------------------------------------------
// Labels — feed the log lines in §5.9
// ---------------------------------------------------------------------------

function seatLabel(seat: SeatRef | null): string {
  if (seat === null) return '';
  switch (seat.kind) {
    case 'seat':
      return `(seat ${seat.index})`;
    case 'all':
      return seat.quantifier === 'some' ? '(any)' : seat.quantifier === 'sum' ? '(total)' : '(all)';
    default:
      return `(${seat.kind})`;
  }
}

function cardLabel(card: CardRef): string {
  switch (card.kind) {
    case 'triggering':
      return 'triggering card';
    case 'zoneTop':
      return `top of ${card.zone.zoneId}${seatLabel(card.zone.seat)}`;
    case 'promptAnswer':
      return `answer ${card.promptId}[${card.ordinal}]`;
    case 'instance':
      return card.id;
    case 'host':
      return 'host';
    // §4.4 — the card under test. Every candidate's line reads `Power(candidate) = 3 > 2`; which
    // card that was is named by the per-candidate log line wrapping it, not repeated in the label.
    case 'candidate':
      return 'candidate';
    // v2 §4.2, §5.7 — bound only inside a replacement rule's `replaces.match`.
    case 'replacedTarget':
      return 'replaced target';
  }
}

function labelOf(ref: ValueRef, def: GameDefinition): string {
  switch (ref.kind) {
    case 'literal':
      return String(ref.value);
    case 'pool': {
      // resolvePoolDef, not `def.pools.find` — the reserved `activePlayer` pool has no entry in
      // `def.pools`, and a criterion on it would otherwise log as the raw id.
      const pool = resolvePoolDef(def, ref.poolId);
      return `${pool?.value.name ?? ref.poolId}${seatLabel(ref.seat)}`;
    }
    case 'cardIndex':
      return `${ref.indexId}(${cardLabel(ref.card)})`;
    case 'zoneCount': {
      const zone = def.zones.find((z) => z.id === ref.zone.zoneId);
      return `count(${zone?.name ?? ref.zone.zoneId}${seatLabel(ref.zone.seat)})`;
    }
    case 'activeSeatCount':
      return 'active seats';
    case 'cardTag':
      return `tag "${ref.tag}"(${cardLabel(ref.card)})`;
    // v2 §4.2, §5.7 — bound only inside a replacement rule's `replaces.match`.
    case 'replacedAmount':
      return 'replaced amount';
    // v2 §4.2 — reads a PendingAction field. UNBOUND_REF until step 23's `pendingActions`
    // resolution lands; the label still needs to exist for the log line that reports the failure.
    case 'actionField':
      return `${ref.field}(${ref.action.kind})`;
  }
}

function fmt(values: (number | boolean)[]): string {
  return values.length === 1 ? String(values[0]) : `[${values.join(', ')}]`;
}

/** A literal already reads as its value, so `10 = 10` is noise. */
function sideText(ref: ValueRef, side: CriteriaSide): string {
  if (ref.kind === 'literal' || side.values === null) return side.label;
  return `${side.label} = ${fmt(side.values)}`;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Types are checked before this runs, so the numeric casts are sound. */
function compare(l: number | boolean, op: ComparisonOp, r: number | boolean): boolean {
  switch (op) {
    case '=':
      return l === r;
    case '!=':
      return l !== r;
    case '>':
      return (l as number) > (r as number);
    case '<':
      return (l as number) < (r as number);
    case '>=':
      return (l as number) >= (r as number);
    case '<=':
      return (l as number) <= (r as number);
  }
}

function typeName(v: number | boolean): 'boolean' | 'integer' {
  return typeof v === 'boolean' ? 'boolean' : 'integer';
}

// ---------------------------------------------------------------------------
// Leaf evaluation — §5.7
// ---------------------------------------------------------------------------

function evalLeaf(
  node: GameCriteria,
  state: PlayState,
  ctx: TriggerContext,
  def: GameDefinition
): CriteriaLeaf {
  const leftLabel = labelOf(node.left, def);
  const rightLabel = labelOf(node.right, def);

  // Both sides resolve even if the first fails: the log wants whatever did resolve.
  const lr = resolveValueRef(node.left, state, ctx, def);
  const rr = resolveValueRef(node.right, state, ctx, def);
  const left: CriteriaSide = { label: leftLabel, values: lr.ok ? lr.values : null };
  const right: CriteriaSide = { label: rightLabel, values: rr.ok ? rr.values : null };

  const reject = (reason: RejectReason, message: string): CriteriaLeaf => ({
    left,
    op: node.op,
    right,
    value: false,
    description: `${message} Evaluated false`,
    error: { reason, message },
  });

  // §5.9 rows 12/13 — a bad ref fails the leaf and surfaces its own message. It never throws,
  // and it never touches its siblings.
  if (!lr.ok) return reject(lr.reason, lr.message);
  if (!rr.ok) return reject(rr.reason, rr.message);

  const lv = lr.values;
  const rv = rr.values;

  // §5.9 row 11 — imported and hand-edited JSON bypass the editor, so re-check the types here.
  if (lv.length > 0 && rv.length > 0) {
    const lt = typeName(lv[0]);
    const rt = typeName(rv[0]);
    const criterion = `${leftLabel} ${node.op} ${rightLabel}`;
    if (lt !== rt) {
      return reject('TYPE_MISMATCH', `Criterion "${criterion}": cannot compare ${lt} to ${rt}.`);
    }
    if (lt === 'boolean' && node.op !== '=' && node.op !== '!=') {
      return reject(
        'TYPE_MISMATCH',
        `Criterion "${criterion}": operator "${node.op}" is not valid for boolean values.`
      );
    }
  }

  // Both sides `all` → zipped by seat, never crossed, and the LEFT quantifier governs when the two
  // disagree (author-time validation warns about the disagreement — §5.7).
  const zipped = lv.length > 1 && rv.length > 1;
  const quantifier = lv.length > 1 ? lr.quantifier : rv.length > 1 ? rr.quantifier : 'every';
  const pairs =
    lv.length === 0 || rv.length === 0
      ? 0
      : zipped
        ? Math.min(lv.length, rv.length)
        : Math.max(lv.length, rv.length);

  const each: boolean[] = [];
  for (let i = 0; i < pairs; i++) {
    each.push(compare(lv[lv.length > 1 ? i : 0], node.op, rv[rv.length > 1 ? i : 0]));
  }
  // `each` is fully materialised first — the fold cannot skip a comparison.
  const value = quantifier === 'some' ? each.some(Boolean) : each.every(Boolean);

  const lText = sideText(node.left, left);
  const rText = sideText(node.right, right);
  return {
    left,
    op: node.op,
    right,
    value,
    description: value ? `${lText} ${node.op} ${rText}` : `${lText}, not ${node.op} ${rText}`,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// evalCriteria — §5.7
// ---------------------------------------------------------------------------

export function evalCriteria(
  node: CriteriaNode,
  state: PlayState,
  ctx: TriggerContext,
  def: GameDefinition
): CriteriaResult {
  if (node.kind === 'criteria') {
    const leaf = evalLeaf(node, state, ctx, def);
    return { value: leaf.value, leaves: [leaf] };
  }
  // Map before folding: every child is evaluated whatever an earlier one decided.
  const children = node.children.map((c) => evalCriteria(c, state, ctx, def));
  const value =
    node.combinator === 'and'
      ? children.every((c) => c.value) // empty AND → true
      : children.some((c) => c.value); // empty OR → false
  return { value, leaves: children.flatMap((c) => c.leaves) };
}

export function evalCriteriaBool(
  node: CriteriaNode,
  state: PlayState,
  ctx: TriggerContext,
  def: GameDefinition
): boolean {
  return evalCriteria(node, state, ctx, def).value;
}
