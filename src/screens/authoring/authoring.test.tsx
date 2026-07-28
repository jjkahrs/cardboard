/**
 * Step 21 — the Pools, Zones and Events screens.
 *
 * These drive the real global store rather than a mock: the whole claim of these screens is that
 * every edit goes through `validateDefinition` and a rejected one changes nothing (A1, A2, P3), and
 * a stubbed store would prove the opposite of that — that the screens agree with a stub.
 */

import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { ValueRefPicker } from '../../components/criteria/ValueRefPicker';
import type { GameDefinition, PriorityWindow, RuleSet, ValueRef } from '../../engine/types';
import { createEmptyDefinition, useDefinitionStore } from '../../stores/definitionStore';
import { Rail } from '../AuthoringLayout';
import { bucketErrors } from '../surfaces';
import { EventsScreen } from './EventsScreen';
import { PoolsScreen } from './PoolsScreen';
import { PollOrderPreview, PriorityWindowsScreen } from './PriorityWindowsScreen';
import { ZonesScreen } from './ZonesScreen';
import { uniqueName } from './uniqueName';

const blank = (over: Partial<GameDefinition> = {}): GameDefinition => ({
  ...createEmptyDefinition('g1', 'Test game', '2026-01-01T00:00:00.000Z'),
  ...over,
});

const definition = () => useDefinitionStore.getState().definition;

beforeEach(() => {
  useDefinitionStore.getState().setDefinition(blank());
});

/** The list a screen renders, by its accessible name — never "the first list on the page". */
const rowsOf = (label: string) =>
  within(screen.getByRole('list', { name: label })).getAllByRole('listitem');

