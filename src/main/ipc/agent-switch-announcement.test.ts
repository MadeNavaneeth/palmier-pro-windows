/**
 * The announcement is consumed by a window APPLYING it, not by a push carrying it.
 *
 * `announced` is what makes a push's path a change rather than a constant. It was
 * cleared the moment a push was BUILT, inside the debounce timer, which is not
 * the same event as a window reading it: `useEditorSync` refuses an inbound push
 * outright whenever a local write is still outstanding, and a refused window
 * never sees the path, yet the flag was already spent. Nothing re-armed it, so
 * no later push could correct that window, and across a reload it came back
 * holding one project's state and another project's path — after which its next
 * Save wrote the user's own document into the file the agent had switched away
 * from, leaving the user's file stale on disk.
 *
 * Measured before the fix: main's record named the agent's file, the window's
 * store still named the user's, and the next push carried no path at all.
 *
 * These run both halves for real, as `agent-project-switch-path.test.ts` does:
 * the real `editor:execute` handler driving the real `ToolExecutor`, the real
 * `project:open` dialog handler, a real `useEditorSync` mount over the real
 * renderer store, and real .vproj files on a real temporary disk.
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
import { ToolExecutor } from '../ai/executor';
import { consumeSessionProjectPathAnnouncement } from '../session-project-path';
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
const settle = () => delay(SETTLE_MS);

interface FakeWindow extends SessionWindow {
  onSend: ((payload: unknown, metadata: unknown) => void) | null;
  /** Every main-side push this window received, in order. */
  pushes: Array<{ filePath: unknown; kind: unknown; projectName: string }>;
}

function fakeWindow(id: number): FakeWindow {
  const win: FakeWindow = {
    id,
    isDestroyed: () => false,
    onSend: null,
    pushes: [],
    send: (_channel: string, ...args: unknown[]) => {
      const meta = (args[1] ?? {}) as { filePath?: unknown; kind?: unknown };
      let projectName = '?';
      try {
        projectName = (JSON.parse(args[0] as string) as Project).name;
      } catch { /* not a project payload */ }
      if (meta.kind !== undefined) {
        win.pushes.push({ filePath: meta.filePath, kind: meta.kind, projectName });
      }
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
function sessionFilePath(senderId = 1): string | null {
  const response = invoke('editor:get-state', senderId) as { filePath?: unknown };
  return typeof response.filePath === 'string' ? response.filePath : null;
}

/** One Agent tool call, exactly as the in-app agent and MCP make it. */
function agent(tool: string, args: Record<string, unknown>): Promise<unknown> {
  return Promise.resolve(invoke('editor:execute', 1, tool, args));
}

let window1: FakeWindow;

function session(): Session {
  const created = createSession();
  window1 = fakeWindow(1);
  addWindow(created.id, window1);
  attachSessionEditorPush(created);
  return created;
}

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
    pushSnapshot: async (payload, filePath) =>
      invoke('editor:sync-from-renderer', target.id, payload, filePath),
    onApply: (listener) => {
      target.onSend = listener;
      return () => {
        target.onSend = null;
      };
    },
    reportSessionPath: async (filePath) =>
      invoke('project:set-session-path', target.id, filePath),
  });
}

/** A project on real disk, with bytes that identify it. */
async function writeVprojFile(
  dir: string,
  name: string,
  projectName: string,
  startFrame = 30,
): Promise<string> {
  const staged = new EditorController(createEmptyProject(projectName));
  staged.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame, durationFrames: 90 });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, staged.serialize(), 'utf-8');
  return filePath;
}

