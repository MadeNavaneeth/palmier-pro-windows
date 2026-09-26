/**
 * Timeline store Ã¢â‚¬â€ Zustand state for the interactive timeline editor.
 * Wraps EditorController for reactive UI updates, manages selection,
 * zoom/scroll viewport, playback state, and drag operations.
 */

import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { EditorController } from '../../shared/editor/controller';
import type { Clip, Track, Frame, Project, MediaAsset, Timeline } from '../../shared/types/project';
import type { TimelineBreadcrumb } from '../../shared/editor/compound';
import type { BlendMode } from '../../shared/types/blend-mode';
import type { ClipTransition } from '../../shared/editor/transition';
import type { MediaProbeResult } from '../../main/ipc/media';
import { normalizePlaybackRate } from '../../shared/editor/playback-rate';
import { normalizeMarkerSettings } from '../../shared/editor/marker-settings';
import type { MarkerStatus } from '../../shared/editor/markers';
import type { GridLayoutPreset } from '../../shared/editor/grid-layout';
import type { ShapeKind } from '../../shared/editor/shape';
import type { SilenceConfig } from '../../shared/audio/silence-detector';
import { mapSilenceRangesToTimeline, type OmittedSilenceRange } from '../../shared/editor/silence-scoping';
import { nextEditPoint, previousEditPoint, timelineContentEnd } from '../../shared/editor/edit-points';
import { createEmptyProject } from '../../shared/types/project';

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Types Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export type DragMode = 'none' | 'move' | 'trim-left' | 'trim-right' | 'playhead' | 'select-rect';

export interface DragState {
  mode: DragMode;
  clipId: string | null;
  startX: number;
  startFrame: Frame;
  /** Original clip state before drag began (for undo on cancel) */
  originalStartFrame?: Frame;
  originalInPoint?: Frame;
  originalOutPoint?: Frame;
  originalDuration?: Frame;
  ripple?: boolean;
  /** Alt-trim: scope to the grabbed half of a linked pair (J/L affordance). */
  singleHalf?: boolean;
  hasAppliedEdit?: boolean;
}

export interface GapSelection {
  trackId: string;
  startFrame: Frame;
  endFrame: Frame;
}

export interface TimelineViewport {
  /** Pixels per frame Ã¢â‚¬â€ controls horizontal zoom */
  pixelsPerFrame: number;
  /** Horizontal scroll offset in frames */
  scrollFrame: Frame;
  /** Minimum zoom (zoomed out) */
  minPxPerFrame: number;
  /** Maximum zoom (zoomed in) */
  maxPxPerFrame: number;
}

export interface SnapPoint {
  frame: Frame;
  source: 'clip-start' | 'clip-end' | 'playhead' | 'marker';
}

function mediaAssetsFromProbeResults(
  probeResults: MediaProbeResult[],
  projectFps: number,
): MediaAsset[] {
  const addedAt = new Date().toISOString();
  return probeResults.map((probe) => ({
    id: nanoid(),
    path: probe.path,
    filename: probe.filename,
    type: probe.type,
    duration: Math.max(0, Math.round((probe.duration || 0) * projectFps)),
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    codec: probe.codec,
    audioCodec: probe.audioCodec,
    sampleRate: probe.sampleRate,
    channels: probe.channels,
    fileSize: probe.fileSize,
    addedAt,
    ...(probe.startTimecode ? { startTimecode: probe.startTimecode } : {}),
  }));
}

/**
 * Tracks that edit-point navigation should consider.
 *
 * A selection is a statement about which tracks the editor is working on, so
 * up/down step through that track's cuts instead of every boundary in the
 * project. With nothing selected there is no such statement, so all tracks
 * contribute.
 */
function navigationTrackIds(state: TimelineState): Set<string> | undefined {
  if (state.selectedClipIds.size === 0) return undefined;
  const trackIds = new Set<string>();
  for (const clip of scopeTimelineOf(state.project, state.activeTimelineId).clips) {
    if (state.selectedClipIds.has(clip.id)) trackIds.add(clip.trackId);
  }
  return trackIds.size > 0 ? trackIds : undefined;
}

/** Snapshot view of the open scope (main timeline at the root). */
export function scopeTimelineOf(project: Project, activeTimelineId: string | null): Timeline {
  if (activeTimelineId === null) return project.timeline;
  return project.timelines?.[activeTimelineId] ?? project.timeline;
}

/**
 * What one silence removal actually did, in numbers the Inspector can state.
 *
 * `removed` counts detected spans that became a cut, not spans the detector
 * asked for: the detector reads the whole asset while a clip shows a trimmed
 * part of it, so a span with no overlap in the clip is omitted rather than
 * clamped (see `mapSilenceRangesToTimeline`). `omitted` reports those spans by
 * reason so "no silence found" is never claimed over silence that was found.
 */
export interface SilenceRemovalOutcome {
  removed: number;
  error?: string;
  /** Detected spans that produced no cut, keyed by the mapper's reason. */
  omitted?: Record<OmittedSilenceRange['reason'], number>;
}

export interface TimelineState {
  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Core Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  controller: EditorController;
  project: Project;

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Selection Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  selectedClipIds: Set<string>;
  hoveredClipId: string | null;
  selectedGap: GapSelection | null;

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Playback Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  isPlaying: boolean;
  playbackRate: number; // 1 = normal, -1 = reverse, 2 = 2x, etc.
  loopEnabled: boolean; // loop over inFrame..outFrame during playback (upstream #428)

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Viewport Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  viewport: TimelineViewport;
  /**
   * Measured width of the timeline lane area in pixels.
   *
   * Published by the Timeline panel's ResizeObserver so "fit to window" is
   * correct from a keyboard shortcut or the toolbar, neither of which can see
   * the lane element. Guessing from `window.innerWidth` was off by the track
   * header and every open side panel.
   */
  viewportWidth: number;

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Drag Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  drag: DragState;
  snapEnabled: boolean;
  snapThresholdFrames: number;

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Computed / Helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  getClips: () => Clip[];
  getTracks: () => Track[];
  getPlayhead: () => Frame;
  getProjectFps: () => number;
  getProjectHeight: () => number;
  getProjectDuration: () => Frame;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Actions Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  // Selection
  selectClip: (clipId: string, additive?: boolean, includeLinked?: boolean) => void;
  selectAllClips: () => void;
  /**
   * Select every clip on one track (upstream PR #512). Returns false Ã¢â‚¬â€ leaving
   * the selection untouched Ã¢â‚¬â€ when the track is missing or has no clips.
   */
  selectAllClipsOnTrack: (trackId: string) => boolean;
  deselectAll: () => void;
  selectClipsInRange: (startFrame: Frame, endFrame: Frame, trackId?: string) => void;
  setHoveredClip: (clipId: string | null) => void;

