/**
 * Palmier Pro Windows - application lifecycle and feature registration.
 *
 * Multi-window sessions (upstream #137): one Electron process hosts
 * N main windows; each window owns one session — a minted id, its own
 * EditorController, its own PalmierAgent (Slice 2), its own recovery file,
 * and its own detached-panel set.
 * Project/editor IPC resolves the session from `event.sender`
 * (main/sessions.ts); channel names and payload shapes are unchanged.
 * File → New Window (CmdOrCtrl+N) opens another session.
 *
 * Deliberate globals kept for this slice (each noted again at its
 * registration below):
 *   - Preview compositor and Exporter: per-session since Slice 3 — each
 *     session previews and exports its own project with its own cancel
 *     scope; only the native addon loading and MCP-side default export
 *     owner stay process-wide.
 *   - MCP HTTP endpoint: one process-wide listener (token + port); each
 *     request resolves the session's controller it acts on (Slice 2).
 *     PalmierAgent is per session since Slice 2 (#137) — each window's agent,
 *     busy state, and cancel are its own.
 *   - Renderer localStorage (workspace layout, splits): still shared across
 *     all windows of the same origin — two windows can fight over layout
 *     writes. Named grade presets are app-wide main-process preferences and
 *     are intentionally not stored there.
 */

import { app, BrowserWindow, Menu, type WebContents } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerProjectHandlers } from './ipc/project';
import { registerMediaHandlers } from './ipc/media';
import { registerSystemHandlers } from './ipc/system';
import { registerAutosaveHandlers } from './ipc/autosave';
import { registerEditorSyncHandlers, attachSessionEditorPush } from './ipc/editor-sync';
import {
  disposePreviewCompositor,
  getPreviewCompositorFor,
  registerPreviewHandlers,
} from './media/preview-compositor';
import { registerExportHandlers } from './media/exporter';
import { registerAudioHandlers } from './media/audio-envelope';
import {
  applyMarkerSettings,
  registerMarkerSettingsHandlers,
} from './markers/marker-settings';
import { registerProxyHandlers } from './media/proxies';
import { registerAiHandlers } from './ai/ipc';
import { registerGradePresetHandlers } from './grade-preset-ipc';
import { isSessionAgentBusy } from './ai/session-agent';
import { registerGenerationHandlers } from './generation';
import { registerDetachedPanelsHandlers } from './ipc/detached-panels';
import { DetachedPanelsManager } from './windows/detached-panels';
import { DETACHED_WINDOW_CONFIG, type DetachablePanel } from '../shared/ui/detached-panels';
import { initAutoUpdater } from './updater';
import {
  addWindow,
  broadcastToSession,
  createSession,
  getSession,
  getSessionForSender,
  listSessions,
  markSessionActive,
  removeSession,
  removeWindow,
  type Session,
  type SessionSender,
} from './sessions';
import type { Project } from '../shared/types/project';

const isDev = !app.isPackaged;
const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** One detached-panel manager per session: the panel set is not process-wide. */
const panelManagers = new Map<string, DetachedPanelsManager>();

function createMainWindow(): BrowserWindow {
  // One session per main window: fresh id, controller, recovery path.
  const session = createSession();
  attachSessionEditorPush(session);
  applyMarkerSettings(session.controller);

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0a0a0b',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#111113',
      symbolColor: '#f4f4f5',
      height: 36,
    },
    webPreferences: {
      preload: path.join(currentDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // A video editor's Play button is expected to produce sound without a
      // second gesture; Chromium's autoplay heuristic otherwise blocks the
      // first preview playback after launch.
      autoplayPolicy: 'no-user-gesture-required',
    },
    show: false,
  });

  // Register before load: the renderer's first IPC arrives only after the
  // page has loaded, which is always after this point.
  addWindow(session.id, win.webContents);

  // The MCP endpoint's default target is the most recently focused main
  // window's session (#137 Slice 2). Detached panels never change it — only
  // a main window's focus does, and a fresh session starts active.
  win.on('focus', () => markSessionActive(session.id));

  let hasShown = false;
  const showWindow = (): void => {
    if (hasShown || win.isDestroyed()) return;
    hasShown = true;
    win.show();
  };

  win.once('ready-to-show', showWindow);
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`Renderer failed to load (${errorCode}): ${errorDescription}`);
    showWindow();
  });

  // Never leave the application invisible if ready-to-show is not emitted.
  setTimeout(showWindow, 3000);

  // ?session=<id> mirrors the ?panel= query detached windows use; IPC routing
  // itself is sender-based, so the renderer never has to read it.
  if (isDev && process.env['VITE_DEV_SERVER_URL']) {
    const url = new URL(process.env['VITE_DEV_SERVER_URL']);
    url.searchParams.set('session', session.id);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(path.join(currentDir, '../renderer/index.html'), {
      query: { session: session.id },
    });
  }

  // The workspace dies with its main window: close its detached panels first
  // so they cannot outlive the session whose state they mirror, then drop the
  // registry entry (which unmaps every remaining sender lookup).
  const mainContentsId = win.webContents.id;
  win.on('closed', () => {
    const live = getSession(session.id);
    if (!live) return;
    for (const contents of [...live.windows.values()]) {
      if (contents.id === mainContentsId || contents.isDestroyed()) continue;
      BrowserWindow.fromWebContents(contents as WebContents)?.destroy();
    }
    removeSession(session.id);
    panelManagers.delete(session.id);
    // The session's preview caches die with it (#137 Slice 3) — a long-lived
    // process opening and closing windows must not accumulate compositors.
    disposePreviewCompositor(session.id);
  });

  return win;
}

