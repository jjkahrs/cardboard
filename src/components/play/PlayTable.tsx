import {
  ACTIVE_PLAYER_POOL_ID,
  type GameDefinition,
  type Id,
  type PlayState,
  type ZoneKey,
} from '../../engine/types';
import { zoneKey } from '../../engine/valueRef';
import type { MoveDestination } from '../dnd/destinations';
import { PoolReadout } from './PoolReadout';
import { ZoneView } from './ZoneView';

export interface PlayTableProps {
  definition: GameDefinition;
  state: PlayState;
  viewingSeat: number;
  revealAll: boolean;
  /** Ids the open prompt would accept; `null` when the engine is not suspended. */
  legalTargets?: Set<Id> | null;
  /** Seats a `chooseSeat` interaction would accept (§6.6); `null` when none is open. Not wired by
   * this step — a sibling's `chooseSeat` arm passes it once it exists. */
  legalSeats?: Set<number> | null;
  chosen?: Set<Id>;
  onCardClick?: (cardId: Id) => void;
  /** §6.7 — a per-instance activation pressed on a card. Ids only; `PlayScreen` owns the dispatch. */
  onActivate?: (ruleId: Id, cardId: Id) => void;
  /** Where the carried card may go, keyed by zone (§6.5); `null` when nothing is carried. */
  destinations?: Map<ZoneKey, MoveDestination> | null;
  placing?: boolean;
  override?: boolean;
  onPlace?: (destination: MoveDestination) => void;
  heldCardId?: Id | null;
  dragEnabled?: boolean;
}

/**
 * The three bands (§6.4): opponents on top, shared zones in the middle, the viewing seat at the
 * bottom.
 *
 * One rule covers 2–4 seats — "every seat that isn't you, in equal columns" — so nothing
 * special-cases the seat count and switching who "you" are only re-keys the bands.
 */
export function PlayTable({
  definition,
  state,
  viewingSeat,
  revealAll,
  legalTargets = null,
  legalSeats = null,
  chosen,
  onCardClick,
  onActivate,
  destinations = null,
  placing = false,
  override = false,
  onPlace,
  heldCardId = null,
  dragEnabled = false,
}: PlayTableProps) {
  // §6.3 amendment 1 — ring order, not array order. Walked forward from the seat after the pinned
  // one, so the strip reads left-to-right as prey through predator; `relative`/`next`/`previous`
  // (§4.1) are positional, and a strip in array order would disagree with them at 5 seats.
  const pinnedIndex = state.seatOrder.indexOf(viewingSeat);
  const opponents =
    pinnedIndex < 0
      ? []
      : [...state.seatOrder.slice(pinnedIndex + 1), ...state.seatOrder.slice(0, pinnedIndex)];
  // §6.3 amendment 3 — ousted seats render after the live ring, never inline, and the pinned seat's
  // own band (below) already covers it if it is itself the eliminated one.
  const eliminatedOpponents = state.eliminated.filter((seat) => seat !== viewingSeat);
  const sharedZones = definition.zones.filter((zone) => zone.scope === 'shared');
  const activeSeat = state.pools[ACTIVE_PLAYER_POOL_ID];

  const zoneProps = {
    definition,
    state,
    viewingSeat,
    revealAll,
    legalTargets,
    chosen,
    onCardClick,
    onActivate,
    destinations,
    placing,
    override,
    onPlace,
    heldCardId,
    dragEnabled,
  };

  return (
    <div className="cb-table">
      <div className="cb-band cb-band--opponents" aria-label="Opponents">
        {opponents.map((seat) => (
          <SeatBand
            key={seat}
            seat={seat}
            active={activeSeat === seat}
            legalTarget={legalSeats?.has(seat) ?? false}
            definition={definition}
            state={state}
            zoneProps={zoneProps}
          />
        ))}
        {eliminatedOpponents.map((seat) => (
          <SeatBand
            key={seat}
            seat={seat}
            active={false}
            eliminated
            legalTarget={legalSeats?.has(seat) ?? false}
            definition={definition}
            state={state}
            zoneProps={zoneProps}
          />
        ))}
      </div>

      <div className="cb-band cb-band--shared" aria-label="Shared zones">
        {sharedZones.map((zone) => {
          const instance = state.zones[zoneKey(zone.id, null)];
          return instance ? (
            <ZoneView key={zone.id} zone={zone} instance={instance} {...zoneProps} />
          ) : null;
        })}
        <PoolReadout definition={definition} state={state} seat={null} />
      </div>

      <div className="cb-band cb-band--own" aria-label={`Your seat (player ${viewingSeat + 1})`}>
        {/* §6.3 — "a pinned seat that is eliminated stays pinned": this band always renders
            `viewingSeat`, elimination or not, so nothing here ever has to notice the difference. */}
        <SeatBand
          seat={viewingSeat}
          active={activeSeat === viewingSeat}
          eliminated={state.eliminated.includes(viewingSeat)}
          legalTarget={legalSeats?.has(viewingSeat) ?? false}
          definition={definition}
          state={state}
          zoneProps={zoneProps}
        />
      </div>
    </div>
  );
}

type ZoneProps = Omit<Parameters<typeof ZoneView>[0], 'zone' | 'instance'>;

function SeatBand({
  seat,
  active,
  eliminated = false,
  legalTarget = false,
  definition,
  state,
  zoneProps,
}: {
  seat: number;
  active: boolean;
  /** §6.3 amendment 3 — greyed, slashed, still shows its zones under the normal visibility rules. */
  eliminated?: boolean;
  /** §6.6 — `chooseSeat` highlight, the seat-level twin of `data-legal-target` on a card slot. */
  legalTarget?: boolean;
  definition: GameDefinition;
  state: PlayState;
  zoneProps: ZoneProps;
}) {
  const zones = definition.zones.filter((zone) => zone.scope === 'player');

  return (
    <section
      className="cb-seat"
      data-active={active}
      data-eliminated={eliminated}
      data-legal-target={legalTarget ? true : undefined}
      aria-label={`Player ${seat + 1}`}
    >
      <h2 className="cb-seat__title">Player {seat + 1}</h2>
      <div className="cb-seat__zones">
        {zones.map((zone) => {
          const instance = state.zones[zoneKey(zone.id, seat)];
          return instance ? (
            <ZoneView key={zone.id} zone={zone} instance={instance} {...zoneProps} />
          ) : null;
        })}
      </div>
      <PoolReadout definition={definition} state={state} seat={seat} />
    </section>
  );
}
