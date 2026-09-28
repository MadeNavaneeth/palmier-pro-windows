/**
 * Which file a session holds after the Agent switches documents.
 *
 * `open_project` and `new_project` run in main against the session's own
 * controller, so the document the window ends up looking at arrives as a push
 * — but the path that document lives in does not travel with it. The project
 * document cannot carry its own path, and the renderer's project store is the
 * window's authority over it, so the window kept naming the file it had before
 * the agent switched: Save wrote the newly-opened project over the old file.
 *
 * Both halves run for real here. `editor:execute` is the real handler driving
 * the real `ToolExecutor`, `project:open` is the real dialog handler, the
 * window is the real `useEditorSync` mount over the real renderer store, and
 * the paths are real .vproj files on a real temporary disk — so the assertion
 * that has to hold is the agreement between what the store says, what the
 * session record says, and what is on disk.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { EditorController } from '../../shared/editor/controller';
import { createEmptyProject, type Project } from '../../shared/types/project';
import { useProjectStore } from '../../renderer/store/project';
import { useTimelineStore } from '../../renderer/store/timeline';
import { createEditorSync, type EditorSync } from '../../renderer/hooks/useEditorSync';
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
  openPath: null as string | null,
  savePath: null as string | null,
  saveDialogCalls: 0,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: MockHandler) => {
      electronState.handlers.set(channel, handler);
    },
  },
  app: { getPath: () => os.tmpdir() },
  dialog: {
    showOpenDialog: async () => (
      electronState.openPath === null
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [electronState.openPath] }
    ),
    showSaveDialog: async () => {
      electronState.saveDialogCalls += 1;
      return electronState.savePath === null
        ? { canceled: true }
        : { canceled: false, filePath: electronState.savePath };
    },
  },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null },
}));

// The executor builds the app-wide grade-preset repository on construction, and
// that reaches electron-store. In memory is enough: no tool call here touches
// a preset, and a real store would put a file in userData for nothing.
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settle(): Promise<void> {
  return delay(SETTLE_MS);
}

interface FakeWindow extends SessionWindow {
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
  const handler = electronState.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler: ${channel}`);
  return handler({ sender: { id: senderId } }, ...args);
}

/** The file main says the session is holding, through the channel a window uses. */
function sessionFilePath(senderId: number): string | null {
  const response = invoke('editor:get-state', senderId) as { filePath?: unknown };
  return typeof response.filePath === 'string' ? response.filePath : null;
}

/** One Agent tool call, exactly as the in-app agent and MCP make it. */
function agent(tool: string, args: Record<string, unknown>): Promise<unknown> {
  return Promise.resolve(invoke('editor:execute', 1, tool, args));
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
 * The renderer half, wired to the real handlers exactly as `useEditorSync`
 * wires them, so the store, the pull and the report are the production ones.
 */
const windowBridge = {
  project: {
    open: () => Promise.resolve(invoke('project:open', 1)),
    save: (projectJson: string, filePath?: string) =>
      Promise.resolve(invoke('project:save', 1, projectJson, filePath)),
    setSessionPath: (filePath: string | null) =>
      Promise.resolve(invoke('project:set-session-path', 1, filePath)),
    recoveryClear: async () => ({ success: true }),
  },
  editor: {
    getState: () => Promise.resolve(invoke('editor:get-state', 1)),
    syncState: (payload: string) => Promise.resolve(invoke('editor:sync-from-renderer', 1, payload)),
  },
};

/** Mount the window's mirror over the real handlers, as useEditorSync does. */
function mountWindow(): EditorSync {
  const target = window1;
  return createEditorSync({
    controller: useTimelineStore.getState().controller,
    pullSessionState: async () => {
      const response = await windowBridge.editor.getState() as {
        success: boolean;
        data?: unknown;
        filePath?: unknown;
      };
      return {
        project: response.success ? response.data as Project : null,
        filePath: typeof response.filePath === 'string' ? response.filePath : null,
      };
    },
    pushSnapshot: async (payload) => invoke('editor:sync-from-renderer', target.id, payload),
    onApply: (listener) => {
      target.onSend = listener;
      return () => {
        target.onSend = null;
      };
    },
    reportSessionPath: async (filePath) => invoke('project:set-session-path', target.id, filePath),
  });
}

/** A project on real disk, as an existing .vproj would be. */
async function writeVprojFile(dir: string, name: string, projectName: string): Promise<string> {
  const staged = new EditorController(createEmptyProject(projectName));
  staged.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 30, durationFrames: 90 });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, staged.serialize(), 'utf-8');
  return filePath;
}

async function readProject(filePath: string): Promise<Project> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as Project;
}

