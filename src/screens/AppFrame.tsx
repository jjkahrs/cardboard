/**
 * The route table's pathless root layout (v3 §4.3). It renders nothing of its own and adds no URL
 * segment; it exists so the file-drop guard is mounted on EVERY route rather than on the two
 * screens that happen to want drops today — a stray drop on the play screen would otherwise
 * navigate the tab to the file and take the (unpersisted) playtest with it.
 *
 * Its own file rather than a local function in `routes.tsx`: that module exports the route table,
 * and a component beside a non-component export breaks fast refresh.
 */

import { Outlet } from 'react-router-dom';
import { useFileDropGuard } from './useFileDrop';

export function AppFrame() {
  useFileDropGuard();
  return <Outlet />;
}
