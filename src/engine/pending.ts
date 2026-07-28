/**
 * The pending-action layer. TECHNICAL_DESIGN_V2.md §3.4, §4.7 (the `resolve` frame), §4.8
 * (`PendingAction`), §4.2 (`ActionRef`/`ActionSelector`, `ValueRef{kind:'actionField'}`), §5.1's
 * ordering amendment, §4.5/§5.7's `counterAction`, §9.5 edge cases 3/11/15.
 *
 * `announceAction` is the one producer of a `PendingAction`: it writes the record, freezes every
 * target-bearing effect in the announced RuleSet against the world AS IT STANDS RIGHT NOW, and
 * pushes onto `actionStack`. The `resolve` frame (`advanceResolve`) is the one consumer: it pops the
 * top of the stack and — unless the action was countered — pushes a `rule` frame bound to the
 * action's own `ruleId`/`sourceCardId`/`ctx`, reusing `dispatch.ts`'s existing per-effect cursor
 * machinery (`advanceRule`/`runEffect`) rather than a second copy of it.
 *
 * FREEZING (§4.8; §9.5 edge case 15). At announce time, every effect in the announced rule that
 * carries a `target: TargetSelector` is resolved ONCE against the current board. A resolution that
 * lands on a concrete card list is frozen twice: once into `PendingAction.targets` (so criteria and
 * `ValueRef{kind:'actionField', field:'targetCount'}` can read it), and once into the SAME
 * `ctx.promptAnswers` a `prompt` selector's answer already lives in, under a reserved key
 * (`actionTargetKey`) parallel to `targets.ts`'s `CHOSEN_PROMPT_KEY`. `effects.ts`'s target-bearing
 * cases consult that key before calling `resolveTargets`, so a response that moves the target cannot
 * silently re-aim the effect at resolve time — and a target destroyed in between is skipped and
 * logged rather than voiding the whole effect (edge case 15's deliberate asymmetry from a LIVE
 * selector, which fails the whole batch on one dead id — §5.3's atomicity does not apply to a
 * selection that was already committed at announce time).
 *
 * A target selector that resolves to an unanswered PROMPT at announce time is deliberately left
 * UNFROZEN: freezing it would mean suspending mid-announce to ask the tester right now, which this
 * wave does not do (announcing never suspends). It falls through to a live, at-resolve-time prompt
 * instead — a real interim limitation, not a bug, called out in the implementation report.
 *
 * ADDRESSABILITY (§4.2, §9.5 edge case 11). `resolveActionRef`/`resolveActionSelector` mirror
 * `seats.ts`'s `resolveCardRef`/`resolveSeat`: pure, never throw, typed failures instead of
 * `undefined`. `{kind:'topOfStack'}` and `{kind:'actionField'}` against an empty `actionStack` fail
 * `MISSING_REFERENT` by construction — there is no code path that reads past the empty-array check.
 *
 * `{kind:'triggeringAction'}` — "the action whose window/resolution we are inside" — is bound the
 * same way `CardRef{kind:'host'}`/`{kind:'candidate'}` are bound in `seats.ts`/`targets.ts`: through
 * a reserved key in `ctx.promptAnswers` (`ACTION_ID_KEY`) rather than a new `TriggerContext` field —
 * `TriggerContext` is closed in this wave and widening it is out of scope (nothing here touches
 * `types.ts`). `announceAction` stamps the key into the `PendingAction`'s own `ctx` once, at
 * creation, so it threads automatically into the `rule` frame `advanceResolve` pushes.
 * `ActionSelector{kind:'allOnStack', where}` reuses the SAME key per candidate while evaluating
 * `where`: the closed `ActionRef` union has no `{kind:'candidate'}` sibling to `CardRef`'s, so
 * `triggeringAction` doubles as both meanings. This is a deliberate reading of an underspecified
 * corner — see the call site — not an oversight.
 *
 * Cyclic with `criteria.ts` (`allOnStack.where` needs `evalCriteria`) and, through it, with
 * `valueRef.ts` (`actionField` there imports `resolveActionField` from here) by design — the same
 * discipline `modifiers.ts` documents at the hub of an identical cycle: every cross-reference below
 * is a function-body call, never a module-top-level one, so evaluation order cannot matter.
 */

