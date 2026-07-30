/**
 * Autosave + crash recovery.
 *
 * Addresses upstream Palmier Pro #211 ("lost a ton of progress due to a crash
 * exit"). The renderer debounces edits and pushes a snapshot here; we write it
 * atomically to a recovery file in userData. On next launch the renderer asks
 * whether a recovery snapshot exists that is newer than the last real save and
 * can offer to restore it.
 *
 * The recovery file is separate from the user's .vproj so a crash mid-write can
 * never corrupt the real project, and it is cleared on a clean explicit save.
 *
 * The atomic + serialized write contract itself lives in
 * `main/services/project-writer.ts`, shared with explicit project saves.
 */

import { ipcMain, app } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { writeProjectFile } from '../services/project-writer';

interface RecoverySnapshot {
  savedAt: string; // ISO timestamp
  projectFilePath: string | null; // the .vproj this snapshot belongs to (if any)
  projectName: string;
  data: string; // serialized project JSON
}

function recoveryDir(): string {
  return path.join(app.getPath('userData'), 'recovery');
}

function recoveryFile(): string {
  return path.join(recoveryDir(), 'autosave.json');
}

export function registerAutosaveHandlers(): void {
  // Renderer pushes a debounced snapshot of the current project.
  ipcMain.handle(
    'project:autosave',
    async (_event, projectName: string, projectFilePath: string | null, data: string) => {
      try {
        const snapshot: RecoverySnapshot = {
          savedAt: new Date().toISOString(),
          projectFilePath,
          projectName,
          data,
        };
        // Serialized through the shared write coordinator: a debounced
        // autosave burst can no longer collide with itself on one temp file,
        // and each snapshot lands whole (upstream #337 / #422).
        await writeProjectFile(recoveryFile(), JSON.stringify(snapshot));
        return { success: true, savedAt: snapshot.savedAt };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
  );

  // On startup the renderer asks whether a recovery snapshot exists.
  ipcMain.handle('project:recovery-check', async () => {
    try {
      const raw = await fs.readFile(recoveryFile(), 'utf-8');
      const snapshot: RecoverySnapshot = JSON.parse(raw);
      return { hasRecovery: true, snapshot };
    } catch {
      return { hasRecovery: false };
    }
  });

  // Clear the recovery file after a clean save or when the user discards it.
  ipcMain.handle('project:recovery-clear', async () => {
    try {
      await fs.rm(recoveryFile(), { force: true });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}
