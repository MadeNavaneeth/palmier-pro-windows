/**
 * Opacity-track editing rules for the Inspector keyframe rows.
 *
 * `Clip.opacityTrack` is a `MotionTrack` (absolute timeline frames, values
 * 0..1) that the preview and the media exporter already evaluate. The only
 * sanctioned writer is `EditorController.setClipOpacityTrack`, which narrows
 * through the shared `sanitizeMotion` and therefore refuses anything shorter
 * than two points — and reports a no-op without touching history. That refusal
 * is invisible in the UI unless the edits are prepared first, so the point
 * arithmetic (insert, remove, clear, easing) lives here as pure functions that
 * the component submits verbatim.
 *
 * This is the opacity animation track only. Fades (`fadeInFrames` /
 * `fadeOutFrames`) are a separate, pre-existing concept and are deliberately
 * not folded into anything here.
 */

import {
  evaluateMotion,
  type MotionEasing,
  type MotionTrack,
} from '../../shared/media/motion';

/** Shortest track the controller will accept, from the shared sanitizer. */
export const OPACITY_TRACK_MIN_POINTS = 2;

/** Whether a clip carries an opacity animation track at all. */
export function hasOpacityTrack(track: MotionTrack | undefined): boolean {
  return Array.isArray(track) && track.length > 0;
}

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Chip-ready percentage for one keyframe value. */
export function opacityPercent(value: number): number {
  return Math.round(clampOpacity(value) * 100);
}

/**
 * The points to submit when the user adds or moves a keyframe at `frame`.
 *
 * The captured value is the track's current value there (falling back to the
 * clip's static opacity), so repeated adds across a fade trace the curve. A
 * point already on that frame is replaced, never duplicated.
 *
 * With no track yet, this seeds the two points the controller requires: one at
 * the playhead and one a second later at the same value, so the first add
 * always produces a valid flat track the user can then shape.
 */
export function nextOpacityTrack(
  track: MotionTrack | undefined,
  frame: number,
  staticValue: number,
  fps: number,
): MotionTrack {
  const value = Math.round(clampOpacity(evaluateMotion(track, frame) ?? staticValue) * 100) / 100;
  const point = { frame, value };
  if (!hasOpacityTrack(track)) {
    const second = Math.max(1, Math.round(fps));
    return [{ ...point }, { frame: frame + second, value }];
  }
  const points = track!.filter((existing) => existing.frame !== frame);
  return [...points, point].sort((a, b) => a.frame - b.frame);
}

/**
 * The points to submit when a keyframe chip is removed.
 *
 * Returns `undefined` to mean "clear the track": a one-point track is not a
 * valid opacity track, so removing down to two points clears rather than
 * stranding an unusable single keyframe. Callers pass the result straight to
 * `setClipOpacityTrack` (an empty array clears).
 */
export function removeOpacityKeyframe(
  track: MotionTrack | undefined,
  frame: number,
): MotionTrack | undefined {
  if (!hasOpacityTrack(track)) return undefined;
  const remaining = track!.filter((point) => point.frame !== frame);
  if (remaining.length < OPACITY_TRACK_MIN_POINTS) return undefined;
  return remaining;
}

/**
 * Apply an easing to every segment start (all points but the last), matching
 * how the shared evaluator reads easing and how the existing motion/volume
 * rows edit it. `linear` drops the field so an eased track reads back as
 * unspecialized.
 */
export function withOpacityEasing(
  track: MotionTrack | undefined,
  easing: MotionEasing,
): MotionTrack | undefined {
  if (!hasOpacityTrack(track)) return undefined;
  return track!.map((point, index) => {
    if (index === track!.length - 1) return { ...point };
    if (easing === 'linear') {
      // Drop the key rather than writing undefined, so an unspecialized track
      // reads back exactly like one that was never eased.
      const next = { ...point };
      delete next.easing;
      return next;
    }
    return { ...point, easing };
  });
}
