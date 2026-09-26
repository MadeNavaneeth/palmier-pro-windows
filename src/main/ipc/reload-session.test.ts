/**
 * Reload coverage across the real main/renderer boundary.
 *
 * `View → Reload` re-evaluates the renderer bundle while the session in main
 * keeps the same webContents, the same session id and the same controller. The
 * mirror used to push unconditionally on mount, so a reloaded window replaced
 * the session's project with its own empty default, reset the preview
 * compositor to it and told every sibling window to adopt it — and the
 * pre-reload recovery snapshot `useAutosave` writes on `beforeunload`, which
 * main skips because the session is still live, was then overwritten with the
 * same empty project by the first edit after the reload.
 *
 * Both halves run against the real IPC handlers here: `editor:get-state`,
 * `editor:sync-from-renderer`, `attachSessionEditorPush`, and
 * `project:autosave` writing a real recovery file.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { EditorController } from '../../shared/editor/controller';
import { createEmptyProject, type Project } from '../../shared/types/project';
import { useProjectStore } from '../../renderer/store/project';
import { useTimelineStore } from '../../renderer/store/timeline';
import { createEditorSync } from '../../renderer/hooks/useEditorSync';
import { drainWrites } from '../services/project-writer';
import {
  addWindow,
  createSession,
  resetSessions,
  type Session,
  type SessionWindow,
} from '../sessions';

type MockHandler = (
  event: { sender: { id: number } },
  ...args: unknown[]
) => unknown;

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, MockHandler>(),
  userData: '',
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: MockHandler) => {
      electronState.handlers.set(channel, handler);
    },
  },
  app: { getPath: () => electronState.userData },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null },
}));

const { attachSessionEditorPush, registerEditorSyncHandlers } = await import('./editor-sync');
const { registerAutosaveHandlers, recoveryFileForSession } = await import('./autosave');
const { registerProjectHandlers } = await import('./project');

/** Same value as useEditorSync. */
const PUSH_DEBOUNCE_MS = 300;
const SETTLE_MS = PUSH_DEBOUNCE_MS + 100;

interface FakeWindow extends SessionWindow {
  sent: Array<{ payload: unknown; metadata: unknown }>;
  /** Delivered to the mounted mirror, standing in for the preload bridge. */
  onSend: ((payload: unknown, metadata: unknown) => void) | null;
}

