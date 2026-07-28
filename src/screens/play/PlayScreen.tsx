import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDndContext,
  useDndMonitor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type SensorDescriptor,
  type SensorOptions,
} from '@dnd-kit/core';
import { Link, useBlocker, useParams } from 'react-router-dom';
import { CardDragOverlay } from '../../components/dnd/CardDragOverlay';
import {
  moveDestinations,
  zoneRefFromKey,
  type MoveDestination,
} from '../../components/dnd/destinations';
import { parseCardDragId, parseDropId } from '../../components/dnd/ids';
import { ActionStackRail } from '../../components/play/ActionStackRail';
import { EventLogPanel } from '../../components/play/EventLogPanel';
import { InteractionBar } from '../../components/play/InteractionBar';
import { PlayTable } from '../../components/play/PlayTable';
import { PlayToolbar } from '../../components/play/PlayToolbar';
import { type ChooseCardsInteraction } from '../../components/play/PromptBar';
import { validateDefinition } from '../../engine/schema';
import type { GameDefinition, Id, Interaction, LogEntry, PlayState } from '../../engine/types';
import { getGame } from '../../stores/persistence';
import { useSessionStore } from '../../stores/sessionStore';
import { useUiStore } from '../../stores/uiStore';

/** Auto-generated per session; the tester can replace it to reproduce a past game (REQUIREMENTS). */
const autoSeed = () => String(Math.floor(Math.random() * 1_000_000));

/**
 * Pointer-based first — exact against the 10px gap targets, where a rect-overlap heuristic guesses
 * — falling back to rectangles when the pointer is over no droppable at all (§6.5).
 */
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

/** Prompt mode hands `DndContext` no sensors, so the only possible interaction is choosing (§6.7). */
const NO_SENSORS: SensorDescriptor<SensorOptions>[] = [];

/**
 * The one arm whose picker is THE TABLE (§6.5): `chooseCards` highlights candidates on the board
 * and `PromptBar` only narrates. Every other arm is answered inside `InteractionBar` itself — its
 * buttons ARE the picker — so they need none of the board plumbing below (`chosen`, `legalTargets`,
 * the click-means-choose branch) and return `null` here.
 *
 * Narrowing happens HERE, once, at the boundary where the interaction is read. Deliberately no
 * `default:` — a new `Interaction` kind is a compile error right here rather than silently
 * rendering nothing (§8).
 */
function interactionSurface(interaction: Interaction): ChooseCardsInteraction | null {
  switch (interaction.kind) {
    case 'chooseCards':
      return interaction;
    case 'chooseOption':
    case 'chooseNumber':
    case 'chooseSeat':
    case 'priority':
    case 'sealed':
      return null;
  }
}

/**
 * `/game/:gameId/play` — the playtest (§6.4). Its own layout, no authoring rail.
 *
 * The definition is snapshotted into the session at start, so editing the game in another tab
 * mid-playtest cannot reach in. A refresh ends the session (§7.4) — deliberate, and cheap to
 * reverse.
 */
