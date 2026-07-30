/**
 * Timeline store — Zustand state for the interactive timeline editor.
 * Wraps EditorController for reactive UI updates, manages selection,
 * zoom/scroll viewport, playback state, and drag operations.
 */

import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { EditorController } from '../../shared/editor/controller';
import type { Clip, Track, Frame, Project, MediaAsset } from '../../shared/types/project';
import type { BlendMode } from '../../shared/types/blend-mode';
import type { ClipTransition } from '../../shared/editor/transition';
import type { MediaProbeResult } from '../../main/ipc/media';
import { normalizePlaybackRate } from '../../shared/editor/playback-rate';
import type { SilenceConfig } from '../../shared/audio/silence-detector';
import { nextEditPoint, previousEditPoint, timelineContentEnd } from '../../shared/editor/edit-points';
import { createEmptyProject } from '../../shared/types/project';

// ─── Types ───────────────────────────────────────────────────────────────────

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
  hasAppliedEdit?: boolean;
}

export interface GapSelection {
  trackId: string;
  startFrame: Frame;
  endFrame: Frame;
}

export interface TimelineViewport {
  /** Pixels per frame — controls horizontal zoom */
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
  for (const clip of state.project.timeline.clips) {
    if (state.selectedClipIds.has(clip.id)) trackIds.add(clip.trackId);
  }
  return trackIds.size > 0 ? trackIds : undefined;
}

export interface TimelineState {
  // ─── Core ────────────────────────────────────────────────────────────────
  controller: EditorController;
  project: Project;

  // ─── Selection ───────────────────────────────────────────────────────────
  selectedClipIds: Set<string>;
  hoveredClipId: string | null;
  selectedGap: GapSelection | null;

  // ─── Playback ──────────────────────────────────────────────────────────
  isPlaying: boolean;
  playbackRate: number; // 1 = normal, -1 = reverse, 2 = 2x, etc.

  // ─── Viewport ──────────────────────────────────────────────────────────
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

  // ─── Drag ──────────────────────────────────────────────────────────────
  drag: DragState;
  snapEnabled: boolean;
  snapThresholdFrames: number;

  // ─── Computed / Helpers ────────────────────────────────────────────────
  getClips: () => Clip[];
  getTracks: () => Track[];
  getPlayhead: () => Frame;
  getProjectFps: () => number;
  getProjectDuration: () => Frame;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // ─── Actions ───────────────────────────────────────────────────────────

  // Selection
  selectClip: (clipId: string, additive?: boolean, includeLinked?: boolean) => void;
  selectAllClips: () => void;
  deselectAll: () => void;
  selectClipsInRange: (startFrame: Frame, endFrame: Frame, trackId?: string) => void;
  setHoveredClip: (clipId: string | null) => void;

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
  ) => Promise<{ removed: number; error?: string }>;
  getSelectedClip: () => Clip | null;

  // Playback
  setPlayhead: (frame: Frame) => void;
  togglePlayback: () => void;
  setPlaybackRate: (rate: number) => void;
  stepFrame: (delta: number) => void;
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

// ─── Store ───────────────────────────────────────────────────────────────────

