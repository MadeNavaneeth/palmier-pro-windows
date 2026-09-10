/**
 * Project digest (Track 2, L4 — see docs/AGENTIC_ROADMAP.md).
 *
 * A short, *derived* summary of the authoritative project state, injected
 * into the system prompt on every turn. The research is explicit that the
 * cheapest context discipline is not a bigger window: it is keeping a
 * truthful, small picture of state so the model does not have to re-read a
 * full `get_timeline` dump after every step — and never a hand-maintained
 * cache that can drift.
 *
 * Derived means regenerated from the controller each turn. Nothing writes to
 * it; if it disagrees with the project, the digest is wrong by construction.
 */

import type { Project } from '../types/project';
import { diagnoseTimeline } from './diagnostics';

/** One-line-ish digest, bounded by construction (counts and one heading). */
export function buildProjectDigest(project: Project): string {
  const { fps, width, height } = project.settings;
  const clips = project.timeline.clips;
  const tracks = project.timeline.tracks;

  const contentEnd = clips.reduce(
    (maximum, clip) => Math.max(maximum, clip.startFrame + clip.durationFrames),
    0,
  );
  const byType = (type: string) => clips.filter((clip) => clip.type === type).length;
  const locked = tracks.filter((track) => track.locked).length;
  const hidden = tracks.filter((track) => track.visible === false).length;
  const markers = project.timeline.markers ?? [];
  const openMarkers = markers.filter((marker) => marker.status === 'open').length;
  const reviewMarkers = markers.filter((marker) => marker.status === 'review').length;

  const issues = diagnoseTimeline(project);
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.length - errors;

  const lines = [
    `## Current project`,
    `"${project.name}" — ${width}x${height} @ ${fps} fps, content ${formatDuration(contentEnd, fps)}`,
    `Tracks: ${tracks.filter((t) => t.type === 'video').length} video, ${tracks.filter((t) => t.type === 'audio').length} audio`
      + `${locked > 0 ? ` (${locked} locked)` : ''}${hidden > 0 ? ` (${hidden} hidden)` : ''}`,
    `Clips: ${clips.length} total`
      + ` — ${byType('video')} video, ${byType('audio')} audio, ${byType('image')} image, ${byType('title')} title`,
    `Media: ${project.media.length} assets`,
    `Markers: ${markers.length}`
      + `${markers.length > 0 ? ` (${openMarkers} open, ${reviewMarkers} in review)` : ''}`,
    `Structural audit: ${errors} error(s), ${warnings} warning(s)`
      + `${errors + warnings > 0 ? ' — run verify_timeline for detail' : ''}`,
  ];
  return lines.join('\n');
}

/** Compact duration for the digest (`5s`, `1m 30s`, `1h 05m`). */
function formatDuration(frames: number, fps: number): string {
  if (!Number.isFinite(frames) || frames <= 0 || fps <= 0) return '0s';
  const totalSeconds = Math.round(frames / fps);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}
