/**
 * Visible-layer resolution for the preview compositor (#556).
 *
 * This runs on EVERY composite and prefetch request, so its cost is paid at
 * playback start and every frame after. The naive form scanned the track
 * list once per clip in the filter and TWICE per sort comparison -- O(clips x
 * tracks) work that scales with track count even when those tracks are empty,
 * which is exactly the sparse-timeline first-paint stall upstream reports.
 * Here the track index is built once per call and ordering keys are resolved
 * before sorting, making a frame's resolution O(clips + tracks).
 */

import type { Clip, Project, Frame } from '../../shared/types/project';

export function visualClipsAtFrame(project: Project, frameIndex: Frame): Clip[] {
  const trackById = new Map(
    project.timeline.tracks.map((track) => [track.id, track] as const),
  );

  // Solo filter: when any track is soloed, only soloed tracks are active.
  const anySoloed = project.timeline.tracks.some((t) => t.soloed);
  const activeTrackIds = anySoloed
    ? new Set(project.timeline.tracks.filter((t) => t.soloed && t.visible !== false).map((t) => t.id))
    : null; // null = no solo, all visible tracks active

  const decorated: Array<{ clip: Clip; order: number }> = [];
  for (const clip of project.timeline.clips) {
    if (clip.type === 'audio') continue;
    const track = trackById.get(clip.trackId);
    if (!track || track.visible === false) continue;
    if (activeTrackIds && !activeTrackIds.has(track.id)) continue;
    const clipEnd = clip.startFrame + clip.durationFrames;
    if (frameIndex < clip.startFrame || frameIndex >= clipEnd) continue;
    decorated.push({ clip, order: track.order });
  }

  // Same layering rule as before: higher track order renders on top.
  decorated.sort((a, b) => a.order - b.order);
  return decorated.map((entry) => entry.clip);
}
