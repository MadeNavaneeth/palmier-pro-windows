/**
 * Preload script — the narrow, context-isolated bridge between
 * the sandboxed renderer and the main process.
 *
 * Only explicitly listed IPC channels are exposed. The renderer
 * never gets access to Node, Electron internals, or the filesystem.
 */

import { contextBridge, ipcRenderer } from 'electron';

// ─── Type-safe API exposed to the renderer as `window.palmier` ───────────────

const api = {
  // ── Project ──────────────────────────────────────────────────────────────────
  project: {
    save: (projectJson: string, filePath?: string) =>
      ipcRenderer.invoke('project:save', projectJson, filePath),
    open: () => ipcRenderer.invoke('project:open'),
    getRecent: () => ipcRenderer.invoke('project:get-recent'),
    autosave: (name: string, filePath: string | null, data: string) =>
      ipcRenderer.invoke('project:autosave', name, filePath, data),
    recoveryCheck: () => ipcRenderer.invoke('project:recovery-check'),
    recoveryClear: () => ipcRenderer.invoke('project:recovery-clear'),
  },

  // ── Media ────────────────────────────────────────────────────────────────────
  media: {
    import: () => ipcRenderer.invoke('media:import'),
    probe: (filePath: string) => ipcRenderer.invoke('media:probe', filePath),
    thumbnail: (filePath: string, outputDir: string, timestamp?: number) =>
      ipcRenderer.invoke('media:thumbnail', filePath, outputDir, timestamp),
    detectSilence: (filePath: string, config?: Record<string, number>) =>
      ipcRenderer.invoke('audio:detect-silence', filePath, config),
  },

  // ── System ───────────────────────────────────────────────────────────────────
  system: {
    getAppInfo: () => ipcRenderer.invoke('system:app-info'),
    gpuInit: () => ipcRenderer.invoke('system:gpu-init'),
    checkFfmpeg: () => ipcRenderer.invoke('system:check-ffmpeg'),
    encrypt: (plaintext: string) => ipcRenderer.invoke('system:encrypt', plaintext),
    decrypt: (encrypted: string) => ipcRenderer.invoke('system:decrypt', encrypted),
  },

  // ── Editor Commands (Phase 2+) ──────────────────────────────────────────────
  editor: {
    execute: (commandName: string, args: Record<string, unknown>) =>
      ipcRenderer.invoke('editor:execute', commandName, args),
    undo: () => ipcRenderer.invoke('editor:undo'),
    redo: () => ipcRenderer.invoke('editor:redo'),
    getState: () => ipcRenderer.invoke('editor:get-state'),
    syncState: (projectJson: string) => ipcRenderer.invoke('editor:sync-from-renderer', projectJson),
  },

  // ── AI / MCP (Phase 5+) ─────────────────────────────────────────────────────
  ai: {
    chat: (messages: unknown[], provider: string) =>
      ipcRenderer.invoke('ai:chat', messages, provider),
    setApiKey: (provider: string, key: string) =>
      ipcRenderer.invoke('ai:set-key', provider, key),
    getProviders: () => ipcRenderer.invoke('ai:get-providers'),
  },

  // ── Preview (Phase 3+) ──────────────────────────────────────────────────────
  preview: {
    compositeFrame: (frameIndex: number) =>
      ipcRenderer.invoke('preview:composite-frame', frameIndex),
    prefetch: (frames: number[]) =>
      ipcRenderer.invoke('preview:prefetch', frames),
  },

  // ── Export (Phase 4+) ───────────────────────────────────────────────────────
  export: {
    start: (options: Record<string, unknown>) =>
      ipcRenderer.invoke('export:start', options),
    cancel: () => ipcRenderer.invoke('export:cancel'),
  },

  // ── Event subscriptions (main → renderer) ───────────────────────────────────
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const allowed = [
      'project:changed',
      'media:import-progress',
      'editor:state-changed',
      'editor:apply-from-main',
      'preview:frame',
      'export:progress',
      'export:complete',
      'export:error',
      'ai:stream-token',
      'ai:stream-end',
      'ai:tool-call',
      'ai:tool-result',
    ];
    if (!allowed.includes(channel)) {
      console.warn(`[preload] Blocked subscription to unknown channel: ${channel}`);
      return () => {};
    }
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, handler);
    // Return unsubscribe function
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

// Expose as window.palmier
contextBridge.exposeInMainWorld('palmier', api);

// ─── Type declaration for the renderer ───────────────────────────────────────
export type PalmierAPI = typeof api;
