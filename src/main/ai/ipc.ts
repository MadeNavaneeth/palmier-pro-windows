/**
 * AI IPC handlers â€” wires the PalmierAgent to the renderer via IPC.
 * Streams tokens, tool calls, and results back as events.
 * Manages API key storage via Electron safeStorage.
 */

import { ipcMain, BrowserWindow, safeStorage } from 'electron';
import Store from 'electron-store';
import { PalmierAgent, type StreamCallbacks } from './agent';
import {
  PROVIDER_PRESETS,
  presetById,
  validateProviderConfig,
  type ProviderConfig,
} from '../../shared/ai/provider-config';
import type { EditorController } from '../../shared/editor/controller';

// Persistent store for encrypted keys and preferences
const store = new Store({
  name: 'palmier-ai-config',
  encryptionKey: 'palmier-pro-windows-v1', // obfuscation layer on top of DPAPI
});

let agent: PalmierAgent | null = null;

/** Provider ids are used as store keys, so they must not contain path separators. */
function isSafeProviderId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9-]{1,32}$/.test(id);
}

/**
 * Stored configuration for a provider, or the preset default.
 *
 * Re-validated on read: the config file is user-writable, and a base URL that
 * reaches the request layer unchecked is how project content ends up at an
 * unintended endpoint.
 */
function loadProviderConfig(providerId: string): ProviderConfig | null {
  const preset = presetById(providerId);
  const stored = store.get(`providers.${providerId}`) as
    | { kind?: unknown; baseUrl?: unknown; model?: unknown }
    | undefined;

  const candidate = {
    kind: stored?.kind ?? preset?.kind,
    baseUrl: stored?.baseUrl ?? preset?.baseUrl,
    model: stored?.model ?? preset?.defaultModel,
  };

  const result = validateProviderConfig(candidate);
  if (result.ok) return result.config;

  console.warn(`[ai] Ignoring invalid stored config for "${providerId}": ${result.reason}`);
  return null;
}

function decryptStoredKey(providerId: string): string {
  const encryptedKey = store.get(`keys.${providerId}`) as string | undefined;
  if (!encryptedKey) return '';
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'))
      : encryptedKey;
  } catch {
    // A key encrypted under a different Windows profile cannot be recovered;
    // treat it as absent rather than throwing on every chat.
    return '';
  }
}

/**
 * OpenAI-compatible runtime for audio transcription (#39 groundwork):
 * prefers an explicit provider id, otherwise the first openai-compatible
 * provider holding a decrypted key. Null when nothing usable is configured.
 */
export function getOpenAiCompatibleRuntime(preferredProviderId?: string): { baseUrl: string; apiKey: string } | null {
  const candidates = preferredProviderId
    ? [preferredProviderId, ...PROVIDER_PRESETS.filter((p) => p.id !== preferredProviderId && p.kind === 'openai-compatible').map((p) => p.id)]
    : PROVIDER_PRESETS.filter((p) => p.kind === 'openai-compatible').map((p) => p.id);
  for (const id of candidates) {
    if (!isSafeProviderId(id)) continue;
    const preset = presetById(id);
    if (!preset || preset.kind !== 'openai-compatible') continue;
    const config = loadProviderConfig(id);
    const apiKey = decryptStoredKey(id);
    if (apiKey.length > 0 && config) {
      const baseUrl = config.baseUrl ?? preset.baseUrl;
      if (!baseUrl) continue;
      return { baseUrl, apiKey };
    }
  }
  return null;
}

