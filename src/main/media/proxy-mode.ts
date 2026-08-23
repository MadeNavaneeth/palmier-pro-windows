/**
 * Persisted proxy decode policy (roadmap R2).
 *
 * Owned by the main process for the same reason as the silence controls:
 * the compositor builds decode requests here, so renderer-held state would
 * leave agent/MCP-driven composites using a different policy than the UI.
 * A preference, not project data -- no undo stack, no dirty flag.
 */

import { app } from 'electron';
import Store from 'electron-store';
import { PROXY_MODES, type ProxyMode } from '../../shared/media/proxy';

const SETTINGS_KEY = 'proxyMode';

let store: Store | null = null;
let cached: ProxyMode | null = null;

function getStore(): Store | null {
  if (!app) return null;
  store ??= new Store({ name: 'palmier-media-settings' });
  return store;
}

/** Narrow a stored value on read; anything unexpected means auto. */
function normalize(value: unknown): ProxyMode {
  return typeof value === 'string' && (PROXY_MODES as readonly string[]).includes(value)
    ? (value as ProxyMode)
    : 'auto';
}

export function loadProxyMode(): ProxyMode {
  if (cached) return cached;
  try {
    cached = normalize(getStore()?.get(SETTINGS_KEY));
  } catch {
    cached = 'auto';
  }
  return cached;
}

export function saveProxyMode(mode: ProxyMode): ProxyMode {
  const next = normalize(mode);
  cached = next;
  try {
    getStore()?.set(SETTINGS_KEY, next);
  } catch {
    // An unwritable store must not break the control itself.
  }
  return next;
}

/** Test seam. */
export function resetProxyModeCache(): void {
  cached = null;
}
