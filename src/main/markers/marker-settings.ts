/**
 * Persisted marker preferences (upstream PR #560, `rippleTimelineMarkers`).
 *
 * The main process owns these, not the renderer, for the same reason it owns
 * the silence controls: they are shared state with a second caller. The Agent
 * and MCP server run here, so a renderer-owned preference would leave an
 * agent ripple delete remapping markers the timeline toolbar says are pinned.
 *
 * They are preferences rather than project data, so they live in the app store
 * instead of the project file: flipping the toggle is not a document edit and
 * must not land on the undo stack or mark the project dirty.
 */

import { app, ipcMain } from 'electron';
import Store from 'electron-store';
import {
  DEFAULT_MARKER_SETTINGS,
  normalizeMarkerSettings,
  type MarkerSettings,
} from '../../shared/editor/marker-settings';
import type { EditorController } from '../../shared/editor/controller';

const SETTINGS_KEY = 'markerPreferences';

let store: Store | null = null;
/** Session value, so a settings file that cannot be written still applies. */
let cached: MarkerSettings | null = null;

/**
 * Created lazily, and only inside a real Electron main process.
 *
 * The store resolves `app.getPath('userData')` on construction, so importing
 * this module must not force that: the tool executor reaches this code from
 * unit tests too, where Electron is not running and the defaults are correct.
 */
function getStore(): Store | null {
  if (!app) return null;
  store ??= new Store({ name: 'palmier-marker-settings' });
  return store;
}

/**
 * The saved preferences, narrowed.
 *
 * The settings file is user-writable and may have been written by a different
 * build, so the stored object is narrowed on every read rather than trusted —
 * a hand-edited non-boolean must not silently unpin every marker.
 */
export function loadMarkerSettings(): MarkerSettings {
  if (cached) return cached;
  try {
    const stored = getStore()?.get(SETTINGS_KEY) as Partial<MarkerSettings> | undefined;
    cached = normalizeMarkerSettings(stored);
  } catch (err: unknown) {
    console.warn('[markers] Could not read marker settings, using defaults:', err);
    cached = { ...DEFAULT_MARKER_SETTINGS };
  }
  return cached;
}

/**
 * Merge a partial update into the saved preferences and return the result.
 */
export function saveMarkerSettings(update: unknown): MarkerSettings {
  const next = normalizeMarkerSettings(update, loadMarkerSettings());
  cached = next;
  try {
    getStore()?.set(SETTINGS_KEY, next);
  } catch (err: unknown) {
    // An unwritable store must not break the control itself.
    console.warn('[markers] Could not persist marker settings:', err);
  }
  return next;
}

/** Test seam: drop the cached value so the next read hits the store again. */
export function resetMarkerSettingsCache(): void {
  cached = null;
}

/**
 * Apply the saved preference to one controller's flag (a preference, not
 * project data, so renderer project syncs neither carry nor clear it). Every
 * new session's mirror gets this on creation, so agent ripple edits obey the
 * toggle without re-reading the file per call.
 */
export function applyMarkerSettings(controller: EditorController): void {
  controller.setRippleTimelineMarkers(loadMarkerSettings().rippleTimelineMarkers);
}

/**
 * IPC for the timeline toolbar toggle, and application of the saved value to
 * the main-process mirrors the Agent edits through. The preference is
 * process-wide, so a set applies to every live session's controller — with
 * multiple windows (#137) a toggle honored in one window must not be skipped
 * in another's agent edits.
 */
export function registerMarkerSettingsHandlers(
  getControllers: () => Iterable<EditorController>,
): void {
  ipcMain.handle('markers:get-marker-settings', () => ({
    success: true,
    settings: loadMarkerSettings(),
    defaults: DEFAULT_MARKER_SETTINGS,
  }));

  ipcMain.handle('markers:set-marker-settings', (_event, update?: unknown) => {
    const settings = saveMarkerSettings(update);
    for (const controller of getControllers()) {
      controller.setRippleTimelineMarkers(settings.rippleTimelineMarkers);
    }
    return { success: true, settings };
  });
}
