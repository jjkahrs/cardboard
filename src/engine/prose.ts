/**
 * Effect[] -> English. TECHNICAL_DESIGN.md §6.3, §6.8.
 *
 * Shared verbatim by the card's Rules layer (`rulesTextOverride ?? generateRulesProse(...)`) and the
 * rule editor's live preview, so the card and the editor can never disagree — that's the whole point.
 *
 * Pure and total: every id is resolved against `GameDefinition` only (no PlayState — this runs in the
 * editor with no session running), and a missing referent renders as a `[deleted x]` placeholder
 * instead of throwing, because the rule editor shows that placeholder to the designer as a red chip.
 */

import type {
  ActionRef,
  ActionSelector,
  CardRef,
  CriteriaNode,
  Effect,
  GameDefinition,
  InsertPosition,
  RuleSet,
  SeatRef,
  TargetSelector,
  ValueRef,
  ZoneRef,
} from './types';
import { resolvePoolDef } from './valueRef';

// ---------------------------------------------------------------------------
// Name resolution — the one place ids surface as names (§6.8)
// ---------------------------------------------------------------------------

function poolName(def: GameDefinition, poolId: string): string {
  // resolvePoolDef, not `def.pools.find` — the reserved `activePlayer` pool is a legitimate
  // reference with no entry in `def.pools`, and would otherwise read as "[deleted pool]".
  return resolvePoolDef(def, poolId)?.value.name ?? '[deleted pool]';
}

function zoneName(def: GameDefinition, zoneId: string): string {
  return def.zones.find((z) => z.id === zoneId)?.name ?? '[deleted zone]';
}

function templateName(def: GameDefinition, templateId: string): string {
  return def.templates.find((t) => t.id === templateId)?.name ?? '[deleted card]';
}

/** A CardIndex id is scoped to its template; find whichever template declares it. */
function indexName(def: GameDefinition, indexId: string): string {
  for (const t of def.templates) {
    const idx = t.indexes.find((i) => i.id === indexId);
    if (idx) return idx.value.name;
  }
  return '[deleted index]';
}

function stateName(def: GameDefinition, stateId: string): string {
  return def.machine.states.find((s) => s.id === stateId)?.name ?? '[deleted state]';
}

/** v2 §4.5 — `announceAction.ruleId` is the first reference from a rule to another rule (§6.10). */
function ruleName(def: GameDefinition, ruleId: string): string {
  return def.ruleSets.find((r) => r.id === ruleId)?.name ?? '[deleted rule]';
}

/** v2 §4.6 — a top-level `PriorityWindow`, addressed by `openPriority`, `announceAction.window` and `activation.window`. */
function windowName(def: GameDefinition, windowId: string): string {
  return def.priorityWindows.find((w) => w.id === windowId)?.name ?? '[deleted window]';
}

// ---------------------------------------------------------------------------
// Seats — §4.2. `their`/`its` reads naturally as a possessive with no assumed gender.
// ---------------------------------------------------------------------------

/**
 * Noun phrase used as a sentence subject/object: "the next player".
 *
 * Takes `def` because §4.1's `owner`/`controller` hold a `CardRef` that has to be named — which is
 * also why this and `describeCardRef` are mutually recursive (a card can be "the top card of their
 * Hand", and that Hand is seated).
 */
function seatNoun(def: GameDefinition, seat: SeatRef): string {
  switch (seat.kind) {
    case 'active':
      return 'the active player';
    case 'next':
      return 'the next player';
    case 'previous':
      return 'the previous player';
    case 'triggeringSeat':
      return 'the player who played this';
    case 'seat':
      return `player ${seat.index + 1}`;
    // Counted round the live ring, so "2 seats after" is the phrasing that survives an elimination.
    case 'relative': {
      const n = Math.abs(seat.offset);
      const seats = `${n} ${n === 1 ? 'seat' : 'seats'}`;
      const dir = seat.offset >= 0 ? 'after' : 'before';
      return `the player ${seats} ${dir} ${seatNoun(def, seat.from)}`;
    }
    // §4.1 — `sum` totals across the live ring rather than quantifying over it, so it needs a
    // phrasing that reads as one number: "HP of all players combined", never "of each player".
    case 'all':
      if (seat.quantifier === 'some') return 'any player';
      if (seat.quantifier === 'sum') return 'all players combined';
      return 'each player';
    case 'owner':
      return `the owner of ${describeCardRef(def, seat.card)}`;
    case 'controller':
      return `the controller of ${describeCardRef(def, seat.card)}`;
  }
}

