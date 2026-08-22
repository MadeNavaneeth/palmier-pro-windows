/**
 * Timeline clip hit-testing (upstream PR #488).
 *
 * At low zoom the trim-edge zones are wider than the clip itself: on a clip
 * rendered 4–11 px wide the two 6 px trim zones overlap and cover the whole
 * body, so every click trims and the clip can never be grabbed to move — with
 * linked A/V that also makes bulk selection-by-drag impossible. The rule
 * upstream adopted is that precision affordances turn off below a minimum
 * width so the body stays a move surface; trimming a clip that narrow is done
 * by zooming in, which is also how the user can see what they are trimming to.
 */

/** Trim-zone half-width in pixels on each side of a clip. */
export const TRIM_HANDLE_WIDTH = 6;

/** Below this rendered width the clip body is move-only. */
export const MIN_PRECISION_CLIP_WIDTH = 16;

export type ClipHitZone = 'trim-left' | 'trim-right' | 'body';

/**
 * Which interaction a click at `localX` inside a clip of `clipWidth` pixels
 * starts. Narrow clips always report `body`.
 */
export function resolveClipHitZone(localX: number, clipWidth: number): ClipHitZone {
  if (clipWidth < MIN_PRECISION_CLIP_WIDTH) return 'body';
  if (localX <= TRIM_HANDLE_WIDTH) return 'trim-left';
  if (localX >= clipWidth - TRIM_HANDLE_WIDTH) return 'trim-right';
  return 'body';
}

/** Whether the visual trim handles should render for this clip width. */
export function showsTrimHandles(clipWidth: number): boolean {
  return clipWidth >= MIN_PRECISION_CLIP_WIDTH;
}
