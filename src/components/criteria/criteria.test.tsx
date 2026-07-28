/**
 * Step 20 — the ValueRef chip and the recursive AND/OR tree.
 *
 * Both are controlled components: every test asserts on what they hand back through onChange, not
 * on internal state, because the rule editor and the state-machine screen are the ones that decide
 * whether an edit is kept.
 */

import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { describeValueRef } from '../../engine/prose';
import type { CriteriaGroup, GameDefinition, ValueRef } from '../../engine/types';
import type { RefContext } from '../authoring/refs';
import { ATTACKERS, BATTLEFIELD, FIRST_BLOOD, HAND, HP, POWER, duel } from '../../test/fixtures/duel';
import { empty } from '../../test/fixtures/empty';
import { CriteriaGroupEditor } from './CriteriaGroupEditor';
import { isDangling } from './isDangling';
import { ValueRefPicker } from './ValueRefPicker';

const literal = (value: number): ValueRef => ({ kind: 'literal', value });

/** Renders a picker that keeps its own value, so a test can make two edits in a row. */
function LiveValueRef({
  initial,
  definition = duel,
  onChange,
  context,
}: {
  initial: ValueRef;
  definition?: GameDefinition;
  onChange?: (v: ValueRef) => void;
  context?: RefContext;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ValueRefPicker
      value={value}
      definition={definition}
      context={context}
      ariaLabel="Left side"
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const openChip = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /left side/i }));