/** Possessive form used right before a noun: "their Hand", "the next player's Hand". */
function seatPossessive(def: GameDefinition, seat: SeatRef): string {
  return seat.kind === 'triggeringSeat' ? 'their' : `${seatNoun(def, seat)}'s`;
}

function zonePhrase(def: GameDefinition, zone: ZoneRef): string {
  const name = zoneName(def, zone.zoneId);
  return zone.seat === null ? name : `${seatPossessive(def, zone.seat)} ${name}`;
}

/** Argument order mirrors `describeValueRef` — the rule editor's zone chip reads its label here. */
export function describeZoneRef(zone: ZoneRef, def: GameDefinition): string {
  return zonePhrase(def, zone);
}

// ---------------------------------------------------------------------------
// Values and card refs — §4.2
// ---------------------------------------------------------------------------

function describeCardRef(def: GameDefinition, ref: CardRef): string {
  switch (ref.kind) {
    case 'triggering':
      return 'this card';
    case 'zoneTop':
      return `the top card of ${zonePhrase(def, ref.zone)}`;
    case 'promptAnswer':
      return 'the chosen card';
    case 'instance':
      return `card ${ref.id}`;
    case 'host':
      return 'the card this is attached to';
    case 'candidate':
      return 'the card';
    // v2 §4.2, §5.7 — bound only inside a replacement rule's `replaces.match`.
    case 'replacedTarget':
      return 'the replaced target';
  }
}

/** v2 §4.2 — addresses a pending action (§4.8) the way `describeCardRef` addresses a card. */
function describeActionRef(ref: ActionRef): string {
  switch (ref.kind) {
    case 'triggeringAction':
      return 'the action this is responding to';
    case 'topOfStack':
      return 'the top action on the stack';
    case 'action':
      return `action ${ref.id}`;
  }
}

/** v2 §4.4 — used by `counterAction`'s prose. */
function describeActionSelector(def: GameDefinition, selector: ActionSelector): string {
  switch (selector.kind) {
    case 'action':
      return describeActionRef(selector.ref);
    case 'allOnStack':
      return selector.where === null
        ? 'every action on the stack'
        : `every action on the stack where ${describeCriteria(selector.where, def)}`;
  }
}

export function describeCriteria(node: CriteriaNode, def: GameDefinition): string {
  if (node.kind === 'group') {
    const joined = node.children.map((c) => describeCriteria(c, def)).join(` ${node.combinator} `);
    return node.children.length > 1 ? `(${joined})` : joined;
  }
  const opPhrase: Record<typeof node.op, string> = {
    '=': 'is',
    '!=': 'is not',
    '>': 'is above',
    '<': 'is below',
    '>=': 'is at least',
    '<=': 'is at most',
  };
  return `${describeValueRef(node.left, def)} ${opPhrase[node.op]} ${describeValueRef(node.right, def)}`;
}

