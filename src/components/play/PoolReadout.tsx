import { ACTIVE_PLAYER_POOL_ID, type GameDefinition, type PlayState } from '../../engine/types';

/**
 * The pool line under a seat (`HP 20  ⚡3`) or under the shared band (§6.4).
 *
 * `seat === null` reads the game-scoped pools, a seat index the per-seat ones. `activePlayer` is
 * skipped: the toolbar already names it, and it is the one pool nobody thinks of as a resource.
 */
export function PoolReadout({
  definition,
  state,
  seat,
}: {
  definition: GameDefinition;
  state: PlayState;
  seat: number | null;
}) {
  const scope = seat === null ? 'game' : 'player';
  const pools = definition.pools.filter(
    (pool) => pool.scope === scope && pool.id !== ACTIVE_PLAYER_POOL_ID
  );
  if (pools.length === 0) return null;

  return (
    <div className="cb-pools">
      {pools.map((pool) => {
        const raw = seat === null ? state.pools[pool.id] : state.playerPools[pool.id]?.[seat];
        const value = raw ?? pool.value.defaultValue;
        return (
          <span key={pool.id} className="cb-pool">
            <span className="cb-pool__name">{pool.value.name}</span>
            <b>{typeof value === 'boolean' ? (value ? 'yes' : 'no') : value}</b>
          </span>
        );
      })}
    </div>
  );
}
