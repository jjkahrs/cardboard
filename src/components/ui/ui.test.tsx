/**
 * Step 20 — the shared primitives: the chip popover every sentence part opens, and the master list
 * five authoring screens sit on.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { EditResult, Referrer } from '../../stores/definitionStore';
import { ChipPopover } from './ChipPopover';
import { EntityList } from './EntityList';

describe('<ChipPopover>', () => {
  const open = async () => {
    const user = userEvent.setup();
    render(
      <ChipPopover label="Player HP" ariaLabel="Left side">
        {(close) => (
          <button type="button" onClick={close}>
            Commit
          </button>
        )}
      </ChipPopover>
    );
    const chip = screen.getByRole('button', { name: /left side/i });
    await user.click(chip);
    return { user, chip };
  };

  it('starts closed and says so', () => {
    render(<ChipPopover label="Player HP">{() => <span>body</span>}</ChipPopover>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens on click', async () => {
    const { chip } = await open();
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes on Escape and gives focus back to the chip', async () => {
    // Otherwise the designer is dropped at the top of the document after every single edit.
    const { user, chip } = await open();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
  });

  it('closes when a committing control inside it calls close', async () => {
    const { user, chip } = await open();
    await user.click(screen.getByRole('button', { name: 'Commit' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
  });

  it('closes on a click outside', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ChipPopover label="Player HP">{() => <span>body</span>}</ChipPopover>
        <button type="button">elsewhere</button>
      </>
    );
    await user.click(screen.getByRole('button', { name: /player hp/i }));
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('marks a chip that points at something deleted', () => {
    // Red is not the carrier — data-danger drives a strikethrough in components.css too.
    render(
      <ChipPopover label="[deleted pool]" danger>
        {() => <span>body</span>}
      </ChipPopover>
    );
    expect(screen.getByRole('button')).toHaveAttribute('data-danger', '1');
  });

  it('cannot be opened when disabled', async () => {
    const user = userEvent.setup();
    render(
      <ChipPopover label="Player HP" disabled>
        {() => <span>body</span>}
      </ChipPopover>
    );
    await user.click(screen.getByRole('button'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('<EntityList>', () => {
  const items = [
    { id: 'p1', name: 'HP', detail: 'player · 0-20' },
    { id: 'p2', name: 'Attackers' },
  ];

  const setup = (over: Partial<Parameters<typeof EntityList>[0]> = {}) => {
    const props = {
      items,
      label: 'Pools',
      addLabel: 'New pool',
      onAdd: vi.fn(),
      onDelete: vi.fn(),
      onRename: vi.fn((): EditResult => ({ ok: true })),
      referrersOf: () => [] as Referrer[],
      ...over,
    };
    return { props, user: userEvent.setup(), ...render(<EntityList {...props} />) };
  };

  it('lists what it is given', () => {
    setup();
    const list = screen.getByRole('list', { name: 'Pools' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('HP')).toBeInTheDocument();
  });

  it('renames in place', async () => {
    const { props, user } = setup();
    await user.click(screen.getAllByRole('button', { name: 'Rename' })[0]);
    await user.clear(screen.getByRole('textbox', { name: /rename hp/i }));
    await user.type(screen.getByRole('textbox', { name: /rename hp/i }), 'Health{Enter}');

    expect(props.onRename).toHaveBeenCalledWith('p1', 'Health');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps the editor open and shows why when the store rejects the name', async () => {
    // A duplicate name is rejected by the same gate the importer runs; silently closing the editor
    // would look like it worked.
    const onRename = vi.fn((): EditResult => ({ ok: false, errors: ['Pool names must be unique'] }));
    const { user } = setup({ onRename });

    await user.click(screen.getAllByRole('button', { name: 'Rename' })[0]);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Pool names must be unique')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /rename hp/i })).toBeInvalid();
  });

  it('abandons a rename on Escape', async () => {
    const { props, user } = setup();
    await user.click(screen.getAllByRole('button', { name: 'Rename' })[0]);
    await user.type(screen.getByRole('textbox', { name: /rename hp/i }), 'x{Escape}');

    expect(props.onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('asks before deleting, and deletes nothing until the second click', async () => {
    const { props, user } = setup();
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    expect(props.onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /delete for good/i }));
    expect(props.onDelete).toHaveBeenCalledWith('p1');
  });

  it('refuses to delete something that is referenced, and names the referrers', async () => {
    // Refused, not confirmed: the store's referential gate would reject the edit anyway.
    const referrer: Referrer = {
      ownerKind: 'ruleSet',
      ownerId: 'rs1',
      ownerName: 'Bolt: burn on play',
      path: 'effects.0.amount',
    };
    const { props, user } = setup({ referrersOf: () => [referrer] });

    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);

    expect(screen.getByText(/Bolt: burn on play \(effects\.0\.amount\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete for good/i })).not.toBeInTheDocument();
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('offers selection only when the caller wants it', async () => {
    const onSelect = vi.fn();
    const { user } = setup({ onSelect, selectedId: 'p2' });

    await user.click(screen.getByRole('button', { name: 'HP' }));
    expect(onSelect).toHaveBeenCalledWith('p1');
    expect(screen.getAllByRole('listitem')[1]).toHaveAttribute('aria-current', 'true');
  });

  it('says what to do when it is empty', () => {
    setup({ items: [], emptyHint: 'No pools yet. HP is a good first one.' });
    expect(screen.getByText(/HP is a good first one/)).toBeInTheDocument();
  });

  it('adds', async () => {
    const { props, user } = setup();
    await user.click(screen.getByRole('button', { name: 'New pool' }));
    expect(props.onAdd).toHaveBeenCalled();
  });
});