describe('<ValueRefPicker>', () => {
  it('labels the chip with the same prose the card would print', () => {
    const value: ValueRef = { kind: 'pool', poolId: HP, seat: { kind: 'active' } };
    render(<LiveValueRef initial={value} />);
    expect(screen.getByRole('button', { name: /left side/i })).toHaveTextContent(
      describeValueRef(value, duel)
    );
  });

  it('switches kind to a ref that already resolves, never a blank one', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveValueRef initial={literal(0)} onChange={onChange} />);

    await openChip(user);
    await user.click(screen.getByRole('radio', { name: /a pool/i }));

    expect(onChange).toHaveBeenCalledWith({ kind: 'pool', poolId: HP, seat: { kind: 'active' } });
  });

  it('changes which pool, keeping the seat', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LiveValueRef initial={{ kind: 'pool', poolId: HP, seat: { kind: 'next' } }} onChange={onChange} />
    );

    await openChip(user);
    await user.selectOptions(screen.getByLabelText('Pool'), 'Attackers');

    expect(onChange).toHaveBeenCalledWith({ kind: 'pool', poolId: ATTACKERS, seat: { kind: 'next' } });
  });

  it('drops the seat when the pool is game-scoped, because there is only one value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LiveValueRef initial={{ kind: 'pool', poolId: HP, seat: { kind: 'active' } }} onChange={onChange} />
    );

    await openChip(user);
    await user.selectOptions(screen.getByLabelText('Pool'), 'First Blood');

    expect(onChange).toHaveBeenCalledWith({ kind: 'pool', poolId: FIRST_BLOOD, seat: null });
    expect(screen.queryByLabelText('Of')).not.toBeInTheDocument();
  });

  it('offers a seat again when moving back to a player-scoped pool', async () => {
    const user = userEvent.setup();
    render(<LiveValueRef initial={{ kind: 'pool', poolId: FIRST_BLOOD, seat: null }} />);

    await openChip(user);
    await user.selectOptions(screen.getByLabelText('Pool'), 'HP');

    expect(screen.getByRole('button', { name: 'Of' })).toHaveTextContent('the active player');
  });

  it('picks a seat by index as well as by role', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LiveValueRef initial={{ kind: 'pool', poolId: HP, seat: { kind: 'active' } }} onChange={onChange} />
    );

    await openChip(user);
    await user.click(screen.getByRole('button', { name: 'Of' }));
    await user.click(screen.getByRole('radio', { name: /a specific seat/i }));
    await user.selectOptions(screen.getByLabelText('Seat'), '1');

    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'pool',
      poolId: HP,
      seat: { kind: 'seat', index: 1 },
    });
  });

  it('edits a literal number', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveValueRef initial={literal(0)} onChange={onChange} />);

    await openChip(user);
    await user.type(screen.getByLabelText('Value'), '5');

    expect(onChange).toHaveBeenLastCalledWith({ kind: 'literal', value: 5 });
  });

  it('switches a literal to true/false', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveValueRef initial={literal(3)} onChange={onChange} />);

    await openChip(user);
    await user.selectOptions(screen.getByLabelText('Type'), 'boolean');
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'literal', value: true });

    await user.selectOptions(screen.getByLabelText('Value'), 'false');
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'literal', value: false });
  });

  it('counts cards in a zone, with a seat only for player-scoped zones', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveValueRef initial={literal(0)} onChange={onChange} />);

    await openChip(user);
    await user.click(screen.getByRole('radio', { name: /cards in a zone/i }));
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'zoneCount',
      zone: { zoneId: 'zone_deck', seat: { kind: 'active' } },
    });

    await user.selectOptions(screen.getByLabelText('Zone'), 'Battlefield');
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'zoneCount',
      zone: { zoneId: BATTLEFIELD, seat: null },
    });
    expect(screen.queryByRole('button', { name: 'Owned by' })).not.toBeInTheDocument();
  });

  it('lists card indexes with the card that declares them', async () => {
    // A bare "Power" is ambiguous the moment two cards both have one.
    const user = userEvent.setup();
    render(<LiveValueRef initial={literal(0)} />);

    await openChip(user);
    await user.click(screen.getByRole('radio', { name: /a card index/i }));

    expect(screen.getByLabelText('Index')).toHaveValue(POWER);
    expect(within(screen.getByLabelText('Index')).getByRole('option')).toHaveTextContent(
      'Power (Grunt)'
    );
  });

  it('disables a kind the definition cannot satisfy yet', async () => {
    // An empty game has no pools or zones; offering them would mint a dangling reference.
    const user = userEvent.setup();
    render(<LiveValueRef initial={literal(0)} definition={empty} />);

    await openChip(user);
    expect(screen.getByRole('radio', { name: /a pool/i })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /cards in a zone/i })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /a number/i })).toBeEnabled();
  });

  it('marks a chip whose referent was deleted', () => {
    render(<LiveValueRef initial={{ kind: 'pool', poolId: 'pool_gone', seat: null }} />);
    const chip = screen.getByRole('button', { name: /left side/i });
    expect(chip).toHaveAttribute('data-danger', '1');
    expect(chip).toHaveTextContent('[deleted pool]');
  });

  it('isDangling covers every ref kind', () => {
    expect(isDangling(literal(1), duel)).toBe(false);
    expect(isDangling({ kind: 'pool', poolId: HP, seat: null }, duel)).toBe(false);
    expect(isDangling({ kind: 'pool', poolId: 'nope', seat: null }, duel)).toBe(true);
    expect(isDangling({ kind: 'zoneCount', zone: { zoneId: HAND, seat: null } }, duel)).toBe(false);
    expect(isDangling({ kind: 'zoneCount', zone: { zoneId: 'nope', seat: null } }, duel)).toBe(true);
    expect(isDangling({ kind: 'cardIndex', card: { kind: 'triggering' }, indexId: POWER }, duel)).toBe(
      false
    );
    expect(isDangling({ kind: 'cardIndex', card: { kind: 'triggering' }, indexId: 'nope' }, duel)).toBe(
      true
    );
    expect(isDangling({ kind: 'activeSeatCount' }, duel)).toBe(false);
    expect(isDangling({ kind: 'replacedAmount' }, duel)).toBe(false);
    expect(isDangling({ kind: 'promptNumber', key: 'x' }, duel)).toBe(false);
    expect(
      isDangling({ kind: 'actionField', action: { kind: 'topOfStack' }, field: 'controller' }, duel)
    ).toBe(false);
    expect(isDangling({ kind: 'cardTag', card: { kind: 'triggering' }, tag: 'x' }, duel)).toBe(false);
  });

  // §4.1 made the three ref unions mutually recursive, so a shallow check on the outermost id would
  // call a ref healthy while the zone three levels down had been deleted.
  it('isDangling descends through the seat and card a ref carries', () => {
    const gone = { kind: 'zoneTop', zone: { zoneId: 'zone_gone', seat: null } } as const;
    const live = { kind: 'zoneTop', zone: { zoneId: HAND, seat: { kind: 'active' } } } as const;

    expect(isDangling({ kind: 'cardTag', card: gone, tag: 'x' }, duel)).toBe(true);
    expect(isDangling({ kind: 'cardTag', card: live, tag: 'x' }, duel)).toBe(false);
    expect(isDangling({ kind: 'cardIndex', card: gone, indexId: POWER }, duel)).toBe(true);
    expect(isDangling({ kind: 'pool', poolId: HP, seat: { kind: 'owner', card: gone } }, duel)).toBe(
      true
    );
    expect(
      isDangling(
        {
          kind: 'zoneCount',
          zone: {
            zoneId: HAND,
            seat: { kind: 'relative', from: { kind: 'controller', card: gone }, offset: 1 },
          },
        },
        duel
      )
    ).toBe(true);
  });

  describe('v2 §4.2 — the four new kinds', () => {
    it('counts the players still in the game, with nothing to configure', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<LiveValueRef initial={literal(0)} onChange={onChange} />);

      await openChip(user);
      await user.click(screen.getByRole('radio', { name: /players still in the game/i }));

      expect(onChange).toHaveBeenLastCalledWith({ kind: 'activeSeatCount' });
      expect(screen.getByRole('button', { name: /left side/i })).toHaveTextContent(
        'the number of players still in the game'
      );
    });

    it('asks whether a card has a tag, through a real CardRef', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<LiveValueRef initial={literal(0)} onChange={onChange} />);

      await openChip(user);
      await user.click(screen.getByRole('radio', { name: /whether a card has a tag/i }));
      expect(onChange).toHaveBeenLastCalledWith({
        kind: 'cardTag',
        card: { kind: 'triggering' },
        tag: '',
      });

      await user.type(screen.getByLabelText('Tag'), 'creature');
      expect(onChange).toHaveBeenLastCalledWith({
        kind: 'cardTag',
        card: { kind: 'triggering' },
        tag: 'creature',
      });

      // The CardRef is editable now — `ValueRefPicker` used to hard-code `{kind:'triggering'}`.
      await user.click(screen.getByRole('button', { name: 'Card' }));
      await user.click(screen.getByRole('radio', { name: /the card this is attached to/i }));
      expect(onChange).toHaveBeenLastCalledWith({
        kind: 'cardTag',
        card: { kind: 'host' },
        tag: 'creature',
      });
    });

    it('lets a card index name its own card rather than always the triggering one', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<LiveValueRef initial={literal(0)} onChange={onChange} />);

      await openChip(user);
      await user.click(screen.getByRole('radio', { name: /a card index/i }));
      await user.click(screen.getByRole('button', { name: 'Card' }));
      await user.click(screen.getByRole('radio', { name: /the top card of a zone/i }));

      expect(onChange).toHaveBeenLastCalledWith({
        kind: 'cardIndex',
        indexId: POWER,
        card: { kind: 'zoneTop', zone: { zoneId: 'zone_deck', seat: { kind: 'active' } } },
      });
    });

    it('reads a field off a pending action, and never offers a runtime action id', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<LiveValueRef initial={literal(0)} onChange={onChange} />);

      await openChip(user);
      await user.click(screen.getByRole('radio', { name: /something about a pending action/i }));
      expect(onChange).toHaveBeenLastCalledWith({
        kind: 'actionField',
        action: { kind: 'topOfStack' },
        field: 'controller',
      });

      // `{kind:'action', id}` names an id no author can know — same omission as `promptAnswer`.
      const actions = within(screen.getByLabelText('Action')).getAllByRole('option');
      expect(actions.map((o) => o.getAttribute('value'))).toEqual([
        'triggeringAction',
        'topOfStack',
      ]);

      await user.selectOptions(screen.getByLabelText('Action'), 'triggeringAction');
      await user.selectOptions(screen.getByLabelText('Field'), 'targetCount');
      expect(onChange).toHaveBeenLastCalledWith({
        kind: 'actionField',
        action: { kind: 'triggeringAction' },
        field: 'targetCount',
      });
    });

    it('disables the replaced amount outside a replacement rule, and says why', async () => {
      const user = userEvent.setup();
      render(<LiveValueRef initial={literal(0)} />);

      await openChip(user);

      expect(screen.getByRole('radio', { name: /the replaced amount/i })).toBeDisabled();
      expect(screen.getByText(/only inside a replacement rule/i)).toBeInTheDocument();
    });

    it('enables the replaced amount inside one', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<LiveValueRef initial={literal(0)} onChange={onChange} context="replacement" />);

      await openChip(user);
      await user.click(screen.getByRole('radio', { name: /the replaced amount/i }));

      expect(onChange).toHaveBeenLastCalledWith({ kind: 'replacedAmount' });
    });
  });
});

