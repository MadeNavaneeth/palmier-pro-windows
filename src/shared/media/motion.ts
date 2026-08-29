/**
 * Position motion tracks (#535 groundwork — keyframes v1.5 with easing).
 *
 * A motion track is a sorted list of {frame, value, easing?} keypoints; the
 * value at any frame interpolates between neighbors using the easing of the
 * segment's START point (default linear) and clamps outside the ends.
 * Translation only: the export graph expresses these curves EXACTLY via
 * overlay arithmetic expressions (`if`/`pow`), so preview and export stay
 * pixel-identical. Scale/rotation keyframes wait on an export-side decision.
 */

export type MotionEasing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

const EASINGS: ReadonlySet<MotionEasing> = new Set([
  'linear', 'easeIn', 'easeOut', 'easeInOut',
]);

export interface MotionPoint {
  frame: number;
  value: number;
  /** Easing of the segment starting at this point. Default linear. */
  easing?: MotionEasing;
}

export type MotionTrack = MotionPoint[];

/** Normalized easing: anything unrecognized/absent is linear. */
export function normalizeEasing(easing: unknown): MotionEasing {
  return typeof easing === 'string' && EASINGS.has(easing as MotionEasing)
    ? (easing as MotionEasing)
    : 'linear';
}

/** Eased progress for normalized time u ∈ [0,1]. */
function easeValue(u: number, easing: MotionEasing): number {
  switch (easing) {
    case 'easeIn': return u * u;
    case 'easeOut': return 1 - (1 - u) * (1 - u);
    case 'easeInOut':
      return u < 0.5
        ? 2 * u * u
        : 1 - Math.pow(-2 * u + 2, 2) / 2;
    default: return u;
  }
}

/** Normalize agent/user input: finite values, sorted, first-frame dedupe. */
export function sanitizeMotion(
  points: Array<{ frame?: number; value?: number; easing?: unknown }> | undefined | null,
): MotionTrack | undefined {
  if (!Array.isArray(points)) return undefined;
  const clean = points
    .filter(
      (p) =>
        Number.isFinite(p?.frame)
        && Number.isFinite(p?.value),
    )
    .map((p) => ({
      frame: Math.round(p.frame as number),
      value: p.value as number,
      ...(normalizeEasing(p.easing) !== 'linear'
        ? { easing: normalizeEasing(p.easing) }
        : {}),
    }))
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
 * eased per segment. Returns undefined when the track is absent/empty so
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
      const u = (frame - a.frame) / (b.frame - a.frame);
      const eased = easeValue(u, normalizeEasing(a.easing));
      return a.value + (b.value - a.value) * eased;
    }
  }
  return last.value;
}

/**
 * Piecewise FFmpeg expression for a motion track, over a caller-chosen time
 * variable (`timeVar`, default `t`) in seconds. `secPerFrame` converts
 * keypoint frames to those seconds. Each segment emits its eased curve via
 * `if`/`pow` over normalized time — exact, matching evaluateMotion.
 *
 * `timeVar` lets a caller reuse this for a filter whose time variable is not
 * literally named `t` after a shift (e.g. an audio chain's `t` already
 * starts at a clip's trimmed source point, so the caller substitutes
 * `(t)+offset` to express the same absolute-timeline frames the track is
 * keyed to).
 */
export function motionExpression(
  track: MotionTrack | undefined,
  secPerFrame: number,
  timeVar = 't',
): string | undefined {
  if (!track || track.length === 0) return undefined;
  if (track.length === 1) return track[0]!.value.toFixed(4);

  // easedExpr(easing, aSec, bSec): value formula over absolute time for one
  // segment, with normalized time n = (time-a)/(b-a).
  const easedExpr = (easing: MotionEasing, aSec: number, bSec: number, v0: string, dv: string): string => {
    const n = `((${timeVar})-(${aSec.toFixed(6)}))/((${bSec.toFixed(6)})-(${aSec.toFixed(6)}))`;
    switch (easing) {
      case 'easeIn':
        return `${v0}+${dv}*pow(${n},2)`;
      case 'easeOut':
        return `${v0}+${dv}*(1-pow(1-${n},2))`;
      case 'easeInOut':
        return `${v0}+${dv}*if(lte(${n},0.5),2*pow(${n},2),1-pow(-2*${n}+2,2)/2)`;
      default:
        return `${v0}+${dv}*${n}`;
    }
  };

  // Clamp before/after ends via nested ifs against segment end times.
  const parts: string[] = [];
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1]!;
    const b = track[i]!;
    const aSec = a.frame * secPerFrame;
    const bSec = b.frame * secPerFrame;
    const easing = normalizeEasing(a.easing);
    const v0 = a.value.toFixed(4);
    const dv = (b.value - a.value).toFixed(6);
    parts.push(`if(lte(${timeVar},${bSec.toFixed(6)}),${easedExpr(easing, aSec, bSec, v0, dv)},`);
  }
  const inner = `${track[track.length - 1]!.value.toFixed(4)}${')'.repeat(parts.length)}`;
  parts.push(inner);
  return parts.join('');
}
