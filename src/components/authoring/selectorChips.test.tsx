/**
 * Step 43 — the two selector chips §4.4 could not be authored without: `TargetSelectorChip`'s three
 * new kinds (`attachedTo`, `hostOf`, `matching`) and the new `ActionSelectorChip`.
 *
 * The load-bearing assertion in here is a NEGATIVE one: §6.11 puts the criteria tree in an expanded
 * region below the effect row and explicitly NOT inside the chip popover, so every `matching` test
 * checks the popover does not contain it. A tree that quietly migrates back into the popover would
 * still "work" and would still be unreadable.
 *
 * Controlled components throughout, like `refChips.test.tsx`: the assertions are on what the chip
 * hands back through `onChange`, because the rule editor is what decides whether an edit is kept.
 */

import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  ActionSelector,
  CriteriaNode,
  GameDefinition,
  TargetSelector,
} from '../../engine/types';
import { BATTLEFIELD, POWER, duel } from '../../test/fixtures/duel';
import { ActionSelectorChip, ActionSelectorSubRow } from './ActionSelectorChip';
import { TargetSelectorChip, TargetSelectorSubRow } from './TargetSelectorChip';

const GONE = { zoneId: 'zone_gone', seat: null } as const;

const EMPTY_WHERE: CriteriaNode = { kind: 'group', combinator: 'and', children: [] };

const ALL_BATTLEFIELD: TargetSelector = {
  kind: 'allInZone',
  zone: { zoneId: BATTLEFIELD, seat: null },
};

/** The chip and its expanded region, wired the way `EffectRow` will wire them (§6.11's seam). */
function LiveTarget({
  initial,
  onChange,
  definition = duel,
}: {
  initial: TargetSelector;
  onChange?: (s: TargetSelector) => void;
  definition?: GameDefinition;
}) {
  const [selector, setSelector] = useState(initial);
  const set = (next: TargetSelector) => {
    setSelector(next);
    onChange?.(next);
  };
  return (
    <>
      <TargetSelectorChip
        selector={selector}
        definition={definition}
        ariaLabel="Which cards"
        onChange={set}
      />
      <TargetSelectorSubRow selector={selector} definition={definition} onChange={set} />
    </>
  );
}

function LiveAction({
  initial,
  onChange,
  definition = duel,
}: {
  initial: ActionSelector;
  onChange?: (s: ActionSelector) => void;
  definition?: GameDefinition;
}) {
  const [selector, setSelector] = useState(initial);
  const set = (next: ActionSelector) => {
    setSelector(next);
    onChange?.(next);
  };
  return (
    <>
      <ActionSelectorChip
        selector={selector}
        definition={definition}
        ariaLabel="Which actions"
        onChange={set}
      />
      <ActionSelectorSubRow selector={selector} definition={definition} onChange={set} />
    </>
  );
}

const chip = () => screen.getByRole('button', { name: 'Which cards' });
const openTarget = (user: ReturnType<typeof userEvent.setup>) => user.click(chip());

/**
 * The outermost "Which cards" fieldset. `prompt` and `matching` render another one for the selector
 * they wrap, so the rows are ambiguous by name alone once either is chosen.
 */
const outerKinds = () => within(screen.getAllByRole('group', { name: 'Which cards' })[0]);

describe('<TargetSelectorChip> — the attachment selectors (§4.4)', () => {
  it('authors attachedTo, and the CardRef it names', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveTarget initial={{ kind: 'triggeringCard' }} onChange={onChange} />);

    await openTarget(user);
    await user.click(screen.getByRole('radio', { name: /everything attached to a card/i }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'attachedTo', host: { kind: 'triggering' } });

    await user.click(screen.getByRole('button', { name: 'Host card' }));
    await user.click(screen.getByRole('radio', { name: /the top card of a zone/i }));
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'attachedTo',
      host: { kind: 'zoneTop', zone: expect.objectContaining({ zoneId: expect.any(String) }) },
    });
    expect(chip()).toHaveTextContent(/everything attached to the top card of/i);
  });

  it('authors hostOf, reading the relation in the other direction', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveTarget initial={{ kind: 'triggeringCard' }} onChange={onChange} />);

    await openTarget(user);
    await user.click(screen.getByRole('radio', { name: /the card another card is attached to/i }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'hostOf', card: { kind: 'triggering' } });

    await user.click(screen.getByRole('button', { name: 'Attached card' }));
    await user.click(screen.getByRole('radio', { name: /the card this is attached to/i }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'hostOf', card: { kind: 'host' } });
  });

  // Attachment is a REFERENCE, not a zone — but the CardRef it names can still carry a deleted one.
  it.each([
    ['attachedTo', { kind: 'attachedTo', host: { kind: 'zoneTop', zone: GONE } } as TargetSelector],
    ['hostOf', { kind: 'hostOf', card: { kind: 'zoneTop', zone: GONE } } as TargetSelector],
  ])('marks %s red when the card inside names a deleted zone', (_name, selector) => {
    render(<LiveTarget initial={selector} />);
    expect(chip()).toHaveAttribute('data-danger', '1');
  });
});

