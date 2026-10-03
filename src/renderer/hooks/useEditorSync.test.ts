/**
 * Ordering coverage for one window's session mirror.
 *
 * Three defects are pinned here, all of which lost or buried user work:
 *
 *  1. A reload re-evaluates the bundle, so the store came back around a fresh
 *     empty controller and the mirror's unconditional mount-time push replaced
 *     the session's real project with it — silently, and then destroyed the
 *     pre-reload recovery snapshot on the first edit.
 *  2. The untagged main push had no guard against a local push in flight, so it
 *     swapped the controller out from under a pending commit and the debounce
 *     then pushed the adopted state, losing the edit from the window and from
 *     the session.
 *  3. StateMirror compared pretty-printed snapshots against compact peer
 *     payloads, so the dedupe and the echo guard never matched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { createEmptyProject, type Project } from '../../shared/types/project';
import { useProjectStore } from '../store/project';
import { useTimelineStore } from '../store/timeline';
import { adoptRendererState, createEditorSync, type EditorSync } from './useEditorSync';

/** Same value as useEditorSync. */
const PUSH_DEBOUNCE_MS = 300;

interface MountOptions {
  /** What the session in main answers with. Null means "no project". */
  pull?: () => Promise<Project | null>;
  /** The file main has that session's project in. */
  filePath?: string;
  /** Main's reply to a renderer push. */
  reply?: (payload: string) => Promise<unknown>;
}

interface Mounted {
  sync: EditorSync;
  /** Serialized snapshots this window sent to main, in order. */
  pushes: string[];
  /** Project paths this window reported to the session, in order. */
  reports: Array<string | null>;
  /** Deliver a main -> renderer push to this window. */
  apply: (payload: unknown, metadata?: unknown) => void;
}

function mount(options: MountOptions = {}): Mounted {
  const pushes: string[] = [];
  const reports: Array<string | null> = [];
  const listeners: Array<(payload: unknown, metadata?: unknown) => void> = [];
  const sync = createEditorSync({
    controller: useTimelineStore.getState().controller,
    pullSessionState: async () => ({
      project: options.pull ? await options.pull() : null,
      filePath: options.filePath ?? null,
    }),
    pushSnapshot: async (payload, _filePath) => {
      pushes.push(payload);
      return options.reply ? options.reply(payload) : { success: true, sequence: pushes.length };
    },
    onApply: (listener) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
    reportSessionPath: async (filePath) => {
      reports.push(filePath);
      return { success: true };
    },
  });
  return {
    sync,
    pushes,
    reports,
    apply: (payload, metadata) => {
      for (const listener of [...listeners]) listener(payload, metadata);
    },
  };
}

function controller(): EditorController {
  return useTimelineStore.getState().controller;
}

/** A project that is unmistakably not the empty default. */
function projectWithWork(name: string): Project {
  const staged = new EditorController(createEmptyProject(name));
  staged.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 30, durationFrames: 90 });
  return staged.getProject();
}

function clipCount(): number {
  return controller().getProject().timeline.clips.length;
}

/** Clip positions, so an edit is identifiable without depending on ids. */
function clipStarts(project?: Project): number[] {
  const clips = (project ?? controller().getProject()).timeline.clips;
  return clips.map((clip) => clip.startFrame);
}

