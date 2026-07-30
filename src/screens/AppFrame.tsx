/**
 * The route table's pathless root layout (v3 §4.3). It adds no URL segment; it exists so the
 * file-drop guard is mounted on EVERY route rather than on the two screens that happen to want drops
 * today — a stray drop on the play screen would otherwise navigate the tab to the file and take the
 * (unpersisted) playtest with it. The header toolbar hangs here for the same reason: one mount,
 * every route.
 *
 * Its own file rather than a local function in `routes.tsx`: that module exports the route table,
 * and a component beside a non-component export breaks fast refresh.
 */

import { Link, Outlet } from 'react-router-dom';
import { useFileDropGuard } from './useFileDrop';

export function AppFrame() {
  useFileDropGuard();
  return (
    <>
      {/* The app's only global chrome. It is fixed-height (--cb-topbar-h) because the two full-bleed
          layouts under it — .cb-shell and .cb-play — size themselves against the viewport and have to
          subtract it. */}
      <header className="cb-topbar">
        <span className="cb-topbar__title">Cardboard</span>
        <nav aria-label="Main">
          <Link to="/" className="cb-topbar__link">
            Games
          </Link>
        </nav>
      </header>
      <Outlet />
    </>
  );
}
