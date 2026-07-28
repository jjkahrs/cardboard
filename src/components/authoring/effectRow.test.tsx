/**
 * Step 42 — the eleven effect kinds §4.5 added, and §6.11's third recursion.
 *
 * Driven through `EffectList` rather than through `EffectRow` directly, because the list IS the
 * seam: it is what `RuleSetEditor` writes to the store, what a `chooseMode` mode holds, and what
 * `activation.cost` will hold. Every assertion is on the `Effect[]` handed back, not on the DOM —
 * the same discipline `selectorChips.test.tsx` gives its reasons for.
 *
 * The picker tests additionally run each new default through `EffectSchema`: "selectable" is only
 * half the claim, "and what it authors validates" is the other half.
 */

import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EffectSchema } from '../../engine/schema';
import type { CriteriaNode, Effect, GameDefinition, PriorityWindow } from '../../engine/types';
import { empty } from '../../test/fixtures/empty';
import { RS_CANTRIP, RS_STRIKE, duel } from '../../test/fixtures/duel';
import { EffectList } from './EffectList';

const WINDOW: PriorityWindow = {
  id: 'pw1',
  name: 'Response',
  start: 'active',
  direction: 'forward',
  includeStart: true,
  passesToClose: null,
  collapseEmptyOffers: true,
};

/** `duel` plus the one entity it lacks — a window for `openPriority` / `announceAction` to name. */
const game: GameDefinition = { ...duel, priorityWindows: [WINDOW] };

const TRIGGERING = { kind: 'triggeringCard' } as const;
const ONE = { kind: 'literal', value: 1 } as const;
const EMPTY_GROUP: CriteriaNode = { kind: 'group', combinator: 'and', children: [] };

function LiveList({
  initial = [],
  definition = game,
  ruleId,
  onChange,
}: {
  initial?: Effect[];
  definition?: GameDefinition;
  ruleId?: string;
  onChange?: (effects: Effect[]) => void;
}) {
  const [effects, setEffects] = useState<Effect[]>(initial);
  return (
    <EffectList
      effects={effects}
      definition={definition}
      ruleId={ruleId}
      onChange={(next) => {
        setEffects(next);
        onChange?.(next);
      }}
    />
  );
}

const setup = (props: Parameters<typeof LiveList>[0] = {}) => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<LiveList {...props} onChange={onChange} />);
  return { user, onChange, last: () => onChange.mock.lastCall![0] as Effect[] };
};

const add = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  await user.click(screen.getByRole('button', { name: 'Add an effect' }));
  await user.click(screen.getByRole('button', { name: label }));
};

// ---------------------------------------------------------------------------
// (a) every new kind is offered, and authors something the schema accepts
// ---------------------------------------------------------------------------

const NEW_KINDS: [string, Effect][] = [
  ['Tag', { kind: 'setTag', target: TRIGGERING, tag: '', on: true }],
  ['Attach', { kind: 'attach', target: TRIGGERING, host: { kind: 'triggering' } }],
  ['Detach', { kind: 'detach', target: TRIGGERING }],
  ['Change control', { kind: 'setController', target: TRIGGERING, seat: { kind: 'active' } }],
  ['Eliminate a player', { kind: 'eliminateSeat', seat: { kind: 'active' } }],
  ['Announce an action', { kind: 'announceAction', ruleId: RS_STRIKE, window: null }],
  ['Counter an action', { kind: 'counterAction', action: { kind: 'action', ref: { kind: 'topOfStack' } } }],
  ['Open a priority window', { kind: 'openPriority', window: WINDOW.id }],
  ['Choose a mode', { kind: 'chooseMode', promptText: '', seat: { kind: 'active' }, modes: [] }],
  [
    'Choose a number',
    { kind: 'chooseNumber', promptText: '', seat: { kind: 'active' }, min: ONE, max: ONE, key: '' },
  ],
  ['Sealed choice', { kind: 'sealedChoice', choiceId: '', seats: { kind: 'all' }, options: [] }],
];

