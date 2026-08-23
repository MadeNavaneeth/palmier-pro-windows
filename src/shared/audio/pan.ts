/**
 * Stereo balance-style pan (roadmap R5).
 *
 * A pan value of -1 attenuates the right channel (hard left), +1 attenuates
 * the left (hard right), 0 leaves both untouched. This balance model is what
 * NLEs apply to stereo clip audio -- it never changes perceived level of the
 * dominant channel and needs no equal-power crossfade on stereo material.
 */

export interface StereoGains {
  left: number;
  right: number;
}

/** Clamp to [-1, 1]; garbage falls back to center. */
export function clampPan(pan: number): number {
  return Number.isFinite(pan) ? Math.min(1, Math.max(-1, pan)) : 0;
}

export function stereoBalanceGains(pan: number): StereoGains {
  const p = clampPan(pan);
  return { left: 1 - Math.max(0, p), right: 1 + Math.min(0, p) };
}

/** FFmpeg pan filter string; identity at center (callers can skip it then). */
export function ffmpegPanFilter(pan: number): string {
  const { left, right } = stereoBalanceGains(pan);
  const f4 = (v: number) => v.toFixed(4);
  return `pan=stereo|c0=c0*${f4(left)}|c1=c1*${f4(right)}`;
}
