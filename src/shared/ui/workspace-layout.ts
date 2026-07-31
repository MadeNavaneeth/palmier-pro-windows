/**
 * Workspace layout presets (upstream PR #430).
 *
 * Upstream models the workspace as three named arrangements rather than a set of
 * independent switches, which is what makes the vertical-video case usable: it is
 * not "hide a panel", it is "put the preview in a tall column and move everything
 * else beside it". Panel visibility stays a separate, finer control — a preset
 * decides the arrangement, the toggles decide what is present in it.
 *
 * Pure data so the presets, their labels, and their key bindings have one
 * definition shared by the store, the shortcut catalogue, and the UI.
 */

export const LAYOUT_PRESETS = ['default', 'media', 'vertical'] as const;

export type LayoutPreset = (typeof LAYOUT_PRESETS)[number];

export const DEFAULT_LAYOUT: LayoutPreset = 'default';

export interface LayoutPresetInfo {
  id: LayoutPreset;
  label: string;
  /** Digit pressed with Ctrl, matching upstream's Cmd+1/2/3. */
  digit: '1' | '2' | '3';
  /** What the arrangement is for, shown as help text. */
  description: string;
}

export const LAYOUT_PRESET_INFO: readonly LayoutPresetInfo[] = [
  {
    id: 'default',
    label: 'Default',
    digit: '1',
    description: 'Media, preview and inspector in a row, timeline underneath.',
  },
  {
    id: 'media',
    label: 'Media',
    digit: '2',
    description: 'Media browser full height down the left, for sifting through footage.',
  },
  {
    id: 'vertical',
    label: 'Vertical',
    digit: '3',
    description: 'Tall preview column on the right, for portrait and social formats.',
  },
] as const;

export function layoutPresetInfo(preset: LayoutPreset): LayoutPresetInfo {
  // Non-null: LAYOUT_PRESET_INFO covers every member of LAYOUT_PRESETS, which the
  // test suite asserts, so this cannot miss.
  return LAYOUT_PRESET_INFO.find((entry) => entry.id === preset)!;
}

/**
 * Narrow an untrusted value to a preset, or null.
 *
 * The persisted value is user-writable and may have been written by a build with
 * a different set of presets, so it is checked rather than cast — the same
 * treatment upstream gives it when reading from `UserDefaults`.
 */
export function asLayoutPreset(value: unknown): LayoutPreset | null {
  return typeof value === 'string' && (LAYOUT_PRESETS as readonly string[]).includes(value)
    ? (value as LayoutPreset)
    : null;
}