export function registerAiHandlers(getEditor: () => EditorController): void {
  // â”€â”€â”€ Chat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle('ai:chat', async (event, messages: any[], provider: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    // Ensure agent is configured
    if (!agent) {
      agent = new PalmierAgent(getEditor());
    }

    if (!isSafeProviderId(provider)) {
      throw new Error('Unknown AI provider.');
    }

    const config = loadProviderConfig(provider);
    if (!config) {
      throw new Error(`AI provider "${provider}" is not configured correctly. Check AI settings.`);
    }

    const apiKey = decryptStoredKey(provider);
    // Local runtimes accept unauthenticated requests, so a missing key is only
    // fatal for a provider that needs one.
    const requiresApiKey = presetById(provider)?.requiresApiKey ?? true;
    if (requiresApiKey && apiKey.length === 0) {
      throw new Error(`No API key configured for ${provider}`);
    }

    agent.configure({
      provider: config.kind,
      apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    });

    // Extract the last user message
    const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
    if (!lastUserMsg) return;

    const callbacks: StreamCallbacks = {
      onToken: (token: string) => {
        win.webContents.send('ai:stream-token', token);
      },
      onToolCall: (name: string, args: Record<string, unknown>) => {
        win.webContents.send('ai:tool-call', { name, args });
      },
      onToolResult: (name: string, result: unknown) => {
        win.webContents.send('ai:tool-result', { name, result });
      },
      onComplete: (_fullResponse: string) => {
        win.webContents.send('ai:stream-end');
      },
      onCancelled: (_partialResponse: string) => {
        // Same channel as a normal finish, with a reason. A separate channel
        // would race it: the renderer must learn why the stream ended before it
        // commits the partial answer to the transcript.
        win.webContents.send('ai:stream-end', 'cancelled');
      },
      onError: (error: string) => {
        win.webContents.send('ai:stream-end');
        throw new Error(error);
      },
    };

    await agent.chat(lastUserMsg.content, callbacks);
  });

  // â”€â”€â”€ Cancellation (upstream #58) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Its own channel rather than a flag on `ai:chat`, because the point is to be
  // answerable while that handler's promise is still pending.
  ipcMain.handle('ai:cancel', () => ({ cancelled: agent?.cancel() ?? false }));

  // â”€â”€â”€ Key Management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle('ai:set-key', async (_event, provider: string, key: string) => {
    if (!isSafeProviderId(provider)) {
      return { success: false, error: 'Unknown AI provider.' };
    }
    if (typeof key !== 'string') {
      return { success: false, error: 'Invalid API key.' };
    }

    // An empty key clears the stored credential, which is how a user detaches a
    // key without deleting the whole provider configuration.
    if (key.length === 0) {
      store.delete(`keys.${provider}` as never);
      return { success: true };
    }

    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(key);
      store.set(`keys.${provider}`, encrypted.toString('base64'));
    } else {
      // Fallback: store in plaintext (less secure, warn user)
      store.set(`keys.${provider}`, key);
    }
    return { success: true };
  });

  // â”€â”€â”€ Provider configuration (#17, #140) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle(
    'ai:set-provider-config',
    (_event, provider: string, config: { kind?: unknown; baseUrl?: unknown; model?: unknown }) => {
      if (!isSafeProviderId(provider)) {
        return { success: false, error: 'Unknown AI provider.' };
      }

      // Validated in the main process, not just the form: the renderer is not the
      // only thing that can reach this channel.
      const result = validateProviderConfig(config ?? {});
      if (!result.ok) return { success: false, error: result.reason };

      store.set(`providers.${provider}`, result.config);
      return { success: true, config: result.config };
    },
  );

  ipcMain.handle('ai:get-providers', () =>
    PROVIDER_PRESETS.map((preset) => {
      const config = loadProviderConfig(preset.id);
      return {
        id: preset.id,
        name: preset.label,
        kind: preset.kind,
        requiresApiKey: preset.requiresApiKey,
        hint: preset.hint,
        hasKey: decryptStoredKey(preset.id).length > 0,
        lastFour: getLastFour(preset.id),
        baseUrl: config?.baseUrl ?? preset.baseUrl ?? '',
        model: config?.model ?? preset.defaultModel,
      };
    }),
  );
}

function getLastFour(provider: string): string {
  return decryptStoredKey(provider).slice(-4);
}




