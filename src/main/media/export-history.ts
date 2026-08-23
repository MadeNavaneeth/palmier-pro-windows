/**
 * Persisted export history (roadmap R2).
 *
 * After each successful export the settings and output path are recorded so
 * the UI can show recent deliveries and offer re-reveal. Stored in
 * electron-store like other app preferences; capped at 20 entries.
 */

import { app } from 'electron';
import Store from 'electron-store';

const SETTINGS_KEY = 'exportHistory';
const MAX_ENTRIES = 20;

let store: Store | null = null;

export interface ExportRecord {
  outputPath: string;
  format: string;
  quality: string;
  /** Project name at time of export. */
  projectName: string;
  /** ISO timestamp of completion. */
  completedAt: string;
  bytes: number;
  /** Full export options for re-running the same delivery. */
  options?: Record<string, unknown>;
}

function getStore(): Store | null {
  if (!app) return null;
  store ??= new Store({ name: 'palmier-export-history' });
  return store;
}

/** Load recent export records, newest first. */
export function loadExportHistory(): ExportRecord[] {
  try {
    const raw = getStore()?.get(SETTINGS_KEY);
    return Array.isArray(raw) ? (raw as ExportRecord[]) : [];
  } catch {
    return [];
  }
}

/** Record a completed export; trims to MAX_ENTRIES. */
export function recordExport(record: ExportRecord): void {
  const history = [record, ...loadExportHistory()].slice(0, MAX_ENTRIES);
  try {
    getStore()?.set(SETTINGS_KEY, history);
  } catch {
    // Unwritable store must not break the control itself.
  }
}
