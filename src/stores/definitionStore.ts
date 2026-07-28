/**
 * The `GameDefinition` being authored, plus its CRUD. TECHNICAL_DESIGN.md §3.1, §7.2, §7.3, step 13.
 *
 * Three rules shape everything below:
 *
 * 1. **Validation is `schema.ts`'s, never a second copy.** Every action builds a *candidate*
 *    definition and runs `validateDefinition` on it; the store only moves if the candidate is clean.
 *    So "zone names must be unique" is enforced by exactly the code the importer runs (§7.2 gate 4),
 *    and a rejected edit leaves the state object referentially identical — structurally, not
 *    carefully (A2, P3).
 * 2. **References are by `Id`; names are display-only.** Renaming can therefore never dangle.
 *    Deleting can, so it is blocked with a referrer list (§9.4 item 2, §5.9 row 3b) — via the one
 *    `findReferrers` walk below, which every delete shares.
 * 3. **Nothing here reads a clock or a random number.** `src/stores/**` is lint-banned from
 *    `Date.now`/`Math.random`/`crypto` (§3.2), so the clock and the id source are constructor
 *    arguments with defaults. Tests pass deterministic ones.
 *
 * `produce` rather than zustand's `immer` middleware: the middleware commits what the recipe
 * mutated, and we need the candidate *before* deciding whether to commit at all. One `edit()` helper
 * does build → validate → `set`, and every action is a one-liner over it.
 */

import { produce, type Draft } from 'immer';
import { create } from 'zustand';
import { importJson, validateDefinition } from '../engine/schema';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_EFFECTS,
  DEFAULT_MAX_PRIORITY_ROUNDS,
  DEFAULT_MAX_SETTLE_ITERATIONS,
  END_STATE_ID,
  SCHEMA_VERSION,
  START_STATE_ID,
} from '../engine/types';
import type {
  ActionRef,
  ActionSelector,
  CardIndex,
  CardRef,
  CardTemplate,
  CriteriaNode,
  Deck,
  Effect,
  GameDefinition,
  Id,
  MachineState,
  PlayZone,
  PointPool,
  PriorityWindow,
  RuleSet,
  SeatRef,
  TargetSelector,
  ValueRef,
  ZoneRef,
} from '../engine/types';

// ---------------------------------------------------------------------------
// Results — a rejection is an expected outcome, so it is a value, never a throw.
// ---------------------------------------------------------------------------

export type EditResult =
  /** `id` is present on the `add*` actions so the UI can navigate to what it just created. */
  | { ok: true; id?: Id }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// findReferrers — ONE walk over every reference site in the definition (§9.4 item 2)
// ---------------------------------------------------------------------------

/** The kinds of thing that can be referenced by id. Matches `schema.ts`'s `Refs`. */
export type RefKind = 'pool' | 'zone' | 'template' | 'cardIndex' | 'ruleSet' | 'state' | 'priorityWindow';

/** The entity holding a reference, plus where inside it the reference sits. */
export interface Referrer {
  ownerKind: 'ruleSet' | 'template' | 'deck' | 'state' | 'definition';
  ownerId: Id;
  ownerName: string;
  /** JSON path of the reference site, e.g. `ruleSets.0.effects.0.poolId` */
  path: string;
}

type Owner = Omit<Referrer, 'path'>;
type Visit = (kind: RefKind, id: Id, path: string, owner: Owner) => void;

/** Threaded through the recursive walkers so each visit knows who holds it. */
interface Walk {
  visit: Visit;
  owner: Owner;
}

const hit = (w: Walk, kind: RefKind, id: Id, path: string): void =>
  w.visit(kind, id, path, w.owner);

/**
 * Structural trap 1 (§8). Every `walk*` switch below has **no `default:` arm** and every case
 * `return`s, so TypeScript narrows the discriminant to `never` here — and the next §4 kind added to
 * any of these unions is a compile error at this line rather than a reference that silently stops
 * being walked. Without it the switches are exhaustive by accident only: these walkers return
 * `void`, so a missing arm is invisible to `tsc` (unlike `prose.ts`, whose `string` return type
 * catches its own gaps).
 */
const unwalked = (x: never): void => x;

function walkZoneRef(z: ZoneRef, p: string, w: Walk): void {
  hit(w, 'zone', z.zoneId, `${p}.zoneId`);
  if (z.seat !== null) walkSeatRef(z.seat, `${p}.seat`, w);
}

