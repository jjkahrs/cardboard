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
    },
  ],
  globalRuleSetIds: ['r-upkeep'],
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
