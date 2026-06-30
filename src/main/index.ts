/**
 * Palmier Pro Windows — Main Process Entry Point
 *
 * Responsibilities:
 * - Window lifecycle management
 * - IPC handler registration
 * - FFmpeg/ffprobe bridge
 * - Project file IO
 * - Native addon (Rust compositor) loading
 * - MCP server lifecycle (Phase 6)
 */

import { app, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron';
import path from 'path';
import { registerProjectHandlers } from './ipc/project';
import { registerMediaHandlers } from './ipc/media';
import { registerSystemHandlers } from './ipc/system';
import { registerAutosaveHandlers } from './ipc/autosave';
import { registerEditorSyncHandlers } from './ipc/editor-sync';
import { registerPreviewHandlers } from './media/preview-compositor';
import { registerExportHandlers } from './media/exporter';
import { registerAudioHandlers } from './media/audio-envelope';
import { registerAiHandlers } from './ai/ipc';
import { registerGenerationHandlers } from './generation';
import { initAutoUpdater } from './updater';
import { EditorController } from '../shared/editor/controller';

// Keep a global reference to prevent GC
let mainWindow: BrowserWindow | null = null;
const editorController = new EditorController();

const isDev = !app.isPackaged;

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
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
    show: false,
  });

  // Graceful show once ready
  win.once('ready-to-show', () => {
    win.show();
    if (isDev) {
      win.webContents.openDevTools({ mode: 'bottom' });
    }
  });

  // Load renderer
  if (isDev && process.env['VITE_DEV_SERVER_URL']) {
    win.loadURL(process.env['VITE_DEV_SERVER_URL']);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Register all IPC handlers
  registerProjectHandlers();
  registerMediaHandlers();
  registerSystemHandlers();
  registerAutosaveHandlers();
  registerEditorSyncHandlers(editorController);
  registerPreviewHandlers();
  registerExportHandlers(() => editorController.getProject());
  registerAudioHandlers();
  registerAiHandlers(() => editorController);
  registerGenerationHandlers();

  mainWindow = createMainWindow();

  // Auto-updater (non-blocking, checks after 10s)
  if (!isDev) {
    initAutoUpdater(mainWindow);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
  }
});

// ─── Security: restrict navigation & new windows ─────────────────────────────

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });
});