/** Exported so the ValueRef chip in the rule editor and the card's Rules layer read identically. */
export function describeValueRef(ref: ValueRef, def: GameDefinition): string {
  switch (ref.kind) {
    case 'literal':
      return typeof ref.value === 'boolean' ? (ref.value ? 'true' : 'false') : String(ref.value);
    case 'pool':
      return ref.seat === null
        ? poolName(def, ref.poolId)
        : `${poolName(def, ref.poolId)} of ${seatNoun(def, ref.seat)}`;
    case 'cardIndex':
      return `${indexName(def, ref.indexId)} of ${describeCardRef(def, ref.card)}`;
    case 'zoneCount':
      return `the number of cards in ${zonePhrase(def, ref.zone)}`;
    case 'activeSeatCount':
      return 'the number of players still in the game';
    case 'cardTag':
      return `whether ${describeCardRef(def, ref.card)} is tagged "${ref.tag}"`;
    // v2 §4.2, §5.7 — bound only inside a replacement rule's `replaces.match`.
    case 'replacedAmount':
      return 'the replaced amount';
    // v2 §4.2 — reads a characteristic off a pending action rather than off a card.
    case 'actionField':
      return `the ${ref.field} of ${describeActionRef(ref.action)}`;
  }
}

/** "2 cards" / "1 card" — plural only when the count is a literal !== 1; dynamic counts stay plural. */
function describeCount(ref: ValueRef, def: GameDefinition): string {
  const singular = ref.kind === 'literal' && ref.value === 1;
  return `${describeValueRef(ref, def)} ${singular ? 'card' : 'cards'}`;
}

function positionPhrase(position: InsertPosition): string {
  if (position === 'top') return 'the top';
  if (position === 'bottom') return 'the bottom';
  return `position ${position.index}`;
}

// ---------------------------------------------------------------------------
// Targets — §4.4, nine kinds
// ---------------------------------------------------------------------------

/** Exported for the rule editor's target chip, so its label and the card's text are one string. */
export function describeTargetSelector(selector: TargetSelector, def: GameDefinition): string {
  return describeTarget(selector, def);
}

function describeTarget(selector: TargetSelector, def: GameDefinition): string {
  switch (selector.kind) {
    case 'triggeringCard':
      return 'this card';
    case 'topOfZone':
      return `${describeCount(selector.count, def)} from the top of ${zonePhrase(def, selector.zone)}`;
    case 'bottomOfZone':
      return `${describeCount(selector.count, def)} from the bottom of ${zonePhrase(def, selector.zone)}`;
    case 'allInZone':
      return `all cards in ${zonePhrase(def, selector.zone)}`;
    case 'taggedInZone':
      return `all cards tagged "${selector.tag}" in ${zonePhrase(def, selector.zone)}`;
    case 'prompt':
      return `${describeCount(selector.count, def)} chosen by the player from ${describeTarget(selector.from, def)}`;
    case 'attachedTo':
      return `everything attached to ${describeCardRef(def, selector.host)}`;
    case 'hostOf':
      return `the card ${describeCardRef(def, selector.card)} is attached to`;
    // §4.4 — `where` is described with `candidate` reading as "the card", so the clause comes out
    // as "…where Power of the card is above 2". Unambiguous inside the `where`, where "the card" can
    // only be the one under test.
    case 'matching':
      return `${describeTarget(selector.from, def)} where ${describeCriteria(selector.where, def)}`;
  }
}

// ---------------------------------------------------------------------------
// Effects — §4.5, fifteen kinds
// ---------------------------------------------------------------------------

