/**
 * useEditorSync — keeps the main-process controller mirrored to the renderer's
 * authoritative timeline controller, and adopts agent/MCP edits pushed back
 * from main so they appear live in the UI.
 *
 *   renderer change -> push serialized project to main (debounced)
 *   main push       -> adoptProject as a single undoable UI step
 *
 * An echo guard prevents the adopted state from immediately bouncing back to
 * main as a redundant sync.
 */

import { useEffect, useRef } from 'react';
import { useTimelineStore } from '../store/timeline';
import { useProjectStore } from '../store/project';

const PUSH_DEBOUNCE_MS = 300;

export function useEditorSync() {
  const controller = useTimelineStore((s) => s.controller);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When true, the next controller change came from adopting a main push and
  // must NOT be re-synced back to main.
  const adopting = useRef(false);
  const lastPushed = useRef<string>('');

  useEffect(() => {
    // renderer -> main: mirror authoritative state.
    const unsubscribe = controller.subscribe(() => {
      // Any controller mutation (local UI edit or adopted agent edit) means the
      // project now differs from the last save.
      useProjectStore.getState().markDirty();

      if (adopting.current) {
        adopting.current = false;
        return;
      }
      if (pushTimer.current) clearTimeout(pushTimer.current);
      pushTimer.current = setTimeout(() => {
        pushTimer.current = null;
        const json = controller.serialize();
        if (json === lastPushed.current) return;
        lastPushed.current = json;
        window.palmier.editor.syncState(json).catch(() => {});
      }, PUSH_DEBOUNCE_MS);
    });

    // main -> renderer: adopt agent/MCP edits as one undoable step.
    const offApply = window.palmier.on('editor:apply-from-main', (payload: unknown) => {
      try {
        const project = JSON.parse(payload as string);
        const incoming = JSON.stringify(project);
        // Ignore a push that matches what we last sent (our own state echoed).
        if (incoming === lastPushed.current) return;
        adopting.current = true;
        lastPushed.current = incoming;
        useTimelineStoreAdopt(project);
      } catch {
        /* ignore malformed payloads */
      }
    });

    // Push an initial snapshot so main starts mirrored.
    const initial = controller.serialize();
    lastPushed.current = initial;
    window.palmier.editor.syncState(initial).catch(() => {});

    return () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
      unsubscribe();
      offApply();
    };
  }, [controller]);
}

/** Adopt a project into the live store + controller. */
function useTimelineStoreAdopt(project: unknown): void {
  const { controller } = useTimelineStore.getState();
  controller.adoptProject(project as never, 'AI edit');
}
