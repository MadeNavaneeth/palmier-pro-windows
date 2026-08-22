/**
 * Timeline markers — review notes anchored to timeline frames
 * (upstream PRs #542 and #560).
 *
 * A marker is a point (`durationFrames === 0`) or a half-open range
 * (`durationFrames > 0`, end exclusive) with a user name, color, and comment.
 * Markers are timeline-level, never clip-level; they ride the project file as
 * an optional `Timeline.markers` array so projects saved before markers
 * decode unchanged.
 *
 * The ripple mapping below is the Windows translation of upstream's engine,
 * including its two embedded fixes: a marker is remapped by the *smallest*
 * per-track hole set so a note sitting on surviving picture is not pushed by
 * another track's larger hole, and track maps that consumed the marker are
 * ignored rather than allowed to collapse it to nothing.
 */

import type { Frame } from '../types/project';
import { MAX_FRAME } from '../utils/safe-number';

export interface TimelineMarker {
  id: string;
  /** Single line, trimmed, 1–120 chars. */
  name: string;
  startFrame: Frame;
  /** 0 = point marker; > 0 = range marker ending at startFrame + durationFrames. */
  durationFrames: Frame;
  /** `#RRGGBB` or `#RRGGBBAA`. */
  color: string;
  /** Up to 4000 chars of free-form note text. */
  comment: string;
}

export const MARKER_NAME_MAX_LENGTH = 120;
export const MARKER_COMMENT_MAX_LENGTH = 4000;
/** Upstream's default marker blue, RGB(0, 0.478, 1). */
export const MARKER_DEFAULT_COLOR = '#007AFF';

const MARKER_COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** Exclusive end frame of a marker's span. */
export function markerEnd(marker: TimelineMarker): Frame {
  return marker.startFrame + marker.durationFrames;
}

export function isRangeMarker(marker: TimelineMarker): boolean {
  return marker.durationFrames > 0;
}

/**
 * Validate one marker, returning a human-readable error or `null` when valid.
 * The same checks run for creates and updates so the Agent and any future UI
 * cannot diverge.
 */
export function validateMarker(marker: TimelineMarker): string | null {
  const name = marker.name.trim();
  if (name.length === 0) return 'Marker name must not be empty.';
  if (name.length > MARKER_NAME_MAX_LENGTH) {
    return `Marker name must be at most ${MARKER_NAME_MAX_LENGTH} characters.`;
  }
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return 'Marker name must be a single line without control characters.';
  }
  if (marker.comment.length > MARKER_COMMENT_MAX_LENGTH) {
    return `Marker comment must be at most ${MARKER_COMMENT_MAX_LENGTH} characters.`;
  }
  if (!Number.isInteger(marker.startFrame) || marker.startFrame < 0 || marker.startFrame > MAX_FRAME) {
    return 'Marker start frame is out of range.';
  }
  if (
    !Number.isInteger(marker.durationFrames)
    || marker.durationFrames < 0
    || markerEnd(marker) > MAX_FRAME
  ) {
    return 'Marker duration is out of range.';
  }
  if (!MARKER_COLOR_PATTERN.test(marker.color)) {
    return 'Marker color must be #RRGGBB or #RRGGBBAA.';
  }
  return null;
}

