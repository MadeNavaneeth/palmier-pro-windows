/**
 * Per-clip audio noise reduction (upstream #165).
 *
 * One percent strength (0-100, absent = off) drives both engines:
 *
 * - Export runs FFmpeg's `afftdn` spectral denoiser with
 *   `nr = amount * 0.24` (upstream's 60% default maps to 14.4, comfortably
 *   inside afftdn's 0.01-97 domain with headroom in both directions).
 * - Web Audio has no FFT denoiser, so the preview approximates the same
 *   character with two biquads ahead of the panner: a highpass at
 *   `20 + amount * 0.8` Hz (60% -> 68 Hz) rolls off rumble below speech,
 *   and a highshelf dip of `-(amount * 0.06)` dB at 6 kHz (60% -> -3.6 dB)
 *   softens hiss. This is a documented approximation, not a bit match —
 *   both mappings are pinned by tests (denoise.test.ts, export-args
 *   .denoise.test.ts) so preview and export can only drift together.
 *
 * Off is exact on both sides: export emits no filter at all, and the
 * preview parks its two biquads at a transparent setting (10 Hz highpass,
 * below audibility, and a 0 dB shelf), so — like the EQ and compressor
 * stages — there is no bypass branch.
 *
 * Absent/0 = off. A value that is not a finite number in [0,100] is
 * dropped by the sanitizer rather than clamped (same contract as the EQ
 * bands), so a hostile project file degrades to "no denoise" instead of
 * an invalid filter argument.
 */

import type { Clip } from '../types/project';

/** Slider bounds for the strength percent. */
export const NOISE_REDUCTION_LIMITS = { min: 0, max: 100 } as const;

/** Strength applied when the checkbox arms the stage (upstream's default). */
export const DEFAULT_NOISE_REDUCTION = 60;

/** Keep a finite percent inside [0,100]; anything else is dropped. */
export function sanitizeNoiseReduction(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value >= NOISE_REDUCTION_LIMITS.min && value <= NOISE_REDUCTION_LIMITS.max
    ? value
    : undefined;
}

/** The clip's strength, or null when off (absent, 0, or hostile). */
export function noiseReductionOf(clip: Pick<Clip, 'noiseReduction'>): number | null {
  const amount = sanitizeNoiseReduction(clip.noiseReduction);
  return amount === undefined || amount <= 0 ? null : amount;
}

/**
 * FFmpeg `afftdn` filter fragment (no leading comma) for a strength percent.
 * `nr` must stay inside afftdn's 0.01-97 domain: the 0.24 scale keeps 100%
 * at 24, and a sub-floor amount is floored rather than rejected so any
 * value the sanitizer keeps (0 < amount <= 100) renders.
 */
export function buildDenoiseFilter(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0 || amount > NOISE_REDUCTION_LIMITS.max) {
    throw new Error(`Noise reduction must be a percent in (0, ${NOISE_REDUCTION_LIMITS.max}].`);
  }
  const nr = Math.max(0.01, amount * 0.24);
  return `afftdn=nr=${nr.toFixed(2)}`;
}

/**
 * Preview biquad settings for a strength percent (null/off included).
 * See the module note for why these approximate rather than match afftdn.
 */
export function denoisePreviewParams(amount: number | null): {
  highpassFrequency: number;
  highshelfFrequency: number;
  highshelfGainDb: number;
} {
  const active = amount !== null && Number.isFinite(amount) && amount > 0
    ? Math.min(amount, NOISE_REDUCTION_LIMITS.max)
    : null;
  if (active === null) {
    // Transparent parking: 10 Hz is inaudible, a 0 dB shelf changes nothing.
    return { highpassFrequency: 10, highshelfFrequency: 6000, highshelfGainDb: 0 };
  }
  return {
    highpassFrequency: 20 + active * 0.8,
    highshelfFrequency: 6000,
    highshelfGainDb: -(active * 0.06),
  };
}
