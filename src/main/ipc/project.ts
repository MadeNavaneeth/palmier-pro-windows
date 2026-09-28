/**
 * IPC handlers for project file operations.
 * .vproj files are JSON with a defined schema (see shared/types/project.ts).
 *
 * Which file a session holds is not kept here but in `../session-project-path`,
 * which every side of the boundary records into — this module's two file
 * operations, the renderer's own report of its store, and the agent's
 * document switches. This file is the IPC surface over that record.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { writeProjectFile, pruneAbandonedWriteTemps } from '../services/project-writer';
import { loadRecentProjects, recordRecentProject } from '../services/recent-projects';
import {
  NO_SESSION_ERROR,
  getSessionForSender,
} from '../sessions';
import { rememberSessionPath, isSessionFilePath, recordSessionProjectPath } from '../session-project-path';

const VPROJ_EXTENSION = '.vproj';
const VPROJ_FILTER = { name: 'Palmier Project', extensions: ['vproj'] };

export function registerProjectHandlers(): void {
  // ─── Save Project ────────────────────────────────────────────────────────────

  ipcMain.handle('project:save', async (event, projectJson: string, filePath?: string) => {
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

    // Ensure extension. Case-insensitively: a Windows volume folds case, so a
    // user who chose CUT.VPROJ means the file we would call CUT.vproj, and a
    // case-sensitive test appended a second one beside it.
    if (!targetPath.toLowerCase().endsWith(VPROJ_EXTENSION)) {
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
    } catch (err: any) {
      return { success: false, error: err.message };
    }

    // A hard kill during a previous save left a full-size staging file beside
    // this project, and nothing ever removed it. This is the only directory the
    // save path is about, so it is swept here rather than by a cleaner that
    // would have to walk wherever a project happens to live. The recovery
    // pipeline cannot cover it: it only ever visits its own directory. After the
    // write, so the sweep never adds a directory read to the failure path, and
    // best effort, so pruning can never turn a saved project into a failed save.
    await pruneAbandonedWriteTemps(path.dirname(targetPath));

    // This handler wrote the file, so the path it landed on is the session's
    // path with no dependence on the renderer reporting it back.
    rememberSessionPath(event?.sender, targetPath);
    // And it is a project this app has genuinely saved, which is what the
    // recent list and the launch sweep that depends on it are built from.
    recordRecentProject(targetPath);

    return { success: true, path: targetPath };
  });

  // ─── Open Project ────────────────────────────────────────────────────────────

  ipcMain.handle('project:open', async (event) => {
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
      // Read the file here, so the session's path is known from this call alone
      // even if the window that asked dies before it can report anything.
      rememberSessionPath(event?.sender, filePath);
      // A read that succeeded is the strongest evidence available that this is
      // a project the user works in, so it is recorded for the same reasons.
      recordRecentProject(filePath);
      return { success: true, data: content, path: filePath };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ─── Session Project Path ───────────────────────────────────────────────────
  // The renderer owns the path in its project store and every transition to a
  // new one lands there, but main sees only the two above: `createNew` writes
  // no file and reaches no main-owned channel, and a recovery restore is a pure
  // renderer-side load. So the mirror reports the store's value when it changes,
  // and this is the record a reloaded window pulls back with the project. The
  // sender's session is the isolation boundary, exactly as for every other
  // handler: one window can never name another session's document.
  ipcMain.handle('project:set-session-path', (event, filePath: unknown) => {
    const session = getSessionForSender(event.sender);
    if (!session) return { success: false, error: NO_SESSION_ERROR };
    // The record and its validation live in `../session-project-path`, because
    // the agent's own document switches record through the same pair.
    if (filePath === null) {
      recordSessionProjectPath(session, null);
      return { success: true, filePath: null };
    }
    if (!isSessionFilePath(filePath)) {
      return { success: false, error: 'Invalid project file path.' };
    }
    recordSessionProjectPath(session, filePath);
    return { success: true, filePath };
  });

  // ─── Recent Projects ─────────────────────────────────────────────────────────
  // Recorded by the two file-I/O handlers above, not by anything the renderer
  // reports, and persisted by `recent-projects.ts`. A bare path list because no
  // consumer exists yet: the preload exposes `getRecent` but no renderer calls
  // it, so nothing constrains the shape and there is nothing to pre-shape for.
  ipcMain.handle('project:get-recent', async () => loadRecentProjects());
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
