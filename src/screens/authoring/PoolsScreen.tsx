import { useState } from 'react';
import { GameValueFields } from '../../components/authoring/GameValueFields';
import { EntityList } from '../../components/ui/EntityList';
import { FormErrors, SelectField } from '../../components/ui/fields';
import { ACTIVE_PLAYER_POOL_ID } from '../../engine/types';
import type { GameValue, PointPool } from '../../engine/types';
import { findReferrers, useDefinitionStore, type EditResult } from '../../stores/definitionStore';
import { uniqueName } from './uniqueName';

/**
 * `/game/:gameId/pools` — the point pools (§4.1, §6.1). Master list plus a detail pane.
 *
 * The pane edits `pool.value`, never a local mirror of it: every control writes through
 * `updatePool` and re-renders from the store, so a rejected edit (min > max) leaves the screen
 * showing what is actually stored rather than a value the definition never accepted (A1, P3).
 *
 * A pool's display name lives at `value.name`, so `<EntityList>`'s rename hands back a whole
 * `GameValue` — that is also why there is no name control in the pane: one field, one owner.
 */
export function PoolsScreen() {
  const definition = useDefinitionStore((s) => s.definition);
  const addPool = useDefinitionStore((s) => s.addPool);
  const updatePool = useDefinitionStore((s) => s.updatePool);
  const removePool = useDefinitionStore((s) => s.removePool);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const selected = definition.pools.find((p) => p.id === selectedId) ?? null;

  /** Every store call funnels through here, so no action can forget to surface its rejection. */
  const report = (result: EditResult): EditResult => {
    setErrors(result.ok ? [] : result.errors);
    return result;
  };

  const add = () => {
    const name = uniqueName(definition.pools.map((p) => p.value.name), 'New pool');
    const result = report(
      addPool({ scope: 'player', value: { type: 'integer', name, defaultValue: 0, min: null, max: null } })
    );
    if (result.ok && result.id !== undefined) setSelectedId(result.id);
  };

  const patchValue = (pool: PointPool, value: GameValue) => void report(updatePool(pool.id, { value }));
  const setScope = (pool: PointPool, scope: PointPool['scope']) =>
    void report(updatePool(pool.id, { scope }));

  return (
    <main className="cb-screen">
      <header className="cb-screen__head">
        <h1>Pools</h1>
      </header>
      <p className="cb-hint">
        Counters the game tracks: player HP, a shared round number, a “first blood” flag. Anything a
        rule can read or change. Every pool is offered wherever a value is picked.
      </p>

      <div className="cb-master-detail">
        <EntityList
          label="Pools"
          addLabel="Add pool"
          emptyHint="No pools yet. Most games want at least one — a life total, a score, a resource."
          items={definition.pools.map((pool) => ({
            id: pool.id,
            name: pool.value.name,
            detail: describePool(pool),
          }))}
          selectedId={selected?.id}
          onSelect={setSelectedId}
          onAdd={add}
          onRename={(id, name) => {
            const pool = definition.pools.find((p) => p.id === id);
            if (!pool) return { ok: false, errors: [`No pool with id "${id}".`] };
            return report(updatePool(id, { value: { ...pool.value, name } }));
          }}
          onDelete={(id) => void report(removePool(id))}
          referrersOf={(id) => findReferrers(definition, 'pool', id)}
        />

        <section className="cb-panel cb-detail" aria-label="Pool settings">
          <span className="cb-rough" aria-hidden="true" />
          {selected === null ? (
            <p className="cb-hint">Pick a pool to edit it.</p>
          ) : (
            <PoolDetail pool={selected} errors={errors} onScope={setScope} onValue={patchValue} />
          )}
        </section>
      </div>

      <p className="cb-hint">
        “{ACTIVE_PLAYER_POOL_ID}” is created for you when a playtest starts, and only your own rules
        ever write it — you don’t need to add it here.
      </p>
    </main>
  );
}

/** The pane. The value half is `<GameValueFields>` — the same six controls a card number uses. */
function PoolDetail({
  pool,
  errors,
  onScope,
  onValue,
}: {
  pool: PointPool;
  errors: string[];
  onScope: (pool: PointPool, scope: PointPool['scope']) => void;
  onValue: (pool: PointPool, value: GameValue) => void;
}) {
  return (
    <>
      <h2>{pool.value.name}</h2>
      <FormErrors errors={errors} />

      <SelectField
        label="Scope"
        value={pool.scope}
        options={[
          { value: 'player', label: 'One per player' },
          { value: 'game', label: 'One for the whole game' },
        ]}
        onChange={(scope) => onScope(pool, scope as PointPool['scope'])}
      />

      {/* The name is renamed in the list, so it is not offered twice. */}
      <GameValueFields
        value={pool.value}
        showName={false}
        onChange={(value) => onValue(pool, value)}
      />
    </>
  );
}

/** The list's second line. Scope first, because it is what changes how a rule reads. */
function describePool(pool: PointPool): string {
  const scope = pool.scope === 'player' ? 'per player' : 'whole game';
  if (pool.value.type === 'boolean') return `${scope} · true/false, starts ${pool.value.defaultValue}`;
  const { defaultValue, min, max } = pool.value;
  const bounds = min === null && max === null ? 'unbounded' : `${min ?? '−∞'}…${max ?? '∞'}`;
  return `${scope} · number, starts ${defaultValue}, ${bounds}`;
}
