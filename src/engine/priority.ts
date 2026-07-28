/**
 * The `priority` frame. TECHNICAL_DESIGN_V2.md §4.6, §4.7, §4.9, §5.5, §9.5 edge cases 1/2.
 *
 * A priority window offers each seat in `order`, in turn, the chance to activate something before
 * a pending action resolves (MTG) or before a phase continues (VTES's block window). It closes after
 * `passesToClose` consecutive passes, or when the whole table has been offered and none of them can
 * do anything at all — the latter is the empty-offer auto-collapse this file's whole shape exists to
 * make automatic rather than special-cased.
 *
 * **`order` is fixed at frame-push time; the close threshold is read live, every check.** Both halves
 * matter and are wrong in isolation (§5.5):
 *  - `order` is a snapshot of `state.seatOrder` taken once, when the window opens (`resolveWindowOrder`
 *    below). A seat eliminated after that is simply absent from the LIVE `state.seatOrder` when
 *    `advance` reaches its slot in `order` — skipped silently, no interaction, no log entry, the same
 *    shape as an auto-pass for a different reason (§9.5 edge case 1).
 *  - `window.passesToClose ?? state.seatOrder.length` is recomputed on every single `advancePriority`
 *    call, never captured once. A window opened at five seats must pop at four consecutive passes once
 *    an elimination drops the table to four — capturing the threshold once would wait forever for a
 *    fifth pass that can no longer happen (§9.5 edge case 2).
 *
 * **One unit of work per call**, matching every other `advance*` function in `dispatch.ts`: a single
 * `advancePriority` call either closes the window, trips `PRIORITY_EXHAUSTED`, silently skips one
 * eliminated seat, auto-passes one seat with nothing to offer, or raises the interaction for one seat
 * with something to offer. Never more than one of those per call — the store's own CONTINUE loop is
 * what turns a whole round into however many `step()` calls it takes, and that discipline is also
 * what keeps a pathological "every seat in `order` individually eliminated" board from spinning
 * forever inside one call: each skip still costs one `budget.priorityRounds` tick, so the ordinary
 * PRIORITY_EXHAUSTED guard bounds it exactly like everything else that loops.
 *
 * MTG4/MTG5 fall out of this without a special case (§5.5's own claim, which is why neither AC gets a
 * dedicated branch below): the EMPTY-offer path never calls `raise`, so it never suspends, so nothing
 * ever commits a transaction boundary for it — the whole round collapses into whichever entry was
 * already open. The NON-empty path always calls `raise`, which always suspends, which always commits
 * — and the seat's own `passPriority`/`activate` is then a fresh top-level action with its own entry.
 *
 * **Closing resolves.** §3.4's own diagram is explicit that a window closing feeds a `resolve` frame
 * for "top of actionStack" — not for the specific action THIS window was opened over. That distinction
 * matters the moment a response is itself a `PendingAction` (MTG1): it is placed ABOVE the original,
 * so when the OUTER window eventually closes, the response — now on top — must resolve first, exactly
 * §3.4's "last placed, first resolved". Closing therefore pushes `resolve` for whatever
 * `state.actionStack`'s current top is, when there is one, regardless of `frame.actionId`. A
 * standalone `openPriority` window (`actionId === null`) never triggers this — it has no action to
 * gate, only a decision point (VTES's "before combat", say).
 */

import type {
  Effect,
  EffectResult,
  Frame,
  GameDefinition,
  Id,
  LogLine,
  PlayState,
  PriorityWindow,
  RejectReason,
  RuleSet,
  SeatId,
  StepResult,
  TriggerContext,
} from './types';
import { ACTIVE_PLAYER_POOL_ID, pushLine } from './types';
import type { ResolutionFail } from './seats';
import type { EffectContext } from './effects';
import { evalCriteria } from './criteria';
import { pop, push, top } from './frames';
import { clear, raise } from './interaction';

// ---------------------------------------------------------------------------
// Small local helpers — mirrors pending.ts's own discipline: nothing here imports effects.ts's
// PRIVATE emit/reject, only the EffectContext type (§3.2).
// ---------------------------------------------------------------------------

function fail(reason: RejectReason, message: string): ResolutionFail {
  return { ok: false, reason, message };
}