/**
 * §4.1. v1 needed no such walker: a v1 `SeatRef` held no id at all. `owner`/`controller` now hold a
 * `CardRef`, which holds a `ZoneRef`, which holds a `SeatRef` again — so these four walkers are
 * mutually recursive, and a zone reachable *only* through `SeatRef{kind:'owner'}.card.zone` is
 * delete-protected exactly like one named directly. Mirrors `schema.ts`'s `checkSeatRef`.
 */
function walkSeatRef(s: SeatRef, p: string, w: Walk): void {
  switch (s.kind) {
    case 'owner':
    case 'controller':
      return walkCardRef(s.card, `${p}.card`, w);
    case 'relative':
      return walkSeatRef(s.from, `${p}.from`, w);
    // Positional or quantified: no authored entity is named.
    case 'active':
    case 'next':
    case 'previous':
    case 'triggeringSeat':
    case 'seat':
    case 'all':
      return;
  }
  return unwalked(s);
}

function walkCardRef(c: CardRef, p: string, w: Walk): void {
  switch (c.kind) {
    case 'zoneTop':
      return walkZoneRef(c.zone, `${p}.zone`, w);
    // §4.2 — `host` and `candidate` are runtime bindings, and `instance`/`promptAnswer` address a
    // card by a per-session id, not by anything the definition declares. `replacedTarget` (v2 §4.2,
    // §5.7) is bound at replacement time — carries no authored id either.
    case 'triggering':
    case 'promptAnswer':
    case 'instance':
    case 'host':
    case 'candidate':
    case 'replacedTarget':
      return;
  }
  return unwalked(c);
}

/**
 * v2 §4.2 — none of the three carry a reference `findReferrers` tracks: `{kind:'action', id}` names
 * a runtime `PendingAction` id (game state, not a declared entity), same reasoning as `CardRef`'s
 * `instance`/`promptAnswer`. No `path`/`Walk` parameter, unlike every other `walk*` here — there is
 * nothing for it to `hit()` yet. Still a real switch, not a no-op, so a future `ActionRef` kind that
 * DOES carry one trips the same `unwalked` guard every other walker here relies on.
 */
function walkActionRef(r: ActionRef): void {
  switch (r.kind) {
    case 'triggeringAction':
    case 'topOfStack':
    case 'action':
      return;
  }
  return unwalked(r);
}

function walkValueRef(v: ValueRef, p: string, w: Walk): void {
  switch (v.kind) {
    case 'pool':
      hit(w, 'pool', v.poolId, `${p}.poolId`);
      if (v.seat !== null) walkSeatRef(v.seat, `${p}.seat`, w);
      return;
    case 'cardIndex':
      walkCardRef(v.card, `${p}.card`, w);
      hit(w, 'cardIndex', v.indexId, `${p}.indexId`);
      return;
    case 'zoneCount':
      return walkZoneRef(v.zone, `${p}.zone`, w);
    // §4.3 — `tag` is a free-form string naming nothing declared, but the CardRef it reads from can
    // still carry a ZoneRef.
    case 'cardTag':
      return walkCardRef(v.card, `${p}.card`, w);
    // §4.2, §5.7 — `replacedAmount` is bound at replacement time; carries no authored id.
    // v2 §8 step 28 — `promptNumber.key` is free-form like `chooseNumber.key` itself; no authored id.
    case 'literal':
    case 'activeSeatCount':
    case 'replacedAmount':
    case 'promptNumber':
      return;
    // v2 §4.2 — the `ActionRef` inside can still carry one, per `walkActionRef` above.
    case 'actionField':
      return walkActionRef(v.action);
  }
  return unwalked(v);
}

function walkCriteria(n: CriteriaNode, p: string, w: Walk): void {
  if (n.kind === 'group') {
    n.children.forEach((c, i) => walkCriteria(c, `${p}.children.${i}`, w));
    return;
  }
  walkValueRef(n.left, `${p}.left`, w);
  walkValueRef(n.right, `${p}.right`, w);
}