/** The on-disk truth, read back as real bytes. */
async function onDisk(filePath: string): Promise<string> {
  try {
    const raw = await fs.readFile(filePath);
    const p = JSON.parse(raw.toString('utf-8')) as Project;
    return [
      `bytes=${raw.length}`,
      `name=${JSON.stringify(p.name)}`,
      `startFrame=${p.timeline.clips[0]?.startFrame}`,
      `fps=${p.settings?.fps}`,
    ].join(' ');
  } catch (err) {
    return `ABSENT (${(err as NodeJS.ErrnoException).code ?? String(err)})`;
  }
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-announce-'));
  scratchDirs.push(dir);
  electronState.openPath = null;
  electronState.savePath = null;
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

/** Open A through the real dialog handler and mount the window over it. */
async function openA(dir: string): Promise<{ a: string; mirror: EditorSync }> {
  const a = await writeVprojFile(dir, 'A.vproj', 'A Original', 30);
  session();
  electronState.openPath = a;
  await useProjectStore.getState().openExisting();
  const mirror = mountWindow();
  await mirror.ready;
  return { a, mirror };
}

/**
 * Arm the renderer's 300ms debounce so the next inbound push is refused: a
 * local edit that has not been committed yet, which is the real condition.
 */
function armPendingLocalWrite(): void {
  const ctrl = useTimelineStore.getState().controller;
  ctrl.moveClip(ctrl.getClips()[0].id, 111);
}

describe('a refused push leaves the announcement pending', () => {
  it('and the next push that can carry a path carries it', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const b = await writeVprojFile(dir, 'B.vproj', 'B Project', 60);
    const { mirror } = await openA(dir);

    // The agent switches documents, and the push lands inside the window's
    // debounce, so the window refuses it and never reads the path.
    armPendingLocalWrite();
    expect(await agent('open_project', { path: b })).toMatchObject({ success: true });
    await settle();

    // The refused push did carry the path — it was offered and not applied.
    expect(window1.pushes.some((p) => p.filePath === b)).toBe(true);
    expect(useProjectStore.getState().droppedSync).toMatchObject({ kind: 'edit' });

    // Nothing spent it: the next main-side push still carries it.
    window1.pushes.length = 0;
    expect(await agent('set_project_settings', { fps: 48 })).toMatchObject({ success: true });
    await settle();
    expect(window1.pushes.map((p) => p.filePath)).toContain(b);
    mirror.dispose();
  });

  it('and the window and the record never disagree about which file it is on', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const b = await writeVprojFile(dir, 'B.vproj', 'B Project', 60);
    const { mirror } = await openA(dir);

    armPendingLocalWrite();
    expect(await agent('open_project', { path: b })).toMatchObject({ success: true });
    await settle();

    // Mid-flight the agent switch has won main while the window still holds A,
    // which is the refusal itself: the announcement is pending, not spent.
    expect(sessionFilePath()).toBe(b);
    expect(useProjectStore.getState().filePath).not.toBe(b);

    // Either the window applies a later push carrying B, or its own pending
    // snapshot wins the session back. Both are legitimate; what must never
    // happen is the record naming one project while the session holds another.
    await delay(MIRROR_SETTLE_MS);
    expect(await agent('set_project_settings', { fps: 48 })).toMatchObject({ success: true });
    await settle();
    await delay(MIRROR_SETTLE_MS);

    expect(sessionFilePath()).toBe(useProjectStore.getState().filePath);
    mirror.dispose();
  });
});

describe('the M10 sequence: a refused push across a reload', () => {
  it('never pairs one project with another project\'s path', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const b = await writeVprojFile(dir, 'B-reload.vproj', 'B Reload', 60);
    const { mirror } = await openA(dir);

    armPendingLocalWrite();
    expect(await agent('open_project', { path: b })).toMatchObject({ success: true });
    await settle();

    // The refusal happened: the window never applied the project, so main still
    // holds the agent's document and the announcement is still pending.
    expect(useProjectStore.getState().droppedSync).toMatchObject({ kind: 'edit' });
    expect(useTimelineStore.getState().project.name).toBe('A Original');
    expect(sessionFilePath()).toBe(b);

    // The window reloads BEFORE the pending announcement could be re-delivered,
    // which is the sequence that used to strand it: a pull pairs whatever main
    // holds with whatever file main names.
    mirror.dispose();
    simulateReload();
    const reloaded = mountWindow();
    await reloaded.ready;


    // The project and the path it is paired with must be the same project.
    const documentName = useTimelineStore.getState().project.name;
    const held = useProjectStore.getState().filePath;
    expect(held).not.toBeNull();
    const heldName = (JSON.parse(await fs.readFile(held!, 'utf-8')) as Project).name;
    // The pairing is the whole assertion: the file the window holds is the
    // file its own project came from, whichever project that turned out to be.
    expect(heldName).toBe(documentName);
    expect(sessionFilePath()).toBe(held);
    reloaded.dispose();
  });

  it('and the user\'s own file is what Ctrl+S writes', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const b = await writeVprojFile(dir, 'B-reload.vproj', 'B Reload', 60);
    const { a, mirror } = await openA(dir);
    const aBefore = await onDisk(a);
    const bBefore = await onDisk(b);

    armPendingLocalWrite();
    expect(await agent('open_project', { path: b })).toMatchObject({ success: true });
    await settle();
    await delay(MIRROR_SETTLE_MS);
    mirror.dispose();

    simulateReload();
    const reloaded = mountWindow();
    await reloaded.ready;

    // The user works in the window and saves. Whichever document the window
    // came back to, the save must land in THAT document's own file, and the
    // file it did not come back to must be byte-identical to before.
    const held = useProjectStore.getState().filePath!;
    const dialogsBefore = electronState.saveDialogCalls;
    await useProjectStore.getState().save();
    await drainWrites();

    expect(electronState.saveDialogCalls).toBe(dialogsBefore);
    expect(useProjectStore.getState().filePath).toBe(held);
    const untouched = held === a ? b : a;
    expect(await onDisk(untouched)).toBe(held === a ? bBefore : aBefore);
    reloaded.dispose();
  });
});