function emit(
  ec: EffectContext,
  effect: Effect,
  level: LogLine['level'],
  message: string,
  kind: LogLine['kind'] = 'effect'
): void {
  ec.log({ level, kind, message, change: null, ruleId: null, effectKind: effect.kind, depth: ec.depth, visibility: null });
}

function reject(ec: EffectContext, effect: Effect, reason: RejectReason, message: string): EffectResult {
  emit(ec, effect, 'error', message);
  return { ok: false, reason, detail: message };
}

// ---------------------------------------------------------------------------
// §4.6 — resolving `start`/`direction`/`includeStart` into a fixed `order`
// ---------------------------------------------------------------------------

/**
 * `actionController` is the controller of the `PendingAction` this window is opening over, when
 * there is one — `null` for a standalone `openPriority` (no action attached), in which case a window
 * authored `start: 'controllerOfAction'` has nothing to mean and fails rather than guessing.
 */
export function resolveWindowOrder(
  window: PriorityWindow,
  state: PlayState,
  ctx: TriggerContext,
  actionController: SeatId | null
): { ok: true; order: SeatId[] } | ResolutionFail {
  let startSeat: SeatId;
  switch (window.start) {
    case 'active': {
      const A = state.pools[ACTIVE_PLAYER_POOL_ID] as number;
      if (!Number.isInteger(A) || !state.seatOrder.includes(A)) {
        return fail('INVALID_SEAT', `Priority window "${window.name}": activePlayer ${A} is not a live seat.`);
      }
      startSeat = A;
      break;
    }
    case 'triggeringSeat': {
      if (ctx.triggeringSeat === null) {
        return fail('UNBOUND_REF', `Priority window "${window.name}": start "triggeringSeat" is unbound.`);
      }
      if (!state.seatOrder.includes(ctx.triggeringSeat)) {
        return fail('SEAT_ELIMINATED', `Priority window "${window.name}": seat ${ctx.triggeringSeat} has been eliminated.`);
      }
      startSeat = ctx.triggeringSeat;
      break;
    }
    case 'controllerOfAction': {
      if (actionController === null) {
        return fail(
          'MISSING_REFERENT',
          `Priority window "${window.name}": start "controllerOfAction" requires an announced action; none is attached.`
        );
      }
      if (!state.seatOrder.includes(actionController)) {
        return fail('SEAT_ELIMINATED', `Priority window "${window.name}": seat ${actionController} has been eliminated.`);
      }
      startSeat = actionController;
      break;
    }
  }

  const ring = state.seatOrder;
  const n = ring.length;
  const at = ring.indexOf(startSeat);
  const stepped: SeatId[] = [];
  for (let i = 0; i < n; i++) {
    const idx = window.direction === 'forward' ? (at + i) % n : (((at - i) % n) + n) % n;
    stepped.push(ring[idx]);
  }
  const order = window.includeStart ? stepped : stepped.slice(1);
  return { ok: true, order };
}

// ---------------------------------------------------------------------------
// activatableRules — the legality probe. Shared by the priority offer (§5.5) and `activation.ts`'s
// `activate` action (§5.8), so a rule that would not be OFFERED behaves identically to one that is
// offered and rejected — one definition of "legal", not two that can drift.
// ---------------------------------------------------------------------------

export interface ActivationCandidate {
  ruleId: Id;
  cardId: Id | null;
  label: string;
}

/** The context a legality probe (or an actual activation) binds — seat as the acting seat, cardId as
 * `sourceCardId` so a `perInstance` rule's `CardRef{kind:'host'}` reads the card it is attached to. */
export function activationCtx(seat: SeatId, cardId: Id | null): TriggerContext {
  return { triggeringCardId: null, zoneKey: null, triggeringSeat: seat, promptAnswers: {}, sourceCardId: cardId };
}

function passesActivationGates(
  state: PlayState,
  def: GameDefinition,
  rule: Pick<RuleSet, 'condition' | 'activation'>,
  ctx: TriggerContext
): boolean {
  if (rule.activation?.costCheck && !evalCriteria(rule.activation.costCheck, state, ctx, def).value) return false;
  if (rule.condition && !evalCriteria(rule.condition, state, ctx, def).value) return false;
  return true;
}

