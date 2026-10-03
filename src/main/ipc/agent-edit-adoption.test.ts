/**
 * What an agent turn costs the user's undo stack, end to end.
 *
 * The agent tools run against the session's controller in main, not the window's,
 * so every agent change reaches the UI as a push. That push used to be adopted
 * through `adoptProject(project, 'AI edit')` — one undoable step, by design —
 * which meant the agent's `set_playhead` landed as an "AI edit" in the user's
 * undo stack and marked a saved project dirty: the autosave then wrote a
 * recovery snapshot for a document nobody had edited, and the next launch
 * offered to recover it.
 *
 * Both halves run here for real: `editor:execute` through the actual
 * ToolExecutor, `attachSessionEditorPush` for the broadcast, and a mounted
 * `createEditorSync` for the window that receives it. The window is a fresh
 * controller over the shared renderer store, so an undo entry and a dirty mark
 * are observed exactly where the user would see them.
 *
 * The claim under test is narrow and two-sided: a cursor move costs nothing,
 * and a real edit still costs exactly one undo step.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { createEmptyProject, type Project } from '../../shared/types/project';
import { useProjectStore } from '../../renderer/store/project';
import { useTimelineStore } from '../../renderer/store/timeline';
import { createEditorSync, type EditorSync } from '../../renderer/hooks/useEditorSync';
import { addWindow, createSession, resetSessions, type Session, type SessionWindow } from '../sessions';

type MockHandler = (
  event: { sender: { id: number } },
  ...args: unknown[]
) => unknown;

const handlers = new Map<string, MockHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: MockHandler) => {
      handlers.set(channel, handler);
    },
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null },
  // Present so the executor's grade-preset repository opens its (mocked) store
  // instead of falling back with a warning; the path is never read.
  app: { getPath: () => 'C:\\palmier-tests' },
}));

// The executor builds the app-wide grade-preset repository on construction, and
// that reaches electron-store. In memory is enough: no tool call here touches a
// preset, and a real store would put a file in userData for nothing.
vi.mock('electron-store', () => {
  class Store {
    private readonly values = new Map<string, unknown>();

    get(key: string): unknown {
      return this.values.get(key);
    }

    set(key: string, value: unknown): void {
      this.values.set(key, value);
    }

    delete(key: string): void {
      this.values.delete(key);
    }
  }
  return { default: Store };
});

const { attachSessionEditorPush, registerEditorSyncHandlers } = await import('./editor-sync');
const { registerProjectHandlers } = await import('./project');

/** editor-sync's push debounce, plus scheduling slack. */
const SETTLE_MS = 80;
/** useEditorSync's own push debounce, plus scheduling slack. */
const MIRROR_SETTLE_MS = 400;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settle(): Promise<void> {
  return delay(SETTLE_MS);
}

interface FakeWindow extends SessionWindow {
  /** Delivered to the mounted mirror, standing in for the preload bridge. */
  onSend: ((payload: unknown, metadata: unknown) => void) | null;
}

function fakeWindow(id: number): FakeWindow {
  const win: FakeWindow = {
    id,
    isDestroyed: () => false,
    onSend: null,
    send: (_channel: string, ...args: unknown[]) => {
      win.onSend?.(args[0], args[1]);
    },
  };
  return win;
}

