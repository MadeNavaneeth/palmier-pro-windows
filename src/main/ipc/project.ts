/**
 * IPC handlers for project file operations.
 * .vproj files are JSON with a defined schema (see shared/types/project.ts).
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'fs/promises';
import path from 'path';

const VPROJ_EXTENSION = '.vproj';
const VPROJ_FILTER = { name: 'Palmier Project', extensions: ['vproj'] };

export function registerProjectHandlers(): void {
  // ─── Save Project ────────────────────────────────────────────────────────────
  ipcMain.handle('project:save', async (_event, projectJson: string, filePath?: string) => {
    let targetPath = filePath;

    if (!targetPath) {
      const win = BrowserWindow.getFocusedWindow();
      const result = await dialog.showSaveDialog(win!, {
        title: 'Save Project',
        defaultPath: `Untitled${VPROJ_EXTENSION}`,
        filters: [VPROJ_FILTER],
      });
      if (result.canceled || !result.filePath) return { success: false, path: null };
      targetPath = result.filePath;
    }

    // Ensure extension
    if (!targetPath.endsWith(VPROJ_EXTENSION)) {
      targetPath += VPROJ_EXTENSION;
    }

    try {
      await fs.writeFile(targetPath, projectJson, 'utf-8');
      return { success: true, path: targetPath };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── Open Project ────────────────────────────────────────────────────────────
  ipcMain.handle('project:open', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: 'Open Project',
      filters: [VPROJ_FILTER],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, data: null };
    }

    const filePath = result.filePaths[0];
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, data: content, path: filePath };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── Recent Projects ─────────────────────────────────────────────────────────
  ipcMain.handle('project:get-recent', async () => {
    // TODO: persist recent list via electron-store
    return [];
  });
}
