/**
 * Persisted export presets (roadmap R2).
 *
 * Named format/quality/range combos stored per user so creators can
 * re-run standard deliveries without reconfiguring the dialog each time.
 * Lives in electron-store like other app preferences; not project data.
 */

import { app } from 'electron';
import Store from 'electron-store';

const SETTINGS_KEY = 'exportPresets';

let store: Store | null = null;

export interface ExportPreset {
  id: string;
  name: string;
  format: 'mp4' | 'mov' | 'webm' | 'audio';
  quality: 'draft' | 'normal' | 'high';
  useRange: boolean;
}

function getStore(): Store | null {
  if (!app) return null;
  store ??= new Store({ name: 'palmier-export-presets' });
  return store;
}

/** Load saved presets sorted by name. Returns [] when unavailable. */
export function loadPresets(): ExportPreset[] {
  try {
    const raw = getStore()?.get(SETTINGS_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is ExportPreset =>
        typeof p === 'object' && p !== null
        && typeof (p as ExportPreset).id === 'string'
        && typeof (p as ExportPreset).name === 'string'
        && typeof (p as ExportPreset).format === 'string',
    );
  } catch {
    return [];
  }
}

/** Persist the full list atomically. */
export function savePresets(presets: ExportPreset[]): void {
  try {
    getStore()?.set(SETTINGS_KEY, presets);
  } catch {
    // Unwritable store must not break the control itself.
  }
}
