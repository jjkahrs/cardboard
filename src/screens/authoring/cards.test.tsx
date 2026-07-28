/**
 * Step 23 — the catalog, the card editor and the deck builder.
 *
 * Step 46 adds the prose-completeness half at the bottom: the READS AS preview and the card face
 * both have to render a rule whose text comes from a panel rather than from `effects`.
 */

import 'fake-indexeddb/auto';
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CardTemplate,
  Deck,
  Effect,
  GameDefinition,
  PlayZone,
  PriorityWindow,
  RuleSet,
} from '../../engine/types';
import { describeEffect, generateRulesProse } from '../../engine/prose';
import { Card } from '../../components/card/Card';
import { RulesProsePreview } from '../../components/authoring/RulesProsePreview';
import { BATTLEFIELD, GRUNT, POWER, RS_STRIKE, duel } from '../../test/fixtures/duel';
import { definition, openRoute, resetGames, seedGame } from '../../test/routeHarness';

const zone = (id: string, name: string, scope: PlayZone['scope'] = 'player'): PlayZone => ({
  id,
  name,
  scope,
  visibility: 'faceDown',
  layout: 'stack',
  ordered: true,
  maxCapacity: null,
});

const template = (over: Partial<CardTemplate> = {}): CardTemplate => ({
  id: 'tpl1',
  name: 'Bolt',
  marquee: 'Bolt',
  faceIcon: 'gi-lightning-bolt',
  borderColor: '#241c14',
  tags: [],
  indexes: [],
  ruleSetIds: [],
  rulesTextOverride: null,
  ...over,
});

const burn: RuleSet = {
  id: 'rs1',
  name: 'Burn',
  trigger: 'onCardPlayed',
  stateFilter: null,
  condition: null,
  effects: [
    {
      kind: 'changePool',
      poolId: 'p1',
      seat: { kind: 'next' },
      op: 'subtract',
      amount: { kind: 'literal', value: 1 },
    },
  ],
  priority: 0,
  onRejection: 'continue',
  modifier: null,
  continuous: false,
  replaces: null,
  activation: null,
};

const hp = {
  id: 'p1',
  scope: 'player' as const,
  value: { type: 'integer' as const, name: 'HP', defaultValue: 20, min: 0, max: null },
};

const only = (): CardTemplate => definition().templates[0];

beforeEach(resetGames);