describe('<PoolsScreen>', () => {
  it('adds a pool, selects it, and never proposes a name it already used', async () => {
    const user = userEvent.setup();
    render(<PoolsScreen />);

    await user.click(screen.getByRole('button', { name: 'Add pool' }));
    expect(definition().pools).toHaveLength(1);
    // Selecting what you just made is the difference between "added" and "added, now find it".
    expect(screen.getByRole('heading', { name: 'New pool' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add pool' }));
    expect(definition().pools.map((p) => p.value.name)).toEqual(['New pool', 'New pool 2']);
  });

  it('renames through the store, so the name is stored where a ValueRef will read it', async () => {
    const user = userEvent.setup();
    render(<PoolsScreen />);
    await user.click(screen.getByRole('button', { name: 'Add pool' }));

    // Adding opens the new row's name field on its own — the placeholder name is the app's, not the
    // designer's, so it is the first thing waiting to be typed over.
    const input = screen.getByRole('textbox', { name: /rename new pool/i });
    await user.clear(input);
    await user.type(input, 'HP{Enter}');

    expect(definition().pools[0].value.name).toBe('HP');
  });

  it('edits scope, type and bounds, resetting the value when the type changes', async () => {
    const user = userEvent.setup();
    render(<PoolsScreen />);
    await user.click(screen.getByRole('button', { name: 'Add pool' }));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Scope' }), 'game');
    await user.type(screen.getByRole('spinbutton', { name: 'Starting value' }), '20');
    await user.type(screen.getByRole('spinbutton', { name: 'Minimum' }), '0');
    expect(definition().pools[0]).toMatchObject({
      scope: 'game',
      value: { type: 'integer', name: 'New pool', defaultValue: 20, min: 0, max: null },
    });

    // A bound means nothing on a flag and `defaultValue` cannot be both 20 and false, so the whole
    // value is rebuilt — keeping only the name.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'boolean');
    expect(definition().pools[0].value).toEqual({
      type: 'boolean',
      name: 'New pool',
      defaultValue: false,
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Starting value' }), 'true');
    expect(definition().pools[0].value).toMatchObject({ defaultValue: true });
  });

  it('shows the store’s rejection and keeps the definition it already had (AC: P3)', async () => {
    const user = userEvent.setup();
    render(<PoolsScreen />);
    await user.click(screen.getByRole('button', { name: 'Add pool' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Minimum' }), '5');

    const before = definition();
    await user.type(screen.getByRole('spinbutton', { name: 'Maximum' }), '1');

    expect(screen.getByRole('alert')).toHaveTextContent(/min \(5\) must be less than or equal/);
    // Referentially identical, not merely deep-equal: nothing was written and then reverted.
    expect(definition()).toBe(before);
    expect(definition().pools[0].value).toMatchObject({ min: 5, max: null });
  });

  it('refuses to delete a pool something still points at, and names the referrer', async () => {
    const rule: RuleSet = {
      id: 'rs1',
      name: 'Burn',
      trigger: 'onCardPlayed',
      stateFilter: null,
      condition: null,
      effects: [
        {
          kind: 'changePool',
          poolId: 'p1',
          seat: { kind: 'active' },
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
    useDefinitionStore.getState().setDefinition(
      blank({
        pools: [
          { id: 'p1', scope: 'player', value: { type: 'integer', name: 'HP', defaultValue: 20, min: 0, max: null } },
        ],
        ruleSets: [rule],
      })
    );
    const user = userEvent.setup();
    render(<PoolsScreen />);

    await user.click(within(rowsOf('Pools')[0]).getByRole('button', { name: 'Delete' }));

    expect(screen.getByText(/Used by Burn/)).toBeInTheDocument();
    expect(definition().pools).toHaveLength(1);
  });

  // AC: A1 — created on this screen, offered as a value everywhere. The picker is rendered from the
  // same store the screen writes, so nothing but the store carries the pool between them.
  it('makes a new pool selectable as a ValueRef (AC: A1)', async () => {
    const user = userEvent.setup();
    render(
      <>
        <PoolsScreen />
        <PickerHarness />
      </>
    );

    // Before the pool exists there is nothing to point at, so the option is disabled rather than
    // producing a dangling reference.
    await user.click(screen.getByRole('button', { name: 'Amount' }));
    expect(screen.getByRole('radio', { name: /a pool/i })).toBeDisabled();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Add pool' }));
    const input = screen.getByRole('textbox', { name: /rename new pool/i });
    await user.clear(input);
    await user.type(input, 'HP{Enter}');

    await user.click(screen.getByRole('button', { name: 'Amount' }));
    await user.click(screen.getByRole('radio', { name: /a pool/i }));

    const picked = screen.getByRole('combobox', { name: 'Pool' });
    expect(within(picked).getByRole('option', { name: 'HP' })).toBeInTheDocument();
    expect(picked).toHaveValue(definition().pools[0].id);
  });
});

/** A ValueRefPicker fed by the live store — the "selectable everywhere" half of A1. */
function PickerHarness() {
  const definition = useDefinitionStore((s) => s.definition);
  const [value, setValue] = useState<ValueRef>({ kind: 'literal', value: 0 });
  return (
    <ValueRefPicker value={value} onChange={setValue} definition={definition} ariaLabel="Amount" />
  );
}

describe('<ZonesScreen>', () => {
  const addZones = async (n: number) => {
    const user = userEvent.setup();
    render(<ZonesScreen />);
    for (let i = 0; i < n; i += 1) await user.click(screen.getByRole('button', { name: 'Add zone' }));
    return user;
  };

  it('adds zones with usable defaults', async () => {
    await addZones(1);
    expect(definition().zones[0]).toMatchObject({
      name: 'New zone',
      scope: 'player',
      visibility: 'faceUp',
      layout: 'stack',
      ordered: true,
      maxCapacity: null,
    });
  });

  // AC: A2 (UI half) — the store's rejection reaches the designer, and nothing moved.
  it('rejects a duplicate zone name, changing nothing (AC: A2)', async () => {
    const user = await addZones(2);
    expect(definition().zones.map((z) => z.name)).toEqual(['New zone', 'New zone 2']);

    const before = definition();
    // The second add left its own name field open.
    const input = screen.getByRole('textbox', { name: /rename new zone 2/i });
    await user.clear(input);
    await user.type(input, 'New zone{Enter}');

    // Twice on purpose: next to the field that caused it, and in the pane's rejection readout.
    expect(within(rowsOf('Zones')[1]).getByText(/Zone names must be unique/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Zone names must be unique/);
    expect(definition()).toBe(before);
    expect(definition().zones.map((z) => z.name)).toEqual(['New zone', 'New zone 2']);
    // Still editing, because a closed editor would read as "saved".
    expect(screen.getByRole('textbox', { name: /rename new zone 2/i })).toBeInTheDocument();
  });

  it('never proposes a name that would collide, so adding twice always works (AC: A2)', async () => {
    await addZones(3);
    expect(definition().zones.map((z) => z.name)).toEqual(['New zone', 'New zone 2', 'New zone 3']);
  });

  it('edits visibility, layout, ordering and capacity', async () => {
    const user = await addZones(1);
    await user.keyboard('{Escape}'); // Leave the name field the add opened; this test is about the row summary.

    await user.selectOptions(screen.getByRole('combobox', { name: 'Visibility' }), 'ownerOnly');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Layout' }), 'fan');
    await user.click(screen.getByRole('checkbox', { name: 'Ordered' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Maximum cards' }), '7');

    expect(definition().zones[0]).toMatchObject({
      visibility: 'ownerOnly',
      layout: 'fan',
      ordered: false,
      maxCapacity: 7,
    });
    expect(rowsOf('Zones')[0]).toHaveTextContent(/per player · owner only · fan · unordered · max 7/);
  });

  it('rejects a capacity of 0 and says why', async () => {
    // §9.4 item 15 — a zone that can hold nothing is a zone nobody can use.
    const user = await addZones(1);
    const before = definition();
    await user.type(screen.getByRole('spinbutton', { name: 'Maximum cards' }), '0');

    expect(screen.getByRole('alert')).toHaveTextContent(/maxCapacity/);
    expect(definition()).toBe(before);
  });
});

describe('<EventsScreen>', () => {
  const withRule = (trigger: string) =>
    blank({
      customEvents: ['onTurnStart'],
      ruleSets: [
        {
          id: 'rs1',
          name: 'Upkeep',
          trigger,
          stateFilter: null,
          condition: null,
          effects: [],
          priority: 0,
          onRejection: 'continue',
          modifier: null,
          continuous: false,
          replaces: null,
          activation: null,
        },
      ],
    });

  it('lists every built-in, read-only', () => {
    render(<EventsScreen />);
    const list = within(screen.getByRole('region', { name: 'Built-in events' }));
    expect(list.getAllByRole('listitem')).toHaveLength(9);
    expect(list.getByText('onCardPlayed')).toBeInTheDocument();
    // Read-only means read-only: no rename, no remove, on any of them.
    expect(list.queryByRole('button')).not.toBeInTheDocument();
    // §4.6 — deliberately absent, because the engine never fires them.
    expect(list.queryByText('onTurnStart')).not.toBeInTheDocument();
  });

  it('adds a custom event', async () => {
    const user = userEvent.setup();
    render(<EventsScreen />);

    await user.type(screen.getByRole('textbox', { name: 'New event' }), 'onTurnStart');
    await user.click(screen.getByRole('button', { name: 'Add event' }));

    expect(definition().customEvents).toEqual(['onTurnStart']);
    expect(within(screen.getByRole('list', { name: 'Custom events' })).getByText('onTurnStart')).toBeInTheDocument();
  });

  it.each([
    ['', /give the event a name/i],
    ['onCardPlayed', /built-in event/i],
  ])('refuses %j', async (name, message) => {
    const user = userEvent.setup();
    render(<EventsScreen />);
    if (name !== '') await user.type(screen.getByRole('textbox', { name: 'New event' }), name);
    await user.click(screen.getByRole('button', { name: 'Add event' }));

    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(definition().customEvents).toEqual([]);
  });

  it('refuses a name it already has', async () => {
    useDefinitionStore.getState().setDefinition(blank({ customEvents: ['onTurnStart'] }));
    const user = userEvent.setup();
    render(<EventsScreen />);

    await user.type(screen.getByRole('textbox', { name: 'New event' }), 'onTurnStart');
    await user.click(screen.getByRole('button', { name: 'Add event' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/already an event/i);
    expect(definition().customEvents).toEqual(['onTurnStart']);
  });

  it('counts who listens and who fires, for built-ins and custom names alike', () => {
    useDefinitionStore.getState().setDefinition(withRule('onTurnStart'));
    render(<EventsScreen />);

    expect(within(screen.getByRole('list', { name: 'Custom events' })).getByText('1 listening')).toBeInTheDocument();
    const builtins = within(screen.getByRole('region', { name: 'Built-in events' }));
    expect(builtins.getAllByText('0 listening')).toHaveLength(9);
  });

  it('names the rules that still listen before removing an event, then removes it', async () => {
    // Removal cannot dangle — a trigger is matched by string, so those rules simply stop firing —
    // which is precisely why this is a warning with the consequence spelled out, not a block.
    useDefinitionStore.getState().setDefinition(withRule('onTurnStart'));
    const user = userEvent.setup();
    render(<EventsScreen />);
    const row = within(screen.getByRole('list', { name: 'Custom events' })).getByRole('listitem');

    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(
      within(row).getByText(/Removing “onTurnStart” leaves 1 rule set \(Upkeep\)/)
    ).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Remove for good' }));
    expect(definition().customEvents).toEqual([]);
  });

  it('offers no rename, because renaming would strand every listener silently', () => {
    useDefinitionStore.getState().setDefinition(blank({ customEvents: ['onTurnStart'] }));
    render(<EventsScreen />);
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
  });
});

describe('uniqueName', () => {
  it('returns the base when it is free, then counts up past every taken variant', () => {
    expect(uniqueName([], 'New zone')).toBe('New zone');
    expect(uniqueName(['New zone'], 'New zone')).toBe('New zone 2');
    expect(uniqueName(['New zone', 'New zone 2', 'New zone 3'], 'New zone')).toBe('New zone 4');
    // A gap is not filled: the point is a free name, not the smallest free number.
    expect(uniqueName(['New zone', 'New zone 3'], 'New zone')).toBe('New zone 2');
  });
});

// ---------------------------------------------------------------------------
// Step 41 — Priority windows (§4.6, §6.9)
// ---------------------------------------------------------------------------

describe('<PriorityWindowsScreen>', () => {
  const addWindows = async (n: number) => {
    const user = userEvent.setup();
    render(<PriorityWindowsScreen />);
    for (let i = 0; i < n; i += 1)
      await user.click(screen.getByRole('button', { name: 'Add window' }));
    return user;
  };

  /** A rule set with only the field under test filled in. */
  const ruleWith = (over: Partial<RuleSet>): RuleSet => ({
    id: 'rs1',
    name: 'Block',
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

  const aWindow: PriorityWindow = {
    id: 'w1',
    name: 'Block window',
    start: 'active',
    direction: 'forward',
    includeStart: true,
    passesToClose: null,
    collapseEmptyOffers: true,
  };

  it('adds a window with §4.6 defaults, selects it, and never proposes a name twice', async () => {
    const user = await addWindows(1);
    expect(definition().priorityWindows[0]).toMatchObject({
      name: 'New window',
      start: 'active',
      direction: 'forward',
      includeStart: true,
      passesToClose: null,
      collapseEmptyOffers: true,
    });
    expect(screen.getByRole('heading', { name: 'New window' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add window' }));
    expect(definition().priorityWindows.map((w) => w.name)).toEqual(['New window', 'New window 2']);
  });

  it('renames through the store', async () => {
    const user = await addWindows(1);
    const input = screen.getByRole('textbox', { name: /rename new window/i });
    await user.clear(input);
    await user.type(input, 'MTG priority{Enter}');

    expect(definition().priorityWindows[0].name).toBe('MTG priority');
  });

  it('edits start, direction and includeStart, and summarises them in the row', async () => {
    const user = await addWindows(1);
    await user.keyboard('{Escape}'); // Leave the name field the add opened.

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Poll starts at' }),
      'triggeringSeat'
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Direction' }), 'backward');
    await user.click(screen.getByRole('checkbox', { name: 'Include the starting seat' }));

    expect(definition().priorityWindows[0]).toMatchObject({
      start: 'triggeringSeat',
      direction: 'backward',
      includeStart: false,
    });
    expect(rowsOf('Windows')[0]).toHaveTextContent(
      /from the triggering seat · backward · skips the start · closes on a full table pass/
    );
  });

  it('deletes a window nothing points at', async () => {
    const user = await addWindows(1);
    await user.keyboard('{Escape}');

    await user.click(within(rowsOf('Windows')[0]).getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete for good' }));

    expect(definition().priorityWindows).toEqual([]);
  });

  // §6.9's delete protection, over two of `walkRefs`' three reference sites.
  it.each([
    [
      'a rule’s activation window',
      ruleWith({
        activation: { costCheck: null, cost: [], window: 'w1', perInstance: false, label: 'Block' },
      }),
    ],
    ['an openPriority effect', ruleWith({ effects: [{ kind: 'openPriority', window: 'w1' }] })],
  ])('refuses to delete a window still used by %s, and names the referrer', async (_what, rule) => {
    useDefinitionStore
      .getState()
      .setDefinition(blank({ priorityWindows: [aWindow], ruleSets: [rule] }));
    const user = userEvent.setup();
    render(<PriorityWindowsScreen />);

    await user.click(within(rowsOf('Windows')[0]).getByRole('button', { name: 'Delete' }));

    expect(screen.getByText(/Used by Block/)).toBeInTheDocument();
    expect(definition().priorityWindows).toHaveLength(1);
  });

  // §6.9 — `passesToClose: null` is a checkbox, not a number field with a magic empty state.
  it('swaps the pass count for null, and writes null rather than 0 or ""', async () => {
    const user = await addWindows(1);
    await user.keyboard('{Escape}');

    const wholeTable = screen.getByRole('checkbox', { name: 'Poll the whole table instead' });
    expect(wholeTable).toBeChecked();
    expect(screen.queryByRole('spinbutton', { name: 'Consecutive passes to close' })).toBeNull();

    await user.click(wholeTable);
    expect(definition().priorityWindows[0].passesToClose).toBe(1);

    const count = screen.getByRole('spinbutton', { name: 'Consecutive passes to close' });
    await user.clear(count);
    await user.type(count, '3');
    expect(definition().priorityWindows[0].passesToClose).toBe(3);
    expect(rowsOf('Windows')[0]).toHaveTextContent(/closes after 3 passes/);

    await user.click(wholeTable);
    // Null, not 0 and not '': the number field is gone, so there is no empty state to mean it.
    expect(definition().priorityWindows[0].passesToClose).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: 'Consecutive passes to close' })).toBeNull();
  });

  it('shows collapseEmptyOffers as a checked, disabled checkbox that says why', async () => {
    await addWindows(1);
    const box = screen.getByRole('checkbox', { name: 'Skip seats with no legal response' });

    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    expect(screen.getByText(/Always on, and not editable/)).toBeInTheDocument();
    expect(screen.getByText(/auto-passes and writes no log entry/)).toBeInTheDocument();
  });
});

describe('<PollOrderPreview>', () => {
  const aWindow = (over: Partial<PriorityWindow> = {}): PriorityWindow => ({
    id: 'w1',
    name: 'Block window',
    start: 'active',
    direction: 'forward',
    includeStart: true,
    passesToClose: null,
    collapseEmptyOffers: true,
    ...over,
  });

  const order = () =>
    within(screen.getByRole('list', { name: 'Poll order' }))
      .getAllByRole('listitem')
      .map((li) => li.textContent);

  it('asks every seat from the start, forward', () => {
    render(<PollOrderPreview window={aWindow()} playerCount={4} />);
    expect(order()).toEqual(['P1 start · #1', '→ P2 · #2', '→ P3 · #3', '→ P4 · #4']);
  });

  it('shows the start seat as skipped when includeStart is false, without renumbering it', () => {
    render(<PollOrderPreview window={aWindow({ includeStart: false })} playerCount={4} />);
    expect(order()).toEqual(['P1 start · skipped', '→ P2 · #1', '→ P3 · #2', '→ P4 · #3']);
  });

  it('walks the ring the other way when the direction is backward', () => {
    render(<PollOrderPreview window={aWindow({ direction: 'backward' })} playerCount={4} />);
    expect(order()).toEqual(['P1 start · #1', '→ P4 · #2', '→ P3 · #3', '→ P2 · #4']);
  });

  // §6.9 — the limit is stated, not implied: the live order comes from `seatOrder` at run time.
  it('says out loud that it is a nominal table with nobody eliminated', () => {
    render(<PollOrderPreview window={aWindow()} playerCount={4} />);
    expect(screen.getByText(/nominal table of 4 seats with nobody eliminated/)).toBeInTheDocument();
    expect(screen.getByText(/the real poll is shorter/)).toBeInTheDocument();
  });
});

describe('the Priority rail surface', () => {
  it('carries the window count and buckets a priorityWindows error to itself, not the game', () => {
    expect(
      bucketErrors(['priorityWindows.0.passesToClose: Expected number, received string'])
    ).toEqual({ priority: ['priorityWindows.0.passesToClose: Expected number, received string'] });

    // The store REFUSES to hold an invalid definition, so the rail is driven directly here — same
    // reasoning as routing.test.tsx's badge test.
    render(
      <MemoryRouter>
        <Rail
          definition={blank({
            priorityWindows: [
              {
                id: 'w1',
                name: 'Block window',
                start: 'active',
                direction: 'forward',
                includeStart: true,
                passesToClose: null,
                collapseEmptyOffers: true,
              },
            ],
          })}
          errors={{ priority: ['priorityWindows.0.passesToClose: Expected number'] }}
        />
      </MemoryRouter>
    );

    const link = within(screen.getByRole('navigation', { name: 'Authoring' })).getByRole('link', {
      name: /Priority/,
    });
    expect(link).toHaveTextContent('1');
    // Colour is never the sole carrier: the badge is joined by a counted, visually-hidden note.
    expect(within(link).getByText('1 problem')).toBeInTheDocument();
  });
});
