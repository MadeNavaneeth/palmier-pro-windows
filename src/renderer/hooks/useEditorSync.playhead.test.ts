/**
 * A playhead move is a view update all the way to the session mirror.
 *
 * The defect this pins shut: the playhead moved through a command, so it was
 * an undo entry, and it notified like an edit, so `useEditorSync` marked the
 * project dirty on every move. Opening a saved project and pressing Play
 * therefore armed the autosave, the autosave wrote a recovery snapshot, a clean
 * quit rewrote it, and the next launch — a new session id, so the file was a
 * genuine orphan newer than the .vproj — offered to recover a project with no
 * unsaved editorial work. Training a user to click through that prompt is what
 * makes losing work on reload unrecoverable in practice.
 *
 * The notification is deliberately kept: it is what the window redraws from, and
 * the debounced push it arms is what main's compositor composites (so the
 * preview follows the playhead) and what a sibling window adopts. So the tests
 * below assert both halves — the move reaches the peer and the compositor, and
 * neither end calls it unsaved work.
 *
 * Two windows are modelled in one process, which holds a single renderer store:
 * the send side is a real mounted window whose debounced push is captured
 * (that is what carries a cursor to main, to the compositor, and to the
 * sibling), and the receive side is a second mounted window that is handed
 * exactly the payload and metadata main broadcasts for the first window's
 * write. The sender's controller is a window of its own, so its moves never
 * leak into the receiver's store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { createEmptyProject, type Project } from '../../shared/types/project';
import { useProjectStore } from '../store/project';
import { useTimelineStore } from '../store/timeline';
import { createEditorSync, type EditorSync } from './useEditorSync';

/** Same value as useEditorSync. */
const PUSH_DEBOUNCE_MS = 300;

interface MountedWindow {
  sync: EditorSync;
  /** Snapshots this window sent to main, in order. */
  pushes: string[];
  /** Deliver a main -> renderer push to this window. */
  apply: (payload: unknown, metadata?: unknown) => void;
}

/** One session's acceptance counter, exactly like main's per-session sequence. */
let sessionSequence = 0;

function mountWindow(): MountedWindow {
  const pushes: string[] = [];
  const listeners: Array<(payload: unknown, metadata?: unknown) => void> = [];
  const sync = createEditorSync({
    controller: useTimelineStore.getState().controller,
    pullSessionProject: async () => null,
    pushSnapshot: async (payload) => {
      pushes.push(payload);
      return { success: true, sequence: ++sessionSequence };
    },
    onApply: (listener) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
  });
  return {
    sync,
    pushes,
    apply: (payload, metadata) => {
      for (const listener of [...listeners]) listener(payload, metadata);
    },
  };
}

function controller(): EditorController {
  return useTimelineStore.getState().controller;
}

function store() {
  return useTimelineStore.getState();
}

function clipStarts(project?: Project): number[] {
  return (project ?? controller().getProject()).timeline.clips
    .map((clip) => clip.startFrame);
}

/**
 * The saved project both windows open, with one clip already placed. Built once
 * per test, because a second build would mint a different clip id and the two
 * "windows" would not be looking at the same file.
 */
function buildSavedProject(): Project {
  const saved = new EditorController(createEmptyProject('Two windows'));
  saved.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 30, durationFrames: 90 });
  return saved.getProject();
}

let saved: Project;

/** What a window holds after opening the saved project and saving nothing since. */
function openSavedProject(): void {
  controller().loadProject(saved);
  useProjectStore.setState({
    name: 'Two windows',
    filePath: 'C:\\projects\\two-windows.vproj',
    isLoaded: true,
    hasUnsavedChanges: false,
  });
}

/**
 * The payload main broadcasts for a sibling window's write: the sender's
 * project as the session mirror holds it, which is the sender's snapshot
 * round-tripped through JSON.
 */
