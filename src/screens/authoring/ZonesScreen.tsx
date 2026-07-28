import { useId, useState } from 'react';
import { EntityList } from '../../components/ui/EntityList';
import { FormErrors, NumberField, SelectField } from '../../components/ui/fields';
import type { PlayZone } from '../../engine/types';
import { findReferrers, useDefinitionStore, type EditResult } from '../../stores/definitionStore';
import { uniqueName } from './uniqueName';

const SCOPES = [
  { value: 'player', label: 'One per player' },
  { value: 'shared', label: 'One shared by everyone' },
];

const VISIBILITIES = [
  { value: 'faceUp', label: 'Face up — everyone sees it' },
  { value: 'faceDown', label: 'Face down — nobody sees it' },
  { value: 'ownerOnly', label: 'Owner only — a hand' },
];

const LAYOUTS = [
  { value: 'stack', label: 'Stack — one pile' },
  { value: 'fan', label: 'Fan — spread, overlapping' },
  { value: 'row', label: 'Row — side by side' },
  { value: 'grid', label: 'Grid — wrapping rows' },
];

/**
 * `/game/:gameId/zones` — where cards live (§4.5, §6.1). Master list plus a detail pane.
 *
 * Zone names must be unique, and that rule is `schema.ts`'s, checked on the *candidate* definition
 * by the store. So this screen owns no uniqueness logic of its own — it renders the rejection it is
 * handed, and the definition is untouched when it does (A2).
 *
 * The one thing it does own is the *default* name for a new zone: "New zone 2" and up, because an
 * add button that rejects its own second click would be blaming the designer for the app's choice.
 */
export function ZonesScreen() {
  const definition = useDefinitionStore((s) => s.definition);
  const addZone = useDefinitionStore((s) => s.addZone);
  const updateZone = useDefinitionStore((s) => s.updateZone);
  const removeZone = useDefinitionStore((s) => s.removeZone);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const orderedId = useId();

  const selected = definition.zones.find((z) => z.id === selectedId) ?? null;

  const report = (result: EditResult): EditResult => {
    setErrors(result.ok ? [] : result.errors);
    return result;
  };

  const add = () => {
    const result = report(
      addZone({
        name: uniqueName(definition.zones.map((z) => z.name), 'New zone'),
        scope: 'player',
        visibility: 'faceUp',
        layout: 'stack',
        ordered: true,
        maxCapacity: null,
      })
    );
    if (result.ok && result.id !== undefined) setSelectedId(result.id);
  };

  const patch = (patch: Partial<Omit<PlayZone, 'id'>>) => {
    if (selected) report(updateZone(selected.id, patch));
  };

  return (
    <main className="cb-screen">
      <header className="cb-screen__head">
        <h1>Zones</h1>
      </header>
      <p className="cb-hint">
        Every place a card can be: a deck, a hand, a discard pile, the table. A per-player zone is
        created once for each seat when a playtest starts; a shared one exists exactly once.
      </p>

      <div className="cb-master-detail">
        <EntityList
          label="Zones"
          addLabel="Add zone"
          emptyHint="No zones yet. A deck and a hand is the usual starting pair."
          items={definition.zones.map((zone) => ({
            id: zone.id,
            name: zone.name,
            detail: describeZone(zone),
          }))}
          selectedId={selected?.id}
          onSelect={setSelectedId}
          onAdd={add}
          onRename={(id, name) => report(updateZone(id, { name }))}
          onDelete={(id) => void report(removeZone(id))}
          referrersOf={(id) => findReferrers(definition, 'zone', id)}
        />

        <section className="cb-panel cb-detail" aria-label="Zone settings">
          <span className="cb-rough" aria-hidden="true" />
          {selected === null ? (
            <p className="cb-hint">Pick a zone to edit it.</p>
          ) : (
            <>
              <h2>{selected.name}</h2>
              <FormErrors errors={errors} />

              <SelectField
                label="Scope"
                value={selected.scope}
                options={SCOPES}
                onChange={(scope) => patch({ scope: scope as PlayZone['scope'] })}
              />
              <SelectField
                label="Visibility"
                value={selected.visibility}
                options={VISIBILITIES}
                onChange={(visibility) =>
                  patch({ visibility: visibility as PlayZone['visibility'] })
                }
              />
              <SelectField
                label="Layout"
                value={selected.layout}
                options={LAYOUTS}
                onChange={(layout) => patch({ layout: layout as PlayZone['layout'] })}
              />

              <div className="cb-field">
                <label htmlFor={orderedId}>Ordered</label>
                <input
                  id={orderedId}
                  type="checkbox"
                  checked={selected.ordered}
                  onChange={(e) => patch({ ordered: e.target.checked })}
                />
                <span className="cb-hint">
                  Position matters — “top of deck” means something. Off for a table where cards just
                  sit.
                </span>
              </div>

              <NumberField
                label="Maximum cards"
                value={selected.maxCapacity}
                min={1}
                hint="Leave empty for no limit. A move that would overflow is refused, not truncated."
                onChange={(maxCapacity) => patch({ maxCapacity })}
              />
            </>
          )}
        </section>
      </div>
    </main>
  );
}

/** The list's second line: scope, visibility, layout, then the capacity if there is one. */
function describeZone(zone: PlayZone): string {
  const scope = zone.scope === 'player' ? 'per player' : 'shared';
  const visibility = { faceUp: 'face up', faceDown: 'face down', ownerOnly: 'owner only' }[
    zone.visibility
  ];
  const parts = [scope, visibility, zone.layout, zone.ordered ? 'ordered' : 'unordered'];
  if (zone.maxCapacity !== null) parts.push(`max ${zone.maxCapacity}`);
  return parts.join(' · ');
}