function invoke(channel: string, senderId: number, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing handler: ${channel}`);
  return handler({ sender: { id: senderId } }, ...args);
}

/**
 * One agent tool call, exactly as the in-app agent and MCP make it.
 *
 * Awaiting this drains microtasks only and never returns to the event loop, so
 * two calls awaited back to back land inside one push debounce window — the
 * case the collapsed tag has to survive.
 */
async function agent(tool: string, args: Record<string, unknown>): Promise<{ success: boolean }> {
  return await invoke('editor:execute', 1, tool, args) as { success: boolean };
}

function controller(): EditorController {
  return useTimelineStore.getState().controller;
}

/** Where each clip ends, so a trim is identifiable without depending on ids. */
function clipEnds(): number[] {
  return controller().getProject().timeline.clips
    .map((clip) => clip.startFrame + clip.durationFrames);
}

let window1: FakeWindow;

/** A session whose main window is the one this test drives the agent through. */
function session(): Session {
  const created = createSession();
  window1 = fakeWindow(1);
  addWindow(created.id, window1);
  attachSessionEditorPush(created);
  return created;
}

/**
 * A saved project the window is looking at: two clips, so a batch edit has
 * something real to change and one undo has something real to take back.
 */
function loadSavedProject(): void {
  const saved = new EditorController(createEmptyProject('Agent turn'));
  saved.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 30, durationFrames: 90 });
  saved.addClip({ assetId: 'asset-2', trackId: 'v1', startFrame: 200, durationFrames: 60 });
  const before = saved.getProject();
  controller().loadProject(before);
  useProjectStore.setState({
    name: before.name,
    filePath: 'C:\\projects\\agent-turn.vproj',
    isLoaded: true,
    hasUnsavedChanges: false,
  });
}

/** Mount the window's mirror over the real handlers, as useEditorSync does. */
function mountWindow(): EditorSync {
  const target = window1;
  return createEditorSync({
    controller: controller(),
    pullSessionState: async () => {
      const response = invoke('editor:get-state', target.id) as {
        success: boolean;
        data?: unknown;
        filePath?: unknown;
      };
      return {
        project: response.success ? response.data as Project : null,
        filePath: typeof response.filePath === 'string' ? response.filePath : null,
      };
    },
    pushSnapshot: async (payload, filePath) =>
      invoke('editor:sync-from-renderer', target.id, payload, filePath),
    onApply: (listener) => {
      target.onSend = listener;
      return () => {
        target.onSend = null;
      };
    },
    reportSessionPath: async (filePath) => invoke('project:set-session-path', target.id, filePath),
  });
}

beforeAll(() => {
  registerProjectHandlers();
  registerEditorSyncHandlers();
});

beforeEach(() => {
  resetSessions();
  loadSavedProject();
});

afterEach(() => {
  resetSessions();
});

describe('an agent turn in the undo stack', () => {
  it('costs nothing for a playhead move, and still moves the cursor', async () => {
    const main = session();
    const mirror = mountWindow();
    await mirror.ready;

    expect(await agent('set_playhead', { frame: 120 })).toMatchObject({ success: true });
    await settle();

    // The cursor reached the window...
    expect(controller().getPlayhead()).toBe(120);
    // ...through no command, so there is nothing to undo, and no dirty mark to
    // arm the autosave over a project the agent only looked at.
    expect(controller().canUndo()).toBe(false);
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
    // The move is not discarded either: it is the frame main composites.
    expect(main.controller.getPlayhead()).toBe(120);
    mirror.dispose();
  });

  it('costs exactly one undo step for a real edit, and still marks it dirty', async () => {
    const main = session();
    const mirror = mountWindow();
    await mirror.ready;
    const before = controller().getProject();

    // trim_clips runs two domain operations inside one transaction, so anything
    // but a single adoption step would leave a fragment behind.
    expect(await agent('trim_clips', {
      edits: [
        { clipId: before.timeline.clips[0].id, endFrame: 100 },
        { clipId: before.timeline.clips[1].id, endFrame: 250 },
      ],
    })).toMatchObject({ success: true });
    await settle();

    expect(clipEnds()).toEqual([100, 250]);
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(true);

    // One entry: one undo reverts the whole tool call, and there is no second
    // one behind it for the user to walk into.
    expect(controller().undo()).toBe(true);
    expect(controller().getProject().timeline.clips).toEqual(before.timeline.clips);
    expect(controller().canUndo()).toBe(false);
    // The undo is a local edit like any other, so it reaches the session on the
    // mirror's own debounce: main is not left holding a project the window has
    // already taken back, which is what the next agent turn would reason about.
    await delay(MIRROR_SETTLE_MS);
    expect(main.controller.getProject().timeline.clips).toEqual(before.timeline.clips);
    mirror.dispose();
  });

  it('tells a cursor move and an edit apart inside one turn', async () => {
    // The push debounce collapses a turn, so the tag describes the whole window
    // rather than whichever notification arrived last. Both orders matter: a
    // turn that ends on a cursor move is still an edit.
    for (const order of ['playhead-first', 'edit-first'] as const) {
      resetSessions();
      loadSavedProject();
      session();
      const mirror = mountWindow();
      await mirror.ready;
      const before = controller().getProject();
      const trim = {
        edits: [{ clipId: before.timeline.clips[0].id, endFrame: 100 }],
      };

      // Awaiting between the two calls drains microtasks only, so both land
      // inside the same debounce window — which is the case under test.
      if (order === 'playhead-first') {
        expect(await agent('set_playhead', { frame: 90 })).toMatchObject({ success: true });
        expect(await agent('trim_clips', trim)).toMatchObject({ success: true });
      } else {
        expect(await agent('trim_clips', trim)).toMatchObject({ success: true });
        expect(await agent('set_playhead', { frame: 90 })).toMatchObject({ success: true });
      }
      await settle();

      // Both halves of the turn arrived...
      expect(controller().getPlayhead()).toBe(90);
      expect(clipEnds()[0]).toBe(100);
      // ...and the turn is an edit: dirty, and one undo step.
      expect(useProjectStore.getState().hasUnsavedChanges).toBe(true);
      expect(controller().undo()).toBe(true);
      expect(controller().canUndo()).toBe(false);
      expect(controller().getProject().timeline.clips).toEqual(before.timeline.clips);
      mirror.dispose();
    }
  });

  it('tags a detached panel’s copy of the same cursor move the same way', async () => {
    const main = session();
    const mirror = mountWindow();
    await mirror.ready;
    // A detached panel joins the session and gets the same push, so it makes
    // the same adoption decision without sharing the workspace's store.
    const panel = fakeWindow(2);
    addWindow(main.id, panel);
    let panelPush: { payload: unknown; metadata: unknown } | null = null;
    panel.send = (channel: string, ...args: unknown[]) => {
      if (channel === 'editor:apply-from-main') panelPush = { payload: args[0], metadata: args[1] };
    };

    await agent('set_playhead', { frame: 60 });
    await settle();

    expect(panelPush).not.toBeNull();
    expect((panelPush as unknown as { metadata: { kind: unknown } }).metadata.kind)
      .toBe('playhead');

    // Once the window has applied the path the first push carried, the path is
    // spent and the cursor moves after it carry no path at all — a panel that
    // joined late was not handed a path it already had on every push since.
    await delay(MIRROR_SETTLE_MS);
    await agent('set_playhead', { frame: 61 });
    await settle();
    expect((panelPush as unknown as { metadata: { filePath?: unknown } }).metadata)
      .not.toHaveProperty('filePath');
    mirror.dispose();
  });
});