describe('the eleven kinds §4.5 added (§6.10)', () => {
  it('offers exactly eleven more than v1 did', () => {
    expect(NEW_KINDS).toHaveLength(11);
  });

  it.each(NEW_KINDS)('adds %s from the picker, and the schema accepts it', async (label, expected) => {
    const { user, onChange } = setup();
    await add(user, label);

    expect(onChange).toHaveBeenLastCalledWith([expected]);
    expect(EffectSchema.safeParse(expected).success).toBe(true);
  });

  it.each(NEW_KINDS)('renders %s as a row that can be switched away and back', async (_label, expected) => {
    const { user, last } = setup({ initial: [expected] });

    const kind = screen.getByRole('combobox', { name: 'Effect 1 kind' });
    await user.selectOptions(kind, 'destroyCards');
    expect(last()[0].kind).toBe('destroyCards');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Effect 1 kind' }), expected.kind);
    expect(last()[0].kind).toBe(expected.kind);
  });
});

// ---------------------------------------------------------------------------
// (a) the newly-nullable kinds, disabled with the reason rather than dangling
// ---------------------------------------------------------------------------

describe('the kinds a bare definition has nothing to point at', () => {
  it.each([
    ['Open a priority window', 'needs a priority window'],
    ['Announce an action', 'needs a rule to announce'],
  ])('disables %s and says %s', async (label, reason) => {
    const user = userEvent.setup();
    render(<EffectList effects={[]} definition={empty} onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Add an effect' }));
    const picker = within(screen.getByRole('dialog'));
    expect(picker.getByRole('button', { name: label })).toBeDisabled();
    expect(picker.getByText(reason)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// (a) the rows themselves
// ---------------------------------------------------------------------------

describe('the new effect rows', () => {
  it('setTag — target, on/off, and the tag itself', async () => {
    const { user, last } = setup({
      initial: [{ kind: 'setTag', target: TRIGGERING, tag: '', on: true }],
    });

    await user.type(screen.getByRole('textbox', { name: 'Tag' }), 'summoned');
    expect(last()[0]).toMatchObject({ tag: 'summoned', on: true });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Add or remove' }), 'off');
    expect(last()[0]).toEqual({ kind: 'setTag', target: TRIGGERING, tag: 'summoned', on: false });
  });

  it('attach — the host is a CardRef, not a zone (§4.3)', async () => {
    const { user, last } = setup({
      initial: [{ kind: 'attach', target: TRIGGERING, host: { kind: 'triggering' } }],
    });

    await user.click(screen.getByRole('button', { name: 'Attach to' }));
    await user.click(screen.getByRole('radio', { name: /the card this is attached to/i }));
    expect(last()[0]).toEqual({ kind: 'attach', target: TRIGGERING, host: { kind: 'host' } });
  });

  it('detach — a target chip and nothing else', async () => {
    const { user, last } = setup({ initial: [{ kind: 'detach', target: TRIGGERING }] });

    await user.click(screen.getByRole('button', { name: 'Which cards' }));
    await user.click(screen.getByRole('radio', { name: /cards the player chooses/i }));
    expect(last()[0]).toMatchObject({ kind: 'detach', target: { kind: 'prompt' } });
  });

  it('setController — a seat, or no explicit controller at all, and back (§4.3)', async () => {
    const { user, last } = setup({
      initial: [{ kind: 'setController', target: TRIGGERING, seat: { kind: 'active' } }],
    });

    expect(screen.getByRole('button', { name: 'Controller' })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /no explicit controller/i }));
    expect(last()[0]).toEqual({ kind: 'setController', target: TRIGGERING, seat: null });
    // The chip goes with it: there is no seat left to edit.
    expect(screen.queryByRole('button', { name: 'Controller' })).toBeNull();

    await user.click(screen.getByRole('radio', { name: /a player/i }));
    expect(last()[0]).toEqual({
      kind: 'setController',
      target: TRIGGERING,
      seat: { kind: 'active' },
    });

    await user.click(screen.getByRole('button', { name: 'Controller' }));
    await user.click(screen.getByRole('radio', { name: /the next player/i }));
    expect(last()[0]).toMatchObject({ seat: { kind: 'next' } });
  });

  it('eliminateSeat — a seat chip and nothing else (§5.12)', async () => {
    const { user, last } = setup({ initial: [{ kind: 'eliminateSeat', seat: { kind: 'active' } }] });

    await user.click(screen.getByRole('button', { name: 'Which player' }));
    await user.click(screen.getByRole('radio', { name: /a specific seat/i }));
    expect(last()[0]).toEqual({ kind: 'eliminateSeat', seat: { kind: 'seat', index: 0 } });
  });

  it('openPriority — one window select, and it says when the window is gone', async () => {
    const { user, last } = setup({ initial: [{ kind: 'openPriority', window: 'pw_gone' }] });

    expect(screen.getByText(/this window was deleted/i)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Priority window' }), WINDOW.id);
    expect(last()[0]).toEqual({ kind: 'openPriority', window: WINDOW.id });
    expect(screen.queryByText(/this window was deleted/i)).toBeNull();
  });

  it('announceAction — a rule and an optional window (§4.8)', async () => {
    const { user, last } = setup({
      initial: [{ kind: 'announceAction', ruleId: RS_STRIKE, window: null }],
    });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Priority window' }), WINDOW.id);
    expect(last()[0]).toEqual({ kind: 'announceAction', ruleId: RS_STRIKE, window: WINDOW.id });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Rule' }), RS_CANTRIP);
    expect(last()[0]).toMatchObject({ ruleId: RS_CANTRIP });

    // `null` is authorable: an ability nobody may respond to.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Priority window' }), '');
    expect(last()[0]).toMatchObject({ window: null });
  });

  it('chooseNumber — who, what it asks, the bounds, and the key it is remembered under', async () => {
    const { user, last } = setup({
      initial: [
        { kind: 'chooseNumber', promptText: '', seat: { kind: 'active' }, min: ONE, max: ONE, key: '' },
      ],
    });

    await user.type(screen.getByRole('textbox', { name: 'Prompt text' }), 'How many?');
    await user.type(screen.getByRole('textbox', { name: 'Answer key' }), 'x');
    expect(last()[0]).toMatchObject({ promptText: 'How many?', key: 'x' });

    await user.click(screen.getByRole('button', { name: 'Highest' }));
    await user.click(screen.getByRole('radio', { name: /players still in the game/i }));
    expect(last()[0]).toMatchObject({ max: { kind: 'activeSeatCount' } });

    await user.click(screen.getByRole('button', { name: 'Who chooses' }));
    await user.click(screen.getByRole('radio', { name: /the player who played this/i }));
    expect(last()[0]).toMatchObject({ seat: { kind: 'triggeringSeat' } });
  });

  it('counterAction — the ActionSelectorSubRow renders below the row, not in the popover', async () => {
    const { user, last } = setup({
      initial: [{ kind: 'counterAction', action: { kind: 'allOnStack', where: EMPTY_GROUP } }],
    });

    // Below the row: inside the same <li>, with every popover shut.
    const row = screen.getByRole('listitem');
    const region = within(row).getByRole('group', { name: 'where' });
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(within(region).getByRole('button', { name: '+ condition' }));
    expect(last()[0]).toMatchObject({
      kind: 'counterAction',
      action: { kind: 'allOnStack', where: { children: [expect.objectContaining({ op: '=' })] } },
    });
  });

  it('counterAction — no expanded region when there is nothing to expand', () => {
    setup({ initial: [{ kind: 'counterAction', action: { kind: 'action', ref: { kind: 'topOfStack' } } }] });
    expect(screen.queryByRole('group', { name: 'where' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (a) sealedChoice's repeatable option list
// ---------------------------------------------------------------------------

describe('sealedChoice — the option list (§5.11)', () => {
  const sealed = (options: { id: string; label: string }[]): Effect => ({
    kind: 'sealedChoice',
    choiceId: 'bid',
    seats: { kind: 'all' },
    options,
  });

  it('adds, edits, reorders and removes options on the same ▲▼✕ trio', async () => {
    const { user, last } = setup({
      initial: [sealed([{ id: 'a', label: 'Attack' }, { id: 'b', label: 'Block' }])],
    });

    await user.click(screen.getByRole('button', { name: '+ option' }));
    expect(last()[0]).toMatchObject({ options: [{ id: 'a' }, { id: 'b' }, { id: '', label: '' }] });

    await user.type(screen.getByRole('textbox', { name: 'Option 3 id' }), 'c');
    await user.type(screen.getByRole('textbox', { name: 'Option 3 label' }), 'Dodge');
    expect(last()[0]).toMatchObject({ options: [{ id: 'a' }, { id: 'b' }, { id: 'c', label: 'Dodge' }] });

    await user.click(screen.getByRole('button', { name: 'Move option 3 up' }));
    expect(last()[0]).toMatchObject({ options: [{ id: 'a' }, { id: 'c' }, { id: 'b' }] });

    await user.click(screen.getByRole('button', { name: 'Move option 1 down' }));
    expect(last()[0]).toMatchObject({ options: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] });

    await user.click(screen.getByRole('button', { name: 'Remove option 2' }));
    expect(last()[0]).toMatchObject({ options: [{ id: 'c' }, { id: 'b' }] });
  });

  it('cannot move the first option up or the last one down', () => {
    setup({ initial: [sealed([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }])] });
    expect(screen.getByRole('button', { name: 'Move option 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move option 2 down' })).toBeDisabled();
  });

  it('names the seats and the key the answers are remembered under', async () => {
    const { user, last } = setup({ initial: [sealed([])] });

    await user.clear(screen.getByRole('textbox', { name: 'Choice key' }));
    expect(screen.getByText(/name the choice/i)).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Choice key' }), 'vote');
    await user.click(screen.getByRole('button', { name: 'Who chooses' }));
    await user.click(screen.getByRole('radio', { name: /^any player$/i }));
    expect(last()[0]).toMatchObject({ choiceId: 'vote', seats: { kind: 'all', quantifier: 'some' } });
  });
});

// ---------------------------------------------------------------------------
// (b) Recursion 3
// ---------------------------------------------------------------------------

describe('chooseMode — the nested effect list (§6.11 recursion 3)', () => {
  const chooseMode = (modes: { label: string; effects: Effect[] }[]): Effect => ({
    kind: 'chooseMode',
    promptText: 'Choose one —',
    seat: { kind: 'active' },
    modes,
  });

  it('adds a mode, labels it, and removes it again', async () => {
    const { user, last } = setup({ initial: [chooseMode([])] });

    await user.click(screen.getByRole('button', { name: '+ mode' }));
    expect(last()[0]).toMatchObject({ modes: [{ label: '', effects: [] }] });

    await user.type(screen.getByRole('textbox', { name: 'Mode 1 label' }), 'Deal 3 damage');
    expect(last()[0]).toMatchObject({ modes: [{ label: 'Deal 3 damage' }] });

    await user.click(screen.getByRole('button', { name: 'Remove mode 1' }));
    expect(last()[0]).toMatchObject({ modes: [] });
  });

  it('adds effects INSIDE a mode, not beside it', async () => {
    const { user, last } = setup({ initial: [chooseMode([{ label: 'Draw', effects: [] }])] });

    await user.click(screen.getByRole('button', { name: 'Add an effect to mode 1' }));
    await user.click(screen.getByRole('button', { name: 'Destroy' }));

    expect(last()).toEqual([
      chooseMode([{ label: 'Draw', effects: [{ kind: 'destroyCards', target: TRIGGERING }] }]),
    ]);
    // One effect in the outer list still — the mode swallowed it.
    expect(last()).toHaveLength(1);
    expect(within(screen.getByRole('list', { name: 'Effects for mode 1' })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('refuses a chooseMode inside a chooseMode, with the reason (§6.11)', async () => {
    const { user } = setup({
      initial: [
        chooseMode([
          { label: 'Draw', effects: [{ kind: 'destroyCards', target: TRIGGERING }] },
        ]),
      ],
    });

    await user.click(screen.getByRole('button', { name: 'Add an effect to mode 1' }));
    const picker = within(screen.getByRole('dialog'));
    expect(picker.getByRole('button', { name: 'Choose a mode' })).toBeDisabled();
    expect(picker.getByText('author it as a second rule instead')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // ...and the row already inside the mode cannot switch itself into one either.
    const inner = within(screen.getByRole('list', { name: 'Effects for mode 1' }));
    expect(
      within(inner.getByRole('combobox', { name: 'Effect 1 kind' })).getByRole('option', {
        name: /choose a mode/i,
      })
    ).toHaveTextContent('author it as a second rule instead');
  });

  it('keeps the outer list editable while a mode holds its own', async () => {
    const { user, last } = setup({
      initial: [
        { kind: 'shuffleZone', zone: { zoneId: duel.zones[0].id, seat: { kind: 'active' } } },
        chooseMode([{ label: 'Draw', effects: [{ kind: 'destroyCards', target: TRIGGERING }] }]),
      ],
    });

    // The two <ol>s carry different accessible names, which is how a screen reader tells the mode's
    // "effect 1" from the rule's. The buttons themselves are scoped by the list they sit in.
    expect(screen.getByRole('list', { name: 'Effects for mode 1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Move effect 2 up' }));
    expect(last().map((e) => e.kind)).toEqual(['chooseMode', 'shuffleZone']);
  });
});

// ---------------------------------------------------------------------------
// (c) the widened ⏸
// ---------------------------------------------------------------------------

describe('the ⏸ marker (§6.11)', () => {
  const PAUSING: [string, Effect][] = [
    ['chooseMode', { kind: 'chooseMode', promptText: '', seat: { kind: 'active' }, modes: [] }],
    [
      'chooseNumber',
      { kind: 'chooseNumber', promptText: '', seat: { kind: 'active' }, min: ONE, max: ONE, key: 'k' },
    ],
    ['sealedChoice', { kind: 'sealedChoice', choiceId: 'c', seats: { kind: 'all' }, options: [] }],
    ['openPriority', { kind: 'openPriority', window: WINDOW.id }],
    [
      'a prompting target',
      {
        kind: 'destroyCards',
        target: { kind: 'prompt', from: TRIGGERING, count: ONE, promptText: 'Pick' },
      },
    ],
    [
      'a prompt wrapped in a filter',
      {
        kind: 'destroyCards',
        target: {
          kind: 'matching',
          from: { kind: 'prompt', from: TRIGGERING, count: ONE, promptText: 'Pick' },
          where: EMPTY_GROUP,
        },
      },
    ],
  ];

  it.each(PAUSING)('marks %s', (_name, effect) => {
    setup({ initial: [effect] });
    expect(screen.getByText(/execution pauses here/)).toBeInTheDocument();
  });

  it('leaves an effect that cannot suspend unmarked', () => {
    setup({ initial: [{ kind: 'destroyCards', target: TRIGGERING }] });
    expect(screen.queryByText(/execution pauses here/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (a) the self-announcing rule
// ---------------------------------------------------------------------------

describe('announceAction — the first rule-to-rule reference (§6.10)', () => {
  it('warns when the rule announces itself, and stops once it names another', async () => {
    const { user } = setup({
      ruleId: RS_STRIKE,
      initial: [{ kind: 'announceAction', ruleId: RS_STRIKE, window: null }],
    });

    expect(screen.getByText(/this rule announces itself/i)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Rule' }), RS_CANTRIP);
    expect(screen.queryByText(/this rule announces itself/i)).toBeNull();
  });

  it('does not warn about a rule announcing a different one', () => {
    setup({
      ruleId: RS_STRIKE,
      initial: [{ kind: 'announceAction', ruleId: RS_CANTRIP, window: null }],
    });
    expect(screen.queryByText(/announces itself/i)).toBeNull();
  });

  it('says so when the announced rule was deleted', () => {
    setup({ initial: [{ kind: 'announceAction', ruleId: 'rs_gone', window: null }] });
    expect(screen.getByText(/this rule was deleted/i)).toBeInTheDocument();
  });
});