function resetRenderer(): void {
  controller().loadProject(createEmptyProject('Local'));
  useProjectStore.setState({
    name: 'Untitled Project',
    filePath: null,
    isLoaded: false,
    hasUnsavedChanges: false,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRenderer();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('renderer-origin adoption', () => {
  it('replaces project state without adding an undo entry or notifying sync subscribers', () => {
    controller().addTrack('video', 'Local edit');
    const remote = createEmptyProject('Remote edit');
    let notifications = 0;
    const unsubscribe = controller().subscribe(() => {
      notifications += 1;
    });

    adoptRendererState(remote);

    expect(controller().getProject().name).toBe('Remote edit');
    expect(useTimelineStore.getState().project.name).toBe('Remote edit');
    expect(controller().canUndo()).toBe(true);
    expect(notifications).toBe(0);

    unsubscribe();
    expect(controller().undo()).toBe(true);
    expect(controller().getTracks()).toHaveLength(2);
  });
});

describe('reload seeds the window from the session', () => {
  it('adopts the session project instead of pushing an empty one over it', async () => {
    // Exactly what a reload leaves behind: same webContents, same session
    // controller, real work still in it — and a renderer bundle that has just
    // rebuilt its store around a fresh empty controller.
    const session = projectWithWork('Pre-reload work');
    const window = mount({ pull: async () => session });

    await window.sync.ready;

    // The empty default never reached main, so the session, the preview
    // compositor and every sibling window keep the real project.
    expect(window.pushes).toEqual([]);
    expect(clipCount()).toBe(1);
    expect(controller().getProject().name).toBe('Pre-reload work');
    // And the window is a workspace again, not the Welcome screen.
    expect(useProjectStore.getState().isLoaded).toBe(true);
    expect(useProjectStore.getState().name).toBe('Pre-reload work');

    window.sync.dispose();
  });

  it('does not notify the controller, so nothing schedules a redundant write', async () => {
    const window = mount({ pull: async () => projectWithWork('Pre-reload work') });
    let notifications = 0;
    const unsubscribe = controller().subscribe(() => {
      notifications += 1;
    });

    await window.sync.ready;

    // useAutosave subscribes to exactly this signal, so the pre-reload recovery
    // snapshot is left alone until the user actually edits something.
    expect(notifications).toBe(0);
    unsubscribe();
    window.sync.dispose();
  });

  it('pushes nothing further until a real edit happens', async () => {
    const window = mount({ pull: async () => projectWithWork('Pre-reload work') });
    await window.sync.ready;

    controller().addClip({ assetId: 'asset-2', trackId: 'v1', startFrame: 200 });
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);

    expect(window.pushes).toHaveLength(1);
    expect(JSON.parse(window.pushes[0]).timeline.clips).toHaveLength(2);
    window.sync.dispose();
  });

  it('still mirrors a window that deliberately loaded a project of its own', async () => {
    useProjectStore.setState({ isLoaded: true, name: 'Opened locally' });
    const opened = projectWithWork('Opened locally');
    controller().loadProject(opened);
    const window = mount({ pull: async () => createEmptyProject('Untitled Project') });

    await window.sync.ready;

    // A project the user opened is the authority for its session; main's empty
    // mirror must not be pulled over it.
    expect(window.pushes).toHaveLength(1);
    expect(JSON.parse(window.pushes[0]).name).toBe('Opened locally');
    window.sync.dispose();
  });

  it('pushes a first launch, where the session has no project yet', async () => {
    const window = mount({ pull: async () => null });
    await window.sync.ready;

    expect(window.pushes).toHaveLength(1);
    window.sync.dispose();
  });

  it('does not push a guess when the session cannot be read', async () => {
    const window = mount({
      pull: async () => {
        throw new Error('bridge down');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await window.sync.ready;

    // Overwriting a live session is irreversible; waiting for the first real
    // edit is not.
    expect(window.pushes).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    window.sync.dispose();
  });

  it('takes the session’s file back with its work', async () => {
    const window = mount({
      pull: async () => projectWithWork('Pre-reload work'),
      filePath: 'C:\\projects\\pre-reload.vproj',
    });

    await window.sync.ready;

    // The document does not carry its own path, so without this the window is
    // back in the workspace with the right project and a Save that asks for a
    // file over a project that is already on disk.
    expect(useProjectStore.getState().filePath).toBe('C:\\projects\\pre-reload.vproj');
    window.sync.dispose();
  });

  it('leaves the file alone when the session holds no path', async () => {
    const window = mount({ pull: async () => projectWithWork('Unsaved work') });

    await window.sync.ready;

    expect(useProjectStore.getState().filePath).toBeNull();
    window.sync.dispose();
  });

  it('lets an edit that lands during the pull win instead of racing it', async () => {
    const session = projectWithWork('Pre-reload work');
    const window = mount({
      pull: async () => {
        // The pull is in flight when the user acts.
        controller().addClip({ assetId: 'local-1', trackId: 'v1', startFrame: 500 });
        return session;
      },
    });

    await window.sync.ready;
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);

    // One push, carrying the local edit — not the session snapshot the pull
    // brought back, and not a second snapshot over the first.
    expect(window.pushes).toHaveLength(1);
    expect(clipStarts(JSON.parse(window.pushes[0]))).toEqual([500]);
    window.sync.dispose();
  });
});

describe('a main push never replaces the controller under a pending commit', () => {
  it('keeps the local edit when the push lands inside the debounce window', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    // The user finishes a drag; the push is armed for +300ms.
    controller().addClip({ assetId: 'dragged', trackId: 'v1', startFrame: 42 });
    // An agent tool edits main; its 30ms debounce fires before ours.
    window.apply(JSON.stringify(createEmptyProject('Agent state')), undefined);

    expect(clipCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);

    // The local edit reached main, and the inbound state did not become a
    // second edit of its own.
    expect(clipCount()).toBe(1);
    expect(window.pushes).toHaveLength(1);
    expect(clipStarts(JSON.parse(window.pushes[0]))).toEqual([42]);
    // One adoptable step in total: the inbound push added no undo entry.
    expect(controller().canUndo()).toBe(true);
    window.sync.dispose();
  });

  it('keeps the local edit when the push is already on the wire', async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    const window = mount({
      reply: async () => {
        calls += 1;
        // The mount-time push goes straight through; the edit's push is the one
        // held open, so the agent's push lands while it is in flight.
        if (calls !== 2) return { success: true, sequence: calls };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { success: true, sequence: calls };
      },
    });
    await window.sync.ready;

    controller().addClip({ assetId: 'dragged', trackId: 'v1', startFrame: 42 });
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    expect(window.pushes).toHaveLength(2);

    window.apply(JSON.stringify(createEmptyProject('Agent state')), undefined);
    release!();
    await vi.advanceTimersByTimeAsync(0);

    expect(clipCount()).toBe(1);
    // Nothing re-armed a push from the inbound state.
    expect(window.pushes).toHaveLength(2);
    window.sync.dispose();
  });

  it('still adopts a main push when no local write is outstanding', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    window.apply(JSON.stringify(createEmptyProject('Agent state')), undefined);

    expect(controller().getProject().name).toBe('Agent state');
    // One undoable step, as the agent/MCP path documents.
    expect(controller().canUndo()).toBe(true);
    // Adopting is not an edit: it is not pushed back.
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    expect(window.pushes).toEqual([]);
    window.sync.dispose();
  });

  it('still adopts an edit-tagged main push as exactly one undoable step', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    const agentState = createEmptyProject('Agent state');
    window.apply(JSON.stringify(agentState), { source: 'main', kind: 'edit' });

    expect(controller().getProject().name).toBe('Agent state');
    expect(controller().canUndo()).toBe(true);
    // Adopting is not an edit: it is not pushed back.
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    expect(window.pushes).toEqual([]);
    // One step, not two: a single undo takes the whole adopted state back and
    // leaves nothing behind for a second one.
    expect(controller().undo()).toBe(true);
    expect(controller().getProject().name).toBe('Local');
    expect(controller().canUndo()).toBe(false);
    window.sync.dispose();
  });

  it('adopts a playhead-tagged main push as a view update, not an edit', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    // The agent's set_playhead: main's controller published no command, and it
    // says so. The window must not charge the user an undo entry for the agent
    // moving the cursor, nor arm the autosave over a saved document.
    const agent = new EditorController(controller().getProject());
    agent.setPlayhead(120);
    window.apply(JSON.stringify(agent.getProject()), { source: 'main', kind: 'playhead' });

    expect(controller().getPlayhead()).toBe(120);
    expect(controller().canUndo()).toBe(false);
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
    // Adopting a view update is not an edit either, so it is not pushed back.
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    expect(window.pushes).toEqual([]);
    window.sync.dispose();
  });

  it('keeps a playhead push out of the way of a pending local write', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    controller().addClip({ assetId: 'dragged', trackId: 'v1', startFrame: 42 });
    const agent = new EditorController(controller().getProject());
    agent.setPlayhead(120);
    window.apply(JSON.stringify(agent.getProject()), { source: 'main', kind: 'playhead' });

    // Same rule as any other inbound state: the local commit owns the window.
    expect(controller().getPlayhead()).toBe(0);
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    expect(clipCount()).toBe(1);
    expect(controller().canUndo()).toBe(true);
    window.sync.dispose();
  });

  it('holds a tagged sibling push behind the local write and drains it after', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    controller().addClip({ assetId: 'dragged', trackId: 'v1', startFrame: 42 });
    // A sibling's older snapshot arrives mid-drag: it must not land yet.
    window.apply(JSON.stringify(createEmptyProject('Sibling')), { source: 'renderer', sequence: 1 });
    expect(controller().getProject().name).toBe('Local');

    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    // Our own write is sequence 1, so the sibling's sequence-1 event is stale
    // and is discarded rather than replayed over the drag.
    expect(clipCount()).toBe(1);
    window.sync.dispose();
  });

  it('applies a newer sibling snapshot once the local write is accepted', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    controller().addClip({ assetId: 'dragged', trackId: 'v1', startFrame: 42 });
    window.apply(JSON.stringify(createEmptyProject('Sibling')), { source: 'renderer', sequence: 9 });

    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);

    // Sequence 9 is above our acknowledgement (1), so it wins: the sibling was
    // accepted after us, and main already holds it.
    expect(controller().getProject().name).toBe('Sibling');
    expect(window.pushes).toHaveLength(1);
    window.sync.dispose();
  });

  it('ignores a sibling echo of this window’s own snapshot', async () => {
    const window = mount();
    await window.sync.ready;
    window.pushes.length = 0;

    controller().addClip({ assetId: 'local', trackId: 'v1', startFrame: 42 });
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);
    const own = window.pushes[0];

    // Same project, compact spelling: byte-different, semantically identical.
    window.apply(JSON.stringify(JSON.parse(own)), { source: 'renderer', sequence: 5 });

    expect(clipCount()).toBe(1);
    expect(controller().canUndo()).toBe(true);
    window.sync.dispose();
  });
});

