/**
 * Timeline store — Zustand state for the interactive timeline editor.
 * Wraps EditorController for reactive UI updates, manages selection,
 * zoom/scroll viewport, playback state, and drag operations.
 */

import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { EditorController } from '../../shared/editor/controller';
import type { Clip, Track, Frame, Project } from '../../shared/types/project';
import type { BlendMode } from '../../shared/types/blend-mode';
import type { ClipTransition } from '../../shared/editor/transition';
import type { MediaProbeResult } from '../../main/ipc/media';
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

export interface TimelineState {
  // ─── Core ────────────────────────────────────────────────────────────────
  controller: EditorController;
  project: Project;

  // ─── Selection ───────────────────────────────────────────────────────────
  selectedClipIds: Set<string>;
  hoveredClipId: string | null;

  // ─── Playback ──────────────────────────────────────────────────────────
  isPlaying: boolean;
  playbackRate: number; // 1 = normal, -1 = reverse, 2 = 2x, etc.

  // ─── Viewport ──────────────────────────────────────────────────────────
  viewport: TimelineViewport;

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
  selectClip: (clipId: string, additive?: boolean) => void;
  deselectAll: () => void;
  selectClipsInRange: (startFrame: Frame, endFrame: Frame, trackId?: string) => void;
  setHoveredClip: (clipId: string | null) => void;

  // Editing
  addClip: (assetId: string, trackId: string, startFrame: Frame, durationFrames?: Frame) => string;
  removeSelectedClips: () => void;
  moveClip: (clipId: string, newStartFrame: Frame, newTrackId?: string) => void;
  trimClipLeft: (clipId: string, newInPoint: Frame, newDuration: Frame) => void;
  trimClipRight: (clipId: string, newOutPoint: Frame, newDuration: Frame) => void;
  splitAtPlayhead: () => void;
  rippleDelete: () => void;

  // Tracks
  addTrack: (type: 'video' | 'audio', name?: string) => string;

  // Compositing / properties
  importAssets: (probeResults: MediaProbeResult[]) => string[];
  setClipBlendMode: (clipId: string, blendMode: BlendMode) => void;
  setClipOpacity: (clipId: string, opacity: number) => void;
  setClipFade: (clipId: string, fadeInFrames?: Frame, fadeOutFrames?: Frame) => void;
  setClipTransition: (clipId: string, transition: ClipTransition | null) => void;
  removeSilenceForClip: (clipId: string) => Promise<{ removed: number; error?: string }>;
  getSelectedClip: () => Clip | null;

  // Playback
  setPlayhead: (frame: Frame) => void;
  togglePlayback: () => void;
  setPlaybackRate: (rate: number) => void;
  stepFrame: (delta: number) => void;

  // Undo/Redo
  undo: () => void;
  redo: () => void;

  // Viewport
  zoomIn: () => void;
  zoomOut: () => void;
  setZoom: (pxPerFrame: number) => void;
  scrollTo: (frame: Frame) => void;
  fitToWindow: (containerWidth: number) => void;

  // Drag operations
  startDrag: (mode: DragMode, clipId: string | null, startX: number, startFrame: Frame) => void;
  updateDrag: (currentX: number) => void;
  endDrag: () => void;
  cancelDrag: () => void;

  // Snapping
  getSnapPoints: (excludeClipId?: string) => SnapPoint[];
  snapFrame: (frame: Frame, excludeClipId?: string) => Frame;

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

    isPlaying: false,
    playbackRate: 1,

    viewport: {
      pixelsPerFrame: 4,
      scrollFrame: 0,
      minPxPerFrame: 0.5,
      maxPxPerFrame: 30,
    },

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
    selectClip: (clipId, additive = false) => {
      set((state) => {
        const next = new Set(additive ? state.selectedClipIds : []);
        if (next.has(clipId)) {
          next.delete(clipId);
        } else {
          next.add(clipId);
        }
        return { selectedClipIds: next };
      });
    },

