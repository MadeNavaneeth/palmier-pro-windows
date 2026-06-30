/**
 * Generation Manager — provider-agnostic orchestration layer.
 *
 * Manages multiple providers, routes requests, handles key storage,
 * and integrates generated assets back into the project's media bin.
 */

import { ipcMain, BrowserWindow, safeStorage } from 'electron';
import Store from 'electron-store';
import { nanoid } from 'nanoid';
import type {
  GenerationProvider,
  GenerationRequest,
  GenerationResult,
  GenerationProgress,
  GenerationType,
} from './types';
import { FalProvider } from './provider-fal';
import { ReplicateProvider } from './provider-replicate';
import { pruneGenerationCache } from './util';

// ─── Provider Registry ───────────────────────────────────────────────────────

const providers = new Map<string, GenerationProvider>();

function registerBuiltinProviders(): void {
  const fal = new FalProvider();
  const replicate = new ReplicateProvider();
  providers.set(fal.id, fal);
  providers.set(replicate.id, replicate);
}

registerBuiltinProviders();

// ─── Key storage ─────────────────────────────────────────────────────────────

const store = new Store({ name: 'palmier-generation-keys' });

function loadProviderKeys(): void {
  for (const [id, provider] of providers) {
    const encrypted = store.get(`keys.${id}`) as string | undefined;
    if (encrypted) {
      try {
        const key = safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
          : encrypted;
        provider.configure(key);
      } catch { /* ignore corrupt keys */ }
    }
  }
}

// ─── Active generations tracking ─────────────────────────────────────────────

const activeGenerations = new Map<string, { provider: string; abortController?: AbortController }>();

// ─── IPC Handlers ────────────────────────────────────────────────────────────

export function registerGenerationHandlers(): void {
  loadProviderKeys();

  // List providers + their status
  ipcMain.handle('generation:providers', () => {
    return Array.from(providers.values()).map((p) => ({
      id: p.id,
      name: p.name,
      supportedTypes: p.supportedTypes,
      configured: p.isConfigured(),
    }));
  });

  // Set API key for a provider
  ipcMain.handle('generation:set-key', async (_event, providerId: string, key: string) => {
    const provider = providers.get(providerId);
    if (!provider) return { success: false, error: `Unknown provider: ${providerId}` };

    provider.configure(key);

    // Persist encrypted
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(key);
      store.set(`keys.${providerId}`, encrypted.toString('base64'));
    } else {
      store.set(`keys.${providerId}`, key);
    }

    return { success: true };
  });

  // Get available models for a type + provider
  ipcMain.handle('generation:models', (_event, providerId: string, type: GenerationType) => {
    const provider = providers.get(providerId);
    if (!provider) return [];
    return provider.getModels(type);
  });

  // Start generation
  ipcMain.handle('generation:start', async (event, requestData: Omit<GenerationRequest, 'id'>) => {
    const providerId = requestData.provider;
    const provider = providers.get(providerId);
    if (!provider) return { success: false, error: `Unknown provider: ${providerId}` };
    if (!provider.isConfigured()) return { success: false, error: `${provider.name} not configured (missing API key)` };

    const win = BrowserWindow.fromWebContents(event.sender);
    const id = nanoid();
    const request: GenerationRequest = { ...requestData, id };

    activeGenerations.set(id, { provider: providerId });

    // Run generation in background
    const onProgress = (progress: GenerationProgress) => {
      win?.webContents.send('generation:progress', progress);
    };

    provider.generate(request, onProgress).then((result) => {
      activeGenerations.delete(id);
      win?.webContents.send('generation:complete', result);
    }).catch((err) => {
      activeGenerations.delete(id);
      const failResult: GenerationResult = {
        id,
        status: 'failed',
        error: err.message,
      };
      win?.webContents.send('generation:complete', failResult);
    });

    return { success: true, id };
  });

  // Cancel generation
  ipcMain.handle('generation:cancel', async (_event, requestId: string) => {
    const gen = activeGenerations.get(requestId);
    if (!gen) return { success: false, error: 'Not found' };

    const provider = providers.get(gen.provider);
    if (provider) {
      await provider.cancel(requestId);
    }
    activeGenerations.delete(requestId);
    return { success: true };
  });

  // Prune old generated files
  ipcMain.handle('generation:prune-cache', async () => {
    await pruneGenerationCache(50);
    return { success: true };
  });
}
