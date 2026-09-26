/**
 * useEditorSync — keeps the main-process controller mirrored to the renderer's
 * authoritative timeline controller, and adopts agent/MCP edits pushed back
 * from main so they appear live in the UI.
 *
 *   mount           -> pull the session's state first and adopt it; push only
 *                      when this window genuinely holds the project
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
 *
 * All of the ordering lives in `createEditorSync`, which takes its three
 * side-effecting collaborators (pull, push, listen) as arguments. The hook is
 * only the wiring, so the rules below are exercised without a DOM.
 */

import { useEffect } from 'react';
import { useTimelineStore } from '../store/timeline';
import { useProjectStore } from '../store/project';
import { StateMirror } from '../../shared/editor/state-mirror';
import { asMirroredProject } from '../../shared/ui/detached-panels';
import type { EditorController } from '../../shared/editor/controller';
import type { Project } from '../../shared/types/project';

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

/** Narrow the session-state reply the same way the detached windows do (#286). */
async function pullSessionProject(): Promise<Project | null> {
  return asMirroredProject(await window.palmier.editor.getState());
}

export interface EditorSyncOptions {
  controller: EditorController;
  /** The session's authoritative project, or null when main has none. */
  pullSessionProject: () => Promise<Project | null>;
  /** Send one serialized snapshot to main and resolve its reply. */
  pushSnapshot: (payload: string) => Promise<unknown>;
  /** Listen for main -> renderer pushes; returns an unsubscribe. */
  onApply: (listener: (payload: unknown, metadata?: unknown) => void) => () => void;
}

export interface EditorSync {
  /** Stop pushing, listening, and drain nothing further. */
  dispose: () => void;
  /**
   * Settles when the mount-time seed and its first push have finished. The
   * hook does not need this; it exists so a caller can await one mount instead
   * of racing the initial pull.
   */
  ready: Promise<void>;
}

/**
 * The renderer half of one window's session mirror.
 *
 * Mounting, editing, and adopting all happen here so the two rules that keep
 * work from being lost are stated once:
 *
 *  1. Pull before pushing (reload). A reload re-evaluates the bundle, so the
 *     store is rebuilt around a fresh empty controller while the session in
 *     main still holds the user's project. An unconditional mount-time push
 *     replaced it with the empty default, reset the preview compositor to it,
 *     and told every sibling window to adopt it — and the pre-reload recovery
 *     snapshot `useAutosave` had written for a still-live session was then
 *     overwritten with the same empty project on the first edit. So a window
 *     that has not loaded a project of its own adopts the session's state and
 *     pushes nothing.
 *
 *  2. Never replace the controller under a pending commit. `pendingLocal` is
 *     set from the moment a mutation arms the debounce, so an inbound main
 *     push that lands inside that window would swap the controller out from
 *     under the edit about to be committed; the timer would then serialize the
 *     adopted state and push that instead, losing the edit from the window and
 *     from the session. Tagged sibling pushes are held for the same reason and
 *     drained by main's acceptance sequence.
 */
