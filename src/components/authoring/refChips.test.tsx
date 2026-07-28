/**
 * Step 44 — `SeatRefChip` and `CardRefChip`, the two widgets §4's unions could not be authored
 * without, plus the `SeatSelect` call sites they replace.
 *
 * Controlled components throughout: every test asserts on what the chip hands back through
 * `onChange`, because the rule editor is what decides whether an edit is kept.
 */

import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  CardRef,
  Effect,
  GameDefinition,
  SeatRef,
  ValueRef,
  ZoneRef,
} from '../../engine/types';
import { BATTLEFIELD, DECK, HAND, HP, duel } from '../../test/fixtures/duel';
import { empty } from '../../test/fixtures/empty';
import { ValueRefPicker } from '../criteria/ValueRefPicker';
import { CardRefChip } from './CardRefChip';
import { EffectRow } from './EffectRow';
import { SeatRefChip } from './SeatRefChip';
import { ZoneRefChip } from './ZoneRefChip';

function LiveSeat({
  initial,
  onChange,
  numeric,
  definition = duel,
}: {
  initial: SeatRef;
  onChange?: (s: SeatRef) => void;
  numeric?: boolean;
  definition?: GameDefinition;
}) {
  const [seat, setSeat] = useState(initial);
  return (
    <SeatRefChip
      seat={seat}
      definition={definition}
      ariaLabel="Whose"
      numeric={numeric}
      onChange={(next) => {
        setSeat(next);
        onChange?.(next);
      }}
    />
  );
}

function LiveCard({
  initial,
  onChange,
  definition = duel,
}: {
  initial: CardRef;
  onChange?: (c: CardRef) => void;
  definition?: GameDefinition;
}) {
  const [card, setCard] = useState(initial);
  return (
    <CardRefChip
      card={card}
      definition={definition}
      ariaLabel="Which card"
      onChange={(next) => {
        setCard(next);
        onChange?.(next);
      }}
    />
  );
}

const openSeat = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Whose' }));

