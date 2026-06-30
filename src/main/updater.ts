/**
 * Auto-Updater — checks for updates on GitHub Releases.
 *
 * Uses electron-updater's autoUpdater for:
 * - Checking for updates on app start (after 10s delay)
 * - Downloading updates in the background
 * - Prompting user to install + restart
 *
 * Release artifacts are published to GitHub Releases
 * via electron-builder's publish configuration.
 */

import { autoUpdater } from 'electron-updater';
import { BrowserWindow, ipcMain } from 'electron';
import log from 'electron-log';

// Configure logging
autoUpdater.logger = log;

let mainWindow: BrowserWindow | null = null;

export function initAutoUpdater(win: BrowserWindow): void {
  mainWindow = win;

  // Don't auto-download — let user decide
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // ─── Events ──────────────────────────────────────────────────────────────

  autoUpdater.on('checking-for-update', () => {
    sendStatus('checking');
  });

  autoUpdater.on('update-available', (info) => {
    sendStatus('available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate,
    });
  });

  autoUpdater.on('update-not-available', () => {
    sendStatus('not-available');
  });

  autoUpdater.on('download-progress', (progress) => {
    sendStatus('downloading', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      total: progress.total,
      transferred: progress.transferred,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendStatus('ready', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    sendStatus('error', { message: err.message });
  });

  // ─── IPC ─────────────────────────────────────────────────────────────────

  ipcMain.handle('updater:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { success: true, updateInfo: result?.updateInfo };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // ─── Auto-check after delay ──────────────────────────────────────────────

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      // Silent failure on auto-check
    });
  }, 10000);
}

function sendStatus(status: string, data?: Record<string, unknown>): void {
  mainWindow?.webContents.send('updater:status', { status, ...data });
}
