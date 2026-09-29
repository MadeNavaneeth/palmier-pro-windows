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

function mountWindow(session?: { project: Project | null; filePath: string | null }): MountedWindow {
  const pushes: string[] = [];
  const listeners: Array<(payload: unknown, metadata?: unknown) => void> = [];
  const sync = createEditorSync({
    controller: useTimelineStore.getState().controller,
    pullSessionState: async () => session ?? { project: null, filePath: null },
    pushSnapshot: async (payload, _filePath) => {
      pushes.push(payload);
      return { success: true, sequence: ++sessionSequence };
    },
    onApply: (listener) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
    reportSessionPath: async () => ({ success: true }),
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

/**
 * The push a playhead notification arms is the debounced project mirror, and
 * a cursor move is a notification like any other.
 *
 * The defect this pins shut: the `kind !== 'playhead'` check guarded only
 * `markDirty`, so everything after it ran for a cursor move too — the pending
 * write was armed and the timer restarted. Playback advances the playhead on
 * every advanced frame (`PlaybackEngine.ts:195`), and so does a scrub or a
 * ruler drag, so during any of them the timer was reset before it could ever
 * reach its 300ms and NOT ONE push landed. Main kept the pre-edit timeline, and
 * since preview, export and the agent's `save_project` all read that mirror
 * (`preview-compositor.ts:771`, `executor.ts:1931`), pressing Play showed the
 * cut as it was before the last edit, and a save could write that stale
 * timeline to the user's file.
 */
describe('a playhead move does not starve the project push', () => {
  it('lands the pending edit while the cursor keeps moving', async () => {
    openSavedProject();
    const own = mountWindow();
    await own.sync.ready;
    own.pushes.length = 0;

    // A real edit, which arms the push for +300ms...
    const clipId = controller().getClips()[0].id;
    expect(controller().setClipBlendMode(clipId, 'multiply')).toBe(true);

    // ...and then the transport: a cursor move every 25ms for three seconds,
    // which is a scrub, a ruler drag, or playback on a fast machine.
    for (let frame = 1; frame <= 120; frame++) {
      controller().setPlayhead(frame);
      await vi.advanceTimersByTimeAsync(25);
    }

    // One push is not enough to call this fixed: a debounced mirror that fires
    // once and then stops is the same defect with a lucky start. What used to
    // happen is that none ever landed at all.
    expect(own.pushes.length).toBeGreaterThan(1);
    // The edit reaches main, so the mirror is not the pre-edit timeline the
    // preview, the export and save_project read.
    expect(JSON.parse(own.pushes[0]).timeline.clips[0].blendMode).toBe('multiply');

    // And the mirror converges on the cursor: once the window settles, main
    // holds the position the user is actually looking at, which is what
    // `get_timeline` reports and what three-point edits default to.
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    const last = JSON.parse(own.pushes[own.pushes.length - 1]);
    expect(last.timeline.playheadFrame).toBe(120);
    expect(last.timeline.clips[0].blendMode).toBe('multiply');

    own.sync.dispose();
  });

  it('still carries the cursor to main, which is the channel the agent reads', async () => {
    openSavedProject();
    const own = mountWindow();
    await own.sync.ready;
    own.pushes.length = 0;

    controller().setPlayhead(120);
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);

    // The agent does not read the cursor from anywhere else. `get_timeline`
    // spreads the session controller's timeline, `playheadFrame` included
    // (`executor.ts:669`), and every three-point edit the agent runs defaults
    // to that controller's `getPlayhead()` (`executor.ts:975`, `:1421` of the
    // controller). The project mirror is the channel that carries it, so a
    // cursor move has to keep using it.
    expect(own.pushes).toHaveLength(1);
    expect(JSON.parse(own.pushes[0]).timeline.playheadFrame).toBe(120);

    // Which is the whole point of the exclusion: it is a view update end to
    // end, so carrying it costs the user neither unsaved work nor an undo step.
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
    expect(controller().canUndo()).toBe(false);

    own.sync.dispose();
  });
});

/**
 * A drag previews its frames instead of publishing them (`previewFrame`), so
 * what is on screen mid-gesture is not state anyone else may hold yet. It is
 * rolled back on the next pointer move and re-applied on mouse-up, so pushing
 * it would publish a position the user has not committed — to main's
 * compositor, to every sibling window, and to the agent's `get_timeline`.
 */
describe('a staged gesture frame is never published to the mirror', () => {
  it('holds the mid-drag position back and mirrors the committed one', async () => {
    openSavedProject();
    const own = mountWindow();
    await own.sync.ready;
    own.pushes.length = 0;

    // Pointer down on the clip at frame 30, then a move to +10 frames: the
    // clip is on screen at 40 and nothing has been published.
    const clipId = controller().getClips()[0].id;
    store().startDrag('move', clipId, 0, 30);
    store().updateDrag(40);
    expect(clipStarts()).toEqual([40]);
    expect(controller().canUndo()).toBe(false);

    // The pointer rests there mid-gesture for four whole debounce windows,
    // which is someone thinking about the cut they are making.
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS * 4);

    expect(own.pushes).toEqual([]);

    // Mouse-up re-runs the same derivation through the publishing path, and
    // that is the one moment the gesture becomes state — so that is the moment
    // it reaches main, as the single undo step it is.
    store().endDrag();
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);

    expect(own.pushes).toHaveLength(1);
    expect(clipStarts(JSON.parse(own.pushes[0]))).toEqual([40]);
    expect(controller().canUndo()).toBe(true);

    own.sync.dispose();
  });
});

describe('a reload seed is not unsaved work', () => {
  it('adopts the session project without arming the autosave', async () => {
    // A reloaded window comes back with a fresh, empty controller and pulls
    // the session's project instead of pushing its own. That pull restores
    // state the user already had; it is not new editorial work. Marking it
    // dirty re-armed the autosave, so reloading a saved, unedited project
    // could write a recovery snapshot and offer to recover work nobody did --
    // the same false prompt the playhead fix closed, one path over.
    const sessionProject = buildSavedProject();
    const reloaded = mountWindow({ project: sessionProject, filePath: 'C:\\projects\\two-windows.vproj' });
    await reloaded.sync.ready;

    expect(useProjectStore.getState().isLoaded).toBe(true);
    expect(useProjectStore.getState().name).toBe('Two windows');
    expect(useProjectStore.getState().filePath).toBe('C:\\projects\\two-windows.vproj');
    expect(store().getClips()).toHaveLength(sessionProject.timeline.clips.length);
    // hasUnsavedChanges is the only gate useAutosave has on both of its
    // writes, so clean here means no recovery snapshot and no prompt.
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
    // And the seed must not push the empty project back over the session.
    expect(reloaded.pushes).toHaveLength(0);

    reloaded.sync.dispose();
  });

  it('still marks a real edit dirty after a seed, so the exclusion is narrow', async () => {
    const sessionProject = buildSavedProject();
    const reloaded = mountWindow({ project: sessionProject, filePath: 'C:\\projects\\two-windows.vproj' });
    await reloaded.sync.ready;
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);

    // A genuine edit after the seed IS unsaved work and must be marked, or
    // real work would go unrecorded.
    const clipId = controller().getClips()[0].id;
    expect(controller().setClipBlendMode(clipId, 'multiply')).toBe(true);

    expect(useProjectStore.getState().hasUnsavedChanges).toBe(true);

    reloaded.sync.dispose();
  });
});
