/**
 * useEditorSync — keeps the main-process controller mirrored to the renderer's
 * authoritative timeline controller, and adopts agent/MCP edits pushed back
 * from main so they appear live in the UI.
 *
 *   renderer change -> push serialized project to main (debounced)
 *   main push       -> adoptProject as a single undoable UI step
 *   sibling change  -> setProjectSilent + store refresh (no history, no push)
 *
 * A tagged renderer-origin push uses the same IPC channel as the main push so
 * the preload bridge stays unchanged, but it is adopted through
 * setProjectSilent instead. StateMirror records the incoming snapshot after
 * the controller is replaced; because that replacement is silent, no
 * controller subscriber can schedule a renderer -> main echo. The sequence in
 * the tag lets concurrent windows converge on the main-process order.
 */

import { useEffect, useRef } from 'react';
import { useTimelineStore } from '../store/timeline';
import { useProjectStore } from '../store/project';
import { StateMirror } from '../../shared/editor/state-mirror';

const PUSH_DEBOUNCE_MS = 300;

interface RendererSyncMetadata {
  source: 'renderer';
  sequence: number;
}

interface PendingLocalSync {
  /** Filled when the debounce timer captures the current serialized state. */
  json: string | null;
}

function isRendererSyncMetadata(value: unknown): value is RendererSyncMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { source?: unknown; sequence?: unknown };
  return candidate.source === 'renderer'
    && typeof candidate.sequence === 'number'
    && Number.isSafeInteger(candidate.sequence)
    && candidate.sequence >= 0;
}

function rendererSyncSequenceFromResponse(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { sequence?: unknown };
  return typeof candidate.sequence === 'number'
    && Number.isSafeInteger(candidate.sequence)
    && candidate.sequence >= 0
    ? candidate.sequence
    : null;
}

function rendererSyncWasRejected(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && (value as { success?: unknown }).success === false;
}

export function useEditorSync() {
  const controller = useTimelineStore((s) => s.controller);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When true, the next controller change came from adopting a main push and
  // must NOT be re-synced back to main.
  const adopting = useRef(false);
  // The highest renderer-origin snapshot order this window has accepted,
  // either from a sibling event or from the sync acknowledgement.
  const rendererSequence = useRef(0);
  // A local snapshot that has not yet been accepted by main. Incoming sibling
  // snapshots are held behind it so a slow IPC response cannot make this window
  // apply an older state over the edit it is already sending.
  const pendingLocal = useRef<PendingLocalSync | null>(null);
  const queuedRendererSyncs = useRef(
    new Map<number, { project: unknown; incoming: string }>(),
  );
  const mirror = useRef(new StateMirror());

  useEffect(() => {
    const state = mirror.current;

    function applyRendererSync(
      sequence: number,
      project: unknown,
      incoming: string,
    ): void {
      if (sequence <= rendererSequence.current || state.isEcho(incoming)) {
        rendererSequence.current = Math.max(rendererSequence.current, sequence);
        return;
      }
      // setProjectSilent preserves the receiving controller's history and does
      // not notify its subscribers. Refresh the Zustand mirror explicitly
      // because the silent controller update is invisible to that store's
      // subscription.
      adoptRendererState(project);
      state.markConfirmed(incoming);
      rendererSequence.current = sequence;
    }

    function drainQueuedRendererSyncs(): void {
      // A newer local snapshot is still authoritative until main acknowledges
      // it. Once it does, the sequence numbers decide which queued peer state
      // (if any) came after the local write.
      if (pendingLocal.current) return;
      const queued = [...queuedRendererSyncs.current.entries()]
        .sort(([left], [right]) => left - right);
      queuedRendererSyncs.current.clear();
      for (const [sequence, update] of queued) {
        applyRendererSync(sequence, update.project, update.incoming);
      }
    }

    /**
     * Mirror one snapshot to main.
     *
     * StateMirror records the snapshot only once main confirms it, so a
     * transient IPC failure leaves the state eligible for retry on the next
     * edit rather than being marked delivered. The acknowledgement sequence is
     * recorded here as well: a sender must know that its own concurrent write
     * won before it can ignore an older sibling event.
     */
    async function pushToMain(json: string, pending: PendingLocalSync): Promise<void> {
      const result = await state.push(json, async (payload) => {
        const response = await window.palmier.editor.syncState(payload);
        if (rendererSyncWasRejected(response)) {
          throw new Error('The main process rejected the renderer editor sync.');
        }
        const sequence = rendererSyncSequenceFromResponse(response);
        if (sequence !== null) {
          rendererSequence.current = Math.max(rendererSequence.current, sequence);
        }
        return response;
      });
      if (result.attempted && !result.delivered) {
        console.warn(
          '[useEditorSync] Failed to mirror the project to the main process. '
          + 'Agent and MCP tools may see stale state until the next edit.',
          result.error,
        );
        return;
      }
      if (pendingLocal.current === pending && pending.json === json) {
        pendingLocal.current = null;
        drainQueuedRendererSyncs();
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
      pendingLocal.current = { json: null };
      if (pushTimer.current) clearTimeout(pushTimer.current);
      pushTimer.current = setTimeout(() => {
        pushTimer.current = null;
        const pending = pendingLocal.current;
        if (!pending) return;
        const json = controller.serialize();
        if (!state.needsPush(json)) {
          if (pendingLocal.current === pending) {
            pendingLocal.current = null;
            drainQueuedRendererSyncs();
          }
          return;
        }
        pending.json = json;
        void pushToMain(json, pending);
      }, PUSH_DEBOUNCE_MS);
    });

    // main -> renderer: agent/MCP edits are one undoable step. A renderer-origin
    // sibling update is tagged and takes the silent branch below instead.
    const offApply = window.palmier.on(
      'editor:apply-from-main',
      (payload: unknown, metadata?: unknown) => {
        try {
          const project: unknown = JSON.parse(payload as string);
          const incoming = JSON.stringify(project);

          if (isRendererSyncMetadata(metadata)) {
            // Main assigns sequence numbers in acceptance order. Ignore an
            // older event that arrives after this window has accepted a newer
            // write; hold newer events while a local write is pending.
            if (metadata.sequence <= rendererSequence.current) return;
            if (pendingLocal.current) {
              queuedRendererSyncs.current.set(metadata.sequence, {
                project,
                incoming,
              });
              return;
            }
            applyRendererSync(metadata.sequence, project, incoming);
            return;
          }

          // Ignore a push that matches what we last sent (our own state echoed).
          if (state.isEcho(incoming)) return;
          adopting.current = true;
          // Main demonstrably holds this state, so it need not be echoed back.
          state.markConfirmed(incoming);
          adoptIntoStore(project);
        } catch {
          /* ignore malformed payloads */
        }
      },
    );

    // Push an initial snapshot so main starts mirrored. Treat it like any
    // other local write while the acknowledgement is in flight.
    const initialJson = controller.serialize();
    const initialPending: PendingLocalSync = { json: initialJson };
    pendingLocal.current = initialPending;
    void pushToMain(initialJson, initialPending);

    return () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
      unsubscribe();
      offApply();
    };
  }, [controller]);
}

/** Replace the live controller without creating a command or a sync callback. */
export function adoptRendererState(project: unknown): void {
  const { controller } = useTimelineStore.getState();
  controller.setProjectSilent(project as never);
  useTimelineStore.getState().syncFromController();
  useProjectStore.getState().markDirty();
}

/** Adopt a project into the live store + controller as the main-side path. */
function adoptIntoStore(project: unknown): void {
  const { controller } = useTimelineStore.getState();
  controller.adoptProject(project as never, 'AI edit');
}
