/**
 * Per-clip compressor / limiter (upstream #158's remaining "compression"
 * tool).
 *
 * Five parameters — threshold (dB), ratio, attack (ms), release (ms), and
 * makeup gain (dB) — chosen because they are the intersection of what the
 * FFmpeg `acompressor` filter and the Web Audio `DynamicsCompressorNode`
 * both expose, so preview and export can be driven from the same numbers.
 * One documented difference: the soft-knee curve is engine-specific (Web
 * Audio works in dB and is fixed at 6 dB here; FFmpeg uses its own 2.87
 * factor), so the knee region is approximate while threshold, ratio, attack,
 * release, and makeup match.
 *
 * Ratio 1 is the off switch, exactly like tolerance 0 for chroma key: a
 * compressor at 1:1 cannot reduce gain, so `compressorOf` reports inactive
 * and both consumers skip the stage.
 */

import type { Clip } from '../types/project';

export interface CompressorConfig {
  /** Threshold in dBFS, -60 to 0. Signals above this are compressed. */
  thresholdDb: number;
  /** Compression ratio 1-20. 1 = off. */
  ratio: number;
  /** Attack in milliseconds. */
  attackMs: number;
  /** Release in milliseconds. */
  releaseMs: number;
  /** Output makeup gain in dB, 0-24. */
  makeupDb: number;
}

export const COMPRESSOR_LIMITS = {
  thresholdDb: { min: -60, max: 0 },
  ratio: { min: 1, max: 20 },
  attackMs: { min: 0.01, max: 2000 },
  releaseMs: { min: 0.01, max: 9000 },
  makeupDb: { min: 0, max: 24 },
} as const;

export const DEFAULT_COMPRESSOR: CompressorConfig = {
  thresholdDb: -18,
  ratio: 3,
  attackMs: 20,
  releaseMs: 250,
  makeupDb: 0,
};

/** Web Audio knee, in dB; see the module note about engine-specific knees. */
export const COMPRESSOR_PREVIEW_KNEE_DB = 6;

function clampInRange(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Normalize a partial compressor onto `fallback` (or the built-in defaults). */
export function normalizeCompressor(
  input: Partial<CompressorConfig> | undefined,
  fallback: CompressorConfig = DEFAULT_COMPRESSOR,
): CompressorConfig {
  return {
    thresholdDb: clampInRange(
      input?.thresholdDb,
      COMPRESSOR_LIMITS.thresholdDb.min,
      COMPRESSOR_LIMITS.thresholdDb.max,
      fallback.thresholdDb,
    ),
    ratio: clampInRange(input?.ratio, COMPRESSOR_LIMITS.ratio.min, COMPRESSOR_LIMITS.ratio.max, fallback.ratio),
    attackMs: clampInRange(
      input?.attackMs,
      COMPRESSOR_LIMITS.attackMs.min,
      COMPRESSOR_LIMITS.attackMs.max,
      fallback.attackMs,
    ),
    releaseMs: clampInRange(
      input?.releaseMs,
      COMPRESSOR_LIMITS.releaseMs.min,
      COMPRESSOR_LIMITS.releaseMs.max,
      fallback.releaseMs,
    ),
    makeupDb: clampInRange(
      input?.makeupDb,
      COMPRESSOR_LIMITS.makeupDb.min,
      COMPRESSOR_LIMITS.makeupDb.max,
      fallback.makeupDb,
    ),
  };
}

/** True when the clip has an active compressor (ratio > 1). */
export function hasCompressor(clip: Clip): boolean {
  return (clip.compressor?.ratio ?? 1) > 1;
}

/** Resolved compressor for a clip, or null when inactive. */
export function compressorOf(clip: Clip): CompressorConfig | null {
  if (!hasCompressor(clip)) return null;
  return normalizeCompressor(clip.compressor);
}

/** Value equality for two possibly-undefined compressor configs. */
export function compressorEquals(
  a: CompressorConfig | undefined,
  b: CompressorConfig | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.thresholdDb === b.thresholdDb
    && a.ratio === b.ratio
    && a.attackMs === b.attackMs
    && a.releaseMs === b.releaseMs
    && a.makeupDb === b.makeupDb;
}

/**
 * Merge partial updates onto a clip's current compressor.
 *
 * Returns undefined when the merged ratio is 1 (the deactivation switch), and
 * the exact `current` reference when the merged values equal what the clip
 * already had — `applyClipProperties`'s no-op detection compares clip fields
 * by `===`, so a fresh object with identical values would otherwise open an
 * undo entry for a repeated call.
 */
export function mergeCompressor(
  current: Clip['compressor'],
  update: Partial<CompressorConfig>,
): CompressorConfig | undefined {
  const base = normalizeCompressor(current);
  const pick = (
    value: number | undefined,
    limit: { min: number; max: number },
    fallback: number,
  ): number => (value === undefined ? fallback : clampInRange(value, limit.min, limit.max, fallback));
  const merged: CompressorConfig = {
    thresholdDb: pick(update.thresholdDb, COMPRESSOR_LIMITS.thresholdDb, base.thresholdDb),
    ratio: pick(update.ratio, COMPRESSOR_LIMITS.ratio, base.ratio),
    attackMs: pick(update.attackMs, COMPRESSOR_LIMITS.attackMs, base.attackMs),
    releaseMs: pick(update.releaseMs, COMPRESSOR_LIMITS.releaseMs, base.releaseMs),
    makeupDb: pick(update.makeupDb, COMPRESSOR_LIMITS.makeupDb, base.makeupDb),
  };
  if (merged.ratio <= 1) return undefined;
  if (current && compressorEquals(current as CompressorConfig, merged)) return current as CompressorConfig;
  return merged;
}

/** dBFS to linear amplitude (FFmpeg's threshold/makeup domains). */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * FFmpeg `acompressor` filter fragment (no leading comma). Downward mode is
 * the default and what the preview node does; threshold and makeup are
 * converted to linear amplitude, which is the filter's domain.
 */
export function buildCompressorFilter(config: CompressorConfig): string {
  // FFmpeg rejects a threshold below 0.00097563 (-60.2 dB); -60 dB is inside
  // that bound but format rounding could dip under, so floor it.
  const threshold = Math.max(0.00097563, dbToLinear(config.thresholdDb));
  const makeup = Math.max(1, dbToLinear(config.makeupDb));
  return [
    `acompressor=threshold=${threshold.toFixed(6)}`,
    `ratio=${config.ratio.toFixed(2)}`,
    `attack=${config.attackMs.toFixed(2)}`,
    `release=${config.releaseMs.toFixed(2)}`,
    `makeup=${makeup.toFixed(6)}`,
  ].join(':');
}

/**
 * Web Audio `DynamicsCompressorNode` settings for the preview graph. Attack
 * and release are seconds there; the node's gain reduction is applied in the
 * graph and the makeup gain lives in a dedicated gain node, mirroring the
 * export chain's makeup stage.
 */
export function compressorPreviewParams(config: CompressorConfig): {
  threshold: number;
  ratio: number;
  attackSec: number;
  releaseSec: number;
  kneeDb: number;
  makeupLinear: number;
} {
  return {
    threshold: config.thresholdDb,
    ratio: config.ratio,
    attackSec: config.attackMs / 1000,
    releaseSec: config.releaseMs / 1000,
    kneeDb: COMPRESSOR_PREVIEW_KNEE_DB,
    makeupLinear: dbToLinear(config.makeupDb),
  };
}
