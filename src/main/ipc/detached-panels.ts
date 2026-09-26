/**
 * IPC for detached panel windows (upstream #286, session-scoped in #137).
 *
 * Thin glue over DetachedPanelsManager: the manager owns the lifecycle, this
 * module owns the channel names and narrows the one untrusted input — the
 * panel key from the renderer — to the detachable set before it can reach any
 * window creation. Each session owns its own manager, resolved from the
 * sender, so two workspaces can detach the same panel independently and each
 * detached window mirrors only its parent session's project.
 */

import { ipcMain } from 'electron';
import { isDetachablePanel } from '../../shared/ui/detached-panels';
import type { DetachedPanelsManager } from '../windows/detached-panels';
import { NO_SESSION_ERROR, type SessionSender } from '../sessions';

export function registerDetachedPanelsHandlers(
  resolveManager: (sender: SessionSender) => DetachedPanelsManager | null,
): void {
  ipcMain.handle('panels:detach', (event, panel: unknown) => {
    if (!isDetachablePanel(panel)) {
      return { ok: false as const, error: `Unknown panel: ${String(panel)}` };
    }
    const manager = resolveManager(event.sender);
    if (!manager) return { ok: false as const, error: NO_SESSION_ERROR };
    return manager.detach(panel);
  });

  ipcMain.handle('panels:attach', (event, panel: unknown) => {
    if (!isDetachablePanel(panel)) {
      return { ok: false as const, error: `Unknown panel: ${String(panel)}` };
    }
    const manager = resolveManager(event.sender);
    if (!manager) return { ok: false as const, error: NO_SESSION_ERROR };
    manager.attach(panel);
    return { ok: true as const };
  });

  ipcMain.handle('panels:list-detached', (event) =>
    resolveManager(event.sender)?.listDetached() ?? [],
  );
}
