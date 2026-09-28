/**
 * Which file a session holds, end to end.
 *
 * A reload re-evaluates the renderer bundle, so the window comes back with an
 * empty controller and a project store that knows nothing. The mirror pulls the
 * session's project and adopts it, which restores the work — but the project
 * document does not carry its own path, so Save afterwards opened Save As over
 * a project that was already on disk. Worse, main did not know the path either,
 * so a window that hit New and then reloaded would be handed the OLD file as
 * the new project's home and Save would overwrite it.
 *
 * The record is therefore owned by the main process, per session: the two file
 * operations main performs itself set it, and the renderer's project store —
 * where every transition to a new path actually lands, including the three main
 * cannot see — reports it. This file drives the real handlers both ways: the
 * real `project:open` / `project:save` dialogs, a real .vproj on a real
 * temporary disk, a real `createNew`, a real store path change standing in for
 * a recovery restore, and a real mounted mirror over a real reload.
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
  removeSession,
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
  /** Where the open/save dialogs point, per call. */
  openPath: null as string | null,
  savePath: null as string | null,
  openDialogCalls: 0,
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
    showOpenDialog: async () => {
      electronState.openDialogCalls += 1;
      return electronState.openPath === null
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [electronState.openPath] };
    },
    showSaveDialog: async () => {
      electronState.saveDialogCalls += 1;
      return electronState.savePath === null
        ? { canceled: true }
        : { canceled: false, filePath: electronState.savePath };
    },
  },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null },
}));

const { attachSessionEditorPush, registerEditorSyncHandlers } = await import('./editor-sync');
const { registerProjectHandlers } = await import('./project');

/** useEditorSync's own push debounce, plus scheduling slack. */
const MIRROR_SETTLE_MS = 400;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The file main says the session is holding, through the channel a window uses. */
function sessionFilePath(senderId: number): string | null {
  const response = invoke('editor:get-state', senderId) as { filePath?: unknown };
  return typeof response.filePath === 'string' ? response.filePath : null;
}

let window1: FakeWindow;

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

function mountWindow() {
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
    pushSnapshot: (payload) => windowBridge.editor.syncState(payload),
    onApply: (listener) => {
      target.onSend = listener;
      return () => {
        target.onSend = null;
      };
    },
    reportSessionPath: (filePath) => windowBridge.project.setSessionPath(filePath),
  });
}

/** A project on real disk, as an existing .vproj would be. */
async function writeVprojFile(dir: string, name: string): Promise<string> {
  const staged = new EditorController(createEmptyProject('Recorded project'));
  staged.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 30, durationFrames: 90 });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, staged.serialize(), 'utf-8');
  return filePath;
}

/** Exactly what a re-evaluated bundle leaves behind. */
function simulateReload(): void {
  useTimelineStore.getState().controller.loadProject(createEmptyProject());
  useProjectStore.setState({
    name: 'Untitled Project',
    filePath: null,
    isLoaded: false,
    hasUnsavedChanges: false,
  });
}

const scratchDirs: string[] = [];

beforeAll(() => {
  registerProjectHandlers();
  registerEditorSyncHandlers();
});

