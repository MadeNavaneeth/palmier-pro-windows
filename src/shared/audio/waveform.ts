/**
 * Waveform peak computation for timeline audio rendering.
 *
 * The main process extracts a full-source RMS envelope (`audio-envelope.ts`)
 * and hands back a fixed number of peak buckets for display. Both steps are
 * pure here so the renderer can also slice a cached full-source curve to a
 * clip's trimmed window without re-decoding.
 */

/**
 * Aggregate an envelope into exactly `buckets` peak values.
 *
 * Each bucket takes the maximum RMS of the hops it covers (peaks survive
 * averaging), values are clamped to [0,1], and an empty envelope yields all
 * zeros rather than NaNs.
 */
export function bucketPeaks(envelope: readonly number[], buckets: number): number[] {
  const count = Math.max(1, Math.floor(buckets));
  if (envelope.length === 0) return new Array(count).fill(0);

  const out: number[] = [];
  for (let b = 0; b < count; b += 1) {
    const start = Math.floor((b * envelope.length) / count);
    const end = Math.max(start + 1, Math.floor(((b + 1) * envelope.length) / count));
    let peak = 0;
    for (let i = start; i < end && i < envelope.length; i += 1) {
      const v = Math.min(1, Math.max(0, envelope[i]));
      if (v > peak) peak = v;
    }
    out.push(peak);
  }
  return out;
}

/**
 * Slice a full-source peak curve to a clip's trimmed window.
 *
 * `startRatio`/`endRatio` are the clip's In/Out as a fraction of source
 * length ([0,1], end > start); the returned array always has exactly
 * `buckets` entries, resampled when the window is narrower than the target
 * resolution so narrow clips still render their shape.
 */
export function slicePeaks(
  peaks: readonly number[],
  startRatio: number,
  endRatio: number,
  buckets: number,
): number[] {
  const clampedStart = Math.min(1, Math.max(0, startRatio));
  const clampedEnd = Math.min(1, Math.max(clampedStart, endRatio));
  const count = Math.max(1, Math.floor(buckets));
  if (peaks.length === 0) return new Array(count).fill(0);

  const out: number[] = [];
  for (let b = 0; b < count; b += 1) {
    const t = count === 1 ? 0 : b / (count - 1);
    const pos = (clampedStart + t * (clampedEnd - clampedStart)) * (peaks.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(peaks.length - 1, lo + 1);
    const frac = pos - lo;
    out.push(peaks[lo] * (1 - frac) + peaks[hi] * frac);
  }
  return out;
}
