/**
 * useAutosave — debounced crash-recovery autosave (upstream #211).
 *
 * Subscribes to timeline project changes and pushes a snapshot to the main
 * process at most once every `debounceMs`. The snapshot is written to a
 * dedicated recovery file (never the user's .vproj), so an unexpected exit
 * loses at most a few seconds of work instead of the whole session.
 *
 * A clean explicit save is a second lifecycle event: cancel a pending write
 * and clear the current session's recovery file. The dirty-state check after
 * an in-flight write prevents that clear from deleting a newer snapshot made
 * by a subsequent edit.
 */

import { useEffect, useRef } from 'react';
import { useTimelineStore } from '../store/timeline';
import { useProjectStore } from '../store/project';

const DEFAULT_DEBOUNCE_MS = 4000;

export function useAutosave(debounceMs: number = DEFAULT_DEBOUNCE_MS) {
  const controller = useTimelineStore((s) => s.controller);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSerialized = useRef<string>('');

  useEffect(() => {
    const scheduleAutosave = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        timer.current = null;
        try {
          // A project can become clean while a debounce timer is waiting. Do
          // not recreate a recovery file after the explicit save that caused
          // the clean transition.
          if (!useProjectStore.getState().hasUnsavedChanges) {
            lastSerialized.current = controller.serialize();
            return;
          }

          const data = controller.serialize();
          // Skip writes when nothing actually changed since the last snapshot.
          if (data === lastSerialized.current) return;
          const { name, filePath } = useProjectStore.getState();
          const result = await window.palmier.project.autosave(name, filePath, data);
          if (result?.success === false) return;
          lastSerialized.current = data;

          // The save may have completed while this IPC write was in flight.
          // Re-check dirty state before removing its destination; a later edit
          // must remain recoverable.
          if (!useProjectStore.getState().hasUnsavedChanges) {
            await window.palmier.project.recoveryClear();
          }
        } catch {
          // Autosave is best-effort; never surface errors to the user mid-edit.
        }
      }, debounceMs);
    };

    // Re-snapshot on every project mutation.
    const unsubscribe = controller.subscribe(() => scheduleAutosave());

    // ProjectState.save() marks the project clean only after the real write
    // succeeds. This subscription closes the small timer/in-flight window in
    // which an old autosave could otherwise recreate the cleared snapshot.
    const unsubscribeProject = useProjectStore.subscribe((state, previous) => {
      if (!previous.hasUnsavedChanges || state.hasUnsavedChanges) return;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      lastSerialized.current = controller.serialize();
      void window.palmier.project.recoveryClear().catch((error: unknown) => {
        console.warn('[autosave] Could not clear the recovery snapshot:', error);
      });
    });

    // Flush a final snapshot if the window is closing.
    const handleBeforeUnload = () => {
      try {
        if (!useProjectStore.getState().hasUnsavedChanges) return;
        const data = controller.serialize();
        const { name, filePath } = useProjectStore.getState();
        // Cannot be awaited: `beforeunload` handlers must be synchronous, so the
        // write is dispatched and the page is allowed to go. The main process
        // completes it. Marked `void` because there is no one left to catch.
        void window.palmier.project.autosave(name, filePath, data).catch(() => {});
      } catch {
        /* best effort */
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      unsubscribe();
      unsubscribeProject();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [controller, debounceMs]);
}
