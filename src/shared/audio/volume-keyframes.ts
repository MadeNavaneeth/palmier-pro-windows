/**
 * Volume keyframes (upstream PRs #535/#539-#541's audio-automation slice).
 *
 * A per-clip dB automation track on audio clips, sharing the exact point
 * shape, sanitize, and evaluate/expression machinery as position/scale/
 * rotation motion tracks (shared/media/motion.ts) — one keyframe engine,
 * several units. Values are absolute decibels, matching upstream's
 * `volumeDb` Agent/MCP contract (0 dB = source level, -60 dB = mute floor,
 * +15 dB = boost ceiling) rather than a linear 0-1 multiplier, so a fade
 * from -6 dB to -60 dB reads the way a mixer fader would.
 *
 * An active track is authoritative over the static `clip.volume` linear
 * field, matching upstream's fix for the "first keyframe jumps the level"
 * defect (PR #522): sampling always starts from the track once one exists.
 */

import type { MotionEasing, MotionPoint, MotionTrack } from '../media/motion';
import { evaluateMotion, motionExpression, sanitizeMotion } from '../media/motion';
import { dbToLinear } from './normalize';
import type { Clip } from '../types/project';

/** Mute floor, matching upstream's VolumeScale. Below this reads as silence. */
export const VOLUME_DB_FLOOR = -60;
/** Boost ceiling, matching upstream's VolumeScale. */
export const VOLUME_DB_CEILING = 15;

export type VolumeKeyframe = MotionPoint;
export type VolumeTrack = MotionTrack;

/** Clamp a dB value into the supported range; non-finite input floors to mute. */
export function clampVolumeDb(db: number): number {
  if (!Number.isFinite(db)) return VOLUME_DB_FLOOR;
  return Math.min(VOLUME_DB_CEILING, Math.max(VOLUME_DB_FLOOR, db));
}

/**
 * Normalize agent/user input into a valid volume track: reuses motion's
 * frame/easing sanitation, then clamps every value into the dB range so an
 * out-of-range point cannot reach storage (validated at the tool boundary
 * too — this is the shared floor for any other caller).
 */
export function sanitizeVolumeKeyframes(
  points: Array<{ frame?: number; value?: number; easing?: unknown }> | undefined | null,
): VolumeTrack | undefined {
  const track = sanitizeMotion(points);
  if (!track) return undefined;
  return track.map((point) => ({ ...point, value: clampVolumeDb(point.value) }));
}

/**
 * Linear gain multiplier for a clip at an absolute timeline frame: the
 * active volumeDb track when present (converted dB→linear), else the
 * static `clip.volume` linear field. Frames are absolute-timeline, exactly
 * like motionX/motionRot — a keyframe is not rebased when the clip moves.
 */
export function resolveClipVolumeLinear(clip: Clip, frame: number): number {
  const db = evaluateMotion(clip.volumeDb, frame);
  if (db !== undefined) return dbToLinear(db);
  return Number.isFinite(clip.volume) ? Math.min(1, Math.max(0, clip.volume)) : 1;
}

/**
 * FFmpeg audio `volume` filter value expressing the dB track as linear gain
 * over the filter's own local time variable, or undefined when no track is
 * active (caller falls back to a static `volume=N`).
 *
 * The audio chain trims to the clip's source window and resets PTS, so its
 * `t` is seconds since that trim point — not the timeline's absolute frame
 * count the track is keyed to. `frameAtLocalZero` is the absolute timeline
 * frame that local `t=0` corresponds to (the clip's `startFrame`), so the
 * substitution `(t)+frameAtLocalZero*secPerFrame` maps local seconds back
 * onto the same absolute-second axis motionExpression's segments use.
 */
export function volumeFilterExpression(
  track: VolumeTrack | undefined,
  fps: number,
  frameAtLocalZero: number,
): string | undefined {
  if (!track || track.length === 0) return undefined;
  const secPerFrame = 1 / fps;
  const shiftSec = frameAtLocalZero * secPerFrame;
  const timeVar = shiftSec !== 0 ? `(t)+(${shiftSec.toFixed(6)})` : 't';
  const dbExpr = motionExpression(track, secPerFrame, timeVar);
  if (dbExpr === undefined) return undefined;
  return `pow(10,(${dbExpr})/20)`;
}

export type { MotionEasing };
