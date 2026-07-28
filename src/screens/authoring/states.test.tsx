/**
 * Step 23 — the state machine canvas.
 */

import 'fake-indexeddb/auto';
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MachineState, StateMachine } from '../../engine/types';
import { machineWarnings } from '../../components/authoring/machineWarnings';
import { definition, openRoute, resetGames, seedGame } from '../../test/routeHarness';

const state = (over: Partial<MachineState> & { id: string; name: string }): MachineState => ({
  enterableFrom: [],
  exitableTo: [],
  entryCriteria: null,
  transitionLabel: null,
  priority: 0,
  position: { x: 0, y: 0 },
  ...over,
});

/** Start → Main → End, all edges written on both sides, as the editor writes them. */
const threeStates = (): StateMachine => ({
  startStateId: 'start',
  endStateId: 'end',
  states: [
    state({ id: 'start', name: 'Start', exitableTo: ['main'], position: { x: 0, y: 0 } }),
    state({
      id: 'main',
      name: 'Main',
      enterableFrom: ['start'],
      exitableTo: ['end'],
      transitionLabel: 'End turn',
      position: { x: 200, y: 0 },
    }),
    state({ id: 'end', name: 'End', enterableFrom: ['main'], position: { x: 400, y: 0 } }),
  ],
});

/**
 * jsdom's synthetic pointer events carry no coordinates, and a drag with no coordinates is not a
 * drag — so the event is built from MouseEvent, which does, with the pointerId added on top.
 */
const pointer = (type: string, node: Element, pointerId: number, clientX: number, clientY: number) => {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
  Object.assign(event, { pointerId });
  fireEvent(node, event);
};

const machine = () => definition().machine;
const named = (name: string) => machine().states.find((s) => s.name === name)!;

beforeEach(resetGames);

