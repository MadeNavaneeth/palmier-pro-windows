/**
 * Three-band EQ for audio clips (upstream #158, "audio editing tools beyond
 * volume control").
 *
 * Low (100 Hz shelving), mid (1 kHz peaking, Q 1), high (3 kHz shelving) —
 * the same three bands and frequencies the FFmpeg export chain uses
 * (`bass`/`equalizer`/`treble`), so preview and export cannot disagree on
 * what "Low +6 dB" means. Gains are in dB, bounded to ±15; 0 is the neutral
 * default and removes the field, so an un-EQ'd clip stays structurally
 * un-EQ'd exactly like the color grade and chroma key fields.
 */

import type { Clip } from '../types/project';

export interface ClipEq {
  lowDb: number;
  midDb: number;
  highDb: number;
}

/** Band frequencies shared by the preview biquads and the FFmpeg filters. */
export const EQ_FREQUENCIES = { low: 100, mid: 1000, high: 3000 } as const;
/** Mid peaking width; 1 Q is the FFmpeg `equalizer`/WebAudio default match. */
export const EQ_MID_Q = 1;

export const EQ_LIMITS = {
  lowDb: { min: -15, max: 15 },
  midDb: { min: -15, max: 15 },
  highDb: { min: -15, max: 15 },
} as const;

export const EQ_DEFAULT: ClipEq = { lowDb: 0, midDb: 0, highDb: 0 };

export type EqField = keyof typeof EQ_LIMITS;

type EqSource = Pick<Clip, 'eqLowDb' | 'eqMidDb' | 'eqHighDb'>;

/** True when any band is set (including a deliberate 0 dB override). */
export function hasEq(clip: EqSource): boolean {
  return clip.eqLowDb !== undefined || clip.eqMidDb !== undefined || clip.eqHighDb !== undefined;
}

/** The clip's EQ, or null when no band differs from neutral. */
export function eqOf(clip: EqSource): ClipEq | null {
  const eq: ClipEq = {
    lowDb: clip.eqLowDb ?? 0,
    midDb: clip.eqMidDb ?? 0,
    highDb: clip.eqHighDb ?? 0,
  };
  return eq.lowDb === 0 && eq.midDb === 0 && eq.highDb === 0 ? null : eq;
}

function inRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value >= min && value <= max ? value : undefined;
}

/**
 * Narrow a partial EQ patch to finite, in-range values. Same contract as
 * `sanitizeColorGrade`: an out-of-range band is dropped, not clamped, so
 * "unusable" never silently becomes "at the boundary".
 */
export function sanitizeEq(input: Partial<ClipEq> | undefined): Partial<ClipEq> {
  if (!input) return {};
  const out: Partial<ClipEq> = {};
  for (const field of Object.keys(EQ_LIMITS) as EqField[]) {
    if (input[field] === undefined) continue;
    const value = inRange(input[field], EQ_LIMITS[field].min, EQ_LIMITS[field].max);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function band(value: number): string {
  return `${value > 0 ? '+' : ''}${value}`;
}

/**
 * FFmpeg audio-filter suffix, e.g.
 * `bass=g=3.0,equalizer=f=1000:t=q:w=1:g=-2.0,treble=g=6.0`.
 * Empty string when every band is neutral.
 */
export function eqFilterChain(eq: ClipEq): string {
  const parts: string[] = [];
  if (eq.lowDb !== 0) parts.push(`bass=g=${band(eq.lowDb)}`);
  if (eq.midDb !== 0) {
    parts.push(`equalizer=f=${EQ_FREQUENCIES.mid}:t=q:w=${EQ_MID_Q}:g=${band(eq.midDb)}`);
  }
  if (eq.highDb !== 0) parts.push(`treble=g=${band(eq.highDb)}`);
  return parts.join(',');
}

/**
 * Web Audio filter settings for the preview graph; the same three bands the
 * export chain emits. `gain` is already in dB, which is what
 * `BiquadFilterNode.gain` expects.
 */
export function eqBiquadParams(eq: ClipEq): Array<{
  type: BiquadFilterType;
  frequency: number;
  q?: number;
  gain: number;
}> {
  return [
    { type: 'lowshelf', frequency: EQ_FREQUENCIES.low, gain: eq.lowDb },
    { type: 'peaking', frequency: EQ_FREQUENCIES.mid, q: EQ_MID_Q, gain: eq.midDb },
    { type: 'highshelf', frequency: EQ_FREQUENCIES.high, gain: eq.highDb },
  ];
}
