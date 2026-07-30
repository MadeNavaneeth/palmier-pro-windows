/**
 * IPC handlers for project file operations.
 * .vproj files are JSON with a defined schema (see shared/types/project.ts).
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { writeProjectFile } from '../services/project-writer';

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

    // Refuse a payload that is not a project document before touching the file.
    // The write itself is atomic, so the previous project survives any failure,
    // but there is no reason to stage bytes we already know are unusable.
    if (typeof projectJson !== 'string' || !isParsableProject(projectJson)) {
      return { success: false, error: 'Refusing to save: project payload is not valid project JSON.' };
    }

    try {
      // Serialized + atomic: overlapping saves and autosaves for the same file
      // queue instead of racing, and a failed write leaves the last good
      // project on disk (upstream #337 / #403 / #422).
      await writeProjectFile(targetPath, projectJson);
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

/** A project document must at minimum parse as a JSON object. */
function isParsableProject(projectJson: string): boolean {
  try {
    const parsed = JSON.parse(projectJson);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
