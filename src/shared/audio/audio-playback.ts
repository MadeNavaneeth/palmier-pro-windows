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

export interface AudioPlanInput {
  clips: readonly Clip[];
  tracks: readonly { id: string; visible: boolean }[];
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
  volume: number;
}

/**
 * Reverse playback and shuttle rates are silent, matching NLE convention
 * (upstream mutes audio whenever |rate| != 1 as well).
 */
export function computeAudioPlan(input: AudioPlanInput): AudioPlaybackEntry[] {
  if (Math.abs(input.playbackRate) !== 1) return [];

  const trackById = new Map(input.tracks.map((t) => [t.id, t]));
  const assetPathById = new Map(input.assets.map((a) => [a.id, a.path]));
  const offline = input.offlinePaths;
  const entries: AudioPlaybackEntry[] = [];

  for (const clip of input.clips) {
    if (clip.type !== 'audio' || clip.muted) continue;
    const track = trackById.get(clip.trackId);
    if (!track || track.visible === false) continue;

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
      volume: Math.min(1, Math.max(0, Number.isFinite(clip.volume) ? clip.volume : 1)),
    });
  }
  return entries;
}