export const useTimelineStore = create<TimelineState>((set, get) => {
  const controller = new EditorController();

  // Subscribe to controller changes
  controller.subscribe((project) => {
    set({ project });
  });

  return {
    controller,
    project: controller.getProject(),

    selectedClipIds: new Set(),
    hoveredClipId: null,
    selectedGap: null,

    isPlaying: false,
    playbackRate: 1,

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

    // ─── Computed ──────────────────────────────────────────────────────────
    getClips: () => get().project.timeline.clips,
    getTracks: () => get().project.timeline.tracks,
    getPlayhead: () => get().project.timeline.playheadFrame,
    getProjectFps: () => get().project.settings.fps,
    getProjectDuration: () => {
      const clips = get().project.timeline.clips;
      if (clips.length === 0) return 300; // default 10s at 30fps
      return Math.max(...clips.map((c) => c.startFrame + c.durationFrames)) + 90;
    },
    canUndo: () => get().controller.canUndo(),
    canRedo: () => get().controller.canRedo(),

    // ─── Selection ─────────────────────────────────────────────────────────
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

    // ─── Editing ───────────────────────────────────────────────────────────
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
      const playhead = controller.getProject().timeline.playheadFrame;
      const clips = controller.getClips();

      // Split selected clips, or all clips under playhead
      const targets = selectedClipIds.size > 0
        ? clips.filter((c) => selectedClipIds.has(c.id))
        : clips;

      for (const clip of targets) {
        const clipEnd = clip.startFrame + clip.durationFrames;
        if (playhead > clip.startFrame && playhead < clipEnd) {
          controller.splitClip(clip.id, playhead);
        }
      }
    },

    rippleDelete: () => {
      const { selectedClipIds, selectedGap, controller, project } = get();
      if (selectedGap) {
        if (controller.rippleDeleteGap(selectedGap.trackId, {
          start: selectedGap.startFrame,
          end: selectedGap.endFrame,
        })) {
          set({ selectedGap: null });
        }
        return;
      }
      const { inFrame, outFrame } = project.timeline;
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
      const { controller, project, selectedClipIds } = get();
      const { inFrame, outFrame } = project.timeline;
      if (inFrame === undefined || outFrame === undefined || outFrame <= inFrame) return;

      const selected = project.timeline.clips.find((clip) => selectedClipIds.has(clip.id));
      const overlappingTrackIds = new Set(
        project.timeline.clips
          .filter((clip) =>
            clip.startFrame < outFrame && clip.startFrame + clip.durationFrames > inFrame
          )
          .map((clip) => clip.trackId),
      );
      const anchorTrack = selected
        ? project.timeline.tracks.find((track) => track.id === selected.trackId)
        : project.timeline.tracks.find((track) =>
            track.type === 'video' && !track.locked && overlappingTrackIds.has(track.id)
          )
          || project.timeline.tracks.find((track) =>
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

    // ─── Tracks ────────────────────────────────────────────────────────────
    addTrack: (type, name) => get().controller.addTrack(type, name),
    setTrackLocked: (trackId, locked) => get().controller.setTrackLocked(trackId, locked),
    setTrackVisible: (trackId, visible) => get().controller.setTrackVisible(trackId, visible),
    setTrackSyncLocked: (trackId, syncLocked) =>
      get().controller.setTrackSyncLocked(trackId, syncLocked),

    // ─── Compositing / properties ──────────────────────────────────────────
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
      const { selectedClipIds, project } = get();
      return project.timeline.clips.filter((clip) => selectedClipIds.has(clip.id));
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
        const removed = get().controller.removeSilence(clipId, result.ranges);
        return { removed };
      } catch (err: any) {
        return { removed: 0, error: err.message };
      }
    },

    getSelectedClip: () => {
      const { selectedClipIds, project } = get();
      const selected = project.timeline.clips.filter((clip) => selectedClipIds.has(clip.id));
      if (selected.length === 1) return selected[0];
      if (selected.length === 0) return null;

      const linkGroupId = selected[0].linkGroupId;
      if (!linkGroupId || selected.some((clip) => clip.linkGroupId !== linkGroupId)) return null;
      return selected.find((clip) => clip.type !== 'audio') || selected[0];
    },

    // ─── Playback ──────────────────────────────────────────────────────────
    setPlayhead: (frame) => {
      get().controller.setPlayhead(Math.max(0, frame));
    },

    togglePlayback: () => set((s) => ({ isPlaying: !s.isPlaying })),

    // Normalized at the boundary: a non-finite rate would poison the playback
    // loop's frame accumulator and freeze preview for the session (#212).
    setPlaybackRate: (rate) => set({ playbackRate: normalizePlaybackRate(rate) }),

    stepFrame: (delta) => {
      const current = get().getPlayhead();
      get().controller.setPlayhead(Math.max(0, current + delta));
    },

    goToStart: () => get().controller.setPlayhead(0),

    // getProjectDuration() carries trailing padding so there is room to drop
    // clips past the end; landing the playhead in that padding is not "the end".
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
      const { inFrame } = get().project.timeline;
      if (inFrame !== undefined) get().controller.setPlayhead(inFrame);
    },

    goToOutPoint: () => {
      const { outFrame } = get().project.timeline;
      if (outFrame !== undefined) get().controller.setPlayhead(outFrame);
    },

    // ─── Undo / Redo ───────────────────────────────────────────────────────
    undo: () => get().controller.undo(),
    redo: () => get().controller.redo(),

    // ─── Viewport ──────────────────────────────────────────────────────────
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

    // ─── Drag Operations ───────────────────────────────────────────────────
    startDrag: (mode, clipId, startX, startFrame, ripple = false) => {
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
        applied = controller.trimClipEdge(drag.clipId, 'left', deltaFrames, drag.ripple) !== null;
      } else if (drag.mode === 'trim-right') {
        applied = controller.trimClipEdge(drag.clipId, 'right', deltaFrames, drag.ripple) !== null;
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

    // ─── Snapping ──────────────────────────────────────────────────────────
    getSnapPoints: (excludeClipId) => {
      const clips = get().getClips();
      const playhead = get().getPlayhead();
      const points: SnapPoint[] = [{ frame: playhead, source: 'playhead' }];

      for (const clip of clips) {
        if (clip.id === excludeClipId) continue;
        points.push({ frame: clip.startFrame, source: 'clip-start' });
        points.push({ frame: clip.startFrame + clip.durationFrames, source: 'clip-end' });
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

    // ─── Project Settings ──────────────────────────────────────────────────
    applyProjectSettings: (change) => {
      get().controller.applyProjectSettings(change);
    },

    // ─── Project Lifecycle ─────────────────────────────────────────────────
    loadProject: (project) => {
      get().controller.loadProject(project);
      set({ selectedClipIds: new Set(), selectedGap: null, isPlaying: false });
    },

    resetProject: () => {
      get().controller.reset();
      set({ selectedClipIds: new Set(), selectedGap: null, isPlaying: false });
    },

    syncFromController: () => {
      set({ project: get().controller.getProject() });
    },
  };
});