/**
 * Every `(ruleId, cardId)` pair `seat` could legally activate right now inside window `windowId` —
 * `null` for `windowId` means "outside any window" (sorcery-speed), since `RuleSet.activation.window`
 * is itself `Id | null` with the identical meaning (§4.5): direct equality is the whole match.
 *
 * Cost + condition + window match (§8 step 24) — NOT ownership. Nothing here restricts a
 * `perInstance` rule to cards the acting seat controls; that restriction, when a game wants it, is
 * authored into `condition`/`costCheck` like every other constraint in this engine.
 */
export function activatableRules(
  state: PlayState,
  def: GameDefinition,
  seat: SeatId,
  windowId: Id | null
): ActivationCandidate[] {
  const out: ActivationCandidate[] = [];
  for (const rule of def.ruleSets) {
    const activation = rule.activation;
    if (!activation || activation.window !== windowId) continue;
    if (activation.perInstance) {
      const cardIds = Object.keys(state.cards).sort();
      for (const cardId of cardIds) {
        const card = state.cards[cardId];
        const template = def.templates.find((t) => t.id === card.templateId);
        if (!template || !template.ruleSetIds.includes(rule.id)) continue;
        if (passesActivationGates(state, def, rule, activationCtx(seat, cardId))) {
          out.push({ ruleId: rule.id, cardId, label: activation.label });
        }
      }
    } else if (passesActivationGates(state, def, rule, activationCtx(seat, null))) {
      out.push({ ruleId: rule.id, cardId: null, label: activation.label });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Opening a window — shared by `openPriority` (effects.ts) and `announceAction`'s `window` field
// (pending.ts). Both already know their `PriorityWindow` and the controller (or `null`) to resolve
// `controllerOfAction` against; this only builds `order` and pushes the frame.
// ---------------------------------------------------------------------------

export function openPriorityWindow(
  ec: EffectContext,
  effect: Effect,
  window: PriorityWindow,
  actionId: Id | null,
  actionController: SeatId | null
): EffectResult {
  const orderRes = resolveWindowOrder(window, ec.state, ec.ctx, actionController);
  if (!orderRes.ok) return reject(ec, effect, orderRes.reason, orderRes.message);
  push(ec.state, {
    kind: 'priority',
    windowId: window.id,
    actionId,
    order: orderRes.order,
    cursor: 0,
    consecutivePasses: 0,
    parentId: ec.parentId ?? null,
    depth: ec.depth,
  });
  emit(
    ec,
    effect,
    'info',
    `Priority window "${window.name}" opened — ${orderRes.order.length} seat(s) in order${
      orderRes.order.length ? `, starting seat ${orderRes.order[0]}` : ''
    }.`
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// advancePriority — the frame body, wired into dispatch.ts's `advance()` switch
// ---------------------------------------------------------------------------

const MORE: StepResult = { done: false, suspended: false, haltedByLoopGuard: false };
const SUSPENDED: StepResult = { done: true, suspended: true, haltedByLoopGuard: false };

type PriorityFrame = Extract<Frame, { kind: 'priority' }>;

function priorityPromptId(state: PlayState, frame: PriorityFrame): string {
  return `${state.logSeq}:priority:${frame.windowId}:${frame.id}:${frame.cursor}`;
}

/** §3.4's diagram — closing feeds a `resolve` frame for the CURRENT top of `actionStack`, not
 * necessarily `frame.actionId` (see the file header). No-op for a standalone window, or one whose
 * action already left the stack some other way. */
function resolveOnClose(frame: PriorityFrame, state: PlayState): void {
  if (frame.actionId === null) return;
  const topActionId = state.actionStack[state.actionStack.length - 1];
  if (topActionId === undefined) return;
  push(state, { kind: 'resolve', actionId: topActionId, parentId: frame.parentId, depth: frame.depth });
}

export function advancePriority(
  frame: PriorityFrame,
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[]
): StepResult {
  const window = def.priorityWindows.find((w) => w.id === frame.windowId);
  if (!window) {
    // Defensive — `definitionStore.ts`'s delete-protection (§8 step 21) means a window in use cannot
    // be deleted, so reaching here means something upstream pushed a dangling reference.
    pop(state);
    pushLine(lines, {
      level: 'error',
      kind: 'effect',
      message: `Priority window "${frame.windowId}" no longer exists in this definition.`,
      change: null,
      ruleId: null,
      effectKind: null,
      depth: frame.depth,
      visibility: null,
    });
    return MORE;
  }

  // §5.5 / §9.5 edge case 2 — read live, every check. Never captured at push time.
  const threshold = window.passesToClose ?? state.seatOrder.length;
  if (frame.order.length === 0 || frame.consecutivePasses >= threshold) {
    pop(state);
    resolveOnClose(frame, state);
    return MORE;
  }

  // §5.5's own cap — a real table can legitimately need a long response chain, so exhausting it is a
  // REJECT-level safety valve, not RULE_LOOP's catastrophic halt: the window simply closes early and
  // whatever it was covering resolves as if the table had finished passing.
  state.budget.priorityRounds += 1;
  if (state.budget.priorityRounds > def.limits.maxPriorityRounds) {
    pop(state);
    pushLine(lines, {
      level: 'reject',
      kind: 'skip',
      message: `Priority window "${window.name}" closed: PRIORITY_EXHAUSTED (priorityRounds ${state.budget.priorityRounds} > limit ${def.limits.maxPriorityRounds}).`,
      change: null,
      ruleId: null,
      effectKind: null,
      depth: frame.depth,
      visibility: null,
    });
    resolveOnClose(frame, state);
    return MORE;
  }

  const seat = frame.order[frame.cursor % frame.order.length];

  // §9.5 edge case 1 — a seat eliminated while the window is open is skipped silently: no log entry,
  // no interaction, and `consecutivePasses` is untouched (this is not a pass, it is an absence).
  if (!state.seatOrder.includes(seat)) {
    frame.cursor = (frame.cursor + 1) % frame.order.length;
    return MORE;
  }

  const legal = activatableRules(state, def, seat, frame.windowId);
  if (legal.length === 0) {
    // §5.5's pseudocode, verbatim: NO log entry, NO interaction.
    frame.consecutivePasses += 1;
    frame.cursor = (frame.cursor + 1) % frame.order.length;
    return MORE;
  }

  raise(state, {
    kind: 'priority',
    promptId: priorityPromptId(state, frame),
    windowId: frame.windowId,
    seat,
    legal,
  });
  pushLine(lines, {
    level: 'info',
    kind: 'prompt',
    message: `Priority (window "${window.name}"): seat ${seat} offered ${legal.length} legal response(s).`,
    change: null,
    ruleId: null,
    effectKind: null,
    depth: frame.depth,
    visibility: null,
  });
  return SUSPENDED;
}

// ---------------------------------------------------------------------------
// passPriority — the `passPriority` PlayAction. Dispatch.ts's `applyAction` delegates here once it
// has confirmed an interaction is open (mirrors how `pending.ts` owns the `resolve` frame's body).
// ---------------------------------------------------------------------------

const DONE: StepResult = { done: true, suspended: false, haltedByLoopGuard: false };

export function passPriority(state: PlayState, def: GameDefinition, lines: LogLine[]): StepResult {
  const interaction = state.interaction;
  if (!interaction || interaction.kind !== 'priority') {
    pushLine(lines, {
      level: 'reject',
      kind: 'skip',
      message: 'Pass priority ignored: no priority interaction is open.',
      change: null,
      ruleId: null,
      effectKind: null,
      depth: 0,
      visibility: null,
    });
    return DONE;
  }
  const head = top(state);
  if (!head || head.kind !== 'priority') {
    // Defensive — nothing pops a priority frame while it is the one holding `state.interaction`.
    pushLine(lines, {
      level: 'error',
      kind: 'skip',
      message: 'Pass priority ignored: the priority window is gone.',
      change: null,
      ruleId: null,
      effectKind: null,
      depth: 0,
      visibility: null,
    });
    return SUSPENDED;
  }
  const window = def.priorityWindows.find((w) => w.id === head.windowId);
  clear(state);
  // A DECLINE, not a response — increments the pass counter exactly like an auto-pass does, but
  // (unlike an auto-pass) this seat WAS offered something and chose not to take it, which is why it
  // gets its own LogEntry via the ordinary top-level-action path (MTG5) instead of no entry at all.
  head.consecutivePasses += 1;
  head.cursor = (head.cursor + 1) % head.order.length;
  pushLine(lines, {
    level: 'info',
    kind: 'prompt',
    message: `Seat ${interaction.seat} passes priority ("${window?.name ?? head.windowId}").`,
    change: null,
    ruleId: null,
    effectKind: null,
    depth: head.depth,
    visibility: null,
  });
  return MORE;
}
