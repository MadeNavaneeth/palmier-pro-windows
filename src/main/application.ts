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
import { registerProxyHandlers } from './media/proxies';
import { registerAiHandlers } from './ai/ipc';
import { registerGenerationHandlers } from './generation';
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
  registerProxyHandlers(editorController);
  registerAiHandlers(() => editorController);
  registerGenerationHandlers();

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
