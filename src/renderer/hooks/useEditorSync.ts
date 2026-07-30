/**
 * useEditorSync — keeps the main-process controller mirrored to the renderer's
 * authoritative timeline controller, and adopts agent/MCP edits pushed back
 * from main so they appear live in the UI.
 *
 *   renderer change -> push serialized project to main (debounced)
 *   main push       -> adoptProject as a single undoable UI step
 *
 * An echo guard prevents the adopted state from immediately bouncing back to
 * main as a redundant sync. The confirmed-state bookkeeping lives in StateMirror
 * so its retry invariant is testable without React (upstream #89).
 */

import { useEffect, useRef } from 'react';
import { useTimelineStore } from '../store/timeline';
import { useProjectStore } from '../store/project';
import { StateMirror } from '../../shared/editor/state-mirror';

const PUSH_DEBOUNCE_MS = 300;

export function useEditorSync() {
  const controller = useTimelineStore((s) => s.controller);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When true, the next controller change came from adopting a main push and
  // must NOT be re-synced back to main.
  const adopting = useRef(false);
  const mirror = useRef(new StateMirror());

  useEffect(() => {
    const state = mirror.current;

    /**
     * Mirror one snapshot to main.
     *
     * StateMirror records the snapshot only once main confirms it, so a
     * transient IPC failure leaves the state eligible for retry on the next
     * edit rather than being marked delivered.
     */
    async function pushToMain(json: string): Promise<void> {
      const result = await state.push(json, (payload) =>
        window.palmier.editor.syncState(payload));
      if (result.attempted && !result.delivered) {
        console.warn(
          '[useEditorSync] Failed to mirror the project to the main process. '
          + 'Agent and MCP tools may see stale state until the next edit.',
          result.error,
        );
      }
    }

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
        if (!state.needsPush(json)) return;
        void pushToMain(json);
      }, PUSH_DEBOUNCE_MS);
    });

    // main -> renderer: adopt agent/MCP edits as one undoable step.
    const offApply = window.palmier.on('editor:apply-from-main', (payload: unknown) => {
      try {
        const project: unknown = JSON.parse(payload as string);
        const incoming = JSON.stringify(project);
        // Ignore a push that matches what we last sent (our own state echoed).
        if (state.isEcho(incoming)) return;
        adopting.current = true;
        // Main demonstrably holds this state, so it need not be echoed back.
        state.markConfirmed(incoming);
        adoptIntoStore(project);
      } catch {
        /* ignore malformed payloads */
      }
    });

    // Push an initial snapshot so main starts mirrored.
    void pushToMain(controller.serialize());

    return () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
      unsubscribe();
      offApply();
    };
  }, [controller]);
}

/** Adopt a project into the live store + controller. */
function adoptIntoStore(project: unknown): void {
  const { controller } = useTimelineStore.getState();
  controller.adoptProject(project as never, 'AI edit');
}
