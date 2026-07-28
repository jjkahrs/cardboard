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
  setViewingSeat(seat: number): void;
  setRevealAll(revealAll: boolean): void;
  setOverrideEnabled(overrideEnabled: boolean): void;
  setPlainMode(plainMode: boolean): void;
}

export const useUiStore = create<UiStore>((set) => ({
  viewingSeat: 0,
  revealAll: false,
  overrideEnabled: false,
  plainMode: false,
  setViewingSeat: (viewingSeat) => set({ viewingSeat }),
  setRevealAll: (revealAll) => set({ revealAll }),
  setOverrideEnabled: (overrideEnabled) => set({ overrideEnabled }),
  setPlainMode: (plainMode) => set({ plainMode }),
}));