export function createEditorSync(options: EditorSyncOptions): EditorSync {
  const { controller, pushSnapshot, onApply } = options;
  let disposed = false;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  // When true, the next controller change came from adopting a main push and
  // must NOT be re-synced back to main.
  let adopting = false;
  // The highest renderer-origin snapshot order this window has accepted,
  // either from a sibling event or from the sync acknowledgement.
  let rendererSequence = 0;
  // A local snapshot that has not yet been accepted by main. Incoming snapshots
  // are held behind it so a slow IPC response cannot make this window apply an
  // older state over the edit it is already sending.
  let pendingLocal: PendingLocalSync | null = null;
  const queuedRendererSyncs = new Map<number, { project: unknown; incoming: string }>();
  const mirror = new StateMirror();

  function applyRendererSync(
    sequence: number,
    project: unknown,
    incoming: string,
  ): void {
    if (sequence <= rendererSequence || mirror.isEcho(incoming)) {
      rendererSequence = Math.max(rendererSequence, sequence);
      return;
    }
    // setProjectSilent preserves the receiving controller's history and does
    // not notify its subscribers. Refresh the Zustand mirror explicitly
    // because the silent controller update is invisible to that store's
    // subscription.
    adoptRendererState(project);
    mirror.markConfirmed(incoming);
    rendererSequence = sequence;
  }

  function drainQueuedRendererSyncs(): void {
    // A newer local snapshot is still authoritative until main acknowledges
    // it. Once it does, the sequence numbers decide which queued peer state
    // (if any) came after the local write.
    if (pendingLocal) return;
    const queued = [...queuedRendererSyncs.entries()]
      .sort(([left], [right]) => left - right);
    queuedRendererSyncs.clear();
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
    const result = await mirror.push(json, async (payload) => {
      const response = await pushSnapshot(payload);
      if (rendererSyncWasRejected(response)) {
        throw new Error('The main process rejected the renderer editor sync.');
      }
      const sequence = rendererSyncSequenceFromResponse(response);
      if (sequence !== null) {
        rendererSequence = Math.max(rendererSequence, sequence);
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
    if (pendingLocal === pending && pending.json === json) {
      pendingLocal = null;
      drainQueuedRendererSyncs();
    }
  }

  // renderer -> main: mirror authoritative state.
  const unsubscribe = controller.subscribe(() => {
    // Any controller mutation (local UI edit or adopted agent edit) means the
    // project now differs from the last save.
    useProjectStore.getState().markDirty();

    if (adopting) {
      adopting = false;
      return;
    }
    pendingLocal = { json: null };
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const pending = pendingLocal;
      if (!pending) return;
      const json = controller.serialize();
      if (!mirror.needsPush(json)) {
        if (pendingLocal === pending) {
          pendingLocal = null;
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
  const offApply = onApply((payload: unknown, metadata?: unknown) => {
    try {
      const project: unknown = JSON.parse(payload as string);
      const incoming = JSON.stringify(project);

      if (isRendererSyncMetadata(metadata)) {
        // Main assigns sequence numbers in acceptance order. Ignore an
        // older event that arrives after this window has accepted a newer
        // write; hold newer events while a local write is pending.
        if (metadata.sequence <= rendererSequence) return;
        if (pendingLocal) {
          queuedRendererSyncs.set(metadata.sequence, { project, incoming });
          return;
        }
        applyRendererSync(metadata.sequence, project, incoming);
        return;
      }

      // A local write is outstanding, so this payload is provably older than
      // what main will hold once that write lands: attachSessionEditorPush
      // captures main's project when its controller notifies, and the sync
      // handler replaces main's state with ours afterwards. Adopting it now
      // would swap the controller out from under a pending commit, and the
      // debounce would then serialize the adopted state and push that — losing
      // the user's edit from the window and from the session. The local write
      // is the one that wins the session; nothing to queue, because a state
      // the pending commit is about to supersede must not be applied later.
      if (pendingLocal) return;

      // Ignore a push that matches what we last sent (our own state echoed).
      if (mirror.isEcho(incoming)) return;
      adopting = true;
      // Main demonstrably holds this state, so it need not be echoed back.
      mirror.markConfirmed(incoming);
      adoptIntoStore(project);
    } catch {
      /* ignore malformed payloads */
    }
  });

  /**
   * Decide whether this freshly mounted window owes main a snapshot.
   *
   * `isLoaded` is the Welcome-screen condition, so it is exactly "does this
   * renderer hold a project on purpose": an open, a restore, or a detached
   * panel's own pull set it. A window that does not has nothing to protect
   * main from, so it adopts the session instead of overwriting it.
   *
   * False is also the answer when the session could not be read: an unknown
   * session must not be overwritten with a guess, so the window waits for its
   * first real edit.
   */
  async function ownsTheProject(): Promise<boolean> {
    if (useProjectStore.getState().isLoaded) return true;
    let project: Project | null;
    try {
      project = await options.pullSessionProject();
    } catch (error) {
      console.warn(
        '[useEditorSync] Could not read the session project from the main process; '
        + 'this window will mirror its own state on the first edit.',
        error,
      );
      return false;
    }
    // The pull crossed an IPC round trip: anything that happened here is a real
    // edit, and it wins over a snapshot of the session.
    if (disposed || useProjectStore.getState().isLoaded || pendingLocal) return true;
    // Main answered and has no project for this session, so mirroring this
    // window's state cannot lose anything.
    if (project === null) return true;
    adoptSessionProject(project);
    // Main demonstrably holds this state, so it need not be echoed back.
    mirror.markConfirmed(controller.serialize());
    return false;
  }

  const ready = (async () => {
    if (disposed || !(await ownsTheProject())) return;
    const initialJson = controller.serialize();
    // An edit that arrived during the pull is already armed and owns the
    // session; a second push would only race it.
    if (pendingLocal) return;
    const initialPending: PendingLocalSync = { json: initialJson };
    pendingLocal = initialPending;
    await pushToMain(initialJson, initialPending);
  })();

  return {
    ready,
    dispose: () => {
      disposed = true;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = null;
      unsubscribe();
      offApply();
    },
  };
}

export function useEditorSync() {
  const controller = useTimelineStore((s) => s.controller);
  useEffect(() => createEditorSync({
    controller,
    pullSessionProject,
    pushSnapshot: (payload) => window.palmier.editor.syncState(payload),
    onApply: (listener) => window.palmier.on('editor:apply-from-main', listener),
  }).dispose, [controller]);
}

/** Replace the live controller without creating a command or a sync callback. */
export function adoptRendererState(project: unknown): void {
  const { controller } = useTimelineStore.getState();
  controller.setProjectSilent(project as never);
  useTimelineStore.getState().syncFromController();
  useProjectStore.getState().markDirty();
}

/**
 * Adopt the session's project into a window that has none of its own.
 *
 * `adoptRendererState` is the silent sibling path; this additionally marks the
 * project store loaded, because a window that adopted the session is no longer
 * on the Welcome screen. `filePath` is session metadata that the project
 * document does not carry, so a reloaded window has none until the user saves.
 */
function adoptSessionProject(project: Project): void {
  adoptRendererState(project);
  useProjectStore.setState({
    name: project.name || 'Untitled Project',
    isLoaded: true,
  });
}

/** Adopt a project into the live store + controller as the main-side path. */
function adoptIntoStore(project: unknown): void {
  const { controller } = useTimelineStore.getState();
  controller.adoptProject(project as never, 'AI edit');
}
