/**
 * Detached panel windows (upstream #286).
 *
 * One window per panel, created on demand and destroyed on attach or on window
 * close, with the detached set broadcast to every window so the main workspace
 * can suppress a panel that now lives elsewhere (and show it again when the
 * window is closed from its own chrome).
 *
 * Electron-free on purpose: the window factory and the broadcaster are
 * injected, so the whole lifecycle is unit-testable in node and this module
 * never imports Electron. Project-state fan-out needs nothing new — the editor
 * sync layer already broadcasts to every window, and per-window streams target
 * the requesting web contents.
 */

import type { DetachablePanel } from '../../shared/ui/detached-panels';
import { DETACHED_WINDOW_CONFIG } from '../../shared/ui/detached-panels';

/** The small surface of BrowserWindow this manager needs. */
export interface DetachedWindowLike {
  focus(): void;
  destroy(): void;
  isDestroyed(): boolean;
  on(event: 'closed', listener: () => void): void;
}

export interface DetachedPanelsDeps {
  createWindow(panel: DetachablePanel, url: string): DetachedWindowLike;
  broadcast(panels: DetachablePanel[]): void;
}

/**
 * Render target for a detached window: the renderer index plus the panel
 * query the renderer's single-panel mode reads.
 */
export function detachedPanelUrl(panel: DetachablePanel): string {
  return `?panel=${panel}`;
}

export class DetachedPanelsManager {
  private readonly windows = new Map<DetachablePanel, DetachedWindowLike>();

  constructor(private readonly deps: DetachedPanelsDeps) {}

  /** Panels currently living in their own window. */
  listDetached(): DetachablePanel[] {
    return [...this.windows.keys()];
  }

  /**
   * Open a panel in its own window. Idempotent: detaching twice focuses the
   * existing window instead of opening a second one.
   */
  detach(panel: DetachablePanel): void {
    const existing = this.windows.get(panel);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }
    const win = this.deps.createWindow(panel, detachedPanelUrl(panel));
    this.windows.set(panel, win);
    win.on('closed', () => {
      // attach() deletes first, so its broadcast is the only one; a user
      // closing the window from its own chrome takes this path instead.
      if (this.windows.delete(panel)) {
        this.deps.broadcast(this.listDetached());
      }
    });
    this.deps.broadcast(this.listDetached());
  }

  /** Close the panel's window, if it has one. */
  attach(panel: DetachablePanel): void {
    const win = this.windows.get(panel);
    if (!win) return;
    // Deleted first so the 'closed' handler above stays silent.
    this.windows.delete(panel);
    if (!win.isDestroyed()) win.destroy();
    this.deps.broadcast(this.listDetached());
  }
}

export { DETACHED_WINDOW_CONFIG };
export type { DetachablePanel };
