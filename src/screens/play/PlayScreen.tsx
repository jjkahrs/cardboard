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
import { EventLogPanel } from '../../components/play/EventLogPanel';
import { PlayTable } from '../../components/play/PlayTable';
import { PlayToolbar } from '../../components/play/PlayToolbar';
import { PromptBar, type ChooseCardsInteraction } from '../../components/play/PromptBar';
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
 * Picks the surface a raised `Interaction` renders as. Narrowing happens HERE, once, at the
 * boundary where the interaction is read — everything downstream (the table's legal-target
 * highlighting, `PromptBar` itself) sees the arm, not the union.
 *
 * Deliberately no `default:`. The declared return type excludes `undefined`, so the moment phase 2
 * adds an `Interaction` kind this switch stops being exhaustive and fails to compile right here,
 * instead of silently rendering nothing at all (§8).
 */
function interactionSurface(interaction: Interaction): ChooseCardsInteraction {
  switch (interaction.kind) {
    case 'chooseCards':
      return interaction;
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
    <main className="cb-play" data-cb-prompt={prompt ? '1' : undefined}>
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
        onRestart={() => setPhase('setup')}
      />

      <DndContext
        sensors={prompt ? NO_SENSORS : sensors}
        collisionDetection={collisionDetection}
        onDragEnd={handleDragEnd}
      >
        <PlayBoard
          definition={session.definition}
          state={state}
          log={log}
          prompt={prompt}
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

      {prompt && (
        <PromptBar
          prompt={prompt}
          chosen={chosen}
          onConfirm={() => dispatch({ kind: 'answerPrompt', chosen })}
          onCancel={() => dispatch({ kind: 'cancelPrompt' })}
        />
      )}
    </main>
  );
}

interface PlayBoardProps {
  definition: GameDefinition;
  state: PlayState;
  log: LogEntry[];
  prompt: ChooseCardsInteraction | null;
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
function PlayBoard({ definition, state, log, prompt, chosen, onChoose }: PlayBoardProps) {
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

  // A prompt takes the table over (§6.7): whatever was picked up is put back down.
  const promptId = prompt?.promptId ?? null;
  useEffect(() => {
    if (promptId !== null) setSelected(null);
  }, [promptId]);

  const legalTargets = useMemo(
    () => (prompt ? new Set(prompt.candidates) : null),
    [prompt]
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
          chosen={new Set(chosen)}
          onCardClick={(cardId) => {
            // One click, two meanings, decided by whether the engine is waiting on an answer:
            // while suspended a click is a prompt choice, otherwise it picks the card up.
            if (prompt) {
              onChoose(cardId);
              return;
            }
            setSelected((previous) => (previous === cardId ? null : cardId));
          }}
          destinations={destinations}
          placing={selected !== null}
          override={overrideEnabled}
          onPlace={place}
          heldCardId={selected}
          dragEnabled={!prompt}
        />
        <EventLogPanel log={log} onRewind={rewind} />
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