beforeEach(async () => {
  resetSessions();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-path-'));
  scratchDirs.push(dir);
  electronState.openPath = null;
  electronState.savePath = null;
  electronState.openDialogCalls = 0;
  electronState.saveDialogCalls = 0;
  vi.stubGlobal('window', { palmier: windowBridge });
  simulateReload();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await drainWrites();
  resetSessions();
  while (scratchDirs.length > 0) {
    await fs.rm(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe('a reloaded window still knows its file', () => {
  it('adopts the session path and saves to it instead of asking for one', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const filePath = await writeVprojFile(dir, 'recorded.vproj');
    session();
    const mirror = mountWindow();
    await mirror.ready;

    // A first launch on a project the user opened: main read the file, so the
    // session knows it even before the window reports anything.
    electronState.openPath = filePath;
    await useProjectStore.getState().openExisting();
    expect(useProjectStore.getState().filePath).toBe(filePath);
    expect(sessionFilePath(1)).toBe(filePath);

    // The user edits, the window reloads.
    useTimelineStore.getState().controller.moveClip(
      useTimelineStore.getState().controller.getClips()[0].id,
      300,
    );
    await delay(MIRROR_SETTLE_MS);
    mirror.dispose();
    simulateReload();
    const reloaded = mountWindow();
    await reloaded.ready;

    // The work came back, and so did the file it belongs to.
    expect(useTimelineStore.getState().project.timeline.clips[0].startFrame).toBe(300);
    expect(useProjectStore.getState().filePath).toBe(filePath);

    // Save targets it: no dialog, and the same file is rewritten.
    const dialogsBefore = electronState.saveDialogCalls;
    await useProjectStore.getState().save();
    await drainWrites();
    expect(electronState.saveDialogCalls).toBe(dialogsBefore);
    const written = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Project;
    expect(written.timeline.clips[0].startFrame).toBe(300);
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
    reloaded.dispose();
  });

  it('still refuses to call a cursor move unsaved work after a reload', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const filePath = await writeVprojFile(dir, 'clean-cursor.vproj');
    session();
    electronState.openPath = filePath;
    await useProjectStore.getState().openExisting();
    const mirror = mountWindow();
    await mirror.ready;
    await useProjectStore.getState().save();
    await drainWrites();
    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
    mirror.dispose();

    simulateReload();
    const reloaded = mountWindow();
    await reloaded.ready;
    // The seed is what it always was; what matters is that moving the cursor
    // afterwards leaves the file it is saved to clean.
    await useProjectStore.getState().save();
    await drainWrites();
    useTimelineStore.getState().controller.setPlayhead(120);
    await delay(MIRROR_SETTLE_MS);

    expect(useProjectStore.getState().hasUnsavedChanges).toBe(false);
    expect(useProjectStore.getState().filePath).toBe(filePath);
    reloaded.dispose();
  });

  it('has no path on a first launch, so Save still offers Save As', async () => {
    session();
    expect(sessionFilePath(1)).toBeNull();
    const mirror = mountWindow();
    await mirror.ready;

    expect(useProjectStore.getState().filePath).toBeNull();

    const dir = scratchDirs[scratchDirs.length - 1]!;
    electronState.savePath = path.join(dir, 'brand-new.vproj');
    const dialogsBefore = electronState.saveDialogCalls;
    await useProjectStore.getState().save();
    await drainWrites();

    expect(electronState.saveDialogCalls).toBe(dialogsBefore + 1);
    expect(useProjectStore.getState().filePath).toBe(path.join(dir, 'brand-new.vproj'));
    // And the session now holds it, so the NEXT reload saves without asking.
    expect(sessionFilePath(1)).toBe(path.join(dir, 'brand-new.vproj'));
    mirror.dispose();
  });
});

describe('every transition to a new path', () => {
  it('sets the session path on a Save As and takes it back over a reload', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const opened = await writeVprojFile(dir, 'opened.vproj');
    session();
    electronState.openPath = opened;
    await useProjectStore.getState().openExisting();
    const mirror = mountWindow();
    await mirror.ready;

    // New project: nothing of the old document survives, including its path.
    useProjectStore.getState().createNew();
    expect(sessionFilePath(1)).toBeNull();

    // Save As: the window has no path, main asks, and the chosen file becomes
    // the session's path from main's own write.
    const chosen = path.join(dir, 'chosen.vproj');
    electronState.savePath = chosen;
    await useProjectStore.getState().save();
    await drainWrites();
    expect(sessionFilePath(1)).toBe(chosen);
    // The file the user opened is untouched: Save As did not write over it.
    const stillThere = JSON.parse(await fs.readFile(opened, 'utf-8')) as Project;
    expect(stillThere.name).toBe('Recorded project');
    mirror.dispose();

    simulateReload();
    const reloaded = mountWindow();
    await reloaded.ready;
    expect(useProjectStore.getState().filePath).toBe(chosen);
    // And a further Save goes straight there, with no dialog in between.
    const dialogsBefore = electronState.saveDialogCalls;
    await useProjectStore.getState().save();
    await drainWrites();
    expect(electronState.saveDialogCalls).toBe(dialogsBefore);
    reloaded.dispose();
  });

  it('does not append a second extension when the chosen name differs only in case', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const upper = path.join(dir, 'MixedCase.VPROJ');
    session();
    const mirror = mountWindow();
    await mirror.ready;

    electronState.savePath = upper;
    await useProjectStore.getState().save();
    await drainWrites();

    // A Windows volume folds case, so CUT.VPROJ names the file we would call
    // CUT.vproj. Appending a second extension wrote a separate document beside
    // the one the user chose and left the original untouched.
    expect(useProjectStore.getState().filePath?.toLowerCase()).toBe(upper.toLowerCase());
    const entries = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.vproj'));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.toLowerCase()).toBe('mixedcase.vproj');
    mirror.dispose();
  });

  it('keeps the path through an import, which edits the open project in place', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const filePath = await writeVprojFile(dir, 'imported-into.vproj');
    session();
    electronState.openPath = filePath;
    await useProjectStore.getState().openExisting();
    const mirror = mountWindow();
    await mirror.ready;

    // A media or FCPXML import adds to the project the user already has open;
    // it is not a new document, so the file it is saved to cannot change. The
    // session's record must survive it untouched.
    useTimelineStore.getState().controller.addClip({
      assetId: 'imported-1',
      trackId: 'v1',
      startFrame: 400,
    });
    await delay(MIRROR_SETTLE_MS);
    expect(sessionFilePath(1)).toBe(filePath);
    expect(useProjectStore.getState().filePath).toBe(filePath);
    mirror.dispose();
  });

  it('is not cleared by a window whose store came back empty', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const filePath = await writeVprojFile(dir, 'survives-empty.vproj');
    session();
    electronState.openPath = filePath;
    await useProjectStore.getState().openExisting();
    const mirror = mountWindow();
    await mirror.ready;

    // A reload rebuilds the store around nothing, and a window with no project
    // of its own has no standing to tell the session it holds no file: the
    // record exists precisely to outlive that empty store.
    useProjectStore.setState({ filePath: null, isLoaded: false });

    expect(sessionFilePath(1)).toBe(filePath);
    mirror.dispose();
  });

  it('takes the path a recovery restore reports, and clears it on a New project', async () => {
    session();
    const mirror = mountWindow();
    await mirror.ready;

    // What useRecovery does when the user restores a snapshot: the restored
    // project names the file the snapshot belonged to, and that set() is the
    // only place main could hear about it.
    useProjectStore.setState({
      name: 'Recovered project',
      filePath: 'C:\\projects\\recovered.vproj',
      isLoaded: true,
      hasUnsavedChanges: true,
    });
    expect(sessionFilePath(1)).toBe('C:\\projects\\recovered.vproj');
    mirror.dispose();

    // New project: the store drops the path, and a session that still held the
    // old one would hand it to the reloaded window and overwrite that file.
    const second = mountWindow();
    useProjectStore.getState().createNew();
    expect(sessionFilePath(1)).toBeNull();
    second.dispose();
  });

  it('never lets one session read or clear another’s path', async () => {
    const a = session();
    const b = createSession();
    const bWindow = fakeWindow(5);
    addWindow(b.id, bWindow);
    attachSessionEditorPush(b);

    invoke('project:set-session-path', 1, 'C:\\projects\\a.vproj');
    invoke('project:set-session-path', 5, 'C:\\projects\\b.vproj');

    expect(sessionFilePath(1)).toBe('C:\\projects\\a.vproj');
    expect(sessionFilePath(5)).toBe('C:\\projects\\b.vproj');

    // B clears its own; A is untouched.
    invoke('project:set-session-path', 5, null);
    expect(sessionFilePath(5)).toBeNull();
    expect(sessionFilePath(1)).toBe('C:\\projects\\a.vproj');
    expect(a.controller).toBeDefined();
  });
});

