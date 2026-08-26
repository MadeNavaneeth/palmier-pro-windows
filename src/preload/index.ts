/**
 * Preload script â€” the narrow, context-isolated bridge between
 * the sandboxed renderer and the main process.
 *
 * Only explicitly listed IPC channels are exposed. The renderer
 * never gets access to Node, Electron internals, or the filesystem.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { SilenceConfig } from '../shared/audio/silence-detector';

// â”€â”€â”€ Type-safe API exposed to the renderer as `window.palmier` â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const api = {
  // â”€â”€ Project â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Media â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  media: {
    import: () => ipcRenderer.invoke('media:import'),
    importPaths: (filePaths: string[]) => ipcRenderer.invoke('media:import-paths', filePaths),
    getPathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
    probe: (filePath: string) => ipcRenderer.invoke('media:probe', filePath),
    /** Which of these paths no longer exist on disk (offline media, R1). */
    checkOffline: (paths: string[]) => ipcRenderer.invoke('media:check-offline', paths),
    filmstrip: (filePath: string, count: number) =>
      ipcRenderer.invoke('media:filmstrip', filePath, count),
    /** Proxy generation (R2): background transcode + attach/detach. */
    generateProxy: (assetId: string) => ipcRenderer.invoke('media:generate-proxy', assetId),
    proxyStatus: () => ipcRenderer.invoke('media:proxy-status'),
    removeProxy: (assetId: string) => ipcRenderer.invoke('media:remove-proxy', assetId),
    getProxyMode: () => ipcRenderer.invoke('media:get-proxy-mode'),
    setProxyMode: (mode: 'auto' | 'off') => ipcRenderer.invoke('media:set-proxy-mode', mode),
    /** Hardware H.264 encoders this FFmpeg build exposes (R2). */
    hwEncoders: () => ipcRenderer.invoke('media:hw-encoders'),
    getPresets: () => ipcRenderer.invoke('export:get-presets'),
    setPresets: (presets: unknown[]) => ipcRenderer.invoke('export:set-presets', presets),
    chooseFolder: () => ipcRenderer.invoke('media:choose-folder'),
    /**
     * Offline-relink scan: match the given filenames (case-insensitive,
     * recursive) under folder; returns filename -> found path.
     */
    scanRelink: (filenames: string[], folder: string) =>
      ipcRenderer.invoke('media:scan-relink', filenames, folder),
    /** FCPXML UI bridges (#154): open+parse+probe / save-dialog+write. */
    openFcpxml: () => ipcRenderer.invoke('media:fcpxml-open'),
    writeFcpxml: (xml: string) => ipcRenderer.invoke('media:fcpxml-write', { xml }),
    /**
     * Transcribe an audio/video file over the BYOK whisper-compatible
     * runtime and return caption cues (#39/#91); renderer materializes them.
     */
    transcribe: (payload: { path: string; language?: string; model?: string }) =>
      ipcRenderer.invoke('media:transcribe', payload),
    /** Custom STT server preference (#287): read + persist. */
    getTranscribeConfig: () => ipcRenderer.invoke('media:get-transcribe-config'),
    setTranscribeConfig: (patch: { baseUrl?: string; apiKey?: string; model?: string }) =>
      ipcRenderer.invoke('media:set-transcribe-config', patch),
    /**
     * Extract a video's audio into a standalone library asset (upstream PR
     * #562). The optional window bakes a source range in (timeline clip entry).
     */
    extractAudio: (
      sourcePath: string,
      window?: { startSec: number; endSec: number },
    ) => ipcRenderer.invoke('media:extract-audio', sourcePath, window),
    thumbnail: (filePath: string, outputDir: string, timestamp?: number) =>
      ipcRenderer.invoke('media:thumbnail', filePath, outputDir, timestamp),
    // `config` overrides the saved silence controls for this call only; omit it
    // to use them as-is (upstream PR #426).
    detectSilence: (filePath: string, config?: Partial<SilenceConfig>) =>
      ipcRenderer.invoke('audio:detect-silence', filePath, config),
    getSilenceSettings: () => ipcRenderer.invoke('audio:get-silence-settings'),
    setSilenceSettings: (update: Partial<SilenceConfig>) =>
      ipcRenderer.invoke('audio:set-silence-settings', update),
    waveform: (filePath: string, buckets: number) =>
      ipcRenderer.invoke('audio:waveform', filePath, buckets),
    /** Peak/mean volume analysis for normalization (R5). */
    volumeAnalysis: (filePath: string) =>
      ipcRenderer.invoke('audio:volume-analysis', filePath),
  },

  // â”€â”€ System â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  system: {
    getAppInfo: () => ipcRenderer.invoke('system:app-info'),
    gpuInit: () => ipcRenderer.invoke('system:gpu-init'),
    checkFfmpeg: () => ipcRenderer.invoke('system:check-ffmpeg'),
    encrypt: (plaintext: string) => ipcRenderer.invoke('system:encrypt', plaintext),
    decrypt: (encrypted: string) => ipcRenderer.invoke('system:decrypt', encrypted),
  },

  // â”€â”€ Editor Commands (Phase 2+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  editor: {
    execute: (commandName: string, args: Record<string, unknown>) =>
      ipcRenderer.invoke('editor:execute', commandName, args),
    undo: () => ipcRenderer.invoke('editor:undo'),
    redo: () => ipcRenderer.invoke('editor:redo'),
    getState: () => ipcRenderer.invoke('editor:get-state'),
    syncState: (projectJson: string) => ipcRenderer.invoke('editor:sync-from-renderer', projectJson),
  },

  // â”€â”€ AI / MCP (Phase 5+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ai: {
    chat: (messages: unknown[], provider: string) =>
      ipcRenderer.invoke('ai:chat', messages, provider),
    /** Stop the turn in progress (#58). Resolves whether there was one. */
    cancel: (): Promise<{ cancelled: boolean }> => ipcRenderer.invoke('ai:cancel'),
    setApiKey: (provider: string, key: string) =>
      ipcRenderer.invoke('ai:set-key', provider, key),
    /** Persist a provider's base URL and model (#17, #140). Validated in main. */
    setProviderConfig: (
      provider: string,
      config: { kind: string; baseUrl?: string; model: string },
    ) => ipcRenderer.invoke('ai:set-provider-config', provider, config),
    getProviders: () => ipcRenderer.invoke('ai:get-providers'),
  },

  // â”€â”€ Preview (Phase 3+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  preview: {
    compositeFrame: (frameIndex: number) =>
      ipcRenderer.invoke('preview:composite-frame', frameIndex),
    prefetch: (frames: number[]) =>
      ipcRenderer.invoke('preview:prefetch', frames),
  },

  // â”€â”€ Export (Phase 4+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  export: {
    start: (options: Record<string, unknown>) =>
      ipcRenderer.invoke('export:start', options),
    cancel: () => ipcRenderer.invoke('export:cancel'),
    /** Show a finished export in Explorer (R2 delivery polish). */
    reveal: (outputPath: string) => ipcRenderer.invoke('export:reveal', outputPath),
    /** Recent export history for the delivery panel (R2). */
    getHistory: () => ipcRenderer.invoke('export:history'),
    /**
     * Persist renderer-baked advanced title layers (#525/#529) to a per-export
     * temp directory; returns { dir, paths } for export.start + cleanup.
     */
    bakeTitles: (files: Array<{ clipId: string; bytes: ArrayBuffer }>) =>
      ipcRenderer.invoke('export:bake-titles', { files }),
  },

  // â”€â”€ Generation (BYOK media providers, upstream PR #406 family) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  generation: {
    /** Providers with configured state and per-type model catalogs. */
    providers: () => ipcRenderer.invoke('generation:providers'),
    setKey: (providerId: string, key: string) =>
      ipcRenderer.invoke('generation:set-key', providerId, key),
    models: (providerId: string, type: 'image' | 'video' | 'audio') =>
      ipcRenderer.invoke('generation:models', providerId, type),
    /** Fire-and-forget: resolves with the request id; result lands on generation:complete. */
    start: (request: Record<string, unknown>) =>
      ipcRenderer.invoke('generation:start', request),
    cancel: (requestId: string) => ipcRenderer.invoke('generation:cancel', requestId),
  },

  // â”€â”€ Event subscriptions (main â†’ renderer) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      'generation:progress',
      'generation:complete',
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

// â”€â”€â”€ Type declaration for the renderer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export type PalmierAPI = typeof api;

