/**
 * Audio normalization math (roadmap R5).
 *
 * Pure conversion helpers so preview, agent, and export agree on what a
 * dB reading means for the volume slider.
 */

/** Convert decibels (relative to full scale) to a linear multiplier. */
export function dbToLinear(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.pow(10, db / 20);
}

/** Convert a linear multiplier back to decibels. */
export function linearToDb(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 0) return -Infinity;
  return 20 * Math.log10(linear);
}

/**
 * Linear volume multiplier needed to bring a measured peak to a target.
 *
 * @param currentPeakDb Measured peak in dBFS (e.g. -6 means peaks at -6 dBFS)
 * @param targetDb Desired peak in dBFS (0 = full scale; negative leaves headroom)
 * @returns Linear multiplier ≥ 0, capped at MAX_NORMALIZE_GAIN to avoid
 *   amplifying noise floor into distortion when the source is very quiet.
 */
export function normalizeGain(currentPeakDb: number, targetDb: number): number {
  if (!Number.isFinite(currentPeakDb) || !Number.isFinite(targetDb)) return 1;
  const delta = targetDb - currentPeakDb;
  return Math.min(MAX_NORMALIZE_GAIN, Math.max(0, dbToLinear(delta)));
}

/**
 * Gain cap so normalizing a near-silent file doesn't blow up into pure
 * noise. 16× (~+24 dB) is generous enough for phone recordings but stops
 * short of making a whisper sound like a jet engine.
 */
export const MAX_NORMALIZE_GAIN = 16;

/** Standard normalization targets offered by the UI. */
export const NORMALIZE_TARGETS_DB = [-3, -6, -12] as const;