function fakeWindow(id: number): FakeWindow {
  const win: FakeWindow = {
    id,
    isDestroyed: () => false,
    sent: [],
    onSend: null,
    send: (...args: unknown[]) => {
      win.sent.push({ payload: args[1], metadata: args[2] });
      win.onSend?.(args[1], args[2]);
    },
  };
  return win;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function invoke(channel: string, senderId: number, ...args: unknown[]): unknown {
  const handler = electronState.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler: ${channel}`);
  return handler({ sender: { id: senderId } }, ...args);
}

function sessionOf(window: FakeWindow): Session {
  const session = createSession();
  addWindow(session.id, window);
  attachSessionEditorPush(session);
  return session;
}

/**
 * A renderer controller holding real work, and the same state in the session.
 *
 * A real window reaches this through the debounced renderer push, so it goes
 * through the real handler rather than poking the main controller.
 */
async function workInSession(
  window: FakeWindow,
  name: string,
): Promise<EditorController> {
  const renderer = new EditorController(createEmptyProject(name));
  renderer.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 30, durationFrames: 90 });
  await invoke('editor:sync-from-renderer', window.id, JSON.stringify(renderer.getProject()));
  return renderer;
}

/** Reset the renderer store the way a re-evaluated bundle leaves it. */
function simulateReload(): void {
  useTimelineStore.getState().controller.loadProject(createEmptyProject());
  useProjectStore.setState({
    name: 'Untitled Project',
    filePath: null,
    isLoaded: false,
    hasUnsavedChanges: false,
  });
}

/** Mount the mirror over the real handlers, as useEditorSync does. */
function mountRendererMirror(window: FakeWindow) {
  return createEditorSync({
    controller: useTimelineStore.getState().controller,
    pullSessionState: async () => {
      const response = invoke('editor:get-state', window.id) as {
        success: boolean;
        data?: unknown;
        filePath?: unknown;
      };
      return {
        project: response.success ? response.data as Project : null,
        filePath: typeof response.filePath === 'string' ? response.filePath : null,
      };
    },
    pushSnapshot: async (payload) => invoke('editor:sync-from-renderer', window.id, payload),
    onApply: (listener) => {
      window.onSend = listener;
      return () => {
        window.onSend = null;
      };
    },
    reportSessionPath: async (filePath) => invoke('project:set-session-path', window.id, filePath),
  });
}

const scratchDirs: string[] = [];

beforeAll(() => {
  registerProjectHandlers();
  registerEditorSyncHandlers();
  registerAutosaveHandlers();
});

beforeEach(async () => {
  resetSessions();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-reload-'));
  scratchDirs.push(dir);
  electronState.userData = dir;
  useTimelineStore.getState().controller.loadProject(createEmptyProject('Local'));
  useProjectStore.setState({
    name: 'Untitled Project',
    filePath: null,
    isLoaded: false,
    hasUnsavedChanges: false,
  });
});

afterEach(async () => {
  await drainWrites();
  resetSessions();
  while (scratchDirs.length > 0) {
    await fs.rm(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe('reloading a window', () => {
  it('adopts the session state and never offers it an empty project', async () => {
    const window = fakeWindow(1);
    const session = sessionOf(window);
    await workInSession(window, 'Pre-reload work');

    // A detached panel of the same session, joining before the reload.
    const sibling = fakeWindow(2);
    addWindow(session.id, sibling);
    simulateReload();
    const mirror = mountRendererMirror(window);
    await mirror.ready;

    // The session still holds the work: the reloaded window pushed nothing, so
    // the compositor was never reset and no sibling was told to adopt an empty
    // project.
    expect(session.controller.getProject().name).toBe('Pre-reload work');
    expect(session.controller.getProject().timeline.clips).toHaveLength(1);
    expect(sibling.sent).toEqual([]);
    await delay(SETTLE_MS);
    expect(sibling.sent).toEqual([]);

    // The window is the workspace again rather than the Welcome screen.
    expect(useProjectStore.getState().isLoaded).toBe(true);
    expect(useTimelineStore.getState().project.name).toBe('Pre-reload work');
    mirror.dispose();
  });

  it('leaves the pre-reload recovery snapshot holding the real work', async () => {
    const window = fakeWindow(1);
    const session = sessionOf(window);
    const renderer = await workInSession(window, 'Pre-reload work');
    const recoveryPath = recoveryFileForSession(
      path.join(electronState.userData, 'recovery'),
      session.id,
    );

    // useAutosave's beforeunload: a reload keeps the webContents, so this is
    // the still-live session's own file.
    await invoke('project:autosave', 1, 'Pre-reload work', null, renderer.serialize());
    await drainWrites();
    const before = await fs.readFile(recoveryPath, 'utf-8');
    expect(JSON.parse((JSON.parse(before) as { data: string }).data).timeline.clips)
      .toHaveLength(1);

    simulateReload();
    const mirror = mountRendererMirror(window);
    await mirror.ready;

    // The seed is silent, so nothing has scheduled an autosave at all.
    await delay(SETTLE_MS);
    expect(await fs.readFile(recoveryPath, 'utf-8')).toBe(before);

    // Now the user touches something. useAutosave's payload is exactly
    // controller.serialize(), four seconds after the mutation.
    useTimelineStore.getState().controller.addClip({
      assetId: 'asset-2',
      trackId: 'v1',
      startFrame: 400,
    });
    await delay(SETTLE_MS);
    await invoke(
      'project:autosave',
      1,
      'Pre-reload work',
      null,
      useTimelineStore.getState().controller.serialize(),
    );
    await drainWrites();

    const recovered = JSON.parse(
      (JSON.parse(await fs.readFile(recoveryPath, 'utf-8')) as { data: string }).data,
    ) as Project;
    // The only copy of the user's work still contains it: the pre-reload clip
    // and the post-reload edit, never an empty project.
    expect(recovered.timeline.clips).toHaveLength(2);
    expect(recovered.name).toBe('Pre-reload work');
    mirror.dispose();
  });
});