describe('an announced path is delivered once, and not re-sent', () => {
  it('carries it on the switch, then not on the pushes that follow', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const b = await writeVprojFile(dir, 'B-announce.vproj', 'B Announce', 60);
    const { mirror } = await openA(dir);

    expect(await agent('open_project', { path: b })).toMatchObject({ success: true });
    await settle();
    expect(window1.pushes.map((p) => p.filePath)).toContain(b);

    // The window applied it and reported the path back, which spends it. The
    // pushes after that must carry no path at all.
    await delay(MIRROR_SETTLE_MS);
    window1.pushes.length = 0;
    for (let i = 0; i < 3; i += 1) {
      expect(await agent('set_project_settings', { fps: 30 + i })).toMatchObject({ success: true });
      await settle();
    }
    expect(window1.pushes.length).toBeGreaterThan(0);
    for (const push of window1.pushes) expect(push.filePath).toBeUndefined();
    expect(useProjectStore.getState().filePath).toBe(b);
    mirror.dispose();
  });

  it('still rides the project push, so a window is never left naming a file whose project it did not get', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const b = await writeVprojFile(dir, 'B-vproj', 'B Project', 60);
    const { mirror } = await openA(dir);

    expect(await agent('open_project', { path: b })).toMatchObject({ success: true });
    await settle();
    await delay(MIRROR_SETTLE_MS);

    // The document arrived and the path came with it, in the same update.
    expect(useTimelineStore.getState().project.name).toBe('B Project');
    expect(useProjectStore.getState().filePath).toBe(b);
    expect(useProjectStore.getState().name).toBe('B Project');
    mirror.dispose();
  });
});

describe('the renderer push reconciles the record with the project it carries', () => {
  it('and a reload after the window wins the session back stays paired', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const a = await writeVprojFile(dir, 'A.vproj', 'A Original', 30);
    const b = await writeVprojFile(dir, 'B.vproj', 'B Project', 60);
    const bBefore = await onDisk(b);
    session();
    electronState.openPath = a;
    await useProjectStore.getState().openExisting();
    const mirror = mountWindow();
    await mirror.ready;

    armPendingLocalWrite();
    expect(await agent('open_project', { path: b })).toMatchObject({ success: true });
    await settle();
    expect(useProjectStore.getState().droppedSync).toMatchObject({ kind: 'edit' });

    // The window's own pending snapshot lands and wins the session back. That
    // push is the window asserting "this is the session's project, in this file",
    // and it is the only statement main gets: the store reports a path only when
    // the path CHANGES, and the window never changed its own.
    await delay(MIRROR_SETTLE_MS);

    expect(sessionFilePath()).toBe(a);

    // A reload with no further main-side notification at all.
    mirror.dispose();
    simulateReload();
    const reloaded = mountWindow();
    await reloaded.ready;

    const held = useProjectStore.getState().filePath!;
    const documentName = useTimelineStore.getState().project.name;
    const heldName = (JSON.parse(await fs.readFile(held, 'utf-8')) as Project).name;
    expect(heldName).toBe(documentName);
    expect(sessionFilePath()).toBe(held);

    // And the user's Save writes that same file, leaving the other untouched.
    await useProjectStore.getState().save();
    await drainWrites();
    expect(await onDisk(a)).toContain('startFrame=111');
    expect(await onDisk(b)).toBe(bBefore);
    reloaded.dispose();
  });
});