/**
 * The window owns the project path and reports each change, because three of
 * the four transitions to a new path (New, a recovery restore, and any future
 * load) never reach a main-owned channel at all. A stale session record is not
 * a cosmetic problem: the reloaded window would then save the new project over
 * the old file.
 */
describe('the session is told which file this window holds', () => {
  it('reports nothing until the path actually changes', async () => {
    const window = mount();
    await window.sync.ready;

    // Edits, a rename, a markDirty: none of them move the document.
    controller().addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 30 });
    useProjectStore.getState().setName('Renamed');
    useProjectStore.getState().markDirty();
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS);

    expect(window.reports).toEqual([]);
    window.sync.dispose();
  });

  it('reports an open, a Save As, a recovery restore and a New project', async () => {
    const window = mount();
    await window.sync.ready;

    // An open, and a Save As over it: both land in the store as the window
    // learns the path, and both are real projects in hand.
    useProjectStore.setState({ filePath: 'C:\\projects\\opened.vproj', isLoaded: true });
    useProjectStore.setState({ filePath: 'C:\\projects\\save-as.vproj' });
    // What useRecovery does when a snapshot is restored: the restored project
    // names the file the snapshot belonged to.
    useProjectStore.setState({ filePath: 'C:\\projects\\recovered.vproj' });
    // And the store's own New project, which reaches main through nothing else.
    useProjectStore.getState().createNew();

    expect(window.reports).toEqual([
      'C:\\projects\\opened.vproj',
      'C:\\projects\\save-as.vproj',
      'C:\\projects\\recovered.vproj',
      null,
    ]);
    window.sync.dispose();
  });

  it('stops reporting once the window is torn down', async () => {
    const window = mount();
    await window.sync.ready;
    window.sync.dispose();

    useProjectStore.setState({ filePath: 'C:\\projects\\after-dispose.vproj' });

    expect(window.reports).toEqual([]);
  });

  it('does not clear the session’s file from a window with no project of its own', async () => {
    const window = mount();
    await window.sync.ready;
    useProjectStore.setState({ filePath: 'C:\\projects\\opened.vproj', isLoaded: true });
    expect(window.reports).toEqual(['C:\\projects\\opened.vproj']);

    // What a reloading window's rebuilt store looks like: no project, no file.
    // The session's record exists to outlive exactly that, so the emptiness is
    // not a report — otherwise the file is gone by the time the window pulls it.
    useProjectStore.setState({ filePath: null, isLoaded: false });

    expect(window.reports).toEqual(['C:\\projects\\opened.vproj']);
    window.sync.dispose();
  });
});