function walkSelector(s: TargetSelector, p: string, w: Walk): void {
  switch (s.kind) {
    case 'topOfZone':
    case 'bottomOfZone':
      walkZoneRef(s.zone, `${p}.zone`, w);
      walkValueRef(s.count, `${p}.count`, w);
      return;
    case 'allInZone':
    case 'taggedInZone':
      return walkZoneRef(s.zone, `${p}.zone`, w);
    case 'prompt':
      walkSelector(s.from, `${p}.from`, w);
      walkValueRef(s.count, `${p}.count`, w);
      return;
    // §4.4 — the `where` is a full CriteriaNode, so it holds ids exactly like a rule's `condition`.
    case 'matching':
      walkSelector(s.from, `${p}.from`, w);
      walkCriteria(s.where, `${p}.where`, w);
      return;
    case 'attachedTo':
      return walkCardRef(s.host, `${p}.host`, w);
    case 'hostOf':
      return walkCardRef(s.card, `${p}.card`, w);
    case 'triggeringCard':
      return;
  }
  return unwalked(s);
}

/** v2 §4.4 — `counterAction.action`'s selector. `allOnStack.where` is a full CriteriaNode. */
function walkActionSelector(s: ActionSelector, p: string, w: Walk): void {
  switch (s.kind) {
    case 'action':
      return walkActionRef(s.ref);
    case 'allOnStack':
      if (s.where !== null) walkCriteria(s.where, `${p}.where`, w);
      return;
  }
  return unwalked(s);
}

function walkEffect(e: Effect, p: string, w: Walk): void {
  switch (e.kind) {
    case 'moveCards':
      walkSelector(e.target, `${p}.target`, w);
      walkZoneRef(e.to, `${p}.to`, w);
      return;
    case 'drawCards':
      walkZoneRef(e.from, `${p}.from`, w);
      walkZoneRef(e.to, `${p}.to`, w);
      walkValueRef(e.count, `${p}.count`, w);
      return;
    case 'shuffleZone':
      return walkZoneRef(e.zone, `${p}.zone`, w);
    case 'changePool':
      hit(w, 'pool', e.poolId, `${p}.poolId`);
      if (e.seat !== null) walkSeatRef(e.seat, `${p}.seat`, w);
      walkValueRef(e.amount, `${p}.amount`, w);
      return;
    case 'setCardIndex':
      walkSelector(e.target, `${p}.target`, w);
      hit(w, 'cardIndex', e.indexId, `${p}.indexId`);
      walkValueRef(e.amount, `${p}.amount`, w);
      return;
    // §4.3 — `setTag.tag` is a free-form string and `detach` takes no second operand, so for both
    // of the new arms here the target selector is the whole of what can dangle.
    case 'flipCard':
    case 'rotateCard':
    case 'destroyCards':
    case 'setTag':
    case 'detach':
      return walkSelector(e.target, `${p}.target`, w);
    case 'attach':
      walkSelector(e.target, `${p}.target`, w);
      walkCardRef(e.host, `${p}.host`, w);
      return;
    case 'setController':
      walkSelector(e.target, `${p}.target`, w);
      if (e.seat !== null) walkSeatRef(e.seat, `${p}.seat`, w);
      return;
    case 'eliminateSeat':
      return walkSeatRef(e.seat, `${p}.seat`, w);
    case 'createCard':
      hit(w, 'template', e.templateId, `${p}.templateId`);
      walkZoneRef(e.zone, `${p}.zone`, w);
      walkValueRef(e.count, `${p}.count`, w);
      return;
    case 'forceTransition':
      hit(w, 'state', e.toStateId, `${p}.toStateId`);
      return;
    // `fireEvent.name` is free-form by design (§4.6) — no declared entity to reference.
    case 'fireEvent':
      return;
    // v2 §4.5 — carries BOTH a ruleId (RefKind:'ruleSet') and a window (RefKind:'priorityWindow',
    // nullable) — two different reference kinds off one effect, unlike anything above it.
    case 'announceAction':
      hit(w, 'ruleSet', e.ruleId, `${p}.ruleId`);
      if (e.window !== null) hit(w, 'priorityWindow', e.window, `${p}.window`);
      return;
    case 'counterAction':
      return walkActionSelector(e.action, `${p}.action`, w);
    case 'openPriority':
      hit(w, 'priorityWindow', e.window, `${p}.window`);
      return;
    // §4.5 — `options` is a free-form id/label list; nothing declared to reference.
    case 'sealedChoice':
      return walkSeatRef(e.seats, `${p}.seats`, w);
    // §4.5 — `modes[].effects` recurses back into `walkEffect`, which is what makes a rule id or
    // priority window reachable only from inside a mode's branch still delete-protected.
    case 'chooseMode':
      walkSeatRef(e.seat, `${p}.seat`, w);
      e.modes.forEach((mode, i) =>
        mode.effects.forEach((inner, j) => walkEffect(inner, `${p}.modes.${i}.effects.${j}`, w))
      );
      return;
    case 'chooseNumber':
      walkSeatRef(e.seat, `${p}.seat`, w);
      walkValueRef(e.min, `${p}.min`, w);
      walkValueRef(e.max, `${p}.max`, w);
      return;
  }
  return unwalked(e);
}

