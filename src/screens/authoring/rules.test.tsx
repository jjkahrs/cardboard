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
import type { CardTemplate, GameDefinition, PlayZone, RuleSet } from '../../engine/types';
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