export function describeEffect(effect: Effect, def: GameDefinition): string {
  switch (effect.kind) {
    case 'moveCards':
      return `move ${describeTarget(effect.target, def)} to ${positionPhrase(effect.position)} of ${zonePhrase(def, effect.to)}`;
    case 'drawCards':
      return `draw ${describeCount(effect.count, def)} from ${zonePhrase(def, effect.from)} to ${zonePhrase(def, effect.to)}`;
    case 'shuffleZone':
      return `shuffle ${zonePhrase(def, effect.zone)}`;
    case 'changePool': {
      const pool = effect.seat === null ? poolName(def, effect.poolId) : `${poolName(def, effect.poolId)} of ${seatNoun(def, effect.seat)}`;
      const amount = describeValueRef(effect.amount, def);
      if (effect.op === 'add') return `add ${amount} to ${pool}`;
      if (effect.op === 'subtract') return `subtract ${amount} from ${pool}`;
      return `set ${pool} to ${amount}`;
    }
    case 'setCardIndex': {
      const target = `${indexName(def, effect.indexId)} of ${describeTarget(effect.target, def)}`;
      const amount = describeValueRef(effect.amount, def);
      if (effect.op === 'add') return `add ${amount} to ${target}`;
      if (effect.op === 'subtract') return `subtract ${amount} from ${target}`;
      return `set ${target} to ${amount}`;
    }
    case 'flipCard': {
      const dir = effect.to === 'toggle' ? 'over' : effect.to === 'faceUp' ? 'face up' : 'face down';
      return `flip ${describeTarget(effect.target, def)} ${dir}`;
    }
    case 'rotateCard': {
      const dir = effect.to === 'toggle' ? '' : effect.to === 'rotated' ? ' sideways' : ' upright';
      return `rotate ${describeTarget(effect.target, def)}${dir}`;
    }
    case 'createCard':
      return `create ${describeCount(effect.count, def)} of ${templateName(def, effect.templateId)} in ${positionPhrase(effect.position)} of ${zonePhrase(def, effect.zone)}`;
    case 'destroyCards':
      return `destroy ${describeTarget(effect.target, def)}`;
    case 'fireEvent':
      return `fire the "${effect.name}" event`;
    case 'forceTransition':
      return `transition to ${stateName(def, effect.toStateId)}`;
    case 'eliminateSeat':
      return `eliminate ${seatNoun(def, effect.seat)}`;
    case 'attach':
      return `attach ${describeTarget(effect.target, def)} to ${describeCardRef(def, effect.host)}`;
    case 'detach':
      return `detach ${describeTarget(effect.target, def)}`;
    case 'setTag':
      return effect.on
        ? `tag ${describeTarget(effect.target, def)} "${effect.tag}"`
        : `remove the "${effect.tag}" tag from ${describeTarget(effect.target, def)}`;
    case 'setController':
      return effect.seat === null
        ? `give up control of ${describeTarget(effect.target, def)}`
        : `give control of ${describeTarget(effect.target, def)} to ${seatNoun(def, effect.seat)}`;
    case 'announceAction':
      return effect.window === null
        ? `announce ${ruleName(def, effect.ruleId)}`
        : `announce ${ruleName(def, effect.ruleId)} and open ${windowName(def, effect.window)}`;
    case 'counterAction':
      return `counter ${describeActionSelector(def, effect.action)}`;
    case 'openPriority':
      return `open ${windowName(def, effect.window)}`;
    case 'sealedChoice':
      return `have ${seatNoun(def, effect.seats)} simultaneously choose one of: ${effect.options.map((o) => o.label).join(', ')}`;
    case 'chooseMode':
      return `have ${seatNoun(def, effect.seat)} choose one of: ${effect.modes.map((m) => m.label).join(', ')}`;
    case 'chooseNumber':
      return `have ${seatNoun(def, effect.seat)} choose a number from ${describeValueRef(effect.min, def)} to ${describeValueRef(effect.max, def)}`;
  }
}

// ---------------------------------------------------------------------------
// Trigger clause and the top-level sentence — §6.8
// ---------------------------------------------------------------------------

const TRIGGER_PHRASE: Record<string, string> = {
  onGameStart: 'the game starts',
  onGameEnd: 'the game ends',
  onCardPlayed: 'this card is played',
  onCardDrawn: 'this card is drawn',
  onZoneEnter: 'this enters a zone',
  onZoneExit: 'this leaves a zone',
  onPoolChanged: 'a pool changes',
};