import type {
  ActionRef,
  ActionSelector,
  Effect,
  EffectResult,
  Frame,
  GameDefinition,
  Id,
  LogLine,
  PendingAction,
  PlayState,
  RejectReason,
  StepResult,
  TriggerContext,
} from './types';
import type { ResolutionFail } from './seats';
import type { EffectContext } from './effects';
import { resolveTargets } from './targets';
import { evalCriteria } from './criteria';
import { pop, push } from './frames';

// ---------------------------------------------------------------------------
// Reserved `ctx.promptAnswers` keys — parallel to `targets.ts`'s `CHOSEN_PROMPT_KEY`. Neither can
// collide with a real promptId (`${logSeq}:${ruleId}:${effectIndex}` — no key here contains a `@`).
// ---------------------------------------------------------------------------

/** Binds `ActionRef{kind:'triggeringAction'}` (and, per-candidate, `allOnStack.where`) — see header. */
export const ACTION_ID_KEY = '@actionId';

/** Binds one target-bearing effect's frozen ids, by its position in `rule.effects`. */
export const actionTargetKey = (effectIndex: number): string => `@actionTarget:${effectIndex}`;

function fail(reason: RejectReason, message: string): ResolutionFail {
  return { ok: false, reason, message };
}

// ---------------------------------------------------------------------------
// Logging — small and local rather than importing effects.ts's PRIVATE `emit`/`reject`: nothing
// here needs the rest of that module, only the `EffectContext` type (§3.2 discipline).
// ---------------------------------------------------------------------------

const ERROR_REASONS: readonly RejectReason[] = [
  'MISSING_REFERENT',
  'TARGET_GONE',
  'TYPE_MISMATCH',
  'INVALID_SEAT',
  'UNBOUND_REF',
];

function emit(
  ec: EffectContext,
  effect: Effect,
  level: LogLine['level'],
  message: string,
  change: LogLine['change'] = null,
  kind: LogLine['kind'] = 'effect'
): void {
  ec.log({ level, kind, message, change, ruleId: null, effectKind: effect.kind, depth: ec.depth });
}

function reject(ec: EffectContext, effect: Effect, reason: RejectReason, message: string): EffectResult {
  emit(ec, effect, ERROR_REASONS.includes(reason) ? 'error' : 'reject', message);
  return { ok: false, reason, detail: message };
}

// ---------------------------------------------------------------------------
// ActionRef / ActionSelector / actionField — §4.2
// ---------------------------------------------------------------------------

export function resolveActionRef(
  ref: ActionRef,
  state: PlayState,
  ctx: TriggerContext
): { ok: true; action: PendingAction } | ResolutionFail {
  switch (ref.kind) {
    case 'triggeringAction': {
      const id = ctx.promptAnswers[ACTION_ID_KEY]?.[0];
      if (id === undefined) {
        return fail(
          'UNBOUND_REF',
          "Ref \"triggeringAction\" is unbound: it resolves only while a pending action's own resolution is running."
        );
      }
      const action = state.pendingActions[id];
      return action ? { ok: true, action } : fail('TARGET_GONE', `Pending action "${id}" no longer exists.`);
    }
    // §9.5 edge case 11 — an empty stack fails MISSING_REFERENT, never `undefined`.
    case 'topOfStack': {
      const id = state.actionStack[state.actionStack.length - 1];
      if (id === undefined) return fail('MISSING_REFERENT', 'Ref "topOfStack": the action stack is empty.');
      const action = state.pendingActions[id];
      return action
        ? { ok: true, action }
        : fail('MISSING_REFERENT', `Ref "topOfStack": pending action "${id}" is missing from state.`);
    }
    case 'action': {
      const action = state.pendingActions[ref.id];
      return action ? { ok: true, action } : fail('TARGET_GONE', `Pending action "${ref.id}" no longer exists.`);
    }
  }
}

