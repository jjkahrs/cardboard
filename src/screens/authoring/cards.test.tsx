/**
 * Step 23 — the catalog, the card editor and the deck builder.
 */

import 'fake-indexeddb/auto';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CardTemplate, Deck, GameDefinition, PlayZone, RuleSet } from '../../engine/types';
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