function triggerPhrase(rule: RuleSet, def: GameDefinition): string {
  if (rule.trigger === 'onStateEnter' || rule.trigger === 'onStateExit') {
    const verb = rule.trigger === 'onStateEnter' ? 'entering' : 'exiting';
    const state = rule.stateFilter ? stateName(def, rule.stateFilter) : 'a state';
    return `${verb} ${state}`;
  }
  return TRIGGER_PHRASE[rule.trigger] ?? `"${rule.trigger}" fires`;
}

// ---------------------------------------------------------------------------
// v2 §4.5, §6.10 — the four new RuleSet panels. `continuous` / `modifier` / `replaces` /
// `activation` are mutually exclusive (a zod refinement enforces it — schema.ts), so `describeRuleSet`
// below picks at most one of these before falling back to the ordinary trigger sentence.
// ---------------------------------------------------------------------------

/** §5.6 — `trigger` is ignored; the condition is what the rule is "whenever" of. */
function describeContinuousRule(rule: RuleSet, def: GameDefinition): string {
  const condition = rule.condition ? describeCriteria(rule.condition, def) : 'true';
  const effects = rule.effects.map((e) => describeEffect(e, def)).join('; ');
  return `Whenever ${condition} becomes true: ${effects}.`;
}

/** §5.4 — a continuously-applying value modifier; never fires an effect, so `rule.effects` is unread. */
function describeModifierRule(rule: RuleSet, def: GameDefinition): string {
  const mod = rule.modifier;
  if (mod === null) return ''; // unreachable — guarded by the caller
  const index = indexName(def, mod.indexId);
  const amount = describeValueRef(mod.amount, def);
  const verb = mod.op === 'set' ? `is set to ${amount}` : `is adjusted by ${amount}`;
  const zones =
    mod.activeZones.length === 0
      ? ''
      : ` while its source is in ${mod.activeZones.map((id) => zoneName(def, id)).join(' or ')}`;
  return `${describeTarget(mod.scope, def)}: ${index} ${verb}${zones}.`;
}

/** §5.7 — intercepts an effect before it applies; `rule.effects` runs IN PLACE of the original. */
function describeReplacementRule(rule: RuleSet, def: GameDefinition): string {
  const r = rule.replaces;
  if (r === null) return ''; // unreachable — guarded by the caller
  const match = r.match ? `, where ${describeCriteria(r.match, def)}` : '';
  const effects = rule.effects.map((e) => describeEffect(e, def)).join('; ');
  return `If a "${r.effectKind}" effect would apply${match}, instead: ${effects}.`;
}

/** §5.8 — cost-gated activation; `rule.effects` is what the activation DOES once its cost is paid. */
function describeActivationRule(rule: RuleSet, def: GameDefinition): string {
  const a = rule.activation;
  if (a === null) return ''; // unreachable — guarded by the caller
  const cost = a.cost.length === 0 ? 'no cost' : a.cost.map((e) => describeEffect(e, def)).join('; ');
  const check = a.costCheck ? `, if ${describeCriteria(a.costCheck, def)}` : '';
  const window = a.window === null ? 'outside a priority window' : windowName(def, a.window);
  const effects = rule.effects.map((e) => describeEffect(e, def)).join('; ');
  return `Activate "${a.label}" (cost: ${cost}${check}; ${window}): ${effects}.`;
}

function describeRuleSet(rule: RuleSet, def: GameDefinition): string {
  if (rule.continuous) return describeContinuousRule(rule, def);
  if (rule.modifier !== null) return describeModifierRule(rule, def);
  if (rule.replaces !== null) return describeReplacementRule(rule, def);
  if (rule.activation !== null) return describeActivationRule(rule, def);
  const when = `When ${triggerPhrase(rule, def)}`;
  const condition = rule.condition ? `, if ${describeCriteria(rule.condition, def)}` : '';
  const effects = rule.effects.map((e) => describeEffect(e, def)).join('; ');
  return `${when}${condition}: ${effects}.`;
}

export function generateRulesProse(ruleSets: RuleSet[], def: GameDefinition): string {
  return ruleSets.map((rs) => describeRuleSet(rs, def)).join(' ');
}