/**
 * Visits every id reference in the definition exactly once. The mirror of `schema.ts`'s
 * `checkReferences`, which asks "does this id exist"; this asks "who points at this id". Both must
 * cover the same sites, which is why deletes all funnel through here instead of hand-rolling a scan
 * per entity kind.
 */
function walkRefs(d: GameDefinition, visit: Visit): void {
  const self: Owner = { ownerKind: 'definition', ownerId: d.id, ownerName: d.name };

  d.templates.forEach((t, i) => {
    const w: Walk = { visit, owner: { ownerKind: 'template', ownerId: t.id, ownerName: t.name } };
    t.ruleSetIds.forEach((id, j) => hit(w, 'ruleSet', id, `templates.${i}.ruleSetIds.${j}`));
  });

  d.decks.forEach((deck, i) => {
    const w: Walk = { visit, owner: { ownerKind: 'deck', ownerId: deck.id, ownerName: deck.name } };
    hit(w, 'zone', deck.zoneId, `decks.${i}.zoneId`);
    deck.entries.forEach((e, j) =>
      hit(w, 'template', e.templateId, `decks.${i}.entries.${j}.templateId`)
    );
  });

  d.ruleSets.forEach((rs, i) => {
    const w: Walk = { visit, owner: { ownerKind: 'ruleSet', ownerId: rs.id, ownerName: rs.name } };
    if (rs.stateFilter !== null) hit(w, 'state', rs.stateFilter, `ruleSets.${i}.stateFilter`);
    if (rs.condition !== null) walkCriteria(rs.condition, `ruleSets.${i}.condition`, w);
    rs.effects.forEach((e, j) => walkEffect(e, `ruleSets.${i}.effects.${j}`, w));
    // §4.5's `modifier` sub-tree. Precisely §8's first trap: an index or zone reachable only from a
    // modifier would delete with no protection and resurface as a runtime MISSING_REFERENT.
    if (rs.modifier !== null) {
      const m = `ruleSets.${i}.modifier`;
      walkSelector(rs.modifier.scope, `${m}.scope`, w);
      hit(w, 'cardIndex', rs.modifier.indexId, `${m}.indexId`);
      walkValueRef(rs.modifier.amount, `${m}.amount`, w);
      rs.modifier.activeZones.forEach((id, j) => hit(w, 'zone', id, `${m}.activeZones.${j}`));
    }
    // v2 §4.5, §5.7 — `replaces.match` may read `replacedAmount`/`replacedTarget`, which carry no
    // id of their own, but a criterion built from ordinary refs dangles exactly like `condition` does.
    if (rs.replaces !== null && rs.replaces.match !== null) {
      walkCriteria(rs.replaces.match, `ruleSets.${i}.replaces.match`, w);
    }
    // v2 §4.5, §5.8 — three more sub-trees `walkRefs` could not see before step 21/31:
    // `costCheck` (a CriteriaNode), `cost` (an Effect[]) and `window` (a priorityWindow ref).
    if (rs.activation !== null) {
      const a = `ruleSets.${i}.activation`;
      if (rs.activation.costCheck !== null) walkCriteria(rs.activation.costCheck, `${a}.costCheck`, w);
      rs.activation.cost.forEach((effect, j) => walkEffect(effect, `${a}.cost.${j}`, w));
      if (rs.activation.window !== null) hit(w, 'priorityWindow', rs.activation.window, `${a}.window`);
    }
  });

  d.globalRuleSetIds.forEach((id, i) => visit('ruleSet', id, `globalRuleSetIds.${i}`, self));
  visit('state', d.machine.startStateId, 'machine.startStateId', self);
  visit('state', d.machine.endStateId, 'machine.endStateId', self);

  d.machine.states.forEach((s, i) => {
    const w: Walk = { visit, owner: { ownerKind: 'state', ownerId: s.id, ownerName: s.name } };
    if (s.entryCriteria !== null) {
      walkCriteria(s.entryCriteria, `machine.states.${i}.entryCriteria`, w);
    }
    s.enterableFrom.forEach((id, j) =>
      hit(w, 'state', id, `machine.states.${i}.enterableFrom.${j}`)
    );
    s.exitableTo.forEach((id, j) => hit(w, 'state', id, `machine.states.${i}.exitableTo.${j}`));
  });
}

