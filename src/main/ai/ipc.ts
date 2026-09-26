/**
 * AI IPC handlers — wires the PalmierAgent to the renderer via IPC.
 * Streams tokens, tool calls, and results back as events.
 * Manages API key storage via Electron safeStorage.
 *
 * Multi-window sessions (upstream #137, Slice 2): every handler resolves the
 * requesting window's session first, and the session owns its PalmierAgent —
 * two windows chat concurrently with separate history, busy state, and cancel.
 */

import { ipcMain, BrowserWindow, app, safeStorage } from 'electron';
import Store from 'electron-store';
import { dirname, isAbsolute } from 'path';
import type { StreamCallbacks } from './agent';
import { agentTranscriptPath } from './transcript-path';
import { applyMcpHttpSettings } from './mcp-http-settings';
import { agentForSession, cancelSessionAgent } from './session-agent';
import { resolveMcpController } from './mcp-session';
import { defaultSkillsDir, discoverSkills, loadDisabledSkills, setSkillEnabled } from './skills';
import { checkCodexAvailability, resolveCodexWorkingDir } from './codex-cli';
import {
  PROVIDER_PRESETS,
  presetById,
  validateProviderConfig,
  type ProviderConfig,
} from '../../shared/ai/provider-config';
import type { EditorController } from '../../shared/editor/controller';
import { NO_SESSION_ERROR, type Session, type SessionSender } from '../sessions';

// Persistent store for encrypted keys and preferences
const store = new Store({
  name: 'palmier-ai-config',
  encryptionKey: 'palmier-pro-windows-v1', // obfuscation layer on top of DPAPI
});

