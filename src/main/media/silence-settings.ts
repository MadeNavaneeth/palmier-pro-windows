/**
 * Persisted silence-removal controls (upstream PR #426).
 *
 * The main process owns these, not the renderer, because they are shared state
 * with a second caller: `remove_silence` invoked with no arguments must produce
 * the edit the visible controls describe, and the Agent and MCP server run
 * here. Renderer-owned settings would leave an agent request using the built-in
 * defaults while the Inspector displayed something else.
 *
 * They are preferences rather than project data, so they live in the app store
 * instead of the project file: changing a slider is not a document edit and must
 * not land on the undo stack or mark the project dirty.
 */

import { app } from 'electron';
import Store from 'electron-store';
import {
  DEFAULT_SILENCE_CONFIG,
  normalizeSilenceConfig,
  type SilenceConfig,
} from '../../shared/audio/silence-detector';

const SETTINGS_KEY = 'silenceRemoval';

let store: Store | null = null;
/** Session value, so a settings file that cannot be written still applies. */
let cached: SilenceConfig | null = null;

/**
 * Created lazily, and only inside a real Electron main process.
 *
 * The store resolves `app.getPath('userData')` on construction, so importing
 * this module must not force that: the tool executor reaches this code from
 * unit tests too, where Electron is not running and the defaults are correct.
 */
function getStore(): Store | null {
  if (!app) return null;
  store ??= new Store({ name: 'palmier-audio-settings' });
  return store;
}

/**
 * The saved controls, normalized.
 *
 * The settings file is user-writable and may have been written by a different
 * build, so the stored object is narrowed on every read rather than trusted —
 * a hand-edited `minSilenceSec: 0` would otherwise cut on natural speech rhythm.
 */
export function loadSilenceSettings(): SilenceConfig {
  if (cached) return cached;
  try {
    const stored = getStore()?.get(SETTINGS_KEY) as Partial<SilenceConfig> | undefined;
    cached = normalizeSilenceConfig(stored);
  } catch (err: unknown) {
    console.warn('[audio] Could not read silence settings, using defaults:', err);
    cached = { ...DEFAULT_SILENCE_CONFIG };
  }
  return cached;
}

/**
 * Merge a partial update into the saved controls and return the result.
 *
 * Partial so one control can move without the caller echoing the others back,
 * which is what keeps two panels editing different controls from clobbering
 * each other.
 */
export function saveSilenceSettings(update: Partial<SilenceConfig> | undefined): SilenceConfig {
  const next = normalizeSilenceConfig(update, loadSilenceSettings());
  cached = next;
  try {
    getStore()?.set(SETTINGS_KEY, next);
  } catch (err: unknown) {
    // An unwritable store must not break the control itself.
    console.warn('[audio] Could not persist silence settings:', err);
  }
  return next;
}

/** Test seam: drop the cached value so the next read hits the store again. */
export function resetSilenceSettingsCache(): void {
  cached = null;
}
