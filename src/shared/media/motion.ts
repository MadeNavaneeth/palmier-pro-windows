/**
 * Position motion tracks (#535 groundwork — keyframes v1).
 *
 * A motion track is a sorted list of {frame, value} keypoints; the value at
 * any frame interpolates linearly between neighbors and clamps outside the
 * ends. Only translation (x/y) ships in v1 because the export graph can
 * express it EXACTLY via overlay's arithmetic x/y expressions — no
 * approximations, so preview and export stay pixel-identical. Scale/rotation
 * keyframes wait on an export-side decision.
 */

export interface MotionPoint {
  frame: number;
  value: number;
}

export type MotionTrack = MotionPoint[];

/** Normalize agent/user input: finite values, sorted, first-frame dedupe. */
export function sanitizeMotion(
  points: Array<{ frame?: number; value?: number }> | undefined | null,
): MotionTrack | undefined {
  if (!Array.isArray(points)) return undefined;
  const clean = points
    .filter(
      (p) =>
        Number.isFinite(p?.frame)
        && Number.isFinite(p?.value),
    )
    .map((p) => ({ frame: Math.round(p.frame as number), value: p.value as number }))
    .sort((a, b) => a.frame - b.frame);
  // Collapse duplicate frames (last wins).
  const deduped: MotionTrack = [];
  for (const point of clean) {
    const last = deduped[deduped.length - 1];
    if (last && last.frame === point.frame) deduped[deduped.length - 1] = point;
    else deduped.push(point);
  }
  return deduped.length >= 2 ? deduped : undefined;
}

/**
 * Value at `frame`: clamps before the first / after the last keypoint,
 * linear between. Returns undefined when the track is absent/empty so
 * callers can fall back to the static clip field.
 */
export function evaluateMotion(
  track: MotionTrack | undefined,
  frame: number,
): number | undefined {
  if (!track || track.length === 0) return undefined;
  if (frame <= track[0]!.frame) return track[0]!.value;
  const last = track[track.length - 1]!;
  if (frame >= last.frame) return last.value;
  for (let i = 1; i < track.length; i++) {
    const b = track[i]!;
    if (frame <= b.frame) {
      const a = track[i - 1]!;
      const t = (frame - a.frame) / (b.frame - a.frame);
      return a.value + (b.value - a.value) * t;
    }
  }
  return last.value;
}

/**
 * Piecewise-linear FFmpeg overlay expression for a motion track, in output
 * seconds. `secPerFrame` converts keypoint frames to the timeline seconds
 * the overlay filter's `t` measures. Exact — no approximation.
 */
export function motionExpression(
  track: MotionTrack | undefined,
  secPerFrame: number,
): string | undefined {
  if (!track || track.length === 0) return undefined;
  const pts = track.map((p) => ({ t: p.frame * secPerFrame, v: p.value }));
  if (pts.length === 1) return pts[0]!.v.toFixed(4);
  // Clamp before/after ends via min/max against the first/last segments.
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const slope = ((b.v - a.v) / (b.t - a.t)).toFixed(6);
    segs.push(`if(lte(t,${b.t.toFixed(6)}),${a.v.toFixed(4)}+${slope}*(t-${a.t.toFixed(6)}),`);
  }
  const inner = `${pts[pts.length - 1]!.v.toFixed(4)}${')'.repeat(segs.length)}`;
  segs.push(inner);
  return segs.join('');
}
