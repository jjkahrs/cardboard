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
}: {
  initial: ValueRef;
  definition?: GameDefinition;
  onChange?: (v: ValueRef) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ValueRefPicker
      value={value}
      definition={definition}
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

    expect(screen.getByLabelText('Of')).toHaveValue('active');
  });

  it('picks a seat by index as well as by role', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LiveValueRef initial={{ kind: 'pool', poolId: HP, seat: { kind: 'active' } }} onChange={onChange} />
    );

    await openChip(user);
    await user.selectOptions(screen.getByLabelText('Of'), 'seat:1');

    expect(onChange).toHaveBeenCalledWith({
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
    expect(screen.queryByLabelText('Owned by')).not.toBeInTheDocument();
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
  });
});

function LiveGroup({ initial, onChange }: { initial: CriteriaGroup; onChange?: (g: CriteriaGroup) => void }) {
  const [node, setNode] = useState(initial);
  return (
    <CriteriaGroupEditor
      node={node}
      definition={duel}
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
});