describe('the state machine screen (/states)', () => {
  it('draws a node per state and a line per legal transition', async () => {
    await seedGame({ machine: threeStates() });
    await openRoute('/game/g1/states');

    for (const name of ['Start', 'Main', 'End']) {
      expect(await screen.findByRole('button', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    // start→main and main→end. Edges are drawn from exitableTo only: a transition needs both
    // sides, so drawing enterableFrom too would double every line.
    expect(document.querySelectorAll('.cb-state-canvas__edges line')).toHaveLength(2);
  });

  it('adds a state, and warns that nothing can enter it yet', async () => {
    await seedGame({ machine: threeStates() });
    const { user } = await openRoute('/game/g1/states');

    await user.click(await screen.findByRole('button', { name: 'Add state' }));

    expect(machine().states).toHaveLength(4);
    const warnings = within(screen.getByRole('list', { name: 'Warnings' }));
    expect(warnings.getByText(/Nothing can enter “New state”/)).toBeInTheDocument();
  });

  it('writes both sides of a transition from one checkbox', async () => {
    // §4.8 — a one-sided edge is a schema error, and it is nearly always a designer ticking one box
    // and forgetting the mirror. The editor cannot express one.
    await seedGame({ machine: threeStates() });
    const { user } = await openRoute('/game/g1/states');

    await user.click(await screen.findByRole('button', { name: /^Start/ }));
    const goTo = within(screen.getByRole('group', { name: 'Can go to' }));
    await user.click(goTo.getByRole('checkbox', { name: 'End' }));

    expect(named('Start').exitableTo).toEqual(['main', 'end']);
    expect(named('End').enterableFrom).toEqual(['main', 'start']);

    await user.click(goTo.getByRole('checkbox', { name: 'End' }));
    expect(named('Start').exitableTo).toEqual(['main']);
    expect(named('End').enterableFrom).toEqual(['main']);
  });

  it('adds an inbound edge from the other direction too', async () => {
    await seedGame({ machine: threeStates() });
    const { user } = await openRoute('/game/g1/states');

    await user.click(await screen.findByRole('button', { name: /^End/ }));
    await user.click(
      within(screen.getByRole('group', { name: 'Can come from' })).getByRole('checkbox', {
        name: 'Start',
      })
    );

    expect(named('Start').exitableTo).toEqual(['main', 'end']);
    expect(named('End').enterableFrom).toEqual(['main', 'start']);
  });

  it('moves a node by dragging it, and by arrow key', async () => {
    await seedGame({ machine: threeStates() });
    const { user } = await openRoute('/game/g1/states');
    const node = await screen.findByRole('button', { name: /^Main/ });

    pointer('pointerdown', node, 1, 250, 30);
    pointer('pointermove', node, 1, 310, 95);
    pointer('pointerup', node, 1, 310, 95);
    expect(named('Main').position).toEqual({ x: 260, y: 65 });

    // A canvas reachable only by mouse is a canvas half the users cannot rearrange. (A real click
    // focuses the node on its own; a synthesised pointer sequence does not.)
    node.focus();
    await user.keyboard('{ArrowRight}');
    expect(named('Main').position).toEqual({ x: 268, y: 65 });

    // Clamped, so a node can never be dragged out of reach off the top-left.
    pointer('pointerdown', node, 2, 300, 100);
    pointer('pointermove', node, 2, -900, -900);
    pointer('pointerup', node, 2, -900, -900);
    expect(named('Main').position).toEqual({ x: 0, y: 0 });
  });

  it('switches a state between a button and automatic entry', async () => {
    await seedGame({ machine: threeStates() });
    const { user } = await openRoute('/game/g1/states');
    await user.click(await screen.findByRole('button', { name: /^Main/ }));

    const label = screen.getByRole('textbox', { name: /button text/i });
    await user.clear(label);
    await user.type(label, 'Go');
    expect(named('Main').transitionLabel).toBe('Go');

    await user.click(screen.getByRole('button', { name: /enter automatically instead/i }));
    expect(named('Main').entryCriteria).toEqual({ kind: 'group', combinator: 'and', children: [] });

    await user.click(screen.getByRole('button', { name: /remove this all of group/i }));
    expect(named('Main').entryCriteria).toBeNull();
    expect(named('Main').transitionLabel).toBe('Continue');
  });

  it('edits the tiebreak priority', async () => {
    await seedGame({ machine: threeStates() });
    const { user } = await openRoute('/game/g1/states');
    await user.click(await screen.findByRole('button', { name: /^Main/ }));

    const priority = screen.getByRole('spinbutton', { name: 'Priority' });
    await user.clear(priority);
    await user.type(priority, '10');

    expect(named('Main').priority).toBe(10);
  });

  it('will not delete Start or End, and says why', async () => {
    await seedGame({ machine: threeStates() });
    const { user } = await openRoute('/game/g1/states');

    await user.click(await screen.findByRole('button', { name: /^Start/ }));
    expect(screen.getByText(/Start and End are part of every game/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete this state/i })).not.toBeInTheDocument();
  });

  it('refuses to delete a state its neighbours still point at', async () => {
    await seedGame({ machine: threeStates() });
    const { user } = await openRoute('/game/g1/states');

    await user.click(await screen.findByRole('button', { name: /^Main/ }));
    expect(screen.getByRole('button', { name: /in use by 2 place/i })).toBeDisabled();
    expect(machine().states).toHaveLength(3);
  });

  it('deletes a state once nothing points at it', async () => {
    await seedGame({ machine: threeStates() });
    const { user } = await openRoute('/game/g1/states');

    await user.click(await screen.findByRole('button', { name: 'Add state' }));
    await user.click(screen.getByRole('button', { name: /delete this state/i }));

    expect(machine().states).toHaveLength(3);
  });
});

describe('machineWarnings (§5.6)', () => {
  it('is quiet on a machine that can actually be played', () => {
    expect(machineWarnings(threeStates())).toEqual([]);
  });

  it('warns when End cannot be reached from Start', () => {
    const broken: StateMachine = {
      startStateId: 'start',
      endStateId: 'end',
      states: [
        state({ id: 'start', name: 'Start' }),
        state({ id: 'end', name: 'End', enterableFrom: ['main'] }),
        state({ id: 'main', name: 'Main', exitableTo: ['end'] }),
      ],
    };
    expect(machineWarnings(broken)[0]).toMatch(/End cannot be reached from Start/);
  });

  it('warns about a state nothing enters, and separately about one cut off from Start', () => {
    const orphan = machineWarnings({
      ...threeStates(),
      states: [...threeStates().states, state({ id: 'x', name: 'Limbo' })],
    });
    expect(orphan).toEqual(['Nothing can enter “Limbo” — it has no inbound transition.']);

    const island = machineWarnings({
      ...threeStates(),
      states: [
        ...threeStates().states,
        state({ id: 'a', name: 'Island A', enterableFrom: ['b'], exitableTo: ['b'] }),
        state({ id: 'b', name: 'Island B', enterableFrom: ['a'], exitableTo: ['a'] }),
      ],
    });
    // Both sides of the island are legal edges; they are simply unreachable, which is a different
    // mistake from "nothing points at it" and reads differently.
    expect(island).toEqual([
      '“Island A” cannot be reached from Start.',
      '“Island B” cannot be reached from Start.',
    ]);
  });
});
