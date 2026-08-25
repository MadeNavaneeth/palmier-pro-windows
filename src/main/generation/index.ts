/**
 * Generation IPC shell — safeStorage key persistence and event forwarding.
 *
 * Registry/lifecycle live in ./manager (headless, unit-testable, and shared
 * with the Agent/MCP executor); this module only bridges them to the
 * renderer over IPC and owns the encrypted key store.
 */

import { ipcMain, BrowserWindow, safeStorage } from 'electron';
import Store from 'electron-store';
import type {
  GenerationRequest,
  GenerationType,
} from './types';
import { pruneGenerationCache } from './util';
import { FalProvider } from './provider-fal';
import { ReplicateProvider } from './provider-replicate';
import { HiggsFieldProvider } from './provider-higgsfield';
import {
  cancelGeneration,
  configureGenerationProvider,
  configuredProvidersFor,
  listGenerationProviders,
  registerGenerationProvider,
  runGeneration,
} from './manager';

// Builtin providers are registered here rather than in the manager so the
// executor-facing module stays import-clean of Electron transitives.
registerGenerationProvider(new FalProvider());
registerGenerationProvider(new ReplicateProvider());
registerGenerationProvider(new HiggsFieldProvider());

// ─── Key storage ─────────────────────────────────────────────────────────────

const store = new Store({ name: 'palmier-generation-keys' });

function loadPersistedKeys(): void {
  const raw = store.store as Record<string, Record<string, string>>;
  const keys = raw.keys ?? {};
  for (const [providerId, encrypted] of Object.entries(keys)) {
    try {
      const key = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
        : encrypted;
      configureGenerationProvider(providerId, key);
    } catch { /* ignore corrupt keys */ }
  }
}

function persistKey(providerId: string, key: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(key);
    store.set(`keys.${providerId}`, encrypted.toString('base64'));
  } else {
    store.set(`keys.${providerId}`, key);
  }
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

export function registerGenerationHandlers(): void {
  loadPersistedKeys();

  // List providers + their status
  ipcMain.handle('generation:providers', () => {
    return { success: true, providers: listGenerationProviders() };
  });

  // Set API key for a provider
  ipcMain.handle('generation:set-key', async (_event, providerId: string, key: string) => {
    const result = configureGenerationProvider(providerId, key);
    if (!result.success) return result;
    persistKey(providerId, key);
    return { success: true };
  });

  // Get available models for a type + provider
  ipcMain.handle('generation:models', (_event, providerId: string, type: GenerationType) => {
    const summary = listGenerationProviders().find((p) => p.id === providerId);
    return summary ? summary.models[type] : [];
  });

  // Start generation — the renderer tracks progress/complete events itself.
  // Start generation — returns the request id immediately so the caller can
  // cancel; progress streams on generation:progress and the settled result
  // lands on generation:complete.
  ipcMain.handle('generation:start', async (event, requestData: Omit<GenerationRequest, 'id'>) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    let startedId = '';

    // Pre-validate synchronously so a missing key or unknown provider fails
    // the invoke instead of only surfacing through the complete event.
    const providerId = requestData.provider;
    if (providerId) {
      const summary = listGenerationProviders().find((p) => p.id === providerId);
      if (!summary) return { success: false, error: `Unknown provider: ${providerId}` };
      if (!summary.configured) {
        return { success: false, error: `${summary.name} has no API key set.` };
      }
    } else if (configuredProvidersFor(requestData.type).length === 0) {
      return {
        success: false,
        error: `No configured generation provider supports ${requestData.type}.`,
      };
    }

    void runGeneration(requestData, {
      onProgress: (progress) => win?.webContents.send('generation:progress', progress),
      onStart: (id) => { startedId = id; },
    }).then((result) => {
      win?.webContents.send('generation:complete', result);
    });

    return startedId
      ? { success: true, id: startedId }
      : { success: false, error: 'Generation failed to start.' };
  });

  // Cancel generation
  ipcMain.handle('generation:cancel', async (_event, requestId: string) => {
    return cancelGeneration(requestId);
  });

  // Prune old generated files
  ipcMain.handle('generation:prune-cache', async () => {
    await pruneGenerationCache(50);
    return { success: true };
  });
}