// Nothing on the chat path is process-wide anymore (#137 Slice 2): the agent
// lives on its Session (agentForSession builds it lazily per session), so
// busy, cancel, and history all scope to the requesting window's session.
// Only the provider-key store above is shared — it is user configuration.

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
    | { kind?: unknown; baseUrl?: unknown; model?: unknown; binaryPath?: unknown }
    | undefined;

  const candidate = {
    kind: stored?.kind ?? preset?.kind,
    baseUrl: stored?.baseUrl ?? preset?.baseUrl,
    model: stored?.model ?? preset?.defaultModel,
    binaryPath: stored?.binaryPath,
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
 * Sandboxed working root for the Codex CLI (upstream #142): the media
 * folders first, the app data dir as fallback. The resolver refuses anything
 * outside that scope rather than running the agent somewhere unintended.
 */
function codexWorkingDir(controller: EditorController): string {
  const mediaDirs: string[] = [];
  try {
    const media = controller.getProject().media ?? [];
    for (const asset of media) {
      const assetPath = (asset as { path?: unknown }).path;
      if (typeof assetPath === 'string' && isAbsolute(assetPath)) {
        const dir = dirname(assetPath);
        if (!mediaDirs.includes(dir)) mediaDirs.push(dir);
      }
    }
  } catch {
    // An unreadable project still gets a scoped directory below.
  }
  const resolved = resolveCodexWorkingDir(undefined, [...mediaDirs, app.getPath('userData')]);
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.dir;
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

/**
 * Wire the PalmierAgent to the renderer via IPC.
 *
 * `getSession` resolves the requesting window's session (#137), so chat,
 * cancel, session snapshots, and MCP config all act on that window's
 * workspace: each session's agent binds to that session's controller, and
 * two main windows run independent turns concurrently.
 */
export function registerAiHandlers(getSession: (sender: SessionSender) => Session | null): void {
  // A clear is a per-session transaction: it cancels the current chat, waits
  // for that chat's promise to finish its cancellation path, then performs the
  // final history wipe. The barrier also keeps a new chat or a detached boot
  // from reading the half-cleared state in the meantime.
  const activeChats = new Map<string, Promise<void>>();
  const clearBarriers = new Map<string, Promise<void>>();

  // Loopback HTTP MCP endpoint (#302/#532): external clients connect to the
  // running editor over 127.0.0.1 with a bearer token. Reading the config
  // reconciles the listener with the saved preference, so a saved "enabled"
  // state starts the socket on first use after launch. One listener per
  // process (token + port shared); `resolveMcpController` binds each request
  // to a session's editor (#137 Slice 2).
  const mcpDeps = {
    getTranscriptionRuntime: async () => getOpenAiCompatibleRuntime(),
    getVisionRuntime: async () => {
      const { getVisionRuntime } = await import('./ipc-vision');
      return getVisionRuntime();
    },
  };
  ipcMain.handle('mcp:get-config', async (event) => {
    const session = getSession(event.sender);
    if (!session) throw new Error(NO_SESSION_ERROR);
    const status = await applyMcpHttpSettings(
      session.controller,
      undefined,
      mcpDeps,
      resolveMcpController,
    );
    return { success: true, status, config: status.config };
  });
  ipcMain.handle('mcp:set-enabled', async (event, enabled: unknown, port?: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'enabled must be a boolean.' };
    }
    const session = getSession(event.sender);
    if (!session) throw new Error(NO_SESSION_ERROR);
    const status = await applyMcpHttpSettings(
      session.controller,
      { enabled, ...(typeof port === 'number' ? { port } : {}) },
      mcpDeps,
      resolveMcpController,
    );
    return { success: true, status, config: status.config };
  });

  // ─── Chat ──────────────────────────────────────────────────────────────────
  ipcMain.handle('ai:chat', async (event, messages: any[], provider: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    // This window's session and, lazily, its own agent (#137 Slice 2): the
    // agent binds to this session's controller for its whole life, so two
    // windows chat concurrently without sharing history or busy state.
    const session = getSession(event.sender);
    if (!session) throw new Error(NO_SESSION_ERROR);
    const clearBarrier = clearBarriers.get(session.id);
    if (clearBarrier) await clearBarrier;
    const controller = session.controller;
    const agent = agentForSession(session);

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
      ...(config.kind === 'codex-cli'
        ? { binaryPath: config.binaryPath, workingDir: codexWorkingDir(controller) }
        : {}),
      transcriptPath: agentTranscriptPath(app.getPath('userData')),
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
      onPlan: (plan) => {
        // Session UI state (L3): the panel renders it, nothing depends on it.
        win.webContents.send('ai:plan', plan);
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

    const turn = agent.chat(lastUserMsg.content, callbacks);
    if (!activeChats.has(session.id)) activeChats.set(session.id, turn);
    try {
      await turn;
    } finally {
      if (activeChats.get(session.id) === turn) activeChats.delete(session.id);
    }
  });

  // ─── Cancellation (upstream #58) ───────────────────────────────────────────
  // Its own channel rather than a flag on `ai:chat`, because the point is to be
  // answerable while that handler's promise is still pending. Scoped to the
  // requesting window's session (#137 Slice 2): stopping one workspace's turn
  // never touches another window's in-flight chat.
  ipcMain.handle('ai:cancel', (event) => ({
    cancelled: cancelSessionAgent(getSession(event.sender)),
  }));

  // Clear the requesting session's authoritative conversation. The cancel is
  // deliberately performed before clearHistory: a busy turn must finish its
  // cancellation path before the final history wipe, and the agent's clear
  // operation repeats that same guard for callers that use it directly.
  ipcMain.handle('ai:clear-history', async (event) => {
    const session = getSession(event.sender);
    if (!session) throw new Error(NO_SESSION_ERROR);

    const previousBarrier = clearBarriers.get(session.id);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    clearBarriers.set(session.id, barrier);
    if (previousBarrier) await previousBarrier;

    try {
      const cancelled = cancelSessionAgent(session);
      const activeTurn = activeChats.get(session.id);
      if (activeTurn) {
        try {
          await activeTurn;
        } catch {
          // The chat IPC owns turn errors. A failed/cancelled turn still has
          // to reach its final cleanup before the history is wiped.
        }
      }
      session.agent?.clearHistory();
      return { success: true, cancelled };
    } finally {
      release();
      if (clearBarriers.get(session.id) === barrier) clearBarriers.delete(session.id);
    }
  });

  // Session hand-off (upstream #286): a detached chat adopts the visible
  // session on boot — the structured history plus the current plan checklist,
  // deep-copied so the renderer never holds a live handle into the object the
  // next tool round appends to. The requesting window's own session snapshot
  // (#137 Slice 2); a window whose session never chatted starts empty. Wait
  // for a clear in progress so a boot cannot observe the pre-clear snapshot.
  ipcMain.handle('ai:get-session', async (event) => {
    const session = getSession(event.sender);
    if (!session) return { history: [], plan: null };
    const clearBarrier = clearBarriers.get(session.id);
    if (clearBarrier) await clearBarrier;
    return session.agent?.getSessionSnapshot() ?? { history: [], plan: null };
  });

  // ─── Key Management ────────────────────────────────────────────────────────
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

  // ─── Provider configuration (#17, #140) ────────────────────────────────────
  ipcMain.handle(
    'ai:set-provider-config',
    (_event, provider: string, config: { kind?: unknown; baseUrl?: unknown; model?: unknown; binaryPath?: unknown }) => {
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
        binaryPath: config?.binaryPath ?? '',
      };
    }),
  );

  // ─── Codex CLI availability (upstream #142) ───
  // Read-only probe for the settings UI: resolves the saved binary override
  // (or PATH) and runs `codex --version`. Never touches credentials.
  ipcMain.handle('ai:codex-status', async () => {
    const config = loadProviderConfig('codex-cli');
    const status = await checkCodexAvailability(config?.binaryPath);
    return { success: true, status };
  });

  // ─── Agent skills (Track 2, L7) ───
  // Read-only listing for the settings UI: discovered skills with their
  // enablement, plus malformed skills refused with reasons. Skill bodies are
  // untrusted text and never leave the main process except through the
  // explicit `load_skill` tool call.
  ipcMain.handle('skills:get-state', () => {
    const { skills, refused } = discoverSkills(defaultSkillsDir());
    const disabled = loadDisabledSkills();
    return {
      success: true,
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        enabled: !disabled.has(skill.name),
      })),
      refused: refused.map((entry) => ({ name: entry.name, reason: entry.reason })),
    };
  });
  ipcMain.handle('skills:set-enabled', (_event, name: unknown, enabled: unknown) => {
    // Narrowed in the main process, not just the form: the renderer is not
    // the only thing that can reach this channel.
    if (!setSkillEnabled(name, enabled)) {
      return { success: false, error: 'Provide a valid skill name and a boolean enabled flag.' };
    }
    return { success: true };
  });
}

function getLastFour(provider: string): string {
  return decryptStoredKey(provider).slice(-4);
}




