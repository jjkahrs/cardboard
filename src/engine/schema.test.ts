/**
 * TECHNICAL_DESIGN.md §9.1 rows P2/P3 and §9.3 "Round-trip identity".
 *
 * The fixture is inline on purpose: `src/test/fixtures/duel.ts` belongs to another step, and this
 * file must be able to fail on its own terms without a shared fixture in the blast radius.
 */

import { describe, expect, it, vi } from 'vitest';
import { exportJson, importJson, validateDefinition } from './schema';
import type { GameDefinition } from './types';

// ---------------------------------------------------------------------------
// A small but complete valid definition. Deliberately contains: a null maxCapacity, a `0` default,
// a plain `20`, unicode + escape sequences in a name, nested criteria, a recursive `prompt`
// selector, and several arrays whose order is NOT alphabetical.
// ---------------------------------------------------------------------------

const valid: GameDefinition = {
  schemaVersion: 2,
  id: 'g-tiny',
  name: 'Tiny Duel — "quoted" \\ back é✨\nsecond line',
  playerCount: 2,
  pools: [
    { id: 'hp', scope: 'player', value: { type: 'integer', name: 'HP', defaultValue: 20, min: 0, max: 20 } },
    { id: 'score', scope: 'game', value: { type: 'integer', name: 'Score', defaultValue: 0, min: null, max: null } },
    { id: 'firstBlood', scope: 'game', value: { type: 'boolean', name: 'First Blood', defaultValue: false } },
  ],
  zones: [
    { id: 'deck', name: 'Deck', scope: 'player', visibility: 'faceDown', layout: 'stack', ordered: true, maxCapacity: null },
    { id: 'hand', name: 'Hand', scope: 'player', visibility: 'ownerOnly', layout: 'fan', ordered: true, maxCapacity: 7 },
    { id: 'field', name: 'Battlefield', scope: 'shared', visibility: 'faceUp', layout: 'row', ordered: false, maxCapacity: null },
  ],
  templates: [
    {
      id: 'strike',
      name: 'Strike',
      marquee: 'Strike',
      faceIcon: 'gi-broadsword',
      borderColor: '#8b5a2b',
      tags: ['attack'],
      indexes: [
        { id: 'power', value: { type: 'integer', name: 'Power', defaultValue: 1, min: 0, max: 9 }, icon: 'gi-fist', position: 'topLeft' },
      ],
      ruleSetIds: ['r-strike'],
      rulesTextOverride: null,
    },
    {
      id: 'grunt',
      name: 'Grunt',
      marquee: 'Grunt',
      faceIcon: 'gi-shield',
      borderColor: '#4a5d23',
      tags: ['creature'],
      indexes: [],
      ruleSetIds: [],
      rulesTextOverride: 'Vanilla.',
    },
  ],
  decks: [
    // strike before grunt — not alphabetical, so a sort would show up
    { id: 'starter', name: 'Starter', zoneId: 'deck', entries: [{ templateId: 'strike', quantity: 20 }, { templateId: 'grunt', quantity: 20 }] },
  ],
  customEvents: ['onUpkeep'],
  ruleSets: [
    {
      id: 'r-strike',
      name: 'Strike hits',
      trigger: 'onCardPlayed',
      stateFilter: null,
      condition: {
        kind: 'group',
        combinator: 'and',
        children: [
          { kind: 'criteria', left: { kind: 'pool', poolId: 'hp', seat: { kind: 'active' } }, op: '>', right: { kind: 'literal', value: 0 } },
          {
            kind: 'group',
            combinator: 'or',
            children: [
              { kind: 'criteria', left: { kind: 'zoneCount', zone: { zoneId: 'field', seat: null } }, op: '>=', right: { kind: 'literal', value: 1 } },
              { kind: 'criteria', left: { kind: 'pool', poolId: 'firstBlood', seat: null }, op: '=', right: { kind: 'literal', value: false } },
            ],
          },
        ],
      },
      effects: [
        // changePool before moveCards — effect order is semantic (§5.3) and must survive export
        { kind: 'changePool', poolId: 'hp', seat: { kind: 'next' }, op: 'subtract', amount: { kind: 'cardIndex', card: { kind: 'triggering' }, indexId: 'power' } },
        {
          kind: 'moveCards',
          target: {
            kind: 'prompt',
            from: { kind: 'taggedInZone', zone: { zoneId: 'field', seat: null }, tag: 'creature' },
            count: { kind: 'literal', value: 1 },
            promptText: 'Choose a creature',
          },
          to: { zoneId: 'hand', seat: { kind: 'active' } },
          position: 'top',
        },
      ],
      priority: 0,
      onRejection: 'continue',
      modifier: null,
      continuous: false,
      replaces: null,
      activation: null,
    },
    {
      id: 'r-upkeep',
      name: 'Upkeep draw',
      trigger: 'onStateEnter',
      stateFilter: 'main',
      condition: null,
      effects: [
        { kind: 'drawCards', from: { zoneId: 'deck', seat: { kind: 'active' } }, to: { zoneId: 'hand', seat: { kind: 'active' } }, count: { kind: 'literal', value: 1 } },
        { kind: 'createCard', templateId: 'grunt', zone: { zoneId: 'field', seat: null }, position: { kind: 'index', index: 0 }, count: { kind: 'literal', value: 2 } },
        { kind: 'setCardIndex', target: { kind: 'allInZone', zone: { zoneId: 'field', seat: null } }, indexId: 'power', op: 'add', amount: { kind: 'literal', value: 1 } },
        { kind: 'forceTransition', toStateId: 'end' },
      ],
      priority: 5,
      onRejection: 'abort',
      modifier: null,
      continuous: false,
      replaces: null,
      activation: null,
    },
  ],
  globalRuleSetIds: ['r-upkeep'],
  priorityWindows: [],
  machine: {
    states: [
      // exitableTo ['main','end'] and enterableFrom ['start','main'] are both non-alphabetical
      { id: 'start', name: 'Start', enterableFrom: [], exitableTo: ['main', 'end'], entryCriteria: null, transitionLabel: 'Begin', priority: 0, position: { x: 0, y: 0 } },
      { id: 'main', name: 'Main', enterableFrom: ['start'], exitableTo: ['end'], entryCriteria: null, transitionLabel: 'End Turn', priority: 0, position: { x: 120, y: 40 } },
      { id: 'end', name: 'End', enterableFrom: ['start', 'main'], exitableTo: [], entryCriteria: { kind: 'criteria', left: { kind: 'pool', poolId: 'hp', seat: { kind: 'all' } }, op: '<=', right: { kind: 'literal', value: 0 } }, transitionLabel: null, priority: 0, position: { x: 240, y: 0 } },
    ],
    startStateId: 'start',
    endStateId: 'end',
  },
  limits: { maxDepth: 256, maxEffects: 50_000, maxSettleIterations: 64, maxPriorityRounds: 256 },
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const canonical = exportJson(valid);

/** Deep clone via JSON so mutations never touch `valid`. */
const clone = (): Record<string, any> => JSON.parse(canonical);

const failed = (text: string): string[] => {
  const r = importJson(text);
  if (r.ok) throw new Error(`expected import to fail, but it succeeded:\n${text.slice(0, 200)}`);
  return r.errors;
};

const imported = (text: string): GameDefinition => {
  const r = importJson(text);
  if (!r.ok) throw new Error(`expected import to succeed, got:\n${r.errors.join('\n')}`);
  return r.definition;
};

// ---------------------------------------------------------------------------

describe('the definition fixture', () => {
  it('is valid', () => {
    expect(validateDefinition(valid)).toEqual([]);
  });

  // The rail renames through this same gate, so a blank name has to fail here rather than in the
  // one screen that happens to ask — an imported file can carry one too.
  it('rejects a blank game name, naming the field', () => {
    expect(validateDefinition({ ...valid, name: '' })).toEqual([
      expect.stringMatching(/^name: .*empty/),
    ]);
  });
});

// ---------------------------------------------------------------------------
// P3 — malformed input rejected, naming the field (§9.1)
// ---------------------------------------------------------------------------

// AC: P3
describe('P3: malformed input names the failing field', () => {
  const rows: { name: string; text: () => string; expected: string }[] = [
    {
      name: 'not JSON at all',
      text: () => '{ "schemaVersion": 1, ',
      expected: 'File is not valid JSON: ',
    },
    {
      name: 'zone missing name',
      text: () => {
        const d = clone();
        delete d.zones[0].name;
        return JSON.stringify(d);
      },
      expected: 'zones.0.name: Required',
    },
    {
      name: 'maxCapacity: -1',
      text: () => {
        const d = clone();
        d.zones[1].maxCapacity = -1;
        return JSON.stringify(d);
      },
      expected: 'zones.1.maxCapacity: Number must be greater than or equal to 1',
    },
    {
      name: 'maxCapacity: 0 (§9.4 item 15)',
      text: () => {
        const d = clone();
        d.zones[1].maxCapacity = 0;
        return JSON.stringify(d);
      },
      expected: 'zones.1.maxCapacity: Number must be greater than or equal to 1',
    },
    {
      name: 'maxCapacity: "seven"',
      text: () => {
        const d = clone();
        d.zones[1].maxCapacity = 'seven';
        return JSON.stringify(d);
      },
      expected: 'zones.1.maxCapacity: Expected number, received string',
    },
    {
      name: "pool type: 'string'",
      text: () => {
        const d = clone();
        d.pools[0].value.type = 'string';
        return JSON.stringify(d);
      },
      expected: 'pools.0.value.type: Invalid discriminator value.',
    },
    {
      name: "effect kind: 'teleport'",
      text: () => {
        const d = clone();
        d.ruleSets[0].effects[0].kind = 'teleport';
        return JSON.stringify(d);
      },
      expected: 'ruleSets.0.effects.0.kind: Invalid discriminator value.',
    },
    {
      name: 'integer GameValue with min > max',
      text: () => {
        const d = clone();
        d.pools[0].value.min = 5;
        d.pools[0].value.max = 1;
        return JSON.stringify(d);
      },
      expected: 'pools.0.value.min: min (5) must be less than or equal to max (1)',
    },
    {
      name: 'non-integer default',
      text: () => {
        const d = clone();
        d.pools[0].value.defaultValue = 1.5;
        return JSON.stringify(d);
      },
      expected: 'pools.0.value.defaultValue: Expected integer, received float',
    },
    {
      name: 'playerCount 0',
      text: () => {
        const d = clone();
        d.playerCount = 0;
        return JSON.stringify(d);
      },
      expected: 'playerCount: Number must be greater than or equal to 1',
    },
  ];

  it.each(rows)('$name', ({ text, expected }) => {
    expect(failed(text()).join('\n')).toContain(expected);
  });
});

// ---------------------------------------------------------------------------
// Gate 2 — version, a different path from malformed JSON (§9.4 item 10)
// ---------------------------------------------------------------------------

describe('gate 2: schema version', () => {
  it('rejects schemaVersion 999 with one message, before any field noise', () => {
    const d = clone();
    d.schemaVersion = 999;
    d.zones = 'not even an array'; // would produce shape errors if the version gate ran late
    expect(failed(JSON.stringify(d))).toEqual([
      'Unsupported schema version 999. This build reads version 2.',
    ]);
  });

  // §7.1 — v1 is a live input, so it gets its own message saying WHY there is no migration,
  // distinct from the generic future-version one above.
  it('rejects schemaVersion 1 by name, saying v1 is not convertible', () => {
    const d = clone();
    d.schemaVersion = 1;
    expect(failed(JSON.stringify(d))).toEqual([
      'Unsupported schema version 1. This build reads version 2. v1 definitions are not convertible — the schema changed before release.',
    ]);
  });

  it('rejects an absent schemaVersion on the version path, not as a shape error', () => {
    const d = clone();
    delete d.schemaVersion;
    expect(failed(JSON.stringify(d))).toEqual(['Missing schemaVersion. This build reads version 2.']);
  });
});

// ---------------------------------------------------------------------------
// Gate 4 — referential integrity (§7.2), which is NOT a shape error
// ---------------------------------------------------------------------------

describe('gate 4: referential integrity', () => {
  it('rejects a RuleSet referencing a nonexistent zone', () => {
    const d = clone();
    d.ruleSets[1].effects[0].from.zoneId = 'nope';
    expect(failed(JSON.stringify(d))).toEqual(['ruleSets.1.effects.0.from.zoneId: Unknown zone id "nope"']);
  });

  it('rejects duplicate zone names', () => {
    const d = clone();
    d.zones[2].name = 'Hand';
    expect(failed(JSON.stringify(d))).toEqual([
      'zones.2.name: Zone names must be unique; "Hand" is used more than once',
    ]);
  });

  it.each([
    ['deck target zone', (d: any) => (d.decks[0].zoneId = 'nope'), 'decks.0.zoneId: Unknown zone id "nope"'],
    ['deck entry template', (d: any) => (d.decks[0].entries[1].templateId = 'nope'), 'decks.0.entries.1.templateId: Unknown template id "nope"'],
    ['template ruleSetId', (d: any) => (d.templates[0].ruleSetIds[0] = 'nope'), 'templates.0.ruleSetIds.0: Unknown rule set id "nope"'],
    ['globalRuleSetId', (d: any) => (d.globalRuleSetIds[0] = 'nope'), 'globalRuleSetIds.0: Unknown rule set id "nope"'],
    ['stateFilter', (d: any) => (d.ruleSets[1].stateFilter = 'nope'), 'ruleSets.1.stateFilter: Unknown state id "nope"'],
    ['forceTransition toStateId', (d: any) => (d.ruleSets[1].effects[3].toStateId = 'nope'), 'ruleSets.1.effects.3.toStateId: Unknown state id "nope"'],
    ['poolId in an effect', (d: any) => (d.ruleSets[0].effects[0].poolId = 'nope'), 'ruleSets.0.effects.0.poolId: Unknown pool id "nope"'],
    ['indexId in an effect', (d: any) => (d.ruleSets[1].effects[2].indexId = 'nope'), 'ruleSets.1.effects.2.indexId: Unknown card index id "nope"'],
    ['createCard templateId', (d: any) => (d.ruleSets[1].effects[1].templateId = 'nope'), 'ruleSets.1.effects.1.templateId: Unknown template id "nope"'],
    ['zone inside a nested prompt selector', (d: any) => (d.ruleSets[0].effects[1].target.from.zone.zoneId = 'nope'), 'ruleSets.0.effects.1.target.from.zone.zoneId: Unknown zone id "nope"'],
    ['pool inside a nested criteria group', (d: any) => (d.ruleSets[0].condition.children[1].children[1].left.poolId = 'nope'), 'ruleSets.0.condition.children.1.children.1.left.poolId: Unknown pool id "nope"'],
    ['machine.startStateId', (d: any) => (d.machine.startStateId = 'nope'), 'machine.startStateId: Unknown state id "nope"'],
    ['machine.endStateId', (d: any) => (d.machine.endStateId = 'nope'), 'machine.endStateId: Unknown state id "nope"'],
  ])('rejects a dangling %s', (_name, mutate, expected) => {
    const d = clone();
    mutate(d);
    expect(failed(JSON.stringify(d))).toContain(expected);
  });

  // v2 §4.5 — the four RuleSet sub-trees and the six new effect kinds. Gate 4 saw none of them
  // before this: the WALKER did (so delete-protection worked), which is exactly what makes the gap
  // easy to miss — an id deleted through the UI was blocked, but the same definition hand-edited or
  // round-tripped through JSON imported clean and failed later as a runtime MISSING_REFERENT.
  // `modifier` is the pre-existing half of the gap, unchecked here since step 13.
  const withRule = (patch: Record<string, unknown>) => (d: any) => Object.assign(d.ruleSets[0], patch);
  const withEffect = (effect: unknown) => (d: any) => (d.ruleSets[0].effects = [effect]);
  const activationOf = (patch: Record<string, unknown>) => ({
    costCheck: null, cost: [], window: null, perInstance: false, label: 'Activate', ...patch,
  });

  it.each([
    ['modifier scope zone', withRule({ modifier: { scope: { kind: 'allInZone', zone: { zoneId: 'nope', seat: null } }, indexId: 'power', op: 'set', amount: { kind: 'literal', value: 1 }, activeZones: [] } }), 'ruleSets.0.modifier.scope.zone.zoneId: Unknown zone id "nope"'],
    ['modifier indexId', withRule({ modifier: { scope: { kind: 'triggeringCard' }, indexId: 'nope', op: 'set', amount: { kind: 'literal', value: 1 }, activeZones: [] } }), 'ruleSets.0.modifier.indexId: Unknown card index id "nope"'],
    ['modifier activeZones entry', withRule({ modifier: { scope: { kind: 'triggeringCard' }, indexId: 'power', op: 'set', amount: { kind: 'literal', value: 1 }, activeZones: ['nope'] } }), 'ruleSets.0.modifier.activeZones.0: Unknown zone id "nope"'],
    // v4 §4.4 — `continuous`'s object form is the fifth RuleSet sub-tree holding ids of its own.
    ['continuous.over zone', withRule({ continuous: { over: { kind: 'allInZone', zone: { zoneId: 'nope', seat: null } } } }), 'ruleSets.0.continuous.over.zone.zoneId: Unknown zone id "nope"'],
    ['continuous.over nested index', withRule({ continuous: { over: { kind: 'matching', from: { kind: 'allInZone', zone: { zoneId: 'field', seat: null } }, where: { kind: 'criteria', left: { kind: 'cardIndex', card: { kind: 'candidate' }, indexId: 'nope' }, op: '>', right: { kind: 'literal', value: 0 } } } } }), 'ruleSets.0.continuous.over.where.left.indexId: Unknown card index id "nope"'],
    ['replaces.match pool', withRule({ replaces: { effectKind: 'drawCards', match: { kind: 'criteria', left: { kind: 'pool', poolId: 'nope', seat: null }, op: '=', right: { kind: 'literal', value: 1 } } } }), 'ruleSets.0.replaces.match.left.poolId: Unknown pool id "nope"'],
    ['activation.costCheck pool', withRule({ activation: activationOf({ costCheck: { kind: 'criteria', left: { kind: 'pool', poolId: 'nope', seat: null }, op: '>=', right: { kind: 'literal', value: 2 } } }) }), 'ruleSets.0.activation.costCheck.left.poolId: Unknown pool id "nope"'],
    ['activation.cost effect zone', withRule({ activation: activationOf({ cost: [{ kind: 'shuffleZone', zone: { zoneId: 'nope', seat: null } }] }) }), 'ruleSets.0.activation.cost.0.zone.zoneId: Unknown zone id "nope"'],
    ['activation.window', withRule({ activation: activationOf({ window: 'nope' }) }), 'ruleSets.0.activation.window: Unknown priority window id "nope"'],
    ['announceAction ruleId', withEffect({ kind: 'announceAction', ruleId: 'nope', window: null }), 'ruleSets.0.effects.0.ruleId: Unknown rule set id "nope"'],
    ['announceAction window', withEffect({ kind: 'announceAction', ruleId: 'rs-pool', window: 'nope' }), 'ruleSets.0.effects.0.window: Unknown priority window id "nope"'],
    ['openPriority window', withEffect({ kind: 'openPriority', window: 'nope' }), 'ruleSets.0.effects.0.window: Unknown priority window id "nope"'],
    ['counterAction allOnStack.where', withEffect({ kind: 'counterAction', action: { kind: 'allOnStack', where: { kind: 'criteria', left: { kind: 'pool', poolId: 'nope', seat: null }, op: '=', right: { kind: 'literal', value: 1 } } } }), 'ruleSets.0.effects.0.action.where.left.poolId: Unknown pool id "nope"'],
    ['chooseNumber bounds', withEffect({ kind: 'chooseNumber', promptText: 'How many', seat: { kind: 'active' }, min: { kind: 'literal', value: 0 }, max: { kind: 'pool', poolId: 'nope', seat: null }, key: 'x' }), 'ruleSets.0.effects.0.max.poolId: Unknown pool id "nope"'],
    ['chooseMode nested effect', withEffect({ kind: 'chooseMode', promptText: 'Pick', seat: { kind: 'active' }, modes: [{ label: 'A', effects: [{ kind: 'shuffleZone', zone: { zoneId: 'nope', seat: null } }] }] }), 'ruleSets.0.effects.0.modes.0.effects.0.zone.zoneId: Unknown zone id "nope"'],
    ['sealedChoice seat ref', withEffect({ kind: 'sealedChoice', choiceId: 'strike', seats: { kind: 'owner', card: { kind: 'zoneTop', zone: { zoneId: 'nope', seat: null } } }, options: [] }), 'ruleSets.0.effects.0.seats.card.zone.zoneId: Unknown zone id "nope"'],
    // v4 §4.3 — `chooseSeat`'s only danglable field is who is asked, so that is the descent to prove.
    ['chooseSeat seat ref', withEffect({ kind: 'chooseSeat', promptText: 'Who', seat: { kind: 'controller', card: { kind: 'zoneTop', zone: { zoneId: 'nope', seat: null } } }, key: 'v' }), 'ruleSets.0.effects.0.seat.card.zone.zoneId: Unknown zone id "nope"'],
  ])('rejects a dangling %s', (_name, mutate, expected) => {
    const d = clone();
    mutate(d);
    expect(failed(JSON.stringify(d))).toContain(expected);
  });

  // §5.6 author-time. The End rule is what closed the runtime repro in stateMachine.test.ts.
  it('rejects a non-empty exitableTo on the End state', () => {
    const d = clone();
    d.machine.states[2].exitableTo = ['main'];
    d.machine.states[1].enterableFrom.push('end');
    expect(failed(JSON.stringify(d))).toEqual([
      'machine.states.2.exitableTo: End state "end" must have an empty exitableTo.',
    ]);
  });

  it('rejects a non-empty enterableFrom on the Start state', () => {
    const d = clone();
    d.machine.states[0].enterableFrom = ['main'];
    d.machine.states[1].exitableTo.push('start');
    expect(failed(JSON.stringify(d))).toEqual([
      'machine.states.0.enterableFrom: Start state "start" must have an empty enterableFrom.',
    ]);
  });

  it('names both states and the missing side of a one-sided edge', () => {
    const d = clone();
    d.machine.states[0].exitableTo = ['end']; // start no longer exits to main
    expect(failed(JSON.stringify(d))).toEqual([
      'machine.states.1.enterableFrom.0: One-sided edge "start" -> "main": "main" lists "start" in enterableFrom, but "start" does not list "main" in exitableTo',
    ]);
  });

  it('names the other side when exitableTo is the declaring half', () => {
    const d = clone();
    d.machine.states[1].enterableFrom = []; // main no longer accepts start
    expect(failed(JSON.stringify(d))).toEqual([
      'machine.states.0.exitableTo.0: One-sided edge "start" -> "main": "start" lists "main" in exitableTo, but "main" does not list "start" in enterableFrom',
    ]);
  });
});

// ---------------------------------------------------------------------------
// P2 / §9.3 — canonicality, tested directly rather than by hopeful round-tripping
// ---------------------------------------------------------------------------

// AC: P2
// ---------------------------------------------------------------------------
// SeatRef is recursive now — §4.1. Mutated onto a clone rather than into `valid`, so the key-order
// and byte-identity assertions above keep testing the fixture they were written against.
// ---------------------------------------------------------------------------

describe('the recursive relative SeatRef', () => {
  /** Puts `seat` on the End state's entryCriteria, the fixture's one SeatRef-bearing ValueRef. */
  const withSeat = (seat: unknown): string => {
    const d = clone();
    d.machine.states[2].entryCriteria.left.seat = seat;
    return JSON.stringify(d);
  };

  const nested = { kind: 'relative', from: { kind: 'relative', from: { kind: 'active' }, offset: 1 }, offset: -2 };

  it('parses at arbitrary nesting depth and survives the round trip', () => {
    const text = withSeat(nested);
    const def = imported(text);
    expect(def.machine.states[2].entryCriteria).toMatchObject({ left: { seat: nested } });
    expect(exportJson(imported(exportJson(def)))).toBe(exportJson(def));
  });

  it('rejects a fractional offset', () => {
    expect(failed(withSeat({ kind: 'relative', from: { kind: 'active' }, offset: 0.5 }))).toEqual([
      'machine.states.2.entryCriteria.left.seat.offset: Expected integer, received float',
    ]);
  });

  it('rejects an unknown kind inside `from`, so the recursion is really validated', () => {
    expect(failed(withSeat({ kind: 'relative', from: { kind: 'nobody' }, offset: 1 }))).not.toEqual([]);
  });

  // §4.1's owner/controller close the loop: SeatRef -> CardRef -> ZoneRef -> SeatRef. The shape has
  // to parse through `z.lazy` in both directions, and gate 4 has to descend the whole way, or a
  // zone id reachable only through a SeatRef imports clean and dies at runtime instead.
  it('parses owner/controller, which makes SeatRef -> CardRef -> ZoneRef -> SeatRef mutual', () => {
    const owner = {
      kind: 'owner',
      card: { kind: 'zoneTop', zone: { zoneId: 'deck', seat: { kind: 'controller', card: { kind: 'triggering' } } } },
    };
    const def = imported(withSeat(owner));
    expect(def.machine.states[2].entryCriteria).toMatchObject({ left: { seat: owner } });
    expect(exportJson(imported(exportJson(def)))).toBe(exportJson(def));
  });

  // §4.4's `matching` makes TargetSelector recursive in a SECOND place, and puts a whole
  // CriteriaNode inside a selector for the first time. Both halves have to be walked or a `where`
  // is a hole in gate 4 that imports clean and dies at runtime.
  describe('the `matching` selector', () => {
    /** Wraps the fixture's existing prompt target in a predicate on `power`. */
    const withMatching = (indexId = 'power'): Record<string, any> => {
      const d = clone();
      const target = d.ruleSets[0].effects[1].target;
      d.ruleSets[0].effects[1].target = {
        kind: 'matching',
        from: target,
        where: {
          kind: 'criteria',
          left: { kind: 'cardIndex', card: { kind: 'candidate' }, indexId },
          op: '>',
          right: { kind: 'literal', value: 2 },
        },
      };
      return d;
    };

    it('parses wrapping a prompt, and survives the round trip', () => {
      const d = withMatching();
      const def = imported(JSON.stringify(d));
      expect(def.ruleSets[0].effects[1]).toMatchObject({
        target: { kind: 'matching', from: { kind: 'prompt' }, where: { left: { card: { kind: 'candidate' } } } },
      });
      expect(exportJson(imported(exportJson(def)))).toBe(exportJson(def));
    });

    it('catches a dangling card index inside the `where`', () => {
      expect(failed(JSON.stringify(withMatching('nope')))).toEqual([
        'ruleSets.0.effects.1.target.where.left.indexId: Unknown card index id "nope"',
      ]);
    });
  });

  it('catches a dangling zone id buried inside a SeatRef\'s card ref', () => {
    expect(
      failed(withSeat({ kind: 'owner', card: { kind: 'zoneTop', zone: { zoneId: 'nope', seat: null } } }))
    ).toEqual([
      'machine.states.2.entryCriteria.left.seat.card.zone.zoneId: Unknown zone id "nope"',
    ]);
  });
});

// ---------------------------------------------------------------------------
// v4 §4.1 — the derived ValueRefs. `arith` makes `ValueRef` self-recursive and the two folds make it
// mutually recursive with `TargetSelector`, so both `z.lazy` directions and gate 4's new descent need
// the same proof the SeatRef cycle above gets: a shape that parses, a round trip that is byte
// identical, and a dangling id buried in the new sub-tree that gate 4 actually reports.
// ---------------------------------------------------------------------------

describe('v4 §4.1: derived value refs', () => {
  /** Puts `left` on the End state's entryCriteria, the same seam the SeatRef tests above use. */
  const withLeft = (left: unknown): string => {
    const d = clone();
    d.machine.states[2].entryCriteria.left = left;
    return JSON.stringify(d);
  };

  /** "all cards in their Deck where Power is above 2" — a fold over a predicate over a zone. */
  const bigOnesInDeck = (indexId = 'power') => ({
    kind: 'matching',
    from: { kind: 'allInZone', zone: { zoneId: 'deck', seat: { kind: 'active' } } },
    where: {
      kind: 'criteria',
      left: { kind: 'cardIndex', card: { kind: 'candidate' }, indexId },
      op: '>',
      right: { kind: 'literal', value: 2 },
    },
  });

  it('parses arith at nesting depth and survives the round trip', () => {
    const nested = {
      kind: 'arith',
      op: 'multiply',
      left: { kind: 'arith', op: 'add', left: { kind: 'literal', value: 1 }, right: { kind: 'activeSeatCount' } },
      right: { kind: 'literal', value: 3 },
    };
    const def = imported(withLeft(nested));
    expect(def.machine.states[2].entryCriteria).toMatchObject({ left: nested });
    expect(exportJson(imported(exportJson(def)))).toBe(exportJson(def));
  });

  it('parses both folds, which makes ValueRef and TargetSelector mutually recursive', () => {
    const count = { kind: 'countMatching', from: bigOnesInDeck() };
    const sum = { kind: 'sumIndex', from: bigOnesInDeck(), indexId: 'power' };
    for (const fold of [count, sum]) {
      const def = imported(withLeft(fold));
      expect(def.machine.states[2].entryCriteria).toMatchObject({ left: fold });
      expect(exportJson(imported(exportJson(def)))).toBe(exportJson(def));
    }
  });

  // The fold's `from` holds a selector holding a criteria holding a ValueRef — four levels of
  // descent that did not exist before v4. A hole anywhere in it imports clean and dies at runtime.
  it('catches a dangling card index inside a fold\'s selector', () => {
    expect(failed(withLeft({ kind: 'countMatching', from: bigOnesInDeck('nope') }))).toEqual([
      'machine.states.2.entryCriteria.left.from.where.left.indexId: Unknown card index id "nope"',
    ]);
  });

  it('catches sumIndex\'s own dangling indexId', () => {
    expect(failed(withLeft({ kind: 'sumIndex', from: bigOnesInDeck(), indexId: 'nope' }))).toEqual([
      'machine.states.2.entryCriteria.left.indexId: Unknown card index id "nope"',
    ]);
  });

  it('catches a dangling pool buried in an arith operand', () => {
    const ref = {
      kind: 'arith',
      op: 'add',
      left: { kind: 'literal', value: 1 },
      right: { kind: 'pool', poolId: 'nope', seat: null },
    };
    expect(failed(withLeft(ref))).toEqual([
      'machine.states.2.entryCriteria.left.right.poolId: Unknown pool id "nope"',
    ]);
  });

  it('rejects an op that is not one of the five', () => {
    const ref = { kind: 'arith', op: 'divide', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 1 } };
    expect(failed(withLeft(ref))).not.toEqual([]);
  });

  // A boolean operand is admitted by SHAPE and refused by the resolver (`valueRef.test.ts`), the
  // same split §4.1's `sum` uses: only the runtime knows what a `cardIndex` operand reads as.
  it('admits a boolean literal operand — the TYPE_MISMATCH is the resolver\'s', () => {
    const ref = { kind: 'arith', op: 'add', left: { kind: 'literal', value: true }, right: { kind: 'literal', value: 1 } };
    expect(validateDefinition(JSON.parse(withLeft(ref)))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v4 §4.2, §4.3 — `CardRef{self}` and the `chooseSeat`/`promptSeat` pair. Both are additive arms, so
// what needs proving is that they parse where their siblings do and round-trip byte-identically
// (§3 decision 1's no-version-bump claim); the dangling descent for `chooseSeat.seat` is in gate 4's
// table above.
// ---------------------------------------------------------------------------

describe('v4 §4.2, §4.3: self and the chooseSeat/promptSeat pair', () => {
  const withLeft = (left: unknown): string => {
    const d = clone();
    d.machine.states[2].entryCriteria.left = left;
    return JSON.stringify(d);
  };

  it('parses `self` anywhere a CardRef is legal, and survives the round trip', () => {
    const ref = { kind: 'cardIndex', card: { kind: 'self' }, indexId: 'power' };
    const def = imported(withLeft(ref));
    expect(def.machine.states[2].entryCriteria).toMatchObject({ left: ref });
    expect(exportJson(imported(exportJson(def)))).toBe(exportJson(def));
  });

  it('parses `promptSeat` anywhere a SeatRef is legal, and survives the round trip', () => {
    const ref = { kind: 'pool', poolId: 'hp', seat: { kind: 'promptSeat', key: 'victim' } };
    const def = imported(withLeft(ref));
    expect(def.machine.states[2].entryCriteria).toMatchObject({ left: ref });
    expect(exportJson(imported(exportJson(def)))).toBe(exportJson(def));
  });

  it('parses the chooseSeat effect and round-trips it with its keys in declaration order', () => {
    const d = clone();
    // Scrambled on the way in — canonical export is what pins the order, not the input.
    d.ruleSets[0].effects = [{ key: 'victim', seat: { kind: 'active' }, kind: 'chooseSeat', promptText: 'Who' }];
    const def = imported(JSON.stringify(d));
    expect(def.ruleSets[0].effects[0]).toEqual({
      kind: 'chooseSeat',
      promptText: 'Who',
      seat: { kind: 'active' },
      key: 'victim',
    });
    expect(exportJson(imported(exportJson(def)))).toBe(exportJson(def));
    // `exportJson` pretty-prints (2-space), so the order claim is made against the re-parsed keys
    // rather than a compact substring: JSON.parse preserves insertion order for non-numeric keys,
    // and insertion order IS zod's declaration order (§7.1) — which is what pins the export bytes.
    expect(Object.keys(JSON.parse(exportJson(def)).ruleSets[0].effects[0])).toEqual([
      'kind',
      'promptText',
      'seat',
      'key',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §4.1's `sum` refinement. The fixture's End-state entryCriteria is `hp(all) <= 0` — the one
// authored ValueRef with a seat on it — so `sum` goes there, over `hp` (integer) or `firstBlood`
// (boolean) by turn.
// ---------------------------------------------------------------------------

// AC: SP6
describe('SP6: the `sum` quantifier is refused over a boolean pool', () => {
  const withPoolAndQuantifier = (poolId: string, quantifier: string): string => {
    const d = clone();
    d.machine.states[2].entryCriteria.left.poolId = poolId;
    d.machine.states[2].entryCriteria.left.seat = { kind: 'all', quantifier };
    return JSON.stringify(d);
  };

  it('rejects it at the schema level, naming the quantifier and the pool', () => {
    expect(failed(withPoolAndQuantifier('firstBlood', 'sum'))).toEqual([
      'machine.states.2.entryCriteria.left.seat.quantifier: Pool "firstBlood" is a boolean; the "sum" quantifier needs a numeric pool',
    ]);
  });

  it('admits the identical shape over an integer pool — the refinement is about the pool TYPE', () => {
    const def = imported(withPoolAndQuantifier('hp', 'sum'));
    expect(def.machine.states[2].entryCriteria).toMatchObject({
      left: { seat: { kind: 'all', quantifier: 'sum' } },
    });
    // §7.2: the new quantifier survives the round trip byte for byte.
    expect(exportJson(imported(exportJson(def)))).toBe(exportJson(def));
  });

  it('still admits `every` and `some` over the boolean pool — only `sum` is type-restricted', () => {
    expect(validateDefinition(imported(withPoolAndQuantifier('firstBlood', 'every')))).toEqual([]);
    expect(validateDefinition(imported(withPoolAndQuantifier('firstBlood', 'some')))).toEqual([]);
  });

  it('rejects a quantifier that is not one of the three', () => {
    expect(failed(withPoolAndQuantifier('hp', 'product'))).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v2 §4.5 — RuleSet.continuous / .modifier / .replaces / .activation are mutually exclusive
// ---------------------------------------------------------------------------

describe('v2 §4.5: continuous / modifier / replaces / activation are mutually exclusive', () => {
  const activation = { costCheck: null, cost: [], window: null, perInstance: false, label: 'Activate' };
  const replaces = { effectKind: 'changePool', match: null };
  const modifier = {
    scope: { kind: 'triggeringCard' },
    indexId: 'power',
    op: 'set',
    amount: { kind: 'literal', value: 1 },
    activeZones: [],
  };

  it('rejects continuous: true together with a non-null modifier', () => {
    const d = clone();
    d.ruleSets[0].continuous = true;
    d.ruleSets[0].modifier = modifier;
    expect(failed(JSON.stringify(d))).toEqual([
      'ruleSets.0.continuous: A RuleSet may be at most one of: continuous, modifier, replaces, activation — pick one.',
    ]);
  });

  it('rejects replaces together with activation', () => {
    const d = clone();
    d.ruleSets[0].replaces = replaces;
    d.ruleSets[0].activation = activation;
    expect(failed(JSON.stringify(d))).toEqual([
      'ruleSets.0.continuous: A RuleSet may be at most one of: continuous, modifier, replaces, activation — pick one.',
    ]);
  });

  it('rejects all four set at once, same as any pair', () => {
    const d = clone();
    d.ruleSets[0].continuous = true;
    d.ruleSets[0].modifier = modifier;
    d.ruleSets[0].replaces = replaces;
    d.ruleSets[0].activation = activation;
    expect(failed(JSON.stringify(d))).toEqual([
      'ruleSets.0.continuous: A RuleSet may be at most one of: continuous, modifier, replaces, activation — pick one.',
    ]);
  });

  it('admits continuous alone', () => {
    const d = clone();
    d.ruleSets[0].continuous = true;
    expect(validateDefinition(imported(JSON.stringify(d)))).toEqual([]);
  });

  // v4 §4.4 — the object form is the same mode as `true`, so the count needs no widening: `{ over }`
  // is truthy and `false` is the only not-continuous value.
  it('admits the per-object form alone, and rejects it beside a modifier like `true` is rejected', () => {
    const perObject = { over: { kind: 'allInZone', zone: { zoneId: 'field', seat: null } } };
    const alone = clone();
    alone.ruleSets[0].continuous = perObject;
    expect(validateDefinition(imported(JSON.stringify(alone)))).toEqual([]);

    const both = clone();
    both.ruleSets[0].continuous = perObject;
    both.ruleSets[0].modifier = modifier;
    expect(failed(JSON.stringify(both))).toEqual([
      'ruleSets.0.continuous: A RuleSet may be at most one of: continuous, modifier, replaces, activation — pick one.',
    ]);
  });

  // v4 §4.4, §3 decision 4 — the settle scan is a READ. Dual-checked: `continuous.ts` degrades an
  // imported file that gets past this to zero arms rather than asking a question mid-scan.
  it('rejects a prompt inside `over`, at the top level and nested inside a `matching`', () => {
    const promptOver = {
      kind: 'prompt',
      from: { kind: 'allInZone', zone: { zoneId: 'field', seat: null } },
      count: { kind: 'literal', value: 1 },
      promptText: 'Pick',
    };
    const message =
      'ruleSets.0.continuous.over: A per-object continuous rule\'s "over" selector may not contain a prompt at any depth — the settle scan is a read and cannot ask a question (v4 §4.4).';

    const top = clone();
    top.ruleSets[0].continuous = { over: promptOver };
    expect(failed(JSON.stringify(top))).toEqual([message]);

    const nested = clone();
    nested.ruleSets[0].continuous = {
      over: { kind: 'matching', from: promptOver, where: { kind: 'group', combinator: 'and', children: [] } },
    };
    expect(failed(JSON.stringify(nested))).toEqual([message]);
  });

  it('admits replaces alone', () => {
    const d = clone();
    d.ruleSets[0].replaces = replaces;
    expect(validateDefinition(imported(JSON.stringify(d)))).toEqual([]);
  });

  it('admits activation alone', () => {
    const d = clone();
    d.ruleSets[0].activation = activation;
    expect(validateDefinition(imported(JSON.stringify(d)))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v2 §5.8 — a cost effect may not suspend
// ---------------------------------------------------------------------------

describe('v4 §4.5: activation.cost may ask a question, but only a freezable one', () => {
  const withCost = (costEffect: unknown): string => {
    const d = clone();
    d.ruleSets[0].activation = {
      costCheck: null,
      cost: [costEffect],
      window: null,
      perInstance: false,
      label: 'Activate',
    };
    return JSON.stringify(d);
  };

  const unfreezable = (kind: string) =>
    `ruleSets.0.activation.cost.0: Cost effect 0 (${kind}) cannot be frozen ahead of the cost (it is a "${kind}" effect) — a cost may ask for a target, a number or a player, but not this (v4 §4.5).`;

  // The three that stayed banned (v4 §4.5.0(c)). `chooseMode` is the interesting one: which branch is
  // chosen decides which sub-effects exist, so freezing it means freezing a tree of unknown shape.
  it('rejects chooseMode', () => {
    expect(
      failed(withCost({ kind: 'chooseMode', promptText: 'Pick', seat: { kind: 'active' }, modes: [] }))
    ).toEqual([unfreezable('chooseMode')]);
  });

  it('rejects sealedChoice', () => {
    expect(
      failed(withCost({ kind: 'sealedChoice', choiceId: 'c', seats: { kind: 'all' }, options: [] }))
    ).toEqual([unfreezable('sealedChoice')]);
  });

  it('rejects openPriority', () => {
    // Two independent failures, both genuine: the freezability rule, and — since gate 4 now
    // descends into `activation.cost` — the window id, which this fixture never declared.
    expect(failed(withCost({ kind: 'openPriority', window: 'w1' }))).toEqual([
      unfreezable('openPriority'),
      'ruleSets.0.activation.cost.0.window: Unknown priority window id "w1"',
    ]);
  });

  // v4 §4.5 (G5) — the three the two-pass cost lifted. Each of these used to be a hard refusal here.
  it('admits chooseNumber — an {X} cost is the case G5 was raised for', () => {
    expect(
      validateDefinition(
        imported(
          withCost({
            kind: 'chooseNumber',
            promptText: 'Pick',
            seat: { kind: 'active' },
            min: { kind: 'literal', value: 0 },
            max: { kind: 'literal', value: 1 },
            key: 'k',
          })
        )
      )
    ).toEqual([]);
  });

  it('admits chooseSeat', () => {
    expect(
      validateDefinition(
        imported(withCost({ kind: 'chooseSeat', promptText: 'Pick a player', seat: { kind: 'active' }, key: 'v' }))
      )
    ).toEqual([]);
  });

  it('admits a `prompt` TargetSelector — "sacrifice a creature" at last', () => {
    const prompted = {
      kind: 'destroyCards',
      target: {
        kind: 'prompt',
        from: { kind: 'triggeringCard' },
        count: { kind: 'literal', value: 1 },
        promptText: 'Choose',
      },
    };
    expect(validateDefinition(imported(withCost(prompted)))).toEqual([]);
  });

  it('admits a `prompt` nested inside a `matching`\'s `from` — depth never shielded it either way', () => {
    const nested = {
      kind: 'destroyCards',
      target: {
        kind: 'matching',
        from: {
          kind: 'prompt',
          from: { kind: 'triggeringCard' },
          count: { kind: 'literal', value: 1 },
          promptText: 'Choose',
        },
        where: { kind: 'criteria', left: { kind: 'literal', value: 1 }, op: '=', right: { kind: 'literal', value: 1 } },
      },
    };
    expect(validateDefinition(imported(withCost(nested)))).toEqual([]);
  });

  it('admits an ordinary cost effect with no prompt', () => {
    const plain = { kind: 'changePool', poolId: 'hp', seat: null, op: 'subtract', amount: { kind: 'literal', value: 1 } };
    expect(validateDefinition(imported(withCost(plain)))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v4 §4.6 (G8) — the schema half of SP19. The row needed no schema change at all, and this is the
// assertion that says so on purpose rather than by omission: nothing here ever banned a prompting
// target selector inside a `chooseMode` branch, so the shape was always *importable* — it merely
// failed AWAITING_PROMPT at runtime. Now that it runs, a future refinement that bans it (by analogy
// with the cost rule directly above, which is a different rule for a different reason) would make
// the one card shape G8 exists for unauthorable again, and would fail here.
// ---------------------------------------------------------------------------

describe('a modal branch that targets — importable and valid (v4 §4.6)', () => {
  it('admits a `prompt` target selector inside a chooseMode mode', () => {
    const d = clone();
    d.ruleSets[0].effects = [
      {
        kind: 'chooseMode',
        promptText: 'Choose one',
        seat: { kind: 'active' },
        modes: [
          { label: 'Draw', effects: [{ kind: 'drawCards', from: { zoneId: 'deck', seat: { kind: 'active' } }, to: { zoneId: 'hand', seat: { kind: 'active' } }, count: { kind: 'literal', value: 1 } }] },
          {
            label: 'Destroy target creature',
            effects: [
              {
                kind: 'destroyCards',
                target: {
                  kind: 'prompt',
                  from: { kind: 'allInZone', zone: { zoneId: 'field', seat: null } },
                  count: { kind: 'literal', value: 1 },
                  promptText: 'Choose a creature',
                },
              },
            ],
          },
        ],
      },
    ];
    expect(validateDefinition(imported(JSON.stringify(d)))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v2 §5.7 — replaces.effectKind is restricted to the five interceptable kinds
// ---------------------------------------------------------------------------

describe('v2 §5.7: replaces.effectKind is restricted to the five interceptable kinds', () => {
  const withReplaces = (effectKind: string): string => {
    const d = clone();
    d.ruleSets[0].replaces = { effectKind, match: null };
    return JSON.stringify(d);
  };

  it('rejects a non-interceptable kind, naming the field', () => {
    expect(failed(withReplaces('fireEvent'))).toEqual([
      'ruleSets.0.replaces.effectKind: "fireEvent" cannot be replaced; only drawCards, changePool, moveCards, destroyCards, setCardIndex are interceptable (§5.7).',
    ]);
  });

  it.each(['drawCards', 'changePool', 'moveCards', 'destroyCards', 'setCardIndex'])(
    'admits %s',
    (kind) => {
      expect(validateDefinition(imported(withReplaces(kind)))).toEqual([]);
    }
  );

  it('rejects an id that is not any Effect kind at all — the shape gate, not just the refinement', () => {
    expect(failed(withReplaces('notARealKind'))).not.toEqual([]);
  });
});

describe('P2: canonical export', () => {
  /** Reverse every object's key order, recursively. Arrays keep their order. */
  const scramble = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(scramble);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, scramble(x)]));
    }
    return v;
  };

  it('scrambled input key order yields the identical canonical string', () => {
    const scrambledText = JSON.stringify(scramble(JSON.parse(canonical)), null, 2);
    expect(scrambledText).not.toBe(canonical); // the scramble actually did something
    expect(exportJson(imported(scrambledText))).toBe(canonical);
  });

  it('round-trips byte-identically', () => {
    expect(exportJson(imported(exportJson(valid)))).toBe(canonical);
  });

  it('is stable over a second round trip', () => {
    expect(exportJson(imported(exportJson(imported(canonical))))).toBe(canonical);
  });

  it('puts schemaVersion first', () => {
    expect(Object.keys(JSON.parse(canonical))[0]).toBe('schemaVersion');
    expect(canonical.startsWith('{\n  "schemaVersion": 2,')).toBe(true);
  });

  it('keeps maxCapacity: null as a present key', () => {
    expect(canonical).toContain('"maxCapacity": null');
    expect(JSON.parse(canonical).zones[0]).toHaveProperty('maxCapacity');
  });

  // v2 §4.5, §4.6, §4.11, §7.2 — the new fields must be `.nullable()`-and-PRESENT, not `.optional()`:
  // an `.optional()` there would turn `null` into an absent key and only fail on the SECOND round
  // trip (the header note above). `priorityWindows` is checked at [] rather than null since it is an
  // array field (always present, never nullable), same as every other top-level entity list.
  it('keeps continuous/replaces/activation as present keys even when null/false, and priorityWindows present', () => {
    expect(canonical).toContain('"continuous": false');
    expect(canonical).toContain('"replaces": null');
    expect(canonical).toContain('"activation": null');
    expect(canonical).toContain('"priorityWindows": []');
    const out = JSON.parse(canonical);
    expect(out.ruleSets[0]).toHaveProperty('continuous');
    expect(out.ruleSets[0]).toHaveProperty('replaces');
    expect(out.ruleSets[0]).toHaveProperty('activation');
    expect(out).toHaveProperty('priorityWindows');
  });

  it('is stable over a second round trip with a populated priorityWindows and a non-null replaces/activation', () => {
    const d = clone();
    d.priorityWindows = [
      {
        id: 'w1',
        name: 'Response window',
        start: 'active',
        direction: 'forward',
        includeStart: false,
        passesToClose: null,
        collapseEmptyOffers: true,
      },
    ];
    d.ruleSets[1].replaces = { effectKind: 'drawCards', match: null };
    d.ruleSets[1].activation = null; // replaces already set — mutually exclusive with activation
    const text = JSON.stringify(d);
    const once = exportJson(imported(text));
    const twice = exportJson(imported(once));
    expect(twice).toBe(once);
    expect(once).toContain('"priorityWindows"');
    expect(JSON.parse(once).priorityWindows).toEqual(d.priorityWindows);
    expect(JSON.parse(once).ruleSets[1].replaces).toEqual({ effectKind: 'drawCards', match: null });
  });

  it('does not omit a 0 default as falsy', () => {
    expect(canonical).toContain('"defaultValue": 0');
    expect(JSON.parse(canonical).pools[1].value).toHaveProperty('defaultValue');
  });

  it('never turns 20 into 20.0', () => {
    expect(canonical).toContain('"defaultValue": 20');
    expect(canonical).not.toMatch(/\d\.0\b/);
  });

  it('preserves unicode and escape sequences', () => {
    expect(JSON.parse(canonical).name).toBe(valid.name);
    expect(exportJson(imported(canonical))).toContain(JSON.stringify(valid.name).slice(1, -1));
  });

  it('strips unknown keys instead of preserving them', () => {
    const d = clone();
    d.bogusRoot = 'x';
    d.zones[0].bogusZone = 'x';
    expect(exportJson(imported(JSON.stringify(d)))).toBe(canonical);
  });

  it('does not sort arrays — deck entries, effect order, enterableFrom', () => {
    const out = JSON.parse(canonical);
    expect(out.decks[0].entries.map((e: any) => e.templateId)).toEqual(['strike', 'grunt']);
    expect(out.ruleSets[0].effects.map((e: any) => e.kind)).toEqual(['changePool', 'moveCards']);
    expect(out.ruleSets.map((r: any) => r.id)).toEqual(['r-strike', 'r-upkeep']);
    expect(out.machine.states[0].exitableTo).toEqual(['main', 'end']);
    expect(out.machine.states[2].enterableFrom).toEqual(['start', 'main']);
    expect(out.customEvents).toEqual(['onUpkeep']);
  });

  it('never writes updatedAt', () => {
    const d = clone();
    d.updatedAt = '1999-12-31T23:59:59.000Z';
    expect(imported(JSON.stringify(d)).updatedAt).toBe('1999-12-31T23:59:59.000Z');
  });

  it('imports with Date.now and crypto.randomUUID stubbed to throw', () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now() called during import');
    });
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('crypto.randomUUID() called during import');
    });
    try {
      expect(exportJson(imported(canonical))).toBe(canonical);
    } finally {
      now.mockRestore();
      uuid.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------

describe('validateDefinition', () => {
  it('returns the same error strings the importer produces', () => {
    const broken = clone();
    broken.zones[2].name = 'Hand';
    expect(validateDefinition(broken)).toEqual(failed(JSON.stringify(broken)));
  });

  it('does not throw on garbage', () => {
    expect(validateDefinition(null).length).toBeGreaterThan(0);
    expect(validateDefinition(42).length).toBeGreaterThan(0);
    expect(validateDefinition([]).length).toBeGreaterThan(0);
  });
});