  // Markers (upstream PRs #542 / #560)
  /** Marker ids currently selected in the ruler. */
  selectedMarkerIds: Set<string>;
  /** Add a point marker at the playhead, auto-named "Marker N". */
  addMarkerAtPlayhead: () => string | null;
  selectMarker: (markerId: string, additive?: boolean) => void;
  clearMarkerSelection: () => void;
  /** Delete the selected markers; true when anything was deleted. */
  deleteSelectedMarkers: () => boolean;
  /** Patch one marker; false when the id is unknown or validation refused it. */
  updateMarker: (
    markerId: string,
    patch: { name?: string; startFrame?: Frame; durationFrames?: Frame; color?: string; comment?: string; status?: MarkerStatus },
  ) => boolean;
  /** Jump to the nearest marker start after the playhead; selects it. */
  goToNextMarker: () => boolean;
  /** Jump to the nearest marker start before the playhead; selects it. */
  goToPreviousMarker: () => boolean;
  /**
   * Whether ripple edits carry markers along (upstream #560,
   * `rippleTimelineMarkers`, default on). Off means program-time pins.
   */
  rippleMarkers: boolean;
  /** Read the saved preference into the controller and state. */
  loadRippleMarkers: () => void;
  /** Flip the preference and persist it via main. */
  setRippleMarkers: (enabled: boolean) => void;

  /** Add a 3s title clip at the playhead on the first video track (R3). */
  addTitleAtPlayhead: (text?: string) => string | '';
  /** Add a 3s shape clip at the playhead on the first video track; '' when refused. */
  addShapeAtPlayhead: (shapeKind: ShapeKind) => string | '';
  /** Update a title clip's text; false when refused (invalid/unknown). */
  setTitleText: (clipId: string, text: string) => boolean;
  /** Constant playback speed on a visual clip (R4 groundwork). */
  setClipSpeed: (clipId: string, speed: number) => boolean;
  /** Stereo balance on an audio clip, -1 left … +1 right (R5). */
  setClipPan: (clipId: string, pan: number) => boolean;
  /** Auto-crossfade adjacent audio clips on a track (R5). */
  autoCrossfadeAudio: (trackId: string) => number;

  // Clipboard (R1)
  copySelectedClips: () => number;
  cutSelectedClips: () => number;
  /** Keyboard paste: anchor at the playhead on its source/compatible track. */
  pasteClipsAtPlayhead: () => string[];

  /** Duplicate the selected clips immediately after themselves (R1). */
  duplicateSelected: () => string[];

  /** Group the selected clips into a nested sequence; null when refused. */
  nestSelected: () => string | null;
  /** Restore one compound clip's nested content; empty when refused. */
  flattenCompound: (clipId: string) => string[];

  // Editing scope (#155 slice 2: in-place nested editing)
  /** Open-scope leaf id, or null on the main timeline (mirrored from the controller). */
  activeTimelineId: string | null;
  /** Breadcrumb chain from the root to the open scope (mirrored from the controller). */
  timelinePath: TimelineBreadcrumb[];
  /** Timeline the lanes show: the open scope, or the main timeline at root. */
  getScopeTimeline: () => Timeline;
  /** Open a compound clip's nested timeline; false when refused. Clears selection. */
  openCompoundClip: (clipId: string) => boolean;
  /** Open a nested timeline by id; false when refused. Clears selection. */
  openScope: (timelineId: string) => boolean;
  /** Navigate one level up; false at the root. Clears selection. */
  navigateScopeUp: () => boolean;
  /** Jump to a breadcrumb scope (ancestor or root); false when refused. Clears selection. */
  navigateScopeTo: (scopeId: string | null) => boolean;

  // Marquee (R1 selection model)
  /** Additive base captured when a rubber band starts; null when idle. */
  marqueeBaseIds: ReadonlySet<string> | null;
  /** Snapshot the current selection as the additive base for a rubber band. */
  beginMarquee: (additive: boolean) => void;
  /**
   * Select every clip intersecting the frame range on any of the given
   * tracks, unioned with the additive base captured by beginMarquee.
   */
  applyMarqueeRegion: (
    startFrame: Frame,
    endFrame: Frame,
    trackIds: ReadonlySet<string>,
  ) => void;
  endMarquee: () => void;

  // Offline media (R0/R1)
  /** Asset paths that no longer exist on disk; refreshed via IPC. */
  offlinePaths: ReadonlySet<string>;
  refreshOfflineStatus: () => Promise<void>;

  // Editing
  addClip: (assetId: string, trackId: string, startFrame: Frame, durationFrames?: Frame) => string;
  placeAssets: (assetIds: string[], trackId: string, startFrame: Frame) => string[];
  importAndPlaceAssets: (
    probeResults: MediaProbeResult[],
    trackId: string,
    startFrame: Frame,
  ) => { assetIds: string[]; clipIds: string[] };
  removeSelectedClips: () => void;
  moveClip: (clipId: string, newStartFrame: Frame, newTrackId?: string) => void;
  trimClipLeft: (clipId: string, newInPoint: Frame, newDuration: Frame) => void;
  trimClipRight: (clipId: string, newOutPoint: Frame, newDuration: Frame) => void;
  splitAtPlayhead: () => void;
  rippleDelete: () => void;
  selectGap: (trackId: string, atFrame: Frame) => void;
  setInFrame: () => void;
  setOutFrame: () => void;
  clearMarkedRange: () => void;
  extractMarkedRange: () => void;
  /** Mark the span of the current selection as the in/out range (#164). */
  markSelectedClip: () => void;

  // Tracks
  addTrack: (type: 'video' | 'audio', name?: string) => string;
  setTrackLocked: (trackId: string, locked: boolean) => void;
  setTrackVisible: (trackId: string, visible: boolean) => void;
  setTrackSyncLocked: (trackId: string, syncLocked: boolean) => void;
  toggleTrackSolo: (trackId: string) => void;
  /** Rename a track; empty restores the generated label (upstream PR #520). */
  setTrackName: (trackId: string, rawName: string) => boolean;