/**
 * Every place `id` is referenced. Empty means the entity is safe to delete. Exported because the
 * authoring UI shows this list next to a blocked delete (§9.4 item 2).
 *
 * Only inbound edges count: references an entity makes *to others* are not its own referrers, so a
 * state is deletable once nobody lists it back, however many neighbours it lists itself.
 */
export function findReferrers(d: GameDefinition, kind: RefKind, id: Id): Referrer[] {
  const found: Referrer[] = [];
  walkRefs(d, (k, refId, path, owner) => {
    if (k !== kind || refId !== id) return;
    if (owner.ownerKind === 'state' && owner.ownerId === id) return; // self-reference
    found.push({ ...owner, path });
  });
  return found;
}

const OWNER_LABEL: Record<Referrer['ownerKind'], string> = {
  ruleSet: 'Rule set',
  template: 'Card',
  deck: 'Deck',
  state: 'State',
  definition: 'Game',
};

const KIND_LABEL: Record<RefKind, string> = {
  pool: 'pool',
  zone: 'zone',
  template: 'card template',
  cardIndex: 'card index',
  ruleSet: 'rule set',
  state: 'state',
  priorityWindow: 'priority window',
};

const blockedErrors = (kind: RefKind, id: Id, refs: Referrer[]): string[] => [
  `Cannot delete ${KIND_LABEL[kind]} "${id}": still referenced by ${refs.length} place(s).`,
  ...refs.map((r) => `${OWNER_LABEL[r.ownerKind]} "${r.ownerName}" (${r.path})`),
];

// ---------------------------------------------------------------------------
// A blank definition — the store needs somewhere to start
// ---------------------------------------------------------------------------

const reservedStates = (): MachineState[] => [
  {
    id: START_STATE_ID,
    name: 'Start',
    enterableFrom: [],
    exitableTo: [END_STATE_ID],
    entryCriteria: null,
    transitionLabel: null,
    priority: 0,
    position: { x: 0, y: 0 },
  },
  {
    id: END_STATE_ID,
    name: 'End',
    enterableFrom: [START_STATE_ID],
    exitableTo: [],
    entryCriteria: null,
    transitionLabel: null,
    priority: 0,
    position: { x: 200, y: 0 },
  },
];