describe('<SeatRefChip>', () => {
  it('reads as prose on the chip, not as an encoded option value', () => {
    render(<LiveSeat initial={{ kind: 'triggeringSeat' }} />);
    expect(screen.getByRole('button', { name: 'Whose' })).toHaveTextContent(
      'the player who played this'
    );
  });

  it('round-trips every flat seat the old select offered', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveSeat initial={{ kind: 'active' }} onChange={onChange} />);

    await openSeat(user);
    for (const [label, expected] of [
      [/the player who played this/i, { kind: 'triggeringSeat' }],
      [/the next player/i, { kind: 'next' }],
      [/the previous player/i, { kind: 'previous' }],
      [/the active player/i, { kind: 'active' }],
    ] as const) {
      await user.click(within(screen.getByRole('dialog')).getByRole('radio', { name: label }));
      expect(onChange).toHaveBeenLastCalledWith(expected);
    }
  });

  it('picks a seat by index', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveSeat initial={{ kind: 'active' }} onChange={onChange} />);

    await openSeat(user);
    await user.click(screen.getByRole('radio', { name: /a specific seat/i }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'seat', index: 0 });

    await user.selectOptions(screen.getByLabelText('Seat'), '1');
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'seat', index: 1 });
  });

  // §4.1's single `all` kind asks three different questions; one row could only ever author one.
  it('makes every / any / summed three distinct, authorable rows', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveSeat initial={{ kind: 'active' }} onChange={onChange} numeric />);

    await openSeat(user);
    for (const [label, quantifier] of [
      [/every player/i, 'every'],
      [/any player/i, 'some'],
      [/all players, summed/i, 'sum'],
    ] as const) {
      await user.click(within(screen.getByRole('dialog')).getByRole('radio', { name: label }));
      expect(onChange).toHaveBeenLastCalledWith({ kind: 'all', quantifier });
    }
  });

  it('checks the every row for a bare {kind:"all"}, which is what it means', async () => {
    const user = userEvent.setup();
    render(<LiveSeat initial={{ kind: 'all' }} />);

    await openSeat(user);
    expect(screen.getByRole('radio', { name: /every player/i })).toBeChecked();
  });

  // §4.1 — `sum` is an arithmetic total, so it exists only where the ref is consumed as a number.
  it('offers the summed row only in a numeric position', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<LiveSeat initial={{ kind: 'active' }} numeric />);
    await openSeat(user);
    expect(screen.getByRole('radio', { name: /all players, summed/i })).toBeInTheDocument();
    unmount();

    render(<LiveSeat initial={{ kind: 'active' }} />);
    await openSeat(user);
    expect(screen.queryByRole('radio', { name: /all players, summed/i })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /every player/i })).toBeInTheDocument();
  });

  it('nests a seat inside relative, and refuses a relative of a relative with a reason', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveSeat initial={{ kind: 'active' }} onChange={onChange} />);

    await openSeat(user);
    await user.click(screen.getByRole('radio', { name: /counted from another player/i }));
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'relative',
      from: { kind: 'active' },
      offset: 1,
    });

    const inner = screen.getByRole('group', { name: 'Counted from' });
    await user.click(within(inner).getByRole('radio', { name: /the player who played this/i }));
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'relative',
      from: { kind: 'triggeringSeat' },
      offset: 1,
    });

    // An editor restriction, not a schema one — so it is disabled and says why, never hidden.
    const nested = within(screen.getByRole('group', { name: 'Counted from' })).getByRole('radio', {
      name: /counted from another player/i,
    });
    expect(nested).toBeDisabled();
    expect(screen.getByText(/do the arithmetic in the offset instead/i)).toBeInTheDocument();
  });

  it('edits the offset', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LiveSeat initial={{ kind: 'relative', from: { kind: 'active' }, offset: 1 }} onChange={onChange} />
    );

    await openSeat(user);
    await user.clear(screen.getByLabelText('Seats along'));
    await user.type(screen.getByLabelText('Seats along'), '3');

    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'relative',
      from: { kind: 'active' },
      offset: 3,
    });
    expect(screen.getByRole('button', { name: 'Whose' })).toHaveTextContent(
      'the player 3 seats after the active player'
    );
  });

  it('reads a negative offset backwards round the ring', () => {
    render(<LiveSeat initial={{ kind: 'relative', from: { kind: 'next' }, offset: -1 }} />);
    expect(screen.getByRole('button', { name: 'Whose' })).toHaveTextContent(
      'the player 1 seat before the next player'
    );
  });

  it('carries a CardRef on owner and on controller', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveSeat initial={{ kind: 'active' }} onChange={onChange} />);

    await openSeat(user);
    await user.click(screen.getByRole('radio', { name: /a card's owner/i }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'owner', card: { kind: 'triggering' } });

    await user.click(screen.getByRole('button', { name: 'Of which card' }));
    await user.click(screen.getByRole('radio', { name: /the card this is attached to/i }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'owner', card: { kind: 'host' } });

    // Switching owner -> controller keeps the card the author already chose.
    await user.click(screen.getByRole('radio', { name: /a card's controller/i }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'controller', card: { kind: 'host' } });
    expect(screen.getByRole('button', { name: 'Whose' })).toHaveTextContent(
      'the controller of the card this is attached to'
    );
  });

  it('marks a seat whose card points at a deleted zone', () => {
    render(
      <LiveSeat
        initial={{
          kind: 'owner',
          card: { kind: 'zoneTop', zone: { zoneId: 'zone_gone', seat: null } },
        }}
      />
    );
    expect(screen.getByRole('button', { name: 'Whose' })).toHaveAttribute('data-danger', '1');
  });
});

describe('<CardRefChip>', () => {
  const open = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole('button', { name: 'Which card' }));

  it('authors the whole union an author can mean', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiveCard initial={{ kind: 'triggering' }} onChange={onChange} />);

    await open(user);
    await user.click(screen.getByRole('radio', { name: /the card this is attached to/i }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'host' });

    await user.click(screen.getByRole('radio', { name: /the top card of a zone/i }));
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'zoneTop',
      zone: { zoneId: DECK, seat: { kind: 'active' } },
    });

    await user.selectOptions(screen.getByLabelText('Zone'), 'Battlefield');
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'zoneTop',
      zone: { zoneId: BATTLEFIELD, seat: null },
    });
  });

  // Both only exist during a running session, so there is nothing an author could pick.
  it('never offers promptAnswer or instance', async () => {
    const user = userEvent.setup();
    render(<LiveCard initial={{ kind: 'triggering' }} />);

    await open(user);
    expect(within(screen.getByRole('dialog')).getAllByRole('radio')).toHaveLength(5);
    expect(screen.queryByRole('radio', { name: /chosen card/i })).not.toBeInTheDocument();
  });

  it('disables the top-of-zone row with a reason when the game has no zones', async () => {
    const user = userEvent.setup();
    render(<LiveCard initial={{ kind: 'triggering' }} definition={empty} />);

    await open(user);
    expect(screen.getByRole('radio', { name: /the top card of a zone/i })).toBeDisabled();
    expect(screen.getByText(/no zones yet/i)).toBeInTheDocument();
  });
});

