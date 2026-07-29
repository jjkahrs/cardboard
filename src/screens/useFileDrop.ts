/**
 * v3 §4.2 — dropping a game file on the window.
 *
 * Window-level rather than a wrapper element: the target the user aims at is "the app", and a
 * bounded div means a drop two pixels outside it navigates the tab to the file instead of importing
 * it. `App.tsx` holds a matching preventDefault for the screens that mount no handler at all (§4.3).
 *
 * Returns whether a file drag is currently over the window, so the caller can say what a drop WOULD
 * do before it happens (IM10) — the only warning a destructive drop gets.
 */

import { useEffect, useRef, useState } from 'react';

/**
 * v3 §4.3 (IM7). Only two screens handle drops; everywhere else the browser's default is to navigate
 * the tab to the dropped file — and on the play screen that ends the playtest, because sessions are
 * not persisted. Mounted once by the route table's root layout so it covers every route, including
 * the ones that will exist later. Stops nothing propagating, so `useFileDrop`'s own handlers still
 * run where they are mounted; preventDefault from either is enough.
 */
export function useFileDropGuard(): void {
  useEffect(() => {
    const stop = (e: DragEvent): void => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);
}

export function useFileDrop(onFile: (file: File) => void): boolean {
  const [dragging, setDragging] = useState(false);
  // A ref, so a caller that re-renders (every screen does) doesn't tear down and re-add four window
  // listeners mid-drag — which would lose the depth count below and strobe the overlay.
  const handler = useRef(onFile);
  handler.current = onFile;

  useEffect(() => {
    // A counter, not a boolean: `dragleave` fires every time the pointer crosses into a child
    // element, so clearing on any leave makes the affordance flicker across the whole page.
    let depth = 0;
    const isFiles = (e: DragEvent): boolean => e.dataTransfer?.types.includes('Files') ?? false;

    const onEnter = (e: DragEvent): void => {
      if (!isFiles(e)) return;
      depth += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent): void => {
      if (!isFiles(e)) return;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    // preventDefault on dragover is what makes the window a drop target at all. Without it the
    // browser refuses the drop and then navigates to the file on release.
    const onOver = (e: DragEvent): void => {
      if (isFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent): void => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      // First file only. A multi-file drop is a slip, not an error worth a message — importing one
      // game is the outcome the user was reaching for. No extension filter either: a valid export
      // saved as .txt still imports, and a file that isn't one gets a real message from gate 1.
      const file = e.dataTransfer?.files[0];
      if (file) handler.current(file);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return dragging;
}
