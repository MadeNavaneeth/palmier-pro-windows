/**
 * Color grading helpers (roadmap R4).
 *
 * Brightness, contrast, saturation, and hue rotation are stored per clip
 * and applied identically by the canvas preview (ctx.filter) and the FFmpeg
 * export chain (eq filter). These helpers produce the values for each
 * consumer from the same clip fields so they can never disagree.
 */

import type { Clip } from '../types/project';

export interface ColorGrade {
  brightness: number;
  contrast: number;
  saturation: number;
  hueRotation: number;
  invertColors?: boolean;
}

const DEFAULTS: ColorGrade = { brightness: 0, contrast: 1, saturation: 1, hueRotation: 0, invertColors: false };

/** Neutral values, exported so UI and agent both reset to the same place. */
export const DEFAULT_COLOR_GRADE: ColorGrade = { ...DEFAULTS };

/**
 * Accepted ranges for the four graded fields (upstream #157's effect stack,
 * exposed to the Inspector). CSS/FFmpeg accept wider values, but past these
 * the picture is destroyed rather than graded — contrast and saturation are
 * multipliers, brightness is an offset added to the normalized signal.
 */
export const COLOR_GRADE_LIMITS = {
  brightness: { min: -1, max: 1 },
  contrast: { min: 0, max: 3 },
  saturation: { min: 0, max: 3 },
  hueRotation: { min: -180, max: 180 },
} as const;

export type ColorGradeField = keyof typeof COLOR_GRADE_LIMITS;

function inRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value >= min && value <= max ? value : undefined;
}

/**
 * Narrow a partial grade to finite, in-range values.
 *
 * A field that is absent, non-finite, or outside its range is dropped rather
 * than clamped: the caller may be clearing a field, and silently substituting
 * a boundary value would turn "remove this" into "set it to the maximum".
 * Consumers that want clamping express it with a range input, which cannot
 * produce an out-of-range value in the first place.
 */
export function sanitizeColorGrade(input: Partial<ColorGrade> | undefined): Partial<ColorGrade> {
  if (!input) return {};
  const out: Partial<ColorGrade> = {};
  for (const field of Object.keys(COLOR_GRADE_LIMITS) as ColorGradeField[]) {
    if (input[field] === undefined) continue;
    const value = inRange(input[field], COLOR_GRADE_LIMITS[field].min, COLOR_GRADE_LIMITS[field].max);
    if (value !== undefined) out[field] = value;
  }
  if (typeof input.invertColors === 'boolean') out.invertColors = input.invertColors;
  return out;
}

/**
 * Named, built-in grade presets (upstream #157). Values stay inside
 * `COLOR_GRADE_LIMITS`, so applying one can never write a grade the sliders
 * cannot represent. `neutral` resets rather than writing defaults, which is
 * what keeps `hasColorGrade` false after a reset.
 */
export interface GradePreset {
  id: string;
  label: string;
  grade: Partial<ColorGrade>;
}

export const GRADE_PRESETS: readonly GradePreset[] = [
  { id: 'neutral', label: 'Neutral', grade: {} },
  { id: 'warm', label: 'Warm', grade: { brightness: 0.03, contrast: 1.05, saturation: 1.15, hueRotation: -8 } },
  { id: 'cool', label: 'Cool', grade: { brightness: 0.02, contrast: 1.05, saturation: 1.05, hueRotation: 10 } },
  { id: 'bw', label: 'Black & White', grade: { saturation: 0 } },
  { id: 'faded', label: 'Faded', grade: { brightness: 0.08, contrast: 0.85, saturation: 0.75 } },
  { id: 'punchy', label: 'Punchy', grade: { contrast: 1.3, saturation: 1.25 } },
  { id: 'vintage', label: 'Vintage', grade: { brightness: 0.05, contrast: 0.9, saturation: 0.8, hueRotation: -15 } },
] as const;

export function gradePresetById(id: string): GradePreset | undefined {
  return GRADE_PRESETS.find((preset) => preset.id === id);
}

/** Extract non-default color fields from a clip; null when no grading. */
export function colorGradeOf(clip: Clip): ColorGrade | null {
  const grade: ColorGrade = {
    brightness: clip.brightness ?? DEFAULTS.brightness,
    contrast: clip.contrast ?? DEFAULTS.contrast,
    saturation: clip.saturation ?? DEFAULTS.saturation,
    hueRotation: clip.hueRotation ?? DEFAULTS.hueRotation,
    invertColors: clip.invertColors ?? DEFAULTS.invertColors,
  };
  return isDefaultGrade(grade) ? null : grade;
}

function isDefaultGrade(g: ColorGrade): boolean {
  return g.brightness === 0 && g.contrast === 1 && g.saturation === 1 && g.hueRotation === 0 && !g.invertColors;
}

/**
 * Chromium canvas `ctx.filter` string, e.g.
 * `brightness(0.9) contrast(1.2) saturate(0.5) hue-rotate(30deg)`.
 */
export function toCanvasFilter(grade: ColorGrade): string {
  const parts: string[] = [];
  if (grade.brightness !== 0) parts.push(`brightness(${grade.brightness.toFixed(3)})`);
  if (grade.contrast !== 1) parts.push(`contrast(${grade.contrast.toFixed(3)})`);
  if (grade.saturation !== 1) parts.push(`saturate(${grade.saturation.toFixed(3)})`);
  if (grade.hueRotation !== 0) parts.push(`hue-rotate(${grade.hueRotation.toFixed(1)}deg)`);
  if (grade.invertColors) parts.push('invert(1)');
  return parts.join(' ');
}

/**
 * FFmpeg `eq` filter value, e.g.
 * `eq=brightness=0.100000:contrast=1.200000:saturation=0.500000`.
 */
export function toFfmpegEq(grade: ColorGrade): string {
  const parts: string[] = [];
  if (grade.brightness !== 0) parts.push(`brightness=${grade.brightness.toFixed(6)}`);
  if (grade.contrast !== 1) parts.push(`contrast=${grade.contrast.toFixed(6)}`);
  if (grade.saturation !== 1) parts.push(`saturation=${grade.saturation.toFixed(6)}`);
  if (grade.hueRotation !== 0) {
    // FFmpeg eq has no hue param; use hue modifier for rotation.
    parts.push(`hue=h=${grade.hueRotation.toFixed(1)}`);
  }
  return parts.length > 0 ? `eq=${parts.join(':')}` : '';
}  /** True when any field differs from default — used to skip no-op work. */
export function hasColorGrade(clip: Clip): boolean {
  return clip.brightness !== undefined || clip.contrast !== undefined
    || clip.saturation !== undefined || clip.hueRotation !== undefined
    || clip.invertColors !== undefined;
}