function peersPush(sender: EditorController): string {
  return JSON.stringify(JSON.parse(JSON.stringify(sender.getProject())));
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionSequence = 0;
  saved = buildSavedProject();
  controller().loadProject(createEmptyProject('Local'));
  useProjectStore.setState({
    name: 'Untitled Project',
    filePath: null,
    isLoaded: false,
    hasUnsavedChanges: false,
  });
  useTimelineStore.setState({ isPlaying: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a playhead move is not unsaved work', () => {
  it('leaves a saved project clean when the user only presses Play', async () => {
    openSavedProject();
    const own = mountWindow();
    await own.sync.ready;
    own.pushes.length = 0;

    // Exactly what pressing Play does: toggle the transport, then let the
    // engine drive the playhead a frame at a time (PlaybackEngine.ts:103).
    store().togglePlayback();
    for (let frame = 1; frame <= 40; frame++) store().setPlayhead(frame);
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);

    expect(store().getPlayhead()).toBe(40);
    // hasUnsavedChanges is the only gate useAutosave has on both of its writes
    // (the 4s debounce at useAutosave.ts:35 and the beforeunload flush at
    // useAutosave.ts:81), so clean here means no recovery snapshot is written
    // and no "Unsaved work found" prompt on the next launch.
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
    // The move is still mirrored, which is what composites the pushed frame in
    // main and carries the cursor to a sibling window.
    expect(own.pushes).toHaveLength(1);
    expect(JSON.parse(own.pushes[0]).timeline.playheadFrame).toBe(40);

    own.sync.dispose();
  });

  it('keeps every transport and ruler path clean, and leaves the cursor right', async () => {
    openSavedProject();
    const own = mountWindow();
    await own.sync.ready;
    own.pushes.length = 0;

    // Preview scrub slider and Go-to-start/end (Preview.tsx:77, :194, :213).
    store().setPlayhead(120, null);
    store().setPlayhead(0, null);
    // Frame stepping (Preview.tsx:78).
    store().stepFrame(1, null);
    store().stepFrame(-1, null);
    // Ruler click and ruler scrub drag (TimelineTrack.tsx:64, useDragHandler.ts:37).
    store().setPlayhead(240);
    // Programmatic move, as an agent tool or a shortcut performs it.
    controller().setPlayhead(60);
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);

    expect(store().getPlayhead()).toBe(60);
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
    expect(own.pushes).toHaveLength(1);
    own.sync.dispose();
  });

  it('still marks a real edit dirty, so the exclusion is narrow', async () => {
    openSavedProject();
    const own = mountWindow();
    await own.sync.ready;

    // A clip-property edit: the same SetClipPropertiesCommand every blend,
    // opacity and fade change runs on.
    const clipId = controller().getClips()[0].id;
    expect(controller().setClipBlendMode(clipId, 'multiply')).toBe(true);

    expect(useProjectStore.getState().hasUnsavedChanges).toBe(true);
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    expect(JSON.parse(own.pushes[1]).timeline.clips[0].blendMode).toBe('multiply');
    own.sync.dispose();
  });
});

describe('a playhead still reaches the other window', () => {
  it('is adopted by the sibling without an undo entry and without a dirty mark', async () => {
    // Window B opens the saved project and is sitting there.
    openSavedProject();
    const b = mountWindow();
    await b.sync.ready;
    b.pushes.length = 0;

    // Window A, a window of its own, scrubs the preview. `peersPush` is exactly
    // what main broadcasts for A's write: the sender's project, round-tripped
    // through the session mirror, tagged as renderer-origin with the sequence
    // main assigned it.
    const a = new EditorController(saved);
    a.setPlayheadInScope(120, null);
    const sequence = ++sessionSequence;

    b.apply(peersPush(a), { source: 'renderer', sequence });

    expect(controller().getPlayhead()).toBe(120);
    expect(store().project.timeline.playheadFrame).toBe(120);
    // The cursor is a view update on the receiving side too: nothing to undo,
    // and no recovery snapshot armed for a project B never edited.
    expect(controller().canUndo()).toBe(false);
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
    // And adopting a snapshot is not an edit, so it is not pushed back.
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    expect(b.pushes).toEqual([]);
    b.sync.dispose();
  });

  it('still marks the sibling dirty when the push carries a real edit', async () => {
    openSavedProject();
    const b = mountWindow();
    await b.sync.ready;

    const a = new EditorController(saved);
    a.setPlayheadInScope(120, null);
    a.moveClip(a.getClips()[0].id, 300);
    const sequence = ++sessionSequence;

    b.apply(peersPush(a), { source: 'renderer', sequence });

    // Both halves of the same snapshot: the cursor lands, and the edit counts
    // as the unsaved work it is.
    expect(store().getPlayhead()).toBe(120);
    expect(clipStarts()).toEqual([300]);
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(true);
    // Adopting never publishes history in this window, as before.
    expect(controller().canUndo()).toBe(false);
    b.sync.dispose();
  });
});
