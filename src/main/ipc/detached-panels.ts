/**
 * IPC for detached panel windows (upstream #286).
 *
 * Thin glue over DetachedPanelsManager: the manager owns the lifecycle, this
 * module owns the channel names and narrows the one untrusted input — the
 * panel key from the renderer — to the detachable set before it can reach any
 * window creation.
 */

import { ipcMain } from 'electron';
import { isDetachablePanel } from '../../shared/ui/detached-panels';
import type { DetachedPanelsManager } from '../windows/detached-panels';

export function registerDetachedPanelsHandlers(manager: DetachedPanelsManager): void {
  ipcMain.handle('panels:detach', (_event, panel: unknown) => {
    if (!isDetachablePanel(panel)) {
      return { ok: false as const, error: `Unknown panel: ${String(panel)}` };
    }
    manager.detach(panel);
    return { ok: true as const };
  });

  ipcMain.handle('panels:attach', (_event, panel: unknown) => {
    if (!isDetachablePanel(panel)) {
      return { ok: false as const, error: `Unknown panel: ${String(panel)}` };
    }
    manager.attach(panel);
    return { ok: true as const };
  });

  ipcMain.handle('panels:list-detached', () => manager.listDetached());
}
