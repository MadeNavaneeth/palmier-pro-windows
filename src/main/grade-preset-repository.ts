/**
 * App-wide named color-grade/shot preset repository (upstream #157).
 *
 * The Agent and renderer share the same persisted preferences, so this store is
 * deliberately process-wide rather than session-scoped. The backend is lazy:
 * unit tests and Electron-free MCP hosts use an in-memory backend, while the
 * desktop app creates the dedicated electron-store file on first use.
 */

import crypto from 'crypto';
import { app } from 'electron';
import Store from 'electron-store';
import {
  GRADE_PRESET_NAME_MAX,
  MAX_USER_GRADE_PRESETS,
  gradePresetNameKey,
  normalizeGradePresetCandidate,
  normalizeGradePresetLabel,
  normalizeUserGradePresets,
  type GradePreset,
} from '../shared/editor/grade-preset-store';

const STORE_NAME = 'palmier-grade-presets';
const STORE_KEY = 'presets';

export interface GradePresetBackend {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** Small backend used by tests and non-Electron hosts. */
export class InMemoryGradePresetBackend implements GradePresetBackend {
  private readonly values = new Map<string, unknown>();

  get(key: string): unknown {
    return this.values.get(key);
  }

  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  clear(): void {
    this.values.clear();
  }
}

export type GradePresetWriteResult =
  | { ok: true; preset: GradePreset; presets: GradePreset[] }
  | { ok: false; error: string; presets: GradePreset[] };

export type GradePresetDeleteResult =
  | { ok: true; changed: boolean; presets: GradePreset[] }
  | { ok: false; error: string; presets: GradePreset[] };

function newPresetId(): string {
  return `user-${crypto.randomUUID()}`;
}

export class GradePresetRepository {
  constructor(
    private readonly backend: GradePresetBackend = new InMemoryGradePresetBackend(),
    private readonly makeId: () => string = newPresetId,
  ) {}

  /** Read and narrow the user-writable store on every call. */
  list(): GradePreset[] {
    try {
      return normalizeUserGradePresets(this.backend.get(STORE_KEY));
    } catch (error: unknown) {
      console.warn('[grade-presets] Could not read presets:', error);
      return [];
    }
  }

  get(id: string): GradePreset | null {
    return this.list().find((preset) => preset.id === id) ?? null;
  }

  /** Save a new uniquely named grade/shot look; duplicate names and a full cap fail loudly. */
  save(label: unknown, grade: unknown, shot?: unknown): GradePresetWriteResult {
    const presets = this.list();
    const normalizedLabel = normalizeGradePresetLabel(label);
    if (!normalizedLabel) {
      return {
        ok: false,
        error: `Preset name must be between 1 and ${GRADE_PRESET_NAME_MAX} characters.`,
        presets,
      };
    }
    const nameKey = gradePresetNameKey(normalizedLabel);
    if (presets.some((preset) => gradePresetNameKey(preset.label) === nameKey)) {
      return { ok: false, error: `A preset named "${normalizedLabel}" already exists.`, presets };
    }
    if (presets.length >= MAX_USER_GRADE_PRESETS) {
      return { ok: false, error: `Preset limit reached (${MAX_USER_GRADE_PRESETS}).`, presets };
    }

    let id = this.makeId();
    while (presets.some((preset) => preset.id === id)) id = this.makeId();
    const preset = normalizeGradePresetCandidate({ id, label: normalizedLabel, grade, shot });
    if (!preset) {
      return { ok: false, error: 'Preset grade contains no valid fields.', presets };
    }
    const next = [...presets, preset];
    try {
      this.backend.set(STORE_KEY, next);
    } catch (error: unknown) {
      return {
        ok: false,
        error: `Could not persist grade preset: ${error instanceof Error ? error.message : String(error)}`,
        presets,
      };
    }
    return { ok: true, preset, presets: next };
  }

  /** Rename an existing preset; a case-insensitive name collision is refused. */
  rename(id: string, label: unknown): GradePresetWriteResult {
    const presets = this.list();
    const current = presets.find((preset) => preset.id === id);
    if (!current) return { ok: false, error: 'Grade preset not found.', presets };

    const normalizedLabel = normalizeGradePresetLabel(label);
    if (!normalizedLabel) {
      return {
        ok: false,
        error: `Preset name must be between 1 and ${GRADE_PRESET_NAME_MAX} characters.`,
        presets,
      };
    }
    const nameKey = gradePresetNameKey(normalizedLabel);
    if (presets.some((preset) => preset.id !== id && gradePresetNameKey(preset.label) === nameKey)) {
      return { ok: false, error: `A preset named "${normalizedLabel}" already exists.`, presets };
    }
    if (current.label === normalizedLabel) {
      return { ok: true, preset: current, presets };
    }
    const next = presets.map((preset) => preset.id === id ? { ...preset, label: normalizedLabel } : preset);
    try {
      this.backend.set(STORE_KEY, next);
    } catch (error: unknown) {
      return {
        ok: false,
        error: `Could not persist grade preset: ${error instanceof Error ? error.message : String(error)}`,
        presets,
      };
    }
    return { ok: true, preset: next.find((preset) => preset.id === id)!, presets: next };
  }

  /** Delete is idempotent: removing an already absent id is a successful no-op. */
  delete(id: string): GradePresetDeleteResult {
    const presets = this.list();
    if (!presets.some((preset) => preset.id === id)) {
      return { ok: true, changed: false, presets };
    }
    const next = presets.filter((preset) => preset.id !== id);
    try {
      this.backend.set(STORE_KEY, next);
    } catch (error: unknown) {
      return {
        ok: false,
        error: `Could not persist grade preset: ${error instanceof Error ? error.message : String(error)}`,
        presets,
      };
    }
    return { ok: true, changed: true, presets: next };
  }
}

let electronStore: Store | null = null;
let fallbackBackend: InMemoryGradePresetBackend | null = null;
let defaultRepository: GradePresetRepository | null = null;

function defaultBackend(): GradePresetBackend {
  try {
    if (app && typeof app.getPath === 'function') {
      electronStore ??= new Store({ name: STORE_NAME });
      return electronStore;
    }
  } catch (error: unknown) {
    console.warn('[grade-presets] Could not open electron-store, using memory:', error);
  }
  fallbackBackend ??= new InMemoryGradePresetBackend();
  return fallbackBackend;
}

/** The process-wide repository shared by IPC, the in-app Agent, and MCP. */
export function getGradePresetRepository(): GradePresetRepository {
  return defaultRepository ??= new GradePresetRepository(defaultBackend());
}

/** Test seam: forget the singleton and its non-Electron fallback. */
export function resetGradePresetRepository(): void {
  defaultRepository = null;
  electronStore = null;
  fallbackBackend = null;
}