  // Compositing / properties
  importAssets: (probeResults: MediaProbeResult[]) => string[];
  /** Delete media assets and their dependent clips as one undoable edit (#409). */
  removeMediaAssets: (
    assetIds: Iterable<string>,
  ) => { removedAssetIds: string[]; removedClipIds: string[] } | null;
  setClipBlendMode: (clipId: string, blendMode: BlendMode) => void;
  setClipOpacity: (clipId: string, opacity: number) => void;
  setClipFade: (clipId: string, fadeInFrames?: Frame, fadeOutFrames?: Frame) => void;
  /** Apply a property to the whole selection as one undoable edit (#419). */
  setSelectedClipsBlendMode: (blendMode: BlendMode) => void;
  setSelectedClipsOpacity: (opacity: number) => void;
  setSelectedClipsFade: (fadeInFrames?: Frame, fadeOutFrames?: Frame) => void;
  /** Clips backing the current selection, in timeline order. */
  getSelectedClips: () => Clip[];
  setClipTransition: (clipId: string, transition: ClipTransition | null) => void;
  /**
   * Detect and ripple-remove silence in one clip.
   *
   * `overrides` apply to this call only. Omitting them uses the saved silence
   * controls, which the main process owns so the Agent resolves the same way
   * (upstream PR #426).
   */
  removeSilenceForClip: (
    clipId: string,
    overrides?: Partial<SilenceConfig>,
  ) => Promise<SilenceRemovalOutcome>;
  getSelectedClip: () => Clip | null;

  // Playback
  /**
   * Move the playhead. `scopeId` selects the timeline explicitly — the
   * preview transport passes root (`null`) because delivery lives in root
   * frame space; omitted means the ambient open scope (lane interactions).
   */
  setPlayhead: (frame: Frame, scopeId?: string | null) => void;
  togglePlayback: () => void;
  setPlaybackRate: (rate: number) => void;
  toggleLoop: () => void;
  compactTake: (sourceClipId: string) => boolean;
  /** Apply a grid layout to the given visual clips (upstream PR #410). */
  applyLayout: (clipIds: string[], preset: GridLayoutPreset) => number;
  stepFrame: (delta: number, scopeId?: string | null) => void;
  /** Jump the playhead to the start of the timeline. */
  goToStart: () => void;
  /** Jump the playhead to the end of the last clip, not into trailing padding. */
  goToEnd: () => void;
  /** Jump to the nearest clip boundary before the playhead (#164). */
  goToPreviousEdit: () => void;
  /** Jump to the nearest clip boundary after the playhead (#164). */
  goToNextEdit: () => void;
  /** Jump to the in mark, if one is set (#164). */
  goToInPoint: () => void;
  /** Jump to the out mark, if one is set (#164). */
  goToOutPoint: () => void;

  // Undo/Redo
  undo: () => void;
  redo: () => void;

  // Viewport
  zoomIn: () => void;
  zoomOut: () => void;
  setZoom: (pxPerFrame: number) => void;
  scrollTo: (frame: Frame) => void;
  fitToWindow: (containerWidth: number) => void;
  /** Publish the measured lane width so fit-to-window has a real number. */
  setViewportWidth: (width: number) => void;
  /** Fit using the last measured lane width. */
  fitToViewport: () => void;

  // Drag operations
  startDrag: (
    mode: DragMode,
    clipId: string | null,
    startX: number,
    startFrame: Frame,
    ripple?: boolean,
    singleHalf?: boolean,
  ) => void;
  updateDrag: (currentX: number) => void;
  endDrag: () => void;
  cancelDrag: () => void;

  // Snapping
  getSnapPoints: (excludeClipId?: string) => SnapPoint[];
  snapFrame: (frame: Frame, excludeClipId?: string) => Frame;
  toggleSnap: () => void;

  // Project settings
  applyProjectSettings: (change: { fps?: number; width?: number; height?: number }) => void;

  // Project lifecycle
  loadProject: (project: Project) => void;
  resetProject: () => void;
  syncFromController: () => void;
}

