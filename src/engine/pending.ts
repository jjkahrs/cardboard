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
 * A target selector that resolves to an unanswered PROMPT at announce time SUSPENDS announce itself
 * (§4.8's carried-over fix, landed in step 24 — steps 22/23 left this interim, see the note they used
 * to leave here). This is not a new mechanism: step 5 already established raise-before-mutate — an
 * effect raises its interaction BEFORE mutating anything, and the frame cursor does not advance until
 * it completes (§3.3) — `announceAction` now uses that exact path for every target-bearing effect in
 * the ANNOUNCED rule, one prompt at a time, re-entrant across suspend/resume the same way `runEffect`
 * is for a single effect's own `target`. `announcePromptScan` below finds the first not-yet-answered
 * one on each call; `dispatch.ts`'s `runEffect` (§4.8 step 24) checks `isSuspended(state)` right after
 * calling `applyEffect` and holds the cursor when it is set, since `announceAction` is the one effect
 * kind that can now suspend from OUTSIDE `runEffect`'s own top-of-function `target` check. Only once
 * every prompt-bearing target is answered does `announceAction` mint the `PendingAction`'s id, freeze
 * everything (including the now-answered prompts, read straight from `ctx.promptAnswers` rather than
 * re-resolved live), push it, and log — i.e. the id is minted, and `state.pendingActions`/
 * `actionStack` are touched, only on the FINAL, non-suspending pass, so a suspended announce leaves
 * genuinely nothing mutated (§3.3's rule, not just its spirit).
 *
 * WINDOW (§4.6, §5.5, step 24). Once an announce's targets are fully frozen, a non-null
 * `effect.window` opens a `priority` frame over the freshly-created action — `priority.ts`'s
 * `resolveWindowOrder`/`openPriorityWindow` own the frame itself; this file only resolves the window
 * BEFORE creating the `PendingAction` (using the controller seat it already knows, not a lookup
 * through `state.pendingActions[id]`, since `id` does not exist yet) so a bad window reference rejects
 * the WHOLE announce with nothing mutated, rather than leaving an action on the stack with no window
 * over it.
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
  PriorityWindow,
  RejectReason,
  StepResult,
  TargetSelector,
  TriggerContext,
} from './types';
import type { ResolutionFail } from './seats';
import type { EffectContext } from './effects';
import { resolveTargets } from './targets';
import { evalCriteria } from './criteria';
import { pop, push } from './frames';
import { raise } from './interaction';
import { openPriorityWindow, resolveWindowOrder } from './priority';

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
// The announce-time prompt suspend — §4.8's carried-over fix (file header). Mirrors dispatch.ts's own
// `promptTarget`: the innermost `prompt` selector, whether the effect's `target` IS one or WRAPS one
// via `matching` (§4.4).
// ---------------------------------------------------------------------------

function innerPrompt(s: TargetSelector): Extract<TargetSelector, { kind: 'prompt' }> | null {
  if (s.kind === 'prompt') return s;
  if (s.kind === 'matching') return innerPrompt(s.from);
  return null;
}

/**
 * Deterministic per announced rule + target-effect index. The extra `:announce:` segment cannot
 * collide with `interaction.ts`'s own `promptIdOf` formula (`${logSeq}:${ruleId}:${effectIndex}`
 * — no colon in a plain effect index), which is what keeps an announced rule's OWN prompts (asked
 * normally, at ITS resolve time, if this same rule is ever invoked directly) distinct from the
 * announce-time freezing prompts this file asks on its behalf.
 */
function announceTargetPromptId(state: PlayState, ruleId: Id, effectIndex: number): string {
  return `${state.logSeq}:${ruleId}:announce:${effectIndex}`;
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

  // §4.6, §5.5 — validated BEFORE anything mutates (plan then mutate, §5.3), using the controller
  // seat already known above rather than a lookup through `state.pendingActions`, which does not
  // have this entry yet. A bad window reference rejects the WHOLE announce with nothing mutated.
  let window: PriorityWindow | undefined;
  if (effect.window !== null) {
    window = def.priorityWindows.find((w) => w.id === effect.window);
    if (!window) {
      return reject(ec, effect, 'MISSING_REFERENT', `Announce "${rule.name}": priority window "${effect.window}" does not exist in this definition.`);
    }
    const orderRes = resolveWindowOrder(window, state, ctx, controller);
    if (!orderRes.ok) {
      return reject(ec, effect, orderRes.reason, orderRes.message);
    }
  }

  // §4.8's carried-over fix — raise BEFORE mutating anything (§3.3, reused verbatim from step 5): scan
  // the ANNOUNCED rule's target-bearing effects, in order, for the first one whose selector wraps a
  // `prompt` and has no frozen answer yet. Re-entrant across suspend/resume: `ctx.promptAnswers`
  // already carries every earlier one THIS announce has already asked, since `ctx` is the SAME object
  // `dispatch.ts`'s `runEffect` re-enters this effect with on resume (unchanged across passes, only
  // gaining keys).
  for (let i = 0; i < rule.effects.length; i++) {
    const fx = rule.effects[i];
    if (!('target' in fx)) continue;
    const prompt = innerPrompt(fx.target);
    if (!prompt) continue;
    const promptId = announceTargetPromptId(state, rule.id, i);
    if (ctx.promptAnswers[promptId] !== undefined) continue; // already answered on an earlier pass
    const candidates = resolveTargets(fx.target, state, ctx, def);
    if (!candidates.ok || candidates.kind !== 'prompt') {
      // Zero legal targets, or an outright resolution failure — left unfrozen for resolve time to
      // handle, unchanged from before this fix. Only a genuinely OPEN prompt suspends.
      continue;
    }
    raise(state, {
      kind: 'chooseCards',
      promptId,
      promptText: candidates.promptText,
      seat: controller,
      candidates: [...candidates.candidates],
      min: candidates.min,
      max: candidates.max,
    });
    emit(
      ec,
      effect,
      'info',
      `Announce "${rule.name}": prompt "${candidates.promptText}" (seat ${controller}) — ${candidates.candidates.length} legal target(s).`,
      null,
      'prompt'
    );
    // dispatch.ts's `runEffect` checks `isSuspended(state)` right after this call returns and holds
    // the cursor when it is set — the cursor does NOT advance, so resuming re-enters THIS SAME effect.
    return { ok: true };
  }

  const id = `a${state.nextSeq++}`;

  // Freeze — see the file header. A resolution that lands on a concrete card list freezes, and so
  // now does a resolved PROMPT answer (read straight from `ctx.promptAnswers`, already validated by
  // `dispatch.ts`'s `answerPrompt` against the SAME candidates/min/max this file raised above). An
  // outright failure (NO_TARGETS or worse) is still left for resolve time to handle, exactly as it
  // always would for a rule invoked any other way.
  const targets: Record<string, Id[]> = {};
  const promptAnswers: Record<string, Id[]> = { ...ctx.promptAnswers, [ACTION_ID_KEY]: [id] };
  rule.effects.forEach((fx, i) => {
    if (!('target' in fx)) return;
    if (innerPrompt(fx.target)) {
      const chosen = ctx.promptAnswers[announceTargetPromptId(state, rule.id, i)];
      if (chosen !== undefined) {
        targets[String(i)] = [...chosen];
        promptAnswers[actionTargetKey(i)] = [...chosen];
      }
      return;
    }
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

  // §4.6, §5.5 — opens a priority window over the action just placed. Already validated above (plan
  // then mutate), so this cannot fail; `priority.ts` owns the frame's own shape.
  if (window) {
    openPriorityWindow(ec, effect, window, id, controller);
  }

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
