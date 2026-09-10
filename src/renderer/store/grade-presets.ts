/**
 * User-defined color-grade presets (upstream #157's naming/reuse half).
 *
 * Renderer-owned and persisted like the other UI preferences: the built-in
 * presets live in the shared domain, and these are the ones the user saved
 * from a clip's current grade. Stored under `palmier.grade.presets` and
 * narrowed on read, so a stale or hand-edited value degrades to "no user
 * presets" instead of feeding the grade pipeline garbage.
 */

import { create } from 'zustand';
import {
  MAX_USER_GRADE_PRESETS,
  normalizeUserGradePresets,
  type GradePreset,
} from '../../shared/editor/color-grade';

const STORAGE_KEY = 'palmier.grade.presets';

function load(): GradePreset[] {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    return normalizeUserGradePresets(JSON.parse(raw));
  } catch {
    return [];
  }
}

function persist(presets: GradePreset[]): void {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // A full or unavailable storage quota must not break the save itself.
  }
}

function newId(): string {
  try {
    return `user-${crypto.randomUUID()}`;
  } catch {
    return `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

interface GradePresetsState {
  presets: GradePreset[];
  /** Save the given grade under a name; returns the stored preset or null. */
  save: (label: string, grade: GradePreset['grade']) => GradePreset | null;
  remove: (id: string) => void;
}

export const useGradePresetsStore = create<GradePresetsState>((set, get) => ({
  presets: load(),

  save: (label, grade) => {
    const candidate: GradePreset = { id: newId(), label, grade };
    const next = normalizeUserGradePresets([...get().presets, candidate])
      .slice(0, MAX_USER_GRADE_PRESETS);
    // A rejected name/value (empty, over-long, or an empty grade) leaves the
    // stored list untouched.
    const stored = next.find((preset) => preset.id === candidate.id);
    if (!stored) return null;
    persist(next);
    set({ presets: next });
    return stored;
  },

  remove: (id) => {
    const next = get().presets.filter((preset) => preset.id !== id);
    if (next.length === get().presets.length) return;
    persist(next);
    set({ presets: next });
  },
}));
