/**
 * `applyEffect` — the eleven effect kinds. TECHNICAL_DESIGN.md §4.7, §5.1, §5.3, §5.9.
 *
 * Three rules the rest of the engine leans on:
 *
 *  - **Effect-level atomicity (§5.3).** Every effect computes its full plan against the current
 *    state, checks it, and only then mutates. Moving three cards where the second would overflow
 *    moves zero. There is no partial mutation followed by a rollback anywhere in this file.
 *  - **Shortfall vs constraint (§5.3), deliberately asymmetric.** A *quantity* shortfall (draw 2
 *    from a 1-card deck) is a partial success with a `[WARN]`. A *constraint* (capacity, a missing
 *    referent, a dead target) is a full rejection. Do not collapse the two.
 *  - **No-op writes fire no events (§5.1).** Writing 5 to a pool holding 5, a `-5` fully absorbed
 *    by a min clamp, and a move to the zone the card already occupies all fire nothing. This is
 *    called out as the single largest source of accidental infinite loops.
 *
 * `state` is a mutable immer draft, mutated in place. This module never imports immer (§3.2) and
 * never dispatches: `fireEvent` only appends to `state.pending`, and `forceTransition` applies the
 * transition at its position in the effect list (§5.6) while its state events go to that same
 * pending FIFO.
 */

import { parseZoneKey, resolveCardRef, resolvePoolDef, resolveSeat, resolveValueRef, zoneKey } from './valueRef';
import type { ResolutionFail } from './valueRef';
import { type CandidateLog, resolveTargets } from './targets';
// Cyclic with `modifiers.ts` (it imports `clampValue` from here) by design (§5.4). Both directions
// are function-body calls only, so module evaluation order never matters.
import { effectiveIndex, invalidateEffective } from './modifiers';
import { applyTransition } from './stateMachine';
import { hashSeed, shuffle } from './rng';
// §5.7 — replacement.ts imports `EffectContext` back from here, but only as a type (`import type`),
// which is erased at compile time. No runtime cycle: this file is the only one of the pair that
// actually depends on the other at runtime.
import { applyWithReplacement } from './replacement';
import type {
  Effect,
  EffectResult,
  EventName,
  GameDefinition,
  GameValue,
  Id,
  InsertPosition,
  LogLevel,
  LogLine,
  NumericOp,
  PlayState,
  RejectReason,
  TriggerContext,
  ZoneKey,
  ZoneRef,
} from './types';

