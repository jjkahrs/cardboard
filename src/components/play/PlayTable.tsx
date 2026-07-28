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
  chosen?: Set<Id>;
  onCardClick?: (cardId: Id) => void;
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
  chosen,
  onCardClick,
  destinations = null,
  placing = false,
  override = false,
  onPlace,
  heldCardId = null,
  dragEnabled = false,
}: PlayTableProps) {
  const seats = Array.from({ length: state.playerCount }, (_, i) => i);
  const opponents = seats.filter((seat) => seat !== viewingSeat);
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
        <SeatBand
          seat={viewingSeat}
          active={activeSeat === viewingSeat}
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
  definition,
  state,
  zoneProps,
}: {
  seat: number;
  active: boolean;
  definition: GameDefinition;
  state: PlayState;
  zoneProps: ZoneProps;
}) {
  const zones = definition.zones.filter((zone) => zone.scope === 'player');

  return (
    <section className="cb-seat" data-active={active} aria-label={`Player ${seat + 1}`}>
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
