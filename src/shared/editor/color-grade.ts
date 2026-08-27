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
