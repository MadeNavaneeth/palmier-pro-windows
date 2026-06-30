/**
 * Editor state sync (renderer <-> main).
 *
 * The renderer's timeline controller is the authoritative source of truth so
 * UI editing stays local and fast. This module keeps the main-process
 * controller mirrored to it, and pushes agent/MCP edits back:
 *
 *   renderer edits  -> editor:sync-from-renderer -> main.setProjectSilent (no echo)
 *   agent/MCP edits -> main.controller change     -> editor:apply-from-main -> renderer.adoptProject
 *
 * setProjectSilent does not notify, so mirroring the renderer never triggers a
 * push back; only genuine main-side (agent/MCP) edits push to the renderer.
 */

import { ipcMain, BrowserWindow } from 'electron';
import type { EditorController } from '../../shared/editor/controller';

export function registerEditorSyncHandlers(controller: EditorController): void {
  // Renderer pushes its authoritative project to main (no history, no echo).
  ipcMain.handle('editor:sync-from-renderer', (_event, projectJson: string) => {
    try {
      controller.setProjectSilent(JSON.parse(projectJson));
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Push main-side edits (agent / MCP) to the renderer, debounced so a
  // multi-tool agent turn collapses into a single UI update.
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  controller.subscribe((project) => {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const payload = JSON.stringify(project);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('editor:apply-from-main', payload);
      }
    }, 30);
  });
}
