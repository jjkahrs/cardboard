import { useState } from 'react';
import { StateGraph } from '../../components/authoring/StateGraph';
import { machineWarnings } from '../../components/authoring/machineWarnings';
import { CriteriaGroupEditor } from '../../components/criteria/CriteriaGroupEditor';
import { FormErrors, InlineNumber } from '../../components/ui/fields';
import type { CriteriaGroup, CriteriaNode, MachineState } from '../../engine/types';
import { findReferrers, useDefinitionStore, type EditResult } from '../../stores/definitionStore';
import { uniqueName } from './uniqueName';

const asGroup = (node: CriteriaNode): CriteriaGroup =>
  node.kind === 'group' ? node : { kind: 'group', combinator: 'and', children: [node] };

/**
 * `/game/:gameId/states` — the state machine (§4.8, §5.6).
 *
 * Transitions are edited as two checkbox lists, "can go to" and "can come from", and each one
 * writes BOTH sides through `connectStates`: a legal transition is `A.exitableTo` ∋ B **and**
 * `B.enterableFrom` ∋ A, and a one-sided edge is nearly always the designer ticking one box and
 * forgetting the mirror. Making that unrepresentable in the editor is cheaper than reporting it.
 */
export function StateMachineScreen() {
  const definition = useDefinitionStore((s) => s.definition);
  const addState = useDefinitionStore((s) => s.addState);
  const updateState = useDefinitionStore((s) => s.updateState);
  const removeState = useDefinitionStore((s) => s.removeState);
  const connectStates = useDefinitionStore((s) => s.connectStates);
  const disconnectStates = useDefinitionStore((s) => s.disconnectStates);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const machine = definition.machine;
  const selected = machine.states.find((s) => s.id === selectedId) ?? null;
  const warnings = machineWarnings(machine);

  const report = (result: EditResult): EditResult => {
    setErrors(result.ok ? [] : result.errors);
    return result;
  };

  const add = () => {
    const count = machine.states.length;
    const result = report(
      addState({
        name: uniqueName(machine.states.map((s) => s.name), 'New state'),
        enterableFrom: [],
        exitableTo: [],
        entryCriteria: null,
        transitionLabel: 'Continue',
        priority: 0,
        // Laid out in a row of four, so a new state never lands exactly on top of an old one.
        position: { x: 40 + (count % 4) * 180, y: 40 + Math.floor(count / 4) * 120 },
      })
    );
    if (result.ok && result.id !== undefined) setSelectedId(result.id);
  };

  const setEdge = (from: string, to: string, on: boolean) =>
    void report(on ? connectStates(from, to) : disconnectStates(from, to));

  return (
    <main className="cb-screen">
      <header className="cb-screen__head">
        <h1>States</h1>
        <button type="button" className="cb-btn" onClick={add}>
          Add state
        </button>
      </header>
      <p className="cb-hint">
        Turns, phases, steps — whatever structure your game has. Drag a state to arrange it; arrow
        keys move the selected one.
      </p>

      <FormErrors errors={errors} />
      {warnings.length > 0 && (
        <ul className="cb-list" aria-label="Warnings">
          {warnings.map((warning) => (
            <li key={warning} className="cb-list__row cb-warning">
              {warning}
            </li>
          ))}
        </ul>
      )}

      <div className="cb-master-detail cb-master-detail--canvas">
        <div className="cb-state-canvas__scroll">
          <StateGraph
            machine={machine}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onMove={(id, position) => void report(updateState(id, { position }))}
          />
        </div>

        <section className="cb-panel cb-detail" aria-label="State settings">
          <span className="cb-rough" aria-hidden="true" />
          {selected === null ? (
            <p className="cb-hint">Pick a state to edit it.</p>
          ) : (
            <StateDetail
              state={selected}
              states={machine.states}
              reserved={selected.id === machine.startStateId || selected.id === machine.endStateId}
              onUpdate={(patch) => void report(updateState(selected.id, patch))}
              onEdge={setEdge}
              onDelete={() => {
                const result = report(removeState(selected.id));
                if (result.ok) setSelectedId(null);
              }}
              referrers={findReferrers(definition, 'state', selected.id).length}
            />
          )}
        </section>
      </div>

    </main>
  );
}