/**
 * The migration: `SeatSelect` and its `seatToOption`/`optionToSeat` encoding are gone, so each site
 * that used them has to still show, and still hand back, the seat it holds.
 */
describe('the replaced SeatSelect call sites', () => {
  it('ZoneRefChip — "Owned by" round-trips, and offers no summed row', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Live() {
      const [zone, setZone] = useState<ZoneRef>({ zoneId: HAND, seat: { kind: 'active' } });
      return (
        <ZoneRefChip
          zone={zone}
          definition={duel}
          ariaLabel="Zone"
          onChange={(next) => {
            setZone(next);
            onChange(next);
          }}
        />
      );
    }
    render(<Live />);

    await user.click(screen.getByRole('button', { name: 'Zone' }));
    expect(screen.getByRole('button', { name: 'Owned by' })).toHaveTextContent('the active player');

    await user.click(screen.getByRole('button', { name: 'Owned by' }));
    // A zone reference is not a numeric position, so `sum` has nothing to total here.
    expect(screen.queryByRole('radio', { name: /all players, summed/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /the next player/i }));
    expect(onChange).toHaveBeenLastCalledWith({ zoneId: HAND, seat: { kind: 'next' } });
  });

  it('ValueRefPicker — a zone count is numeric, so "Owned by" does offer the summed row', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Live() {
      const [value, setValue] = useState<ValueRef>({
        kind: 'zoneCount',
        zone: { zoneId: HAND, seat: { kind: 'active' } },
      });
      return (
        <ValueRefPicker
          value={value}
          definition={duel}
          ariaLabel="Amount"
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      );
    }
    render(<Live />);

    await user.click(screen.getByRole('button', { name: 'Amount' }));
    await user.click(screen.getByRole('button', { name: 'Owned by' }));
    await user.click(screen.getByRole('radio', { name: /all players, summed/i }));

    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'zoneCount',
      zone: { zoneId: HAND, seat: { kind: 'all', quantifier: 'sum' } },
    });
  });

  it('EffectRow — the mid-sentence seat on changePool round-trips', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Live() {
      const [effect, setEffect] = useState<Effect>({
        kind: 'changePool',
        poolId: HP,
        seat: { kind: 'active' },
        op: 'subtract',
        amount: { kind: 'literal', value: 1 },
      });
      return (
        <ul>
          <EffectRow
            effect={effect}
            index={0}
            total={1}
            definition={duel}
            onChange={(next) => {
              setEffect(next);
              onChange(next);
            }}
            onMove={() => {}}
            onRemove={() => {}}
          />
        </ul>
      );
    }
    render(<Live />);

    expect(screen.getByRole('button', { name: 'Whose' })).toHaveTextContent('the active player');

    await user.click(screen.getByRole('button', { name: 'Whose' }));
    await user.click(screen.getByRole('radio', { name: /every player/i }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ seat: { kind: 'all', quantifier: 'every' } })
    );
  });
});
