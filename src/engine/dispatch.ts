/**
 * The work queue and `step()`. TECHNICAL_DESIGN.md §3.3, §5.1–§5.5, §5.9 rows 6/7/8/8b/8c/9/16/17.
 *
 * `step()` performs exactly ONE unit of work and returns. Everything still owed lives in
 * `state.queue`, which is inside `PlayState` and therefore serializable, patchable and rewindable.
 * The store re-enters with CONTINUE until `done`. There is no recursion anywhere in this file: with
 * recursion the in-flight rule state would live on the JS call stack, which cannot be serialized,
 * snapshotted or unwound — and prompt suspension plus rewind both need exactly that.
 *
 * Fired events go to the queue TAIL (breadth-first, §5.1). The RULES of an event go to the HEAD, so
 * one event resolves fully before the next queued event starts — that is what makes
 * `onZoneExit → onZoneEnter → onCardPlayed` read in the order the tester sees.
 */

import {
  ACTIVE_PLAYER_POOL_ID,
  CARD_BINDING_EVENTS,
  type Effect,
  type EngineInput,
  type EventName,
  type GameDefinition,
  type CardTemplate,
  type Id,
  type LogLine,
  type PlayAction,
  type PlayState,
  type RejectReason,
  type RuleSet,
  type StepResult,
  type TargetSelector,
  type TriggerContext,
  type WorkItem,
  type ZoneRef,
} from './types';
import { evalCriteria } from './criteria';
import { applyEffect, canMove, type EffectContext } from './effects';
import { applyTransition, findAutoTransition } from './stateMachine';
import { CHOSEN_PROMPT_KEY, resolveTargets } from './targets';
import { resolveSeat, zoneKey } from './valueRef';

// ---------------------------------------------------------------------------
// Results and logging
// ---------------------------------------------------------------------------

const MORE: StepResult = { done: false, suspended: false, haltedByLoopGuard: false };
const DONE: StepResult = { done: true, suspended: false, haltedByLoopGuard: false };
const SUSPENDED: StepResult = { done: true, suspended: true, haltedByLoopGuard: false };
const HALTED: StepResult = { done: true, suspended: false, haltedByLoopGuard: true };

/** Authoring/data faults are ERROR; rule-legal refusals are REJECT (§5.9 preamble). */
const ERROR_REASONS: readonly RejectReason[] = [
  'MISSING_REFERENT',
  'TARGET_GONE',
  'TYPE_MISMATCH',
  'INVALID_SEAT',
  'UNBOUND_REF',
];
const levelFor = (reason: RejectReason) => (ERROR_REASONS.includes(reason) ? 'error' : 'reject');

type LogInput = Pick<LogLine, 'level' | 'kind' | 'message'> & Partial<LogLine>;

