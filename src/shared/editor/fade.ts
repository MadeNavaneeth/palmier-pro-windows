/**
 * Transition fade math (pure, shared by preview and export).
 *
 * A fade-in ramps a clip's effective opacity 0→1 over its first `fadeInFrames`;
 * a fade-out ramps 1→0 over its last `fadeOutFrames`. The result multiplies the
 * clip's base opacity, so fades route through the compositor's existing
 * per-layer opacity (no shader changes) and through FFmpeg's `fade` filter on
 * export — keeping preview and export pixel-consistent.
 */

import type { Clip, Frame } from '../types/project';

/**
 * The fade opacity multiplier (0–1) for a clip at a given TIMELINE frame.
 * Does not include the clip's base opacity.
 */
export function fadeMultiplier(clip: Clip, timelineFrame: Frame): number {
  const duration = clip.durationFrames;
  if (duration <= 0) return 1;

  const local = timelineFrame - clip.startFrame;
  if (local < 0 || local >= duration) return 0; // outside the clip

  let mult = 1;

  const fadeIn = clip.fadeInFrames ?? 0;
  if (fadeIn > 0 && local < fadeIn) {
    // local 0 -> ~0, local (fadeIn-1) -> near 1. Use +1 so the last fade frame
    // is fully (or nearly) opaque and frame 0 is fully transparent.
    mult = Math.min(mult, local / fadeIn);
  }

  const fadeOut = clip.fadeOutFrames ?? 0;
  if (fadeOut > 0) {
    const fadeOutStart = duration - fadeOut;
    if (local >= fadeOutStart) {
      const remaining = duration - local; // counts down to 0 at the last frame
      mult = Math.min(mult, remaining / fadeOut);
    }
  }

  return Math.max(0, Math.min(1, mult));
}

/**
 * A clip's effective opacity at a timeline frame: base opacity × fade ramp.
 */
export function effectiveOpacity(clip: Clip, timelineFrame: Frame): number {
  return clip.opacity * fadeMultiplier(clip, timelineFrame);
}