describe('the original guarantee: an external executor on a live session', () => {
  it('a caller-chosen save never retargets the window, and Ctrl+S writes the window\'s own file', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const a = await writeVprojFile(dir, 'A.vproj', 'A Original', 30);
    const b = await writeVprojFile(dir, 'B-mcp.vproj', 'B MCP', 60);
    const x = path.join(dir, 'X-mcp.vproj');
    const main = createSession();
    window1 = fakeWindow(1);
    addWindow(main.id, window1);
    attachSessionEditorPush(main);
    // What `resolveMcpController(null)` hands an MCP request with no session
    // header: the active session's own controller.
    const external = new ToolExecutor(main.controller);

    electronState.openPath = a;
    await useProjectStore.getState().openExisting();
    const mirror = mountWindow();
    await mirror.ready;
    const aBefore = await onDisk(a);

    // The documented batch: open, edit, save to a path the caller chose.
    expect(await external.execute('open_project', { path: b })).toMatchObject({ success: true });
    expect(await external.execute('set_project_settings', { fps: 48 })).toMatchObject({ success: true });
    expect(await external.execute('save_project', { path: x })).toMatchObject({ success: true });
    await settle();
    await delay(MIRROR_SETTLE_MS);

    // The agent's switch moved the window onto the file it opened.
    expect(useProjectStore.getState().filePath).toBe(b);

    // The user's Save writes the document the window is showing, which is B,
    // and A — the file the user opened — is untouched by the whole batch.
    await useProjectStore.getState().save();
    await drainWrites();
    expect(useProjectStore.getState().filePath).toBe(b);
    expect(await onDisk(a)).toBe(aBefore);
    expect((await onDisk(b))).toContain('fps=48');
    mirror.dispose();
  });
});

describe('a window that already holds the path', () => {
  it('spends the announcement on applying it, so later pushes carry no path', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const a = await writeVprojFile(dir, 'A.vproj', 'A Original', 30);
    session();
    electronState.openPath = a;
    await useProjectStore.getState().openExisting();
    const mirror = mountWindow();
    await mirror.ready;
    await delay(MIRROR_SETTLE_MS);

    // `project:open` armed this path and the mount-time push spent it, so arm it
    // again the way an agent's document switch does, on a window that ALREADY
    // holds it: adopting that push changes no store value, so the store's own
    // report never fires, and only the confirmation on the unchanged store can
    // spend it.
    window1.pushes.length = 0;
    expect(await agent('open_project', { path: a })).toMatchObject({ success: true });
    await settle();
    expect(window1.pushes.map((p) => p.filePath)).toEqual([a]);

    // Applying that push is what spends it, so the cursor moves after it carry
    // nothing. Without the confirmation on an unchanged store the path rides
    // every push for the life of the session.
    window1.pushes.length = 0;
    expect(await agent('set_playhead', { frame: 61 })).toMatchObject({ success: true });
    await settle();
    expect(window1.pushes.length).toBeGreaterThan(0);
    for (const push of window1.pushes) expect(push.filePath).toBeUndefined();
    mirror.dispose();
  });

  it('and a detached panel joining later is handed the path exactly once', async () => {
    const dir = scratchDirs[scratchDirs.length - 1]!;
    const a = await writeVprojFile(dir, 'A.vproj', 'A Original', 30);
    const main = session();
    electronState.openPath = a;
    await useProjectStore.getState().openExisting();
    const mirror = mountWindow();
    await mirror.ready;
    await delay(MIRROR_SETTLE_MS);

    // A panel joins the session. It shares the session but not the store, so it
    // never reports a path, and it must not be able to hold the announcement
    // open forever by never confirming it.
    const panel = fakeWindow(2);
    addWindow(main.id, panel);

    panel.pushes.length = 0;
    expect(await agent('open_project', { path: a })).toMatchObject({ success: true });
    await settle();
    expect(panel.pushes.map((p) => p.filePath)).toEqual([a]);

    panel.pushes.length = 0;
    expect(await agent('set_playhead', { frame: 61 })).toMatchObject({ success: true });
    await settle();
    expect(panel.pushes.length).toBeGreaterThan(0);
    for (const push of panel.pushes) expect(push.filePath).toBeUndefined();
    mirror.dispose();
  });
});

describe('the consuming function itself', () => {
  it('spends a matching announcement and nothing else', () => {
    const s = createSession();
    const w = fakeWindow(77);
    addWindow(s.id, w);

    // No record yet, so a report is a write: it records and arms.
    consumeSessionProjectPathAnnouncement(s, 'C:\\projects\\a.vproj');
    expect(sessionFilePath(77)).toBe('C:\\projects\\a.vproj');

    // A report of a DIFFERENT path is that window asserting a change of its own,
    // so it is recorded as a write rather than treated as a confirmation.
    consumeSessionProjectPathAnnouncement(s, 'C:\\projects\\b.vproj');
    expect(sessionFilePath(77)).toBe('C:\\projects\\b.vproj');
  });
});