/** Omitted spans grouped by reason, so the notice can name the reason. */
function countOmissions(
  omitted: readonly OmittedSilenceRange[],
): Record<OmittedSilenceRange['reason'], number> {
  const counts = { 'outside-clip': 0, 'invalid-range': 0 } as Record<OmittedSilenceRange['reason'], number>;
  for (const span of omitted) counts[span.reason] += 1;
  return counts;
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Store Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export const useTimelineStore = create<TimelineState>((set, get) => {
  const controller = new EditorController();

  // Subscribe to controller changes
  controller.subscribe((project) => {
    set({
      project,
      activeTimelineId: controller.getActiveTimelineId(),
      timelinePath: controller.getTimelineBreadcrumbs(),
    });
  });

  return {
    controller,
    project: controller.getProject(),
    activeTimelineId: controller.getActiveTimelineId(),
    timelinePath: controller.getTimelineBreadcrumbs(),

    selectedClipIds: new Set(),
    hoveredClipId: null,
    selectedGap: null,
    selectedMarkerIds: new Set(),
    rippleMarkers: true,
    marqueeBaseIds: null,
    offlinePaths: new Set(),

    isPlaying: false,
    playbackRate: 1,
    loopEnabled: false,

    viewport: {
      pixelsPerFrame: 4,
      scrollFrame: 0,
      minPxPerFrame: 0.5,
      maxPxPerFrame: 30,
    },
    viewportWidth: 0,

    drag: {
      mode: 'none',
      clipId: null,
      startX: 0,
      startFrame: 0,
    },

    snapEnabled: true,
    snapThresholdFrames: 5,

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Computed Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    getClips: () => get().controller.getClips(),
    getTracks: () => get().controller.getTracks(),
    getPlayhead: () => get().controller.getPlayhead(),
    getScopeTimeline: () => scopeTimelineOf(get().project, get().activeTimelineId),
    getProjectFps: () => get().project.settings.fps,
    getProjectHeight: () => get().project.settings.height,
    getProjectDuration: () => {
      const clips = get().project.timeline.clips;
      if (clips.length === 0) return 300; // default 10s at 30fps
      return Math.max(...clips.map((c) => c.startFrame + c.durationFrames)) + 90;
    },
    canUndo: () => get().controller.canUndo(),
    canRedo: () => get().controller.canRedo(),

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Selection Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    selectClip: (clipId, additive = false, includeLinked = true) => {
      set((state) => {
        const clipIds = includeLinked
          ? state.controller.expandLinkedClipIds([clipId])
          : [clipId];
        const next = new Set(additive ? state.selectedClipIds : []);
        const shouldDeselect = additive && clipIds.every((id) => next.has(id));
        if (shouldDeselect) {
          for (const id of clipIds) next.delete(id);
        } else {
          for (const id of clipIds) next.add(id);
        }
        return { selectedClipIds: next, selectedGap: null };
      });
    },

    selectAllClips: () => {
      const clips = get().getClips();
      set({ selectedClipIds: new Set(clips.map((clip) => clip.id)), selectedGap: null });
    },

    selectAllClipsOnTrack: (trackId) => {
      const ids = get()
        .getClips()
        .filter((clip) => clip.trackId === trackId)
        .map((clip) => clip.id);
      // A missing or empty track must not clobber the current selection Ã¢â‚¬â€
      // the same invariant as upstream's embedded stale-gap fix (#512): a
      // successful select clears any selected gap so a following
      // gap-ripple-delete cannot fire against the old gap.
      if (ids.length === 0) return false;
      set({
        selectedClipIds: new Set(get().controller.expandLinkedClipIds(ids)),
        selectedGap: null,
      });
      return true;
    },

    deselectAll: () => set({ selectedClipIds: new Set(), selectedGap: null }),

    selectClipsInRange: (startFrame, endFrame, trackId) => {
      const clips = get().getClips();
      const minF = Math.min(startFrame, endFrame);
      const maxF = Math.max(startFrame, endFrame);
      const ids = clips
        .filter((c) => {
          const clipEnd = c.startFrame + c.durationFrames;
          const overlaps = c.startFrame < maxF && clipEnd > minF;
          const trackMatch = !trackId || c.trackId === trackId;
          return overlaps && trackMatch;
        })
        .map((c) => c.id);
      set({
        selectedClipIds: new Set(get().controller.expandLinkedClipIds(ids)),
        selectedGap: null,
      });
    },

    setHoveredClip: (clipId) => set({ hoveredClipId: clipId }),

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Markers (#542) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    addMarkerAtPlayhead: () => {
      const { controller } = get();
      const frame = controller.getPlayhead();
      // Auto-name "Marker N", skipping any name the user already claimed.
      const existing = new Set(controller.getMarkers().map((marker) => marker.name));
      let n = 1;
      while (existing.has(`Marker ${n}`)) n += 1;
      try {
        const receipt = controller.changeTimelineMarkers(
          { creates: [{ name: `Marker ${n}`, startFrame: frame }] },
          'Add marker',
        );
        const created = receipt?.created[0];
        if (!created) return null;
        set({
          selectedMarkerIds: new Set([created.id]),
          selectedClipIds: new Set(),
          selectedGap: null,
        });
        return created.id;
      } catch {
        return null;
      }
    },

    selectMarker: (markerId, additive) => {
      set((state) => {
        const next = new Set(additive ? state.selectedMarkerIds : []);
        if (additive && next.has(markerId)) next.delete(markerId);
        else next.add(markerId);
        // Selecting a marker dismisses clip and gap selections, matching
        // upstream's marker-first interaction.
        return {
          selectedMarkerIds: next,
          selectedClipIds: additive ? state.selectedClipIds : new Set(),
          selectedGap: null,
        };
      });
    },

    clearMarkerSelection: () => set({ selectedMarkerIds: new Set() }),

    deleteSelectedMarkers: () => {
      const ids = [...get().selectedMarkerIds];
      if (ids.length === 0) return false;
      try {
        const receipt = get().controller.changeTimelineMarkers(
          { deleteIds: ids },
          ids.length > 1 ? 'Delete markers' : 'Delete marker',
        );
        set({ selectedMarkerIds: new Set() });
        return receipt !== null;
      } catch {
        return false;
      }
    },

  updateMarker: (markerId, patch) => {
    try {
      const receipt = get().controller.changeTimelineMarkers(
        { updates: [{ id: markerId, ...patch }] },
        'Update marker',
      );
      return receipt !== null;
    } catch {
      return false;
    }
  },

  goToNextMarker: () => {
    const playhead = get().getPlayhead();
    const next = get()
      .controller.getMarkers()
      .map((marker) => marker.startFrame)
      .filter((frame) => frame > playhead)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return false;
    get().setPlayhead(next);
    // Land with the destination marker selected so Delete acts on it.
    const hit = get().controller.getMarkers().find((m) => m.startFrame === next);
    set({ selectedMarkerIds: hit ? new Set([hit.id]) : new Set() });
    return true;
  },

  goToPreviousMarker: () => {
    const playhead = get().getPlayhead();
    const previous = get()
      .controller.getMarkers()
      .map((marker) => marker.startFrame)
      .filter((frame) => frame < playhead)
      .sort((a, b) => b - a)[0];
    if (previous === undefined) return false;
    get().setPlayhead(previous);
    const hit = get().controller.getMarkers().find((m) => m.startFrame === previous);
    set({ selectedMarkerIds: hit ? new Set([hit.id]) : new Set() });
    return true;
  },

  loadRippleMarkers: () => {
    // Unit tests run without a preload bridge; the default-on value stands.
    if (typeof window === 'undefined' || !window.palmier?.markers) return;
    void window.palmier.markers
      .getMarkerSettings()
      .then((result: unknown) => {
        const settings = (result as { settings?: { rippleTimelineMarkers?: unknown } } | null)
          ?.settings;
        const enabled = normalizeMarkerSettings(settings).rippleTimelineMarkers;
        get().controller.setRippleTimelineMarkers(enabled);
        set({ rippleMarkers: enabled });
      })
      .catch(() => {
        // The default stands; a failed read must not unpin markers.
      });
  },

  setRippleMarkers: (enabled) => {
    get().controller.setRippleTimelineMarkers(enabled);
    set({ rippleMarkers: enabled });
    // Best-effort persistence: the controller already governs this session,
    // so a failed write only means the choice will not survive a restart.
    try {
      if (typeof window === 'undefined' || !window.palmier?.markers) return;
      void window.palmier.markers
        .setMarkerSettings({ rippleTimelineMarkers: enabled })
        .then((result: unknown) => {
          const settings = (result as { settings?: { rippleTimelineMarkers?: unknown } } | null)
            ?.settings;
          if (!settings) return;
          const reconciled = normalizeMarkerSettings(settings).rippleTimelineMarkers;
          get().controller.setRippleTimelineMarkers(reconciled);
          set({ rippleMarkers: reconciled });
        })
        .catch(() => {
          // Keep the optimistic value for this session.
        });
    } catch {
      // No bridge (unit tests): the controller value still governs.
    }
  },

  addTitleAtPlayhead: (text = 'Title') => {
    const { controller } = get();
    const videoTrack = controller.getTracks().find((t) => t.type === 'video');
    if (!videoTrack) return '';
    const clipId = controller.addTitleClip({
      trackId: videoTrack.id,
      startFrame: controller.getPlayhead(),
      durationFrames: Math.round(controller.getProject().settings.fps * 3),
      text,
    });
    if (clipId) set({ selectedClipIds: new Set([clipId]), selectedGap: null });
    return clipId;
  },

  addShapeAtPlayhead: (shapeKind) => {
    const { controller } = get();
    const videoTrack = controller.getTracks().find((t) => t.type === 'video');
    if (!videoTrack) return '';
    const clipId = controller.addShapeClip({
      trackId: videoTrack.id,
      startFrame: controller.getPlayhead(),
      durationFrames: Math.round(controller.getProject().settings.fps * 3),
      shapeKind,
    });
    if (clipId) set({ selectedClipIds: new Set([clipId]), selectedGap: null });
    return clipId;
  },

  setTitleText: (clipId, text) => {
    try {
      return get().controller.setTitleText(clipId, text);
    } catch {
      return false;
    }
  },

  setClipSpeed: (clipId, speed) => {
    try {
      return get().controller.setClipSpeed(clipId, speed);
    } catch {
      return false;
    }
  },

  setClipPan: (clipId, pan) => {
    try {
      return get().controller.setClipPan(clipId, pan);
    } catch {
      return false;
    }
  },

  autoCrossfadeAudio: (trackId) => {
    try {
      return get().controller.autoCrossfadeAudio(trackId);
    } catch {
      return -1;
    }
  },

  copySelectedClips: () => {
    const count = get().controller.copyClips(get().selectedClipIds);
    return count;
  },

  cutSelectedClips: () => {
    const ids = [...get().selectedClipIds];
    const copied = get().controller.copyClips(ids);
    if (copied > 0 && get().controller.removeClips(ids)) {
      set({ selectedClipIds: new Set() });
    }
    return copied;
  },

    pasteClipsAtPlayhead: () => {
      const newIds = get().controller.pasteClips();
      if (newIds.length > 0) {
        // Pasted clips arrive selected, matching upstream.
        set({
          selectedClipIds: new Set(newIds),
          selectedGap: null,
          selectedMarkerIds: new Set(),
        });
      }
      return newIds;
    },

    duplicateSelected: () => {
      const ids = [...get().selectedClipIds];
      if (ids.length === 0) return [];
      const copied = get().controller.copyClips(ids);
      if (copied === 0) return [];
      const clips = get().controller.getClips().filter((c) => ids.includes(c.id));
      const maxEnd = Math.max(...clips.map((c) => c.startFrame + c.durationFrames));
      // Place duplicates immediately after the last selected clip.
      const pasted = get().controller.pasteClips({ startFrame: maxEnd });
      if (pasted.length > 0) {
        set({
          selectedClipIds: new Set(pasted),
          selectedGap: null,
          selectedMarkerIds: new Set(),
        });
      }
      return pasted;
    },

    // ─── Compound clips / nested sequences (#155 slice 1) ───────────────────
    // Thin selection wrappers over the controller's undoable nest/flatten:
    // refusals (empty selection, locked track, unknown id) select nothing
    // rather than surfacing a toast on right-click.
    nestSelected: () => {
      const ids = [...get().selectedClipIds];
      if (ids.length === 0) return null;
      try {
        const receipt = get().controller.nestClips(ids);
        set({
          selectedClipIds: new Set([receipt.compoundClipId]),
          selectedGap: null,
          selectedMarkerIds: new Set(),
        });
        return receipt.compoundClipId;
      } catch {
        return null;
      }
    },

    flattenCompound: (clipId) => {
      try {
        const receipt = get().controller.flattenCompound(clipId);
        set({
          selectedClipIds: new Set(receipt.restoredClipIds),
          selectedGap: null,
          selectedMarkerIds: new Set(),
        });
        return receipt.restoredClipIds;
      } catch {
        return [];
      }
    },

    // ─── Editing scope (#155 slice 2) ───────────────────────────────────────
    // Thin navigation wrappers: the controller owns the breadcrumb path (and
    // notifies, so project + scope re-sync); the store clears selection
    // because a selection names clips in exactly one scope. Refusals
    // (dangling, unreachable, off-path) return false instead of toasting.
    openCompoundClip: (clipId) => {
      try {
        get().controller.openCompoundClip(clipId);
      } catch {
        return false;
      }
      set({ selectedClipIds: new Set(), selectedGap: null, selectedMarkerIds: new Set() });
      return true;
    },

    openScope: (timelineId) => {
      try {
        get().controller.openNestedTimeline(timelineId);
      } catch {
        return false;
      }
      set({ selectedClipIds: new Set(), selectedGap: null, selectedMarkerIds: new Set() });
      return true;
    },

    navigateScopeUp: () => {
      if (get().activeTimelineId === null) return false;
      get().controller.navigateTimelineUp();
      set({ selectedClipIds: new Set(), selectedGap: null, selectedMarkerIds: new Set() });
      return true;
    },

    navigateScopeTo: (scopeId) => {
      try {
        get().controller.navigateToScope(scopeId);
      } catch {
        return false;
      }
      set({ selectedClipIds: new Set(), selectedGap: null, selectedMarkerIds: new Set() });
      return true;
    },

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Marquee (R1) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  beginMarquee: (additive) => {
    set((state) => ({
      marqueeBaseIds: additive ? state.selectedClipIds : new Set<string>(),
      selectedGap: null,
      selectedMarkerIds: new Set(),
    }));
  },

  applyMarqueeRegion: (startFrame, endFrame, trackIds) => {
    set((state) => {
      const next = new Set(state.marqueeBaseIds ?? new Set<string>());
      for (const clip of state.getClips()) {
        if (
          trackIds.has(clip.trackId)
          && clip.startFrame < endFrame
          && clip.startFrame + clip.durationFrames > startFrame
        ) {
          next.add(clip.id);
        }
      }
      return { selectedClipIds: next };
    });
  },

  endMarquee: () => set({ marqueeBaseIds: null }),

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Offline media (R0/R1) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  refreshOfflineStatus: async () => {
    const paths = get().project.media.map((asset) => asset.path);
    if (paths.length === 0) {
      set({ offlinePaths: new Set() });
      return;
    }
    try {
      const { missing } = await window.palmier.media.checkOffline(paths);
      set({ offlinePaths: new Set(missing) });
    } catch {
      // IPC unavailable (e.g. probe harness): treat everything as online
      // rather than flashing offline states across the timeline.
    }
  },

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Editing Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    addClip: (assetId, trackId, startFrame, durationFrames) => {
      const { controller } = get();
      return controller.addClip({ assetId, trackId, startFrame, durationFrames });
    },

    placeAssets: (assetIds, trackId, startFrame) => {
      return get().controller.placeMediaAssets(assetIds, trackId, startFrame).clipIds;
    },

    importAndPlaceAssets: (probeResults, trackId, startFrame) => {
      const { controller } = get();
      const assets = mediaAssetsFromProbeResults(
        probeResults,
        controller.getProject().settings.fps,
      );
      return controller.importAndPlaceMedia(assets, trackId, startFrame);
    },

    removeSelectedClips: () => {
      const { selectedClipIds, controller } = get();
      if (controller.removeClips(selectedClipIds)) {
        set({ selectedClipIds: new Set() });
      }
    },

    moveClip: (clipId, newStartFrame, newTrackId) => {
      get().controller.moveClip(clipId, Math.max(0, newStartFrame), newTrackId);
    },

    trimClipLeft: (clipId, newInPoint, newDuration) => {
      const { controller } = get();
      const clip = controller.getClips().find((c) => c.id === clipId);
      if (!clip) return;
      controller.trimClip(clipId, newInPoint, newInPoint + newDuration);
    },

    trimClipRight: (clipId, newOutPoint, newDuration) => {
      const { controller } = get();
      const clip = controller.getClips().find((c) => c.id === clipId);
      if (!clip) return;
      controller.trimClip(clipId, clip.inPoint, newOutPoint);
    },

    splitAtPlayhead: () => {
      const { selectedClipIds, controller } = get();
      const playhead = controller.getPlayhead();
      const clips = controller.getClips();

      // Split selected clips, or all clips under playhead
      const targets = selectedClipIds.size > 0
        ? clips.filter((c) => selectedClipIds.has(c.id))
        : clips;

      // One domain operation, so the whole split undoes in one step however
      // many clips the playhead crossed.
      controller.splitClips(targets.map((clip) => clip.id), playhead);
    },

    rippleDelete: () => {
      const { selectedClipIds, selectedGap, controller } = get();
      if (selectedGap) {
        if (controller.rippleDeleteGap(selectedGap.trackId, {
          start: selectedGap.startFrame,
          end: selectedGap.endFrame,
        })) {
          set({ selectedGap: null });
        }
        return;
      }
      const { inFrame, outFrame } = get().getScopeTimeline();
      if (inFrame !== undefined && outFrame !== undefined && outFrame > inFrame) {
        get().extractMarkedRange();
        return;
      }
      if (selectedClipIds.size === 0) return;
      if (controller.rippleDeleteClips(selectedClipIds)) {
        set({ selectedClipIds: new Set() });
      }
    },

    setInFrame: () => get().controller.setInFrame(),
    setOutFrame: () => get().controller.setOutFrame(),
    clearMarkedRange: () => get().controller.clearMarkedRange(),

    // Marks the span the selection covers, so extract/ripple can act on the
    // selected material without hunting for its exact boundaries by hand.
    markSelectedClip: () => {
      const selected = get().getSelectedClips();
      if (selected.length === 0) return;
      const start = Math.min(...selected.map((clip) => clip.startFrame));
      const end = Math.max(...selected.map((clip) => clip.startFrame + clip.durationFrames));
      if (end <= start) return;
      get().controller.setMarkedRange(start, end);
    },

    extractMarkedRange: () => {
      const { controller, selectedClipIds } = get();
      const scope = get().getScopeTimeline();
      const { inFrame, outFrame } = scope;
      if (inFrame === undefined || outFrame === undefined || outFrame <= inFrame) return;

      const selected = scope.clips.find((clip) => selectedClipIds.has(clip.id));
      const overlappingTrackIds = new Set(
        scope.clips
          .filter((clip) =>
            clip.startFrame < outFrame && clip.startFrame + clip.durationFrames > inFrame
          )
          .map((clip) => clip.trackId),
      );
      const anchorTrack = selected
        ? scope.tracks.find((track) => track.id === selected.trackId)
        : scope.tracks.find((track) =>
            track.type === 'video' && !track.locked && overlappingTrackIds.has(track.id)
          )
          || scope.tracks.find((track) =>
            !track.locked && overlappingTrackIds.has(track.id)
          );
      if (!anchorTrack) return;

      if (controller.rippleDeleteRanges(anchorTrack.id, [{ start: inFrame, end: outFrame }])) {
        set({ selectedClipIds: new Set(), selectedGap: null });
      }
    },

    selectGap: (trackId, atFrame) => {
      const clips = get().getClips()
        .filter((clip) => clip.trackId === trackId)
        .sort((a, b) => a.startFrame - b.startFrame);
      if (clips.some((clip) =>
        atFrame >= clip.startFrame && atFrame < clip.startFrame + clip.durationFrames
      )) {
        set({ selectedGap: null });
        return;
      }
      const startFrame = clips
        .filter((clip) => clip.startFrame + clip.durationFrames <= atFrame)
        .reduce((latest, clip) => Math.max(latest, clip.startFrame + clip.durationFrames), 0);
      const next = clips.find((clip) => clip.startFrame > atFrame);
      set({
        selectedGap: next && next.startFrame > startFrame
          ? { trackId, startFrame, endFrame: next.startFrame }
          : null,
        selectedClipIds: new Set(),
      });
    },

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Tracks Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    addTrack: (type, name) => get().controller.addTrack(type, name),
    setTrackLocked: (trackId, locked) => get().controller.setTrackLocked(trackId, locked),
    setTrackVisible: (trackId, visible) => get().controller.setTrackVisible(trackId, visible),
    setTrackSyncLocked: (trackId, syncLocked) =>
      get().controller.setTrackSyncLocked(trackId, syncLocked),
    toggleTrackSolo: (trackId) => get().controller.toggleTrackSolo(trackId),
    setTrackName: (trackId, rawName) => get().controller.setTrackName(trackId, rawName),

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Compositing / properties Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    importAssets: (probeResults) => {
      const { controller } = get();
      const assets = mediaAssetsFromProbeResults(
        probeResults,
        controller.getProject().settings.fps,
      );
      return controller.importMediaAssets(assets);
    },

    removeMediaAssets: (assetIds) => {
      const { controller } = get();
      const report = controller.removeMediaAssets(assetIds);
      if (report && report.removedClipIds.length > 0) {
        // Clips that just disappeared must not stay selected on the timeline.
        set((state) => {
          const next = new Set(state.selectedClipIds);
          for (const clipId of report.removedClipIds) next.delete(clipId);
          return { selectedClipIds: next, selectedGap: null };
        });
      }
      return report;
    },

    setClipBlendMode: (clipId, blendMode) => {
      get().controller.setClipBlendMode(clipId, blendMode);
    },

    setClipOpacity: (clipId, opacity) => {
      get().controller.setClipOpacity(clipId, opacity);
    },

    setClipFade: (clipId, fadeInFrames, fadeOutFrames) => {
      get().controller.setClipFade(clipId, fadeInFrames, fadeOutFrames);
    },

    setClipTransition: (clipId, transition) => {
      get().controller.setClipTransition(clipId, transition);
    },

    // Selection-wide property edits go through the controller's batched path, so
    // restyling twelve clips is one undo step and one timeline notification.
    setSelectedClipsBlendMode: (blendMode) => {
      const { controller, selectedClipIds } = get();
      controller.setClipsBlendMode(selectedClipIds, blendMode);
    },

    setSelectedClipsOpacity: (opacity) => {
      const { controller, selectedClipIds } = get();
      controller.setClipsOpacity(selectedClipIds, opacity);
    },

    setSelectedClipsFade: (fadeInFrames, fadeOutFrames) => {
      const { controller, selectedClipIds } = get();
      controller.setClipsFade(selectedClipIds, fadeInFrames, fadeOutFrames);
    },

    getSelectedClips: () => {
      const { selectedClipIds } = get();
      return get().getScopeTimeline().clips.filter((clip) => selectedClipIds.has(clip.id));
    },

    removeSilenceForClip: async (clipId, overrides) => {
      const clip = get().getClips().find((c) => c.id === clipId);
      if (!clip) return { removed: 0, error: 'Clip not found' };
      const asset = get().project.media.find((m) => m.id === clip.assetId);
      if (!asset) return { removed: 0, error: 'Source media not found' };

      try {
        const result = await window.palmier.media.detectSilence(asset.path, overrides);
        if (!result.success) return { removed: 0, error: result.error };
        if (!result.ranges || result.ranges.length === 0) {
          return { removed: 0, error: 'No silence detected' };
        }
        // The controller maps these same spans for the cut; mapping here too is
        // what makes the omissions reportable, and the mapped count is what
        // became a cut. A 0 return means the ripple refused (locked anchor), so
        // nothing was cut even when spans mapped.
        const mapping = mapSilenceRangesToTimeline(
          clip,
          get().project.settings.fps,
          result.ranges,
        );
        const committed = get().controller.removeSilence(clipId, result.ranges);
        return {
          removed: committed > 0 ? mapping.ranges.length : 0,
          ...(mapping.omitted.length > 0
            ? { omitted: countOmissions(mapping.omitted) }
            : {}),
        };
      } catch (err: any) {
        return { removed: 0, error: err.message };
      }
    },

    getSelectedClip: () => {
      const { selectedClipIds } = get();
      const selected = get().getScopeTimeline().clips.filter((clip) => selectedClipIds.has(clip.id));
      if (selected.length === 1) return selected[0];
      if (selected.length === 0) return null;

      const linkGroupId = selected[0].linkGroupId;
      if (!linkGroupId || selected.some((clip) => clip.linkGroupId !== linkGroupId)) return null;
      return selected.find((clip) => clip.type !== 'audio') || selected[0];
    },

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Playback Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    setPlayhead: (frame, scopeId?: string | null) => {
      const { controller } = get();
      const target = Math.max(0, frame);
      if (scopeId === undefined) controller.setPlayhead(target);
      else controller.setPlayheadInScope(target, scopeId);
    },

    togglePlayback: () => set((s) => ({ isPlaying: !s.isPlaying })),

    // Normalized at the boundary: a non-finite rate would poison the playback
    // loop's frame accumulator and freeze preview for the session (#212).
    setPlaybackRate: (rate) => set({ playbackRate: normalizePlaybackRate(rate) }),
    toggleLoop: () => set((s) => ({ loopEnabled: !s.loopEnabled })),
    compactTake: (sourceClipId) => get().controller.compactTake(sourceClipId),
    applyLayout: (clipIds, preset) => get().controller.applyLayout(clipIds, preset),

    stepFrame: (delta, scopeId?: string | null) => {
      const current = scopeId === undefined
        ? get().getPlayhead()
        : get().controller.getTimelineInScope(scopeId).playheadFrame;
      get().setPlayhead(Math.max(0, current + delta), scopeId);
    },

    goToStart: () => get().controller.setPlayhead(0),

    // getProjectDuration() carries trailing padding so there is room to drop
    // clips past the end; landing the playhead in that padding is not "the end".
    // Scoped like the lanes: inside a nest, the end is the nest's content end.
    goToEnd: () => get().controller.setPlayhead(timelineContentEnd(get().getClips())),

    goToPreviousEdit: () => {
      const point = previousEditPoint(get().getClips(), get().getPlayhead(), navigationTrackIds(get()));
      if (point !== null) get().controller.setPlayhead(point);
    },

    goToNextEdit: () => {
      const point = nextEditPoint(get().getClips(), get().getPlayhead(), navigationTrackIds(get()));
      if (point !== null) get().controller.setPlayhead(point);
    },

    goToInPoint: () => {
      const { inFrame } = get().getScopeTimeline();
      if (inFrame !== undefined) get().controller.setPlayhead(inFrame);
    },

    goToOutPoint: () => {
      const { outFrame } = get().getScopeTimeline();
      if (outFrame !== undefined) get().controller.setPlayhead(outFrame);
    },

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Undo / Redo Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    undo: () => get().controller.undo(),
    redo: () => get().controller.redo(),

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Viewport Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    zoomIn: () => {
      set((state) => ({
        viewport: {
          ...state.viewport,
          pixelsPerFrame: Math.min(state.viewport.maxPxPerFrame, state.viewport.pixelsPerFrame * 1.5),
        },
      }));
    },

    zoomOut: () => {
      set((state) => ({
        viewport: {
          ...state.viewport,
          pixelsPerFrame: Math.max(state.viewport.minPxPerFrame, state.viewport.pixelsPerFrame / 1.5),
        },
      }));
    },

    setZoom: (pxPerFrame) => {
      set((state) => ({
        viewport: {
          ...state.viewport,
          pixelsPerFrame: Math.max(state.viewport.minPxPerFrame, Math.min(state.viewport.maxPxPerFrame, pxPerFrame)),
        },
      }));
    },

    scrollTo: (frame) => {
      set((state) => ({ viewport: { ...state.viewport, scrollFrame: Math.max(0, frame) } }));
    },

    fitToWindow: (containerWidth) => {
      const duration = get().getProjectDuration();
      if (!Number.isFinite(containerWidth) || duration <= 0 || containerWidth <= 0) return;
      const pxPerFrame = containerWidth / duration;
      set((state) => ({
        viewport: {
          ...state.viewport,
          pixelsPerFrame: Math.max(
            state.viewport.minPxPerFrame,
            Math.min(state.viewport.maxPxPerFrame, pxPerFrame),
          ),
          scrollFrame: 0,
        },
      }));
    },

    setViewportWidth: (width) => {
      if (!Number.isFinite(width) || width < 0) return;
      if (get().viewportWidth === width) return;
      set({ viewportWidth: width });
    },

    fitToViewport: () => {
      const width = get().viewportWidth;
      if (width <= 0) return;
      get().fitToWindow(width);
    },

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Drag Operations Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    startDrag: (mode, clipId, startX, startFrame, ripple = false, singleHalf = false) => {
      const clip = clipId ? get().getClips().find((c) => c.id === clipId) : null;
      set({
        drag: {
          mode,
          clipId,
          startX,
          startFrame,
          originalStartFrame: clip?.startFrame,
          originalInPoint: clip?.inPoint,
          originalOutPoint: clip?.outPoint,
          originalDuration: clip?.durationFrames,
          ripple,
          singleHalf,
          hasAppliedEdit: false,
        },
      });
    },

    updateDrag: (currentX) => {
      const { drag, viewport, controller, snapFrame } = get();
      if (drag.mode === 'none' || !drag.clipId) return;

      const deltaPixels = currentX - drag.startX;
      const deltaFrames = Math.round(deltaPixels / viewport.pixelsPerFrame);
      if (drag.hasAppliedEdit) controller.undo();
      if (deltaFrames === 0) {
        set((state) => ({ drag: { ...state.drag, hasAppliedEdit: false } }));
        return;
      }

      let applied = false;
      if (drag.mode === 'move') {
        const newStart = snapFrame(Math.max(0, drag.startFrame + deltaFrames), drag.clipId);
        controller.moveClip(drag.clipId, newStart);
        applied = true;
      } else if (drag.mode === 'trim-left') {
        applied = controller.trimClipEdge(drag.clipId, 'left', deltaFrames, drag.ripple, drag.singleHalf ? 'single' : 'linked') !== null;
      } else if (drag.mode === 'trim-right') {
        applied = controller.trimClipEdge(drag.clipId, 'right', deltaFrames, drag.ripple, drag.singleHalf ? 'single' : 'linked') !== null;
      }
      set((state) => ({
        drag: {
          ...state.drag,
          hasAppliedEdit: applied,
        },
      }));
    },

    endDrag: () => {
      set({ drag: { mode: 'none', clipId: null, startX: 0, startFrame: 0 } });
    },

    cancelDrag: () => {
      const { drag, controller } = get();
      // Restore original state
      if (drag.hasAppliedEdit) controller.undo();
      set({ drag: { mode: 'none', clipId: null, startX: 0, startFrame: 0 } });
    },

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Snapping Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    getSnapPoints: (excludeClipId) => {
      const clips = get().getClips();
      const playhead = get().getPlayhead();
      const points: SnapPoint[] = [{ frame: playhead, source: 'playhead' }];

      for (const clip of clips) {
        if (clip.id === excludeClipId) continue;
        points.push({ frame: clip.startFrame, source: 'clip-start' });
        points.push({ frame: clip.startFrame + clip.durationFrames, source: 'clip-end' });
      }

      // Marker edges are snap targets (upstream PR #542); the 'marker'
      // source was reserved in the SnapPoint union for exactly this.
      for (const marker of get().controller.getMarkers()) {
        points.push({ frame: marker.startFrame, source: 'marker' });
        const end = marker.startFrame + marker.durationFrames;
        if (marker.durationFrames > 0) points.push({ frame: end, source: 'marker' });
      }

      return points;
    },

    snapFrame: (frame, excludeClipId) => {
      const { snapEnabled, snapThresholdFrames } = get();
      if (!snapEnabled) return frame;

      const points = get().getSnapPoints(excludeClipId);
      let closest = frame;
      let closestDist = Infinity;

      for (const point of points) {
        const dist = Math.abs(frame - point.frame);
        if (dist < closestDist && dist <= snapThresholdFrames) {
          closest = point.frame;
          closestDist = dist;
        }
      }

      return closest;
    },

    toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Project Settings Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    applyProjectSettings: (change) => {
      get().controller.applyProjectSettings(change);
    },

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Project Lifecycle Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    loadProject: (project) => {
      get().controller.loadProject(project);
      set({
        selectedClipIds: new Set(),
        selectedGap: null,
        selectedMarkerIds: new Set(),
        isPlaying: false,
      });
    },

    resetProject: () => {
      get().controller.reset();
      set({
        selectedClipIds: new Set(),
        selectedGap: null,
        selectedMarkerIds: new Set(),
        isPlaying: false,
      });
    },

    syncFromController: () => {
      set({ project: get().controller.getProject() });
    },
  };
});
