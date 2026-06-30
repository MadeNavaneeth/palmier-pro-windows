/**
 * useAutosave — debounced crash-recovery autosave (upstream #211).
 *
 * Subscribes to timeline project changes and pushes a snapshot to the main
 * process at most once every `debounceMs`. The snapshot is written to a
 * dedicated recovery file (never the user's .vproj), so an unexpected exit
 * loses at most a few seconds of work instead of the whole session.
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
        try {
          const data = controller.serialize();
          // Skip writes when nothing actually changed since the last snapshot.
          if (data === lastSerialized.current) return;
          lastSerialized.current = data;

          const { name, filePath } = useProjectStore.getState();
          await window.palmier.project.autosave(name, filePath, data);
        } catch {
          // Autosave is best-effort; never surface errors to the user mid-edit.
        }
      }, debounceMs);
    };

    // Re-snapshot on every project mutation.
    const unsubscribe = controller.subscribe(() => scheduleAutosave());

    // Flush a final snapshot if the window is closing.
    const handleBeforeUnload = () => {
      try {
        const data = controller.serialize();
        const { name, filePath } = useProjectStore.getState();
        window.palmier.project.autosave(name, filePath, data);
      } catch {
        /* best effort */
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      if (timer.current) clearTimeout(timer.current);
      unsubscribe();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [controller, debounceMs]);
}
