import { Navigate, type RouteObject } from 'react-router-dom';
import { AppFrame } from './screens/AppFrame';
import { AuthoringLayout } from './screens/AuthoringLayout';
import { GameListScreen } from './screens/GameListScreen';
import { NotFoundScreen } from './screens/NotFoundScreen';
import { PlayScreen } from './screens/play/PlayScreen';
import { CardEditorScreen } from './screens/authoring/CardEditorScreen';
import { CatalogScreen } from './screens/authoring/CatalogScreen';
import { DecksScreen } from './screens/authoring/DecksScreen';
import { EventsScreen } from './screens/authoring/EventsScreen';
import { PoolsScreen } from './screens/authoring/PoolsScreen';
import { PriorityWindowsScreen } from './screens/authoring/PriorityWindowsScreen';
import { RuleSetEditorScreen } from './screens/authoring/RuleSetEditorScreen';
import { RuleSetsScreen } from './screens/authoring/RuleSetsScreen';
import { StateMachineScreen } from './screens/authoring/StateMachineScreen';
import { ZonesScreen } from './screens/authoring/ZonesScreen';

/**
 * §6.1's route table. Hash routing (see App) because there is no backend to configure an SPA
 * fallback on.
 *
 * The card editor and rule editor are full routes, not modals: both are large and both are link
 * targets from elsewhere, and modals that deep-link are a bug farm.
 *
 * Every route now points at its real screen; `UnbuiltScreen`, which stood in for the later steps,
 * went with the last of them (step 25).
 */
const screens: RouteObject[] = [
  { path: '/', element: <GameListScreen /> },
  {
    path: '/game/:gameId',
    element: <AuthoringLayout />,
    children: [
      { index: true, element: <Navigate to="pools" replace /> },
      { path: 'pools', element: <PoolsScreen /> },
      { path: 'cards', element: <CatalogScreen /> },
      { path: 'cards/:cardId', element: <CardEditorScreen /> },
      { path: 'zones', element: <ZonesScreen /> },
      { path: 'decks', element: <DecksScreen /> },
      { path: 'events', element: <EventsScreen /> },
      { path: 'rules', element: <RuleSetsScreen /> },
      { path: 'rules/:ruleSetId', element: <RuleSetEditorScreen /> },
      // Between rules and states (§6.12): a window is referenced BY rules and references nothing
      // itself, and the rail reads in authoring order.
      { path: 'priority', element: <PriorityWindowsScreen /> },
      { path: 'states', element: <StateMachineScreen /> },
    ],
  },
  // Play has its own layout and no rail (§6.1), so it is a sibling of the authoring layout, not a
  // child of it.
  { path: '/game/:gameId/play', element: <PlayScreen /> },
  { path: '*', element: <NotFoundScreen /> },
];

/** Every screen under one pathless layout, so `AppFrame`'s drop guard covers every route (v3 §4.3). */
export const routes: RouteObject[] = [{ element: <AppFrame />, children: screens }];