function LiveGroup({
  initial,
  onChange,
  context,
}: {
  initial: CriteriaGroup;
  onChange?: (g: CriteriaGroup) => void;
  context?: RefContext;
}) {
  const [node, setNode] = useState(initial);
  return (
    <CriteriaGroupEditor
      node={node}
      definition={duel}
      context={context}
      onChange={(next) => {
        setNode(next);
        onChange?.(next);
      }}
    />
  );
}

const groupWith = (...children: CriteriaGroup['children']): CriteriaGroup => ({
  kind: 'group',
  combinator: 'and',
  children,
});

describe('<CriteriaGroupEditor>', () => {
  it('shows the combinator once, on the group', async () => {
    // Never a per-row AND/OR dropdown — that is the usual source of "what does this evaluate to".
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveGroup initial={groupWith()} onChange={onChange} />);

    const toggle = screen.getByRole('button', { name: /all of/i });
    await user.click(toggle);

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ combinator: 'or' }));
    expect(screen.getByRole('button', { name: /any of/i })).toBeInTheDocument();
  });

  it('adds a condition that already evaluates', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveGroup initial={groupWith()} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: '+ condition' }));

    expect(onChange).toHaveBeenCalledWith(
      groupWith({ kind: 'criteria', left: literal(0), op: '=', right: literal(0) })
    );
  });

  it('changes a comparison', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LiveGroup
        initial={groupWith({ kind: 'criteria', left: literal(1), op: '=', right: literal(2) })}
        onChange={onChange}
      />
    );

    await user.selectOptions(screen.getByLabelText('Comparison'), '>=');

    expect(onChange).toHaveBeenCalledWith(
      groupWith({ kind: 'criteria', left: literal(1), op: '>=', right: literal(2) })
    );
  });

  it('removes one condition without touching its siblings', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const a = { kind: 'criteria', left: literal(1), op: '=', right: literal(1) } as const;
    const b = { kind: 'criteria', left: literal(2), op: '=', right: literal(2) } as const;
    render(<LiveGroup initial={groupWith(a, b)} onChange={onChange} />);

    await user.click(screen.getAllByRole('button', { name: 'Remove condition' })[0]);

    expect(onChange).toHaveBeenCalledWith(groupWith(b));
  });

  it('nests groups, and each keeps its own combinator', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveGroup initial={groupWith()} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: '+ group' }));
    expect(onChange).toHaveBeenLastCalledWith(groupWith({ kind: 'group', combinator: 'and', children: [] }));

    // The inner group's toggle is the second one on screen; flipping it must not touch the outer.
    await user.click(screen.getAllByRole('button', { name: /all of/i })[1]);
    expect(onChange).toHaveBeenLastCalledWith(
      groupWith({ kind: 'group', combinator: 'or', children: [] })
    );
  });

  it('removes a nested group', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveGroup initial={groupWith({ kind: 'group', combinator: 'or', children: [] })} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /remove this any of group/i }));
    expect(onChange).toHaveBeenCalledWith(groupWith());
  });

  it('gives the root no delete control', () => {
    render(<LiveGroup initial={groupWith()} />);
    expect(screen.queryByRole('button', { name: /remove this .* group/i })).not.toBeInTheDocument();
  });

  it('stops indenting past depth 3 and prints the depth instead', () => {
    const nest = (depth: number): CriteriaGroup =>
      depth === 0 ? groupWith() : { kind: 'group', combinator: 'and', children: [nest(depth - 1)] };
    const { container } = render(<LiveGroup initial={nest(5)} />);

    const depths = [...container.querySelectorAll('.cb-crit')].map((el) => el.getAttribute('data-depth'));
    expect(depths).toEqual(['0', '1', '2', '3', '3', '3']);
    expect(screen.getByText('depth 4')).toBeInTheDocument();
    expect(screen.getByText('depth 5')).toBeInTheDocument();
  });

  it('says what an empty group does, rather than looking broken', () => {
    render(<LiveGroup initial={groupWith()} />);
    expect(screen.getByText(/passes until you add a condition/i)).toBeInTheDocument();
  });

  /**
   * §6.11's prop chain, asserted end to end: `CriteriaGroupEditor` -> `CriteriaRow` ->
   * `ValueRefPicker` -> `CardRefChip`. Calling `CardRefChip` directly would prove the chip works and
   * nothing about whether the four hand-offs between here and it are wired.
   */
  const openCardChip = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'Left side' }));
    await user.click(screen.getByRole('radio', { name: /whether a card has a tag/i }));
    await user.click(screen.getByRole('button', { name: 'Card' }));
  };

  const tagCriteria = groupWith({
    kind: 'criteria',
    left: literal(0),
    op: '=',
    right: literal(0),
  });

  it('disables the card under test outside a matching subtree, and says why', async () => {
    const user = userEvent.setup();
    render(<LiveGroup initial={tagCriteria} />);

    await openCardChip(user);

    expect(screen.getByRole('radio', { name: /the card under test/i })).toBeDisabled();
    expect(screen.getByText(/only inside a "cards matching/i)).toBeInTheDocument();
  });

  it('enables the card under test inside one, all four props deep', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveGroup initial={tagCriteria} onChange={onChange} context="candidate" />);

    await openCardChip(user);
    await user.click(screen.getByRole('radio', { name: /the card under test/i }));

    expect(onChange).toHaveBeenLastCalledWith(
      groupWith({
        kind: 'criteria',
        left: { kind: 'cardTag', card: { kind: 'candidate' }, tag: '' },
        op: '=',
        right: literal(0),
      })
    );
  });

  it('keeps the two contexts apart', async () => {
    const user = userEvent.setup();
    render(<LiveGroup initial={tagCriteria} context="replacement" />);

    await openCardChip(user);

    expect(screen.getByRole('radio', { name: /the replaced target/i })).toBeEnabled();
    expect(screen.getByRole('radio', { name: /the card under test/i })).toBeDisabled();
  });
});