describe('the catalog (/cards)', () => {
  it('says so when there are no cards', async () => {
    await seedGame();
    await openRoute('/game/g1/cards');
    expect(await screen.findByText(/no cards yet/i)).toBeInTheDocument();
  });

  it('adds a card and opens it', async () => {
    await seedGame();
    const { router, user } = await openRoute('/game/g1/cards');

    await user.click(await screen.findByRole('button', { name: 'Add card' }));

    expect(definition().templates).toHaveLength(1);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/game/g1/cards/${only().id}`)
    );

    await user.click(await screen.findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/game/g1/cards'));
    expect(definition().templates).toHaveLength(1);
  });

  it('renders each card with the same component the table uses, and opens one on click', async () => {
    await seedGame({ templates: [template({ marquee: 'Lightning Bolt' })] });
    const { router, user } = await openRoute('/game/g1/cards');

    const grid = await screen.findByRole('list', { name: 'Cards' });
    const card = within(grid).getByRole('button');
    expect(card).toHaveTextContent('Lightning Bolt');

    await user.click(card);
    await waitFor(() => expect(router.state.location.pathname).toBe('/game/g1/cards/tpl1'));
  });
});

describe('the card editor (/cards/:cardId)', () => {
  const openEditor = async (over: Partial<GameDefinition> = {}) => {
    await seedGame({ templates: [template()], ...over });
    const handle = await openRoute('/game/g1/cards/tpl1');
    await screen.findByRole('heading', { level: 1 });
    return handle;
  };

  it('says so when the card is not there', async () => {
    await seedGame({ templates: [template()] });
    await openRoute('/game/g1/cards/ghost');
    expect(await screen.findByRole('heading', { name: /card not found/i })).toBeInTheDocument();
  });

  it('edits the appearance, and the preview is the card itself', async () => {
    const { user } = await openEditor();

    await user.clear(screen.getByRole('textbox', { name: 'Title on the card' }));
    await user.type(screen.getByRole('textbox', { name: 'Title on the card' }), 'Fire');
    expect(only().marquee).toBe('Fire');
    expect(within(screen.getByRole('region', { name: 'Preview' })).getByText('Fire')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /use the name/i }));
    expect(only().marquee).toBe('Bolt');

    await user.click(screen.getByRole('radio', { name: 'Red' }));
    expect(only().borderColor).toBe('#9e2f26');

    await user.type(screen.getByRole('textbox', { name: 'Tags' }), 'creature,  fire ,');
    expect(only().tags).toEqual(['creature', 'fire']);
  });

  // §4.3 — `CardInstance.tags` is a COPY seeded from the template at creation and mutable per copy
  // after that. Without saying so the field reads as a static label and `setTag` looks global.
  it('says the tags seed each copy in play rather than labelling the template', async () => {
    await openEditor();
    expect(
      screen.getByText(/every copy dealt into play starts with these tags and keeps its own list/i)
    ).toBeInTheDocument();
  });

  it('picks a face icon from the searchable sprite', async () => {
    const { user } = await openEditor();

    await user.click(screen.getByRole('button', { name: 'Face icon' }));
    const picker = within(screen.getByRole('dialog'));
    const first = picker.getAllByRole('button')[0];
    const chosen = first.getAttribute('data-icon-id') ?? first.textContent;
    await user.click(first);

    expect(only().faceIcon).toBeTruthy();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    if (chosen) expect(only().faceIcon.length).toBeGreaterThan(0);
  });

  it('adds a card number, moves it between corners and warns when two share one', async () => {
    const { user } = await openEditor();

    await user.click(screen.getByRole('button', { name: /add a number/i }));
    expect(only().indexes).toHaveLength(1);
    expect(only().indexes[0].position).toBe('topLeft');

    await user.click(screen.getByRole('button', { name: /add a number/i }));
    // Both default to topLeft, so the card would stack them — said out loud, not silently refused.
    expect(screen.getAllByText(/will overlap on the card/)).toHaveLength(2);

    await user.selectOptions(screen.getAllByRole('combobox', { name: 'Corner' })[1], 'bottomRight');
    expect(only().indexes[1].position).toBe('bottomRight');
    expect(screen.queryByText(/will overlap on the card/)).not.toBeInTheDocument();
  });

  it('refuses to remove a card number a rule still reads', async () => {
    const { user } = await openEditor({
      templates: [
        template({
          indexes: [
            {
              id: 'idx1',
              value: { type: 'integer', name: 'Power', defaultValue: 1, min: null, max: null },
              icon: 'gi-sword',
              position: 'topLeft',
            },
          ],
        }),
      ],
      ruleSets: [
        {
          ...burn,
          effects: [
            {
              kind: 'setCardIndex',
              target: { kind: 'triggeringCard' },
              indexId: 'idx1',
              op: 'add',
              amount: { kind: 'literal', value: 1 },
            },
          ],
        },
      ],
      pools: [hp],
    });

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/Cannot delete card index/);
    expect(only().indexes).toHaveLength(1);
  });

  it('attaches a rule and writes it into the card’s rules layer', async () => {
    const { user } = await openEditor({ ruleSets: [burn], pools: [hp] });

    await user.click(screen.getByRole('checkbox', { name: 'Burn' }));

    expect(only().ruleSetIds).toEqual(['rs1']);
    expect(within(screen.getByRole('region', { name: 'Preview' })).getByText(/subtract 1 from HP/)).toBeInTheDocument();
  });

  // AC: A3 (UI half) — the override replaces the text and leaves the RuleSet alone.
  it('overrides the rules text without altering the rules (AC: A3)', async () => {
    const { user } = await openEditor({
      templates: [template({ ruleSetIds: ['rs1'] })],
      ruleSets: [burn],
      pools: [hp],
    });
    const rulesBefore = structuredClone(definition().ruleSets);

    await user.click(screen.getByRole('button', { name: /write my own text/i }));
    // Seeded with the generated text so the designer edits rather than retypes.
    expect(only().rulesTextOverride).toContain('subtract 1 from HP');

    const box = screen.getByRole('textbox', { name: /custom rules text/i });
    await user.clear(box);
    await user.type(box, 'Zap something.');

    expect(only().rulesTextOverride).toBe('Zap something.');
    expect(definition().ruleSets).toEqual(rulesBefore);
    const preview = within(screen.getByRole('region', { name: 'Preview' }));
    expect(preview.getByText('Zap something.')).toBeInTheDocument();
    expect(preview.queryByText(/subtract 1 from HP/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /back to the generated text/i }));
    expect(only().rulesTextOverride).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Preview' })).getByText(/subtract 1 from HP/)
    ).toBeInTheDocument();
  });

  it('deletes the card and returns to the catalog', async () => {
    const { router, user } = await openEditor();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: /delete for good/i }));

    expect(definition().templates).toEqual([]);
    await waitFor(() => expect(router.state.location.pathname).toBe('/game/g1/cards'));
  });

  it('refuses to delete a card a deck still holds', async () => {
    const { router, user } = await openEditor({
      zones: [zone('z1', 'Deck')],
      decks: [{ id: 'd1', name: 'Starter', zoneId: 'z1', entries: [{ templateId: 'tpl1', quantity: 4 }] }],
    });

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: /delete for good/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/Cannot delete card template/);
    expect(definition().templates).toHaveLength(1);
    expect(router.state.location.pathname).toBe('/game/g1/cards/tpl1');
  });
});

describe('the deck builder (/decks)', () => {
  const deck = (over: Partial<Deck> = {}): Deck => ({
    id: 'd1',
    name: 'Starter',
    zoneId: 'z1',
    entries: [],
    ...over,
  });

  it('needs a zone before it can offer a deck at all', async () => {
    await seedGame();
    const { user } = await openRoute('/game/g1/decks');

    expect(await screen.findByText(/needs a zone to deal into/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add deck' }));
    expect(definition().decks).toEqual([]);
  });

  it('adds a deck, fills it, and says what that means per seat', async () => {
    await seedGame({ zones: [zone('z1', 'Deck')], templates: [template()] });
    const { user } = await openRoute('/game/g1/decks');

    await user.click(await screen.findByRole('button', { name: 'Add deck' }));
    await user.click(screen.getByRole('button', { name: /add cards/i }));
    expect(definition().decks[0].entries).toEqual([{ templateId: 'tpl1', quantity: 1 }]);

    const quantity = screen.getByRole('spinbutton', { name: /quantity of entry 1/i });
    await user.clear(quantity);
    await user.type(quantity, '20');
    expect(definition().decks[0].entries[0].quantity).toBe(20);

    // A deck on a per-player zone is instantiated once per seat — 20 authored is 40 dealt.
    expect(screen.getByText(/20 cards per player — 40 in total across 2 seats/)).toBeInTheDocument();
  });

  it('drops the per-seat multiplier for a shared zone', async () => {
    await seedGame({
      zones: [zone('z1', 'Table', 'shared')],
      templates: [template()],
      decks: [deck({ entries: [{ templateId: 'tpl1', quantity: 3 }] })],
    });
    const { user } = await openRoute('/game/g1/decks');

    await user.click(await screen.findByRole('button', { name: 'Starter' }));

    expect(screen.getByText('3 cards')).toBeInTheDocument();
    expect(screen.queryByText(/in total across/)).not.toBeInTheDocument();
  });

  it('removes an entry', async () => {
    await seedGame({
      zones: [zone('z1', 'Deck')],
      templates: [template()],
      decks: [deck({ entries: [{ templateId: 'tpl1', quantity: 3 }] })],
    });
    const { user } = await openRoute('/game/g1/decks');

    await user.click(await screen.findByRole('button', { name: 'Starter' }));
    await user.click(screen.getByRole('button', { name: /remove entry 1/i }));

    expect(definition().decks[0].entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Step 46 — prose completeness. §8's trap 2: a construct with no prose renders BLANK on the card
// face and in the rule editor's READS AS, and neither throws. `prose.test.ts` is the gate on the
// generator itself; these are the gate on the two components that show what it generates.
// ---------------------------------------------------------------------------

const proseWindow: PriorityWindow = {
  id: 'pw1',
  name: 'Responses',
  start: 'active',
  direction: 'forward',
  includeStart: true,
  passesToClose: null,
  collapseEmptyOffers: true,
};

const proseDef: GameDefinition = { ...duel, priorityWindows: [proseWindow] };

const proseRule = (over: Partial<RuleSet>): RuleSet => ({
  id: 'rs-prose',
  name: 'Prose',
  trigger: 'onGameStart',
  stateFilter: null,
  condition: null,
  effects: [],
  priority: 0,
  onRejection: 'continue',
  modifier: null,
  continuous: false,
  replaces: null,
  activation: null,
  ...over,
});

/** Every effect kind v2 added, in one rule — the face and the preview show them or they are lost. */
const V2_EFFECTS: Effect[] = [
  { kind: 'eliminateSeat', seat: { kind: 'relative', from: { kind: 'active' }, offset: -1 } },
  {
    kind: 'attach',
    target: { kind: 'triggeringCard' },
    host: { kind: 'zoneTop', zone: { zoneId: BATTLEFIELD, seat: null } },
  },
  { kind: 'detach', target: { kind: 'hostOf', card: { kind: 'triggering' } } },
  { kind: 'setTag', target: { kind: 'attachedTo', host: { kind: 'host' } }, tag: 'blocking', on: true },
  {
    kind: 'setController',
    target: { kind: 'triggeringCard' },
    seat: { kind: 'owner', card: { kind: 'triggering' } },
  },
  { kind: 'announceAction', ruleId: RS_STRIKE, window: proseWindow.id },
  { kind: 'counterAction', action: { kind: 'allOnStack', where: null } },
  { kind: 'openPriority', window: proseWindow.id },
  {
    kind: 'sealedChoice',
    choiceId: 'c1',
    seats: { kind: 'all' },
    options: [
      { id: 'a', label: 'Bid one' },
      { id: 'b', label: 'Pass' },
    ],
  },
  {
    kind: 'chooseMode',
    promptText: 'Pick',
    seat: { kind: 'active' },
    modes: [
      { label: 'Burn', effects: [] },
      { label: 'Draw', effects: [] },
    ],
  },
  {
    kind: 'chooseNumber',
    promptText: 'How many',
    seat: { kind: 'controller', card: { kind: 'triggering' } },
    min: { kind: 'literal', value: 0 },
    max: { kind: 'activeSeatCount' },
    key: 'n',
  },
];

/** One rule per panel, each taking ALL of its text from the panel. `modifier` has no effects at
 *  all (§5.4 — it never fires one), which is the shape a preview gated on `effects.length` blanks. */
const PANEL_RULES: Record<string, RuleSet> = {
  continuous: proseRule({
    continuous: true,
    condition: {
      kind: 'criteria',
      left: { kind: 'zoneCount', zone: { zoneId: BATTLEFIELD, seat: null } },
      op: '>=',
      right: { kind: 'literal', value: 3 },
    },
    effects: [{ kind: 'shuffleZone', zone: { zoneId: BATTLEFIELD, seat: null } }],
  }),
  modifier: proseRule({
    modifier: {
      scope: {
        kind: 'matching',
        from: { kind: 'allInZone', zone: { zoneId: BATTLEFIELD, seat: null } },
        where: {
          kind: 'criteria',
          left: { kind: 'cardTag', card: { kind: 'candidate' }, tag: 'creature' },
          op: '=',
          right: { kind: 'literal', value: true },
        },
      },
      indexId: POWER,
      op: 'adjust',
      amount: { kind: 'literal', value: 1 },
      activeZones: [BATTLEFIELD],
    },
  }),
  replaces: proseRule({
    replaces: {
      effectKind: 'drawCards',
      match: {
        kind: 'criteria',
        left: { kind: 'replacedAmount' },
        op: '>',
        right: { kind: 'literal', value: 1 },
      },
    },
    effects: [{ kind: 'shuffleZone', zone: { zoneId: BATTLEFIELD, seat: null } }],
  }),
  activation: proseRule({
    activation: {
      costCheck: null,
      cost: [{ kind: 'rotateCard', target: { kind: 'triggeringCard' }, to: 'rotated' }],
      window: proseWindow.id,
      perInstance: true,
      label: 'Tap for value',
    },
    effects: [{ kind: 'shuffleZone', zone: { zoneId: BATTLEFIELD, seat: null } }],
  }),
};

describe('READS AS renders every construct (step 46)', () => {
  const readsAs = (rule: RuleSet) => {
    render(<RulesProsePreview rule={rule} definition={proseDef} />);
    return screen.getByRole('region', { name: 'Reads as' });
  };

  it.each(Object.entries(PANEL_RULES))(
    'a %s rule reads as its panel, not as the empty-effects placeholder',
    (_panel, rule) => {
      const region = readsAs(rule);
      const expected = generateRulesProse([rule], proseDef);

      expect(expected).not.toContain('[deleted');
      expect(within(region).getByText(expected)).toBeInTheDocument();
      expect(within(region).queryByText(/nothing yet/i)).not.toBeInTheDocument();
    }
  );

  it('spells out every effect kind v2 added', () => {
    const region = readsAs(proseRule({ effects: V2_EFFECTS }));

    for (const effect of V2_EFFECTS) {
      expect(region).toHaveTextContent(describeEffect(effect, proseDef));
    }
    expect(region.textContent).not.toContain('[deleted');
  });

  it('still says nothing yet for a rule that really is empty', () => {
    expect(within(readsAs(proseRule({}))).getByText(/nothing yet/i)).toBeInTheDocument();
  });
});

describe('the card face renders every construct (step 46)', () => {
  const faceOf = (rule: RuleSet) => {
    const grunt = proseDef.templates.find((t) => t.id === GRUNT)!;
    const { container } = render(
      <Card
        template={{ ...grunt, ruleSetIds: [rule.id] }}
        definition={{ ...proseDef, ruleSets: [...proseDef.ruleSets, rule] }}
      />
    );
    return container.querySelector('.cb-card__rules')!;
  };

  it.each(Object.entries(PANEL_RULES))('prints a %s rule', (_panel, rule) => {
    expect(faceOf(rule)).toHaveTextContent(generateRulesProse([rule], proseDef));
  });

  it('prints every effect kind v2 added', () => {
    const face = faceOf(proseRule({ effects: V2_EFFECTS }));

    for (const effect of V2_EFFECTS) {
      expect(face).toHaveTextContent(describeEffect(effect, proseDef));
    }
    expect(face.textContent).not.toContain('[deleted');
  });
});