/** `updatedAt` is a parameter, not a clock read — see the header note on §3.2. */
export function createEmptyDefinition(id: Id, name: string, updatedAt: string): GameDefinition {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    playerCount: 2,
    pools: [],
    zones: [],
    templates: [],
    decks: [],
    customEvents: [],
    ruleSets: [],
    globalRuleSetIds: [],
    priorityWindows: [],
    machine: {
      states: reservedStates(),
      startStateId: START_STATE_ID,
      endStateId: END_STATE_ID,
    },
    limits: {
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEffects: DEFAULT_MAX_EFFECTS,
    maxSettleIterations: DEFAULT_MAX_SETTLE_ITERATIONS,
    maxPriorityRounds: DEFAULT_MAX_PRIORITY_ROUNDS,
  },
    updatedAt,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface DefinitionStoreOptions {
  definition?: GameDefinition;
  /** ISO timestamp source. Injected because `src/stores/**` may not call `Date.now()` (§3.2). */
  now?: () => string;
  /** Deterministic id source. Default is a per-store counter — no `crypto.randomUUID` (§3.6). */
  nextId?: (prefix: string) => Id;
}

export interface DefinitionStore {
  definition: GameDefinition;

  /** Replace wholesale (load from IndexedDB). Validated; does NOT bump `updatedAt` (§4.9). */
  setDefinition(d: GameDefinition): EditResult;
  /** §7.2. Nothing is written unless all four gates pass. */
  importDefinition(text: string): EditResult;

  setName(name: string): EditResult;
  setPlayerCount(n: number): EditResult;
  setLimits(limits: GameDefinition['limits']): EditResult;

  addPool(input: Omit<PointPool, 'id'>): EditResult;
  updatePool(id: Id, patch: Partial<Omit<PointPool, 'id'>>): EditResult;
  removePool(id: Id): EditResult;

  addZone(input: Omit<PlayZone, 'id'>): EditResult;
  updateZone(id: Id, patch: Partial<Omit<PlayZone, 'id'>>): EditResult;
  removeZone(id: Id): EditResult;

  addTemplate(input: Omit<CardTemplate, 'id'>): EditResult;
  updateTemplate(id: Id, patch: Partial<Omit<CardTemplate, 'id'>>): EditResult;
  removeTemplate(id: Id): EditResult;

  addCardIndex(templateId: Id, input: Omit<CardIndex, 'id'>): EditResult;
  updateCardIndex(templateId: Id, indexId: Id, patch: Partial<Omit<CardIndex, 'id'>>): EditResult;
  removeCardIndex(templateId: Id, indexId: Id): EditResult;

  addDeck(input: Omit<Deck, 'id'>): EditResult;
  updateDeck(id: Id, patch: Partial<Omit<Deck, 'id'>>): EditResult;
  removeDeck(id: Id): EditResult;

  addCustomEvent(name: string): EditResult;
  removeCustomEvent(name: string): EditResult;

  addRuleSet(input: Omit<RuleSet, 'id'>): EditResult;
  updateRuleSet(id: Id, patch: Partial<Omit<RuleSet, 'id'>>): EditResult;
  removeRuleSet(id: Id): EditResult;
  /** Membership of `globalRuleSetIds` — the game-level rules (§4.9). */
  setGlobalRuleSet(id: Id, on: boolean): EditResult;

  /** v2 §4.6, §8 step 21 — a top-level authored entity, edited in its own screen (§6.9). */
  addPriorityWindow(input: Omit<PriorityWindow, 'id'>): EditResult;
  updatePriorityWindow(id: Id, patch: Partial<Omit<PriorityWindow, 'id'>>): EditResult;
  removePriorityWindow(id: Id): EditResult;

  addState(input: Omit<MachineState, 'id'>): EditResult;
  updateState(id: Id, patch: Partial<Omit<MachineState, 'id'>>): EditResult;
  removeState(id: Id): EditResult;
  /** Writes BOTH sides of the edge, because a one-sided edge is invalid (§4.8). */
  connectStates(from: Id, to: Id): EditResult;
  disconnectStates(from: Id, to: Id): EditResult;
}

const has = (list: readonly { id: Id }[], id: Id): boolean => list.some((e) => e.id === id);

const missing = (kind: string, id: Id): EditResult => ({
  ok: false,
  errors: [`No ${kind} with id "${id}" in this definition.`],
});

/**
 * Not generic on purpose: every call site is already narrowed by the action's own signature, and a
 * `Partial<T>` parameter gives TypeScript a second inference site that fights the first.
 */
function patchById(list: { id: Id }[], id: Id, patch: object): void {
  const found = list.find((e) => e.id === id);
  if (found) Object.assign(found, patch);
}

export function createDefinitionStore(options: DefinitionStoreOptions = {}) {
  // ponytail: `new Date()` is not `Date.now()`, so it clears the §3.2 lint rule on its own — but
  // the point of the rule is testability, so time enters only here, at the creation boundary.
  const now = options.now ?? (() => new Date().toISOString());
  let seq = 0;
  const mint = options.nextId ?? ((prefix: string) => `${prefix}_${++seq}`);

  return create<DefinitionStore>()((set, get) => {
    /** Unique within `taken`, so a counter that starts fresh cannot collide with imported ids. */
    const freshId = (prefix: string, taken: Set<Id>): Id => {
      let id = mint(prefix);
      while (taken.has(id)) id = mint(prefix);
      return id;
    };

    /**
     * Build → validate → commit. On failure nothing is written, so `getState()` returns the very
     * same object it returned before (A2, P3).
     */
    const edit = (mutate: (d: Draft<GameDefinition>) => void, id?: Id): EditResult => {
      const next = produce(get().definition, (d) => {
        mutate(d);
        d.updatedAt = now();
      });
      const errors = validateDefinition(next);
      if (errors.length > 0) return { ok: false, errors };
      set({ definition: next });
      return id === undefined ? { ok: true } : { ok: true, id };
    };

    /** Every delete goes through here, so no entity kind can forget the referrer check. */
    const removeChecked = (
      kind: RefKind,
      id: Id,
      mutate: (d: Draft<GameDefinition>) => void
    ): EditResult => {
      const refs = findReferrers(get().definition, kind, id);
      if (refs.length > 0) return { ok: false, errors: blockedErrors(kind, id, refs) };
      return edit(mutate);
    };

    const allIndexIds = (d: GameDefinition): Set<Id> =>
      new Set(d.templates.flatMap((t) => t.indexes.map((i) => i.id)));

    return {
      definition:
        options.definition ?? createEmptyDefinition(mint('game'), 'Untitled Game', now()),

      setDefinition(d) {
        const errors = validateDefinition(d);
        if (errors.length > 0) return { ok: false, errors };
        set({ definition: d });
        return { ok: true };
      },

      importDefinition(text) {
        const result = importJson(text);
        if (!result.ok) return { ok: false, errors: result.errors };
        set({ definition: result.definition });
        return { ok: true, id: result.definition.id };
      },

      setName: (name) => edit((d) => void (d.name = name)),
      setPlayerCount: (n) => edit((d) => void (d.playerCount = n)),
      setLimits: (limits) => edit((d) => void (d.limits = { ...limits })),

      // --- pools ---
      addPool(input) {
        const id = freshId('pool', new Set(get().definition.pools.map((p) => p.id)));
        return edit((d) => void d.pools.push({ ...input, id }), id);
      },
      updatePool(id, patch) {
        if (!has(get().definition.pools, id)) return missing('pool', id);
        return edit((d) => patchById(d.pools, id, patch));
      },
      removePool: (id) =>
        removeChecked('pool', id, (d) => void (d.pools = d.pools.filter((p) => p.id !== id))),

      // --- zones ---
      addZone(input) {
        const id = freshId('zone', new Set(get().definition.zones.map((z) => z.id)));
        return edit((d) => void d.zones.push({ ...input, id }), id);
      },
      updateZone(id, patch) {
        if (!has(get().definition.zones, id)) return missing('zone', id);
        return edit((d) => patchById(d.zones, id, patch));
      },
      removeZone: (id) =>
        removeChecked('zone', id, (d) => void (d.zones = d.zones.filter((z) => z.id !== id))),

      // --- card templates ---
      addTemplate(input) {
        const id = freshId('tpl', new Set(get().definition.templates.map((t) => t.id)));
        return edit((d) => void d.templates.push({ ...input, id }), id);
      },
      updateTemplate(id, patch) {
        if (!has(get().definition.templates, id)) return missing('card template', id);
        return edit((d) => patchById(d.templates, id, patch));
      },
      removeTemplate: (id) =>
        removeChecked(
          'template',
          id,
          (d) => void (d.templates = d.templates.filter((t) => t.id !== id))
        ),

      // --- card indexes (owned by a template, referenced globally by id) ---
      addCardIndex(templateId, input) {
        const def = get().definition;
        if (!has(def.templates, templateId)) return missing('card template', templateId);
        const id = freshId('idx', allIndexIds(def));
        return edit((d) => {
          d.templates.find((t) => t.id === templateId)?.indexes.push({ ...input, id });
        }, id);
      },
      updateCardIndex(templateId, indexId, patch) {
        const tpl = get().definition.templates.find((t) => t.id === templateId);
        if (!tpl) return missing('card template', templateId);
        if (!has(tpl.indexes, indexId)) return missing('card index', indexId);
        return edit((d) => {
          const t = d.templates.find((x) => x.id === templateId);
          if (t) patchById(t.indexes, indexId, patch);
        });
      },
      removeCardIndex(templateId, indexId) {
        const tpl = get().definition.templates.find((t) => t.id === templateId);
        if (!tpl) return missing('card template', templateId);
        if (!has(tpl.indexes, indexId)) return missing('card index', indexId);
        return removeChecked('cardIndex', indexId, (d) => {
          const t = d.templates.find((x) => x.id === templateId);
          if (t) t.indexes = t.indexes.filter((i) => i.id !== indexId);
        });
      },

      // --- decks ---
      addDeck(input) {
        const id = freshId('deck', new Set(get().definition.decks.map((k) => k.id)));
        return edit((d) => void d.decks.push({ ...input, id }), id);
      },
      updateDeck(id, patch) {
        if (!has(get().definition.decks, id)) return missing('deck', id);
        return edit((d) => patchById(d.decks, id, patch));
      },
      // Nothing references a Deck, so there is no referrer check to run.
      removeDeck: (id) => edit((d) => void (d.decks = d.decks.filter((k) => k.id !== id))),

      // --- custom events ---
      // Free-form strings (§4.6): a RuleSet triggering on a removed name still runs, so removal
      // cannot dangle and needs no referrer check.
      addCustomEvent: (name) =>
        edit((d) => {
          if (!d.customEvents.includes(name)) d.customEvents.push(name);
        }),
      removeCustomEvent: (name) =>
        edit((d) => void (d.customEvents = d.customEvents.filter((e) => e !== name))),

      // --- rule sets ---
      addRuleSet(input) {
        const id = freshId('rs', new Set(get().definition.ruleSets.map((r) => r.id)));
        return edit((d) => void d.ruleSets.push({ ...input, id }), id);
      },
      updateRuleSet(id, patch) {
        if (!has(get().definition.ruleSets, id)) return missing('rule set', id);
        return edit((d) => patchById(d.ruleSets, id, patch));
      },
      removeRuleSet: (id) =>
        removeChecked(
          'ruleSet',
          id,
          (d) => void (d.ruleSets = d.ruleSets.filter((r) => r.id !== id))
        ),
      setGlobalRuleSet: (id, on) =>
        edit((d) => {
          const present = d.globalRuleSetIds.includes(id);
          if (on && !present) d.globalRuleSetIds.push(id);
          if (!on && present) d.globalRuleSetIds = d.globalRuleSetIds.filter((x) => x !== id);
        }),

      // --- priority windows (v2 §4.6, §8 step 21) ---
      addPriorityWindow(input) {
        const id = freshId('window', new Set(get().definition.priorityWindows.map((w) => w.id)));
        return edit((d) => void d.priorityWindows.push({ ...input, id }), id);
      },
      updatePriorityWindow(id, patch) {
        if (!has(get().definition.priorityWindows, id)) return missing('priority window', id);
        return edit((d) => patchById(d.priorityWindows, id, patch));
      },
      removePriorityWindow: (id) =>
        removeChecked(
          'priorityWindow',
          id,
          (d) => void (d.priorityWindows = d.priorityWindows.filter((w) => w.id !== id))
        ),

      // --- state machine ---
      addState(input) {
        const id = freshId('state', new Set(get().definition.machine.states.map((s) => s.id)));
        return edit((d) => void d.machine.states.push({ ...input, id }), id);
      },
      updateState(id, patch) {
        if (!has(get().definition.machine.states, id)) return missing('state', id);
        return edit((d) => patchById(d.machine.states, id, patch));
      },
      removeState: (id) =>
        removeChecked('state', id, (d) => {
          d.machine.states = d.machine.states.filter((s) => s.id !== id);
        }),
      connectStates(from, to) {
        const states = get().definition.machine.states;
        if (!has(states, from)) return missing('state', from);
        if (!has(states, to)) return missing('state', to);
        return edit((d) => {
          const a = d.machine.states.find((s) => s.id === from)!;
          const b = d.machine.states.find((s) => s.id === to)!;
          if (!a.exitableTo.includes(to)) a.exitableTo.push(to);
          if (!b.enterableFrom.includes(from)) b.enterableFrom.push(from);
        });
      },
      disconnectStates(from, to) {
        const states = get().definition.machine.states;
        if (!has(states, from)) return missing('state', from);
        if (!has(states, to)) return missing('state', to);
        return edit((d) => {
          const a = d.machine.states.find((s) => s.id === from)!;
          const b = d.machine.states.find((s) => s.id === to)!;
          a.exitableTo = a.exitableTo.filter((x) => x !== to);
          b.enterableFrom = b.enterableFrom.filter((x) => x !== from);
        });
      },
    };
  });
}

/**
 * The app-wide store. One game is open at a time (§6.1), loaded with `setDefinition`.
 *
 * INTEGRATION POINT — autosave (§7.3). `persistence.ts` owns the debounce; wiring it is one line at
 * the boot site (`main.tsx`, step 19) rather than a constructor option, so this module keeps no
 * IndexedDB dependency and tests need no fake:
 *
 *   const autosave = createAutosave();
 *   useDefinitionStore.subscribe((s, prev) => {
 *     if (s.definition !== prev.definition) autosave.save(s.definition);
 *   });
 */
export const useDefinitionStore = createDefinitionStore();
