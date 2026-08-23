/**
 * Timeline frames to source media time.
 *
 * The one place that converts between the project's frame space and a source
 * file's own time. Preview and export both go through it so they cannot drift
 * (upstream issue #68: "export hangs on deep seeks into 60 fps 4K sources in a
 * 30 fps timeline").
 *
 * The invariant this module exists to protect:
 *
 *   Every frame-valued field in the project — `startFrame`, `durationFrames`,
 *   `inPoint`, `outPoint`, and `MediaAsset.duration` — is expressed in PROJECT
 *   frames, because media is converted at import (`duration seconds x project
 *   fps`). They therefore convert to seconds with the PROJECT frame rate.
 *   `MediaAsset.fps` is the source's own rate and matters only when addressing
 *   an individual decoded frame in the source's timebase.
 *
 * Dividing a project-frame offset by the source frame rate is the specific bug
 * this replaces: with a 60 fps source in a 30 fps timeline it seeked to half the
 * intended time, and with a 24 fps source it overshot by 1.25x — far past the
 * end of a long clip, where each request became a full-file scan that ran until
 * the decode timeout and looked like a hang.
 */

import type { Clip, Frame, MediaAsset } from '../types/project';

/** The subset of a clip needed to map timeline time onto its source. */
export interface ClipSourceWindow {
  /** Clip position on the timeline, in project frames. */
  startFrame: Frame;
  /** Source trim in point, in project frames. */
  inPoint: Frame;
  /** Source trim out point, in project frames. */
  outPoint: Frame;
  /** Visible duration on the timeline, in project frames. */
  durationFrames: Frame;
  /**
   * Constant playback speed (R4 groundwork): source time advances this many
   * frames per timeline frame. Undefined means 1.
   */
  speed?: number;
}

/** Defensive speed resolution: undefined/garbage falls back to normal. */
export function effectiveSpeed(speed: number | undefined): number {
  return typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : 1;
}export function clipSourceWindow(clip: Clip): ClipSourceWindow {
  return {
    startFrame: clip.startFrame,
    inPoint: clip.inPoint,
    outPoint: clip.outPoint,
    durationFrames: clip.durationFrames,
  };
}

function usableRate(fps: number | undefined): number {
  return typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : 0;
}

/** Project frames to seconds. Returns 0 for an unusable frame rate or frame. */
export function projectFramesToSeconds(frames: Frame, projectFps: number): number {
  const rate = usableRate(projectFps);
  if (rate === 0 || !Number.isFinite(frames)) return 0;
  return frames / rate;
}

/** Seconds to project frames, rounded to the nearest frame. */
export function secondsToProjectFrames(seconds: number, projectFps: number): Frame {
  const rate = usableRate(projectFps);
  if (rate === 0 || !Number.isFinite(seconds)) return 0;
  return Math.round(seconds * rate);
}

/**
 * Offset into the source file, in seconds, for a timeline frame.
 *
 * The result is not clamped to the clip: callers that composite only visible
 * clips already know the frame is inside, and export needs the raw mapping.
 */
export function sourceSecondsForTimelineFrame(
  clip: ClipSourceWindow,
  timelineFrame: Frame,
  projectFps: number,
): number {
  if (!Number.isFinite(timelineFrame)) return 0;
  const speed = effectiveSpeed(clip.speed);
  const sourceOffset = clip.inPoint + (timelineFrame - clip.startFrame) * speed;
  return Math.max(0, projectFramesToSeconds(sourceOffset, projectFps));
}

/**
 * The clip's trim window in source seconds.
 *
 * `outPoint` is trusted only when it is after `inPoint`; older projects and
 * agent edits can leave it stale, in which case the visible duration defines the
 * window. Without this an inverted window would produce an empty FFmpeg `trim`
 * range and a silently blank clip in the export.
 */
export function clipTrimSeconds(
  clip: ClipSourceWindow,
  projectFps: number,
): { start: number; end: number } {
  const speed = effectiveSpeed(clip.speed);
  const start = Math.max(0, projectFramesToSeconds(clip.inPoint, projectFps));
  // The consumed source span scales with speed; outPoint is trusted when it
  // already encodes that span (set by setClipSpeed), otherwise the visible
  // duration at normal speed is the fallback for legacy/stale projects.
  const outPointSeconds = projectFramesToSeconds(clip.outPoint, projectFps);
  const durationSeconds = projectFramesToSeconds(clip.durationFrames * speed, projectFps);
  const end = outPointSeconds > start ? outPointSeconds : start + durationSeconds;
  return { start, end };
}

/** Playable length of an asset in seconds (its duration is in project frames). */
export function assetDurationSeconds(
  asset: Pick<MediaAsset, 'duration'>,
  projectFps: number,
): number {
  return Math.max(0, projectFramesToSeconds(asset.duration, projectFps));
}

/**
 * True when a source seek lands inside readable media.
 *
 * A duration of 0 means "unknown or a still image", where any non-negative seek
 * is allowed. Callers use this to skip a decode outright: attempting to read
 * past the end of a large source is what turns a bad seek into a stall, because
 * the decoder scans the file before giving up.
 */
export function isSourceSeekable(seconds: number, durationSeconds: number): boolean {
  if (!Number.isFinite(seconds) || seconds < 0) return false;
  if (durationSeconds <= 0) return true;
  return seconds < durationSeconds;
}

/**
 * Clamp a source seek to the last readable instant.
 *
 * Seeking exactly at the duration yields no frame, so the clamp lands one source
 * frame short when the source rate is known.
 */
export function clampSourceSeconds(
  seconds: number,
  durationSeconds: number,
  sourceFps?: number,
): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  if (durationSeconds <= 0) return seconds;
  const rate = usableRate(sourceFps);
  const lastReadable = rate > 0
    ? Math.max(0, durationSeconds - 1 / rate)
    : Math.max(0, durationSeconds - 0.001);
  return Math.min(seconds, lastReadable);
}

/**
 * Frame index in the source's own timebase for a source offset in seconds.
 *
 * Used to address a specific decoded frame; falls back to millisecond
 * addressing when the source rate is unknown so distinct times stay distinct.
 */
export function sourceFrameForSeconds(seconds: number, sourceFps?: number): Frame {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  const rate = usableRate(sourceFps);
  return rate > 0 ? Math.round(seconds * rate) : Math.round(seconds * 1000);
}