describe('<TargetSelectorChip> — matching (§6.11 recursion 1)', () => {
  it('authors matching, wrapping the selector already chosen', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveTarget initial={ALL_BATTLEFIELD} onChange={onChange} />);

    await openTarget(user);
    await user.click(screen.getByRole('radio', { name: /cards matching a filter/i }));

    // An empty AND is true, so a half-built filter never silently drops every candidate.
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'matching',
      from: ALL_BATTLEFIELD,
      where: EMPTY_WHERE,
    });
  });

  it('edits the where tree BELOW the row, never inside the popover', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LiveTarget
        initial={{ kind: 'matching', from: ALL_BATTLEFIELD, where: EMPTY_WHERE }}
        onChange={onChange}
      />
    );

    // The region is present with the popover shut: it is a sub-row, not a disclosure of the chip.
    const region = screen.getByRole('group', { name: 'where' });
    expect(region).toBeInTheDocument();

    await openTarget(user);
    const popover = screen.getByRole('dialog');
    expect(within(popover).queryByRole('group', { name: 'where' })).toBeNull();
    expect(within(popover).queryByRole('button', { name: '+ condition' })).toBeNull();
    // ...and the popover says where the conditions actually live.
    expect(within(popover).getByText(/edited below the rule/i)).toBeInTheDocument();

    await user.click(within(region).getByRole('button', { name: '+ condition' }));
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'matching',
      from: ALL_BATTLEFIELD,
      where: {
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
      },
    });
  });

  // §4.4 — `candidate` binds once per candidate inside `where` and NOWHERE else, so the row is
  // disabled with the reason outside it rather than hidden. Asserted through the real chain:
  // chip -> CriteriaGroupEditor -> ValueRefPicker -> CardRefChip.
  it('offers "the card under test" inside the where tree', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LiveTarget
        initial={{ kind: 'matching', from: ALL_BATTLEFIELD, where: EMPTY_WHERE }}
        onChange={onChange}
      />
    );

    const region = screen.getByRole('group', { name: 'where' });
    await user.click(within(region).getByRole('button', { name: '+ condition' }));
    await user.click(within(region).getByRole('button', { name: 'Left side' }));
    await user.click(screen.getByRole('radio', { name: /a card index/i }));
    await user.click(screen.getByRole('button', { name: 'Card' }));

    const candidate = screen.getByRole('radio', { name: /the card under test/i });
    expect(candidate).toBeEnabled();
    await user.click(candidate);

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'matching',
        where: expect.objectContaining({
          children: [
            expect.objectContaining({
              left: { kind: 'cardIndex', card: { kind: 'candidate' }, indexId: POWER },
            }),
          ],
        }),
      })
    );
  });

  it('disables "the card under test" with a reason outside a where tree', async () => {
    const user = userEvent.setup();
    render(
      <LiveTarget
        initial={{
          kind: 'topOfZone',
          zone: { zoneId: BATTLEFIELD, seat: null },
          count: { kind: 'literal', value: 1 },
        }}
      />
    );

    await openTarget(user);
    await user.click(screen.getByRole('button', { name: 'How many cards' }));
    await user.click(screen.getByRole('radio', { name: /a card index/i }));
    await user.click(screen.getByRole('button', { name: 'Card' }));

    expect(screen.getByRole('radio', { name: /the card under test/i })).toBeDisabled();
    expect(screen.getByText(/only inside a "cards matching…" filter/i)).toBeInTheDocument();
  });

  // §4.4 — "the two compose in either order", so both orders have to author.
  it('composes with prompt, matching wrapping prompt', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const prompt: TargetSelector = {
      kind: 'prompt',
      from: ALL_BATTLEFIELD,
      count: { kind: 'literal', value: 1 },
      promptText: 'Choose a card',
    };
    render(<LiveTarget initial={prompt} onChange={onChange} />);

    await openTarget(user);
    await user.click(outerKinds().getByRole('radio', { name: /cards matching a filter/i }));

    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'matching',
      from: prompt,
      where: EMPTY_WHERE,
    });
    expect(screen.getByRole('group', { name: 'where' })).toBeInTheDocument();
  });

  it('composes with prompt, prompt wrapping matching — and the region still finds it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const matching: TargetSelector = {
      kind: 'matching',
      from: ALL_BATTLEFIELD,
      where: EMPTY_WHERE,
    };
    render(<LiveTarget initial={matching} onChange={onChange} />);

    await openTarget(user);
    await user.click(outerKinds().getByRole('radio', { name: /cards the player chooses/i }));

    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'prompt',
      from: matching,
      count: { kind: 'literal', value: 1 },
      promptText: 'Choose a card',
    });

    // The `matching` is now one level down the `from` spine; its tree still has to be editable.
    const region = screen.getByRole('group', { name: 'where' });
    await user.click(within(region).getByRole('button', { name: '+ group' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'prompt',
        from: expect.objectContaining({
          kind: 'matching',
          where: expect.objectContaining({ children: [EMPTY_WHERE] }),
        }),
      })
    );
  });

  // An editor restriction, not a schema one — a filter of a filter is one filter with more rows.
  it('refuses a matching inside a matching, with the reason', async () => {
    const user = userEvent.setup();
    render(<LiveTarget initial={{ kind: 'matching', from: ALL_BATTLEFIELD, where: EMPTY_WHERE }} />);

    await openTarget(user);
    const inner = screen.getByRole('group', { name: 'Out of' });
    expect(within(inner).getByRole('radio', { name: /cards matching a filter/i })).toBeDisabled();
    expect(screen.getByText(/add the conditions to the filter above instead/i)).toBeInTheDocument();

    // The wrapped selector is still editable in there, which is the point of the fieldset.
    await user.click(within(inner).getByRole('radio', { name: /this card/i }));
    expect(chip()).toHaveTextContent(/this card where/i);
  });

  it.each([
    [
      'its from',
      { kind: 'matching', from: { kind: 'allInZone', zone: GONE }, where: EMPTY_WHERE },
    ],
    [
      'its where',
      {
        kind: 'matching',
        from: { kind: 'triggeringCard' },
        where: {
          kind: 'criteria',
          left: { kind: 'zoneCount', zone: GONE },
          op: '>',
          right: { kind: 'literal', value: 0 },
        },
      },
    ],
  ])('marks matching red when %s dangles', (_name, selector) => {
    render(<LiveTarget initial={selector as TargetSelector} />);
    expect(chip()).toHaveAttribute('data-danger', '1');
  });
});