export function resolveActionSelector(
  sel: ActionSelector,
  state: PlayState,
  ctx: TriggerContext,
  def: GameDefinition
): { ok: true; actions: PendingAction[] } | ResolutionFail {
  if (sel.kind === 'action') {
    const res = resolveActionRef(sel.ref, state, ctx);
    return res.ok ? { ok: true, actions: [res.action] } : res;
  }

  // §5.1's amendment — "pending actions sort after cards, by actionStack position ascending, then
  // action id". Position ascending IS array order (index 0 was placed first, i.e. resolves last);
  // the id tiebreak never actually decides anything today (`actionStack` entries are unique by
  // construction) but is kept so a future duplicate-position source fails safe, not
  // nondeterministically.
  const ordered = [...state.actionStack].sort((a, b) => {
    const pa = state.actionStack.indexOf(a);
    const pb = state.actionStack.indexOf(b);
    return pa - pb || (a < b ? -1 : a > b ? 1 : 0);
  });

  const actions: PendingAction[] = [];
  for (const id of ordered) {
    const action = state.pendingActions[id];
    if (!action) continue; // defensive — actionStack should never name a missing record
    if (sel.where === null) {
      actions.push(action);
      continue;
    }
    // The per-candidate binding — see the file header's note on reusing `triggeringAction`. A
    // fresh spread per candidate, never mutating the shared `ctx`, the same discipline
    // `targets.ts`'s `matching` selector uses for `CardRef{kind:'candidate'}`.
    const candidateCtx: TriggerContext = {
      ...ctx,
      promptAnswers: { ...ctx.promptAnswers, [ACTION_ID_KEY]: [id] },
    };
    if (evalCriteria(sel.where, state, candidateCtx, def).value) actions.push(action);
  }
  return { ok: true, actions };
}

export function resolveActionField(
  ref: { action: ActionRef; field: 'controller' | 'targetCount' },
  state: PlayState,
  ctx: TriggerContext
): { ok: true; values: (number | boolean)[]; quantifier: 'every' } | ResolutionFail {
  const res = resolveActionRef(ref.action, state, ctx);
  if (!res.ok) return res;
  if (ref.field === 'controller') {
    return { ok: true, values: [res.action.controller], quantifier: 'every' };
  }
  const targetCount = Object.values(res.action.targets).reduce((sum, ids) => sum + ids.length, 0);
  return { ok: true, values: [targetCount], quantifier: 'every' };
}

// ---------------------------------------------------------------------------
// announceAction — §4.5, §4.8
// ---------------------------------------------------------------------------

