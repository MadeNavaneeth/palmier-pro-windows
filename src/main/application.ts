/**
 * Palmier Pro Windows - application lifecycle and feature registration.
 */

import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerProjectHandlers } from './ipc/project';
import { registerMediaHandlers } from './ipc/media';
import { registerSystemHandlers } from './ipc/system';
import { registerAutosaveHandlers } from './ipc/autosave';
import { registerEditorSyncHandlers } from './ipc/editor-sync';
import { getPreviewCompositor, registerPreviewHandlers } from './media/preview-compositor';
import { registerExportHandlers } from './media/exporter';
import { registerAudioHandlers } from './media/audio-envelope';
import { registerMarkerSettingsHandlers } from './markers/marker-settings';
import { registerProxyHandlers } from './media/proxies';
import { registerAiHandlers, isAgentBusy } from './ai/ipc';
import { registerGenerationHandlers } from './generation';
import { registerDetachedPanelsHandlers } from './ipc/detached-panels';
import { DetachedPanelsManager } from './windows/detached-panels';
import { DETACHED_WINDOW_CONFIG, type DetachablePanel } from '../shared/ui/detached-panels';
import { initAutoUpdater } from './updater';
import { EditorController } from '../shared/editor/controller';

let mainWindow: BrowserWindow | null = null;
const editorController = new EditorController();
const isDev = !app.isPackaged;
const currentDir = path.dirname(fileURLToPath(import.meta.url));

function createMainWindow(): BrowserWindow {
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

  if (isDev && process.env['VITE_DEV_SERVER_URL']) {
    void win.loadURL(process.env['VITE_DEV_SERVER_URL']);
  } else {
    void win.loadFile(path.join(currentDir, '../renderer/index.html'));
  }

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

/**
 * A panel in its own window (upstream #286).
 *
 * Same sandbox contract as the main window — the detached renderer is the same
 * bundle, so it gets the same preload, isolation, and navigation lockdown.
 * State needs no extra plumbing: editor sync already broadcasts to every
 * window, and per-window streams target the requesting web contents.
 */
function createDetachedWindow(panel: DetachablePanel): BrowserWindow {
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

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  if (isDev && process.env['VITE_DEV_SERVER_URL']) {
    const url = new URL(process.env['VITE_DEV_SERVER_URL']);
    url.searchParams.set('panel', panel);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(path.join(currentDir, '../renderer/index.html'), { query: { panel } });
  }

  return win;
}

export function startApplication(): void {
  const previewCompositor = getPreviewCompositor();

  registerProjectHandlers();
  registerMediaHandlers();
  registerSystemHandlers();
  registerAutosaveHandlers();
  registerEditorSyncHandlers(editorController, async (project, win) => {
    previewCompositor.setProject(project);
    if (win) {
      await previewCompositor.compositeFrame(project.timeline.playheadFrame, win);
    }
  });
  registerPreviewHandlers(() => editorController.getProject());
  registerExportHandlers(() => editorController.getProject());
  registerAudioHandlers();
  registerMarkerSettingsHandlers(editorController);
  registerProxyHandlers(editorController);
  registerAiHandlers(() => editorController);
  registerGenerationHandlers();

  const detachedPanels = new DetachedPanelsManager({
    createWindow: (panel) => createDetachedWindow(panel),
    // The Agent may not move mid-turn: a transcript captured while the answer
    // is still streaming would be missing the answer. The renderer disables
    // the control too, but the refusal lives here so no caller can skip it.
    canDetach: (panel) =>
      panel === 'agent' && isAgentBusy()
        ? { ok: false as const, error: 'A turn is in progress. Stop it before moving the chat.' }
        : { ok: true as const },
    broadcast: (panels) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('panels:detached-changed', panels);
      }
    },
  });
  registerDetachedPanelsHandlers(detachedPanels);

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  mainWindow = createMainWindow();

  if (!isDev) {
    initAutoUpdater(mainWindow);
  }

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
}
