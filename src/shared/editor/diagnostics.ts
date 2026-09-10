/**
 * Timeline diagnostics (Track 2, L2 — see docs/AGENTIC_ROADMAP.md).
 *
 * A read-only structural audit of the project, exposed to the Agent as
 * `verify_timeline` so the model can check its own work after a destructive
 * batch instead of asking the user to spot mistakes. The evaluator-optimizer
 * pattern from the harness research: verification is a separate, cheap pass
 * over the authoritative state, never a mutation path.
 *
 * Pure: no Electron, no filesystem. Offline media is passed in (the executor
 * checks disk), so the checks are unit-testable in isolation.
 */

import type { Project, Clip } from '../types/project';
import type { TimelineMarker } from './markers';
import { MAX_FRAME } from '../utils/safe-number';

export type TimelineDiagnosticCode =
  | 'clip-not-on-track'
  | 'zero-length-clip'
  | 'negative-start'
  | 'clip-outlives-source'
  | 'overlapping-clips'
  | 'missing-media'
  | 'offline-media'
  | 'orphaned-link'
  | 'fade-exceeds-clip'
  | 'empty-title'
  | 'marker-invalid';

export interface TimelineDiagnostic {
  severity: 'error' | 'warning';
  code: TimelineDiagnosticCode;
  message: string;
  clipId?: string;
  markerId?: string;
  trackId?: string;
}

export interface DiagnoseOptions {
  /** Asset paths known to be missing on disk. */
  offlinePaths?: ReadonlySet<string>;
  /** Hard cap on returned issues (default 50, ordered errors-first). */
  maxIssues?: number;
}

/** Structural audit of the whole project. */
export function diagnoseTimeline(
  project: Project,
  options: DiagnoseOptions = {},
): TimelineDiagnostic[] {
  const issues: TimelineDiagnostic[] = [];
  const tracks = new Set(project.timeline.tracks.map((track) => track.id));
  const assetById = new Map(project.media.map((asset) => [asset.id, asset] as const));
  const offline = options.offlinePaths ?? new Set<string>();

  for (const clip of project.timeline.clips) {
    const label = clip.label || clip.id;

    if (!tracks.has(clip.trackId)) {
      issues.push({
        severity: 'error',
        code: 'clip-not-on-track',
        message: `Clip "${label}" references track "${clip.trackId}", which does not exist.`,
        clipId: clip.id,
        trackId: clip.trackId,
      });
    }
    if (clip.durationFrames <= 0) {
      issues.push({
        severity: 'error',
        code: 'zero-length-clip',
        message: `Clip "${label}" has a non-positive duration (${clip.durationFrames} frames).`,
        clipId: clip.id,
      });
    }
    if (clip.startFrame < 0) {
      issues.push({
        severity: 'error',
        code: 'negative-start',
        message: `Clip "${label}" starts before frame 0 (${clip.startFrame}).`,
        clipId: clip.id,
      });
    }

    if (clip.type === 'title') {
      if (!clip.text || clip.text.trim().length === 0) {
        issues.push({
          severity: 'warning',
          code: 'empty-title',
          message: `Title clip "${label}" has no text and renders nothing.`,
          clipId: clip.id,
        });
      }
    } else {
      const asset = assetById.get(clip.assetId);
      if (!asset) {
        issues.push({
          severity: 'error',
          code: 'missing-media',
          message: `Clip "${label}" references media "${clip.assetId}", which is not in the library.`,
          clipId: clip.id,
        });
      } else {
        if (offline.has(asset.path)) {
          issues.push({
            severity: 'warning',
            code: 'offline-media',
            message: `Clip "${label}" uses "${asset.filename}", which is missing on disk. Relink it before exporting.`,
            clipId: clip.id,
          });
        }
        // Still images and titles extend freely; a timed source cannot.
        if (asset.type !== 'image' && asset.duration > 0 && clip.outPoint > asset.duration) {
          issues.push({
            severity: 'warning',
            code: 'clip-outlives-source',
            message: `Clip "${label}" reads to frame ${clip.outPoint} of "${asset.filename}", which is only ${asset.duration} frames long.`,
            clipId: clip.id,
          });
        }
      }
    }

    const fadeIn = clip.fadeInFrames ?? 0;
    const fadeOut = clip.fadeOutFrames ?? 0;
    if (fadeIn + fadeOut > clip.durationFrames) {
      issues.push({
        severity: 'warning',
        code: 'fade-exceeds-clip',
        message: `Clip "${label}" has ${fadeIn + fadeOut} frames of fades over a ${clip.durationFrames}-frame clip.`,
        clipId: clip.id,
      });
    }
  }

  // Overlaps per track: a later clip starting inside an earlier one.
  const byTrack = new Map<string, Clip[]>();
  for (const clip of project.timeline.clips) {
    const list = byTrack.get(clip.trackId);
    if (list) list.push(clip);
    else byTrack.set(clip.trackId, [clip]);
  }
  for (const [trackId, clips] of byTrack) {
    const sorted = [...clips].sort((a, b) => a.startFrame - b.startFrame);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const current = sorted[i];
      const prevEnd = prev.startFrame + prev.durationFrames;
      if (current.startFrame < prevEnd) {
        issues.push({
          severity: 'warning',
          code: 'overlapping-clips',
          message: `Clips "${prev.label || prev.id}" and "${current.label || current.id}" overlap on track "${trackId}" (${current.startFrame} < ${prevEnd}).`,
          clipId: current.id,
          trackId,
        });
      }
    }
  }

  // A link group with a single member is a half-detached pair.
  const linkCounts = new Map<string, number>();
  for (const clip of project.timeline.clips) {
    if (!clip.linkGroupId) continue;
    linkCounts.set(clip.linkGroupId, (linkCounts.get(clip.linkGroupId) ?? 0) + 1);
  }
  for (const clip of project.timeline.clips) {
    if (clip.linkGroupId && (linkCounts.get(clip.linkGroupId) ?? 0) < 2) {
      issues.push({
        severity: 'warning',
        code: 'orphaned-link',
        message: `Clip "${clip.label || clip.id}" is in a link group with no partner; unlink it or relink its other half.`,
        clipId: clip.id,
      });
    }
  }

  for (const marker of validateMarkers(project.timeline.markers ?? [])) issues.push(marker);

  const severityRank = (issue: TimelineDiagnostic) => (issue.severity === 'error' ? 0 : 1);
  const max = Math.max(1, Math.min(200, options.maxIssues ?? 50));
  return issues
    .sort((a, b) => severityRank(a) - severityRank(b))
    .slice(0, max);
}

function validateMarkers(markers: readonly TimelineMarker[]): TimelineDiagnostic[] {
  const issues: TimelineDiagnostic[] = [];
  for (const marker of markers) {
    const end = marker.startFrame + marker.durationFrames;
    if (marker.startFrame < 0 || marker.durationFrames < 0 || end > MAX_FRAME) {
      issues.push({
        severity: 'error',
        code: 'marker-invalid',
        message: `Marker "${marker.name}" has an out-of-range span (${marker.startFrame} + ${marker.durationFrames}).`,
        markerId: marker.id,
      });
    }
  }
  return issues;
}
