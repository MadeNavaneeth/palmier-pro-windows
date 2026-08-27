/**
 * Export clip eligibility — the single rule deciding which timeline clips an
 * export build consumes (upstream PR #544).
 *
 * Upstream's defect was a muted audio lane still entering the composition
 * graph, muted only downstream by a zero-gain mix, which stalled the exporter.
 * The invariant that fixes it and keeps preview and export agreeing is:
 * muting is a build-time exclusion, not a gain of zero. Here a track's
 * `visible === false` means "muted" on audio tracks (the header toggle), and a
 * clip can additionally be muted individually; either one removes the clip's
 * audio from the export inputs entirely. Video clips are unaffected by the
 * per-clip mute flag because it is an audio property.
 */

import type { Clip, Project } from '../types/project';

/** True when this clip's audio must not enter the exported mix. */
export function isMutedAudioClip(clip: Clip): boolean {
  return clip.type === 'audio' && clip.muted;
}

/**
 * The clips an export build consumes: nothing on a hidden (or audio-muted)
 * track, and no individually muted audio clip. Both the frame-extent
 * calculation and the FFmpeg argument builder must read this one list so the
 * reported duration and the rendered output can never disagree about what is
 * in the export.
 */
export function selectExportClips(project: Project): Clip[] {
  // Solo filter: when any track is soloed, only soloed tracks are active.
  const anySoloed = project.timeline.tracks.some((t) => t.soloed);
  const visibleTrackIds = anySoloed
    ? new Set(project.timeline.tracks.filter((t) => t.soloed && t.visible !== false).map((t) => t.id))
    : new Set(project.timeline.tracks.filter((t) => t.visible !== false).map((t) => t.id));
  return project.timeline.clips.filter(
    (clip) => visibleTrackIds.has(clip.trackId) && !isMutedAudioClip(clip),
  );
}
