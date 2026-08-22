/**
 * Filmstrip layout math for timeline video thumbnails.
 *
 * A strip is `count` evenly spaced sample times across the FULL source; a
 * clipped trim window shows only the samples inside it, positioned
 * proportionally so the visible strip tracks trimming exactly like the
 * audio waveform slices do.
 */

export interface FilmstripSlot {
  /** Sample index within the full-source strip (0-based). */
  index: number;
  /** Left edge as a fraction of the rendered clip width, [0,1). */
  leftRatio: number;
}

/**
 * Which strip samples fall inside `[startSec, endSec)` of the source, with
 * their proportional left positions. Samples are centered in their slot
 * (`(i + 0.5) / count`) so a full-length window yields symmetric coverage.
 */
export function filmstripLayout(
  count: number,
  totalSeconds: number,
  startSec: number,
  endSec: number,
): FilmstripSlot[] {
  const slots: FilmstripSlot[] = [];
  if (count <= 0 || !(totalSeconds > 0)) return slots;
  const clampedStart = Math.max(0, Math.min(startSec, totalSeconds));
  const clampedEnd = Math.max(clampedStart, Math.min(endSec, totalSeconds));
  const span = clampedEnd - clampedStart;
  if (span <= 0) return slots;

  for (let i = 0; i < count; i += 1) {
    const t = ((i + 0.5) / count) * totalSeconds;
    if (t < clampedStart || t >= clampedEnd) continue;
    slots.push({ index: i, leftRatio: (t - clampedStart) / span });
  }
  return slots;
}
