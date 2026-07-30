/**
 * Silence detection + removal planning (upstream feature parity, Palmier Pro #175).
 *
 * Pure, dependency-free logic so it is fully unit-testable and shared between
 * the in-app UI, the AI agent, and the MCP server. Detection runs on an RMS
 * envelope (extracted on-device via FFmpeg in the main process) — no AI or
 * transcription dependency.
 *
 * Pipeline:
 *   1. detectSilentRanges(envelope) -> silent spans in source SECONDS
 *   2. (caller converts seconds -> source frames using project fps)
 *   3. planSilenceRemoval(clip, silentFrameRanges) -> kept segments + ripple delta
 */

import type { Frame } from '../types/project';

export interface SilentRange {
  /** Start of the silent span, in source seconds. */
  startSec: number;
  /** End of the silent span, in source seconds. */
  endSec: number;
}

export interface SilenceConfig {
  /** Below this loudness (dBFS) a sample counts as silent. Typical: -35. */
  thresholdDb: number;
  /** Ignore silent gaps shorter than this (seconds). Typical: 0.5. */
  minSilenceSec: number;
  /** Keep this much padding around speech so transients aren't clipped (seconds). */
  edgePaddingSec: number;
}

export const DEFAULT_SILENCE_CONFIG: SilenceConfig = {
  thresholdDb: -35,
  minSilenceSec: 0.5,
  edgePaddingSec: 0.15,
};

/**
 * Accepted ranges for user- and agent-supplied silence settings
 * (upstream PR #426).
 *
 * The bounds are what makes the controls safe to expose: a minimum pause under
 * a quarter second cuts on natural speech rhythm, and padding above half a
 * second removes so little that the operation looks broken.
 */
export const SILENCE_LIMITS = {
  thresholdDb: { min: -120, max: 0 },
  minSilenceSec: { min: 0.25, max: 3 },
  edgePaddingSec: { min: 0, max: 0.5 },
} as const;

