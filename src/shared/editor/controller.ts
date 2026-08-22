/**
 * EditorController ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the single command surface for all editing operations.
 *
 * The UI, the AI agent, and the MCP server all call these methods.
 * Every mutation goes through execute(), making it undoable and auditable.
 */

import { nanoid } from 'nanoid';
import type {
  Project,
  Clip,
  Track,
  Timeline,
  Frame,
  MediaAsset,
  ClipType,
} from '../types/project';
import { MAX_CANVAS_EDGE } from '../project/aspect-ratio';
import { createEmptyProject } from '../types/project';
import { clampFrame, asValidFrame } from '../utils/safe-number';
import {
  CommandHistory,
  AddClipCommand,
  AddMediaAndClipsCommand,
  AddTrackCommand,
  SetClipPropertiesCommand,
  ReplaceClipsCommand,
  ReplaceTracksCommand,
  ReplaceProjectCommand,
  ReplaceMarkersCommand,
} from './commands';
import type { Command } from './commands';
import type { BlendMode } from '../types/blend-mode';
import type { ClipTransition } from './transition';
import { planSilenceRemoval, type FrameRange, type SilentRange } from '../audio/silence-detector';
import { resolveTrackName, TRACK_NAME_MAX_LENGTH } from './track-name';
import {
  MARKER_DEFAULT_COLOR,
  mapMarkersOpeningAt,
  mapMarkersThroughClosingHoles,
  rescaleMarker,
  sortMarkers,
  validateMarker,
  type TimelineMarker,
} from './markers';
import { hasEmbeddedAudio, isMediaCompatibleWithTrack, placementDuration } from './placement';

/**
 * One copied clip and its position relative to the copy anchor ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the
 * Windows translation of upstream's `ClipClipboardEntry` (R1 clipboard).
 */
interface ClipClipboardEntry {
  clip: Clip;
  /** Array-index distance from the topmost copied track. */
  trackOffset: number;
  /** Frame distance from the earliest copied start. */
  frameOffset: number;
  sourceTrackId: string;
}
import { computeRippleShifts, mergeRippleRanges, type RippleRange } from './ripple';

export type StateChangeListener = (project: Project) => void;

export interface MediaPlacementResult {
  assetIds: string[];
  clipIds: string[];
}

export interface RippleDeleteReport {
  removedClipIds: string[];
  shiftedClipIds: string[];
}

export type TrimEdge = 'left' | 'right';

export interface RippleTrimReport {
  resizedClipIds: string[];
  shiftedClipIds: string[];
  durationDelta: Frame;
}

/** Highest project frame rate the timeline math is validated for. */
export const MAX_PROJECT_FPS = 240;

/** Result of a project-settings change: the applied values and what moved. */
export interface ProjectSettingsReport {
  fps: number;
  width: number;
  height: number;
  changed: ('fps' | 'resolution')[];
}

/**
 * Outcome of a batched clip-property edit.
 *
 * `changedClipIds` are the clips actually written (all in one undo step);
 * `skippedClipIds` are requested ids that did not resolve to a clip or that the
 * property is not valid for ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â e.g. a blend mode aimed at an audio clip. A
 * request that resolves but changes nothing appears in neither list.
 */
export interface BulkClipPropertyReport {
  changedClipIds: string[];
  skippedClipIds: string[];
}

export interface RippleRangesReport {
  removedFrames: Frame;
  clearedTrackIds: string[];
  removedClipIds: string[];
  fragmentClipIds: string[];
  shiftedClipIds: string[];
}

/**
 * True when two clips carry the same own properties. Property mutators may
 * delete keys (a cleared fade, a 'normal' blend mode), so key sets are compared
 * as well as values. Clip properties are all primitives apart from
 * `transitionIn`, which is replaced wholesale rather than edited in place.
 */
function clipsShallowEqual(a: Clip, b: Clip): boolean {
  const aKeys = Object.keys(a) as (keyof Clip)[];
  const bKeys = Object.keys(b) as (keyof Clip)[];
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}

/**
 * Rescale every frame-valued field in a timeline by `scale`.
 *
 * Translation of upstream's `Timeline.rescaleFrames(by:)`. Clips are walked in
 * timeline order per track so a clip whose rounded start would land inside its
 * rescaled predecessor is pushed to that predecessor's end instead of
 * overlapping it, and every clip keeps at least one frame of duration.
 */
function rescaleTimelineFrames(timeline: Timeline, scale: number): Timeline {
  if (!Number.isFinite(scale) || scale <= 0) return timeline;

  const rescaled = new Map<string, Clip>();
  const byTrack = new Map<string, Clip[]>();
  for (const clip of timeline.clips) {
    const bucket = byTrack.get(clip.trackId);
    if (bucket) bucket.push(clip);
    else byTrack.set(clip.trackId, [clip]);
  }

  for (const clips of byTrack.values()) {
    let previousEnd: Frame | null = null;
    for (const clip of [...clips].sort((a, b) => a.startFrame - b.startFrame)) {
      const scaledStart = clampFrame(Math.round(clip.startFrame * scale), 0);
      const scaledEnd = clampFrame(
        Math.round((clip.startFrame + clip.durationFrames) * scale),
        0,
      );
      const startFrame: Frame =
        previousEnd === null ? scaledStart : Math.max(scaledStart, previousEnd);
      const durationFrames = clampFrame(Math.max(1, scaledEnd - startFrame), 1);

      const next: Clip = {
        ...clip,
        startFrame,
        durationFrames,
        inPoint: clampFrame(Math.round(clip.inPoint * scale), 0),
        outPoint: clampFrame(Math.round(clip.outPoint * scale), 0),
      };
      if (clip.fadeInFrames !== undefined) {
        const value = Math.min(durationFrames, clampFrame(Math.round(clip.fadeInFrames * scale), 0));
        if (value > 0) next.fadeInFrames = value;
        else delete next.fadeInFrames;
      }
      if (clip.fadeOutFrames !== undefined) {
        const value = Math.min(durationFrames, clampFrame(Math.round(clip.fadeOutFrames * scale), 0));
        if (value > 0) next.fadeOutFrames = value;
        else delete next.fadeOutFrames;
      }
      if (clip.transitionIn) {
        next.transitionIn = {
          ...clip.transitionIn,
          frames: Math.min(
            durationFrames,
            clampFrame(Math.round(clip.transitionIn.frames * scale), 1),
          ),
        };
      }

      rescaled.set(clip.id, next);
      previousEnd = startFrame + durationFrames;
    }
  }

  const scaleMarker = (frame: Frame | undefined): Frame | undefined =>
    frame === undefined ? undefined : clampFrame(Math.round(frame * scale), 0);

  const next: Timeline = {
    ...timeline,
    clips: timeline.clips.map((clip) => rescaled.get(clip.id) ?? clip),
    // Markers follow the project timebase change like every other frame
    // value (upstream PR #542's rescaleFrames hook).
    ...(timeline.markers
      ? { markers: timeline.markers.map((marker) => rescaleMarker(marker, scale)) }
      : {}),
    playheadFrame: clampFrame(Math.round(timeline.playheadFrame * scale), 0),
  };
  const inFrame = scaleMarker(timeline.inFrame);
  const outFrame = scaleMarker(timeline.outFrame);
  if (inFrame === undefined) delete next.inFrame;
  else next.inFrame = inFrame;
  if (outFrame === undefined) delete next.outFrame;
  else next.outFrame = outFrame;
  return next;
}

/**
 * Re-fit one clip's geometry from the old canvas to the new one.
 *
 * A clip that exactly filled the old canvas at unit scale is an auto-fit clip
 * and is re-fitted to fill the new canvas. Anything the user placed or scaled
 * keeps its relative position and size, scaled per axis.
 */
function refitClipToCanvas(
  clip: Clip,
  previousWidth: number,
  previousHeight: number,
  width: number,
  height: number,
): Clip {
  if (previousWidth <= 0 || previousHeight <= 0) return clip;

  const fillsCanvas =
    clip.x === 0
    && clip.y === 0
    && clip.width === previousWidth
    && clip.height === previousHeight
    && clip.scaleX === 1
    && clip.scaleY === 1;
  if (fillsCanvas) {
    return clip.width === width && clip.height === height ? clip : { ...clip, width, height };
  }

  const scaleX = width / previousWidth;
  const scaleY = height / previousHeight;
  const next: Clip = {
    ...clip,
    x: Math.round(clip.x * scaleX),
    y: Math.round(clip.y * scaleY),
    width: Math.max(1, Math.round(clip.width * scaleX)),
    height: Math.max(1, Math.round(clip.height * scaleY)),
    anchorX: Math.round(clip.anchorX * scaleX),
    anchorY: Math.round(clip.anchorY * scaleY),
  };
  return clipsShallowEqual(clip, next) ? clip : next;
}

/**
 * The automatic `Video N` / `Audio N` label for a track's position among
 * tracks of its type, computed against an explicit track list so rename
 * batching can resolve fallbacks against its own working copy.
 */
function generatedTrackLabelIn(track: Track, tracks: readonly Track[]): string {
  const sameType = tracks
    .filter((candidate) => candidate.type === track.type)
    .sort((a, b) => a.order - b.order);
  const position = Math.max(0, sameType.findIndex((candidate) => candidate.id === track.id)) + 1;
  return `${track.type === 'video' ? 'Video' : 'Audio'} ${position}`;
}

export class EditorController {  private project: Project;
  private history: CommandHistory;
  private listeners: Set<StateChangeListener> = new Set();
  /**
   * Clip lookups by id, valid only for the exact project object it was built
   * from (upstream PR #486). Every mutation ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â command execution, undo, redo,
   * restore ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â replaces `this.project` wholesale, so reference identity is a
   * complete invalidation signal and no revision counter is needed. First
   * occurrence wins per id, matching what the linear `Array.find` it replaced
   * returned.
   */
  private clipByIdCache?: { project: Project; byId: Map<string, Clip> };
  /** In-app clipboard for copy/cut/paste (R1). Not OS-shared by design. */
  private clipClipboard: ClipClipboardEntry[] = [];