export function PlayScreen() {
  const { gameId } = useParams();
  const [definition, setDefinition] = useState<GameDefinition | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'invalid'>('loading');
  const [errors, setErrors] = useState<string[]>([]);
  const [seed, setSeed] = useState(autoSeed);
  /** `setup` shows the seed panel; `playing` shows the table. Restart returns to `setup` so the
   *  tester can change the seed there rather than needing a second control for it. */
  const [phase, setPhase] = useState<'setup' | 'playing'>('setup');
  const [chosen, setChosen] = useState<Id[]>([]);

  const session = useSessionStore((s) => s.session);
  const startSession = useSessionStore((s) => s.startSession);
  const dispatch = useSessionStore((s) => s.dispatch);
  const overrideEnabled = useUiStore((s) => s.overrideEnabled);
  /** Only to stamp the acting seat onto an `activate` (§6.7); the board reads its own copy. */
  const viewingSeat = useUiStore((s) => s.viewingSeat);

  useEffect(() => {
    if (gameId === undefined) return;
    let cancelled = false;
    void getGame(gameId).then((found) => {
      if (cancelled) return;
      if (!found) {
        setStatus('missing');
        return;
      }
      // The same gate the importer and the authoring store run (§7.2). Starting a session on a
      // definition the engine would choke on produces failures with no useful message.
      const problems = validateDefinition(found);
      if (problems.length > 0) {
        setErrors(problems);
        setStatus('invalid');
        return;
      }
      setDefinition(found);
      setStatus('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  // Leaving discards the session and its log (§6.1), so it is worth one click to confirm.
  const blocker = useBlocker(phase === 'playing');

  const interaction = session?.state.interaction ?? null;
  const prompt = interaction === null ? null : interactionSurface(interaction);
  const promptId = prompt?.promptId ?? null;
  useEffect(() => setChosen([]), [promptId]);

  // 5px, so a click still reaches the card underneath — click-to-place shares this pointer, and a
  // zero-distance sensor would swallow every one of those clicks as a one-pixel drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      const cardId = parseCardDragId(String(active.id));
      const target = over ? parseDropId(String(over.id)) : null;
      if (cardId === null || target === null) return;
      // Blocked targets are disabled droppables, so anything that lands here already passed the
      // capacity probe — or override is on, in which case the engine logs the ⚑ (AC: M4).
      dispatch(
        {
          kind: 'moveCard',
          cardId,
          to: zoneRefFromKey(target.zoneKey),
          position: target.position,
        },
        overrideEnabled
      );
    },
    [dispatch, overrideEnabled]
  );

  if (status === 'missing') {
    return (
      <main className="cb-screen">
        <h1>Game not found</h1>
        <p>No game with id “{gameId}” is stored in this browser.</p>
        <Link to="/">Back to your games</Link>
      </main>
    );
  }

  if (status === 'invalid') {
    return (
      <main className="cb-screen">
        <h1>This game can’t be played</h1>
        <p className="cb-error">Fix these in the editor first — nothing was started.</p>
        <ul className="cb-list">
          {errors.map((error) => (
            <li key={error} className="cb-list__row">
              {error}
            </li>
          ))}
        </ul>
        <Link to={`/game/${gameId}/pools`}>Back to the editor</Link>
      </main>
    );
  }

  if (status === 'loading' || definition === null) {
    return (
      <main className="cb-screen">
        <p>Loading…</p>
      </main>
    );
  }

  if (phase === 'setup' || session === null || session.state.definitionId !== definition.id) {
    return (
      <main className="cb-screen">
        <h1>Play {definition.name}</h1>
        <div className="cb-field">
          <label htmlFor="cb-seed">Shuffle seed</label>
          <input
            id="cb-seed"
            className="cb-input"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
          />
          <span className="cb-hint">
            Same seed, same shuffle — type in the seed of a past game to replay it.
          </span>
        </div>
        <button
          type="button"
          className="cb-btn"
          onClick={() => {
            startSession(definition, seed);
            // Separate from startSession: createPlayState builds the table, `start` fires
            // onGameStart through the normal transaction loop so it lands in the log like
            // everything else.
            dispatch({ kind: 'start' });
            setPhase('playing');
          }}
        >
          Start playtest
        </button>
        <Link to={`/game/${gameId}/pools`}>Back to the editor</Link>
      </main>
    );
  }

  const { state, log } = session;

  return (
    // §6.5: `data-cb-prompt` is set for EVERY interaction kind, not just the card prompt. One rule
    // — while the engine is suspended the board is not draggable and non-targetable cards are
    // greyed. For a `chooseOption` that greys the whole board, which is correct: nothing on the
    // table is an answer, and the grey says so.
    <main className="cb-play" data-cb-prompt={interaction ? '1' : undefined}>
      {blocker.state === 'blocked' && (
        <div className="cb-prompt-bar" role="alert">
          <span>Leave the playtest? The session and its log are discarded.</span>
          <button type="button" className="cb-btn" data-variant="danger" onClick={() => blocker.proceed()}>
            Leave
          </button>
          <button type="button" className="cb-btn" data-variant="ghost" onClick={() => blocker.reset()}>
            Stay
          </button>
        </div>
      )}

      <PlayToolbar
        definition={session.definition}
        state={state}
        log={log}
        onTransition={(toStateId) => dispatch({ kind: 'transition', toStateId }, overrideEnabled)}
        // §6.7's other half — a rule that is not `perInstance` has no card to sit on, so it sits
        // here. Same action, same seat, `cardId: null`.
        onActivate={(ruleId) => dispatch({ kind: 'activate', ruleId, cardId: null, seat: viewingSeat })}
        onRestart={() => setPhase('setup')}
      />

      <DndContext
        sensors={interaction ? NO_SENSORS : sensors}
        collisionDetection={collisionDetection}
        onDragEnd={handleDragEnd}
      >
        <PlayBoard
          definition={session.definition}
          state={state}
          log={log}
          prompt={prompt}
          interaction={interaction}
          chosen={chosen}
          onChoose={(cardId) =>
            setChosen((previous) =>
              previous.includes(cardId)
                ? previous.filter((id) => id !== cardId)
                : [...previous, cardId]
            )
          }
        />
      </DndContext>

      {/* One bar for every kind of pause (§6.5). It owns the pinned-seat gate and the per-kind
          surfaces; `PromptBar` still renders the `chooseCards` arm inside it, unchanged. */}
      {interaction && (
        <InteractionBar interaction={interaction} chosen={chosen} dispatch={dispatch} />
      )}
    </main>
  );
}

interface PlayBoardProps {
  definition: GameDefinition;
  state: PlayState;
  log: LogEntry[];
  prompt: ChooseCardsInteraction | null;
  /** The whole union, not just the card arm: §6.5's one rule for the board applies to EVERY kind,
   *  and §6.5's priority bar also lights the cards its legal responses name. */
  interaction: Interaction | null;
  chosen: Id[];
  onChoose: (cardId: Id) => void;
}

/**
 * The table itself, INSIDE `DndContext` — which is the point of it being its own component.
 *
 * The card being carried is read from dnd-kit (`useDndContext().active`) rather than mirrored into
 * React state by `onDragStart`. A mirrored copy is one missed `onDragEnd` away from a table stuck
 * in carry-mode forever, which is exactly what a synthetic drag produced during browser testing.
 * Derived state cannot desynchronise from its source.
 */
function PlayBoard({ definition, state, log, prompt, interaction, chosen, onChoose }: PlayBoardProps) {
  const suspended = interaction !== null;
  /** Click-to-place: the card picked up by clicking. Dragging is the other input for the same move. */
  const [selected, setSelected] = useState<Id | null>(null);

  const { active } = useDndContext();
  const dragging = active === null ? null : parseCardDragId(String(active.id));
  /** Dragging and click-to-place carry a card the same way; only the input differs. */
  const heldCardId = dragging ?? selected;

  const dispatch = useSessionStore((s) => s.dispatch);
  const rewind = useSessionStore((s) => s.rewind);
  const viewingSeat = useUiStore((s) => s.viewingSeat);
  const revealAll = useUiStore((s) => s.revealAll);
  const overrideEnabled = useUiStore((s) => s.overrideEnabled);

  // Picking a card up with the pointer puts down whatever the keyboard was holding.
  useDndMonitor({ onDragStart: () => setSelected(null) });

  // Any interaction takes the table over (§6.5, §6.7): whatever was picked up is put back down.
  useEffect(() => {
    if (suspended) setSelected(null);
  }, [suspended]);

  // §6.5: a priority offer lights up the cards its per-instance responses name, reusing the set the
  // table already takes rather than minting a second highlight channel. The bar stays the picker —
  // the card's own activate button (§6.7) is the other way to press the same response.
  const legalTargets = useMemo(() => {
    if (prompt) return new Set(prompt.candidates);
    if (interaction?.kind === 'priority') {
      return new Set(interaction.legal.map((l) => l.cardId).filter((id) => id !== null));
    }
    return null;
  }, [prompt, interaction]);

  /** §6.6 — `chooseSeat` highlights the seat BAND, not cards: "pick a thing" reads the same either way. */
  const legalSeats = useMemo(
    () => (interaction?.kind === 'chooseSeat' ? new Set(interaction.candidates) : null),
    [interaction]
  );

  const destinationList = useMemo(
    () => (heldCardId === null ? [] : moveDestinations(definition, state, heldCardId)),
    [definition, state, heldCardId]
  );

  const destinations = useMemo(
    () => (heldCardId === null ? null : new Map(destinationList.map((d) => [d.zoneKey, d]))),
    [destinationList, heldCardId]
  );

  const place = useCallback(
    (destination: MoveDestination) => {
      if (selected === null) return;
      if (destination.blocked !== null && !overrideEnabled) return;
      dispatch(
        { kind: 'moveCard', cardId: selected, to: destination.to, position: destination.position },
        overrideEnabled
      );
      setSelected(null);
    },
    [selected, dispatch, overrideEnabled]
  );

  // Esc puts the card back down; the digits are the badge numbers, which is what makes
  // click-to-place the faster input once a designer knows the board (§6.5).
  useEffect(() => {
    if (selected === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelected(null);
        return;
      }
      const ordinal = Number(e.key);
      if (!Number.isInteger(ordinal) || ordinal < 1) return;
      const destination = destinationList[ordinal - 1];
      if (destination) place(destination);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, destinationList, place]);

  return (
    <>
      <div className="cb-play__main">
        <PlayTable
          definition={definition}
          state={state}
          viewingSeat={viewingSeat}
          revealAll={revealAll}
          legalTargets={legalTargets}
          legalSeats={legalSeats}
          chosen={new Set(chosen)}
          onCardClick={(cardId) => {
            // One click, two meanings, decided by whether the engine is waiting on an answer:
            // while suspended a click is a prompt choice, otherwise it picks the card up.
            if (prompt) {
              onChoose(cardId);
              return;
            }
            // Suspended on an interaction the TABLE cannot answer (§6.6 — an option list, a
            // number, a seat): the board is inert, so a click must not pick a card up either.
            if (suspended) return;
            setSelected((previous) => (previous === cardId ? null : cardId));
          }}
          // §6.7 — the card's own button and the priority bar dispatch the SAME `activate`; the
          // seat is always the pinned one, because you do not activate an opponent's abilities.
          onActivate={(ruleId, cardId) =>
            dispatch({ kind: 'activate', ruleId, cardId, seat: viewingSeat })
          }
          destinations={destinations}
          placing={selected !== null}
          override={overrideEnabled}
          onPlace={place}
          heldCardId={selected}
          dragEnabled={!suspended}
        />
        {/* §6.4 — above the log in the EXISTING right rail, not a second one: horizontal space at
            a five-seat table is the scarce resource, and the rail renders nothing at all while
            `actionStack` is empty, so a v1-shaped game sees precisely the v1 right rail. */}
        <div className="cb-play__rail">
          <ActionStackRail definition={definition} state={state} />
          <EventLogPanel log={log} onRewind={rewind} />
        </div>
      </div>

      <CardDragOverlay
        cardId={dragging}
        definition={definition}
        state={state}
        viewingSeat={viewingSeat}
        revealAll={revealAll}
      />
    </>
  );
}