describe('what a closed window takes with it', () => {
  it('drops the path with the session and leaves every other session alone', async () => {
    const a = session();
    invoke('project:set-session-path', 1, 'C:\\projects\\a.vproj');

    // A panel of the same session: one document, one path, whichever window
    // asks.
    invoke('project:set-session-path', 1, 'C:\\projects\\a-renamed.vproj');

    const b = createSession();
    const bWindow = fakeWindow(5);
    addWindow(b.id, bWindow);
    attachSessionEditorPush(b);
    invoke('project:set-session-path', 5, 'C:\\projects\\b.vproj');

    removeSession(a.id);

    // A fresh session never inherits the closed window's document, and B is
    // still holding its own.
    const c = createSession();
    const cWindow = fakeWindow(6);
    addWindow(c.id, cWindow);
    attachSessionEditorPush(c);
    expect(sessionFilePath(6)).toBeNull();
    expect(sessionFilePath(5)).toBe('C:\\projects\\b.vproj');
    expect(b.controller).toBeDefined();
  });
});

describe('the path report is validated at the boundary', () => {
  it('refuses a value that is not a path, and answers for no session', () => {
    session();

    expect(invoke('project:set-session-path', 1, '')).toMatchObject({ success: false });
    expect(invoke('project:set-session-path', 1, 'C:\\a\0b.vproj')).toMatchObject({ success: false });
    expect(invoke('project:set-session-path', 1, 42)).toMatchObject({ success: false });
    expect(invoke('project:set-session-path', 1, { path: 'C:\\a.vproj' })).toMatchObject({ success: false });
    // None of those changed the record.
    expect(sessionFilePath(1)).toBeNull();

    // A window with no session cannot name a document at all.
    expect(invoke('project:set-session-path', 999, 'C:\\a.vproj')).toMatchObject({ success: false });
  });
});