describe('<ActionSelectorChip> (§4.4, §6.11 recursion 2)', () => {
  const actionChip = () => screen.getByRole('button', { name: 'Which actions' });

  it('authors one particular action', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveAction initial={{ kind: 'allOnStack', where: null }} onChange={onChange} />);

    expect(actionChip()).toHaveTextContent('every action on the stack');

    await user.click(actionChip());
    await user.click(screen.getByRole('radio', { name: /one particular action/i }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'action', ref: { kind: 'topOfStack' } });

    await user.selectOptions(screen.getByLabelText('Action'), 'triggeringAction');
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'action',
      ref: { kind: 'triggeringAction' },
    });
    expect(actionChip()).toHaveTextContent('the action this is responding to');
  });

  it('authors every-action-on-the-stack, filtered, in the same expanded region', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LiveAction initial={{ kind: 'action', ref: { kind: 'topOfStack' } }} onChange={onChange} />
    );

    await user.click(actionChip());
    await user.click(screen.getByRole('radio', { name: /every action on the stack/i }));
    // `where: null` IS "all of them", so it is a checkbox rather than an empty tree meaning nothing.
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'allOnStack', where: null });
    expect(screen.queryByRole('group', { name: 'where' })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: /only the ones matching a filter/i }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'allOnStack', where: EMPTY_WHERE });

    const popover = screen.getByRole('dialog');
    expect(within(popover).queryByRole('group', { name: 'where' })).toBeNull();

    const region = screen.getByRole('group', { name: 'where' });
    await user.click(within(region).getByRole('button', { name: '+ condition' }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'allOnStack',
        where: expect.objectContaining({ children: [expect.objectContaining({ op: '=' })] }),
      })
    );
  });

  it('has no card under test to offer — this tree filters actions, not cards', async () => {
    const user = userEvent.setup();
    render(<LiveAction initial={{ kind: 'allOnStack', where: EMPTY_WHERE }} />);

    const region = screen.getByRole('group', { name: 'where' });
    await user.click(within(region).getByRole('button', { name: '+ condition' }));
    await user.click(within(region).getByRole('button', { name: 'Left side' }));
    await user.click(screen.getByRole('radio', { name: /a card index/i }));
    await user.click(screen.getByRole('button', { name: 'Card' }));

    expect(screen.getByRole('radio', { name: /the card under test/i })).toBeDisabled();
  });

  it('turns red when a ref in its filter dangles', () => {
    render(
      <LiveAction
        initial={{
          kind: 'allOnStack',
          where: {
            kind: 'criteria',
            left: { kind: 'zoneCount', zone: GONE },
            op: '>',
            right: { kind: 'literal', value: 0 },
          },
        }}
      />
    );
    expect(screen.getByRole('button', { name: 'Which actions' })).toHaveAttribute('data-danger', '1');
  });
});
