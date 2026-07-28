/**
 * Step 14 — the §6.8 half of §5.4's read sites.
 *
 * `ZoneView` is where `effectiveIndex` / `effectiveTags` are resolved, exactly as `faceDown` already
 * is, and handed to `<Card>` as computed answers. The load-bearing assertion here is the *negative*
 * one: a card being rendered face-down is not computed at all. It is asserted by counting calls,
 * because "the value is absent from the DOM" is already true of a face-down card either way and
 * would keep passing after someone moved the computation above the `hidden` check.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { zoneKey } from '../../engine/valueRef';
import type { CriteriaNode, GameDefinition, PlayState, PlayZone, RuleSet } from '../../engine/types';
import { BATTLEFIELD, DECK, GRUNT, HAND, MAIN, POWER, duel } from '../../test/fixtures/duel';
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

// ---------------------------------------------------------------------------
// Step 37, §6.7 — per-instance activation
// ---------------------------------------------------------------------------

/** Always true / always false leaves — plain literal comparisons, so a test rule's `condition` or
 * `costCheck` needs nothing from the board itself. */
const ALWAYS: CriteriaNode = { kind: 'criteria', left: { kind: 'literal', value: 1 }, op: '>', right: { kind: 'literal', value: 0 } };
const NEVER: CriteriaNode = { kind: 'criteria', left: { kind: 'literal', value: 1 }, op: '>', right: { kind: 'literal', value: 999 } };
/** HP's max is 20 (`duel.ts`), so `>= 999` can never be paid — a deterministic COST_UNPAYABLE. */
const UNPAYABLE_COST: CriteriaNode = {
  kind: 'criteria',
  left: { kind: 'pool', poolId: 'pool_hp', seat: { kind: 'triggeringSeat' } },
  op: '>=',
  right: { kind: 'literal', value: 999 },
};

/** A minimal `perInstance` activation RuleSet — every field `RuleSet` requires but this file
 * doesn't exercise gets the same inert default `duel.ts`'s own rules use. */
function perInstanceRule(id: string, label: string, opts: { condition?: CriteriaNode; costCheck?: CriteriaNode } = {}): RuleSet {
  return {
    id,
    name: label,
    trigger: `never_${id}`,
    stateFilter: null,
    condition: opts.condition ?? null,
    effects: [],
    priority: 0,
    onRejection: 'continue',
    modifier: null,
    continuous: false,
    replaces: null,
    activation: { costCheck: opts.costCheck ?? null, cost: [], window: null, perInstance: true, label },
  };
}

/** `duel`, cloned (it is frozen, §9.2) with `rules` appended and attached to the Grunt template —
 * JSON round-trip rather than `structuredClone`, matching `deepCopyState`'s own established idiom
 * for "this is plain JSON data" (`activation.ts`). */
function defWithRules(rules: RuleSet[]): GameDefinition {
  const clone: GameDefinition = JSON.parse(JSON.stringify(duel));
  clone.ruleSets.push(...rules);
  clone.templates.find((t) => t.id === GRUNT)!.ruleSetIds.push(...rules.map((r) => r.id));
  return clone;
}

/** One Grunt on the (shared) Battlefield, explicitly controlled by seat 0 — `controllerOf` falls
 * back to the holding zone's OWN seat (§4.3), and Battlefield's is `null`, so a shared-zone card
 * needs `controller` set explicitly to read as "seat 0's" at all. */
function boardWithGrunt(def: GameDefinition): PlayState {
  const state = emptyBoard(def, MAIN);
  place(state, def, BF, GRUNT, 'g1');
  state.cards['g1'].controller = 0;
  return state;
}

function renderBattlefield(def: GameDefinition, state: PlayState, viewingSeat: number, onActivate?: (ruleId: string, cardId: string) => void) {
  return render(
    <ZoneView
      zone={def.zones.find((z) => z.id === BATTLEFIELD)!}
      instance={state.zones[BF]}
      definition={def}
      state={state}
      viewingSeat={viewingSeat}
      revealAll={false}
      onActivate={onActivate}
    />
  );
}

