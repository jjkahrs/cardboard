/**
 * Step 14 — the §6.8 half of §5.4's read sites.
 *
 * `ZoneView` is where `effectiveIndex` / `effectiveTags` are resolved, exactly as `faceDown` already
 * is, and handed to `<Card>` as computed answers. The load-bearing assertion here is the *negative*
 * one: a card being rendered face-down is not computed at all. It is asserted by counting calls,
 * because "the value is absent from the DOM" is already true of a face-down card either way and
 * would keep passing after someone moved the computation above the `hidden` check.
 */

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { zoneKey } from '../../engine/valueRef';
import type { GameDefinition, PlayZone } from '../../engine/types';
import { BATTLEFIELD, GRUNT, HAND, MAIN, POWER, duel } from '../../test/fixtures/duel';
import { emptyBoard, place } from '../../test/board';
import { ZoneView } from './ZoneView';

/** `vi.hoisted`, because `vi.mock` is hoisted above every other statement in the module. */
const calls = vi.hoisted(() => ({ index: 0, tags: 0 }));

vi.mock('../../engine/modifiers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../engine/modifiers')>();
  return {
    ...real,
    effectiveIndex: (...args: Parameters<typeof real.effectiveIndex>) => {
      calls.index += 1;
      return real.effectiveIndex(...args);
    },
    effectiveTags: (...args: Parameters<typeof real.effectiveTags>) => {
      calls.tags += 1;
      return real.effectiveTags(...args);
    },
  };
});

const zoneDef = (id: string): PlayZone => duel.zones.find((z) => z.id === id)!;

const BF = zoneKey(BATTLEFIELD, null);
const HAND_1 = zoneKey(HAND, 1);

/** Seat 0 is watching; seat 1's hand is `ownerOnly`, so its Grunt renders face-down. */
function board() {
  const state = emptyBoard(duel, MAIN);
  place(state, duel, BF, GRUNT, 'g1');
  place(state, duel, HAND_1, GRUNT, 'g2');
  return state;
}

function renderZone(zone: PlayZone, seat: number | null, definition: GameDefinition = duel) {
  const state = board();
  calls.index = 0;
  calls.tags = 0;
  const result = render(
    <ZoneView
      zone={zone}
      instance={state.zones[zoneKey(zone.id, seat)]}
      definition={definition}
      state={state}
      viewingSeat={0}
      revealAll={false}
    />
  );
  return { state, ...result };
}

describe('effective values are resolved here, not in <Card> (§6.8)', () => {
  it('computes them for a face-up card', () => {
    const { container } = renderZone(zoneDef(BATTLEFIELD), null);

    // One index on a Grunt, so one effectiveIndex call and one effectiveTags call.
    expect(calls.index).toBe(1);
    expect(calls.tags).toBe(1);
    expect(container.querySelector('.cb-pip b')).toHaveTextContent('1');
  });

  it('computes NOTHING for a card it renders face-down', () => {
    const { container } = renderZone(zoneDef(HAND), 1);

    expect(container.querySelector('.cb-card__back')).toBeInTheDocument();
    expect(calls.index).toBe(0);
    expect(calls.tags).toBe(0);
  });

  it('reads the base value through effectiveIndex, so a modifier would reach the pip', () => {
    // No modifier in `duel`, so the proof that the wiring is live is that the pip follows the
    // instance's stored value through the same call the counter above sees.
    const state = board();
    state.cards['g1'].indexValues[POWER] = 4;
    const { container } = render(
      <ZoneView
        zone={zoneDef(BATTLEFIELD)}
        instance={state.zones[BF]}
        definition={duel}
        state={state}
        viewingSeat={0}
        revealAll={false}
      />
    );
    expect(container.querySelector('.cb-pip b')).toHaveTextContent('4');
    expect(container.querySelector('.cb-pip')).not.toHaveAttribute('data-modified');
  });
});
