/**
 * Persistence and lifecycle for the loopback HTTP MCP endpoint.
 *
 * The endpoint is opt-in: nothing listens until the user enables external
 * clients in AI Settings. The token is generated once and stored encrypted
 * via Windows DPAPI when available (plaintext fallback, same rule the AI
 * provider keys use); the store is narrowed on read so a hand-edited value
 * cannot produce a non-numeric port or an empty token.
 */

import { app, safeStorage } from 'electron';
import Store from 'electron-store';
import crypto from 'crypto';
import { createMcpHttpServer, type McpHttpHandle } from './mcp-http';
import { mcpHttpConfig } from './mcp-server';
import type { ToolExecutorDeps } from './executor';
import type { EditorController } from '../../shared/editor/controller';

const DEFAULT_PORT = 8765;
const PORT_ATTEMPTS = 10;

interface StoredSettings {
  enabled: boolean;
  port: number;
  token: string;
}

export interface McpHttpStatus {
  enabled: boolean;
  running: boolean;
  port: number | null;
  url: string | null;
  config: string | null;
}

let store: Store | null = null;
let handle: McpHttpHandle | null = null;
let cached: { enabled: boolean; port: number; token: string } | null = null;

function getStore(): Store | null {
  if (!app) return null;
  store ??= new Store({ name: 'palmier-mcp' });
  return store;
}

function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function encryptToken(token: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `dpapi:${safeStorage.encryptString(token).toString('base64')}`;
    }
  } catch {
    // Fall through to plaintext; a locked keyring must not brick the toggle.
  }
  return `plain:${token}`;
}

function decryptToken(stored: unknown): string {
  if (typeof stored !== 'string' || stored.length === 0) return '';
  try {
    if (stored.startsWith('dpapi:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice('dpapi:'.length), 'base64'));
    }
    if (stored.startsWith('plain:')) return stored.slice('plain:'.length);
  } catch {
    return '';
  }
  return '';
}

function loadSettings(): { enabled: boolean; port: number; token: string } {
  if (cached) return cached;
  try {
    const stored = getStore()?.get('settings') as Partial<StoredSettings> | undefined;
    const port =
      typeof stored?.port === 'number' && Number.isInteger(stored.port)
      && stored.port >= 1024 && stored.port <= 65535
        ? stored.port
        : DEFAULT_PORT;
    const token = decryptToken(stored?.token);
    cached = {
      enabled: stored?.enabled === true,
      port,
      token: token.length > 0 ? token : newToken(),
    };
    // Persist a freshly generated token immediately so the shown config and
    // the next launch agree.
    if (token.length === 0) saveSettings(cached);
  } catch (err) {
    console.warn('[mcp] Could not read settings, using defaults:', err);
    cached = { enabled: false, port: DEFAULT_PORT, token: newToken() };
  }
  return cached;
}

function saveSettings(settings: { enabled: boolean; port: number; token: string }): void {
  cached = settings;
  try {
    getStore()?.set('settings', {
      enabled: settings.enabled,
      port: settings.port,
      token: encryptToken(settings.token),
    } satisfies Partial<StoredSettings>);
  } catch (err) {
    console.warn('[mcp] Could not persist settings:', err);
  }
}

function status(): McpHttpStatus {
  const settings = loadSettings();
  if (!handle) {
    return { enabled: settings.enabled, running: false, port: null, url: null, config: null };
  }
  const url = `http://127.0.0.1:${handle.port}/mcp`;
  return {
    enabled: settings.enabled,
    running: true,
    port: handle.port,
    url,
    config: mcpHttpConfig(url, settings.token),
  };
}

async function start(controller: EditorController, deps?: ToolExecutorDeps): Promise<void> {
  if (handle) return;
  const settings = loadSettings();
  // A port that is taken must not disable the feature; walk a small range
  // and remember where the listener actually landed.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    try {
      const created = await createMcpHttpServer({
        controller,
        token: settings.token,
        port: settings.port + attempt,
        deps,
      });
      handle = created;
      if (created.port !== settings.port) {
        cached = { ...settings, port: created.port };
        saveSettings(cached);
      }
      return;
    } catch (err) {
      lastError = err;
    }
  }
  console.warn('[mcp] Could not start the loopback endpoint:', lastError);
}

async function stop(): Promise<void> {
  const current = handle;
  handle = null;
  if (current) await current.close();
}

/**
 * Apply a settings change (or just reconcile on startup) and return the
 * resulting status.
 */
export async function applyMcpHttpSettings(
  controller: EditorController,
  update?: { enabled?: boolean; port?: number },
  deps?: ToolExecutorDeps,
): Promise<McpHttpStatus> {
  const settings = loadSettings();
  const requestedPort = update?.port;
  const nextPort =
    typeof requestedPort === 'number'
    && Number.isInteger(requestedPort)
    && requestedPort >= 1024
    && requestedPort <= 65535
      ? requestedPort
      : settings.port;
  const requestedEnabled = update?.enabled;
  if (requestedEnabled !== undefined || nextPort !== settings.port) {
    saveSettings({
      enabled: requestedEnabled ?? settings.enabled,
      port: nextPort,
      token: settings.token,
    });
  }
  const next = loadSettings();
  if (next.enabled) {
    await start(controller, deps);
  } else {
    await stop();
  }
  return status();
}

/** Current status without starting or stopping anything. */
export function getMcpHttpStatus(): McpHttpStatus {
  return status();
}

/**
 * Start the loopback endpoint without consulting (or mutating) the
 * "enabled" preference — the windowless `--mcp-server` entry uses this so a
 * CI run never flips the desktop app's own setting. The saved port and
 * token are reused, so a harness that already knows the config keeps
 * working.
 */
export async function startStandaloneMcpHttp(
  controller: EditorController,
  deps?: ToolExecutorDeps,
): Promise<McpHttpStatus> {
  await start(controller, deps);
  return status();
}

/** Close the listener (windowless mode teardown). */
export async function stopStandaloneMcpHttp(): Promise<void> {
  await stop();
}

/** Test seam. */
export function resetMcpHttpCache(): void {
  cached = null;
}