    deselectAll: () => set({ selectedClipIds: new Set() }),

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
      set({ selectedClipIds: new Set(ids) });
    },

    setHoveredClip: (clipId) => set({ hoveredClipId: clipId }),

    // ─── Editing ───────────────────────────────────────────────────────────
    addClip: (assetId, trackId, startFrame, durationFrames) => {
      const { controller } = get();
      return controller.addClip({ assetId, trackId, startFrame, durationFrames });
    },

    removeSelectedClips: () => {
      const { selectedClipIds, controller } = get();
      for (const id of selectedClipIds) {
        controller.removeClip(id);
      }
      set({ selectedClipIds: new Set() });
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
      const { selectedClipIds, controller } = get();
      if (selectedClipIds.size === 0) return;

      const clips = controller.getClips();
      const selected = clips.filter((c) => selectedClipIds.has(c.id));
      if (selected.length === 0) return;

      // Group by track and find the gap to close
      const trackGaps = new Map<string, { start: Frame; duration: Frame }>();
      for (const clip of selected) {
        const existing = trackGaps.get(clip.trackId);
        if (!existing || clip.startFrame < existing.start) {
          trackGaps.set(clip.trackId, { start: clip.startFrame, duration: clip.durationFrames });
        }
      }

      // Remove selected clips
      for (const id of selectedClipIds) {
        controller.removeClip(id);
      }

      // Ripple: shift subsequent clips left to close the gap
      for (const [trackId, gap] of trackGaps) {
        const remaining = controller.getClips()
          .filter((c) => c.trackId === trackId && c.startFrame >= gap.start)
          .sort((a, b) => a.startFrame - b.startFrame);

        for (const clip of remaining) {
          controller.moveClip(clip.id, clip.startFrame - gap.duration);
        }
      }

      set({ selectedClipIds: new Set() });
    },

    // ─── Tracks ────────────────────────────────────────────────────────────
    addTrack: (type, name) => get().controller.addTrack(type, name),

    // ─── Compositing / properties ──────────────────────────────────────────
    importAssets: (probeResults) => {
      const { controller } = get();
      const fps = controller.getProject().settings.fps;
      const ids: string[] = [];
      for (const p of probeResults) {
        const id = nanoid();
        ids.push(id);
        controller.addMedia({
          id,
          path: p.path,
          filename: p.filename,
          type: p.type,
          // MediaProbeResult.duration is in seconds; the asset model is frame-based.
          duration: Math.max(0, Math.round((p.duration || 0) * fps)),
          width: p.width,
          height: p.height,
          fps: p.fps,
          codec: p.codec,
          audioCodec: p.audioCodec,
          sampleRate: p.sampleRate,
          channels: p.channels,
          fileSize: p.fileSize,
          addedAt: new Date().toISOString(),
        });
      }
      return ids;
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

    removeSilenceForClip: async (clipId) => {
      const clip = get().getClips().find((c) => c.id === clipId);
      if (!clip) return { removed: 0, error: 'Clip not found' };
      const asset = get().project.media.find((m) => m.id === clip.assetId);
      if (!asset) return { removed: 0, error: 'Source media not found' };

      try {
        const result = await window.palmier.media.detectSilence(asset.path);
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
      if (selectedClipIds.size !== 1) return null;
      const [id] = Array.from(selectedClipIds);
      return project.timeline.clips.find((c) => c.id === id) || null;
    },

    // ─── Playback ──────────────────────────────────────────────────────────
    setPlayhead: (frame) => {
      get().controller.setPlayhead(Math.max(0, frame));
    },

    togglePlayback: () => set((s) => ({ isPlaying: !s.isPlaying })),

    setPlaybackRate: (rate) => set({ playbackRate: rate }),

    stepFrame: (delta) => {
      const current = get().getPlayhead();
      get().controller.setPlayhead(Math.max(0, current + delta));
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
      if (duration <= 0 || containerWidth <= 0) return;
      const pxPerFrame = containerWidth / duration;
      set((state) => ({
        viewport: { ...state.viewport, pixelsPerFrame: Math.max(state.viewport.minPxPerFrame, pxPerFrame), scrollFrame: 0 },
      }));
    },

    // ─── Drag Operations ───────────────────────────────────────────────────
    startDrag: (mode, clipId, startX, startFrame) => {
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
        },
      });
    },

    updateDrag: (currentX) => {
      const { drag, viewport, controller, snapFrame } = get();
      if (drag.mode === 'none' || !drag.clipId) return;

      const deltaPixels = currentX - drag.startX;
      const deltaFrames = Math.round(deltaPixels / viewport.pixelsPerFrame);

      if (drag.mode === 'move') {
        const newStart = snapFrame(Math.max(0, drag.startFrame + deltaFrames), drag.clipId);
        controller.moveClip(drag.clipId, newStart);
      } else if (drag.mode === 'trim-left') {
        const clip = controller.getClips().find((c) => c.id === drag.clipId);
        if (!clip || drag.originalInPoint === undefined || drag.originalDuration === undefined) return;
        const newIn = Math.max(0, drag.originalInPoint + deltaFrames);
        const newDuration = drag.originalDuration - deltaFrames;
        if (newDuration > 1) {
          controller.trimClip(drag.clipId, newIn, newIn + newDuration);
        }
      } else if (drag.mode === 'trim-right') {
        const clip = controller.getClips().find((c) => c.id === drag.clipId);
        if (!clip || drag.originalOutPoint === undefined || drag.originalDuration === undefined) return;
        const newDuration = Math.max(1, drag.originalDuration + deltaFrames);
        const newOut = (drag.originalInPoint || 0) + newDuration;
        controller.trimClip(drag.clipId, drag.originalInPoint || 0, newOut);
      }
    },

    endDrag: () => {
      set({ drag: { mode: 'none', clipId: null, startX: 0, startFrame: 0 } });
    },

    cancelDrag: () => {
      const { drag, controller } = get();
      // Restore original state
      if (drag.clipId && drag.originalStartFrame !== undefined) {
        if (drag.mode === 'move') {
          controller.undo();
        } else if (drag.mode === 'trim-left' || drag.mode === 'trim-right') {
          controller.undo();
        }
      }
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

    // ─── Project Lifecycle ─────────────────────────────────────────────────
    loadProject: (project) => {
      get().controller.loadProject(project);
      set({ selectedClipIds: new Set(), isPlaying: false });
    },

    resetProject: () => {
      get().controller.reset();
      set({ selectedClipIds: new Set(), isPlaying: false });
    },

    syncFromController: () => {
      set({ project: get().controller.getProject() });
    },
  };
});