/** Canonical order: by start frame, then id, so ties are deterministic. */
export function sortMarkers(markers: readonly TimelineMarker[]): TimelineMarker[] {
  return [...markers].sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Rescale every frame value by `scale` (fps / canvas changes). Rounding each
 * edge independently keeps point markers points and can never invert a range.
 */
export function rescaleMarker(marker: TimelineMarker, scale: number): TimelineMarker {
  return {
    ...marker,
    startFrame: Math.max(0, Math.round(marker.startFrame * scale)),
    durationFrames: Math.max(0, Math.round(marker.durationFrames * scale)),
  };
}

// ─── Ripple mapping ──────────────────────────────────────────────────────────

interface Hole {
  start: Frame;
  end: Frame;
}

/** Merge overlapping/adjacent holes and drop empties, per track. */
function mergeHoles(holes: readonly Hole[]): Hole[] {
  const sorted = [...holes].filter((hole) => hole.end > hole.start).sort((a, b) => a.start - b.start);
  const merged: Hole[] = [];
  for (const hole of sorted) {
    const last = merged[merged.length - 1];
    if (last && hole.start <= last.end) {
      last.end = Math.max(last.end, hole.end);
    } else {
      merged.push({ ...hole });
    }
  }
  return merged;
}

/**
 * Map one frame through one track's closed holes: whole holes before the
 * frame subtract fully; a hole straddling the frame pulls it back to the
 * hole's own start. Mirrors upstream's `RippleEngine.mapFrame`.
 */
function mapFrame(frame: Frame, holes: readonly Hole[]): Frame {
  let mapped = frame;
  for (const hole of holes) {
    if (hole.end <= frame) {
      mapped -= hole.end - hole.start;
    } else if (hole.start < frame) {
      mapped -= frame - hole.start;
    }
  }
  return Math.max(0, mapped);
}

/**
 * Map markers through a ripple delete, where each participating track closes
 * its own set of holes. A track whose hole list is empty does not vote — its
 * material never moved, so anchoring unmapped positions to it would pin
 * markers that other tracks' cuts moved.
 *
 * A point survives unless every voting track's holes removed it; a range
 * survives while some track leaves it non-empty. The surviving position takes
 * the minimum mapped start (and, independently, minimum mapped end) across
 * surviving track maps — upstream's conservative smallest-position remap,
 * which keeps a marker from being dragged further than any single cut
 * requires while never letting an ignored map collapse it to nothing.
 */
export function mapMarkersThroughClosingHoles(
  markers: readonly TimelineMarker[],
  trackHoles: readonly (readonly Hole[])[],
): TimelineMarker[] | null {
  const mergedTracks = trackHoles.map(mergeHoles).filter((holes) => holes.length > 0);
  if (mergedTracks.length === 0) return null;

  let changed = false;
  const next: TimelineMarker[] = [];

  for (const marker of markers) {
    const surviving: Array<{ start: Frame; end: Frame }> = [];
    for (const holes of mergedTracks) {
      const start = mapFrame(marker.startFrame, holes);
      if (!isRangeMarker(marker)) {
        const removed = holes.some((hole) => hole.start <= marker.startFrame && marker.startFrame < hole.end);
        if (!removed) surviving.push({ start, end: start });
        continue;
      }
      const end = mapFrame(markerEnd(marker), holes);
      if (end > start) surviving.push({ start, end });
    }

    if (surviving.length === 0) {
      // Removed on every voting track.
      changed = true;
      continue;
    }

    const nextStart = Math.min(...surviving.map((entry) => entry.start));
    if (isRangeMarker(marker)) {
      const nextEnd = Math.min(...surviving.map((entry) => entry.end));
      if (nextEnd <= nextStart) {
        changed = true;
        continue;
      }
      if (nextStart !== marker.startFrame || nextEnd !== markerEnd(marker)) changed = true;
      next.push({ ...marker, startFrame: nextStart, durationFrames: nextEnd - nextStart });
    } else {
      if (nextStart !== marker.startFrame) changed = true;
      next.push({ ...marker, startFrame: nextStart });
    }
  }

  if (!changed) return null;
  return sortMarkers(next);
}

/**
 * Map markers through an opening (push > 0) or closing (push < 0) at `frame`,
 * used by ripple trim and insert: starts at or after the frame move by push,
 * ranges spanning the frame stretch or shrink by it, and a negative push is
 * exactly a single-hole close.
 */
export function mapMarkersOpeningAt(
  markers: readonly TimelineMarker[],
  frame: Frame,
  push: Frame,
): TimelineMarker[] | null {
  if (push === 0) return null;
  if (push < 0) {
    return mapMarkersThroughClosingHoles(markers, [[{ start: frame + push, end: frame }]]);
  }
  let changed = false;
  const next = markers.map((marker) => {
    const end = markerEnd(marker);
    if (marker.startFrame >= frame) {
      changed = true;
      return { ...marker, startFrame: marker.startFrame + push };
    }
    if (isRangeMarker(marker) && marker.startFrame < frame && end > frame) {
      changed = true;
      return { ...marker, durationFrames: marker.durationFrames + push };
    }
    return marker;
  });
  return changed ? sortMarkers(next) : null;
}