export function announceAction(
  ec: EffectContext,
  effect: Extract<Effect, { kind: 'announceAction' }>
): EffectResult {
  const { state, def, ctx } = ec;
  const rule = def.ruleSets.find((r) => r.id === effect.ruleId);
  if (!rule) {
    return reject(ec, effect, 'MISSING_REFERENT', `Announce: RuleSet "${effect.ruleId}" does not exist in this definition.`);
  }
  // The announcing seat becomes the action's controller. §4.8 gives `PendingAction` its own
  // `controller`, independent of any card — an announced action card (VTES) is controlled by the
  // seat that played it, not derived from a permanent the way `controllerOf` derives a card's.
  const controller = ctx.triggeringSeat;
  if (controller === null) {
    return reject(ec, effect, 'INVALID_SEAT', `Announce "${rule.name}": no acting seat is bound (triggeringSeat is null).`);
  }

  const id = `a${state.nextSeq++}`;

  // Freeze — see the file header. Only a resolution that lands on a concrete card list freezes; a
  // live prompt or an outright failure is left for resolve time to handle, exactly as it always
  // would for a rule invoked any other way.
  const targets: Record<string, Id[]> = {};
  const promptAnswers: Record<string, Id[]> = { ...ctx.promptAnswers, [ACTION_ID_KEY]: [id] };
  rule.effects.forEach((fx, i) => {
    if (!('target' in fx)) return;
    const res = resolveTargets(fx.target, state, ctx, def);
    if (res.ok && res.kind === 'cards') {
      targets[String(i)] = [...res.cardIds];
      promptAnswers[actionTargetKey(i)] = [...res.cardIds];
    }
  });

  const pending: PendingAction = {
    id,
    ruleId: rule.id,
    sourceCardId: ctx.sourceCardId,
    controller,
    // `triggeringSeat` is stamped to the controller explicitly (matching what it already is in the
    // overwhelmingly common case) so a sub-effect's `SeatRef{kind:'triggeringSeat'}` — read while
    // this action's OWN effects run, at resolve time — is what §9.5 edge case 3 needs it to be: a
    // live, elimination-checked reference to the seat that announced this action, correctly failing
    // `SEAT_ELIMINATED` (via `seats.ts`'s existing `live()` check) if that seat is ousted before
    // this resolves. No new elimination-awareness was added anywhere for this — it falls out of
    // `resolveSeat`'s existing behaviour once `ctx.triggeringSeat` names the right seat.
    ctx: { ...ctx, triggeringSeat: controller, promptAnswers },
    targets,
    tags: [],
    countered: false,
  };
  state.pendingActions[id] = pending;
  const before = [...state.actionStack];
  state.actionStack.push(id);

  const frozenCount = Object.keys(targets).length;
  emit(
    ec,
    effect,
    'info',
    `Announce "${rule.name}" (${id}) — controller seat ${controller}${
      frozenCount ? `, ${frozenCount} target set(s) frozen` : ''
    }.`,
    { path: 'actionStack', before, after: [...state.actionStack] },
    'change'
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// counterAction — §4.5, §5.7 (via §8 step 23). AC: MTG3.
// ---------------------------------------------------------------------------

export function counterAction(
  ec: EffectContext,
  effect: Extract<Effect, { kind: 'counterAction' }>
): EffectResult {
  const { state, def, ctx } = ec;
  const res = resolveActionSelector(effect.action, state, ctx, def);
  if (!res.ok) return reject(ec, effect, res.reason, res.message);
  if (res.actions.length === 0) {
    return reject(ec, effect, 'NO_TARGETS', 'Counter: selector matched no pending action.');
  }
  // Plan then mutate (§5.3) — an action no longer on the stack (already resolved, or already
  // countered) rejects the WHOLE effect rather than countering the rest and silently no-oping it.
  for (const action of res.actions) {
    if (!state.actionStack.includes(action.id)) {
      return reject(
        ec,
        effect,
        'TARGET_GONE',
        `Counter ${action.id}: not on the stack (already resolved or countered).`
      );
    }
  }

  // "The counter" for the log — the action whose OWN resolution this effect is running inside, when
  // there is one. `counterAction` may also be authored on an ordinary triggered rule with no
  // enclosing pending action (an always-up counter that was never itself announced), so this is
  // allowed to be unbound rather than required — the fallback names the source card, or the effect
  // itself, instead of leaving the sentence half-written.
  const counterer = resolveActionRef({ kind: 'triggeringAction' }, state, ctx);
  const nameOf = (a: PendingAction) => def.ruleSets.find((r) => r.id === a.ruleId)?.name ?? a.ruleId;
  const counterLabel = counterer.ok
    ? `"${nameOf(counterer.action)}" (${counterer.action.id})`
    : ctx.sourceCardId
      ? `card ${ctx.sourceCardId}`
      : 'this effect';

  // Only the `countered` FLAG is set here — `state.actionStack` is left untouched. The action
  // still leaves the stack "on its resolve frame" (MTG3's own wording): `advanceResolve` below is
  // what actually pops it, once its turn to resolve comes back around, finds `countered`, and skips
  // pushing a `rule` frame. Two separate responsibilities: counterAction marks, resolve sweeps.
  for (const action of res.actions) {
    state.pendingActions[action.id].countered = true;
    // AC: MTG3 — names BOTH the counter and the countered action.
    emit(
      ec,
      effect,
      'info',
      `${counterLabel} counters "${nameOf(action)}" (${action.id}).`,
      { path: `pendingActions.${action.id}.countered`, before: false, after: true },
      'change'
    );
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The `resolve` frame — §4.7, §4.8. AC: MTG2.
// ---------------------------------------------------------------------------

const RESOLVE_MORE: StepResult = { done: false, suspended: false, haltedByLoopGuard: false };

/** Matches `dispatch.ts`'s private `UNRESOLVED` sentinel — a `rule` frame's header has not run yet. */
const UNRESOLVED = -1;

type ResolveFrame = Extract<Frame, { kind: 'resolve' }>;

/**
 * Pops the top of `actionStack` (by `frame.actionId`, which WAS the top at push time — nothing can
 * change it between then and now, since a `resolve` frame is processed the very next `step()` after
 * it is pushed) and either logs a countered action's non-effect or pushes a `rule` frame bound to
 * the action's own `ruleId`/`sourceCardId`/`ctx` — reusing `dispatch.ts`'s existing per-effect
 * cursor machinery (`advanceRule`/`runEffect`) rather than a second copy of it.
 *
 * `pendingActions[id]` is never deleted here, or anywhere in this wave: §4.8's addressability
 * requirement means a rule that just finished resolving must still answer
 * `ActionRef{kind:'triggeringAction'}` while ITS OWN effects run (`counterAction` naming itself in
 * the log is exactly this). Only `actionStack` membership tracks whether an action still awaits
 * resolution — mirroring `state.eliminated` outliving `seatOrder` removal (§5.12) rather than
 * `state.cards` deleting on destroy. A deliberate choice, not an omission.
 */
export function advanceResolve(
  frame: ResolveFrame,
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[]
): StepResult {
  pop(state); // transient — one step, never re-visited

  const idx = state.actionStack.indexOf(frame.actionId);
  if (idx >= 0) state.actionStack.splice(idx, 1);

  const action = state.pendingActions[frame.actionId];
  if (!action) {
    // Nothing in this wave can reach this — a `resolve` frame is only ever pushed for an id that
    // was just read off `actionStack` — kept as a named, non-throwing failure rather than silent.
    lines.push({
      level: 'error',
      kind: 'effect',
      message: `Resolve: pending action "${frame.actionId}" is missing from state.`,
      change: null,
      ruleId: null,
      effectKind: null,
      depth: frame.depth,
    });
    return RESOLVE_MORE;
  }

  const rule = def.ruleSets.find((r) => r.id === action.ruleId);
  const label = `"${rule?.name ?? action.ruleId}" (${action.id})`;

  if (action.countered) {
    lines.push({
      level: 'reject',
      kind: 'effect',
      message: `Resolve ${label}: countered. Removed from the stack without applying.`,
      change: null,
      ruleId: action.ruleId,
      effectKind: null,
      depth: frame.depth,
    });
    return RESOLVE_MORE;
  }
  if (!rule) {
    lines.push({
      level: 'error',
      kind: 'effect',
      message: `Resolve ${label}: RuleSet no longer exists in this definition.`,
      change: null,
      ruleId: action.ruleId,
      effectKind: null,
      depth: frame.depth,
    });
    return RESOLVE_MORE;
  }

  lines.push({
    level: 'info',
    kind: 'effect',
    message: `Resolve ${label}.`,
    change: null,
    ruleId: action.ruleId,
    effectKind: null,
    depth: frame.depth,
  });
  push(state, {
    kind: 'rule',
    ruleId: action.ruleId,
    sourceCardId: action.sourceCardId,
    ctx: action.ctx,
    cursor: UNRESOLVED,
    aborted: false,
    parentId: frame.id,
    depth: frame.depth,
  });
  return RESOLVE_MORE;
}