describe('§6.7 per-instance activation', () => {
  it('renders a button for a perInstance rule on a card the pinned seat controls', () => {
    const def = defWithRules([perInstanceRule('rs_zap', 'Zap')]);
    renderBattlefield(def, boardWithGrunt(def), 0);
    expect(screen.getByRole('button', { name: 'Zap' })).toBeInTheDocument();
  });

  it("renders none of a card's buttons when the pinned seat is not its controller", () => {
    const def = defWithRules([perInstanceRule('rs_zap', 'Zap')]);
    const state = boardWithGrunt(def);
    state.cards['g1'].controller = 1; // seat 1 controls it; we're pinned to seat 0
    renderBattlefield(def, state, 0);
    expect(screen.queryByRole('button', { name: 'Zap' })).not.toBeInTheDocument();
  });

  it('clicking a button calls onActivate with the rule id and the card id', () => {
    const def = defWithRules([perInstanceRule('rs_zap', 'Zap')]);
    const onActivate = vi.fn();
    renderBattlefield(def, boardWithGrunt(def), 0, onActivate);
    fireEvent.click(screen.getByRole('button', { name: 'Zap' }));
    expect(onActivate).toHaveBeenCalledWith('rs_zap', 'g1');
  });

  it('stops a pointerdown on the button reaching the drag sensor on the slot above it (§6.7)', () => {
    const def = defWithRules([perInstanceRule('rs_zap', 'Zap')]);
    renderBattlefield(def, boardWithGrunt(def), 0);
    const stop = vi.spyOn(Event.prototype, 'stopPropagation');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Zap' }));
    expect(stop).toHaveBeenCalled();
    stop.mockRestore();
  });

  it('renders two perInstance rules side by side, not collapsed', () => {
    const def = defWithRules([perInstanceRule('rs_a', 'A'), perInstanceRule('rs_b', 'B')]);
    renderBattlefield(def, boardWithGrunt(def), 0);
    expect(screen.getByRole('button', { name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'B' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /actions/i })).not.toBeInTheDocument();
  });

  it('collapses three or more perInstance rules into one [Actions] popover', () => {
    const def = defWithRules([perInstanceRule('rs_a', 'A'), perInstanceRule('rs_b', 'B'), perInstanceRule('rs_c', 'C')]);
    renderBattlefield(def, boardWithGrunt(def), 0);

    expect(screen.queryByRole('button', { name: 'A' })).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: /actions/i });
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'B' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'C' })).toBeInTheDocument();
  });

  it('renders an unpayable rule disabled, with the failing cost named in its title (§6.7 task 3)', () => {
    const def = defWithRules([perInstanceRule('rs_zap', 'Zap', { costCheck: UNPAYABLE_COST })]);
    renderBattlefield(def, boardWithGrunt(def), 0);

    const button = screen.getByRole('button', { name: 'Zap' }) as HTMLButtonElement;
    expect(button).toBeDisabled();
    expect(button.title).not.toBe('');
  });

  it('omits a rule entirely when its condition fails, rather than showing it disabled', () => {
    const def = defWithRules([perInstanceRule('rs_hidden', 'Hidden', { condition: NEVER })]);
    renderBattlefield(def, boardWithGrunt(def), 0);
    expect(screen.queryByRole('button', { name: 'Hidden' })).not.toBeInTheDocument();
  });

  it('still renders when the condition is satisfied and there is no cost to fail (control case)', () => {
    const def = defWithRules([perInstanceRule('rs_zap', 'Zap', { condition: ALWAYS })]);
    renderBattlefield(def, boardWithGrunt(def), 0);
    expect(screen.getByRole('button', { name: 'Zap' })).toBeEnabled();
  });

  // §9.4/step 40 gate finding: an activation label names the card ("Use Equipment" on your own
  // face-down library's top card says which card is on top), and a disabled button's `title` comes
  // straight from an internal `costCheck` description that can carry the raw card id. Both are the
  // exact class of disclosure §6.8 already forbids for `effective`/`tags` — not computing the value
  // is the fix, not sanitising it after the fact.
  it('renders no activation button at all on a face-down card the pinned seat controls, and leaks neither the label nor the card id', () => {
    const def = defWithRules([perInstanceRule('rs_zap', 'Use Equipment')]);
    const state = emptyBoard(def, MAIN);
    const deckKey = zoneKey(DECK, 0); // DECK is `faceDown` even to its own owner (duel.ts)
    place(state, def, deckKey, GRUNT, 'c31');

    const { container } = render(
      <ZoneView
        zone={def.zones.find((z) => z.id === DECK)!}
        instance={state.zones[deckKey]}
        definition={def}
        state={state}
        viewingSeat={0}
        revealAll={false}
      />
    );

    expect(container.querySelector('.cb-card-activate')).toBeNull();
    expect(container.innerHTML).not.toContain('Use Equipment');
    expect(container.innerHTML).not.toContain('c31');
  });
});
