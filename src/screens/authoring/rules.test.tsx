/**
 * Step 22 — the RuleSet library and the rule editor.
 *
 * Driven through the real route table and the real store, like the step 19 routing tests: the two
 * new routes and the "edit one rule, every card carrying it changes" claim are the artefacts under
 * test, and a screen rendered without its route proves neither.
 */

import 'fake-indexeddb/auto';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CardIndex,
  CardTemplate,
  GameDefinition,
  PlayZone,
  PriorityWindow,
  RuleSet,
} from '../../engine/types';
import { defaultEffect, missingFor } from '../../components/authoring/effectKinds';
import { defaultSelector } from '../../components/authoring/targetSelector';
import { createEmptyDefinition, useDefinitionStore } from '../../stores/definitionStore';
import { deleteGame, getAllGames, putGame } from '../../stores/persistence';
import { routes } from '../../routes';

const zone = (id: string, name: string): PlayZone => ({
  id,
  name,
  scope: 'player',
  visibility: 'faceDown',
  layout: 'stack',
  ordered: true,
  maxCapacity: null,
});

const rule = (over: Partial<RuleSet> = {}): RuleSet => ({
  id: 'rs1',
  name: 'Burn',
  trigger: 'onCardPlayed',
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

const template = (over: Partial<CardTemplate> = {}): CardTemplate => ({
  id: 'tpl1',
  name: 'Bolt',
  marquee: 'Bolt',
  faceIcon: 'gi-lightning-bolt',
  borderColor: '#a8342a',
  tags: [],
  indexes: [],
  ruleSetIds: [],
  rulesTextOverride: null,
  ...over,
});

const seed = async (over: Partial<GameDefinition> = {}): Promise<GameDefinition> => {
  const game: GameDefinition = {
    ...createEmptyDefinition('g1', 'Duel', '2026-01-01T00:00:00.000Z'),
    zones: [zone('z1', 'Deck'), zone('z2', 'Hand')],
    pools: [
      { id: 'p1', scope: 'player', value: { type: 'integer', name: 'HP', defaultValue: 20, min: 0, max: null } },
    ],
    ...over,
  };
  await putGame(game);
  return game;
};

const at = (path: string) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return { router, user: userEvent.setup(), ...render(<RouterProvider router={router} />) };
};

/** The library and the editor both wait on the layout's IndexedDB load. */
const openRules = async (path = '/game/g1/rules') => {
  const handle = at(path);
  await waitFor(() => expect(useDefinitionStore.getState().definition.id).toBe('g1'));
  return handle;
};

const definition = () => useDefinitionStore.getState().definition;
const only = () => definition().ruleSets[0];

beforeEach(async () => {
  for (const game of await getAllGames()) await deleteGame(game.id);
  useDefinitionStore
    .getState()
    .setDefinition(createEmptyDefinition('blank', 'blank', '2026-01-01T00:00:00.000Z'));
  localStorage.clear();
});

describe('the rule library (/rules)', () => {
  it('lists each rule with what fires it, how much it does and where it hangs', async () => {
    await seed({
      ruleSets: [rule({ effects: [{ kind: 'shuffleZone', zone: { zoneId: 'z1', seat: { kind: 'active' } } }] })],
      templates: [template({ ruleSetIds: ['rs1'] })],
    });
    await openRules();

    const row = within(await screen.findByRole('list', { name: 'Rules' })).getByRole('listitem');
    expect(within(row).getByText('Burn')).toBeInTheDocument();
    expect(row).toHaveTextContent(/onCardPlayed · 1 effect · on 1 card/);
  });

  it('adds a rule and opens it', async () => {
    await seed();
    const { router, user } = await openRules();

    await user.click(await screen.findByRole('button', { name: 'Add rule' }));

    expect(definition().ruleSets).toHaveLength(1);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/game/g1/rules/${only().id}`)
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New rule');
  });

  it('refuses to delete a rule a card still carries, and names the card', async () => {
    // Blocked, not confirmed: the referential gate would reject the resulting definition anyway.
    await seed({ ruleSets: [rule()], templates: [template({ ruleSetIds: ['rs1'] })] });
    const { user } = await openRules();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(screen.getByText(/Used by Bolt/)).toBeInTheDocument();
    expect(definition().ruleSets).toHaveLength(1);
  });
});

describe('the rule editor (/rules/:ruleSetId)', () => {
  const openEditor = async (over: Partial<GameDefinition> = {}) => {
    await seed({ ruleSets: [rule()], ...over });
    const handle = await openRules('/game/g1/rules/rs1');
    await screen.findByRole('heading', { level: 1 });
    return handle;
  };

  it('says so when the rule is not there, instead of rendering an empty editor', async () => {
    await seed({ ruleSets: [rule()] });
    await openRules('/game/g1/rules/ghost');
    expect(await screen.findByRole('heading', { name: /rule not found/i })).toBeInTheDocument();
  });

  it('edits the trigger, and offers a state filter only for the two triggers that use one', async () => {
    const { user } = await openEditor();
    expect(screen.queryByRole('combobox', { name: 'State' })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Trigger' }), 'onStateEnter');
    expect(only().trigger).toBe('onStateEnter');

    // §4.7 — stateFilter is ignored for every other trigger, so offering it there would be a lie.
    await user.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'end');
    expect(only().stateFilter).toBe('end');
  });

  it('offers a custom event as a trigger', async () => {
    const { user } = await openEditor({ customEvents: ['onTurnStart'] });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Trigger' }), 'onTurnStart');
    expect(only().trigger).toBe('onTurnStart');
  });

  it('edits priority and marks the rule game-level', async () => {
    const { user } = await openEditor();

    await user.type(screen.getByRole('spinbutton', { name: 'Priority' }), '5');
    expect(only().priority).toBe(5);

    await user.click(screen.getByRole('checkbox', { name: /game-level rule/i }));
    expect(definition().globalRuleSetIds).toEqual(['rs1']);
  });

  it('adds a condition and removes it again', async () => {
    const { user } = await openEditor();
    expect(screen.getByText(/always runs/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add a condition/i }));
    expect(only().condition).toEqual({ kind: 'group', combinator: 'and', children: [] });

    await user.click(screen.getByRole('button', { name: /remove this all of group/i }));
    expect(only().condition).toBeNull();
  });

  it('adds an effect from the picker and reads it back as English', async () => {
    const { user } = await openEditor();

    await user.click(screen.getByRole('button', { name: 'Add an effect' }));
    await user.click(screen.getByRole('button', { name: 'Draw' }));

    expect(only().effects).toEqual([
      {
        kind: 'drawCards',
        from: { zoneId: 'z1', seat: { kind: 'active' } },
        to: { zoneId: 'z1', seat: { kind: 'active' } },
        count: { kind: 'literal', value: 1 },
      },
    ]);
    // The preview runs the SAME generateRulesProse the card's Rules layer runs (§6.3).
    expect(screen.getByRole('region', { name: 'Reads as' })).toHaveTextContent(
      "When this card is played: draw 1 card from the active player's Deck to the active player's Deck."
    );
  });

  it('changes an effect through the sentence, keeping the zone already chosen', async () => {
    const { user } = await openEditor({
      ruleSets: [
        rule({
          effects: [
            { kind: 'shuffleZone', zone: { zoneId: 'z2', seat: { kind: 'active' } } },
          ],
        }),
      ],
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Effect 1 kind' }), 'moveCards');

    // Switching kind carries the zone across rather than resetting to the first zone in the game.
    expect(only().effects[0]).toEqual({
      kind: 'moveCards',
      target: { kind: 'triggeringCard' },
      to: { zoneId: 'z2', seat: { kind: 'active' } },
      position: 'top',
    });
  });

  it('edits a zone through its chip', async () => {
    const { user } = await openEditor({
      ruleSets: [rule({ effects: [{ kind: 'shuffleZone', zone: { zoneId: 'z1', seat: { kind: 'active' } } }] })],
    });

    await user.click(screen.getByRole('button', { name: 'Zone to shuffle' }));
    await user.selectOptions(within(screen.getByRole('dialog')).getByRole('combobox', { name: 'Zone' }), 'z2');

    expect(only().effects[0]).toMatchObject({ zone: { zoneId: 'z2' } });
  });

  it('marks the effect that pauses the rule, at the point of authoring', async () => {
    // §5.4's suspension is the one genuinely surprising behaviour; §6.8 puts the ⏸ here rather than
    // leaving the designer to discover it mid-playtest.
    const { user } = await openEditor({
      ruleSets: [rule({ effects: [{ kind: 'destroyCards', target: { kind: 'triggeringCard' } }] })],
    });
    expect(screen.queryByText(/execution pauses here/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Which cards' }));
    await user.click(screen.getByRole('radio', { name: /cards the player chooses/i }));

    expect(only().effects[0]).toMatchObject({
      target: { kind: 'prompt', from: { kind: 'triggeringCard' }, promptText: 'Choose a card' },
    });
    expect(screen.getByText(/execution pauses here/)).toBeInTheDocument();
  });

  it('reorders and removes effects with the keyboard-reachable controls', async () => {
    const { user } = await openEditor({
      ruleSets: [
        rule({
          effects: [
            { kind: 'shuffleZone', zone: { zoneId: 'z1', seat: { kind: 'active' } } },
            { kind: 'destroyCards', target: { kind: 'triggeringCard' } },
          ],
        }),
      ],
    });

    expect(screen.getByRole('button', { name: 'Move effect 1 up' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move effect 1 down' }));
    expect(only().effects.map((e) => e.kind)).toEqual(['destroyCards', 'shuffleZone']);

    await user.click(screen.getByRole('button', { name: 'Remove effect 2' }));
    expect(only().effects.map((e) => e.kind)).toEqual(['destroyCards']);
  });

  it('duplicates a rule without sharing anything with the original', async () => {
    const { router, user } = await openEditor({
      ruleSets: [rule({ effects: [{ kind: 'shuffleZone', zone: { zoneId: 'z1', seat: { kind: 'active' } } }] })],
    });

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    const [original, copy] = definition().ruleSets;
    expect(copy.name).toBe('Burn copy');
    expect(copy.id).not.toBe(original.id);
    expect(copy.effects[0]).not.toBe(original.effects[0]); // deep-cloned, not shared
    await waitFor(() => expect(router.state.location.pathname).toBe(`/game/g1/rules/${copy.id}`));
  });

  it('deletes the rule and returns to the library', async () => {
    const { router, user } = await openEditor();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: /delete for good/i }));

    expect(definition().ruleSets).toEqual([]);
    await waitFor(() => expect(router.state.location.pathname).toBe('/game/g1/rules'));
  });

  it('disables the effect kinds the game has nothing to point at, and says what is missing', async () => {
    const { user } = await openEditor({ zones: [], pools: [], ruleSets: [rule()] });

    await user.click(screen.getByRole('button', { name: 'Add an effect' }));
    const picker = within(screen.getByRole('dialog'));

    expect(picker.getByRole('button', { name: 'Draw' })).toBeDisabled();
    expect(picker.getAllByText('needs a zone')).toHaveLength(4); // draw, move, shuffle, create
    expect(picker.getByText('needs a pool')).toBeInTheDocument();
    // Nothing to reference — always available.
    expect(picker.getByRole('button', { name: 'Destroy' })).toBeEnabled();
  });
});

/**
 * Step 45 — the four mutually-exclusive rule modes (§4.5, §6.10).
 *
 * The exclusivity claim is only worth testing against the REAL store: every assertion below reads
 * the definition back, so a patch the zod refinement rejected shows up as an unchanged rule rather
 * than as a green test.
 */
describe('the four rule-mode panels', () => {
  const index = (id: string, name: string): CardIndex => ({
    id,
    value: { type: 'integer', name, defaultValue: 1, min: null, max: null },
    icon: 'gi-sword',
    position: 'topLeft',
  });

  const window_ = (id: string, name: string): PriorityWindow => ({
    id,
    name,
    start: 'active',
    direction: 'forward',
    includeStart: true,
    passesToClose: null,
    collapseEmptyOffers: true,
  });

  const openEditor = async (over: Partial<GameDefinition> = {}) => {
    await seed({
      ruleSets: [rule()],
      templates: [template({ indexes: [index('idx1', 'Power'), index('idx2', 'Toughness')] })],
      priorityWindows: [window_('w1', 'Response')],
      ...over,
    });
    const handle = await openRules('/game/g1/rules/rs1');
    await screen.findByRole('heading', { level: 1 });
    return handle;
  };

  /** Nothing rejected: a refused patch leaves `FormErrors` shouting through `role="alert"`. */
  const accepted = () => expect(screen.queryByRole('alert')).not.toBeInTheDocument();

  const pick = (user: ReturnType<typeof userEvent.setup>, mode: string) =>
    user.click(screen.getByRole('radio', { name: mode }));

  it('is a single choice of five, and each switch clears the other three panels', async () => {
    const { user } = await openEditor();
    expect(screen.getByRole('radio', { name: 'trigger' })).toBeChecked();

    await pick(user, 'value modifier');
    expect(only()).toMatchObject({ continuous: false, replaces: null, activation: null });
    expect(only().modifier).toEqual({
      scope: { kind: 'triggeringCard' },
      indexId: 'idx1',
      op: 'adjust',
      amount: { kind: 'literal', value: 1 },
      activeZones: [],
    });
    accepted();

    await pick(user, 'replacement');
    expect(only()).toMatchObject({ continuous: false, modifier: null, activation: null });
    expect(only().replaces).toEqual({ effectKind: 'drawCards', match: null });
    accepted();

    await pick(user, 'activation');
    expect(only()).toMatchObject({ continuous: false, modifier: null, replaces: null });
    expect(only().activation).toEqual({
      costCheck: null,
      cost: [],
      window: null,
      perInstance: false,
      label: 'Activate',
    });
    accepted();

    await pick(user, 'continuous condition');
    expect(only()).toMatchObject({
      continuous: true,
      modifier: null,
      replaces: null,
      activation: null,
    });
    accepted();

    await pick(user, 'trigger');
    expect(only()).toMatchObject({
      continuous: false,
      modifier: null,
      replaces: null,
      activation: null,
    });
    accepted();
  });

  it('disables the modifier mode, with the reason, when the game has no card index', async () => {
    await openEditor({ templates: [] });
    expect(screen.getByRole('radio', { name: /value modifier/ })).toBeDisabled();
    expect(screen.getByText('— no card indexes yet')).toBeInTheDocument();
  });

  it('drops the trigger select entirely for a continuous rule (§4.5 ignores it)', async () => {
    const { user } = await openEditor();
    expect(screen.getByRole('combobox', { name: 'Trigger' })).toBeInTheDocument();

    await pick(user, 'continuous condition');
    expect(screen.queryByRole('combobox', { name: 'Trigger' })).not.toBeInTheDocument();
    expect(screen.getByText(/whenever the condition below becomes true/)).toBeInTheDocument();

    await pick(user, 'trigger');
    expect(screen.getByRole('combobox', { name: 'Trigger' })).toBeInTheDocument();
  });

  describe('the modifier panel', () => {
    const openModifier = async (over: Partial<GameDefinition> = {}) => {
      const handle = await openEditor(over);
      await handle.user.click(screen.getByRole('radio', { name: 'value modifier' }));
      return handle;
    };

    it('edits scope, index, set-or-adjust, amount and active zones', async () => {
      const { user } = await openModifier();

      await user.click(screen.getByRole('button', { name: 'Which cards are modified' }));
      await user.click(screen.getByRole('radio', { name: 'Every card in a zone' }));
      expect(only().modifier).toMatchObject({ scope: { kind: 'allInZone' } });

      await user.selectOptions(screen.getByRole('combobox', { name: 'Index' }), 'idx2');
      expect(only().modifier).toMatchObject({ indexId: 'idx2' });

      await user.selectOptions(screen.getByRole('combobox', { name: 'Set or adjust' }), 'set');
      expect(only().modifier).toMatchObject({ op: 'set' });

      await user.click(screen.getByRole('button', { name: 'Amount' }));
      const amount = within(screen.getByRole('dialog', { name: 'Amount' }));
      await user.clear(amount.getByRole('spinbutton', { name: 'Value' }));
      await user.type(amount.getByRole('spinbutton', { name: 'Value' }), '3');
      expect(only().modifier).toMatchObject({ amount: { kind: 'literal', value: 3 } });

      await user.click(screen.getByRole('checkbox', { name: 'Deck' }));
      expect(only().modifier).toMatchObject({ activeZones: ['z1'] });
      await user.click(screen.getByRole('checkbox', { name: 'Hand' }));
      expect(only().modifier).toMatchObject({ activeZones: ['z1', 'z2'] });

      await user.click(screen.getByRole('checkbox', { name: 'Deck' }));
      expect(only().modifier).toMatchObject({ activeZones: ['z2'] });
      accepted();
    });

    it('does not call a modifier-only rule with no effects "nothing", and reads as English', async () => {
      // §5.4 — the whole rule IS the panel; gating the hint on `effects.length` alone told the
      // designer their working rule did nothing. Step 46 fixed the twin in `RulesProsePreview`.
      await openModifier();
      expect(only().effects).toEqual([]);
      expect(screen.queryByText(/this rule does nothing/)).not.toBeInTheDocument();
      expect(screen.getByText(/A modifier needs no effects/)).toBeInTheDocument();

      const prose = screen.getByRole('region', { name: 'Reads as' });
      expect(prose).not.toHaveTextContent(/Nothing yet/);
      expect(prose).toHaveTextContent(/Power is adjusted by 1/);
    });
  });

  describe('the replacement panel', () => {
    const openReplacement = async () => {
      const handle = await openEditor();
      await handle.user.click(screen.getByRole('radio', { name: 'replacement' }));
      return handle;
    };

    it('offers exactly §5.7’s five interceptable kinds and nothing else', async () => {
      await openReplacement();
      const options = within(screen.getByRole('combobox', { name: 'Replaced effect' })).getAllByRole(
        'option'
      );
      expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
        'drawCards',
        'changePool',
        'moveCards',
        'destroyCards',
        'setCardIndex',
      ]);
    });

    it('edits the kind and the match tree', async () => {
      const { user } = await openReplacement();

      await user.selectOptions(
        screen.getByRole('combobox', { name: 'Replaced effect' }),
        'destroyCards'
      );
      expect(only().replaces).toMatchObject({ effectKind: 'destroyCards' });

      const match = within(screen.getByRole('group', { name: 'where' }));
      await user.click(match.getByRole('button', { name: '+ condition' }));
      expect(only().replaces?.match).toEqual({
        kind: 'group',
        combinator: 'and',
        children: [
          {
            kind: 'criteria',
            left: { kind: 'literal', value: 0 },
            op: '=',
            right: { kind: 'literal', value: 0 },
          },
        ],
      });
      accepted();
    });

    it('binds replacedAmount and replacedTarget inside the match tree and nowhere else', async () => {
      const { user } = await openReplacement();

      // Inside: the match tree is the one place either ref means anything (§5.7).
      const match = within(screen.getByRole('group', { name: 'where' }));
      await user.click(match.getByRole('button', { name: '+ condition' }));
      await user.click(match.getByRole('button', { name: 'Left side' }));
      const left = within(screen.getByRole('dialog', { name: 'Left side' }));
      expect(left.getByRole('radio', { name: 'The replaced amount' })).toBeEnabled();

      // The replaced TARGET is a CardRef, so it is reachable through any value that carries a card.
      await user.click(left.getByRole('radio', { name: 'A card index' }));
      await user.click(match.getByRole('button', { name: 'Card' }));
      const card = within(screen.getByRole('dialog', { name: 'Card' }));
      await user.click(card.getByRole('radio', { name: 'The replaced target' }));
      expect(only().replaces?.match).toMatchObject({
        children: [{ left: { kind: 'cardIndex', card: { kind: 'replacedTarget' } } }],
      });
      accepted();

      // Outside: the rule's own IF tree, disabled with the reason rather than silently missing.
      const iff = within(screen.getByRole('region', { name: 'If' }));
      await user.click(iff.getByRole('button', { name: /add a condition/i }));
      await user.click(iff.getByRole('button', { name: '+ condition' }));
      await user.click(iff.getByRole('button', { name: 'Left side' }));
      const outside = within(iff.getByRole('dialog', { name: 'Left side' }));
      expect(outside.getByRole('radio', { name: /The replaced amount/ })).toBeDisabled();
      expect(outside.getByText('— only inside a replacement rule')).toBeInTheDocument();

      await user.click(outside.getByRole('radio', { name: 'A card index' }));
      await user.click(iff.getByRole('button', { name: 'Card' }));
      const outsideCard = within(iff.getByRole('dialog', { name: 'Card' }));
      expect(outsideCard.getByRole('radio', { name: /The replaced target/ })).toBeDisabled();
    });
  });

  describe('the activation panel', () => {
    const openActivation = async (over: Partial<GameDefinition> = {}) => {
      const handle = await openEditor(over);
      await handle.user.click(screen.getByRole('radio', { name: 'activation' }));
      return handle;
    };

    it('edits the label, the window, per-instance and the cost check', async () => {
      const { user } = await openActivation();

      await user.clear(screen.getByRole('textbox', { name: 'Button label' }));
      await user.type(screen.getByRole('textbox', { name: 'Button label' }), 'Tap: draw');
      expect(only().activation).toMatchObject({ label: 'Tap: draw' });

      await user.selectOptions(screen.getByRole('combobox', { name: 'Priority window' }), 'w1');
      expect(only().activation).toMatchObject({ window: 'w1' });
      await user.selectOptions(screen.getByRole('combobox', { name: 'Priority window' }), '');
      expect(only().activation).toMatchObject({ window: null });

      await user.click(screen.getByRole('checkbox', { name: /a button on each card/i }));
      expect(only().activation).toMatchObject({ perInstance: true });

      const check = within(screen.getByRole('group', { name: 'Cost check' }));
      await user.click(check.getByRole('button', { name: '+ condition' }));
      expect(only().activation?.costCheck).toMatchObject({ kind: 'group', combinator: 'and' });
      accepted();
    });

    it('shows no window to choose, disabled with the reason, when the game has none', async () => {
      await openActivation({ priorityWindows: [] });

      const select = screen.getByRole('combobox', { name: 'Priority window' });
      expect(select).toBeDisabled();
      expect(within(select).queryAllByRole('option')).toHaveLength(0);
      expect(screen.getByText(/no priority windows yet/)).toBeInTheDocument();
    });

    it('builds the cost out of the shared effect list — add, reorder, remove', async () => {
      const { user } = await openActivation();

      await user.click(screen.getByRole('button', { name: 'Add a cost effect' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Destroy' }));
      await user.click(screen.getByRole('button', { name: 'Add a cost effect' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Shuffle' }));

      expect(only().activation?.cost.map((e) => e.kind)).toEqual(['destroyCards', 'shuffleZone']);
      // The rule's own effects are a different list on the same screen and must not have moved.
      expect(only().effects).toEqual([]);
      accepted();

      const cost = within(screen.getByRole('list', { name: 'Cost' }));
      await user.click(cost.getByRole('button', { name: 'Move effect 1 down' }));
      expect(only().activation?.cost.map((e) => e.kind)).toEqual(['shuffleZone', 'destroyCards']);

      await user.click(cost.getByRole('button', { name: 'Remove effect 2' }));
      expect(only().activation?.cost.map((e) => e.kind)).toEqual(['shuffleZone']);
      accepted();
    });

    it('refuses a cost effect that can suspend — the draft could then never be discarded (§5.8)', async () => {
      // ponytail: the shared `EffectList`/`EffectPicker` offer every kind (their contract has no
      // filter and step 45 does not own them), so this boundary is held by the store's refinement
      // and reported, not prevented. Filter the picker when `EffectPicker` is next opened.
      const { user } = await openActivation();

      await user.click(screen.getByRole('button', { name: 'Add a cost effect' }));
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Choose a number' })
      );

      expect(only().activation?.cost).toEqual([]);
      expect(screen.getByRole('alert')).toHaveTextContent(/may suspend/);
    });
  });
});

describe('effect and target defaults', () => {
  const withZone: GameDefinition = {
    ...createEmptyDefinition('g', 'g', '2026-01-01T00:00:00.000Z'),
    zones: [zone('z1', 'Deck')],
  };
  const bare = createEmptyDefinition('g', 'g', '2026-01-01T00:00:00.000Z');

  it('returns null rather than a dangling reference when nothing exists to point at', () => {
    expect(defaultEffect('drawCards', bare)).toBeNull();
    expect(defaultEffect('changePool', bare)).toBeNull();
    expect(defaultSelector('topOfZone', bare)).toBeNull();
    expect(missingFor('drawCards', bare)).toBe('needs a zone');
  });

  it('always has a state to transition to, because Start and End are reserved', () => {
    expect(defaultEffect('forceTransition', bare)).toEqual({ kind: 'forceTransition', toStateId: 'end' });
  });

  it('wraps the selector already chosen when the designer switches to a prompt', () => {
    const from = defaultSelector('allInZone', withZone);
    expect(defaultSelector('prompt', withZone, from!)).toMatchObject({ kind: 'prompt', from });
  });
});