function StateDetail({
  state,
  states,
  reserved,
  onUpdate,
  onEdge,
  onDelete,
  referrers,
}: {
  state: MachineState;
  states: MachineState[];
  reserved: boolean;
  onUpdate: (patch: Partial<Omit<MachineState, 'id'>>) => void;
  onEdge: (from: string, to: string, on: boolean) => void;
  onDelete: () => void;
  referrers: number;
}) {
  const others = states.filter((s) => s.id !== state.id);

  return (
    <>
      <h2>{state.name}</h2>

      {/* The node on the canvas IS the state's text alternative — it is a button carrying the name,
          so renaming lives here rather than in a second list that would say everything twice. */}
      <div className="cb-field">
        <label htmlFor="cb-state-name">Name</label>
        <input
          id="cb-state-name"
          className="cb-input"
          value={state.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
        />
      </div>

      <span className="cb-rule__meta">
        {'priority '}
        <InlineNumber
          label="Priority"
          value={state.priority}
          onChange={(priority) => onUpdate({ priority })}
        />
        <span className="cb-hint">breaks ties when two transitions are eligible at once</span>
      </span>

      <fieldset className="cb-fieldset">
        <legend>Can go to</legend>
        {others.map((other) => (
          <label key={other.id} className="cb-radio">
            <input
              type="checkbox"
              checked={state.exitableTo.includes(other.id)}
              onChange={(e) => onEdge(state.id, other.id, e.target.checked)}
            />
            {other.name}
          </label>
        ))}
      </fieldset>

      <fieldset className="cb-fieldset">
        <legend>Can come from</legend>
        {others.map((other) => (
          <label key={other.id} className="cb-radio">
            <input
              type="checkbox"
              checked={state.enterableFrom.includes(other.id)}
              onChange={(e) => onEdge(other.id, state.id, e.target.checked)}
            />
            {other.name}
          </label>
        ))}
      </fieldset>

      <h3>Entered</h3>
      {state.entryCriteria === null ? (
        <>
          <div className="cb-field">
            <label htmlFor="cb-transition-label">Button text</label>
            <input
              id="cb-transition-label"
              className="cb-input"
              value={state.transitionLabel ?? ''}
              placeholder="End turn"
              onChange={(e) => onUpdate({ transitionLabel: e.target.value })}
            />
            <span className="cb-hint">
              No criteria, so this is a button on the play toolbar the tester presses.
            </span>
          </div>
          <button
            type="button"
            className="cb-btn"
            onClick={() => onUpdate({ entryCriteria: { kind: 'group', combinator: 'and', children: [] } })}
          >
            Enter automatically instead
          </button>
        </>
      ) : (
        <>
          <span className="cb-hint">
            {state.entryCriteria.kind === 'group' && state.entryCriteria.children.length === 0
              ? 'No criteria yet, so this state is never entered — add at least one.'
              : 'Entered on its own as soon as this holds, once nothing else is mid-rule.'}
          </span>
          <CriteriaGroupEditorHost node={state.entryCriteria} onUpdate={onUpdate} />
        </>
      )}

      {reserved ? (
        <p className="cb-hint">Start and End are part of every game and cannot be removed.</p>
      ) : (
        <button
          type="button"
          className="cb-btn"
          data-variant="danger"
          disabled={referrers > 0}
          onClick={onDelete}
        >
          {referrers > 0 ? `In use by ${referrers} place(s)` : 'Delete this state'}
        </button>
      )}
    </>
  );
}

/** Split only to keep the criteria/definition wiring out of the panel's own signature. */
function CriteriaGroupEditorHost({
  node,
  onUpdate,
}: {
  node: CriteriaNode;
  onUpdate: (patch: Partial<Omit<MachineState, 'id'>>) => void;
}) {
  const definition = useDefinitionStore((s) => s.definition);
  return (
    <CriteriaGroupEditor
      node={asGroup(node)}
      definition={definition}
      onChange={(entryCriteria) => onUpdate({ entryCriteria })}
      // Removing the criteria makes the transition manual again — the button, not automatic entry.
      onDelete={() => onUpdate({ entryCriteria: null, transitionLabel: 'Continue' })}
    />
  );
}
