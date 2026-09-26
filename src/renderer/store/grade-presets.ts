/**
 * Renderer client for app-wide named color-grade presets (upstream #157).
 *
 * The main process owns persistence so the Agent/MCP surface and every window
 * see the same list. The exported Zustand shape remains compatible with the
 * Inspector: `presets`, `save`, and `remove` are still the operations it uses;
 * the two mutations now resolve after the IPC request. The initial list is
 * intentionally empty until the async load completes.
 */

import { create } from 'zustand';
import {
  normalizeUserGradePresets,
  type GradePreset,
} from '../../shared/editor/grade-preset-store';

interface GradePresetResponse {
  success?: unknown;
  preset?: unknown;
  presets?: unknown;
  changed?: unknown;
}

interface GradePresetsState {
  presets: GradePreset[];
  /** Refresh the app-wide list; used by the initial client load and tests. */
  load: () => Promise<GradePreset[]>;
  /** Save the given grade and optional shot under a name; resolves to null when refused. */
  save: (label: string, grade: GradePreset['grade'], shot?: GradePreset['shot']) => Promise<GradePreset | null>;
  /** Remove one preset; resolves true only when a row was removed. */
  remove: (id: string) => Promise<boolean>;
}

function client() {
  if (typeof window === 'undefined') return undefined;
  return window.palmier?.gradePresets;
}

function response(value: unknown): GradePresetResponse {
  return typeof value === 'object' && value !== null ? value as GradePresetResponse : {};
}

function narrowPresets(value: unknown): GradePreset[] | null {
  return Array.isArray(value) ? normalizeUserGradePresets(value) : null;
}

function narrowPreset(value: unknown): GradePreset | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { id?: unknown; label?: unknown; grade?: unknown; shot?: unknown };
  return normalizeUserGradePresets([{
    id: candidate.id,
    label: candidate.label,
    grade: candidate.grade,
    shot: candidate.shot,
  }])[0] ?? null;
}

export const useGradePresetsStore = create<GradePresetsState>((set, get) => {
  const load = async (): Promise<GradePreset[]> => {
    const api = client();
    if (!api) {
      set({ presets: [] });
      return [];
    }
    try {
      const result = response(await api.list());
      const presets = narrowPresets(result.presets) ?? [];
      set({ presets });
      return presets;
    } catch {
      return get().presets;
    }
  };

  const state: GradePresetsState = {
    presets: [],
    load,

    save: async (label, grade, shot) => {
      const api = client();
      if (!api) return null;
      try {
        const result = response(shot === undefined
          ? await api.save(label, grade)
          : await api.save(label, grade, shot));
        const presets = narrowPresets(result.presets);
        if (presets) set({ presets });
        const preset = narrowPreset(result.preset);
        if (result.success !== true || !preset) return null;
        if (!presets) set({ presets: [...get().presets, preset] });
        return preset;
      } catch {
        return null;
      }
    },

    remove: async (id) => {
      const api = client();
      if (!api) return false;
      try {
        const result = response(await api.remove(id));
        const presets = narrowPresets(result.presets);
        if (presets) set({ presets });
        return result.success === true && result.changed === true;
      } catch {
        return false;
      }
    },
  };

  // No localStorage read and no blocking renderer work: the list arrives from
  // the main repository immediately after the client is created.
  void load();
  return state;
});
