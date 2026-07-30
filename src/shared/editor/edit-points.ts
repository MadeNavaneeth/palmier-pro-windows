/**
 * Edit-point navigation.
 *
 * An edit point is any clip boundary on the timeline. Jumping the playhead
 * between them is how editors move through a cut without scrubbing, and it is
 * the behaviour behind the up/down arrow bindings requested in upstream issue
 * #164 (Premiere / DaVinci Resolve keyboard parity).
 *
 * Pure functions over clip geometry so the navigation rules can be tested
 * without a timeline view.
 */

import type { Frame } from '../types/project';

/** The clip fields edit-point navigation depends on. */
export interface EditPointClip {
  startFrame: Frame;
  durationFrames: Frame;
  trackId: string;
}

/**
 * Every distinct edit point, ascending.
 *
 * The start of the timeline is always an edit point, so navigating backwards
 * from the first clip lands at 0 instead of refusing to move. Clips with a
 * non-finite or negative geometry are ignored rather than poisoning the list.
 *
 * When `trackIds` is given, only those tracks contribute — that is how
 * navigation stays scoped to the tracks a user has targeted.
 */
export function editPoints(
  clips: readonly EditPointClip[],
  trackIds?: ReadonlySet<string>,
): Frame[] {
  const points = new Set<Frame>([0]);

  for (const clip of clips) {
    if (trackIds && !trackIds.has(clip.trackId)) continue;
    if (!Number.isFinite(clip.startFrame) || !Number.isFinite(clip.durationFrames)) continue;
    if (clip.startFrame < 0 || clip.durationFrames <= 0) continue;
    points.add(Math.round(clip.startFrame));
    points.add(Math.round(clip.startFrame + clip.durationFrames));
  }

  return [...points].sort((a, b) => a - b);
}

/**
 * The first edit point after `frame`, or null when the playhead is already at or
 * past the last one.
 */
export function nextEditPoint(
  clips: readonly EditPointClip[],
  frame: Frame,
  trackIds?: ReadonlySet<string>,
): Frame | null {
  if (!Number.isFinite(frame)) return null;
  for (const point of editPoints(clips, trackIds)) {
    if (point > frame) return point;
  }
  return null;
}

/**
 * The last edit point before `frame`, or null when the playhead is already at
 * the start of the timeline.
 */
export function previousEditPoint(
  clips: readonly EditPointClip[],
  frame: Frame,
  trackIds?: ReadonlySet<string>,
): Frame | null {
  if (!Number.isFinite(frame)) return null;
  const points = editPoints(clips, trackIds);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index] < frame) return points[index];
  }
  return null;
}

/**
 * Last frame occupied by any clip — the true end of the edit.
 *
 * Distinct from the timeline's scrollable length, which carries trailing padding
 * so there is room to drop clips past the end. "Go to end" must land on the end
 * of the material, not in that padding.
 */
export function timelineContentEnd(clips: readonly EditPointClip[]): Frame {
  let end = 0;
  for (const clip of clips) {
    if (!Number.isFinite(clip.startFrame) || !Number.isFinite(clip.durationFrames)) continue;
    end = Math.max(end, clip.startFrame + clip.durationFrames);
  }
  return Math.max(0, Math.round(end));
}
