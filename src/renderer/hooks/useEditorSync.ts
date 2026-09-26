/**
 * useEditorSync — keeps the main-process controller mirrored to the renderer's
 * authoritative timeline controller, adopts agent/MCP edits pushed back from
 * main so they appear live in the UI, and carries the session's project file
 * path both ways so a reloaded window saves to the file it came from.
 *
 *   mount           -> pull the session's state first (project + file path) and
 *                      adopt it; push only when this window genuinely holds the
 *                      project
 *   renderer change -> push serialized project to main (debounced)
 *   main push       -> an `edit` tag is one undoable UI step; a `playhead` tag
 *                      is the cursor, adopted as a view update
 *   sibling change  -> setProjectSilent + store refresh (no history, no push)
 *   path change     -> report the store's path to the session, so the session
 *                      still knows the file when this window reloads
 *
 * A tagged renderer-origin push uses the same IPC channel as the main push so
 * the preload bridge stays unchanged, but it is adopted through
 * setProjectSilent instead. StateMirror records the incoming snapshot after
 * the controller is replaced; because that replacement is silent, no
 * controller subscriber can schedule a renderer -> main echo. The sequence in
 * the tag lets concurrent windows converge on the main-process order.
 *
 * All of the ordering lives in `createEditorSync`, which takes its four
 * side-effecting collaborators (pull, push, listen, report) as arguments. The
 * hook is only the wiring, so the rules below are exercised without a DOM.
 */

import { useEffect } from 'react';
import { useTimelineStore } from '../store/timeline';
import { useProjectStore } from '../store/project';
import { StateMirror } from '../../shared/editor/state-mirror';
import { asMirroredProject } from '../../shared/ui/detached-panels';
import { sameProjectExceptPlayhead, type EditorController } from '../../shared/editor/controller';
import type { Project } from '../../shared/types/project';

const PUSH_DEBOUNCE_MS = 300;

interface RendererSyncMetadata {
  source: 'renderer';
  sequence: number;
}

/**
 * A main-side push, carrying the kind its controller published.
 *
 * Forwarded rather than re-derived: the session's controller is the only party
 * that knows whether it published a command (the agent's `adoptProject`) or
 * only moved the cursor, and a snapshot comparison could not tell an agent
 * `set_playhead` from an agent call that changed nothing — two states the
 * undo contract treats differently.
 */