const scratchDirs: string[] = [];

beforeAll(() => {
  registerProjectHandlers();
  registerEditorSyncHandlers();
});

beforeEach(async () => {
  resetSessions();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-agent-path-'));
  scratchDirs.push(dir);
  electronState.openPath = null;
  electronState.savePath = null;
  electronState.saveDialogCalls = 0;
  vi.stubGlobal('window', { palmier: windowBridge });
  // Exactly what a re-evaluated bundle leaves behind.
  useTimelineStore.getState().controller.loadProject(createEmptyProject());
  useProjectStore.setState({
    name: 'Untitled Project',
    filePath: null,
    isLoaded: false,
    hasUnsavedChanges: false,
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await drainWrites();
  resetSessions();
  while (scratchDirs.length > 0) {
    await fs.rm(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe('an Agent-initiated project switch', () => {
  it('moves the window and the session onto the file it opened', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const before = await writeVprojFile(dir, 'before.vproj', 'Before project');
    const after = await writeVprojFile(dir, 'after.vproj', 'After project');
    const main = session();
    electronState.openPath = before;
    await useProjectStore.getState().openExisting();
    const mirror = mountWindow();
    await mirror.ready;
    expect(useProjectStore.getState().filePath).toBe(before);

    expect(await agent('open_project', { path: after })).toMatchObject({ success: true });
    await settle();

    // The document itself did arrive: main and the window are both looking at
    // the project the agent opened.
    expect(main.controller.getProject().name).toBe('After project');
    expect(useTimelineStore.getState().project.name).toBe('After project');
    // And the file it lives in is now the one both sides name.
    expect(useProjectStore.getState().filePath).toBe(after);
    expect(sessionFilePath(1)).toBe(after);
    // The document's own name travels with it: `save` stamps this one into the
    // file, so a store still holding the old name would write the new project
    // under the old project's title.
    expect(useProjectStore.getState().name).toBe('After project');
    mirror.dispose();
  });

  it('saves to the file the agent opened, and leaves the previous one untouched', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const before = await writeVprojFile(dir, 'opened-then-abandoned.vproj', 'Before project');
    const after = await writeVprojFile(dir, 'agent-opened.vproj', 'After project');
    session();
    electronState.openPath = before;
    await useProjectStore.getState().openExisting();
    const mirror = mountWindow();
    await mirror.ready;

    expect(await agent('open_project', { path: after })).toMatchObject({ success: true });
    expect(await agent('set_project_settings', { fps: 48 })).toMatchObject({ success: true });
    await settle();

    const dialogsBefore = electronState.saveDialogCalls;
    await useProjectStore.getState().save();
    await drainWrites();

    // A known path is not a Save As, and the edit lands in the file the agent
    // opened rather than in the one the window happened to start on.
    expect(electronState.saveDialogCalls).toBe(dialogsBefore);
    expect((await readProject(after)).settings.fps).toBe(48);
    expect((await readProject(after)).name).toBe('After project');
    expect((await readProject(before)).settings.fps).not.toBe(48);
    expect((await readProject(before)).name).toBe('Before project');
    mirror.dispose();
  });

  it('leaves no path behind when the agent starts a new project', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const opened = await writeVprojFile(dir, 'replaced-by-new.vproj', 'Before project');
    session();
    electronState.openPath = opened;
    await useProjectStore.getState().openExisting();
    const mirror = mountWindow();
    await mirror.ready;

    expect(await agent('new_project', { name: 'Agent scratch' })).toMatchObject({ success: true });
    await settle();

    expect(useTimelineStore.getState().project.name).toBe('Agent scratch');
    expect(useProjectStore.getState().name).toBe('Agent scratch');
    // Nothing of the old document survives, its file least of all: keeping it
    // would have the next Save overwrite the project the agent replaced.
    expect(useProjectStore.getState().filePath).toBeNull();
    expect(sessionFilePath(1)).toBeNull();

    // So Save asks for a file, and the one it writes becomes the session's.
    electronState.savePath = path.join(dir, 'agent-new.vproj');
    const dialogsBefore = electronState.saveDialogCalls;
    await useProjectStore.getState().save();
    await drainWrites();

    expect(electronState.saveDialogCalls).toBe(dialogsBefore + 1);
    expect(useProjectStore.getState().filePath).toBe(electronState.savePath);
    expect(sessionFilePath(1)).toBe(electronState.savePath);
    expect((await readProject(electronState.savePath!)).name).toBe('Agent scratch');
    // The project the agent replaced is still the project it was.
    expect((await readProject(opened)).name).toBe('Before project');
    mirror.dispose();
  });
});
