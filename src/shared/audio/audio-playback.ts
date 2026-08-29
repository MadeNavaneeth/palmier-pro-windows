/**
 * Which audio sources should be audible at a given playhead — the pure core
 * of preview audio playback (R2/R5 groundwork).
 *
 * A clip contributes when it is an audio clip, unmuted, on an audible
 * (non-muted) track, its source file is online, and the playhead sits inside
 * its span. The returned offset is the position IN THE SOURCE FILE the
 * element should be at, in seconds.
 */

import type { Clip, Frame, MediaAsset } from '../types/project';
import { clampPan } from './pan';
import { resolveClipVolumeLinear } from './volume-keyframes';

export interface AudioPlanInput {
  clips: readonly Clip[];
  tracks: readonly { id: string; visible: boolean; soloed?: boolean }[];
  assets: readonly Pick<MediaAsset, 'id' | 'path'>[];
  /** Asset paths known to be missing on disk. */
  offlinePaths?: ReadonlySet<string>;
  playbackRate: number;
  playhead: Frame;
  fps: number;
}

export interface AudioPlaybackEntry {
  /** Source file path — the pool key for HTMLMediaElements. */
  path: string;
  /** Where in the source the element's currentTime belongs, seconds. */
  sourceTimeSec: number;
  /**
   * Linear gain. [0,1] from the static field; a positive-dB volumeDb
   * keyframe can resolve above 1 (#535/#539-#541) — callers must apply
   * gain > 1 through a Web Audio gain stage, not `HTMLMediaElement.volume`,
   * which throws outside [0,1].
   */
  volume: number;
  /** Stereo balance, -1 left … +1 right (R5). */
  pan: number;
}

/**
 * Reverse playback and shuttle rates are silent, matching NLE convention
 * (upstream mutes audio whenever |rate| != 1 as well).
 */
export function computeAudioPlan(input: AudioPlanInput): AudioPlaybackEntry[] {
  if (Math.abs(input.playbackRate) !== 1) return [];

  const anySoloed = input.tracks.some((t) => t.soloed);
  const trackById = new Map(input.tracks.map((t) => [t.id, t]));
  const assetPathById = new Map(input.assets.map((a) => [a.id, a.path]));
  const offline = input.offlinePaths;
  const entries: AudioPlaybackEntry[] = [];

  for (const clip of input.clips) {
    if (clip.type !== 'audio' || clip.muted) continue;
    const track = trackById.get(clip.trackId);
    if (!track || track.visible === false) continue;
    // Solo filter: when any track is soloed, only soloed tracks play.
    if (anySoloed && !track.soloed) continue;

    const end = clip.startFrame + clip.durationFrames;
    if (input.playhead < clip.startFrame || input.playhead >= end) continue;

    const path = assetPathById.get(clip.assetId);
    if (!path) continue;
    if (offline?.has(path)) continue;

    const sourceTimeSec =
      clip.inPoint / input.fps + (input.playhead - clip.startFrame) / input.fps;

    entries.push({
      path,
      sourceTimeSec,
      // An active volumeDb track (#535/#539-#541) is authoritative over the
      // static linear field. A positive-dB boost keyframe resolves above 1 —
      // deliberately not re-clamped here; the consumer (audio-preview.ts)
      // applies gain > 1 through a Web Audio GainNode rather than the
      // [0,1]-only HTMLMediaElement.volume.
      volume: resolveClipVolumeLinear(clip, input.playhead),
      pan: clampPan(clip.pan ?? 0),
    });
  }
  return entries;
}