/**
 * A panel in its own window (upstream #286).
 *
 * Same sandbox contract as the main window — the detached renderer is the same
 * bundle, so it gets the same preload, isolation, and navigation lockdown.
 * The window joins the parent session (#137): editor sync broadcasts reach it
 * with the parent's project, and per-window streams target the requesting web
 * contents.
 */
function createDetachedWindow(panel: DetachablePanel, sessionId: string): BrowserWindow {
  const config = DETACHED_WINDOW_CONFIG[panel];
  const win = new BrowserWindow({
    width: config.width,
    height: config.height,
    minWidth: config.minWidth,
    minHeight: config.minHeight,
    backgroundColor: '#0a0a0b',
    title: config.title,
    webPreferences: {
      preload: path.join(currentDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
    show: false,
  });

  addWindow(sessionId, win.webContents);
  const contentsId = win.webContents.id;
  win.on('closed', () => {
    // Panel closed from its own chrome while the session lives on: drop just
    // this window. (Closing the whole session tears its windows down itself.)
    removeWindow(contentsId);
  });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  if (isDev && process.env['VITE_DEV_SERVER_URL']) {
    const url = new URL(process.env['VITE_DEV_SERVER_URL']);
    url.searchParams.set('panel', panel);
    url.searchParams.set('session', sessionId);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(path.join(currentDir, '../renderer/index.html'), {
      query: { panel, session: sessionId },
    });
  }

  return win;
}

/**
 * The session's detached-panel manager, created on first use.
 *
 * Per session (#137): two workspaces must be able to detach the same panel
 * independently, each window showing its own project. The broadcast is scoped
 * to the session's windows for the same reason — a panel opened from session
 * A is nobody else's business.
 */
function panelManagerFor(session: Session): DetachedPanelsManager {
  let manager = panelManagers.get(session.id);
  if (!manager) {
    manager = new DetachedPanelsManager({
      createWindow: (panel) => createDetachedWindow(panel, session.id),
      // The Agent may not move mid-turn: a transcript captured while the answer
      // is still streaming would be missing the answer. The renderer disables
      // the control too, but the refusal lives here so no caller can skip it.
      // Per session (#137 Slice 2): only THIS workspace's agent blocks its own
      // detach — another window's in-flight turn is nobody else's business.
      canDetach: (panel) =>
        panel === 'agent' && isSessionAgentBusy(session.id)
          ? { ok: false as const, error: 'A turn is in progress. Stop it before moving the chat.' }
          : { ok: true as const },
      broadcast: (panels) => broadcastToSession(session.id, 'panels:detached-changed', panels),
    });
    panelManagers.set(session.id, manager);
  }
  return manager;
}

/**
 * Application menu, created with File → New Window (#137).
 *
 * Built explicitly rather than left to Electron's default so the new command
 * ships with the standard Edit/View/Window items (roles are item-level, which
 * behaves the same on Windows). Ctrl+N is intentionally NOT claimed here: the
 * renderer's `newProject` chord (shared/editor/shortcuts.ts) keeps it.
 * New Window uses Ctrl+Shift+N so both commands stay reachable.
 */
function installApplicationMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            createMainWindow();
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

export function startApplication(): void {
  registerProjectHandlers();
  registerMediaHandlers();
  registerSystemHandlers();
  registerAutosaveHandlers();
  registerEditorSyncHandlers(async (project, win) => {
    // The sync's sender determines the session; the push goes to that
    // window's own compositor so two windows can mirror different projects
    // (#137 Slice 3).
    if (!win) return;
    const session = getSessionForSender({ id: win.webContents.id });
    if (!session) return;
    const compositor = getPreviewCompositorFor(session.id);
    compositor.setProject(project);
    await compositor.compositeFrame(project.timeline.playheadFrame, win);
  });
  // Sender → session id + session project for the per-session media handlers
  // (#137 Slice 3): preview compositors and export jobs are keyed by the
  // session that asked, so concurrent windows never share request gates,
  // caches, or cancel state.
  const resolveSessionMedia = (
    sender: SessionSender,
  ): { sessionId: string; project: Project } | null => {
    const session = getSessionForSender(sender);
    return session ? { sessionId: session.id, project: session.controller.getProject() } : null;
  };
  registerPreviewHandlers(resolveSessionMedia);
  registerExportHandlers(resolveSessionMedia);
  registerAudioHandlers();
  registerMarkerSettingsHandlers(() => listSessions().map((session) => session.controller));
  registerProxyHandlers((sender) => getSessionForSender(sender)?.controller ?? null);
  // Per-session agent + MCP controller routing (#137 Slice 2): handlers
  // resolve the session from the sender; each session owns its own
  // PalmierAgent, and the MCP listener resolves controllers per request.
  registerAiHandlers(getSessionForSender);
  registerGradePresetHandlers();
  registerGenerationHandlers();

  registerDetachedPanelsHandlers((sender) => {
    const session = getSessionForSender(sender);
    return session ? panelManagerFor(session) : null;
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  installApplicationMenu();
  const firstWindow = createMainWindow();

  if (!isDev) {
    initAutoUpdater(firstWindow);
  }

  // With N windows this fires only when the LAST one closes, so one process
  // still quits as a unit; single-instance lock in index.ts is unchanged.
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}