export interface EffectContext {
  /** A MUTABLE immer draft. Mutate it directly; never clone. */
  state: PlayState;
  def: GameDefinition;
  ctx: TriggerContext;
  depth: number;
  override: boolean;
  log(line: LogLine): void;
  /**
   * APPENDS to `state.pending` only. dispatch.ts owns depth+1 and the FIFO placement (§3.2).
   * `stateId` is for `onStateExit` alone — the state being LEFT, which stateFilter matching needs
   * because `currentStateId` is already the destination when the pending event is promoted.
   */
  fireEvent(name: EventName, ctx: TriggerContext, stateId?: Id): void;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * §5.9's levels. `REJECT` is a rule-legal refusal, `ERROR` an authoring/data fault — the split
 * matters because the log panel colours them differently and only ERROR indicates a broken game.
 */
const LEVEL_OF: Record<RejectReason, LogLevel> = {
  ZONE_FULL: 'reject',
  TARGET_GONE: 'error',
  NO_TARGETS: 'reject',
  ILLEGAL_TRANSITION: 'reject',
  ONE_SIDED_EDGE: 'reject',
  MISSING_REFERENT: 'error',
  TYPE_MISMATCH: 'error',
  INVALID_SEAT: 'error',
  UNBOUND_REF: 'error',
  RULE_LOOP: 'error',
  AWAITING_PROMPT: 'reject',
  INVALID_ANSWER: 'reject',
  PROMPT_CANCELED: 'reject',
  SESSION_FINISHED: 'reject',
  // The fixpoint failed to converge — that is a broken game, not a rule-legal refusal, so it sits
  // with RULE_LOOP rather than with the rejections (v2 §4.12, §5.3).
  SETTLE_DIVERGED: 'error',
  // Rule-legal: acting on an ousted seat is a refusal, not a broken game (§5.12).
  SEAT_ELIMINATED: 'reject',
  // v2 §4.12, §5.8 — a cost genuinely could not be paid. Rule-legal, like ZONE_FULL.
  COST_UNPAYABLE: 'reject',
  // v2 §4.12, §5.8 — wrong window, or `activation` is null. Rule-legal.
  NOT_ACTIVATABLE: 'reject',
  // v2 §4.12 — a targeted action was countered before resolving. Rule-legal.
  ACTION_COUNTERED: 'reject',
  // v2 §4.12, §5.5 — the priority round cap. Not a broken game the way RULE_LOOP/SETTLE_DIVERGED
  // are: a real table can legitimately hit `maxPriorityRounds` on a long response chain, and the
  // fix is raising the limit, not treating the session as corrupt.
  PRIORITY_EXHAUSTED: 'reject',
};

/**
 * `ruleId` is null here: this module is not told which RuleSet is in flight. dispatch.ts knows,
 * and stamps it in its own `log` wrapper — that is where H2's "non-null ruleId" comes from.
 */
function emit(
  ec: EffectContext,
  e: Effect,
  level: LogLevel,
  message: string,
  change: LogLine['change'] = null,
  kind: LogLine['kind'] = 'effect'
): void {
  ec.log({ level, kind, message, change, ruleId: null, effectKind: e.kind, depth: ec.depth });
}

function reject(ec: EffectContext, e: Effect, reason: RejectReason, message: string): EffectResult {
  emit(ec, e, LEVEL_OF[reason], message);
  return { ok: false, reason, detail: message };
}

const failed = (ec: EffectContext, e: Effect, f: ResolutionFail): EffectResult =>
  reject(ec, e, f.reason, f.message);

/**
 * §4.4, §5.9 level 3 — the sink `resolveTargets` writes one include/exclude line into per candidate
 * of a `matching` selector. Every targeted effect passes it, because a predicate selector is legal
 * in any of their `target` slots and a line nobody wired up is a line that does not exist.
 *
 * Unconditional for now: §5.9's verbosity gate is step 30's, and it goes here rather than inside
 * the resolver so that what gets EVALUATED never depends on who is listening.
 */
const candidateLog =
  (ec: EffectContext, e: Effect): CandidateLog =>
  (line) =>
    emit(ec, e, 'info', line.message, null, line.kind);

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/** "Hand (seat 0)" / "Battlefield" — the shape §5.9's example messages use. */
function zoneLabel(def: GameDefinition, key: ZoneKey): string {
  const { zoneId, seat } = parseZoneKey(key);
  const name = def.zones.find((z) => z.id === zoneId)?.name ?? zoneId;
  return seat === null ? name : `${name} (seat ${seat})`;
}

function keysOf(
  zone: ZoneRef,
  state: PlayState,
  ctx: TriggerContext
): { ok: true; keys: ZoneKey[] } | ResolutionFail {
  if (zone.seat === null) return { ok: true, keys: [zoneKey(zone.zoneId, null)] };
  const seats = resolveSeat(zone.seat, state, ctx);
  if (!seats.ok) return seats;
  // §5.12's other half. `{kind:'seat', index}` deliberately still RESOLVES for an ousted seat so the
  // log and the UI can name it, but an effect may not move cards into or out of that seat's zones.
  // `resolveSeat` cannot make the call — it is not told whether its caller is reading or writing —
  // so the refusal lives here, on the one path every effect's zone operand goes through.
  const ousted = seats.seats.find((s) => state.eliminated.includes(s));
  if (ousted !== undefined) {
    return {
      ok: false,
      reason: 'SEAT_ELIMINATED',
      message: `Zone "${zone.zoneId}" (seat ${ousted}): that seat has been eliminated.`,
    };
  }
  return { ok: true, keys: seats.seats.map((s) => zoneKey(zone.zoneId, s)) };
}

/** The single-zone case every effect except `shuffleZone` needs. */
function oneKey(
  zone: ZoneRef,
  state: PlayState,
  ctx: TriggerContext
): { ok: true; key: ZoneKey } | ResolutionFail {
  const r = keysOf(zone, state, ctx);
  if (!r.ok) return r;
  if (r.keys.length !== 1) {
    return {
      ok: false,
      reason: 'INVALID_SEAT',
      message: `Zone ref "${zone.zoneId}" resolved to ${r.keys.length} seats; expected exactly one.`,
    };
  }
  if (!state.zones[r.keys[0]]) {
    return {
      ok: false,
      reason: 'MISSING_REFERENT',
      message: `Zone "${r.keys[0]}" does not exist in this definition.`,
    };
  }
  return { ok: true, key: r.keys[0] };
}

/**
 * ponytail: linear scan of every zone. A `cardId -> ZoneKey` index would have to live inside
 * `PlayState` to survive rewind, i.e. a second source of truth to keep in sync. At playtest sizes
 * (tens of zones, hundreds of cards) the scan is free; add the index if a profile says otherwise.
 */
function zoneKeyOf(state: PlayState, cardId: Id): ZoneKey | null {
  for (const key of Object.keys(state.zones)) {
    if (state.zones[key].cardIds.includes(cardId)) return key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Attachment — §4.3. A reference, not a zone.
// ---------------------------------------------------------------------------

/** Mutates + logs one change line. Shared by `attach`, `detach` and the destroy choke point. */
function writeAttachment(ec: EffectContext, e: Effect, cardId: Id, to: Id | null, why: string): void {
  const before = ec.state.cards[cardId].attachedTo;
  if (before === to) return; // §5.1 — a no-op write logs no change
  ec.state.cards[cardId].attachedTo = to;
  emit(ec, e, 'info', `${cardId}: ${why}`, { path: `cards.${cardId}.attachedTo`, before, after: to }, 'change');
}

/**
 * Every card attached to `hostId` becomes unattached, one change line each.
 *
 * THE choke point. It is called from the one place a card leaves `state.cards` — the `delete` in
 * `destroyCards` — rather than from each effect that might plausibly orphan an attachment, for the
 * reason §5.4 gives for deriving modifiers instead of materializing them: the bug always lives in
 * the route someone forgot. Attachment is the one relation here that genuinely has to be
 * materialized (§9.1 SP4 wants `attachedTo === null` in state and a change line in the log, neither
 * of which a read-time fixup produces), so the discipline is instead that removal has exactly one
 * site and the detach lives inside it. Any future removal route must go through that same site.
 *
 * Deliberately does NOT cascade: the attached card is not destroyed, moved, or otherwise touched.
 * v1's standing refusal to cascade destruction implicitly (§4.3) — "destroy the creature, destroy
 * its equipment" is authorable as a second effect and must not be assumed.
 *
 * Also deliberately NOT called from `moveCards`: a host changing zones changes nothing at all,
 * which is the entire point of attachment being a reference (§9.1 SP3).
 */
function detachDependents(ec: EffectContext, e: Effect, hostId: Id): void {
  // Sorted for the same reason `targets.ts`'s `attachedTo` sorts — key order is not rewind-stable,
  // and these lines are part of the log a rewind replays.
  const attached = Object.keys(ec.state.cards)
    .filter((id) => ec.state.cards[id].attachedTo === hostId)
    .sort();
  for (const id of attached) {
    writeAttachment(ec, e, id, null, `detached from ${hostId} (host destroyed). Not destroyed with it.`);
  }
}

/** Index 0 is the TOP of `cardIds` (valueRef.ts and targets.ts share this). */
function insertIndex(position: InsertPosition, length: number): number {
  if (position === 'top') return 0;
  if (position === 'bottom') return length;
  return Math.max(0, Math.min(length, position.index));
}

// ---------------------------------------------------------------------------
// The two exported helpers other modules must route through
// ---------------------------------------------------------------------------

/**
 * The ONE clamp. Used by pool writes and by card Index writes — they share `GameValue` bounds and
 * §9.3 warns they silently become two code paths otherwise. Booleans ignore bounds entirely.
 */
export function clampValue(v: GameValue, raw: number | boolean): number | boolean {
  if (v.type === 'boolean' || typeof raw !== 'number') return raw;
  let n = raw;
  if (v.min !== null) n = Math.max(n, v.min);
  if (v.max !== null) n = Math.min(n, v.max);
  return n;
}

/**
 * The ONE place capacity legality is decided, for the whole batch at once (§5.3 atomicity, §9.4
 * item 5). Exported because §6.4 requires the drag UI to probe the engine rather than reimplement
 * the rule. Cards already in the destination consume no new slot, which is what makes §5.9 row 15
 * a no-op instead of a capacity error.
 */
export function canMove(
  state: PlayState,
  def: GameDefinition,
  cardIds: Id[],
  toZoneKey: ZoneKey
): EffectResult {
  const inst = state.zones[toZoneKey];
  if (!inst) {
    return { ok: false, reason: 'MISSING_REFERENT', detail: `Zone "${toZoneKey}" does not exist in this definition.` };
  }
  const zoneDef = def.zones.find((z) => z.id === inst.zoneId);
  if (!zoneDef) {
    return { ok: false, reason: 'MISSING_REFERENT', detail: `Zone "${inst.zoneId}" does not exist in this definition.` };
  }
  if (zoneDef.maxCapacity === null) return { ok: true };
  const incoming = cardIds.filter((id) => !inst.cardIds.includes(id)).length;
  const held = inst.cardIds.length;
  if (held + incoming > zoneDef.maxCapacity) {
    return {
      ok: false,
      reason: 'ZONE_FULL',
      detail:
        held >= zoneDef.maxCapacity
          ? `zone at capacity (${held}/${zoneDef.maxCapacity})`
          : `zone capacity ${zoneDef.maxCapacity} exceeded (${held} held + ${incoming} incoming)`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Shared move machinery
// ---------------------------------------------------------------------------

interface MovePlan {
  movers: Id[];
  from: (ZoneKey | null)[];
}

/** Cards already in the destination are dropped from the plan — §5.9 row 15, no move, no events. */
function planMove(state: PlayState, cardIds: readonly Id[], toKey: ZoneKey): MovePlan {
  const movers: Id[] = [];
  const from: (ZoneKey | null)[] = [];
  for (const id of cardIds) {
    const src = zoneKeyOf(state, id);
    if (src === toKey) continue;
    movers.push(id);
    from.push(src);
  }
  return { movers, from };
}

/**
 * Mutates. Batch-splices so the group keeps its order at the insertion point, then enqueues
 * `onZoneExit(from)` -> `onZoneEnter(to)` per card — the §5.1 compound order, with the card already
 * physically settled before any rule bound to those events runs.
 */
function performMove(ec: EffectContext, plan: MovePlan, toKey: ZoneKey, position: InsertPosition): void {
  const { state } = ec;
  for (let i = 0; i < plan.movers.length; i++) {
    const src = plan.from[i];
    if (src === null) continue;
    const list = state.zones[src].cardIds;
    list.splice(list.indexOf(plan.movers[i]), 1);
  }
  const dest = state.zones[toKey].cardIds;
  dest.splice(insertIndex(position, dest.length), 0, ...plan.movers);

  const toSeat = parseZoneKey(toKey).seat;
  for (let i = 0; i < plan.movers.length; i++) {
    const cardId = plan.movers[i];
    const src = plan.from[i];
    if (src !== null) {
      ec.fireEvent('onZoneExit', {
        triggeringCardId: cardId,
        zoneKey: src,
        triggeringSeat: parseZoneKey(src).seat,
        promptAnswers: ec.ctx.promptAnswers,
        sourceCardId: null,
      });
    }
    ec.fireEvent('onZoneEnter', {
      triggeringCardId: cardId,
      zoneKey: toKey,
      triggeringSeat: toSeat,
      promptAnswers: ec.ctx.promptAnswers,
        sourceCardId: null,
    });
  }
}

const plural = (n: number) => (n === 1 ? 'card' : 'cards');

/**
 * Capacity gate shared by `moveCards`, `drawCards` and `createCard`. Override bypasses capacity and
 * ONLY capacity (§5.9 rows 1b/5c) — every other rejection above still stands.
 */
function capacityGate(
  ec: EffectContext,
  e: Effect,
  ids: Id[],
  toKey: ZoneKey,
  verb: string
): EffectResult {
  const room = canMove(ec.state, ec.def, ids, toKey);
  if (room.ok) return { ok: true };
  if (room.reason !== 'ZONE_FULL' || !ec.override) {
    return reject(
      ec,
      e,
      room.reason,
      `${verb} ${ids.length} ${plural(ids.length)} → ${zoneLabel(ec.def, toKey)}: ${room.detail}. No cards moved.`
    );
  }
  const cap = ec.def.zones.find((z) => z.id === parseZoneKey(toKey).zoneId)?.maxCapacity;
  const now = ec.state.zones[toKey].cardIds.length + ids.length;
  emit(
    ec,
    e,
    'override',
    `${verb} ${ids.length} ${plural(ids.length)} → ${zoneLabel(ec.def, toKey)}: capacity ${cap} exceeded (now ${now}/${cap}).`
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Numeric writes — pools and card indexes, both clamped by clampValue
// ---------------------------------------------------------------------------

function applyOp(op: NumericOp, current: number, amount: number): number {
  if (op === 'add') return current + amount;
  if (op === 'subtract') return current - amount;
  return amount;
}

const describeOp = (op: NumericOp): string =>
  op === 'add' ? 'Add to' : op === 'subtract' ? 'Subtract from' : 'Set';

/** A `ValueRef` used as an operand must resolve to exactly one value (`all` is not an amount). */
function singleAmount(
  ec: EffectContext,
  e: Effect,
  ref: Parameters<typeof resolveValueRef>[0]
): { ok: true; value: number | boolean } | EffectResult {
  const res = resolveValueRef(ref, ec.state, ec.ctx, ec.def);
  if (!res.ok) return failed(ec, e, res);
  if (res.values.length !== 1) {
    return reject(ec, e, 'TYPE_MISMATCH', `Amount resolved to ${res.values.length} values; expected exactly one.`);
  }
  return { ok: true, value: res.values[0] };
}

/**
 * The clamped next value for one numeric write, or a type error. `set` clamps too — §9.3 is
 * explicit that a `set` past a bound is clamped, not rejected.
 */
function nextValue(
  def: GameValue,
  op: NumericOp,
  current: number | boolean,
  amount: number | boolean,
  label: string
): { ok: true; value: number | boolean } | { ok: false; message: string } {
  if (def.type === 'boolean') {
    if (op !== 'set' || typeof amount !== 'boolean') {
      return { ok: false, message: `${label} is a boolean: only "set" with a boolean amount applies (got "${op}").` };
    }
    return { ok: true, value: amount };
  }
  if (typeof amount !== 'number' || !Number.isInteger(amount)) {
    return { ok: false, message: `${label} is an integer: amount ${String(amount)} is not an integer.` };
  }
  if (typeof current !== 'number') {
    return { ok: false, message: `${label} holds a boolean but is declared an integer.` };
  }
  return { ok: true, value: clampValue(def, applyOp(op, current, amount)) };
}

/** "3 → 0 (requested -5, clamped at min 0)" — §5.9 rows 4 / 4b. */
function writeNote(v: GameValue, op: NumericOp, before: number | boolean, after: number | boolean, amount: number | boolean): string {
  const head = `${String(before)} → ${String(after)}`;
  if (v.type !== 'integer' || typeof before !== 'number') return head;
  const raw = applyOp(op, before, amount as number);
  if (raw === after) return head;
  const bound = raw < (after as number) ? `min ${v.min}` : `max ${v.max}`;
  // The sign comes from the actual delta, never from the operator: `subtract -5` adds 5, and a log
  // line that disagrees with the write is only discovered when someone rewinds (§9.3).
  const delta = raw - before;
  const req = op === 'set' ? `requested ${raw}` : `requested ${delta < 0 ? '-' : '+'}${Math.abs(delta)}`;
  return before === after ? `${head} (${req}, already at ${bound})` : `${head} (${req}, clamped at ${bound})`;
}

// ---------------------------------------------------------------------------
// applyEffect
// ---------------------------------------------------------------------------

/**
 * §5.4's memo is keyed on state identity, which is a fresh object per immer produce — but NOT per
 * effect: this draft is mutated in place by every effect in the transaction.
 *
 * Entry AND exit, because not every read between two effects goes through `applyEffect`:
 * `dispatch.ts:564` evaluates the next RuleSet's `condition` in this same draft, `stateMachine.ts`
 * scans transition `entryCriteria` at settle, and both reach `effectiveIndex` via `resolveValueRef`.
 * Invalidating on entry alone leaves those reads answering with the value from before the last
 * write — a `setCardIndex` that raised a creature's power to 7 would gate the following rule on 5.
 *
 * §5.7 — `replacement.ts` is spliced in here, ahead of `applyEffectInner`: it is what makes "before
 * `applyEffect` mutates anything" literally true, since `applyEffectInner` is where every mutation
 * in this file happens. A definition with no `replaces` rule matching `effect.kind` costs one no-op
 * scan and falls straight through to `applyEffectInner`, unchanged from before this step.
 */
export function applyEffect(effect: Effect, ec: EffectContext): EffectResult {
  invalidateEffective(ec.state);
  try {
    return applyWithReplacement(effect, ec, applyEffectInner);
  } finally {
    invalidateEffective(ec.state);
  }
}

function applyEffectInner(effect: Effect, ec: EffectContext): EffectResult {
  const { state, def, ctx } = ec;

  switch (effect.kind) {
    // -----------------------------------------------------------------------
    case 'moveCards': {
      const targets = resolveTargets(effect.target, state, ctx, def, candidateLog(ec, effect));
      if (!targets.ok) return failed(ec, effect, targets);
      if (targets.kind === 'prompt') {
        return reject(ec, effect, 'AWAITING_PROMPT', `Move: prompt "${targets.promptText}" has no answer bound.`);
      }
      const to = oneKey(effect.to, state, ctx);
      if (!to.ok) return failed(ec, effect, to);

      const plan = planMove(state, targets.cardIds, to.key);
      if (plan.movers.length === 0) {
        // §5.9 row 15
        emit(ec, effect, 'info', `Move ${targets.cardIds.join(', ')} → ${zoneLabel(def, to.key)}: already in that zone. No-op, no events fired.`);
        return { ok: true };
      }
      const room = capacityGate(ec, effect, plan.movers, to.key, 'Move');
      if (!room.ok) return room;

      performMove(ec, plan, to.key, effect.position);
      emit(ec, effect, 'info', `Move ${plan.movers.length} ${plural(plan.movers.length)} → ${zoneLabel(def, to.key)}.`);
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case 'drawCards': {
      const from = oneKey(effect.from, state, ctx);
      if (!from.ok) return failed(ec, effect, from);
      const to = oneKey(effect.to, state, ctx);
      if (!to.ok) return failed(ec, effect, to);
      // planMove drops every card whose source is the destination, so this draws nothing and fires
      // no onCardDrawn — but it used to log as a plain success. The editor's default drawCards has
      // from === to, so an untouched default effect looked like it ran. §5.9 row 15's spirit.
      if (from.key === to.key) {
        return reject(
          ec,
          effect,
          'NO_TARGETS',
          `Draw from ${zoneLabel(def, from.key)}: source and destination are the same zone. Nothing drawn.`
        );
      }

      const n = singleAmount(ec, effect, effect.count);
      if (!('value' in n)) return n;
      if (typeof n.value !== 'number') {
        return reject(ec, effect, 'TYPE_MISMATCH', 'Draw: count resolved to a boolean; expected an integer.');
      }
      const requested = Math.max(0, Math.trunc(n.value));
      // `count` is a ValueRef, so "draw X" with X sitting at 0 is ordinary play, not an error —
      // the degenerate partial of §5.3's shortfall rule. Matches `createCard` below.
      if (requested === 0) {
        emit(ec, effect, 'info', `Draw from ${zoneLabel(def, from.key)}: count 0. Nothing drawn.`);
        return { ok: true };
      }
      const available = state.zones[from.key].cardIds.slice(0, requested);
      if (available.length === 0) {
        return reject(ec, effect, 'NO_TARGETS', `Draw ${requested} from ${zoneLabel(def, from.key)}: zone is empty.`);
      }
      // Capacity is checked against what will actually move, AFTER the shortfall — a constraint,
      // so all-or-nothing (§9.4 item 5), while the shortfall itself stays a partial (§5.9 row 2b).
      const room = capacityGate(ec, effect, available, to.key, 'Draw');
      if (!room.ok) return room;

      const plan = planMove(state, available, to.key);
      performMove(ec, plan, to.key, 'top');
      for (const cardId of plan.movers) {
        // The one thing moveCards must never do — which is why drawCards exists separately (§4.7).
        ec.fireEvent('onCardDrawn', {
          triggeringCardId: cardId,
          zoneKey: to.key,
          triggeringSeat: parseZoneKey(to.key).seat,
          promptAnswers: ctx.promptAnswers,
          sourceCardId: null,
        });
      }
      const label = `Draw ${requested} from ${zoneLabel(def, from.key)} → ${zoneLabel(def, to.key)}`;
      if (available.length < requested) {
        emit(ec, effect, 'warn', `${label}: only ${available.length} available. Drew ${available.length}.`);
      } else {
        emit(ec, effect, 'info', `${label}.`);
      }
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case 'shuffleZone': {
      const keys = keysOf(effect.zone, state, ctx);
      if (!keys.ok) return failed(ec, effect, keys);
      for (const key of keys.keys) {
        if (!state.zones[key]) {
          return reject(ec, effect, 'MISSING_REFERENT', `Zone "${key}" does not exist in this definition.`);
        }
      }
      const seedHash = hashSeed(state.seed);
      for (const key of keys.keys) {
        // rngCursor is part of the rewound domain — thread it, never restart it, or a
        // rewind-then-shuffle produces a different deck (§9.3).
        const result = shuffle(state.zones[key].cardIds, seedHash, state.rngCursor);
        state.zones[key].cardIds = result.items;
        state.rngCursor = result.cursor;
        emit(ec, effect, 'info', `Shuffle ${zoneLabel(def, key)} (${result.items.length} ${plural(result.items.length)}).`);
      }
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case 'changePool': {
      // The shared lookup, not `def.pools.find` — it also resolves the reserved `activePlayer`
      // pool, which setup.ts seeds but no definition authors (§4.1). Authored effects are its only
      // legal writers, so a MISSING_REFERENT here would make turn structure unauthorable.
      const poolDef = resolvePoolDef(def, effect.poolId);
      if (!poolDef) {
        // §5.9 row 3b
        return reject(ec, effect, 'MISSING_REFERENT', `${describeOp(effect.op)} pool "${effect.poolId}": pool does not exist in this definition.`);
      }
      const amount = singleAmount(ec, effect, effect.amount);
      if (!('value' in amount)) return amount;

      let seatList: (number | null)[] = [null];
      if (effect.seat !== null) {
        const seats = resolveSeat(effect.seat, state, ctx);
        if (!seats.ok) return failed(ec, effect, seats);
        seatList = seats.seats;
      }

      // Plan every seat first — atomicity (§5.3). One bad seat rejects the whole effect.
      const writes: { seat: number | null; before: number | boolean; after: number | boolean }[] = [];
      for (const seat of seatList) {
        const before = seat === null ? state.pools[effect.poolId] : state.playerPools[effect.poolId]?.[seat];
        if (before === undefined) {
          return reject(ec, effect, 'MISSING_REFERENT', `Pool "${effect.poolId}"${seat === null ? '' : ` (seat ${seat})`} has no value in this session.`);
        }
        const next = nextValue(poolDef.value, effect.op, before, amount.value, `Pool "${poolDef.value.name}"`);
        if (!next.ok) return reject(ec, effect, 'TYPE_MISMATCH', next.message);
        writes.push({ seat, before, after: next.value });
      }

      for (const w of writes) {
        const label = `${poolDef.value.name}${w.seat === null ? '' : ` (seat ${w.seat})`}`;
        const note = writeNote(poolDef.value, effect.op, w.before, w.after, amount.value);
        if (w.before === w.after) {
          // §5.1 / §5.9 row 4b — no write, no onPoolChanged. The loop-guard rule.
          emit(ec, effect, 'info', `${label}: ${note}. No event fired.`);
          continue;
        }
        // AC: A4 — the LOGGED value is the clamped one. If the log said -2 the inverse patch would
        // restore -2 and the corruption would stay silent until someone rewound.
        const path = w.seat === null ? `pools.${effect.poolId}` : `playerPools.${effect.poolId}.${w.seat}`;
        if (w.seat === null) state.pools[effect.poolId] = w.after;
        else state.playerPools[effect.poolId][w.seat] = w.after;
        emit(ec, effect, 'info', `${label}: ${note}.`, { path, before: w.before, after: w.after }, 'change');
        ec.fireEvent('onPoolChanged', {
          triggeringCardId: null,
          zoneKey: null,
          triggeringSeat: w.seat,
          promptAnswers: ctx.promptAnswers,
          sourceCardId: null,
        });
      }
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case 'setCardIndex': {
      const targets = resolveTargets(effect.target, state, ctx, def, candidateLog(ec, effect));
      if (!targets.ok) return failed(ec, effect, targets);
      if (targets.kind === 'prompt') {
        return reject(ec, effect, 'AWAITING_PROMPT', `SetIndex: prompt "${targets.promptText}" has no answer bound.`);
      }
      const amount = singleAmount(ec, effect, effect.amount);
      if (!('value' in amount)) return amount;

      const writes: { id: Id; before: number | boolean; from: number | boolean; after: number | boolean; value: GameValue }[] = [];
      for (const id of targets.cardIds) {
        const card = state.cards[id];
        // §9.4 item 14 — a card destroyed by an earlier effect this RuleSet is skipped, never thrown on.
        if (!card) {
          return reject(ec, effect, 'TARGET_GONE', `SetIndex(${effect.indexId}) on ${id}: card no longer exists.`);
        }
        const template = def.templates.find((t) => t.id === card.templateId);
        const indexDef = template?.indexes.find((i) => i.id === effect.indexId);
        if (!indexDef) {
          return reject(ec, effect, 'MISSING_REFERENT', `SetIndex(${effect.indexId}) on ${id}: card "${card.templateId}" has no such index.`);
        }
        const before = card.indexValues[effect.indexId];
        if (before === undefined) {
          return reject(ec, effect, 'MISSING_REFERENT', `SetIndex(${effect.indexId}) on ${id}: index has no value on this instance.`);
        }
        // §5.4's read site: `add`/`subtract` operate on what the card currently READS AS, and the
        // result is written back as its new BASE. "This creature gets -1/-1 permanently" has to
        // subtract from the buffed value, or damage on a buffed creature behaves differently from
        // damage on an unbuffed one. `set` overwrites outright and reads nothing, so it stays on the
        // base and skips the modifier scan. With no modifiers active `from === before` and every
        // pre-v2 result is unchanged.
        const from = effect.op === 'set' ? before : effectiveIndex(state, def, id, effect.indexId);
        // Same clampValue as pools — that shared call is the whole point of §9.3's warning.
        const next = nextValue(indexDef.value, effect.op, from, amount.value, `Index "${indexDef.value.name}"`);
        if (!next.ok) return reject(ec, effect, 'TYPE_MISMATCH', next.message);
        writes.push({ id, before, from, after: next.value, value: indexDef.value });
      }

      for (const w of writes) {
        // `w.from`, not `w.before`: writeNote re-derives the raw arithmetic to spot a clamp, so it
        // has to be handed the number the arithmetic actually used. The CHANGE line below still
        // records the base either side, which is what a rewind replays.
        const note = writeNote(w.value, effect.op, w.from, w.after, amount.value);
        if (w.before === w.after) {
          emit(ec, effect, 'info', `${w.value.name} on ${w.id}: ${note}. No change.`);
          continue;
        }
        // AC: A4 again — same clampValue, same "log the clamped value" rule as pools.
        state.cards[w.id].indexValues[effect.indexId] = w.after;
        emit(ec, effect, 'info', `${w.value.name} on ${w.id}: ${note}.`, { path: `cards.${w.id}.indexValues.${effect.indexId}`, before: w.before, after: w.after }, 'change');
      }
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case 'flipCard':
    case 'rotateCard': {
      const targets = resolveTargets(effect.target, state, ctx, def, candidateLog(ec, effect));
      if (!targets.ok) return failed(ec, effect, targets);
      if (targets.kind === 'prompt') {
        return reject(ec, effect, 'AWAITING_PROMPT', `${effect.kind}: prompt "${targets.promptText}" has no answer bound.`);
      }
      const field = effect.kind === 'flipCard' ? 'faceDown' : 'rotated';

      for (const id of targets.cardIds) {
        if (!state.cards[id]) {
          return reject(ec, effect, 'TARGET_GONE', `${effect.kind} on ${id}: card no longer exists.`);
        }
      }
      for (const id of targets.cardIds) {
        const card = state.cards[id];
        const before = card[field];
        const after = effect.to === 'toggle' ? !before : effect.to === field;
        if (before === after) continue;
        card[field] = after;
        emit(ec, effect, 'info', `${id}: ${field} ${String(before)} → ${String(after)}.`, { path: `cards.${id}.${field}`, before, after }, 'change');
      }
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case 'createCard': {
      const template = def.templates.find((t) => t.id === effect.templateId);
      if (!template) {
        return reject(ec, effect, 'MISSING_REFERENT', `Create card: template "${effect.templateId}" does not exist in this definition.`);
      }
      const to = oneKey(effect.zone, state, ctx);
      if (!to.ok) return failed(ec, effect, to);
      const n = singleAmount(ec, effect, effect.count);
      if (!('value' in n)) return n;
      if (typeof n.value !== 'number') {
        return reject(ec, effect, 'TYPE_MISMATCH', 'Create card: count resolved to a boolean; expected an integer.');
      }
      const count = Math.max(0, Math.trunc(n.value));
      if (count === 0) {
        emit(ec, effect, 'info', `Create ${template.name}: count 0. Nothing created.`);
        return { ok: true };
      }
      // Capacity before minting — otherwise a rejected create still burns nextSeq and every
      // subsequent id shifts, which breaks same-seed determinism (§9.4 item 1).
      const room = capacityGate(ec, effect, Array.from({ length: count }, (_, i) => `pending${i}`), to.key, 'Create');
      if (!room.ok) return room;

      const ids: Id[] = [];
      for (let i = 0; i < count; i++) {
        const id = `c${state.nextSeq++}`; // deterministic, never a UUID (§4.4)
        const indexValues: Record<Id, number | boolean> = {};
        for (const index of template.indexes) indexValues[index.id] = index.value.defaultValue;
        // Same identity seeding as setup.ts's deal (§4.3): a created card's owner is the seat of
        // the zone it is created into, and null for a shared zone.
        state.cards[id] = {
          id,
          templateId: template.id,
          indexValues,
          faceDown: false,
          rotated: false,
          tags: [...template.tags],
          owner: parseZoneKey(to.key).seat,
          controller: null,
          attachedTo: null,
        };
        ids.push(id);
      }
      const dest = state.zones[to.key].cardIds;
      dest.splice(insertIndex(effect.position, dest.length), 0, ...ids);
      // Product ruling, not an oversight: a created card DOES enter its zone, so it fires
      // onZoneEnter. Enqueued after the splice, so the card is settled before any bound rule runs
      // (§5.1's compound-move ordering).
      for (const id of ids) {
        ec.fireEvent('onZoneEnter', {
          triggeringCardId: id,
          zoneKey: to.key,
          triggeringSeat: parseZoneKey(to.key).seat,
          promptAnswers: ctx.promptAnswers,
          sourceCardId: null,
        });
      }
      emit(ec, effect, 'info', `Create ${count} ${template.name} → ${zoneLabel(def, to.key)} (${ids.join(', ')}).`);
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case 'destroyCards': {
      const targets = resolveTargets(effect.target, state, ctx, def, candidateLog(ec, effect));
      if (!targets.ok) return failed(ec, effect, targets);
      if (targets.kind === 'prompt') {
        return reject(ec, effect, 'AWAITING_PROMPT', `Destroy: prompt "${targets.promptText}" has no answer bound.`);
      }
      for (const id of targets.cardIds) {
        if (!state.cards[id]) {
          return reject(ec, effect, 'TARGET_GONE', `Destroy ${id}: card no longer exists.`);
        }
      }
      for (const id of targets.cardIds) {
        const key = zoneKeyOf(state, id);
        if (key !== null) {
          const list = state.zones[key].cardIds;
          list.splice(list.indexOf(id), 1);
        }
        // Before the delete, so the detach lines read against a board where the host still exists.
        // §4.3: detaches, logs each detachment as its own change line, does NOT cascade.
        detachDependents(ec, effect, id);
        delete state.cards[id];
        // Product ruling: a destroyed card DOES leave its zone. Because events go to the tail the
        // card is already gone when this drains, so its OWN rule is skipped (§5.9 row 16) while
        // global onZoneExit rules still read zoneKey/triggeringSeat. Intended — do not resurrect.
        if (key !== null) {
          ec.fireEvent('onZoneExit', {
            triggeringCardId: id,
            zoneKey: key,
            triggeringSeat: parseZoneKey(key).seat,
            promptAnswers: ctx.promptAnswers,
          sourceCardId: null,
          });
        }
      }
      emit(ec, effect, 'info', `Destroy ${targets.cardIds.length} ${plural(targets.cardIds.length)} (${targets.cardIds.join(', ')}).`);
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case 'fireEvent': {
      // §5.7 binds `triggeringCard` under exactly the four CARD_BINDING_EVENTS, and a custom event
      // is not one of them — forwarding `ctx` unchanged would let a rule on it resolve
      // `triggeringCard`. Seat and prompt answers are separate and meaningful, so they carry over.
      // Same rule stateMachine.ts applies to onStateEnter/onStateExit.
      ec.fireEvent(effect.name, {
        triggeringCardId: null,
        zoneKey: null,
        triggeringSeat: ctx.triggeringSeat,
        promptAnswers: ctx.promptAnswers,
          sourceCardId: null,
      });
      emit(ec, effect, 'info', `Event "${effect.name}" fired.`, null, 'event');
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case 'forceTransition':
      // §5.6: this "applies at its position in the effect list", so the RuleSet's REMAINING effects
      // run in the NEW state. Enqueuing a work item instead would run them in the old one.
      // applyTransition owns legality, the End handling and its own logging, and enqueues
      // onStateExit/onStateEnter to the tail — exactly what §5.6 describes.
      return applyTransition(ec, effect.toStateId, { forced: true });

    // -----------------------------------------------------------------------
    case 'eliminateSeat': {
      const seats = resolveSeat(effect.seat, state, ctx);
      if (!seats.ok) return failed(ec, effect, seats);
      // Plan before mutating (§5.3 atomicity). An `all` ref that includes one already-ousted seat
      // rejects the whole effect rather than eliminating the rest and leaving a half-closed ring.
      for (const s of seats.seats) {
        if (!state.seatOrder.includes(s)) {
          return reject(ec, effect, 'SEAT_ELIMINATED', `Eliminate seat ${s}: that seat is already eliminated.`);
        }
      }
      for (const s of seats.seats) {
        const before = [...state.seatOrder];
        state.seatOrder.splice(state.seatOrder.indexOf(s), 1);
        state.eliminated.push(s);
        // §5.12, and every clause of it is a deliberate omission: pools, zone instances and cards
        // are NOT deleted (storage stays dense and full-length — §3.5), cards owned by the seat are
        // not cascaded, and `finished` is untouched. Elimination is not session end; ending the
        // session is still the End state's job. One change line per seat.
        emit(
          ec,
          effect,
          'info',
          `Seat ${s} eliminated. ${state.seatOrder.length} ${state.seatOrder.length === 1 ? 'seat' : 'seats'} remain.`,
          { path: 'seatOrder', before, after: [...state.seatOrder] },
          'change'
        );
      }
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case 'setTag': {
      const targets = resolveTargets(effect.target, state, ctx, def, candidateLog(ec, effect));
      if (!targets.ok) return failed(ec, effect, targets);
      if (targets.kind === 'prompt') {
        return reject(ec, effect, 'AWAITING_PROMPT', `SetTag: prompt "${targets.promptText}" has no answer bound.`);
      }
      // Plan then mutate (§5.3): one dead target rejects the batch rather than half-tagging it.
      for (const id of targets.cardIds) {
        if (!state.cards[id]) {
          return reject(ec, effect, 'TARGET_GONE', `SetTag("${effect.tag}") on ${id}: card no longer exists.`);
        }
      }
      for (const id of targets.cardIds) {
        const tags = state.cards[id].tags;
        const at = tags.indexOf(effect.tag);
        // §5.1 — tagging an already-tagged card writes nothing and logs no change. Tags are a SET,
        // so a second `on:true` must not append a duplicate that one `on:false` then fails to clear.
        if ((at >= 0) === effect.on) continue;
        const before = [...tags];
        if (effect.on) tags.push(effect.tag);
        else tags.splice(at, 1);
        emit(
          ec,
          effect,
          'info',
          `${id}: tag "${effect.tag}" ${effect.on ? 'added' : 'removed'}.`,
          { path: `cards.${id}.tags`, before, after: [...tags] },
          'change'
        );
      }
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case 'attach':
    case 'detach': {
      const targets = resolveTargets(effect.target, state, ctx, def, candidateLog(ec, effect));
      if (!targets.ok) return failed(ec, effect, targets);
      if (targets.kind === 'prompt') {
        return reject(ec, effect, 'AWAITING_PROMPT', `${effect.kind}: prompt "${targets.promptText}" has no answer bound.`);
      }

      let hostId: Id | null = null;
      if (effect.kind === 'attach') {
        const host = resolveCardRef(effect.host, state, ctx);
        if (!host.ok) return failed(ec, effect, host);
        hostId = host.card.id;
      }

      // Plan then mutate (§5.3): one dead or illegal target rejects the batch rather than
      // attaching half of it.
      for (const id of targets.cardIds) {
        if (!state.cards[id]) {
          return reject(ec, effect, 'TARGET_GONE', `${effect.kind} ${id}: card no longer exists.`);
        }
        // A card hosting itself is not a loop — `hostOf` is one hop, never transitive — but it is
        // nonsense, and the cheapest place to refuse it is before it is written.
        if (id === hostId) {
          return reject(ec, effect, 'TYPE_MISMATCH', `Attach ${id}: a card cannot be attached to itself.`);
        }
      }
      for (const id of targets.cardIds) {
        writeAttachment(
          ec,
          effect,
          id,
          hostId,
          hostId === null ? 'detached.' : `attached to ${hostId}.`
        );
      }
      // Nothing moves. §4.3: attachment is a reference, so the card stays exactly where it is and
      // no onZoneEnter/onZoneExit fires. A game that wants the equipment to follow its host into
      // play authors a `moveCards` next to this one.
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    case 'setController': {
      const targets = resolveTargets(effect.target, state, ctx, def, candidateLog(ec, effect));
      if (!targets.ok) return failed(ec, effect, targets);
      if (targets.kind === 'prompt') {
        return reject(ec, effect, 'AWAITING_PROMPT', `SetController: prompt "${targets.promptText}" has no answer bound.`);
      }
      // null is not "no seat resolved" — it is the authored instruction to CLEAR the override, so
      // control goes back to being derived from the holding zone (§4.3).
      let seat: number | null = null;
      if (effect.seat !== null) {
        const seats = resolveSeat(effect.seat, state, ctx);
        if (!seats.ok) return failed(ec, effect, seats);
        if (seats.seats.length !== 1) {
          return reject(
            ec,
            effect,
            'INVALID_SEAT',
            `SetController: seat ref resolved to ${seats.seats.length} seats; expected exactly one.`
          );
        }
        seat = seats.seats[0];
      }

      // Plan then mutate (§5.3): one dead target rejects the batch rather than half-reassigning it.
      for (const id of targets.cardIds) {
        if (!state.cards[id]) {
          return reject(ec, effect, 'TARGET_GONE', `SetController on ${id}: card no longer exists.`);
        }
      }
      for (const id of targets.cardIds) {
        const before = state.cards[id].controller;
        if (before === seat) continue; // §5.1 — a no-op write logs no change
        state.cards[id].controller = seat;
        // Deliberately does NOT move the card: §5.12's sibling ruling for §4.3. A contested unique
        // changes hands where it stands, and which zone instance holds it is untouched.
        emit(
          ec,
          effect,
          'info',
          `${id}: controller ${before === null ? 'zone-derived' : `seat ${before}`} → ${seat === null ? 'zone-derived' : `seat ${seat}`}.`,
          { path: `cards.${id}.controller`, before, after: seat },
          'change'
        );
      }
      return { ok: true };
    }

    // -----------------------------------------------------------------------
    // v2 §4.5 — STUB. The type exists (step 21/31 has to make every §4 union compile), but the
    // behaviour belongs to the step named per kind below. Grouped into one arm because all six
    // reject identically: nothing here can run, so nothing here should pretend to.
    case 'announceAction':
    case 'counterAction': {
      const step = effect.kind === 'announceAction' ? 22 : 23;
      return reject(ec, effect, 'NOT_ACTIVATABLE', `${effect.kind}: not yet implemented — v2 step ${step}.`);
    }
    case 'openPriority':
      return reject(ec, effect, 'NOT_ACTIVATABLE', `${effect.kind}: not yet implemented — v2 step 24.`);
    case 'chooseMode':
    case 'chooseNumber':
      return reject(ec, effect, 'NOT_ACTIVATABLE', `${effect.kind}: not yet implemented — v2 step 28.`);
    case 'sealedChoice':
      return reject(ec, effect, 'NOT_ACTIVATABLE', `${effect.kind}: not yet implemented — v2 step 29.`);
  }
}