function clampInRange(value: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

/**
 * Coerce untrusted settings into a usable config.
 *
 * Applied at every boundary — the Inspector, the Agent tool, and the MCP
 * socket — so a non-finite or out-of-range value produces a sane edit rather
 * than an envelope scan with a NaN threshold that reports the whole clip silent.
 *
 * @param fallback  Used for any field that is absent or unusable. Defaults to
 *                  the built-in config; pass the user's saved settings to make
 *                  a partial input behave as an override of those.
 */
export function normalizeSilenceConfig(
  input: Partial<SilenceConfig> | undefined,
  fallback: SilenceConfig = DEFAULT_SILENCE_CONFIG,
): SilenceConfig {
  return {
    thresholdDb: clampInRange(input?.thresholdDb, SILENCE_LIMITS.thresholdDb, fallback.thresholdDb),
    minSilenceSec: clampInRange(input?.minSilenceSec, SILENCE_LIMITS.minSilenceSec, fallback.minSilenceSec),
    edgePaddingSec: clampInRange(input?.edgePaddingSec, SILENCE_LIMITS.edgePaddingSec, fallback.edgePaddingSec),
  };
}

/**
 * Settings to run a removal with: the user's saved controls, with any supplied
 * field applied as a one-shot override.
 *
 * This is the contract upstream PR #426 documents for its `remove_silence`
 * tool — omitted arguments follow the current Minimum Pause and Speech Padding
 * controls, and supplied ones override for that call only without rewriting
 * them. Because the Agent and the Inspector both resolve through here, a
 * no-argument agent request produces exactly the edit the visible controls
 * describe, rather than quietly falling back to the built-in defaults.
 *
 * Both layers are normalized, so a corrupt saved value cannot govern a removal.
 * An out-of-range override is clamped into range rather than dropped, which is
 * the last line of defence: the Inspector's sliders cannot express one, and the
 * Agent tool schema refuses one outright with a message.
 */
export function resolveSilenceConfig(
  saved: Partial<SilenceConfig> | undefined,
  overrides: Partial<SilenceConfig> | undefined,
): SilenceConfig {
  return normalizeSilenceConfig(overrides, normalizeSilenceConfig(saved));
}

/**
 * Detect silent ranges from an RMS envelope.
 *
 * @param envelope  RMS amplitude per hop, normalized to [0, 1].
 * @param hopSeconds  Seconds between consecutive envelope samples.
 */
export function detectSilentRanges(
  envelope: number[],
  hopSeconds: number,
  config: SilenceConfig = DEFAULT_SILENCE_CONFIG,
): SilentRange[] {
  if (envelope.length === 0 || hopSeconds <= 0) return [];

  // dBFS -> linear amplitude. -Inf/very-low dB => ~0 threshold.
  const threshold = config.thresholdDb <= -120 ? 0 : Math.pow(10, config.thresholdDb / 20);

  // Silent runs as envelope-sample index pairs, so the padding step below can
  // tell an interior run from one that touches the edge of the material.
  const raw: { startIndex: number; endIndex: number }[] = [];
  let runStart = -1;

  for (let i = 0; i < envelope.length; i++) {
    const isSilent = envelope[i] < threshold;
    if (isSilent && runStart < 0) {
      runStart = i;
    } else if (!isSilent && runStart >= 0) {
      raw.push({ startIndex: runStart, endIndex: i });
      runStart = -1;
    }
  }
  // Close a trailing silent run.
  if (runStart >= 0) {
    raw.push({ startIndex: runStart, endIndex: envelope.length });
  }

  // Filter by minimum duration, then shrink by edge padding.
  const result: SilentRange[] = [];
  for (const range of raw) {
    const startSec = range.startIndex * hopSeconds;
    const endSec = range.endIndex * hopSeconds;
    if (endSec - startSec < config.minSilenceSec) continue;

    // Padding protects a speech transient from being clipped, so it is only
    // applied on a side that actually borders speech. A run reaching the start
    // or end of the material has nothing to protect there and is removed in
    // full — otherwise leading and trailing silence can never be cut away
    // completely, which is what upstream PR #426 fixed.
    const start = startSec + (range.startIndex > 0 ? config.edgePaddingSec : 0);
    const end = endSec - (range.endIndex < envelope.length ? config.edgePaddingSec : 0);

    // After padding the span must still be meaningfully long.
    if (end - start >= Math.min(config.minSilenceSec, 0.05)) {
      result.push({ startSec: start, endSec: end });
    }
  }
  return result;
}

// ─── Removal planning (frame domain) ─────────────────────────────────────────

export interface FrameRange {
  start: Frame; // inclusive, source frame
  end: Frame; // exclusive, source frame
}

export interface KeptSegment {
  /** Source in-point (frame) of a segment to keep. */
  inPoint: Frame;
  /** Source out-point (frame, exclusive) of a segment to keep. */
  outPoint: Frame;
}

export interface SilenceRemovalPlan {
  /** Non-silent source segments, in order. */
  kept: KeptSegment[];
  /** Total source frames removed (the ripple-close amount). */
  removedFrames: Frame;
}

/**
 * Compute the kept (non-silent) segments of a clip's source range after
 * removing the given silent frame ranges, plus the total removed length.
 *
 * @param clipInPoint   The clip's source in-point (frame).
 * @param clipOutPoint  The clip's source out-point (frame, exclusive).
 * @param silentRanges  Silent spans in SOURCE frames (any order, may overlap
 *                      or exceed the clip bounds — they are clamped/merged).
 */
export function planSilenceRemoval(
  clipInPoint: Frame,
  clipOutPoint: Frame,
  silentRanges: FrameRange[],
): SilenceRemovalPlan {
  if (clipOutPoint <= clipInPoint) {
    return { kept: [], removedFrames: 0 };
  }

  // Clamp ranges to the clip and drop empties.
  const clamped = silentRanges
    .map((r) => ({ start: Math.max(clipInPoint, Math.min(r.start, r.end)), end: Math.min(clipOutPoint, Math.max(r.start, r.end)) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  // Merge overlapping/adjacent silent ranges.
  const merged: FrameRange[] = [];
  for (const r of clamped) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  // Kept segments = complement of merged silent ranges within the clip.
  const kept: KeptSegment[] = [];
  let cursor = clipInPoint;
  let removed = 0;
  for (const r of merged) {
    if (r.start > cursor) {
      kept.push({ inPoint: cursor, outPoint: r.start });
    }
    removed += r.end - r.start;
    cursor = r.end;
  }
  if (cursor < clipOutPoint) {
    kept.push({ inPoint: cursor, outPoint: clipOutPoint });
  }

  return { kept, removedFrames: removed };
}
