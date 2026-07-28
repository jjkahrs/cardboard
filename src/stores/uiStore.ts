/**
 * Camera/viewer state — TECHNICAL_DESIGN.md §3.5. Deliberately outside `sessionStore`: rewinding
 * must not yank the tester's view to another seat or flip override/reveal-all off underneath them.
 * No engine imports, nothing here is part of the rewound domain.
 */

import { create } from 'zustand';

interface UiStore {
  viewingSeat: number;
  revealAll: boolean;
  overrideEnabled: boolean;
  /** the `data-cb-plain` root attribute — reduced-motion / no-illustration mode */
  plainMode: boolean;
  /** v2 §5.9 — read by sessionStore.ts on every dispatch and passed into the engine as
   * `EngineInput.level`. Raw `1 | 2 | 3` rather than importing engine's `LogVerbosity`, matching
   * `viewingSeat`'s own `number` (not `SeatId`) above — this store stays free of engine imports. */
  logVerbosity: 1 | 2 | 3;
  setViewingSeat(seat: number): void;
  setRevealAll(revealAll: boolean): void;
  setOverrideEnabled(overrideEnabled: boolean): void;
  setPlainMode(plainMode: boolean): void;
  setLogVerbosity(level: 1 | 2 | 3): void;
}

export const useUiStore = create<UiStore>((set) => ({
  viewingSeat: 0,
  revealAll: false,
  overrideEnabled: false,
  plainMode: false,
  logVerbosity: 2,
  setViewingSeat: (viewingSeat) => set({ viewingSeat }),
  setRevealAll: (revealAll) => set({ revealAll }),
  setOverrideEnabled: (overrideEnabled) => set({ overrideEnabled }),
  setPlainMode: (plainMode) => set({ plainMode }),
  setLogVerbosity: (logVerbosity) => set({ logVerbosity }),
}));
