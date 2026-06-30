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
  edgePaddingSec: 0.1,
};

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

  const raw: SilentRange[] = [];
  let runStart = -1;

  for (let i = 0; i < envelope.length; i++) {
    const isSilent = envelope[i] < threshold;
    if (isSilent && runStart < 0) {
      runStart = i;
    } else if (!isSilent && runStart >= 0) {
      raw.push({ startSec: runStart * hopSeconds, endSec: i * hopSeconds });
      runStart = -1;
    }
  }
  // Close a trailing silent run.
  if (runStart >= 0) {
    raw.push({ startSec: runStart * hopSeconds, endSec: envelope.length * hopSeconds });
  }

  // Filter by minimum duration, then shrink by edge padding.
  const result: SilentRange[] = [];
  for (const range of raw) {
    const duration = range.endSec - range.startSec;
    if (duration < config.minSilenceSec) continue;

    const start = range.startSec + config.edgePaddingSec;
    const end = range.endSec - config.edgePaddingSec;
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
