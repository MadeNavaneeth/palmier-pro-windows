/**
 * Offline media — which project assets no longer resolve on disk (R0/R1
 * "media-offline state"). The existence check itself must run in the main
 * process; this module keeps the classification pure so both the exporter's
 * pre-flight refusal and the timeline's offline visuals share one definition.
 */

import type { MediaAsset, Project } from '../types/project';

export type PathExists = (path: string) => boolean;

/** Assets whose source file is missing. Images count too. */
export function findOfflineAssets(
  project: Project,
  exists: PathExists,
): MediaAsset[] {
  return project.media.filter((asset) => !exists(asset.path));
}

/**
 * The exporter refuses to start while any consumed clip references offline
 * media — a silent black-hole render is worse than a loud stop. Only clips
 * the export would consume are considered (#544 eligibility).
 */
export function offlineExportBlockers(
  project: Project,
  exists: PathExists,
): MediaAsset[] {
  const offline = new Set(findOfflineAssets(project, exists).map((a) => a.id));
  const visibleTrackIds = new Set(
    project.timeline.tracks.filter((t) => t.visible !== false).map((t) => t.id),
  );
  const blockers = new Set<string>();
  for (const clip of project.timeline.clips) {
    if (!visibleTrackIds.has(clip.trackId)) continue;
    if (clip.type === 'audio' && clip.muted) continue;
    if (offline.has(clip.assetId)) blockers.add(clip.assetId);
  }
  return project.media.filter((a) => blockers.has(a.id));
}

/** Human list for the refusal message, e.g. `interview.mp4, b-roll.mp4`. */
export function formatOfflineNames(assets: readonly MediaAsset[]): string {
  return assets.map((a) => a.filename).join(', ');
}