function log(lines: LogLine[], entry: LogInput): void {
  lines.push({ change: null, ruleId: null, effectKind: null, depth: 0, ...entry });
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** Distributes over the union — a plain `Omit` on `WorkItem` would collapse it to the common keys. */
type NewWorkItem = WorkItem extends infer T ? (T extends WorkItem ? Omit<T, 'id'> : never) : never;

/** Tail. Every fired event lands here (§5.1). */
export function enqueue(state: PlayState, item: NewWorkItem): void {
  state.queue.push({ ...item, id: state.nextWorkId++ } as WorkItem);
}

/** Head, order preserved. Only the rules of the event being resolved, and a suspended effect. */
function enqueueFront(state: PlayState, items: NewWorkItem[]): void {
  state.queue.unshift(...items.map((i) => ({ ...i, id: state.nextWorkId++ }) as WorkItem));
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

const activeSeat = (state: PlayState): number => Number(state.pools[ACTIVE_PLAYER_POOL_ID] ?? 0);

/**
 * `@chosen` is the answer to the prompt of the effect being applied RIGHT NOW. effects.ts forwards
 * `ctx.promptAnswers` by reference into every event it fires, so without this a rule bound to that
 * child event inherits the key, its own `prompt` selector short-circuits in targets.ts, and the
 * nested prompt is never raised — logged, misleadingly, as "0 legal targets. Prompt skipped."
 */
function stripChosen(ctx: TriggerContext): TriggerContext {
  if (!(CHOSEN_PROMPT_KEY in ctx.promptAnswers)) return ctx;
  const promptAnswers = { ...ctx.promptAnswers };
  delete promptAnswers[CHOSEN_PROMPT_KEY];
  return { ...ctx, promptAnswers };
}

function baseCtx(state: PlayState): TriggerContext {
  return { triggeringCardId: null, zoneKey: null, triggeringSeat: activeSeat(state), promptAnswers: {} };
}

function makeEc(
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[],
  ctx: TriggerContext,
  depth: number,
  parentId: number | null,
  override: boolean,
  ruleId: Id | null,
  effectKind: Effect['kind'] | null
): EffectContext {
  return {
    state,
    def,
    ctx,
    depth,
    override,
    // Filling in a null ruleId/effectKind is this module's job — effects.ts does not know which
    // RuleSet is driving it, and H2 requires every change line to name one.
    log: (l) =>
      lines.push({ ...l, ruleId: l.ruleId ?? ruleId, effectKind: l.effectKind ?? effectKind }),
    // depth + 1 and tail placement are enforced HERE, not in effects.ts (§5.5, §5.1).
    fireEvent: (name, childCtx, stateId) =>
      enqueue(state, {
        kind: 'event',
        name,
        ctx: stripChosen(childCtx),
        ...(stateId !== undefined && { stateId }),
        parentId,
        depth: depth + 1,
      }),
  };
}

// ---------------------------------------------------------------------------
// Bindings — §5.2. Snapshot at frame start; sort is TOTAL.
// ---------------------------------------------------------------------------

interface Binding {
  rule: RuleSet;
  sourceCardId: Id | null;
  /** 0 game-level, 1 card-attached. */
  scope: number;
  zoneOrder: number;
  position: number;
  seat: number;
}

/**
 * §5.2's sort key in order: priority desc, scope, zone declaration order, position in zone
 * (top = 0), seat, then authored RuleSet id. The id tiebreak is what makes it TOTAL — without it a
 * stable-sort accident or object iteration order changes replay across export/import (§9.4 item 4).
 */
function compareBindings(a: Binding, b: Binding): number {
  return (
    b.rule.priority - a.rule.priority ||
    a.scope - b.scope ||
    a.zoneOrder - b.zoneOrder ||
    a.position - b.position ||
    a.seat - b.seat ||
    (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0) ||
    String(a.sourceCardId).localeCompare(String(b.sourceCardId))
  );
}

/**
 * Id lookups, derived purely from the (immutable) definition. Cached because a runaway chain
 * resolves bindings tens of thousands of times, and `ruleSets.find` per rule is what turns §9.3's
 * "under 100ms" into seconds on a large definition.
 */
const defIndex = new WeakMap<GameDefinition, { rules: Map<Id, RuleSet>; templates: Map<Id, CardTemplate> }>();

function indexOf(def: GameDefinition) {
  let index = defIndex.get(def);
  if (!index) {
    index = {
      rules: new Map(def.ruleSets.map((r) => [r.id, r] as const)),
      templates: new Map(def.templates.map((t) => [t.id, t] as const)),
    };
    defIndex.set(def, index);
  }
  return index;
}

function resolveBindings(
  name: EventName,
  ctx: TriggerContext,
  state: PlayState,
  def: GameDefinition,
  /** The state a queued `onStateExit` left, when the item carries one. */
  eventStateId: Id | null
): Binding[] {
  const { rules: byId, templates } = indexOf(def);

  /**
   * Under the four CARD_BINDING_EVENTS a card-attached RuleSet fires ONLY for the card that
   * triggered the event. Otherwise a fourth Grunt entering the Battlefield fires all four copies of
   * "on enter, attackers +1", the generated prose ("when this card is played") is a lie, and a rule
   * runs with `triggeringCard` pointing at some other card. Board-wide reactions are expressed as
   * GLOBAL rules, which are never filtered here. Every other trigger has no triggering card, so
   * card rules bind board-wide and §5.2's zone/position/seat ordering still decides their order.
   */
  const selfScoped = (CARD_BINDING_EVENTS as readonly string[]).includes(name);

  // stateFilter matches currentStateId for onStateEnter. For onStateExit the transition has already
  // landed by the time the queued event drains, so currentStateId is the DESTINATION — the item
  // carries the state that was left and that is what the filter is matched against instead.
  const filterState = name === 'onStateExit' ? (eventStateId ?? state.currentStateId) : state.currentStateId;
  const matches = (rule: RuleSet | undefined): rule is RuleSet =>
    rule !== undefined &&
    rule.trigger === name &&
    (rule.stateFilter === null ||
      (name !== 'onStateEnter' && name !== 'onStateExit') ||
      rule.stateFilter === filterState);

  const out: Binding[] = [];
  for (const id of def.globalRuleSetIds) {
    const rule = byId.get(id);
    if (matches(rule)) out.push({ rule, sourceCardId: null, scope: 0, zoneOrder: 0, position: 0, seat: -1 });
  }

  // Keys are built from the definition, never from Object.keys(state.zones) — §9.4 item 4.
  def.zones.forEach((zone, zoneOrder) => {
    const keys =
      zone.scope === 'shared'
        ? [zoneKey(zone.id, null)]
        : Array.from({ length: state.playerCount }, (_, s) => zoneKey(zone.id, s));
    keys.forEach((key, seat) => {
      const inst = state.zones[key];
      if (!inst) return;
      inst.cardIds.forEach((cardId, position) => {
        // Not a match, not a skip — logging every unbound copy would drown the log on a wide board.
        if (selfScoped && cardId !== ctx.triggeringCardId) return;
        const card = state.cards[cardId];
        const template = card && templates.get(card.templateId);
        if (!template) return;
        for (const ruleId of template.ruleSetIds) {
          const rule = byId.get(ruleId);
          if (matches(rule)) {
            out.push({
              rule,
              sourceCardId: cardId,
              scope: 1,
              zoneOrder,
              position,
              seat: zone.scope === 'shared' ? -1 : seat,
            });
          }
        }
      });
    });
  });

  return out.sort(compareBindings);
}

// ---------------------------------------------------------------------------
// Loop guard — §5.5. BOTH counters; override never bypasses it.
// ---------------------------------------------------------------------------

function tripLoopGuard(state: PlayState, def: GameDefinition, lines: LogLine[], tripped: string): StepResult {
  const discarded = state.queue.length;
  state.queue = [];
  // A suspension inside a runaway chain is not resumable.
  state.pendingPrompt = null;
  // ponytail: the chain is rendered from the event lines already in this transaction's log rather
  // than by walking WorkItem.parentId — the ancestors have been dequeued, so an exact walk would
  // need a frame table living in PlayState (patched and rewound every step) to render one message.
  // parentId/id are threaded correctly on every item, so that table can be added without changes here.
  const chain = lines
    .filter((l) => l.kind === 'event')
    .slice(-8)
    .map((l) => `      depth ${l.depth}  ${l.message}`)
    .join('\n');
  log(lines, {
    level: 'error',
    kind: 'rule',
    depth: state.budget.causalDepth,
    message:
      `Possible rule loop — chain halted.\n` +
      `  Tripped: ${tripped}   (effects executed ${state.budget.effectsUsed} / ${def.limits.maxEffects})\n` +
      `  Chain (most recent 8 frames):\n${chain}\n` +
      `  Discarded ${discarded} queued events. State is at the last completed effect — use Rewind to back this out.`,
  });
  return HALTED;
}

// ---------------------------------------------------------------------------
// Effects — §5.3, §5.4
// ---------------------------------------------------------------------------

/** The five effects that carry a target; only a `prompt` target suspends. */
function promptTarget(effect: Effect): Extract<TargetSelector, { kind: 'prompt' }> | null {
  return 'target' in effect && effect.target.kind === 'prompt' ? effect.target : null;
}

const promptIdOf = (state: PlayState, ruleId: Id, effectIndex: number) =>
  `${state.logSeq}:${ruleId}:${effectIndex}`;

function runEffects(
  state: PlayState,
  def: GameDefinition,
  lines: LogLine[],
  rule: RuleSet,
  ctx: TriggerContext,
  fromIndex: number,
  depth: number,
  parentId: number | null
): StepResult {
  for (let i = fromIndex; i < rule.effects.length; i++) {
    const effect = rule.effects[i];
    const selector = promptTarget(effect);
    const promptId = promptIdOf(state, rule.id, i);
    let chosen: Id[] | undefined;

    if (selector) {
      chosen = ctx.promptAnswers[promptId];
      if (chosen === undefined) {
        // §5.4 hard rule: raise BEFORE any mutation. This effect executes twice — once to raise,
        // once to complete — so it must be re-entrant by construction.
        const candidates = resolveTargets(selector, state, ctx, def);
        if (!candidates.ok || candidates.kind !== 'prompt') {
          // Zero legal targets → the prompt is NOT raised (§5.9 row 8). A modal with nothing
          // clickable is a dead end; this holds even when min is 0.
          const reason = candidates.ok ? 'NO_TARGETS' : candidates.reason;
          log(lines, {
            level: levelFor(reason),
            kind: 'prompt',
            depth,
            ruleId: rule.id,
            effectKind: effect.kind,
            message: `Prompt "${selector.promptText}" (seat ${promptSeat(state, ctx)}): ${
              candidates.ok ? '0 legal targets' : candidates.message
            } Prompt skipped.`,
          });
          if (rule.onRejection === 'abort') return MORE;
          continue;
        }
        state.pendingPrompt = {
          promptId,
          promptText: candidates.promptText,
          seat: promptSeat(state, ctx),
          candidates: [...candidates.candidates],
          min: candidates.min,
          max: candidates.max,
        };
        enqueueFront(state, [{ kind: 'effect', ruleId: rule.id, effectIndex: i, ctx, parentId, depth }]);
        log(lines, {
          level: 'info',
          kind: 'prompt',
          depth,
          ruleId: rule.id,
          effectKind: effect.kind,
          message: `Prompt "${candidates.promptText}" (seat ${state.pendingPrompt.seat}): ${candidates.candidates.length} legal targets.`,
        });
        return SUSPENDED;
      }
    }

    // Counted only when an effect actually applies — the prompt-raising pass mutates nothing.
    state.budget.effectsUsed += 1;
    if (state.budget.effectsUsed > def.limits.maxEffects) {
      return tripLoopGuard(
        state,
        def,
        lines,
        `effectsUsed ${state.budget.effectsUsed} > limit ${def.limits.maxEffects}   (causalDepth ${state.budget.causalDepth})`
      );
    }

    const effectCtx = chosen
      ? { ...ctx, promptAnswers: { ...ctx.promptAnswers, [CHOSEN_PROMPT_KEY]: chosen } }
      : ctx;
    const result = applyEffect(
      effect,
      // Override is ACTION-scoped (§5.9 rows 1b/5c): it is a property of the tester's own move,
      // never of rule execution, so a rule-driven effect is always evaluated without it.
      makeEc(state, def, lines, effectCtx, depth, parentId, false, rule.id, effect.kind)
    );
    if (!result.ok) {
      log(lines, {
        level: levelFor(result.reason),
        kind: 'effect',
        depth,
        ruleId: rule.id,
        effectKind: effect.kind,
        message: `${effect.kind}: ${result.detail ?? result.reason}`,
      });
      // abort stops the REMAINING effects. Already-applied effects stay — abort is not rollback (§5.3).
      if (rule.onRejection === 'abort') {
        log(lines, {
          level: 'info',
          kind: 'skip',
          depth,
          ruleId: rule.id,
          message: `RuleSet "${rule.name}" aborted after effect ${i + 1} of ${rule.effects.length}.`,
        });
        return MORE;
      }
    }
  }
  return MORE;
}

const promptSeat = (state: PlayState, ctx: TriggerContext) => ctx.triggeringSeat ?? activeSeat(state);

// ---------------------------------------------------------------------------
// One work item
// ---------------------------------------------------------------------------

function runItem(item: WorkItem, state: PlayState, def: GameDefinition, lines: LogLine[]): StepResult {
  switch (item.kind) {
    case 'event': {
      const bindings = resolveBindings(item.name, item.ctx, state, def, item.stateId ?? null);
      // Row 6: a custom event with no bound RuleSet is NOT an error.
      log(lines, {
        level: 'info',
        kind: 'event',
        depth: item.depth,
        message: `Event "${item.name}" fired — ${bindings.length} rules bound.`,
      });
      // Rules of THIS event run before any queued sibling event (§5.1).
      enqueueFront(
        state,
        bindings.map((b) => ({
          kind: 'rule' as const,
          ruleId: b.rule.id,
          sourceCardId: b.sourceCardId,
          // promptAnswers is copied, not aliased: promptIds are `logSeq:ruleId:effectIndex`, so two
          // bindings of the SAME rule under one event compute the same id. Sharing the map would let
          // the first binding's answer satisfy the second's prompt, which then never raises.
          ctx: { ...item.ctx, promptAnswers: { ...item.ctx.promptAnswers } },
          parentId: item.id,
          depth: item.depth,
        }))
      );
      return MORE;
    }

    case 'rule': {
      const rule = indexOf(def).rules.get(item.ruleId);
      if (!rule) return MORE;
      // Bindings were snapshotted when the event frame began — re-validate existence now (§5.9 row 16).
      if (item.sourceCardId !== null && !state.cards[item.sourceCardId]) {
        log(lines, {
          level: 'info',
          kind: 'skip',
          depth: item.depth,
          ruleId: rule.id,
          message: `Skipped RuleSet "${rule.name}" on ${item.sourceCardId}: card destroyed earlier this event.`,
        });
        return MORE;
      }
      // Conditions are evaluated NOW, not snapshotted — earlier rules on the same event gate later
      // ones (§5.2).
      if (rule.condition) {
        const verdict = evalCriteria(rule.condition, state, item.ctx, def);
        if (!verdict.value) {
          const failing = verdict.leaves.find((l) => !l.value) ?? verdict.leaves[0];
          log(lines, {
            level: 'info',
            kind: 'skip',
            depth: item.depth,
            ruleId: rule.id,
            message: `Skipped RuleSet "${rule.name}" — condition false: ${failing?.description ?? 'no leaves'}.`,
          });
          return MORE;
        }
      }
      log(lines, {
        level: 'info',
        kind: 'rule',
        depth: item.depth,
        ruleId: rule.id,
        message: `RuleSet "${rule.name}"${item.sourceCardId ? ` on ${item.sourceCardId}` : ''}.`,
      });
      return runEffects(state, def, lines, rule, item.ctx, 0, item.depth, item.id);
    }

    case 'effect': {
      const rule = indexOf(def).rules.get(item.ruleId);
      if (!rule) return MORE;
      // No source-card re-validation here: destroying the card whose RuleSet is executing must NOT
      // abort its remaining effects — every "when this dies" combo depends on that (§9.4 item 14).
      return runEffects(state, def, lines, rule, item.ctx, item.effectIndex, item.depth, item.id);
    }

    case 'transition': {
      // Queued by a `forceTransition` effect. applyTransition owns legality and its own logging;
      // `forced` is a log marker, not a bypass — only override bypasses (§5.9 row 5c).
      applyTransition(
        makeEc(state, def, lines, baseCtx(state), item.depth, item.id, false, null, null),
        item.toStateId,
        { forced: item.forced }
      );
      return MORE;
    }
  }
}

// ---------------------------------------------------------------------------
// Draining and quiescence — §5.1's transaction skeleton
// ---------------------------------------------------------------------------

function drain(state: PlayState, def: GameDefinition, lines: LogLine[]): StepResult {
  if (state.pendingPrompt) return SUSPENDED;

  const item = state.queue.shift();
  if (item) {
    if (item.depth > def.limits.maxDepth) {
      state.budget.causalDepth = item.depth;
      return tripLoopGuard(state, def, lines, `causalDepth ${item.depth} > limit ${def.limits.maxDepth}`);
    }
    state.budget.causalDepth = Math.max(state.budget.causalDepth, item.depth);
    return runItem(item, state, def, lines);
  }

  // Quiescence. Auto-transitions are scanned ONLY here (§5.1, §5.6).
  if (state.finished) return DONE;
  const auto = findAutoTransition(state, def, baseCtx(state));
  if (!auto) return DONE;

  state.budget.causalDepth += 1;
  if (state.budget.causalDepth > def.limits.maxDepth) {
    return tripLoopGuard(state, def, lines, `causalDepth ${state.budget.causalDepth} > limit ${def.limits.maxDepth}`);
  }
  if (auto.eligible.length > 1) {
    log(lines, {
      level: 'warn',
      kind: 'transition',
      depth: state.budget.causalDepth,
      message: `${auto.eligible.length} transitions eligible from "${state.currentStateId}": ${auto.eligible.join(', ')}. Took "${auto.toStateId}" (exitableTo order).`,
    });
  }
  applyTransition(
    makeEc(state, def, lines, baseCtx(state), state.budget.causalDepth, null, false, null, null),
    auto.toStateId,
    { forced: false }
  );
  return MORE;
}

// ---------------------------------------------------------------------------
// Actions — §5.1, §5.4, §5.9 rows 9/10/15
// ---------------------------------------------------------------------------

function zoneKeyOf(ref: ZoneRef, state: PlayState, ctx: TriggerContext): string | null {
  if (ref.seat === null) return zoneKey(ref.zoneId, null);
  const seats = resolveSeat(ref.seat, state, ctx);
  return seats.ok && seats.seats.length === 1 ? zoneKey(ref.zoneId, seats.seats[0]) : null;
}

function zoneKeyHolding(state: PlayState, cardId: Id): string | null {
  for (const [key, inst] of Object.entries(state.zones)) {
    if (inst.cardIds.includes(cardId)) return key;
  }
  return null;
}

function applyAction(
  state: PlayState,
  action: PlayAction,
  override: boolean,
  def: GameDefinition,
  lines: LogLine[]
): StepResult {
  const reject = (reason: RejectReason, message: string, result = DONE): StepResult => {
    log(lines, { level: levelFor(reason), kind: 'skip', message });
    return result;
  };

  if (state.finished) {
    return reject('SESSION_FINISHED', 'Session finished at "End". Only Rewind is accepted.');
  }
  const resuming = action.kind === 'answerPrompt' || action.kind === 'cancelPrompt';
  if (state.pendingPrompt && !resuming) {
    // Row 9. Rewind is the store's job and never reaches step().
    return reject(
      'AWAITING_PROMPT',
      `Input ignored: awaiting response to prompt "${state.pendingPrompt.promptText}".`,
      SUSPENDED
    );
  }
  // A user action opens a transaction (§5.1). A resume CONTINUES the open one, budget included.
  // Field-by-field, and only when non-zero: assigning a fresh object literal makes immer record a
  // whole-object `replace` on every action even when nothing changed, doubling the patches in each
  // history frame for no gain.
  if (!resuming) {
    if (state.budget.causalDepth !== 0) state.budget.causalDepth = 0;
    if (state.budget.effectsUsed !== 0) state.budget.effectsUsed = 0;
  }

  const ctx = baseCtx(state);

  switch (action.kind) {
    case 'start': {
      enqueue(state, { kind: 'event', name: 'onGameStart', ctx, parentId: null, depth: 1 });
      return MORE;
    }

    case 'moveCard': {
      const card = state.cards[action.cardId];
      if (!card) return reject('TARGET_GONE', `Move ${action.cardId}: card no longer exists.`);
      const to = zoneKeyOf(action.to, state, ctx);
      if (to === null || !state.zones[to]) {
        return reject('MISSING_REFERENT', `Move ${action.cardId} → "${action.to.zoneId}": zone does not exist.`);
      }
      const from = zoneKeyHolding(state, action.cardId);
      if (from === to) {
        // Row 15 — no-op, and no zone events. The largest source of accidental loops (§5.1).
        log(lines, {
          level: 'info',
          kind: 'change',
          message: `Move ${action.cardId} → ${to}: already in that zone. No-op, no events fired.`,
        });
        return DONE;
      }
      const allowed = canMove(state, def, [action.cardId], to);
      if (!allowed.ok && !override) {
        return reject(allowed.reason, `Move ${action.cardId} → ${to}: ${allowed.detail ?? allowed.reason}`);
      }
      if (!allowed.ok) {
        log(lines, {
          level: 'override',
          kind: 'change',
          message: `Move ${action.cardId} → ${to}: ${allowed.detail ?? allowed.reason} Performed anyway.`,
        });
      }

      if (from) {
        const src = state.zones[from].cardIds;
        src.splice(src.indexOf(action.cardId), 1);
      }
      const dst = state.zones[to].cardIds;
      if (action.position === 'top') dst.unshift(action.cardId);
      else if (action.position === 'bottom') dst.push(action.cardId);
      else dst.splice(Math.max(0, Math.min(dst.length, action.position.index)), 0, action.cardId);

      log(lines, {
        level: 'info',
        kind: 'change',
        message: `Move ${action.cardId}: ${from ?? '(nowhere)'} → ${to}.`,
        change: { path: `zones/${to}/cardIds`, before: from, after: to },
      });

      // §5.1 compound enqueue order: the card is physically settled before the semantic event runs.
      const cardCtx = (key: string | null): TriggerContext => ({
        triggeringCardId: action.cardId,
        zoneKey: key,
        triggeringSeat: key === null ? ctx.triggeringSeat : (state.zones[key]?.seat ?? ctx.triggeringSeat),
        promptAnswers: {},
      });
      if (from) enqueue(state, { kind: 'event', name: 'onZoneExit', ctx: cardCtx(from), parentId: null, depth: 1 });
      enqueue(state, { kind: 'event', name: 'onZoneEnter', ctx: cardCtx(to), parentId: null, depth: 1 });
      // onCardDrawn belongs to the drawCards effect alone (§4.7) — a tester's move is a play.
      enqueue(state, { kind: 'event', name: 'onCardPlayed', ctx: cardCtx(to), parentId: null, depth: 1 });
      return MORE;
    }

    case 'flipCard':
    case 'rotateCard': {
      const card = state.cards[action.cardId];
      if (!card) return reject('TARGET_GONE', `${action.kind} ${action.cardId}: card no longer exists.`);
      const field = action.kind === 'flipCard' ? 'faceDown' : 'rotated';
      const before = card[field];
      const after =
        action.to === 'toggle' ? !before : action.to === 'faceDown' || action.to === 'rotated';
      card[field] = after;
      log(lines, {
        level: 'info',
        kind: 'change',
        message: `${action.kind} ${action.cardId}: ${before} → ${after}.`,
        change: { path: `cards/${action.cardId}/${field}`, before, after },
      });
      return MORE;
    }

    case 'transition': {
      // applyTransition checks both sides of the edge, honours override and logs the outcome.
      const done = applyTransition(
        makeEc(state, def, lines, ctx, 0, null, override, null, null),
        action.toStateId,
        { forced: false }
      );
      return done.ok ? MORE : DONE;
    }

    case 'fireEvent': {
      enqueue(state, {
        kind: 'event',
        name: action.name,
        ctx: { ...ctx, triggeringSeat: action.seat ?? ctx.triggeringSeat },
        parentId: null,
        depth: 1,
      });
      return MORE;
    }

    case 'answerPrompt': {
      const pending = state.pendingPrompt;
      if (!pending) return reject('INVALID_ANSWER', 'Prompt answer ignored: no prompt is pending.');
      // Trust boundary: UI highlighting is not enforcement (§9.3). Nothing below mutates state
      // until every check has passed, so a rejected answer leaves the suspension untouched.
      const legal = new Set(pending.candidates);
      const unique = new Set(action.chosen);
      if (unique.size !== action.chosen.length || action.chosen.some((id) => !legal.has(id))) {
        return reject(
          'INVALID_ANSWER',
          `Prompt answer invalid: selection is not a subset of the ${pending.candidates.length} legal targets.`,
          SUSPENDED
        );
      }
      if (action.chosen.length < pending.min || action.chosen.length > pending.max) {
        const expected =
          pending.min === pending.max ? `exactly ${pending.min}` : `${pending.min}–${pending.max}`;
        return reject(
          'INVALID_ANSWER',
          `Prompt answer invalid: ${action.chosen.length} cards selected, expected ${expected}.`,
          SUSPENDED
        );
      }
      const head = state.queue[0];
      if (!head || head.kind !== 'effect') {
        return reject('INVALID_ANSWER', 'Prompt answer ignored: the suspended effect is gone.', SUSPENDED);
      }
      head.ctx.promptAnswers[pending.promptId] = [...action.chosen];
      state.pendingPrompt = null;
      log(lines, {
        level: 'info',
        kind: 'prompt',
        depth: head.depth,
        ruleId: head.ruleId,
        message: `Prompt "${pending.promptText}" (seat ${pending.seat}) answered: ${action.chosen.join(', ')}.`,
      });
      return MORE;
    }

    case 'cancelPrompt': {
      const pending = state.pendingPrompt;
      if (!pending) return reject('PROMPT_CANCELED', 'Cancel ignored: no prompt is pending.');
      const head = state.queue[0];
      state.pendingPrompt = null;
      log(lines, {
        level: 'reject',
        kind: 'prompt',
        message: `Prompt "${pending.promptText}" (seat ${pending.seat}): canceled by tester.`,
      });
      // Not an override, and not flagged as one. The RuleSet then continues or aborts per
      // onRejection (§5.9 row 8b) — resuming at the SAME index would just re-raise the prompt.
      if (head?.kind === 'effect') {
        state.queue.shift();
        const rule = indexOf(def).rules.get(head.ruleId);
        if (rule && rule.onRejection === 'continue' && head.effectIndex + 1 < rule.effects.length) {
          enqueueFront(state, [
            {
              kind: 'effect',
              ruleId: head.ruleId,
              effectIndex: head.effectIndex + 1,
              ctx: head.ctx,
              parentId: head.parentId,
              depth: head.depth,
            },
          ]);
        }
      }
      return MORE;
    }
  }
}

// ---------------------------------------------------------------------------

/** Exactly ONE unit of work per call. §3.3. */
export function step(
  state: PlayState,
  input: EngineInput,
  lines: LogLine[],
  def: GameDefinition
): StepResult {
  return input.kind === 'action'
    ? applyAction(state, input.action, input.override, def, lines)
    : drain(state, def, lines);
}