interface MainSyncMetadata {
  source: 'main';
  kind: 'edit' | 'playhead';
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

function isMainSyncMetadata(value: unknown): value is MainSyncMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { source?: unknown; kind?: unknown };
  return candidate.source === 'main'
    && (candidate.kind === 'edit' || candidate.kind === 'playhead');
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

/** What one pull of the session yields: the project, and the file holding it. */
export interface SessionProjectState {
  /** The session's authoritative project, or null when main has none. */
  project: Project | null;
  /** The .vproj it came from, or null when the session holds no file. */
  filePath: string | null;
}

/** Narrow the session-state reply the same way the detached windows do (#286). */
async function pullSessionState(): Promise<SessionProjectState> {
  const response: unknown = await window.palmier.editor.getState();
  const envelope = (typeof response === 'object' && response !== null)
    ? response as { filePath?: unknown }
    : {};
  return {
    project: asMirroredProject(response),
    filePath: typeof envelope.filePath === 'string' ? envelope.filePath : null,
  };
}

export interface EditorSyncOptions {
  controller: EditorController;
  /** Pull the session's project and the file it is held in. */
  pullSessionState: () => Promise<SessionProjectState>;
  /** Send one serialized snapshot to main and resolve its reply. */
  pushSnapshot: (payload: string) => Promise<unknown>;
  /** Listen for main -> renderer pushes; returns an unsubscribe. */
  onApply: (listener: (payload: unknown, metadata?: unknown) => void) => () => void;
  /** Report the renderer's project path to the session that owns the window. */
  reportSessionPath: (filePath: string | null) => Promise<unknown>;
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
 * Mounting, editing, and adopting all happen here so the four rules that keep
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
 *
 *  3. Only an EDIT is unsaved work. The playhead is the cursor, and it still
 *     travels — the compositor composites the pushed frame and sibling windows
 *     follow it — but neither a local move, a sibling's move, nor the agent's
 *     `set_playhead` may mark the project dirty or take an undo entry. Marking
 *     it made pressing Play on a saved project arm the autosave, and the
 *     snapshot that wrote then arrived on the next launch as an "Unsaved work
 *     found" prompt for a project nobody had edited. Which of the three it is
 *     comes from the tag main forwards, not from comparing snapshots: main's
 *     controller is the only party that knows it published a command.
 *
 *  4. The session remembers the file, and the window takes it back. The project
 *     document does not carry its own path, so a reloaded window that adopted
 *     the session's work could not name the file to save it over. Main keeps
 *     one path per session, fed by the file operations it performs itself and
 *     by this window's report of its own store, and the pull that restores the
 *     work restores the path with it.
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
    // subscription. A snapshot that differs from ours in nothing but the
    // playhead is the sibling's cursor, adopted without claiming unsaved work.
    adoptRendererState(
      project,
      !sameProjectExceptPlayhead(controller.getProject(), project as Project),
    );
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
  const unsubscribe = controller.subscribe((_project, kind) => {
    // An editorial mutation (local UI edit or adopted agent edit) means the
    // project now differs from the last save. A playhead move does not: it
    // authors nothing, so it must not mark the project dirty, or opening a
    // saved project and pressing Play would arm the autosave and the next
    // launch would offer to recover a project with no unsaved editorial work.
    if (kind !== 'playhead') useProjectStore.getState().markDirty();

    if (adopting) {
      adopting = false;
      return;
    }
    // A cursor move still has to reach main: `get_timeline` reports the
    // mirror's playhead, and every three-point edit the agent runs defaults to
    // it. What it must not do is hold the push back. Re-arming the debounce on
    // every notification is only safe for work that is still arriving, and a
    // playhead move arrives once per advanced frame during playback and once
    // per pointer frame during a scrub — so re-arming on it reset the timer
    // before it could ever elapse, and a pending edit then waited forever.
    // While a push is already armed the cursor simply rides along in that
    // snapshot, which serializes it when the timer fires.
    if (kind === 'playhead' && pushTimer) return;
    pendingLocal = { json: null };
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const pending = pendingLocal;
      if (!pending) return;
      // A drag stages its frames instead of publishing them, so the project can
      // be holding a position the user is still dragging towards — which it is
      // whenever they pause mid-gesture to look at the cut they are making.
      // Sending that would publish an uncommitted frame to main's compositor,
      // to every sibling window, and to whatever the agent reads.
      //
      // The local commit stays outstanding, which is what an armed debounce
      // means, and the gesture arms this timer again when it ends: closing a
      // staged frame notifies, so the next push carries the committed position
      // and releases the commit then. Nothing is owed by not sending now.
      if (useTimelineStore.getState().isGestureFrameStaged()) return;
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

  // main -> renderer: an agent/MCP edit is one undoable step, and main says so
  // in the tag. A tagged playhead push is the same cursor the local transport
  // moves, so it is adopted as a view update; a tagged sibling update is
  // renderer-origin and takes the silent branch above.
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

      // A local write is outstanding, so this inbound state is dropped. The
      // local write wins the session, and that is a PRIORITY this module
      // asserts rather than an ordering it derives: the window is mid-gesture
      // or mid-debounce, and adopting now would swap the controller out from
      // under a commit about to be sent, after which the timer would serialize
      // the adopted state and push that — losing the user's edit from the
      // window and from the session. So it is dropped, and nothing is queued:
      // the state is discarded with a success receipt, so an agent edit that
      // landed inside a 300ms debounce window is gone from this window for
      // good, with main told the push succeeded. Sequencing these instead —
      // ordering them by main's acceptance sequence, rebasing, or versioning —
      // is a separate decision and is deliberately not taken here. The same
      // rule covers a tagged playhead push, for the same reason.
      if (pendingLocal) return;

      // Ignore a push that matches what we last sent (our own state echoed).
      if (mirror.isEcho(incoming)) return;
      // Main demonstrably holds this state, so it need not be echoed back.
      mirror.markConfirmed(incoming);

      if (isMainSyncMetadata(metadata) && metadata.kind === 'playhead') {
        // The agent moved the playhead. That is the cursor and nothing else —
        // main's controller published no command for it, so taking an undo
        // entry for it would let Ctrl+Z answer "Move playhead" instead of the
        // user's last edit, and marking the project dirty would arm the
        // autosave for a document nobody edited. Content is not consulted
        // here: main only sends this tag when every notification it collapsed
        // was a cursor move, so the snapshot cannot be carrying an edit under
        // it, and a window that already held this state gets the same answer
        // the local transport's move would give it.
        adoptRendererState(project, false);
        return;
      }

      adopting = true;
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
    let state: SessionProjectState;
    try {
      state = await options.pullSessionState();
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
    if (state.project === null) return true;
    adoptSessionProject(state.project, state.filePath);
    // Main demonstrably holds this state, so it need not be echoed back.
    mirror.markConfirmed(controller.serialize());
    return false;
  }

  //  4. The session remembers the file. The project store owns the path, and
  //     every transition to a new one lands there — an open, a Save As, a New,
  //     a recovery restore — but only two of them reach a main-owned channel, so
  //     each change is reported and kept per session. Without it a reload comes
  //     back to the right work and a Save that opens Save As over it. A detached
  //     panel never changes the path (it only ever mirrors the session's), so it
  //     reports nothing and cannot clear another window's document.
  const offPathReport = useProjectStore.subscribe((state, previous) => {
    if (state.filePath === previous.filePath) return;
    // A window holding no project of its own has no standing to clear the
    // session's file. A reloading window's store comes back empty, and a read
    // of that emptiness must not be reported as "this session has no document
    // any more" — the file it is about to pull belongs to the session, and the
    // whole point of the record is to survive the reload that produced the
    // empty store. New project and a restored snapshot both mark the project
    // loaded in the same update, so both still report.
    if (state.filePath === null && !state.isLoaded) return;
    void options.reportSessionPath(state.filePath).catch((error: unknown) => {
      console.warn(
        '[useEditorSync] Could not report the project path to the main process; '
        + 'a reload would lose it and Save would ask for a file again.',
        error,
      );
    });
  });

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
      offPathReport();
      unsubscribe();
      offApply();
    },
  };
}

export function useEditorSync() {
  const controller = useTimelineStore((s) => s.controller);
  useEffect(() => createEditorSync({
    controller,
    pullSessionState,
    pushSnapshot: (payload) => window.palmier.editor.syncState(payload),
    onApply: (listener) => window.palmier.on('editor:apply-from-main', listener),
    reportSessionPath: (filePath) => window.palmier.project.setSessionPath(filePath),
  }).dispose, [controller]);
}

/**
 * Replace the live controller without creating a command or a sync callback.
 *
 * `editorial` is false for a snapshot that differs from the one in place in
 * nothing but the playhead: adopting a peer's cursor is not unsaved work, so
 * the project stays clean and no recovery snapshot is armed for it.
 */
export function adoptRendererState(project: unknown, editorial = true): void {
  const { controller } = useTimelineStore.getState();
  controller.setProjectSilent(project as never);
  useTimelineStore.getState().syncFromController();
  if (editorial) useProjectStore.getState().markDirty();
}

/**
 * Adopt the session's project into a window that has none of its own.
 *
 * `adoptRendererState` is the silent sibling path; this additionally marks the
 * project store loaded, because a window that adopted the session is no longer
 * on the Welcome screen. `filePath` is the session's record of the document it
 * holds: the project itself does not carry its own path, so this is the only
 * thing that keeps Save pointing at the file after a reload instead of asking
 * for one over a project that is already saved.
 *
 * The seed is deliberately NOT editorial: it restores state this session already
 * held, so marking it dirty would arm the autosave for work the user never did --
 * the same false "Unsaved work found" prompt the playhead fix closed, one path over.
 * Work that was genuinely unsaved before a reload is protected by the recovery
 * snapshot, not by this flag.
 */
function adoptSessionProject(project: Project, filePath: string | null): void {
  adoptRendererState(project, false);
  useProjectStore.setState({
    name: project.name || 'Untitled Project',
    filePath,
    isLoaded: true,
  });
}

/** Adopt a project into the live store + controller as the main-side path. */
function adoptIntoStore(project: unknown): void {
  const { controller } = useTimelineStore.getState();
  controller.adoptProject(project as never, 'AI edit');
}
