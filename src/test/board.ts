/**
 * Hand-built `PlayState` boards for tests that need a specific table rather than a fresh deal.
 *
 * `createPlayState` deals 40 shuffled cards; almost every assertion about a zone, a prompt or a
 * rendered card wants four named cards in known places instead. Extracted from `dispatch.test.ts`
 * when the play components needed the same two helpers.
 */

import { createPlayState } from '../engine/setup';
import { parseZoneKey } from '../engine/valueRef';
import { START_STATE_ID, type GameDefinition, type Id, type PlayState } from '../engine/types';

/** A real state with every card removed — zones instanced, pools defaulted, nothing dealt. */
export function emptyBoard(def: GameDefinition, currentStateId: Id = START_STATE_ID): PlayState {
  const state = createPlayState(def, 'seed');
  state.cards = {};
  for (const key of Object.keys(state.zones)) state.zones[key].cardIds = [];
  state.rngCursor = 0;
  state.nextSeq = 0;
  state.currentStateId = currentStateId;
  return state;
}

/** Puts one card of `templateId` at the bottom of `key`, with the given id. Returns the id. */
export function place(
  state: PlayState,
  def: GameDefinition,
  key: string,
  templateId: Id,
  id: Id
): Id {
  const template = def.templates.find((t) => t.id === templateId);
  const indexValues: Record<Id, number | boolean> = {};
  for (const index of template?.indexes ?? []) indexValues[index.id] = index.value.defaultValue;
  // Identity fields seeded the same way `createPlayState` deals them (§4.3), so a hand-built board
  // is indistinguishable from a dealt one for anything that reads owner or tags.
  state.cards[id] = {
    id,
    templateId,
    indexValues,
    faceDown: false,
    rotated: false,
    tags: [...(template?.tags ?? [])],
    owner: parseZoneKey(key).seat,
    controller: null,
    attachedTo: null,
  };
  state.zones[key].cardIds.push(id);
  return id;
}
