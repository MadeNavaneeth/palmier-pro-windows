/**
 * AI IPC handlers — wires the PalmierAgent to the renderer via IPC.
 * Streams tokens, tool calls, and results back as events.
 * Manages API key storage via Electron safeStorage.
 */

import { ipcMain, BrowserWindow, safeStorage } from 'electron';
import Store from 'electron-store';
import { PalmierAgent, type StreamCallbacks } from './agent';
import { EditorController } from '../../shared/editor/controller';

// Persistent store for encrypted keys and preferences
const store = new Store({
  name: 'palmier-ai-config',
  encryptionKey: 'palmier-pro-windows-v1', // obfuscation layer on top of DPAPI
});

let agent: PalmierAgent | null = null;

export function registerAiHandlers(getEditor: () => EditorController): void {
  // ─── Chat ──────────────────────────────────────────────────────────────────
  ipcMain.handle('ai:chat', async (event, messages: any[], provider: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    // Ensure agent is configured
    if (!agent) {
      agent = new PalmierAgent(getEditor());
    }

    // Load key
    const encryptedKey = store.get(`keys.${provider}`) as string | undefined;
    if (!encryptedKey) {
      throw new Error(`No API key configured for ${provider}`);
    }

    const apiKey = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'))
      : encryptedKey; // fallback if DPAPI unavailable

    agent.configure({
      provider: provider as 'anthropic' | 'openai',
      apiKey,
      model: (store.get(`models.${provider}`) as string) || undefined,
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
      onError: (error: string) => {
        win.webContents.send('ai:stream-end');
        throw new Error(error);
      },
    };

    await agent.chat(lastUserMsg.content, callbacks);
  });

  // ─── Key Management ────────────────────────────────────────────────────────
  ipcMain.handle('ai:set-key', async (_event, provider: string, key: string) => {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(key);
      store.set(`keys.${provider}`, encrypted.toString('base64'));
    } else {
      // Fallback: store in plaintext (less secure, warn user)
      store.set(`keys.${provider}`, key);
    }
    return { success: true };
  });

  ipcMain.handle('ai:get-providers', () => {
    const providers = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        hasKey: !!store.get('keys.anthropic'),
        lastFour: getLastFour('anthropic'),
      },
      {
        id: 'openai',
        name: 'OpenAI',
        hasKey: !!store.get('keys.openai'),
        lastFour: getLastFour('openai'),
      },
    ];
    return providers;
  });
}

function getLastFour(provider: string): string {
  const encryptedKey = store.get(`keys.${provider}`) as string | undefined;
  if (!encryptedKey) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const key = safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'));
      return key.slice(-4);
    }
    return encryptedKey.slice(-4);
  } catch {
    return '';
  }
}