  constructor(project?: Project) {
    this.project = project || createEmptyProject();
    this.history = new CommandHistory();
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ State access ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  getProject(): Project {
    return this.project;
  }

  getTimeline() {
    return this.project.timeline;
  }

  getClips(): Clip[] {
    return this.project.timeline.clips;
  }

  getTracks(): Track[] {
    return this.project.timeline.tracks;
  }

  getMedia(): MediaAsset[] {
    return this.project.media;
  }

  expandLinkedClipIds(clipIds: Iterable<string>): string[] {
    const requested = new Set(clipIds);
    const groupIds = new Set(
      this.project.timeline.clips
        .filter((clip) => requested.has(clip.id) && clip.linkGroupId)
        .map((clip) => clip.linkGroupId!),
    );

    for (const clip of this.project.timeline.clips) {
      if (clip.linkGroupId && groupIds.has(clip.linkGroupId)) {
        requested.add(clip.id);
      }
    }
    return [...requested];
  }

  /** O(1) clip lookup, rebuilt lazily once per project revision (#486). */
  private findClipById(clipId: string): Clip | undefined {
    let cache = this.clipByIdCache;
    if (!cache || cache.project !== this.project) {
      const byId = new Map<string, Clip>();
      for (const clip of this.project.timeline.clips) {
        if (!byId.has(clip.id)) byId.set(clip.id, clip);
      }
      cache = { project: this.project, byId };
      this.clipByIdCache = cache;
    }
    return cache.byId.get(clipId);
  }

  private canEditClipIds(clipIds: Iterable<string>): boolean {
    const ids = new Set(clipIds);
    const lockedTrackIds = new Set(
      this.project.timeline.tracks.filter((track) => track.locked).map((track) => track.id),
    );
    return this.project.timeline.clips
      .filter((clip) => ids.has(clip.id))
      .every((clip) => !lockedTrackIds.has(clip.trackId));
  }

  getPlayhead(): Frame {
    return this.project.timeline.playheadFrame;
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Command execution ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  execute(command: Command): void {
    this.project = this.history.execute(command, this.project);
    this.notify();
  }

  undo(): boolean {
    const result = this.history.undo(this.project);
    if (result) {
      this.project = result;
      this.notify();
      return true;
    }
    return false;
  }

  redo(): boolean {
    const result = this.history.redo(this.project);
    if (result) {
      this.project = result;
      this.notify();
      return true;
    }
    return false;
  }

  canUndo(): boolean {
    return this.history.canUndo();
  }

  canRedo(): boolean {
    return this.history.canRedo();
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ High-level editing API (used by UI, agent, MCP) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  addClip(params: {
    assetId: string;
    trackId: string;
    startFrame: Frame;
    type?: ClipType;
    durationFrames?: Frame;
  }): string {
    const asset = this.project.media.find((m) => m.id === params.assetId);
    // Guard every numeric input: a non-finite or out-of-range frame/duration
    // would otherwise corrupt timeline math or downstream loop bounds (#200).
    const startFrame = clampFrame(params.startFrame);
    const duration = clampFrame(params.durationFrames || asset?.duration || 150, 1); // default 5s at 30fps
    const type = params.type || asset?.type || 'video';
    const track = this.project.timeline.tracks.find((candidate) => candidate.id === params.trackId);

    // Refuse an unknown track rather than placing a clip nothing can reach.
    // Tracks are what the timeline, the compositor and the exporter all iterate,
    // so a clip naming a track that does not exist is invisible everywhere while
    // still counting in the clip list and toward the project duration ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â and the
    // caller was told the placement succeeded. An agent inventing a track id is
    // the realistic way in, which is the mis-targeting class upstream closed in
    // PR #307 (#302).
    if (!track) return '';

    if (asset) {
      const tracks: Track[] = [];
      const linkGroupId = type === 'video'
        && track?.type === 'video'
        && hasEmbeddedAudio(asset)
        ? nanoid()
        : undefined;
      const clip = this.createPlacedClip(
        asset,
        type,
        params.trackId,
        startFrame,
        duration,
        linkGroupId,
      );
      const clips = [clip];

      if (linkGroupId) {
        const audioTrack = this.resolveAudioPlacementTrack(startFrame, duration, clips, tracks);
        clips.push(
          this.createPlacedClip(asset, 'audio', audioTrack.id, startFrame, duration, linkGroupId),
        );
      }

      this.execute(new AddMediaAndClipsCommand([], clips, 'Add clip', tracks));
      return clip.id;
    }

    const clip = this.createPlacedClip(
      {
        id: params.assetId,
        path: '',
        filename: params.assetId,
        type: type === 'audio' || type === 'image' ? type : 'video',
        duration,
        fileSize: 0,
        addedAt: new Date().toISOString(),
      },
      type,
      params.trackId,
      startFrame,
      duration,
    );
    this.execute(new AddClipCommand(clip));
    return clip.id;
  }

  removeClip(clipId: string): boolean {
    return this.removeClips([clipId]);
  }

  removeClips(clipIds: Iterable<string>, includeLinked = true): boolean {
    const requested = [...clipIds];
    const ids = new Set(includeLinked ? this.expandLinkedClipIds(requested) : requested);
    if (!this.project.timeline.clips.some((clip) => ids.has(clip.id))) return false;
    if (!this.canEditClipIds(ids)) return false;
    this.execute(
      new ReplaceClipsCommand(
        this.project.timeline.clips.filter((clip) => !ids.has(clip.id)),
        ids.size > 1 ? 'Remove linked clips' : 'Remove clip',
      ),
    );
    return true;
  }

  rippleDeleteClips(clipIds: Iterable<string>): RippleDeleteReport | null {
    const ids = new Set(this.expandLinkedClipIds(clipIds));
    const selected = this.project.timeline.clips.filter((clip) => ids.has(clip.id));
    if (selected.length === 0 || !this.canEditClipIds(ids)) return null;

    const globalRanges: RippleRange[] = selected.map((clip) => ({
      start: clip.startFrame,
      end: clip.startFrame + clip.durationFrames,
    }));
    const shifts = new Map<string, Frame>();
    const trackHoles: RippleRange[][] = [];

    for (const track of this.project.timeline.tracks) {
      if (track.locked) continue;

      const removedOnTrack = selected.filter((clip) => clip.trackId === track.id);
      const ranges = removedOnTrack.length > 0
        ? removedOnTrack.map((clip) => ({
            start: clip.startFrame,
            end: clip.startFrame + clip.durationFrames,
          }))
        : track.syncLocked !== false
          ? globalRanges
          : [];
      if (ranges.length === 0) continue;
      trackHoles.push(ranges);

      const remaining = this.project.timeline.clips.filter(
        (clip) => clip.trackId === track.id && !ids.has(clip.id),
      );
      for (const shift of computeRippleShifts(remaining, ranges)) {
        shifts.set(shift.clipId, shift.startFrame);
      }
    }

    const clips = this.project.timeline.clips
      .filter((clip) => !ids.has(clip.id))
      .map((clip) => {
        const startFrame = shifts.get(clip.id);
        return startFrame === undefined ? clip : { ...clip, startFrame };
      });
    this.executeRipple(clips, this.rippleMarkersClosing(trackHoles), 'Ripple delete clips');

    return {
      removedClipIds: selected.map((clip) => clip.id),
      shiftedClipIds: [...shifts.keys()],
    };
  }

  rippleDeleteGap(trackId: string, range: RippleRange): RippleDeleteReport | null {
    const track = this.project.timeline.tracks.find((candidate) => candidate.id === trackId);
    const start = asValidFrame(range.start);
    const end = asValidFrame(range.end);
    if (!track || track.locked || start === null || end === null || end <= start) return null;

    const anchorClips = this.project.timeline.clips.filter((clip) => clip.trackId === trackId);
    if (anchorClips.some((clip) =>
      clip.startFrame < end && clip.startFrame + clip.durationFrames > start
    )) {
      return null;
    }

    const shifts = new Map<string, Frame>();
    for (const candidate of this.project.timeline.tracks) {
      if (candidate.locked || (candidate.id !== trackId && candidate.syncLocked === false)) continue;
      const clips = this.project.timeline.clips.filter((clip) => clip.trackId === candidate.id);
      const moving = clips.filter((clip) => clip.startFrame >= end);
      if (moving.length === 0) continue;

      const shift = end - start;
      const stationaryEnd = clips
        .filter((clip) => clip.startFrame < end)
        .reduce((latest, clip) => Math.max(latest, clip.startFrame + clip.durationFrames), 0);
      const firstMovingStart = Math.min(...moving.map((clip) => clip.startFrame));
      if (firstMovingStart - shift < stationaryEnd) return null;

      for (const clip of moving) shifts.set(clip.id, clip.startFrame - shift);
    }

    if (shifts.size === 0) return null;
    const clips = this.project.timeline.clips.map((clip) => {
      const startFrame = shifts.get(clip.id);
      return startFrame === undefined ? clip : { ...clip, startFrame };
    });
    this.executeRipple(
      clips,
      this.rippleMarkersClosing([[{ start, end }]]),
      'Ripple delete gap',
    );
    return { removedClipIds: [], shiftedClipIds: [...shifts.keys()] };
  }

  rippleDeleteRanges(trackId: string, ranges: RippleRange[]): RippleRangesReport | null {
    const anchorTrack = this.project.timeline.tracks.find((track) => track.id === trackId);
    const validRanges = ranges.flatMap((range) => {
      const start = asValidFrame(range.start);
      const end = asValidFrame(range.end);
      return start !== null && end !== null && end > start ? [{ start, end }] : [];
    });
    const merged = mergeRippleRanges(validRanges);
    if (!anchorTrack || anchorTrack.locked || merged.length === 0) return null;

    const clearTrackIds = new Set(
      this.project.timeline.tracks
        .filter((track) => track.id === trackId || track.syncLocked !== false)
        .map((track) => track.id),
    );

    // A linked partner follows the cut even when its track opted out of sync lock.
    let expanded = true;
    while (expanded) {
      expanded = false;
      const overlappingGroupIds = new Set(
        this.project.timeline.clips
          .filter((clip) =>
            clearTrackIds.has(clip.trackId)
            && clip.linkGroupId
            && merged.some((range) =>
              range.start < clip.startFrame + clip.durationFrames && range.end > clip.startFrame
            ),
          )
          .map((clip) => clip.linkGroupId!),
      );
      for (const clip of this.project.timeline.clips) {
        if (
          clip.linkGroupId
          && overlappingGroupIds.has(clip.linkGroupId)
          && !clearTrackIds.has(clip.trackId)
        ) {
          clearTrackIds.add(clip.trackId);
          expanded = true;
        }
      }
    }

    if (this.project.timeline.tracks.some((track) =>
      clearTrackIds.has(track.id) && track.locked
    )) {
      return null;
    }

    const removedClipIds: string[] = [];
    const fragmentClipIds: string[] = [];
    const shiftedClipIds: string[] = [];
    const fragmentGroups = new Map<string, string>();
    let changed = false;

    const clips = this.project.timeline.clips.flatMap((clip) => {
      if (!clearTrackIds.has(clip.trackId)) return [clip];

      const clipStart = clip.startFrame;
      const clipEnd = clip.startFrame + clip.durationFrames;
      const intersections = merged
        .map((range) => ({
          start: Math.max(clipStart, range.start),
          end: Math.min(clipEnd, range.end),
        }))
        .filter((range) => range.end > range.start);

      if (intersections.length === 0) {
        const shift = merged
          .filter((range) => range.end <= clip.startFrame)
          .reduce((total, range) => total + range.end - range.start, 0);
        if (shift === 0) return [clip];
        changed = true;
        shiftedClipIds.push(clip.id);
        return [{ ...clip, startFrame: clip.startFrame - shift }];
      }

      const kept: RippleRange[] = [];
      let cursor = clipStart;
      for (const intersection of intersections) {
        if (intersection.start > cursor) kept.push({ start: cursor, end: intersection.start });
        cursor = Math.max(cursor, intersection.end);
      }
      if (cursor < clipEnd) kept.push({ start: cursor, end: clipEnd });

      changed = true;
      if (kept.length === 0) {
        removedClipIds.push(clip.id);
        return [];
      }

      return kept.map((segment, index) => {
        const shift = merged
          .filter((range) => range.end <= segment.start)
          .reduce((total, range) => total + range.end - range.start, 0);
        const id = index === 0 ? clip.id : nanoid();
        if (index > 0) fragmentClipIds.push(id);
        const linkGroupId = clip.linkGroupId
          ? (() => {
              const key = `${clip.linkGroupId}:${segment.start}:${segment.end}`;
              const existing = fragmentGroups.get(key);
              if (existing) return existing;
              const created = nanoid();
              fragmentGroups.set(key, created);
              return created;
            })()
          : undefined;
        return {
          ...clip,
          id,
          linkGroupId,
          startFrame: segment.start - shift,
          durationFrames: segment.end - segment.start,
          inPoint: clip.inPoint + segment.start - clipStart,
          outPoint: clip.inPoint + segment.end - clipStart,
          fadeInFrames: segment.start === clipStart ? clip.fadeInFrames : 0,
          fadeOutFrames: segment.end === clipEnd ? clip.fadeOutFrames : 0,
          transitionIn: segment.start === clipStart ? clip.transitionIn : undefined,
        };
      });
    });

    if (!changed) return null;
    const markers = this.rippleMarkersClosing(
      [...clearTrackIds].map(() => merged),
    );
    if (markers === null) {
      const project: Project = {
        ...this.project,
        timeline: {
          ...this.project.timeline,
          clips,
          inFrame: undefined,
          outFrame: undefined,
        },
      };
      this.execute(new ReplaceProjectCommand(project, 'Ripple delete ranges'));
    } else {
      this.execute(new ReplaceProjectCommand({
        ...this.project,
        timeline: {
          ...this.project.timeline,
          clips,
          markers,
          inFrame: undefined,
          outFrame: undefined,
        },
      }, 'Ripple delete ranges'));
    }
    return {
      removedFrames: merged.reduce((total, range) => total + range.end - range.start, 0),
      clearedTrackIds: [...clearTrackIds],
      removedClipIds,
      fragmentClipIds,
      shiftedClipIds,
    };
  }

  moveClip(clipId: string, newStartFrame: Frame, newTrackId?: string): void {
    const clip = this.findClipById(clipId);
    if (!clip) return;

    const targetFrame = clampFrame(newStartFrame);
    const delta = targetFrame - clip.startFrame;
    const linkedIds = new Set(this.expandLinkedClipIds([clipId]));
    if (!this.canEditClipIds(linkedIds)) return;
    if (newTrackId && this.project.timeline.tracks.find((track) => track.id === newTrackId)?.locked) {
      return;
    }
    const clips = this.project.timeline.clips.map((candidate) => {
      if (!linkedIds.has(candidate.id)) return candidate;
      return {
        ...candidate,
        startFrame: clampFrame(candidate.startFrame + delta),
        trackId: candidate.id === clipId && newTrackId ? newTrackId : candidate.trackId,
      };
    });
    this.execute(new ReplaceClipsCommand(clips, linkedIds.size > 1 ? 'Move linked clips' : 'Move clip'));
  }

  trimClip(clipId: string, newInPoint: Frame, newOutPoint: Frame): void {
    // Reject non-finite/out-of-range points outright; clamp ordering so
    // outPoint is always strictly greater than inPoint.
    const inPoint = clampFrame(newInPoint);
    const outPoint = clampFrame(newOutPoint, inPoint + 1);
    const linkedIds = new Set(this.expandLinkedClipIds([clipId]));
    if (!linkedIds.has(clipId) || !this.project.timeline.clips.some((clip) => clip.id === clipId)) {
      return;
    }
    if (!this.canEditClipIds(linkedIds)) return;
    const clips = this.project.timeline.clips.map((clip) =>
      linkedIds.has(clip.id)
        ? {
            ...clip,
            inPoint,
            outPoint,
            durationFrames: outPoint - inPoint,
          }
        : clip,
    );
    this.execute(new ReplaceClipsCommand(clips, linkedIds.size > 1 ? 'Trim linked clips' : 'Trim clip'));
  }

  trimClipEdge(
    clipId: string,
    edge: TrimEdge,
    deltaFrames: Frame,
    ripple = false,
  ): RippleTrimReport | null {
    const lead = this.findClipById(clipId);
    const requestedDelta = Math.round(deltaFrames);
    if (!lead || !Number.isFinite(requestedDelta) || requestedDelta === 0) return null;

    const targetIds = new Set(this.expandLinkedClipIds([clipId]));
    if (!this.canEditClipIds(targetIds)) return null;
    const targets = this.project.timeline.clips.filter((clip) => targetIds.has(clip.id));
    const durationDeltaRequested = edge === 'right' ? requestedDelta : -requestedDelta;

    let minDurationDelta = Math.max(...targets.map((clip) => -(clip.durationFrames - 1)));
    let maxDurationDelta = Math.min(...targets.map((clip) => {
      if (edge === 'left') {
        return ripple ? clip.inPoint : Math.min(clip.inPoint, clip.startFrame);
      }
      const asset = this.project.media.find((candidate) => candidate.id === clip.assetId);
      return asset && asset.duration > 0
        ? Math.max(0, asset.duration - clip.outPoint)
        : Number.POSITIVE_INFINITY;
    }));

    const targetTrackIds = new Set(targets.map((clip) => clip.trackId));
    const leadEnd = lead.startFrame + lead.durationFrames;
    if (ripple && durationDeltaRequested < 0) {
      for (const track of this.project.timeline.tracks) {
        if (
          track.locked
          || targetTrackIds.has(track.id)
          || track.syncLocked === false
        ) {
          continue;
        }
        const clips = this.project.timeline.clips.filter((clip) => clip.trackId === track.id);
        const followers = clips.filter((clip) => clip.startFrame >= leadEnd);
        if (followers.length === 0) continue;
        const firstFollower = Math.min(...followers.map((clip) => clip.startFrame));
        const stationaryEnd = clips
          .filter((clip) => clip.startFrame < leadEnd)
          .reduce((latest, clip) => Math.max(latest, clip.startFrame + clip.durationFrames), 0);
        minDurationDelta = Math.max(minDurationDelta, -(firstFollower - stationaryEnd));
      }
    }

    const durationDelta = Math.min(
      maxDurationDelta,
      Math.max(minDurationDelta, durationDeltaRequested),
    );
    if (!Number.isFinite(durationDelta) || durationDelta === 0) return null;

    const shifts = new Map<string, Frame>();
    if (ripple) {
      for (const track of this.project.timeline.tracks) {
        if (track.locked || (track.syncLocked === false && !targetTrackIds.has(track.id))) continue;
        const trackTarget = targets.find((clip) => clip.trackId === track.id);
        const shiftPoint = trackTarget
          ? trackTarget.startFrame + trackTarget.durationFrames
          : leadEnd;
        for (const clip of this.project.timeline.clips) {
          if (
            clip.trackId === track.id
            && !targetIds.has(clip.id)
            && clip.startFrame >= shiftPoint
          ) {
            shifts.set(clip.id, Math.max(0, clip.startFrame + durationDelta));
          }
        }
      }
    }

    const clips = this.project.timeline.clips.map((clip) => {
      if (targetIds.has(clip.id)) {
        if (edge === 'right') {
          return {
            ...clip,
            durationFrames: clip.durationFrames + durationDelta,
            outPoint: clip.outPoint + durationDelta,
          };
        }
        return {
          ...clip,
          startFrame: ripple ? clip.startFrame : clip.startFrame - durationDelta,
          durationFrames: clip.durationFrames + durationDelta,
          inPoint: clip.inPoint - durationDelta,
        };
      }
      const startFrame = shifts.get(clip.id);
      return startFrame === undefined ? clip : { ...clip, startFrame };
    });
    // Upstream wires ripple-trim marker movement at the lead clip's inner
    // edge: a shortening trim closes the space after it, a lengthening one
    // opens more.
    const markers = ripple
      ? this.rippleMarkersOpening(leadEnd, durationDelta)
      : null;
    this.executeRipple(
      clips,
      markers,
      ripple ? 'Ripple trim clips' : targetIds.size > 1 ? 'Trim linked clips' : 'Trim clip',
    );
    return {
      resizedClipIds: targets.map((clip) => clip.id),
      shiftedClipIds: [...shifts.keys()],
      durationDelta,
    };
  }

  splitClip(clipId: string, atFrame: Frame): string | null {
    const clip = this.findClipById(clipId);
    if (!clip) return null;

    // Validate the split frame before any arithmetic; null = reject.
    const frame = asValidFrame(atFrame);
    if (frame === null) return null;

    const relativeFrame = frame - clip.startFrame;
    if (relativeFrame <= 0 || relativeFrame >= clip.durationFrames) return null;

    const linkedIds = new Set(this.expandLinkedClipIds([clipId]));
    const splitTargets = this.project.timeline.clips.filter((candidate) =>
      linkedIds.has(candidate.id)
      && frame > candidate.startFrame
      && frame < candidate.startFrame + candidate.durationFrames,
    );
    if (splitTargets.length === 0) return null;
    if (!this.canEditClipIds(splitTargets.map((target) => target.id))) return null;

    const rightLinkGroupId = splitTargets.length > 1 ? nanoid() : undefined;
    const rightIds = new Map<string, string>();
    const clips = this.project.timeline.clips.flatMap((candidate) => {
      if (!splitTargets.some((target) => target.id === candidate.id)) return [candidate];

      const relativeFrame = frame - candidate.startFrame;
      const rightId = nanoid();
      rightIds.set(candidate.id, rightId);
      return [
        {
          ...candidate,
          durationFrames: relativeFrame,
          outPoint: candidate.inPoint + relativeFrame,
        },
        {
          ...candidate,
          id: rightId,
          linkGroupId: rightLinkGroupId,
          startFrame: frame,
          durationFrames: candidate.durationFrames - relativeFrame,
          inPoint: candidate.inPoint + relativeFrame,
        },
      ];
    });

    this.execute(new ReplaceClipsCommand(clips, splitTargets.length > 1 ? 'Split linked clips' : 'Split clip'));
    return rightIds.get(clipId) || null;
  }

  addTrack(type: 'video' | 'audio', name?: string): string {
    const existing = this.project.timeline.tracks.filter((t) => t.type === type);
    const trackName = name || `${type === 'video' ? 'Video' : 'Audio'} ${existing.length + 1}`;
    const track: Track = {
      id: nanoid(),
      name: trackName,
      type,
      locked: false,
      visible: true,
      syncLocked: true,
      order: this.project.timeline.tracks.length,
    };
    this.execute(new AddTrackCommand(track));
    return track.id;
  }

  setTrackLocked(trackId: string, locked: boolean): boolean {
    return this.updateTrack(trackId, { locked }, locked ? 'Lock track' : 'Unlock track');
  }

  setTrackVisible(trackId: string, visible: boolean): boolean {
    return this.updateTrack(
      trackId,
      { visible },
      visible ? 'Show track' : 'Hide track',
    );
  }

  setTrackSyncLocked(trackId: string, syncLocked: boolean): boolean {
    return this.updateTrack(
      trackId,
      { syncLocked },
      syncLocked ? 'Enable sync lock' : 'Disable sync lock',
    );
  }

  /**
   * Apply a user-entered track name (upstream PR #520).
   *
   * Invalid input is refused (`false`, no history entry); an empty-after-trim
   * name restores the generated `Video N` / `Audio N` label for the track's
   * position among its type. An unchanged name is a no-op that adds no
   * history entry.
   */
  setTrackName(trackId: string, rawName: string): boolean {
    const track = this.project.timeline.tracks.find((candidate) => candidate.id === trackId);
    if (!track) return false;
    const name = resolveTrackName(rawName, this.generatedTrackLabel(track));
    if (name === null || name === track.name) return false;
    return this.updateTrack(trackId, { name }, 'Rename track');
  }

  /** The automatic label for a track's position among tracks of its type. */
  private generatedTrackLabel(track: Track): string {
    return generatedTrackLabelIn(track, this.project.timeline.tracks);
  }

  /**
   * Reorder, restyle, rename, and remove tracks in one atomic, undoable step
   * (upstream PR #520's `manage_tracks` surface).
   *
   * Every entry addresses a track by exactly one of `trackId` or current
   * `index` ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â never both (the #302 mis-targeting class). Reorder destinations
   * must stay inside the track's type zone. `muted` and `hidden` fold onto
   * this port's single `visible` toggle (`visible === false` means muted on
   * audio tracks). A `name` key present with an empty string restores the
   * generated label; absent leaves the name untouched. Removals refuse
   * non-empty tracks and the last track of either type.
   */
  manageTracks(op: {
    reorder?: Array<{ trackId?: string; index?: number; to: number }>;
    set?: Array<{
      trackId?: string;
      index?: number;
      muted?: boolean;
      hidden?: boolean;
      syncLocked?: boolean;
      name?: string;
    }>;
    remove?: Array<number | string | { trackId?: string; index?: number }>;
  }): {
    tracks: Array<{ trackId: string; index: number; type: string; name: string }>;
    reordered?: Array<{ trackId: string; from: number; to: number; changed: boolean }>;
    renamed?: Array<{ trackId: string; name: string; changed: boolean }>;
    removedTracks?: Array<{ trackId: string; label: string; type: string }>;
  } | null {
    const hasWork = (op.reorder?.length ?? 0) + (op.set?.length ?? 0) + (op.remove?.length ?? 0) > 0;
    if (!hasWork) {
      throw new Error('Nothing to do ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â pass at least one of reorder, set, remove.');
    }

    // All selectors resolve against the current track list, up front.
    const resolveSelector = (
      entry: { trackId?: string; index?: number },
      path: string,
    ): { id: string } => {
      const tracks = this.project.timeline.tracks;
      const hasId = typeof entry.trackId === 'string' && entry.trackId.length > 0;
      const hasIndex = entry.index !== undefined;
      if (hasId === hasIndex) {
        throw new Error(`${path}: pass one current trackId or index`);
      }
      if (hasId) {
        const found = tracks.find((candidate) => candidate.id === entry.trackId);
        if (!found) throw new Error(`${path}: no track "${entry.trackId}" on this timeline.`);
        return { id: found.id };
      }
      const idx = entry.index!;
      if (!Number.isInteger(idx) || idx < 0 || idx >= tracks.length) {
        throw new Error(
          `${path}: track index ${idx} out of range (timeline has ${tracks.length} tracks)`,
        );
      }
      return { id: tracks[idx].id };
    };

    const reorders = (op.reorder ?? []).map((entry, i) => {
      const path = `reorder[${i}]`;
      const resolved = resolveSelector(entry, path);
      if (!Number.isInteger(entry.to)) {
        throw new Error(`${path}: 'to' is required and must be an integer`);
      }
      return { id: resolved.id, to: entry.to };
    });
    const sets = (op.set ?? []).map((entry, i) => {
      const path = `set[${i}]`;
      const resolved = resolveSelector(entry, path);
      const includesName = entry.name !== undefined;
      if (
        entry.muted === undefined
        && entry.hidden === undefined
        && entry.syncLocked === undefined
        && !includesName
      ) {
        throw new Error(`${path}: pass at least one of muted, hidden, syncLocked, name`);
      }
      return { ...resolved, muted: entry.muted, hidden: entry.hidden, syncLocked: entry.syncLocked, name: includesName ? entry.name! : '', includesName };
    });
    const removeIds = (op.remove ?? []).map((raw, i) =>
      resolveSelector(
        typeof raw === 'number'
          ? { index: raw }
          : typeof raw === 'string'
            ? { trackId: raw }
            : raw,
        `remove[${i}]`,
      ).id,
    );

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Apply: reorders ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ sets ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ removes, mirroring upstream's order ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    let working = [...this.project.timeline.tracks];
    const reordered: Array<{ trackId: string; from: number; to: number; changed: boolean }> = [];
    for (const r of reorders) {
      const from = working.findIndex((track) => track.id === r.id);
      if (from === -1) continue;
      const to = Math.max(0, Math.min(working.length - 1, r.to));
      if (working[to].type !== working[from].type) {
        throw new Error(`reorder: destination index ${r.to} is outside the track's type zone`);
      }
      const [moved] = working.splice(from, 1);
      working.splice(to, 0, moved);
      reordered.push({ trackId: r.id, from, to, changed: from !== to });
    }

    const setById = new Map(sets.map((entry) => [entry.id, entry]));
    const renamed: Array<{ trackId: string; name: string; changed: boolean }> = [];
    working = working.map((track) => {
      const patch = setById.get(track.id);
      if (!patch) return track;
      let visible = track.visible;
      if (patch.muted !== undefined) visible = !patch.muted;
      if (patch.hidden !== undefined) visible = !patch.hidden;
      let name = track.name;
      if (patch.includesName) {
        const resolved = resolveTrackName(patch.name, generatedTrackLabelIn(track, working));
        if (resolved === null) {
          throw new Error(
            `set.name must be one line of at most ${TRACK_NAME_MAX_LENGTH} characters`,
          );
        }
        name = resolved;
      }
      if (patch.includesName) {
        renamed.push({ trackId: track.id, name, changed: name !== track.name });
      }
      return {
        ...track,
        visible,
        ...(name !== track.name ? { name } : {}),
        ...(patch.syncLocked !== undefined ? { syncLocked: patch.syncLocked } : {}),
      };
    });

    const removeSet = new Set(removeIds);
    for (const id of removeIds) {
      const track = working.find((candidate) => candidate.id === id)!;
      const clipCount = this.project.timeline.clips.filter((clip) => clip.trackId === id).length;
      if (clipCount > 0) {
        throw new Error(
          `"${track.name}" still has ${clipCount} clip(s) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â move or remove them first.`,
        );
      }
    }
    for (const type of ['video', 'audio'] as const) {
      const remaining = working.filter((t) => t.type === type && !removeSet.has(t.id)).length;
      if (remaining === 0 && removeIds.length > 0) {
        throw new Error(`Cannot remove the last ${type} track.`);
      }
    }
    const removedTracks = working
      .filter((track) => removeSet.has(track.id))
      .map((track) => ({ trackId: track.id, label: track.name, type: track.type }));
    working = working.filter((track) => !removeSet.has(track.id));

    // Renumber render orders per type zone: each zone's existing order values
    // are reassigned (descending ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â array head is the top compositing layer)
    // along the new array sequence, so reordered tracks restack correctly
    // while untouched zones keep their exact original values. A global
    // renumber here would flip cross-type defaults (the seeded project has
    // video order 1 above audio order 0) and turn invisible changes into
    // history entries.
    const ordersByType = new Map<string, number[]>();
    for (const track of working) {
      const list = ordersByType.get(track.type);
      if (list) list.push(track.order);
      else ordersByType.set(track.type, [track.order]);
    }
    for (const list of ordersByType.values()) list.sort((a, b) => b - a);
    const zoneCursor = new Map<string, number>();
    const nextTracks = working.map((track) => {
      const type = track.type;
      const slot = zoneCursor.get(type) ?? 0;
      zoneCursor.set(type, slot + 1);
      const nextOrder = ordersByType.get(type)![slot];
      return track.order === nextOrder ? track : { ...track, order: nextOrder };
    });

    // No-op calls add no history entry.
    const current = this.project.timeline.tracks;
    if (
      nextTracks.length === current.length
      && nextTracks.every((track, i) =>
        track.id === current[i].id
        && track.visible === current[i].visible
        && track.syncLocked === current[i].syncLocked
        && track.order === current[i].order
        && track.name === current[i].name,
      )
    ) {
      return null;
    }

    this.execute(new ReplaceTracksCommand(nextTracks, 'Manage tracks'));

    return {
      tracks: nextTracks.map((track, i) => ({
        trackId: track.id,
        index: i,
        type: track.type,
        name: track.name,
      })),
      ...(reordered.length > 0 ? { reordered } : {}),
      ...(renamed.length > 0 ? { renamed } : {}),
      ...(removedTracks.length > 0 ? { removedTracks } : {}),
    };
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Clipboard: copy / cut / paste (R1, upstream EditorViewModel+Clipboard) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  /** Snapshot the given clips into the in-app clipboard; returns the count. */
  copyClips(clipIds: Iterable<string>): number {
    const requested = new Set(clipIds);
    const tracks = this.project.timeline.tracks;
    const captures = this.project.timeline.clips
      .filter((clip) => requested.has(clip.id))
      .map((clip) => ({
        clip,
        trackIndex: tracks.findIndex((track) => track.id === clip.trackId),
      }))
      .filter(({ trackIndex }) => trackIndex !== -1)
      .sort((a, b) =>
        a.trackIndex - b.trackIndex
        || a.clip.startFrame - b.clip.startFrame
        || (a.clip.id < b.clip.id ? -1 : 1),
      );
    if (captures.length === 0) return 0;

    const minTrack = captures[0].trackIndex;
    const minStart = Math.min(...captures.map((c) => c.clip.startFrame));
    this.clipClipboard = captures.map(({ clip, trackIndex }) => ({
      clip,
      trackOffset: trackIndex - minTrack,
      frameOffset: clip.startFrame - minStart,
      sourceTrackId: clip.trackId,
    }));
    return this.clipClipboard.length;
  }

  hasClipboard(): boolean {
    return this.clipClipboard.length > 0;
  }

  /** Copy then remove; one visible delete step plus the clipboard snapshot. */
  cutClips(clipIds: Iterable<string>): number {
    const ids = [...clipIds];
    const copied = this.copyClips(ids);
    if (copied === 0) return 0;
    if (!this.removeClips(ids)) return 0;
    return copied;
  }

  /**
   * Paste the clipboard. Without arguments this is keyboard paste: the anchor
   * lands on its source track when that still exists and stays compatible
   * (first compatible track otherwise), at the playhead. Entries whose
   * offset track falls outside the timeline or is incompatible are skipped,
   * matching upstream. Pasting overwrites: intersecting clips on each
   * destination track are split and their covered middles removed, with no
   * ripple shift. New link groups are minted for copied group members.
   */
  pasteClips(options?: { trackId?: string; startFrame?: Frame }): string[] {
    if (this.clipClipboard.length === 0) return [];
    const tracks = this.project.timeline.tracks;

    // Title/generated clips are visual media for placement purposes.
    const mediaKindOf = (clip: Clip): 'video' | 'audio' | 'image' =>
      clip.type === 'audio' ? 'audio' : clip.type === 'image' ? 'image' : 'video';

    let destIndex: number;
    if (options?.trackId !== undefined) {
      destIndex = tracks.findIndex((track) => track.id === options.trackId);
      if (destIndex === -1) return [];
    } else {
      const anchor = this.clipClipboard[0];
      const sourceTrack = tracks.find((track) => track.id === anchor.sourceTrackId);
      const compatible = (index: number) =>
        index >= 0 && index < tracks.length
        && isMediaCompatibleWithTrack(mediaKindOf(anchor.clip), tracks[index].type);
      destIndex = sourceTrack && compatible(tracks.indexOf(sourceTrack))
        ? tracks.indexOf(sourceTrack)
        : tracks.findIndex((_, index) => compatible(index));
      if (destIndex === -1) return [];
    }

    const baseFrame = Math.max(0, Math.round(options?.startFrame ?? this.getPlayhead()));

    type Placement = { clip: Clip; dstTrackId: string; dstStart: Frame };
    const placements: Placement[] = [];
    for (const entry of this.clipClipboard) {
      const target = tracks[destIndex + entry.trackOffset];
      if (!target || !isMediaCompatibleWithTrack(mediaKindOf(entry.clip), target.type)) continue;
      placements.push({
        clip: entry.clip,
        dstTrackId: target.id,
        dstStart: baseFrame + entry.frameOffset,
      });
    }
    if (placements.length === 0) return [];

    // Fresh link-group ids per copied group (a singleton copy still gets a
    // fresh id, matching upstream's group remapping).
    const groupCounts = new Map<string, number>();
    for (const placement of placements) {
      if (placement.clip.linkGroupId) {
        groupCounts.set(placement.clip.linkGroupId, (groupCounts.get(placement.clip.linkGroupId) ?? 0) + 1);
      }
    }
    const newGroupId = new Map<string, string>();
    for (const groupId of groupCounts.keys()) newGroupId.set(groupId, nanoid());

    // Overwrite: split every destination-track clip intersecting a pasted
    // span and drop the covered middle ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â clearRegion without ripple shift.
    const spansByTrack = new Map<string, Array<{ start: Frame; end: Frame }>>();
    for (const p of placements) {
      const list = spansByTrack.get(p.dstTrackId) ?? [];
      list.push({ start: p.dstStart, end: p.dstStart + p.clip.durationFrames });
      spansByTrack.set(p.dstTrackId, list);
    }

    const touchedTracks = new Set(spansByTrack.keys());
    const newIds: string[] = [];
    const clips = this.project.timeline.clips.flatMap((clip) => {
      if (!touchedTracks.has(clip.trackId)) return [clip];
      const spans = spansByTrack.get(clip.trackId)!;
      const intersections = spans
        .map((span) => ({
          start: Math.max(clip.startFrame, span.start),
          end: Math.min(clip.startFrame + clip.durationFrames, span.end),
        }))
        .filter((span) => span.end > span.start);
      if (intersections.length === 0) return [clip];

      const kept: Array<{ start: Frame; end: Frame }> = [];
      let cursor = clip.startFrame;
      for (const intersection of intersections) {
        if (intersection.start > cursor) kept.push({ start: cursor, end: intersection.start });
        cursor = Math.max(cursor, intersection.end);
      }
      if (cursor < clip.startFrame + clip.durationFrames) {
        kept.push({ start: cursor, end: clip.startFrame + clip.durationFrames });
      }
      // Head/tail fragments keep their source mapping; the covered middle goes.
      return kept.map((segment) => {
        const headKept = segment.start === clip.startFrame;
        return {
          ...clip,
          startFrame: segment.start,
          durationFrames: segment.end - segment.start,
          inPoint: clip.inPoint + (segment.start - clip.startFrame),
          outPoint: clip.inPoint + (segment.end - clip.startFrame),
          fadeInFrames: headKept ? clip.fadeInFrames : 0,
          fadeOutFrames: segment.end === clip.startFrame + clip.durationFrames ? clip.fadeOutFrames : 0,
        };
      });
    });

    for (const placement of placements) {
      const newId = nanoid();
      newIds.push(newId);
      clips.push({
        ...placement.clip,
        id: newId,
        trackId: placement.dstTrackId,
        startFrame: placement.dstStart,
        ...(placement.clip.linkGroupId
          ? { linkGroupId: newGroupId.get(placement.clip.linkGroupId) }
          : {}),
      });
    }
    const ordered = clips.sort((a, b) => a.startFrame - b.startFrame);
    this.execute(new ReplaceClipsCommand(
      ordered,
      placements.length > 1 ? 'Paste clips' : 'Paste clip',
    ));
    return newIds;
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Timeline markers (upstream PRs #542 / #560) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  getMarkers(): TimelineMarker[] {
    return this.project.timeline.markers ?? [];
  }

  /**
   * Create, update, and delete markers in one undoable step.
   *
   * Every resulting marker is validated (name/comment/color/frame bounds);
   * a violation throws with a precise message so the Agent can correct its
   * arguments rather than retry blind. Deletes and updates must reference
   * existing markers. A call that changes nothing adds no history entry and
   * returns `null`.
   */
  changeTimelineMarkers(
    op: {
      creates?: Array<Pick<TimelineMarker, 'name' | 'startFrame'> & Partial<TimelineMarker>>;
      updates?: Array<Partial<Omit<TimelineMarker, 'id'>> & { id: string }>;
      deleteIds?: string[];
    },
    actionName = 'Edit timeline markers',
  ): { created: TimelineMarker[]; updated: TimelineMarker[]; deletedIds: string[] } | null {
    const current = this.getMarkers();
    const deleteIds = new Set(op.deleteIds ?? []);
    for (const id of deleteIds) {
      if (!current.some((marker) => marker.id === id)) {
        throw new Error(`No marker "${id}" on this timeline.`);
      }
    }

    const created: TimelineMarker[] = (op.creates ?? []).map((input) => ({
      id: nanoid(),
      name: input.name,
      startFrame: input.startFrame,
      durationFrames: input.durationFrames ?? 0,
      color: input.color ?? MARKER_DEFAULT_COLOR,
      comment: input.comment ?? '',
    }));
    const updated: TimelineMarker[] = [];

    let next = current.filter((marker) => !deleteIds.has(marker.id));
    for (const patch of op.updates ?? []) {
      const index = next.findIndex((marker) => marker.id === patch.id);
      if (index === -1) throw new Error(`No marker "${patch.id}" on this timeline.`);
      const merged: TimelineMarker = {
        ...next[index],
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.startFrame !== undefined ? { startFrame: patch.startFrame } : {}),
        ...(patch.durationFrames !== undefined ? { durationFrames: patch.durationFrames } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.comment !== undefined ? { comment: patch.comment } : {}),
      };
      next = next.map((marker, index_) => (index_ === index ? merged : marker));
      updated.push(merged);
    }

    const error = [...created, ...next].map(validateMarker).find((message) => message !== null);
    if (error) throw new Error(error);

    next = sortMarkers([...next, ...created]);
    if (
      next.length === current.length
      && next.every((marker, index) =>
        marker.id === current[index].id
        && marker.name === current[index].name
        && marker.startFrame === current[index].startFrame
        && marker.durationFrames === current[index].durationFrames
        && marker.color === current[index].color
        && marker.comment === current[index].comment,
      )
    ) {
      return null;
    }

    this.execute(new ReplaceMarkersCommand(next, actionName));
    return { created, updated, deletedIds: [...deleteIds] };
  }

  /** Remap markers through a ripple delete; `null` when none would move. */
  private rippleMarkersClosing(
    trackHoles: readonly (readonly RippleRange[])[],
  ): TimelineMarker[] | null {
    if (this.getMarkers().length === 0 || trackHoles.length === 0) return null;
    return mapMarkersThroughClosingHoles(this.getMarkers(), trackHoles);
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Manual clip linking (upstream PR #462) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  /**
   * Resolve the clips a link/unlink request acts on: the requested ids plus
   * every clip sharing their current link groups. Shared by both directions
   * so the Agent and any future UI gate identically.
   */
  private resolveLinkTargets(clipIds: Iterable<string>): Clip[] {
    const requested = [...new Set(clipIds)];
    if (requested.length === 0) {
      throw new Error('At least one clip id is required.');
    }
    for (const id of requested) {
      if (!this.findClipById(id)) throw new Error(`Clip not found: ${id}`);
    }
    return this.expandLinkedClipIds(requested)
      .map((id) => this.findClipById(id))
      .filter((clip): clip is Clip => clip !== undefined);
  }

  /**
   * Link clips (and their existing groups) under one new link group.
   *
   * Refusals mirror upstream's message exactly: at least two clips, at least
   * two distinct media types among them, and not already a single group.
   * One undoable step stamps the new group over the whole union, so linking
   * two half-groups merges them.
   */
  linkClips(clipIds: Iterable<string>): { linkedClipIds: string[] } {
    const targets = this.resolveLinkTargets(clipIds);
    const mediaTypes = new Set(targets.map((clip) => clip.type));
    const groupIds = new Set(
      targets.map((clip) => clip.linkGroupId).filter((id): id is string => id !== undefined),
    );
    const alreadyOneGroup =
      groupIds.size === 1 && targets.every((clip) => clip.linkGroupId === targets[0].linkGroupId);
    if (targets.length < 2 || mediaTypes.size < 2 || alreadyOneGroup) {
      throw new Error(
        'Link requires at least two clips of different media types that are not already one link group',
      );
    }
    if (!this.canEditClipIds(targets.map((clip) => clip.id))) {
      throw new Error('One or more clips are on a locked track.');
    }

    const groupId = nanoid();
    const targetIds = new Set(targets.map((clip) => clip.id));
    const clips = this.project.timeline.clips.map((clip) =>
      targetIds.has(clip.id) ? { ...clip, linkGroupId: groupId } : clip,
    );
    this.execute(new ReplaceClipsCommand(clips, 'Link clips'));
    return { linkedClipIds: [...targetIds] };
  }

  /**
   * Clear the link group from the requested clips and everyone linked to
   * them. Refuses when none of the resolved clips is actually linked.
   */
  unlinkClips(clipIds: Iterable<string>): { unlinkedClipIds: string[] } {
    const resolved = this.resolveLinkTargets(clipIds);
    const targets = resolved.filter((clip) => clip.linkGroupId !== undefined);
    if (targets.length === 0) {
      throw new Error('None of the provided clips is linked');
    }
    if (!this.canEditClipIds(targets.map((clip) => clip.id))) {
      throw new Error('One or more clips are on a locked track.');
    }

    const targetIds = new Set(targets.map((clip) => clip.id));
    const clips = this.project.timeline.clips.map((clip) => {
      if (!targetIds.has(clip.id)) return clip;
      const next = { ...clip };
      delete next.linkGroupId;
      return next;
    });
    this.execute(new ReplaceClipsCommand(clips, 'Unlink clips'));
    return { unlinkedClipIds: [...targetIds] };
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Clip media source swapping (upstream PR #500) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  /**
   * Replace a clip's source media while keeping its edit state ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â timeline
   * position, duration, framing, fades ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â intact.
   *
   * Every linked partner sharing the anchor's source swaps with it, as one
   * undoable step. The replacement must be compatible: same media kind as
   * every target, long enough to cover each target's trimmed source window,
   * and ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â for video without an audio stream ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â never backing an audio clip.
   * A longer replacement simply leaves trim headroom: the user can extend
   * the clip into the surplus later, because `outPoint` remains free up to
   * the new asset's duration (the Windows rendering of upstream's
   * trim-end-headroom bookkeeping).
   */
  swapClipMedia(clipId: string, replacementAssetId: string): {
    changedClipIds: string[];
    oldAssetId: string;
    newAssetId: string;
  } {
    const anchor = this.findClipById(clipId);
    if (!anchor) throw new Error(`Clip not found: ${clipId}`);
    const replacement = this.project.media.find((asset) => asset.id === replacementAssetId);
    if (!replacement) throw new Error(`No media asset "${replacementAssetId}" in this project.`);

    // Only linked partners sharing the anchor's source swap with it; a
    // manually linked clip with different media keeps its own source.
    const targets = this.expandLinkedClipIds([clipId])
      .map((id) => this.findClipById(id))
      .filter((clip): clip is Clip => clip !== undefined)
      .filter((clip) => clip.assetId === anchor.assetId);

    // A clip's SOURCE kind comes from its current asset, not its playback
    // type: the audio half of a picture-plus-audio pair sources from video
    // media and must validate against video replacements (upstream splits
    // this as sourceClipType vs mediaType).
    const sourceKindOf = (clip: Clip): string =>
      this.project.media.find((asset) => asset.id === clip.assetId)?.type ?? clip.type;

    for (const target of targets) {
      if (target.type === 'title' || target.type === 'generated') {
        throw new Error('This clip\'s source cannot be swapped.');
      }
      // Checked before the generic kind mismatch so the common real case ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
      // swapping a picture-plus-linked-audio pair to a silent video ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â gets
      // the precise reason instead of "video vs audio".
      if (
        target.type === 'audio'
        && replacement.type === 'video'
        && !replacement.audioCodec
      ) {
        throw new Error('The replacement video has no audio stream to back this clip\'s audio.');
      }
      if (sourceKindOf(target) !== replacement.type) {
        throw new Error(
          `Replacement is ${replacement.type} media; this clip's source is ${sourceKindOf(target)}.`,
        );
      }
      if (replacement.type !== 'image' && replacement.duration < target.outPoint - target.inPoint) {
        throw new Error(
          'The replacement media is too short for this clip\'s edit. Trim it shorter first or pick longer media.',
        );
      }
    }
    if (!this.canEditClipIds(targets.map((clip) => clip.id))) {
      throw new Error('One or more clips are on a locked track.');
    }

    const targetIds = new Set(targets.map((clip) => clip.id));
    const clips = this.project.timeline.clips.map((clip) =>
      targetIds.has(clip.id) ? { ...clip, assetId: replacementAssetId } : clip,
    );
    this.execute(new ReplaceClipsCommand(clips, 'Replace clip source'));
    return {
      changedClipIds: [...targetIds],
      oldAssetId: anchor.assetId,
      newAssetId: replacementAssetId,
    };
  }

  private rippleMarkersOpening(frame: Frame, push: Frame): TimelineMarker[] | null {
    if (this.getMarkers().length === 0) return null;
    return mapMarkersOpeningAt(this.getMarkers(), frame, push);
  }

  /**
   * Commit a ripple transaction's clip changes together with any marker
   * remapping, so one user action stays exactly one undo step.
   */
  private executeRipple(clips: Clip[], markers: TimelineMarker[] | null, label: string): void {
    if (markers === null) {
      this.execute(new ReplaceClipsCommand(clips, label));
      return;
    }
    this.execute(new ReplaceProjectCommand({
      ...this.project,
      timeline: { ...this.project.timeline, clips, markers },
    }, label));
  }

  private updateTrack(trackId: string, patch: Partial<Track>, label: string): boolean {
    const track = this.project.timeline.tracks.find((candidate) => candidate.id === trackId);
    if (!track) return false;
    this.execute(
      new ReplaceTracksCommand(
        this.project.timeline.tracks.map((candidate) =>
          candidate.id === trackId ? { ...candidate, ...patch } : candidate,
        ),
        label,
      ),
    );
    return true;
  }

  setPlayhead(frame: Frame): void {
    this.project = {
      ...this.project,
      timeline: {
        ...this.project.timeline,
        playheadFrame: clampFrame(frame),
      },
    };
    this.notify();
  }

  setInFrame(frame: Frame = this.project.timeline.playheadFrame): void {
    this.project = {
      ...this.project,
      timeline: { ...this.project.timeline, inFrame: clampFrame(frame) },
    };
    this.notify();
  }

  setOutFrame(frame: Frame = this.project.timeline.playheadFrame): void {
    this.project = {
      ...this.project,
      timeline: { ...this.project.timeline, outFrame: clampFrame(frame) },
    };
    this.notify();
  }

  /**
   * Set both marks at once, normalized so in <= out.
   *
   * Marking a clip is one user action, so it is one mutation and one
   * notification ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â setting the marks separately would publish an intermediate
   * state where out still belongs to the previously marked range, and every
   * consumer guards `out > in` by discarding the range.
   */
  setMarkedRange(inFrame: Frame, outFrame: Frame): void {
    const start = clampFrame(Math.min(inFrame, outFrame));
    const end = clampFrame(Math.max(inFrame, outFrame));
    this.project = {
      ...this.project,
      timeline: { ...this.project.timeline, inFrame: start, outFrame: end },
    };
    this.notify();
  }

  clearMarkedRange(): void {
    this.project = {
      ...this.project,
      timeline: {
        ...this.project.timeline,
        inFrame: undefined,
        outFrame: undefined,
      },
    };
    this.notify();
  }

  importMediaAssets(assets: MediaAsset[]): string[] {
    if (assets.length === 0) return [];
    this.execute(new AddMediaAndClipsCommand(assets, [], 'Import media'));
    return assets.map((asset) => asset.id);
  }

  placeMediaAssets(
    assetIds: string[],
    trackId: string,
    startFrame: Frame,
  ): MediaPlacementResult {
    return this.addMediaAndClips([], assetIds, trackId, startFrame, 'Place media');
  }

  importAndPlaceMedia(
    assets: MediaAsset[],
    trackId: string,
    startFrame: Frame,
  ): MediaPlacementResult {
    return this.addMediaAndClips(
      assets,
      assets.map((asset) => asset.id),
      trackId,
      startFrame,
      'Import and place media',
    );
  }

  private addMediaAndClips(
    importedAssets: MediaAsset[],
    assetIds: string[],
    trackId: string,
    startFrame: Frame,
    label: string,
  ): MediaPlacementResult {
    const track = this.project.timeline.tracks.find((candidate) => candidate.id === trackId);
    const importedById = new Map(importedAssets.map((asset) => [asset.id, asset]));
    const allAssets = new Map(this.project.media.map((asset) => [asset.id, asset]));
    for (const asset of importedAssets) allAssets.set(asset.id, asset);

    const clips: Clip[] = [];
    const tracks: Track[] = [];
    let cursor = clampFrame(startFrame);

    if (track && !track.locked) {
      for (const assetId of assetIds) {
        const asset = allAssets.get(assetId);
        if (!asset || !isMediaCompatibleWithTrack(asset.type, track.type)) continue;

        const duration = placementDuration(asset, this.project.settings.fps);
        const linkGroupId = hasEmbeddedAudio(asset) && track.type === 'video'
          ? nanoid()
          : undefined;
        clips.push(this.createPlacedClip(asset, asset.type, track.id, cursor, duration, linkGroupId));

        if (linkGroupId) {
          const audioTrack = this.resolveAudioPlacementTrack(cursor, duration, clips, tracks);
          clips.push(
            this.createPlacedClip(asset, 'audio', audioTrack.id, cursor, duration, linkGroupId),
          );
        }
        cursor = clampFrame(cursor + duration);
      }
    }

    const media = importedAssets.filter((asset) => importedById.has(asset.id));
    if (media.length === 0 && clips.length === 0) {
      return { assetIds: [], clipIds: [] };
    }

    this.execute(new AddMediaAndClipsCommand(media, clips, label, tracks));
    return {
      assetIds: media.map((asset) => asset.id),
      clipIds: clips.map((clip) => clip.id),
    };
  }

  private createPlacedClip(
    asset: MediaAsset,
    type: ClipType,
    trackId: string,
    startFrame: Frame,
    durationFrames: Frame,
    linkGroupId?: string,
  ): Clip {
    return {
      id: nanoid(),
      assetId: asset.id,
      type,
      trackId,
      linkGroupId,
      startFrame,
      durationFrames,
      inPoint: 0,
      outPoint: durationFrames,
      x: 0,
      y: 0,
      width: this.project.settings.width,
      height: this.project.settings.height,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      anchorX: 0,
      anchorY: 0,
      volume: 1,
      muted: false,
      label: asset.filename,
    };
  }

  private resolveAudioPlacementTrack(
    startFrame: Frame,
    durationFrames: Frame,
    plannedClips: Clip[],
    plannedTracks: Track[],
  ): Track {
    const endFrame = startFrame + durationFrames;
    const candidates = [...this.project.timeline.tracks, ...plannedTracks]
      .filter((track) => track.type === 'audio' && !track.locked)
      .sort((left, right) => left.order - right.order);
    const allClips = [...this.project.timeline.clips, ...plannedClips];

    const available = candidates.find((track) =>
      allClips
        .filter((clip) => clip.trackId === track.id)
        .every((clip) => {
          const clipEnd = clip.startFrame + clip.durationFrames;
          return clipEnd <= startFrame || clip.startFrame >= endFrame;
        }),
    );
    if (available) return available;

    const track: Track = {
      id: nanoid(),
      name: `Audio ${
        this.project.timeline.tracks.filter((candidate) => candidate.type === 'audio').length
        + plannedTracks.filter((candidate) => candidate.type === 'audio').length
        + 1
      }`,
      type: 'audio',
      locked: false,
      visible: true,
      syncLocked: true,
      order: this.project.timeline.tracks.length + plannedTracks.length,
    };
    plannedTracks.push(track);
    return track;
  }

  /**
   * Set a clip's layer blend mode. Only valid for visual clips ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
   * audio clips have no compositing stage, so this is a no-op for them
   * (returns false), matching upstream behaviour (#203).
   */
  setClipBlendMode(clipId: string, blendMode: BlendMode): boolean {
    return this.setClipsBlendMode([clipId], blendMode).skippedClipIds.length === 0;
  }

  /**
   * Set the blend mode on every given visual clip in one undoable edit.
   * Audio clips are reported as skipped rather than silently mutated (#203).
   */
  setClipsBlendMode(clipIds: Iterable<string>, blendMode: BlendMode): BulkClipPropertyReport {
    return this.applyClipProperties(clipIds, `Set blend mode to "${blendMode}"`, (draft) => {
      if (draft.type === 'audio') return false;
      // 'normal' clears the property to keep saved projects clean.
      if (blendMode === 'normal') {
        delete draft.blendMode;
      } else {
        draft.blendMode = blendMode;
      }
      return true;
    });
  }

  /** Set a clip's opacity (0ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“1). Valid for any visual clip. */
  setClipOpacity(clipId: string, opacity: number): boolean {
    return this.setClipsOpacity([clipId], opacity).skippedClipIds.length === 0;
  }

  /** Set opacity on every given clip in one undoable edit. */
  setClipsOpacity(clipIds: Iterable<string>, opacity: number): BulkClipPropertyReport {
    const clamped = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
    return this.applyClipProperties(
      clipIds,
      `Set opacity to ${Math.round(clamped * 100)}%`,
      (draft) => {
        draft.opacity = clamped;
        return true;
      },
    );
  }

  /** Set fade-in / fade-out lengths (frames). Either may be undefined to keep current. */
  setClipFade(clipId: string, fadeInFrames?: Frame, fadeOutFrames?: Frame): boolean {
    return this.setClipsFade([clipId], fadeInFrames, fadeOutFrames).skippedClipIds.length === 0;
  }

  /**
   * Set fade lengths on every given clip in one undoable edit. Either length may
   * be undefined to leave it unchanged; each is clamped to its own clip's
   * duration, so a bulk fade across clips of different lengths stays valid.
   */
  setClipsFade(
    clipIds: Iterable<string>,
    fadeInFrames?: Frame,
    fadeOutFrames?: Frame,
  ): BulkClipPropertyReport {
    const fin = fadeInFrames === undefined ? undefined : clampFrame(fadeInFrames, 0);
    const fout = fadeOutFrames === undefined ? undefined : clampFrame(fadeOutFrames, 0);
    return this.applyClipProperties(clipIds, 'Set clip fades', (draft) => {
      const max = draft.durationFrames;
      if (fin !== undefined) {
        const value = Math.max(0, Math.min(max, fin));
        if (value <= 0) delete draft.fadeInFrames;
        else draft.fadeInFrames = value;
      }
      if (fout !== undefined) {
        const value = Math.max(0, Math.min(max, fout));
        if (value <= 0) delete draft.fadeOutFrames;
        else draft.fadeOutFrames = value;
      }
      return true;
    });
  }

  /**
   * Batched clip-property edit ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the one path every property mutation takes,
   * for a single clip or a whole selection (upstream PR #419).
   *
   * `mutate` receives a copy of each resolved clip and returns false to reject
   * that clip as ineligible. Ids that do not resolve, and clips the mutator
   * rejects, are reported in `skippedClipIds`. Clips the mutator leaves
   * unchanged are neither written nor counted, so a redundant edit adds no undo
   * entry. When at least one clip changes, all changes land as one command and
   * therefore one undo step.
   */
  applyClipProperties(
    clipIds: Iterable<string>,
    label: string,
    mutate: (draft: Clip) => boolean,
  ): BulkClipPropertyReport {
    const requestedIds = [...new Set(clipIds)];
    const indices = this.clipIndices(requestedIds);
    const clips = this.project.timeline.clips;
    const nextClips = new Map<string, Clip>();
    const changedClipIds: string[] = [];
    const skippedClipIds: string[] = [];

    for (const clipId of requestedIds) {
      const index = indices.get(clipId);
      if (index === undefined) {
        skippedClipIds.push(clipId);
        continue;
      }
      const current = clips[index];
      const draft: Clip = { ...current };
      if (!mutate(draft)) {
        skippedClipIds.push(clipId);
        continue;
      }
      if (clipsShallowEqual(current, draft)) continue;
      nextClips.set(clipId, draft);
      changedClipIds.push(clipId);
    }

    if (nextClips.size > 0) {
      const suffix = nextClips.size > 1 ? ` (${nextClips.size} clips)` : '';
      this.execute(new SetClipPropertiesCommand(nextClips, `${label}${suffix}`));
    }
    return { changedClipIds, skippedClipIds };
  }

  /**
   * Resolve clip ids to timeline array indices in one pass over the clips.
   *
   * The direct analogue of upstream's `clipLocations(for:)`: a bulk edit across a
   * large selection used to run one linear search per clip, which is quadratic in
   * timeline size. One pass with an early exit keeps a selection-wide edit linear.
   */
  private clipIndices(clipIds: Iterable<string>): Map<string, number> {
    const requested = new Set(clipIds);
    const indices = new Map<string, number>();
    if (requested.size === 0) return indices;

    const clips = this.project.timeline.clips;
    for (let index = 0; index < clips.length; index += 1) {
      const clipId = clips[index].id;
      if (!requested.has(clipId) || indices.has(clipId)) continue;
      indices.set(clipId, index);
      if (indices.size === requested.size) break;
    }
    return indices;
  }

  /**
   * Set or clear a geometric in-transition (wipe/slide) on a clip.
   * Pass `transition` as null to clear. Not undoable via a dedicated command ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â
   * uses a project replace so it's a single undo step.
   */
  setClipTransition(clipId: string, transition: ClipTransition | null): boolean {
    const clips = this.project.timeline.clips;
    const idx = clips.findIndex((c) => c.id === clipId);
    if (idx < 0) return false;
    const next = clips.map((c) => {
      if (c.id !== clipId) return c;
      const copy = { ...c };
      if (transition === null || transition.frames <= 0) {
        delete copy.transitionIn;
      } else {
        copy.transitionIn = {
          ...transition,
          frames: clampFrame(transition.frames, 1),
        };
      }
      return copy;
    });
    this.execute(new ReplaceClipsCommand(next, 'Set transition'));
    return true;
  }

  /**
   * Create a cross-dissolve between two adjacent clips on the same track.
   * `firstClipId` must be immediately followed by `secondClipId`. The second
   * clip (and everything after it on the track) shifts left by `durationFrames`
   * to overlap the first clip's tail; the first gets a matching fade-out and the
   * second a matching fade-in, so the overlap renders as a dissolve.
   * Returns false if the clips aren't adjacent or the overlap won't fit.
   */
  createCrossDissolve(firstClipId: string, secondClipId: string, durationFrames: Frame): boolean {
    const clips = this.project.timeline.clips;
    const first = clips.find((c) => c.id === firstClipId);
    const second = clips.find((c) => c.id === secondClipId);
    if (!first || !second) return false;
    if (first.trackId !== second.trackId) return false;

    const d = clampFrame(durationFrames, 1);
    const firstEnd = first.startFrame + first.durationFrames;
    // Require adjacency (second starts where first ends).
    if (second.startFrame !== firstEnd) return false;
    // The overlap must fit inside both clips.
    if (d >= first.durationFrames || d >= second.durationFrames) return false;

    const next: Clip[] = clips.map((c) => {
      if (c.id === firstClipId) {
        return { ...c, fadeOutFrames: d };
      }
      if (c.trackId === first.trackId && c.startFrame >= second.startFrame) {
        // Shift the second clip and everything after it left to create the overlap.
        const shifted = { ...c, startFrame: Math.max(0, c.startFrame - d) };
        if (c.id === secondClipId) shifted.fadeInFrames = d;
        return shifted;
      }
      return c;
    });

    this.execute(new ReplaceClipsCommand(next, 'Cross dissolve'));
    return true;
  }

  /**
   * Remove silent ranges from a clip and ripple-close the gaps (#175).
   *
   * `silentRangesSec` are silent spans in SOURCE seconds (from the detector).
   * They are converted to source frames at the project frame rate, intersected
   * with the clip, and the kept segments are placed contiguously; clips after
   * the original on the same track shift left by the removed amount.
   *
   * Returns the number of segments removed (0 = nothing changed).
   */
  removeSilence(clipId: string, silentRangesSec: SilentRange[]): number {
    const clip = this.findClipById(clipId);
    if (!clip) return 0;

    const fps = this.project.settings.fps;
    const silentFrameRanges: FrameRange[] = silentRangesSec.map((r) => ({
      start: Math.round(r.startSec * fps),
      end: Math.round(r.endSec * fps),
    }));

    const plan = planSilenceRemoval(clip.inPoint, clip.outPoint, silentFrameRanges);
    if (plan.removedFrames <= 0 || plan.kept.length === 0) return 0;

    // Build replacement clips for the kept segments, placed contiguously
    // starting at the original clip's timeline position.
    const newClips: Clip[] = [];
    let cursorTimeline = clip.startFrame;
    for (const seg of plan.kept) {
      const segDuration = seg.outPoint - seg.inPoint;
      newClips.push({
        ...clip,
        id: nanoid(),
        startFrame: cursorTimeline,
        durationFrames: segDuration,
        inPoint: seg.inPoint,
        outPoint: seg.outPoint,
      });
      cursorTimeline += segDuration;
    }

    const originalEnd = clip.startFrame + clip.durationFrames;
    const totalKept = cursorTimeline - clip.startFrame;
    const rippleShift = clip.durationFrames - totalKept; // frames freed up

    // Assemble the new full clips array: drop the original, add segments,
    // and ripple clips that started at/after the original's end on this track.
    const nextClips: Clip[] = [];
    for (const c of this.project.timeline.clips) {
      if (c.id === clipId) continue;
      if (c.trackId === clip.trackId && c.startFrame >= originalEnd && rippleShift > 0) {
        nextClips.push({ ...c, startFrame: Math.max(0, c.startFrame - rippleShift) });
      } else {
        nextClips.push(c);
      }
    }
    nextClips.push(...newClips);

    this.execute(new ReplaceClipsCommand(nextClips, 'Remove silence'));
    return silentRangesSec.length;
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Project settings ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  /**
   * Change frame rate and/or canvas size as one undoable edit (upstream #417).
   *
   * Two re-fits happen so the timeline stays coherent, matching upstream's
   * `applyTimelineSettings`:
   *
   *   - Frame rate: every frame-valued field is rescaled, so a 30 -> 60 fps
   *     change keeps clips at the same wall-clock position and length instead of
   *     halving the edit. Clips are rescaled in timeline order per track and
   *     nudged forward if rounding would overlap a neighbour.
   *   - Canvas size: clips that filled the old canvas fill the new one; clips the
   *     user positioned keep their relative placement, scaled by the change on
   *     each axis. Windows clip geometry is in canvas pixels rather than upstream's
   *     normalized transform, so scaling both axes here is the equivalent of
   *     upstream's aspect-delta adjustment.
   *
   * Returns null and changes nothing when a value is unusable. An unchanged
   * resolution is never re-validated for size, so an fps-only change on an
   * oversized legacy canvas is preserved rather than refused.
   */
  applyProjectSettings(change: {
    fps?: number;
    width?: number;
    height?: number;
  }): ProjectSettingsReport | null {
    const previous = this.project.settings;
    const fps = change.fps === undefined ? previous.fps : Math.round(change.fps);
    const width = change.width === undefined ? previous.width : Math.round(change.width);
    const height = change.height === undefined ? previous.height : Math.round(change.height);

    if (!Number.isFinite(fps) || fps < 1 || fps > MAX_PROJECT_FPS) return null;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (width < 1 || height < 1) return null;

    const resolutionChanged = width !== previous.width || height !== previous.height;
    // Only a resolution the caller is actually changing has to satisfy the
    // encoder limit; an existing oversized canvas survives an fps-only edit.
    if (resolutionChanged && (width > MAX_CANVAS_EDGE || height > MAX_CANVAS_EDGE)) return null;

    const fpsChanged = fps !== previous.fps;
    const changed: ProjectSettingsReport['changed'] = [];
    if (fpsChanged) changed.push('fps');
    if (resolutionChanged) changed.push('resolution');
    if (changed.length === 0) {
      return { fps, width, height, changed };
    }

    let timeline = this.project.timeline;
    if (fpsChanged) {
      timeline = rescaleTimelineFrames(timeline, fps / previous.fps);
    }
    if (resolutionChanged) {
      timeline = {
        ...timeline,
        clips: timeline.clips.map((clip) =>
          refitClipToCanvas(clip, previous.width, previous.height, width, height),
        ),
      };
    }

    this.execute(
      new ReplaceProjectCommand(
        {
          ...this.project,
          settings: { ...previous, fps, width, height },
          timeline,
          updatedAt: new Date().toISOString(),
        },
        'Change project settings',
      ),
    );
    return { fps, width, height, changed };
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Media management (not undoable ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â these mutate the asset library) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  addMedia(asset: MediaAsset): void {
    this.project = {
      ...this.project,
      media: [...this.project.media, asset],
      updatedAt: new Date().toISOString(),
    };
    this.notify();
  }

  removeMedia(assetId: string): void {
    this.project = {
      ...this.project,
      media: this.project.media.filter((m) => m.id !== assetId),
      updatedAt: new Date().toISOString(),
    };
    this.notify();
  }

  /**
   * Delete media assets and every clip that references them, as one undoable
   * edit (upstream PR #409's `deleteMediaAssets`).
   *
   * Deleting an asset while clips still point at it would leave the timeline
   * referencing media that no longer exists, so dependents go with it. Refuses
   * the whole request when a dependent clip sits on a locked track ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a locked
   * track must not lose clips through the media panel.
   *
   * Returns null when nothing matched or the request was refused.
   */
  removeMediaAssets(assetIds: Iterable<string>): {
    removedAssetIds: string[];
    removedClipIds: string[];
  } | null {
    const requested = new Set(assetIds);
    const removedAssetIds = this.project.media
      .filter((asset) => requested.has(asset.id))
      .map((asset) => asset.id);
    if (removedAssetIds.length === 0) return null;

    const removedSet = new Set(removedAssetIds);
    const dependents = this.project.timeline.clips.filter((clip) => removedSet.has(clip.assetId));
    // Linked partners share a placement, so removing one member must remove the
    // whole group rather than orphan half of it.
    const removedClipIds = this.expandLinkedClipIds(dependents.map((clip) => clip.id));
    if (removedClipIds.length > 0 && !this.canEditClipIds(removedClipIds)) return null;

    const removedClipSet = new Set(removedClipIds);
    this.execute(
      new ReplaceProjectCommand(
        {
          ...this.project,
          media: this.project.media.filter((asset) => !removedSet.has(asset.id)),
          timeline: {
            ...this.project.timeline,
            clips: this.project.timeline.clips.filter((clip) => !removedClipSet.has(clip.id)),
          },
          updatedAt: new Date().toISOString(),
        },
        removedAssetIds.length === 1 ? 'Delete media' : `Delete ${removedAssetIds.length} media items`,
      ),
    );
    return { removedAssetIds, removedClipIds };
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Project lifecycle ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  loadProject(project: Project): void {
    this.project = project;
    this.history.clear();
    this.notify();
  }

  /**
   * Replace the project WITHOUT notifying subscribers or touching history.
   * Used by the main process to mirror the renderer's authoritative state
   * (renderer -> main sync) so MCP/agent reads see live data, without
   * triggering a sync echo back to the renderer.
   */
  setProjectSilent(project: Project): void {
    this.project = project;
  }

  /**
   * Adopt an externally-produced project (e.g. an AI agent edit) as a single
   * undoable step, so it is visible in the UI and reversible from the UI's
   * undo. Notifies subscribers.
   */
  adoptProject(project: Project, label = 'AI edit'): void {
    this.execute(new ReplaceProjectCommand(project, label));
  }

  reset(): void {
    this.project = createEmptyProject();
    this.history.clear();
    this.notify();
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Subscriptions ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  subscribe(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.project);
    }
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Serialization ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

  serialize(): string {
    return JSON.stringify(this.project, null, 2);
  }

  static deserialize(json: string): EditorController {
    const project: Project = JSON.parse(json);
    return new EditorController(project);
  }
}
