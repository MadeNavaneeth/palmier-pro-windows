/**
 * EditorController  the single command surface for all editing operations.
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
  ReplaceMediaCommand,
  scopeTimeline,
  scopeTimelineExists,
  replaceScopeTimeline,
  trimWindowDurationFrames,
} from './commands';
import type { Command, TimelineScopeId } from './commands';
import { resolveLayoutPreset, type GridLayoutPreset } from './grid-layout';
import type { BlendMode } from '../types/blend-mode';
import type { ClipTransition } from './transition';
import type { SilentRange } from '../audio/silence-detector';
import { eqOf } from '../audio/eq';
import { compressorEquals, compressorOf } from '../audio/compressor';
import { noiseReductionOf } from '../audio/denoise';
import { resolveTrackName, TRACK_NAME_MAX_LENGTH } from './track-name';
import {
  MARKER_DEFAULT_COLOR,
  MARKER_DEFAULT_STATUS,
  diffMarkers,
  mapMarkersOpeningAt,
  mapMarkersThroughClosingHoles,
  normalizeMarkerStatus,
  rescaleMarker,
  sortMarkers,
  validateMarker,
  type MarkerRippleDelta,
  type TimelineMarker,
} from './markers';
import { DEFAULT_MARKER_SETTINGS } from './marker-settings';
import { hasEmbeddedAudio, isMediaCompatibleWithTrack, placementDuration } from './placement';
import { fileKindOf } from '../media/file-kind';
import { assetDurationSeconds, effectiveSpeed } from '../media/source-time';
import {
  DEFAULT_TITLE_STYLE,
  narrowTitleVariationClip,
  sanitizeTitleText,
} from './title';
import {
  DEFAULT_SHAPE_STYLE,
  SHAPE_ANIMATION_PRESETS,
  SHAPE_ASSET_ID,
  narrowShapeClip,
  sanitizeShapeFillColor,
  sanitizeShapeKind,
  sanitizeShapeStrokeColor,
  sanitizeShapeStrokeWidth,
  shapePresetMotion,
  type ShapeAnimationPreset,
} from './shape';
import { parseSrt } from './srt';
import { parseVtt } from './vtt-parse';
import { placeCaptionCue } from '../captions/apply';
import { colorGradeOf, gradeCurvesEqual, gradeWheelsEqual, hueCurvesEqual, sanitizeGradeCurve, sanitizeGradeWheels, sanitizeHueCurves } from './color-grade';
import { normalizeEasing, sanitizeMotion, type MotionTrack } from '../media/motion';
import { narrowProjectGradePresetLinks } from './grade-preset-store';
import { clipEffectsEqual, effectsOf, sanitizeBlurRadius, sanitizeGlow, sanitizeGrain, sanitizeVignette } from './effects';
import { lutRefsEqual, sanitizeLutRef } from './lut';
import { migrateProject, CURRENT_SCHEMA_VERSION } from './migrations';
import { folderNamesMatch, narrowMediaFolders, sanitizeFolderName } from '../media/folders';
import type { MediaFolder } from '../types/project';
import { narrowAiDescription, sanitizeAiDescription } from '../media/ai-description';
import {
  MAX_COMPOUND_DEPTH,
  nestedSubtreeDepth,
  planFlatten,
  planNest,
  sanitizeCompoundTimelineId,
  scopeDisplayName,
  timelineBreadcrumbs,
  timelineInScope,
  withTimelineInScope,
  withNarrowedCompounds,
  type FlattenReceipt,
  type NestReceipt,
  type TimelineBreadcrumb,
} from './compound';

/**
 * One copied clip and its position relative to the copy anchor  the
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
import { timelineSilenceRanges } from './silence-scoping';

/**
 * What a notification is about, for the subscriber that must tell the two apart.
 *
 * `edit` is editorial work: something the user would expect to undo, and work a
 * crash-recovery snapshot exists to protect. `playhead` is the cursor. It lives
 * in the project because preview and delivery are both frame-relative, but
 * moving it authors nothing, so a subscriber must not treat it as unsaved work
 * — otherwise opening a saved project and pressing Play marks it dirty, the
 * autosave writes a snapshot, and the next launch offers to recover a project
 * nobody edited.
 */
export type StateChangeKind = 'edit' | 'playhead';

export type StateChangeListener = (project: Project, kind: StateChangeKind) => void;

export interface MediaPlacementResult {
  assetIds: string[];
  clipIds: string[];
}

export interface RippleDeleteReport {
  removedClipIds: string[];
  shiftedClipIds: string[];
  /** New state of every marker whose span moved (upstream #560). */
  shiftedMarkers: TimelineMarker[];
  /** Ids of every marker the edit consumed (upstream #560). */
  removedMarkerIds: string[];
}

export type TrimEdge = 'left' | 'right';

export interface RippleTrimReport {
  resizedClipIds: string[];
  shiftedClipIds: string[];
  durationDelta: Frame;
  /** New state of every marker whose span moved (upstream #560). */
  shiftedMarkers: TimelineMarker[];
  /** Ids of every marker the edit consumed (upstream #560). */
  removedMarkerIds: string[];
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
 * property is not valid for  e.g. a blend mode aimed at an audio clip. A
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
  /** New state of every marker whose span moved (upstream #560). */
  shiftedMarkers: TimelineMarker[];
  /** Ids of every marker the edit consumed (upstream #560). */
  removedMarkerIds: string[];
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
 * What one live preview frame wrote: per item id, the own properties whose
 * value differs between the scope as it stood before the frame and as it
 * stood after.
 *
 * The two snapshots are consecutive — nothing ran between them — so every
 * shallow difference is the frame's own write. An id present in only ONE of
 * them is not a write: a gesture preview never adds or removes a clip or a
 * marker, so a one-sided id is a change some other editor made while the
 * gesture was in flight, and it is deliberately left out of the patch.
 */
function frameWrites<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): Map<string, Set<string>> {
  const prior = new Map(before.map((item) => [item.id, item] as const));
  const writes = new Map<string, Set<string>>();
  for (const item of after) {
    const original = prior.get(item.id) as Record<string, unknown> | undefined;
    if (original === undefined) continue;
    const current = item as Record<string, unknown>;
    const changed = new Set(Object.keys(current).filter((key) => !Object.is(original[key], current[key])));
    if (changed.size > 0) writes.set(item.id, changed);
  }
  return writes;
}

/** The inverse of `frameWrites`: put those properties back, leave the rest. */
function revertFrameWrites<T extends { id: string }>(
  items: readonly T[],
  before: readonly T[],
  writes: Map<string, Set<string>>,
): T[] {
  const prior = new Map(before.map((item) => [item.id, item] as const));
  return items.map((item) => {
    const changed = writes.get(item.id);
    const original = changed ? prior.get(item.id) : undefined;
    if (!changed || !original) return item;
    const reverted = { ...item } as Record<string, unknown>;
    const source = original as Record<string, unknown>;
    for (const key of changed) reverted[key] = source[key];
    return reverted as T;
  });
}

/** Apply the same rounded, clamped frame conversion used by timeline rescale. */
function rescaleFrame(frame: Frame, scale: number): Frame {
  return clampFrame(Math.round(frame * scale), 0);
}

/** Rescale keyframe times while preserving each point's value and easing. */
function rescaleKeyframeTrack(
  track: MotionTrack | undefined,
  scale: number,
): MotionTrack | undefined {
  return track?.map((point) => ({
    ...point,
    frame: rescaleFrame(point.frame, scale),
  }));
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
      const scaledStart = rescaleFrame(clip.startFrame, scale);
      const scaledEnd = rescaleFrame(clip.startFrame + clip.durationFrames, scale);
      const startFrame: Frame =
        previousEnd === null ? scaledStart : Math.max(scaledStart, previousEnd);
      const durationFrames = clampFrame(Math.max(1, scaledEnd - startFrame), 1);

      const next: Clip = {
        ...clip,
        startFrame,
        durationFrames,
        inPoint: rescaleFrame(clip.inPoint, scale),
        outPoint: rescaleFrame(clip.outPoint, scale),
      };
      if (clip.fadeInFrames !== undefined) {
        const value = Math.min(durationFrames, rescaleFrame(clip.fadeInFrames, scale));
        if (value > 0) next.fadeInFrames = value;
        else delete next.fadeInFrames;
      }
      if (clip.fadeOutFrames !== undefined) {
        const value = Math.min(durationFrames, rescaleFrame(clip.fadeOutFrames, scale));
        if (value > 0) next.fadeOutFrames = value;
        else delete next.fadeOutFrames;
      }
      if (clip.transitionIn) {
        next.transitionIn = {
          ...clip.transitionIn,
          frames: Math.min(
            durationFrames,
            Math.max(1, rescaleFrame(clip.transitionIn.frames, scale)),
          ),
        };
      }
      if (next.motionX !== undefined) next.motionX = rescaleKeyframeTrack(next.motionX, scale);
      if (next.motionY !== undefined) next.motionY = rescaleKeyframeTrack(next.motionY, scale);
      if (next.motionRot !== undefined) next.motionRot = rescaleKeyframeTrack(next.motionRot, scale);
      if (next.motionScaleX !== undefined) next.motionScaleX = rescaleKeyframeTrack(next.motionScaleX, scale);
      if (next.motionScaleY !== undefined) next.motionScaleY = rescaleKeyframeTrack(next.motionScaleY, scale);
      if (next.opacityTrack !== undefined) next.opacityTrack = rescaleKeyframeTrack(next.opacityTrack, scale);
      if (next.volumeDb !== undefined) next.volumeDb = rescaleKeyframeTrack(next.volumeDb, scale);

      rescaled.set(clip.id, next);
      previousEnd = startFrame + durationFrames;
    }
  }

  const scaleMarker = (frame: Frame | undefined): Frame | undefined =>
    frame === undefined ? undefined : rescaleFrame(frame, scale);

  const next: Timeline = {
    ...timeline,
    clips: timeline.clips.map((clip) => rescaled.get(clip.id) ?? clip),
    // Markers follow the project timebase change like every other frame
    // value (upstream PR #542's rescaleFrames hook).
    ...(timeline.markers
      ? { markers: timeline.markers.map((marker) => rescaleMarker(marker, scale)) }
      : {}),
    playheadFrame: rescaleFrame(timeline.playheadFrame, scale),
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
 * Source frame reached at a timeline boundary inside `clip`.
 *
 * The frames-level form of the shared source-time model's
 * `sourceOffset = clip.inPoint + (timelineFrame - clip.startFrame) * speed`
 * (`sourceSecondsForTimelineFrame`, and the rounding
 * `timelineFrameForSourceSeconds` applies coming back). Every edit that
 * rebuilds a clip's trim from timeline frames goes through here, so a
 * fragment cannot be mapped without the `speed` term: rebuilt without it, a
 * 2x clip's fragment claims half the source material it actually plays and
 * mis-trims on preview and export, exactly the omission `setClipSpeed` does
 * not make.
 */
function sourceFrameAtBoundary(clip: Clip, timelineFrame: Frame): Frame {
  return clip.inPoint
    + Math.round((timelineFrame - clip.startFrame) * effectiveSpeed(clip.speed));
}

/**
 * Source trim window for the timeline slice [start, end) of `clip`.
 *
 * Rounding: the start boundary rounds once (above) and the span rounds once,
 * with `outPoint` derived from the already-rounded `inPoint`. That is the same
 * shape `setClipSpeed` writes -- `outPoint = inPoint + round(durationFrames *
 * speed)` -- so `outPoint - inPoint === round(durationFrames * speed)` holds
 * exactly for any speed and a fragment can never claim more or less source than
 * its own duration says. Rounding the two ends independently instead lets the
 * span disagree with the duration by a frame, and the error lands on a
 * different fragment at each end of a cut.
 *
 * No gap, no overlap: the mapping is monotone in the timeline frame, so a later
 * slice's window can never start before an earlier one ends, and one boundary
 * always resolves to one source frame no matter which path asks for it -- a
 * split's left `outPoint` is the right `inPoint` because both are the same
 * boundary. At a whole-number speed every product is already an integer, so the
 * surviving windows and the cut-out ones tile the original window exactly; at a
 * fractional speed a cut-out span can differ from `(cut length) * speed` by
 * under one source frame, which is the same per-boundary rounding the mapping
 * that produced those ranges already applied.
 */
function sourceWindowForSlice(
  clip: Clip,
  start: Frame,
  end: Frame,
): { inPoint: Frame; outPoint: Frame } {
  const inPoint = sourceFrameAtBoundary(clip, start);
  return {
    inPoint,
    outPoint: inPoint + Math.round((end - start) * effectiveSpeed(clip.speed)),
  };
}

/**
 * Source frames of headroom, expressed as whole TIMELINE frames.
 *
 * A user drag on a clip edge is a distance in TIMELINE frames -- the pointer
 * moves along the timeline -- while the headroom that bounds it is a distance
 * in the clip's SOURCE window (`inPoint`, or `outPoint` short of the asset's
 * end). The shared model advances source time `speed` frames per timeline
 * frame, so on a sped-up clip those are different scales: a 2x clip with 5
 * source frames before its asset starts has 2 timeline frames of drag left
 * before it, and a bound left in source frames would let the edge run twice as
 * far as the media allows and write an `inPoint` below zero or an `outPoint`
 * past the end of the asset. Flooring is the safe direction -- a bound one
 * frame too small refuses a legal drag, one too large corrupts the window --
 * and at speed 1 this is the source number itself.
 *
 * A compound's window is a range of NESTED-timeline frames mapped 1:1 onto its
 * own duration (compound validation requires `durationFrames === outPoint -
 * inPoint`, and `setClipSpeed` refuses the type), so its headroom is already a
 * timeline quantity and passes through untouched.
 */
function sourceHeadroomAsTimelineFrames(clip: Clip, headroom: Frame): Frame {
  if (clip.type === 'compound') return headroom;
  const speed = effectiveSpeed(clip.speed);
  return speed === 1 ? headroom : Math.floor(headroom / speed);
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

/**
 * The settings fields a paste would touch, narrowed by the requested field
 * groups — used for value comparison so unchanged pastes add no history.
 */
function pickSettings(
  clip: Clip,
  kind: ClipType,
  fields?: Array<'transform' | 'opacity' | 'blendMode' | 'volume'>,
): Record<string, unknown> {
  const want = (f: string): boolean => !fields || fields.includes(f as 'transform');
  if (kind === 'audio') {
    return want('volume') ? { volume: clip.volume } : {};
  }
  const out: Record<string, unknown> = {};
  if (want('opacity')) out.opacity = clip.opacity;
  if (want('blendMode')) out.blendMode = clip.blendMode ?? null;
  if (want('transform')) {
    out.x = clip.x;
    out.y = clip.y;
    out.rotation = clip.rotation;
    out.scaleX = clip.scaleX;
    out.scaleY = clip.scaleY;
  }
  return out;
}

/**
 * Narrow every title clip's stored variable-font axes on load (title.ts).
 * A hostile or hand-edited value degrades to absent; the load never throws.
 */
function withNarrowedTitleVariations(project: Project): Project {
  let changed = false;
  const clips = project.timeline.clips.map((clip) => {
    const narrowed = narrowTitleVariationClip(clip);
    if (narrowed !== clip) changed = true;
    return narrowed;
  });
  return changed ? { ...project, timeline: { ...project.timeline, clips } } : project;
}

/**
 * Narrow every shape clip's stored style on load (shape.ts). A hostile or
 * hand-edited value degrades to absent; the load never throws.
 */
function withNarrowedShapes(project: Project): Project {
  let changed = false;
  const clips = project.timeline.clips.map((clip) => {
    const narrowed = narrowShapeClip(clip);
    if (narrowed !== clip) changed = true;
    return narrowed;
  });
  return changed ? { ...project, timeline: { ...project.timeline, clips } } : project;
}

/**
 * Normalize opacity automation through the shared motion engine. Opacity is
 * range-limited by dropping invalid points rather than clamping them, so a
 * hostile project cannot create an out-of-range alpha animation.
 */
function sanitizeOpacityTrack(input: unknown): MotionTrack | undefined {
  if (!Array.isArray(input)) return undefined;
  const track = sanitizeMotion(input as Array<{ frame?: number; value?: number; easing?: unknown }>);
  if (!track) return undefined;
  const bounded = track.filter((point) => point.value >= 0 && point.value <= 1);
  return bounded.length >= 2 ? bounded : undefined;
}

function sameOpacityTrack(left: unknown, right: MotionTrack | undefined): boolean {
  if (!Array.isArray(left) || !right || left.length !== right.length) return false;
  return left.every((raw, index) => {
    const point = raw as { frame?: unknown; value?: unknown; easing?: unknown } | null;
    const expected = right[index]!;
    return point?.frame === expected.frame
      && point?.value === expected.value
      && normalizeEasing(point?.easing) === normalizeEasing(expected.easing);
  });
}

function narrowOpacityTrackClip(clip: Clip): Clip {
  const raw = (clip as Clip & { opacityTrack?: unknown }).opacityTrack;
  const track = sanitizeOpacityTrack(raw);
  if (track) return sameOpacityTrack(raw, track) ? clip : { ...clip, opacityTrack: track };
  if (!Object.prototype.hasOwnProperty.call(clip, 'opacityTrack') || raw === undefined) return clip;
  const copy = { ...clip };
  delete copy.opacityTrack;
  return copy;
}

function narrowTimelineOpacityTracks(timeline: Timeline): Timeline {
  let changed = false;
  const clips = timeline.clips.map((clip) => {
    const narrowed = narrowOpacityTrackClip(clip);
    if (narrowed !== clip) changed = true;
    return narrowed;
  });
  return changed ? { ...timeline, clips } : timeline;
}

/** Narrow opacity tracks on the main and every nested timeline during project read. */
function withNarrowedOpacityTracks(project: Project): Project {
  const timeline = narrowTimelineOpacityTracks(project.timeline);
  let timelines = project.timelines;
  if (timelines) {
    let nestedChanged = false;
    const nextTimelines: Record<string, Timeline> = {};
    for (const [id, nested] of Object.entries(timelines)) {
      const narrowed = narrowTimelineOpacityTracks(nested);
      nextTimelines[id] = narrowed;
      if (narrowed !== nested) nestedChanged = true;
    }
    if (nestedChanged) timelines = nextTimelines;
  }
  if (timeline === project.timeline && timelines === project.timelines) return project;
  return {
    ...project,
    timeline,
    ...(timelines === project.timelines ? {} : { timelines }),
  };
}

/**
 * Narrow every asset's stored AI description on load (#118 AI half).
 * A hostile or hand-edited value degrades to absent; the load never throws.
 */
function withNarrowedDescriptions(project: Project): Project {
  let changed = false;
  const media = project.media.map((asset) => {
    if (asset.aiDescription === undefined) return asset;
    const narrowed = narrowAiDescription(asset.aiDescription);
    if (narrowed === asset.aiDescription) return asset;
    changed = true;
    if (narrowed === undefined) {
      const copy = { ...asset };
      delete copy.aiDescription;
      return copy;
    }
    return { ...asset, aiDescription: narrowed };
  });
  return changed ? { ...project, media } : project;
}

/**
 * Clear the session-only solo flag when a project is loaded from durable
 * state. Live renderer/main synchronization deliberately does not call this:
 * a solo chosen for the current audition must be visible to the main
 * compositor and exporter.
 */
function clearSoloState(project: Project): Project {
  const clearTimeline = (timeline: Timeline): Timeline => {
    let changed = false;
    const tracks = timeline.tracks.map((track) => {
      if (track.soloed === undefined) return track;
      changed = true;
      const copy = { ...track };
      delete copy.soloed;
      return copy;
    });
    return changed ? { ...timeline, tracks } : timeline;
  };

  const timeline = clearTimeline(project.timeline);
  let timelines = project.timelines;
  if (timelines) {
    let nestedChanged = false;
    const next: NonNullable<Project['timelines']> = {};
    for (const [id, nested] of Object.entries(timelines)) {
      const cleared = clearTimeline(nested);
      next[id] = cleared;
      if (cleared !== nested) nestedChanged = true;
    }
    if (nestedChanged) timelines = next;
  }
  if (timeline === project.timeline && timelines === project.timelines) return project;
  return {
    ...project,
    timeline,
    ...(timelines === project.timelines ? {} : { timelines }),
  };
}

/**
 * True when two projects are the same project with the playheads possibly
 * somewhere else.
 *
 * Sibling windows receive whole-project snapshots, and a playhead move is the
 * one difference in one of them that is not editorial work. Pinning every
 * timeline's playhead on both sides and comparing the rest is what lets the
 * receiving window adopt a peer's cursor move without claiming unsaved work,
 * and therefore without arming the recovery snapshot that raises the
 * "Unsaved work found" prompt on the next launch. Any other difference is
 * editorial and answers false, which is the direction that keeps real work
 * protected.
 *
 * Compared by value, the way the snapshots travel: key order and spelling are
 * not differences, and a key explicitly set to `undefined` is the same as an
 * absent one, because JSON drops it in transit.
 */
export function sameProjectExceptPlayhead(left: Project, right: Project): boolean {
  if (left === right) return true;
  return sameJsonValue(withoutPlayheads(left), withoutPlayheads(right));
}

/** The project with every timeline's playhead pinned, so it cannot differ. */
function withoutPlayheads(project: Project): Project {
  const pin = (timeline: Timeline): Timeline => ({ ...timeline, playheadFrame: 0 });
  const timelines = project.timelines
    ? Object.fromEntries(
      Object.entries(project.timelines).map(([id, timeline]) => [id, pin(timeline)]),
    )
    : undefined;
  return {
    ...project,
    timeline: pin(project.timeline),
    ...(timelines ? { timelines } : {}),
  };
}

/** Value equality for JSON-shaped data. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object'
    || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => sameJsonValue(item, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => key in rightRecord
    && sameJsonValue(leftRecord[key], rightRecord[key]));
}

export class EditorController {  private project: Project;
  private history: CommandHistory;
  private listeners: Set<StateChangeListener> = new Set();
  /**
   * Clip lookups by id, valid only for the exact project object it was built
   * from (upstream PR #486). Every mutation  command execution, undo, redo,
   * restore  replaces `this.project` wholesale, so reference identity is a
   * complete invalidation signal and no revision counter is needed. First
   * occurrence wins per id, matching what the linear `Array.find` it replaced
   * returned.
   */
  private clipByIdCache?: { project: Project; scope: string | null; byId: Map<string, Clip> };
  /**
   * Active editing scope (upstream issue #155 slice 2): nested timeline ids
   * from the root down to the open timeline; empty = main timeline. View
   * state, like selection — never an undo entry, never serialized. Commands
   * snapshot the whole project, so undo/redo are scope-agnostic and the path
   * only needs coercing (dropping timelines that no longer exist) afterwards.
   */
  private activeTimelinePath: string[] = [];
  /** In-app clipboard for copy/cut/paste (R1). Not OS-shared by design. */
  private clipClipboard: ClipClipboardEntry[] = [];
  /**
   * Whether ripple edits carry markers along (upstream #560,
   * `rippleTimelineMarkers`, default on). A preference, not project data:
   * it never lands on the undo stack and is not serialized with the project.
   */
  private rippleTimelineMarkers: boolean = DEFAULT_MARKER_SETTINGS.rippleTimelineMarkers;
  /**
   * Depth of open `previewFrame` bodies. While non-zero, `execute` applies
   * commands without publishing them, so a live gesture's frames are applied
   * and observed but never reach the shared undo/redo stacks. A counter rather
   * than a flag so a preview inside a preview is still a preview.
   */
  private previewFrames: number = 0;

  constructor(project?: Project) {
    const narrowed = project
      ? withNarrowedOpacityTracks(narrowProjectGradePresetLinks(narrowMediaFolders(withNarrowedDescriptions(project))))
      : createEmptyProject();
    this.project = clearSoloState(
      withNarrowedCompounds(withNarrowedTitleVariations(withNarrowedShapes(narrowed))),
    );
    this.history = new CommandHistory();
  }

  //  State access 

  getProject(): Project {
    return this.project;
  }

  getTimeline() {
    return this.scopedTimeline();
  }

  getClips(): Clip[] {
    return this.scopedTimeline().clips;
  }

  getTracks(): Track[] {
    return this.scopedTimeline().tracks;
  }

  getMedia(): MediaAsset[] {
    return this.project.media;
  }

  getMediaFolders(): MediaFolder[] {
    return this.project.mediaFolders ?? [];
  }

  expandLinkedClipIds(clipIds: Iterable<string>, clips: readonly Clip[] = this.scopedTimeline().clips): string[] {
    const requested = new Set(clipIds);
    const groupIds = new Set(
      clips
        .filter((clip) => requested.has(clip.id) && clip.linkGroupId)
        .map((clip) => clip.linkGroupId!),
    );

    for (const clip of clips) {
      if (clip.linkGroupId && groupIds.has(clip.linkGroupId)) {
        requested.add(clip.id);
      }
    }
    return [...requested];
  }

  /** O(1) clip lookup, rebuilt lazily once per project revision (#486). */
  private findClipById(clipId: string): Clip | undefined {
    const scope = this.getActiveTimelineId();
    let cache = this.clipByIdCache;
    if (!cache || cache.project !== this.project || cache.scope !== scope) {
      const byId = new Map<string, Clip>();
      for (const clip of this.scopedTimeline().clips) {
        if (!byId.has(clip.id)) byId.set(clip.id, clip);
      }
      cache = { project: this.project, scope, byId };
      this.clipByIdCache = cache;
    }
    return cache.byId.get(clipId);
  }

  private canEditClipIds(clipIds: Iterable<string>): boolean {
    const ids = new Set(clipIds);
    const lockedTrackIds = new Set(
      this.scopedTimeline().tracks.filter((track) => track.locked).map((track) => track.id),
    );
    return this.scopedTimeline().clips
      .filter((clip) => ids.has(clip.id))
      .every((clip) => !lockedTrackIds.has(clip.trackId));
  }

  getPlayhead(): Frame {
    return this.scopedTimeline().playheadFrame;
  }

  // ─── Editing scope (upstream issue #155 slice 2) ──────────────────────────
  //
  // The active timeline is VIEW state owned here, next to the project it
  // views: every editing op below routes through scopedTimeline(), so the
  // full toolset works inside a nest unchanged, while undo stays coherent —
  // commands snapshot the whole project, so undo/redo never depend on which
  // scope is open, and the path is only coerced (dropping timelines that no
  // longer exist) afterwards. Switching scope notifies (the timeline panel
  // re-renders) but never touches history and is never serialized.

  /** Open-scope leaf id, or null on the main timeline. */
  getActiveTimelineId(): string | null {
    const leaf = this.activeTimelinePath[this.activeTimelinePath.length - 1];
    return leaf ?? null;
  }

  /** Breadcrumb chain from the root to the open scope (root alone at main). */
  getTimelineBreadcrumbs(): TimelineBreadcrumb[] {
    const path = this.activeTimelinePath;
    const crumbs: TimelineBreadcrumb[] = [
      { id: null, name: scopeDisplayName(this.project, null) },
    ];
    for (const id of path) {
      crumbs.push({ id, name: scopeDisplayName(this.project, id) });
    }
    return crumbs;
  }

  /**
   * The timeline the editor is currently inside (main at the root). Falls
   * back to the main timeline when the open scope no longer exists — every
   * commit coerces the path, so this is only a transient between a foreign
   * state adoption and the next commit.
   */
  getActiveTimeline(): Timeline {
    const leaf = this.getActiveTimelineId();
    if (leaf === null) return this.project.timeline;
    return this.project.timelines?.[leaf] ?? this.project.timeline;
  }

  /**
   * Explicit scope read for agent/MCP tools: `null` is always the main
   * timeline (omitted scope = root, exactly today's behavior), otherwise the
   * nested timeline or a precise dangling error. Never falls back — unlike
   * the ambient view above, a tool addressing a scope must know it is gone.
   */
  getTimelineInScope(scopeId: string | null): Timeline {
    return timelineInScope(this.project, scopeId);
  }

  /** The timeline every editing op below reads and writes. */
  private scopedTimeline(): Timeline {
    return this.getActiveTimeline();
  }

  /** Replant a timeline into the ambient scope slot. */
  private withScopedTimeline(next: Timeline): Project {
    return withTimelineInScope(this.project, this.getActiveTimelineId(), next);
  }

  /** Drop open-scope ids whose timelines no longer exist (deepest survivor wins). */
  private coerceScope(): void {
    const timelines = this.project.timelines;
    while (this.activeTimelinePath.length > 0) {
      const leaf = this.activeTimelinePath[this.activeTimelinePath.length - 1]!;
      if (timelines?.[leaf] !== undefined) break;
      this.activeTimelinePath.pop();
    }
  }

  /**
   * Open a nested timeline for in-place editing. Refuses precisely when the
   * id dangles, is unreachable from the main timeline (orphan or cycle), or
   * the recursion reachable through it would pass the depth cap (breadcrumb
   * distance plus the subtree below — the same bound the planner and the
   * render resolution enforce). Not an undo entry.
   */
  openNestedTimeline(timelineId: string): TimelineBreadcrumb[] {
    if (this.project.timelines?.[timelineId] === undefined) {
      throw new Error(`Nested timeline "${timelineId}" no longer exists.`);
    }
    const chain = timelineBreadcrumbs(this.project, timelineId);
    if (chain === null) {
      throw new Error(
        `Nested timeline "${timelineId}" is not reachable from the main timeline.`,
      );
    }
    const reachable = (chain.length - 1) + nestedSubtreeDepth(this.project, timelineId);
    if (reachable > MAX_COMPOUND_DEPTH) {
      throw new Error(
        `Nested timeline "${timelineId}" reaches ${reachable} levels deep, past the maximum of ${MAX_COMPOUND_DEPTH}.`,
      );
    }
    this.activeTimelinePath = chain.slice(1).map((crumb) => crumb.id as string);
    this.notify();
    return chain;
  }

  /**
   * Open the timeline a compound clip in the ACTIVE scope points at
   * (double-click / explicit Open action). Dangling compounds refuse with
   * the same wording flatten uses.
   */
  openCompoundClip(compoundClipId: string): TimelineBreadcrumb[] {
    const clip = this.scopedTimeline().clips.find((candidate) => candidate.id === compoundClipId);
    if (!clip) throw new Error(`Clip not found: ${compoundClipId}`);
    if (clip.type !== 'compound') {
      throw new Error(`Clip "${compoundClipId}" is not a compound clip.`);
    }
    const ref = sanitizeCompoundTimelineId(clip.compoundTimelineId);
    if (ref === undefined) {
      throw new Error(`Compound clip "${compoundClipId}" has no nested timeline reference.`);
    }
    return this.openNestedTimeline(ref);
  }

  /** Navigate one level up (no-op at the root). Not an undo entry. */
  navigateTimelineUp(): TimelineBreadcrumb[] {
    if (this.activeTimelinePath.length > 0) {
      this.activeTimelinePath.pop();
      this.notify();
    }
    return this.getTimelineBreadcrumbs();
  }

  /**
   * Jump to a breadcrumb (an ancestor scope or the root). Refuses ids outside
   * the current path — breadcrumbs navigate up, never sideways into an
   * unrelated timeline. Not an undo entry.
   */
  navigateToScope(scopeId: string | null): TimelineBreadcrumb[] {
    if (scopeId === null) {
      if (this.activeTimelinePath.length > 0) {
        this.activeTimelinePath = [];
        this.notify();
      }
      return this.getTimelineBreadcrumbs();
    }
    const at = this.activeTimelinePath.indexOf(scopeId);
    if (at === -1) {
      throw new Error(`Timeline "${scopeId}" is not on the current breadcrumb path.`);
    }
    this.activeTimelinePath = this.activeTimelinePath.slice(0, at + 1);
    this.notify();
    return this.getTimelineBreadcrumbs();
  }

  /**
   * Move the playhead of one explicit scope (the preview transport drives
   * the ROOT playhead: delivery lives in root frame space even while a nest
   * is open for editing).
   */
  setPlayheadInScope(frame: Frame, scopeId: string | null): void {
    this.movePlayhead(frame, scopeId);
  }

  //  Command execution

  execute(command: Command): void {
    // A preview frame applies without publishing, so it never becomes a
    // history entry and never displaces one (see previewFrame).
    this.project = this.previewFrames > 0
      ? command.execute(this.project)
      : this.history.execute(command, this.project);
    this.coerceScope();
    this.notify();
  }

  /**
   * Run `body` as an uncommitted PREVIEW FRAME: its operations apply to the
   * live project and subscribers see the result at once, but nothing is
   * published — not to the undo stack, not into an enclosing transaction. The
   * caller owns the frame and closes it one of two ways: `collapsePreviewFrame`
   * to roll it back, or by re-running the same operations through the normal
   * publishing path.
   *
   * A live gesture needs this because collapsing a frame means undoing the
   * previous one, and `undo()` pops whatever is on top of the SHARED history.
   * An edit adopted while the gesture is in flight — an AI agent's
   * `ReplaceProjectCommand`, pushed from main — lands on that same stack, so
   * the next pointer move would revert the agent's edit instead of the
   * gesture's own frame, and leave main holding a project the edit is no
   * longer in. A preview frame never reaches the stack, so a frame collapse
   * cannot consume history that is not the gesture's own.
   *
   * The window is synchronous, so a command from elsewhere can only arrive
   * BETWEEN frames, never inside one.
   */
  previewFrame<T>(body: () => T): T {
    this.previewFrames += 1;
    try {
      return body();
    } finally {
      this.previewFrames -= 1;
    }
  }

  /**
   * Roll back one live preview frame, identified by the scope as it stood
   * before and after the frame, without touching the undo/redo stacks.
   *
   * Undoing the frame's own command is not enough. Those commands replace a
   * whole clips array (a ripple trim replaces the whole project), so rolling
   * one back over a project another editor has since rewritten would take that
   * edit with it. So the collapse is driven by the two snapshots instead:
   *
   * - **nothing intervened** (`current === after`, exact because every
   *   mutation replaces the project object) — the pre-frame scope is restored
   *   wholesale, by reference, exactly as undoing the frame's command was.
   * - **something intervened** — only the properties the frame itself wrote
   *   are restored, found by diffing the two snapshots. An edit that landed
   *   mid-gesture survives, including one on a clip the frame moved: the
   *   gesture wins the properties it is actively dragging and nothing else.
   */
  collapsePreviewFrame(before: Timeline, after: Timeline, scopeId: TimelineScopeId = null): void {
    if (!scopeTimelineExists(this.project, scopeId)) return;
    const current = scopeTimeline(this.project, scopeId);
    let restored: Timeline;
    if (current === after) {
      restored = before;
    } else {
      const clipWrites = frameWrites(before.clips, after.clips);
      const markerWrites = frameWrites(before.markers ?? [], after.markers ?? []);
      if (clipWrites.size === 0 && markerWrites.size === 0) return;
      restored = {
        ...current,
        clips: revertFrameWrites(current.clips, before.clips, clipWrites),
        ...(current.markers
          ? { markers: revertFrameWrites(current.markers, before.markers ?? [], markerWrites) }
          : {}),
      };
    }
    this.project = {
      ...replaceScopeTimeline(this.project, scopeId, restored),
      updatedAt: new Date().toISOString(),
    };
    this.coerceScope();
    this.notify();
  }

  /**
   * Run `body` as ONE undoable action named `label`.
   *
   * Every command `body` executes through this controller is collected and
   * published as a single history entry, so a multi-command operation is
   * grouped by construction rather than by counting how many entries it
   * happened to push. `body` may nest inside an enclosing transaction, in which
   * case it joins it (see CommandHistory.commitTransaction).
   *
   * The three ways out are all deliberate:
   *
   * - **no command** — nothing is published, so a no-op, a validation refusal,
   *   or an early return that changed nothing adds no history entry.
   * - **normal return, including an early return or a cancellation** after
   *   partial mutation — the commands produced so far commit as exactly one
   *   entry. Never a fragment, never one entry per command.
   * - **throw** — the scope is aborted: nothing is published and the commands
   *   it produced are undone in reverse, restoring the pre-action project. An
   *   exception after a mutation therefore never leaves a mix of unrelated
   *   commands on the stack.
   */
  transaction<T>(label: string, body: () => T): T {
    this.history.beginTransaction(label);
    try {
      const result = body();
      this.history.commitTransaction();
      return result;
    } catch (error) {
      this.project = [...this.history.abortTransaction()].reverse()
        .reduce((state, command) => command.undo(state), this.project);
      this.coerceScope();
      this.notify();
      throw error;
    }
  }

  undo(): boolean {
    const result = this.history.undo(this.project);
    if (result) {
      this.project = result;
      this.coerceScope();
      this.notify();
      return true;
    }
    return false;
  }

  redo(): boolean {
    const result = this.history.redo(this.project);
    if (result) {
      this.project = result;
      this.coerceScope();
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

  /** Human-readable description of the next undo, or null. */
  getLastCommandDescription(): string | null {
    return this.history.lastCommandName();
  }

  //  High-level editing API (used by UI, agent, MCP) 

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
    const track = this.scopedTimeline().tracks.find((candidate) => candidate.id === params.trackId);

    // Refuse an unknown track rather than placing a clip nothing can reach.
    // Tracks are what the timeline, the compositor and the exporter all iterate,
    // so a clip naming a track that does not exist is invisible everywhere while
    // still counting in the clip list and toward the project duration  and the
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

      this.execute(new AddMediaAndClipsCommand([], clips, 'Add clip', tracks, this.getActiveTimelineId()));
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
    this.execute(new AddClipCommand(clip, this.getActiveTimelineId()));
    return clip.id;
  }

  /**
   * Clear one project-frame span the way overwrite placement does — split
   * survivors and drop the covered middles with correct source mapping —
   * on every track where a non-protected clip intersects the span, so a
   * covered clip's linked partners on other tracks are overwritten with it
   * and A/V stays paired. trim_clips uses this to realize the upstream
   * ripple=false contract that extending an edge overwrites whatever the
   * new span overlaps. Refuses (returns null) when a covered clip sits on
   * a locked track; a no-op clears nothing and adds no history entry.
   */
  overwriteClearSpan(
    span: { start: Frame; end: Frame },
    protectedIds: Iterable<string>,
  ): { removedClipIds: string[]; trimmedClipIds: string[] } | null {
    const before = this.scopedTimeline().clips;
    const keep = new Set(protectedIds);
    const others = before.filter((clip) => !keep.has(clip.id));
    const affectedTracks = new Set(
      others
        .filter(
          (clip) =>
            clip.startFrame < span.end && clip.startFrame + clip.durationFrames > span.start,
        )
        .map((clip) => clip.trackId),
    );
    if (affectedTracks.size === 0) return { removedClipIds: [], trimmedClipIds: [] };
    const affected = others.filter((clip) => affectedTracks.has(clip.trackId));
    if (!this.canEditClipIds(affected.map((clip) => clip.id))) return null;

    const spansByTrack = new Map([...affectedTracks].map((trackId) => [trackId, [span]]));
    const cleared = this.clearTrackSpans(others, spansByTrack);
    const fragmentsById = new Map<string, Clip[]>();
    for (const fragment of cleared) {
      const list = fragmentsById.get(fragment.id);
      if (list) list.push(fragment);
      else fragmentsById.set(fragment.id, [fragment]);
    }

    const removedClipIds: string[] = [];
    const trimmedClipIds: string[] = [];
    const final = before.flatMap((clip) => {
      if (keep.has(clip.id)) return [clip];
      const fragments = fragmentsById.get(clip.id);
      if (!fragments) {
        removedClipIds.push(clip.id);
        return [];
      }
      const changed =
        fragments.length !== 1
        || fragments[0].startFrame !== clip.startFrame
        || fragments[0].durationFrames !== clip.durationFrames;
      if (changed) trimmedClipIds.push(clip.id);
      return fragments;
    });

    if (removedClipIds.length === 0 && trimmedClipIds.length === 0) {
      return { removedClipIds, trimmedClipIds };
    }
    this.execute(new ReplaceClipsCommand(final, 'Overwrite trim extension', this.getActiveTimelineId()));
    return { removedClipIds, trimmedClipIds };
  }

  /**
   * Split every clip intersecting the given per-track spans and drop the
   * covered middles, keeping head/tail fragments with correct source mapping
   * and no ripple shift. Shared by clipboard paste and overwrite placement.
   */
  private clearTrackSpans(
    clips: Clip[],
    spansByTrack: Map<string, Array<{ start: Frame; end: Frame }>>,
  ): Clip[] {
    return clips.flatMap((clip) => {
      const spans = spansByTrack.get(clip.trackId);
      if (!spans) return [clip];
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
        const window = sourceWindowForSlice(clip, segment.start, segment.end);
        return {
          ...clip,
          startFrame: segment.start,
          durationFrames: segment.end - segment.start,
          inPoint: window.inPoint,
          outPoint: window.outPoint,
          fadeInFrames: headKept ? clip.fadeInFrames : 0,
          fadeOutFrames:
            segment.end === clip.startFrame + clip.durationFrames ? clip.fadeOutFrames : 0,
        };
      });
    });
  }

  /**
   * Place media with an explicit collision mode (roadmap R1; upstream pairs
   * `add_clips`/`insert_clips`).
   *
   * - `overwrite` clears the destination span first (splitting survivors),
   *   leaving other tracks untouched.
   * - `insert` ripple-pushes the target track's later clips — plus any linked
   *   partners of those clips on their own tracks — later by the placed
   *   length, then lands at `startFrame`.
   * - `append` lands after the last clip on the track.
   *
   * Video placements with embedded audio create a linked audio partner on a
   * free lane exactly like `addClip`, atomically creating one when needed.
   * Everything is one undoable step. Returns null for unknown/incompatible
   * asset-track pairs and locked tracks.
   */
  placeClipWithMode(params: {
    assetId: string;
    trackId: string;
    mode?: 'overwrite' | 'insert' | 'append';
    startFrame?: Frame;
    durationFrames?: Frame;
    /** Source window in seconds, [start, end) — three-point editing's In/Out. */
    source?: [number, number];
  }): { clipIds: string[] } | null {
    const asset = this.project.media.find((m) => m.id === params.assetId);
    const track = this.scopedTimeline().tracks.find((t) => t.id === params.trackId);
    if (!asset || !track || track.locked) return null;
    if (!isMediaCompatibleWithTrack(asset.type, track.type)) return null;

    const fps = this.project.settings.fps;
    const mode = params.mode ?? 'overwrite';

    // Source-window resolution mirrors upstream resolvePlacement: `source`
    // and `durationFrames` are mutually exclusive; a source span is clamped
    // to the asset and must survive as at least one frame.
    let duration: Frame;
    let inPoint: Frame;
    if (params.source !== undefined) {
      if (params.durationFrames !== undefined) {
        throw new Error(
          'Set source OR durationFrames, not both — source picks a span of the asset, durationFrames an exact timeline length.',
        );
      }
      const [rawStart, rawEnd] = params.source;
      if (
        !Number.isFinite(rawStart) || !Number.isFinite(rawEnd)
        || rawStart < 0 || rawEnd <= rawStart
      ) {
        throw new Error('source must be [startSeconds, endSeconds] with 0 <= start < end.');
      }
      const assetLen = assetDurationSeconds(asset, fps);
      if (asset.type !== 'image') {
        if (assetLen <= 0) {
          throw new Error(
            'source needs a known source length; this asset has none. Use durationFrames.',
          );
        }
        if (rawStart >= assetLen) {
          throw new Error(`source start (${rawStart}s) is past the end of the asset (${assetLen}s).`);
        }
      }
      const startSec = Math.max(0, rawStart);
      const endSec = asset.type === 'image' ? rawEnd : Math.min(rawEnd, assetLen);
      inPoint = Math.round(startSec * fps);
      duration = Math.max(1, Math.round(endSec * fps) - inPoint);
    } else {
      duration = clampFrame(params.durationFrames || placementDuration(asset, fps), 1);
      inPoint = 0;
    }

    let start: Frame;
    if (mode === 'append') {
      start = this.scopedTimeline().clips
        .filter((c) => c.trackId === params.trackId)
        .reduce((max, c) => Math.max(max, c.startFrame + c.durationFrames), 0);
    } else {
      start = clampFrame(params.startFrame ?? this.getPlayhead());
    }

    let clips = [...this.scopedTimeline().clips];
    const newTracks: Track[] = [];

    if (mode === 'overwrite') {
      clips = this.clearTrackSpans(
        clips,
        new Map([[params.trackId, [{ start, end: start + duration }]]]),
      );
    } else if (mode === 'insert') {
      const movingIds = new Set(this.expandLinkedClipIds(
        clips.filter((c) => c.trackId === params.trackId && c.startFrame >= start).map((c) => c.id),
      ));
      clips = clips.map((clip) =>
        movingIds.has(clip.id)
          ? { ...clip, startFrame: clampFrame(clip.startFrame + duration) }
          : clip,
      );
    }

    const linkGroupId =
      asset.type === 'video' && track.type === 'video' && hasEmbeddedAudio(asset)
        ? nanoid()
        : undefined;
    const mainClip = this.createPlacedClip(
      asset, asset.type, params.trackId, start, duration, linkGroupId,
      mode === 'append' ? 0 : inPoint,
    );
    const createdClips = [mainClip];
    let audioClip: Clip | undefined;
    if (linkGroupId) {
      const audioTrack = this.resolveAudioPlacementTrack(start, duration, createdClips, newTracks);
      audioClip = this.createPlacedClip(asset, 'audio', audioTrack.id, start, duration, linkGroupId,
        mode === 'append' ? 0 : inPoint);
      createdClips.push(audioClip);
    }
    const finalClips = [...clips, ...createdClips];

    if (newTracks.length > 0) {
      this.execute(new AddMediaAndClipsCommand([], finalClips, mode === 'insert' ? 'Insert clip' : 'Place clip', newTracks, this.getActiveTimelineId()));
    } else {
      this.execute(new ReplaceClipsCommand(finalClips, mode === 'insert' ? 'Insert clip' : 'Place clip', this.getActiveTimelineId()));
    }
    return { clipIds: createdClips.map((clip) => clip.id) };
  }

  removeClip(clipId: string): boolean {
    return this.removeClips([clipId]);
  }

  removeClips(clipIds: Iterable<string>, includeLinked = true): boolean {
    const requested = [...clipIds];
    const ids = new Set(includeLinked ? this.expandLinkedClipIds(requested) : requested);
    if (!this.scopedTimeline().clips.some((clip) => ids.has(clip.id))) return false;
    if (!this.canEditClipIds(ids)) return false;
    this.execute(
      new ReplaceClipsCommand(
        this.scopedTimeline().clips.filter((clip) => !ids.has(clip.id)),
        ids.size > 1 ? 'Remove linked clips' : 'Remove clip',
        this.getActiveTimelineId(),
      ),
    );
    return true;
  }

  rippleDeleteClips(clipIds: Iterable<string>): RippleDeleteReport | null {
    const ids = new Set(this.expandLinkedClipIds(clipIds));
    const selected = this.scopedTimeline().clips.filter((clip) => ids.has(clip.id));
    if (selected.length === 0 || !this.canEditClipIds(ids)) return null;

    const globalRanges: RippleRange[] = selected.map((clip) => ({
      start: clip.startFrame,
      end: clip.startFrame + clip.durationFrames,
    }));
    const shifts = new Map<string, Frame>();
    const trackHoles: RippleRange[][] = [];

    for (const track of this.scopedTimeline().tracks) {
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

      const remaining = this.scopedTimeline().clips.filter(
        (clip) => clip.trackId === track.id && !ids.has(clip.id),
      );
      for (const shift of computeRippleShifts(remaining, ranges)) {
        shifts.set(shift.clipId, shift.startFrame);
      }
    }

    const clips = this.scopedTimeline().clips
      .filter((clip) => !ids.has(clip.id))
      .map((clip) => {
        const startFrame = shifts.get(clip.id);
        return startFrame === undefined ? clip : { ...clip, startFrame };
      });
    const markerDelta = this.executeRipple(clips, this.rippleMarkersClosing(trackHoles), 'Ripple delete clips');

    return {
      removedClipIds: selected.map((clip) => clip.id),
      shiftedClipIds: [...shifts.keys()],
      ...markerDelta,
    };
  }

  rippleDeleteGap(trackId: string, range: RippleRange): RippleDeleteReport | null {
    const track = this.scopedTimeline().tracks.find((candidate) => candidate.id === trackId);
    const start = asValidFrame(range.start);
    const end = asValidFrame(range.end);
    if (!track || track.locked || start === null || end === null || end <= start) return null;

    const anchorClips = this.scopedTimeline().clips.filter((clip) => clip.trackId === trackId);
    if (anchorClips.some((clip) =>
      clip.startFrame < end && clip.startFrame + clip.durationFrames > start
    )) {
      return null;
    }

    const shifts = new Map<string, Frame>();
    for (const candidate of this.scopedTimeline().tracks) {
      if (candidate.locked || (candidate.id !== trackId && candidate.syncLocked === false)) continue;
      const clips = this.scopedTimeline().clips.filter((clip) => clip.trackId === candidate.id);
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
    const clips = this.scopedTimeline().clips.map((clip) => {
      const startFrame = shifts.get(clip.id);
      return startFrame === undefined ? clip : { ...clip, startFrame };
    });
    const markerDelta = this.executeRipple(
      clips,
      this.rippleMarkersClosing([[{ start, end }]]),
      'Ripple delete gap',
    );
    return { removedClipIds: [], shiftedClipIds: [...shifts.keys()], ...markerDelta };
  }

  rippleDeleteRanges(trackId: string, ranges: RippleRange[]): RippleRangesReport | null {
    const anchorTrack = this.scopedTimeline().tracks.find((track) => track.id === trackId);
    const validRanges = ranges.flatMap((range) => {
      const start = asValidFrame(range.start);
      const end = asValidFrame(range.end);
      return start !== null && end !== null && end > start ? [{ start, end }] : [];
    });
    const merged = mergeRippleRanges(validRanges);
    if (!anchorTrack || anchorTrack.locked || merged.length === 0) return null;

    const clearTrackIds = new Set(
      this.scopedTimeline().tracks
        .filter((track) => track.id === trackId || track.syncLocked !== false)
        .map((track) => track.id),
    );

    // A linked partner follows the cut even when its track opted out of sync lock.
    let expanded = true;
    while (expanded) {
      expanded = false;
      const overlappingGroupIds = new Set(
        this.scopedTimeline().clips
          .filter((clip) =>
            clearTrackIds.has(clip.trackId)
            && clip.linkGroupId
            && merged.some((range) =>
              range.start < clip.startFrame + clip.durationFrames && range.end > clip.startFrame
            ),
          )
          .map((clip) => clip.linkGroupId!),
      );
      for (const clip of this.scopedTimeline().clips) {
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

    if (this.scopedTimeline().tracks.some((track) =>
      clearTrackIds.has(track.id) && track.locked
    )) {
      return null;
    }

    const removedClipIds: string[] = [];
    const fragmentClipIds: string[] = [];
    const shiftedClipIds: string[] = [];
    const fragmentGroups = new Map<string, string>();
    let changed = false;

    const clips = this.scopedTimeline().clips.flatMap((clip) => {
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
        const { inPoint, outPoint } = sourceWindowForSlice(clip, segment.start, segment.end);
        return {
          ...clip,
          id,
          linkGroupId,
          startFrame: segment.start - shift,
          durationFrames: segment.end - segment.start,
          inPoint,
          outPoint,
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
    const markerDelta = diffMarkers(this.getMarkers(), markers);
    if (markers === null) {
      const project: Project = this.withScopedTimeline({
        ...this.scopedTimeline(),
        clips,
        inFrame: undefined,
        outFrame: undefined,
      });
      this.execute(new ReplaceProjectCommand(project, 'Ripple delete ranges'));
    } else {
      this.execute(new ReplaceProjectCommand(this.withScopedTimeline({
        ...this.scopedTimeline(),
        clips,
        markers,
        inFrame: undefined,
        outFrame: undefined,
      }), 'Ripple delete ranges'));
    }
    return {
      removedFrames: merged.reduce((total, range) => total + range.end - range.start, 0),
      clearedTrackIds: [...clearTrackIds],
      removedClipIds,
      fragmentClipIds,
      shiftedClipIds,
      ...markerDelta,
    };
  }

  moveClip(clipId: string, newStartFrame: Frame, newTrackId?: string): void {
    const clip = this.findClipById(clipId);
    if (!clip) return;

    const targetFrame = clampFrame(newStartFrame);
    const delta = targetFrame - clip.startFrame;
    const linkedIds = new Set(this.expandLinkedClipIds([clipId]));
    if (!this.canEditClipIds(linkedIds)) return;
    if (newTrackId && this.scopedTimeline().tracks.find((track) => track.id === newTrackId)?.locked) {
      return;
    }
    const clips = this.scopedTimeline().clips.map((candidate) => {
      if (!linkedIds.has(candidate.id)) return candidate;
      return {
        ...candidate,
        startFrame: clampFrame(candidate.startFrame + delta),
        trackId: candidate.id === clipId && newTrackId ? newTrackId : candidate.trackId,
      };
    });
    this.execute(new ReplaceClipsCommand(clips, linkedIds.size > 1 ? 'Move linked clips' : 'Move clip', this.getActiveTimelineId()));
  }

  trimClip(clipId: string, newInPoint: Frame, newOutPoint: Frame): void {
    // Reject non-finite/out-of-range points outright; clamp ordering so
    // outPoint is always strictly greater than inPoint.
    const inPoint = clampFrame(newInPoint);
    const outPoint = clampFrame(newOutPoint, inPoint + 1);
    const linkedIds = new Set(this.expandLinkedClipIds([clipId]));
    const lead = this.scopedTimeline().clips.find((clip) => clip.id === clipId);
    if (!linkedIds.has(clipId) || !lead) {
      return;
    }
    if (!this.canEditClipIds(linkedIds)) return;
    // The window the caller asked for is the input and is in SOURCE frames;
    // the clip's length is a TIMELINE one and follows from that window through
    // the addressed clip's speed (`trimWindowDurationFrames`). Reading the
    // timeline length off the source span instead made the clip disagree with
    // its own window by the speed factor -- the same disagreement
    // `setClipSpeed` writes the other way round. One length for the group, as
    // the window is one window: a linked pair keeps the shared timing
    // `trimClipEdge` gives it, rather than each half taking its own speed's
    // reading of one range.
    const durationFrames = trimWindowDurationFrames(lead, inPoint, outPoint);
    const clips = this.scopedTimeline().clips.map((clip) =>
      linkedIds.has(clip.id)
        ? {
            ...clip,
            inPoint,
            outPoint,
            durationFrames,
          }
        : clip,
    );
    this.execute(new ReplaceClipsCommand(clips, linkedIds.size > 1 ? 'Trim linked clips' : 'Trim clip', this.getActiveTimelineId()));
  }

  trimClipEdge(
    clipId: string,
    edge: TrimEdge,
    deltaFrames: Frame,
    ripple = false,
    scope: 'linked' | 'single' = 'linked',
  ): RippleTrimReport | null {
    const lead = this.findClipById(clipId);
    const requestedDelta = Math.round(deltaFrames);
    if (!lead || !Number.isFinite(requestedDelta) || requestedDelta === 0) return null;

    // J/L affordance: Alt-trim scopes to the grabbed half only, so the audio
    // side of a linked pair can extend past the picture (or vice versa) while
    // the pair keeps moving together afterwards.
    const targetIds = new Set(scope === 'single' ? [clipId] : this.expandLinkedClipIds([clipId]));
    if (!this.canEditClipIds(targetIds)) return null;
    const targets = this.scopedTimeline().clips.filter((clip) => targetIds.has(clip.id));
    const durationDeltaRequested = edge === 'right' ? requestedDelta : -requestedDelta;

    let minDurationDelta = Math.max(...targets.map((clip) => -(clip.durationFrames - 1)));
    // Every headroom below is a distance in the clip's own SOURCE window, and
    // the drag it bounds is measured in TIMELINE frames, so each bound is
    // converted to the drag's scale first (`sourceHeadroomAsTimelineFrames`).
    // Clamping against the source number instead would leave a sped-up clip
    // with speed× more room than its media has.
    let maxDurationDelta = Math.min(...targets.map((clip) => {
      if (edge === 'left') {
        const headroom = sourceHeadroomAsTimelineFrames(clip, clip.inPoint);
        return ripple ? headroom : Math.min(headroom, clip.startFrame);
      }
      if (clip.type === 'compound') {
        // A compound's source length is its nested content: extending past it
        // would open a dead window that renders nothing, so headroom ends at
        // the content end exactly like a media clip's ends at its duration.
        const ref = sanitizeCompoundTimelineId(clip.compoundTimelineId);
        const nested = ref !== undefined ? this.project.timelines?.[ref] : undefined;
        if (!nested) return 0;
        const contentEnd = nested.clips.reduce(
          (latest, inner) => Math.max(latest, inner.startFrame + inner.durationFrames),
          0,
        );
        return Math.max(0, contentEnd - clip.outPoint);
      }
      const asset = this.project.media.find((candidate) => candidate.id === clip.assetId);
      return asset && asset.duration > 0
        ? sourceHeadroomAsTimelineFrames(clip, Math.max(0, asset.duration - clip.outPoint))
        : Number.POSITIVE_INFINITY;
    }));

    const targetTrackIds = new Set(targets.map((clip) => clip.trackId));
    const leadEnd = lead.startFrame + lead.durationFrames;
    if (ripple && durationDeltaRequested < 0) {
      for (const track of this.scopedTimeline().tracks) {
        if (
          track.locked
          || targetTrackIds.has(track.id)
          || track.syncLocked === false
        ) {
          continue;
        }
        const clips = this.scopedTimeline().clips.filter((clip) => clip.trackId === track.id);
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
      for (const track of this.scopedTimeline().tracks) {
        if (track.locked || (track.syncLocked === false && !targetTrackIds.has(track.id))) continue;
        const trackTarget = targets.find((clip) => clip.trackId === track.id);
        const shiftPoint = trackTarget
          ? trackTarget.startFrame + trackTarget.durationFrames
          : leadEnd;
        for (const clip of this.scopedTimeline().clips) {
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

    const clips = this.scopedTimeline().clips.map((clip) => {
      if (targetIds.has(clip.id)) {
        // The drag is a TIMELINE distance and the clip's window is a SOURCE
        // one, so the window is rebuilt through the shared model
        // (`sourceOffset = inPoint + (timelineFrame - startFrame) * speed`)
        // instead of being slid by the same raw delta. Moving the window by
        // the drag distance moved a 2x clip's source by half what the edge
        // actually travelled. `durationFrames` stays the timeline length, so at
        // speed 1 the mapped window is the delta arithmetic it replaces.
        if (edge === 'right') {
          return {
            ...clip,
            durationFrames: clip.durationFrames + durationDelta,
            outPoint: sourceWindowForSlice(
              clip,
              clip.startFrame,
              clip.startFrame + clip.durationFrames + durationDelta,
            ).outPoint,
          };
        }
        return {
          ...clip,
          startFrame: ripple ? clip.startFrame : clip.startFrame - durationDelta,
          durationFrames: clip.durationFrames + durationDelta,
          // The grabbed material travels with the edge, so the window's leading
          // source frame is wherever the edge now sits -- the same
          // grabbed-material window in both ripple modes: a ripple left trim
          // leaves `startFrame` in place and pulls the timeline in behind the
          // material, but the edge moved, so the source frame under it moved
          // with it. `outPoint` is deliberately untouched: the out end is not
          // the edge being dragged, and the new in point already leaves it
          // where the model says it belongs.
          inPoint: sourceFrameAtBoundary(clip, clip.startFrame - durationDelta),
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
    const markerDelta = this.executeRipple(
      clips,
      markers,
      ripple ? 'Ripple trim clips' : targetIds.size > 1 ? 'Trim linked clips' : 'Trim clip',
    );
    return {
      resizedClipIds: targets.map((clip) => clip.id),
      shiftedClipIds: [...shifts.keys()],
      durationDelta,
      ...markerDelta,
    };
  }

  splitClip(clipId: string, atFrame: Frame): string | null {
    const plan = this.planClipSplit(clipId, atFrame);
    if (!plan) return null;
    this.execute(new ReplaceClipsCommand(plan.clips, plan.label, this.getActiveTimelineId()));
    return plan.rightId;
  }

  /**
   * Split every named clip at one frame as ONE undoable edit, linked partners
   * included (the same per-clip contract splitClip has, applied to each target
   * in turn). Targets are resolved against live state inside the transaction,
   * so a target an earlier split made unsplittable is skipped rather than
   * corrupting the timeline.
   *
   * Returns the new right-hand clip id for each clip actually split, in input
   * order. A clip the frame does not fall strictly inside, or that the
   * controller refuses (unknown, invalid frame, locked track), contributes
   * nothing, and a run that splits nothing adds no history entry.
   */
  splitClips(clipIds: Iterable<string>, atFrame: Frame): string[] {
    const frame = asValidFrame(atFrame);
    const rightIds: string[] = [];
    if (frame === null) return rightIds;
    this.transaction('Split clips at playhead', () => {
      for (const clipId of clipIds) {
        const plan = this.planClipSplit(clipId, frame);
        if (!plan) continue;
        this.execute(new ReplaceClipsCommand(plan.clips, plan.label, this.getActiveTimelineId()));
        rightIds.push(plan.rightId);
      }
    });
    return rightIds;
  }

  /**
   * Resolve one split against the CURRENT project without executing it, so both
   * splitClip and splitClips apply identical per-clip rules. Returns the next
   * clip array, the label its own history entry would carry, and the new
   * right-hand id for the requested clip — or null when the split is refused.
   */
  private planClipSplit(
    clipId: string,
    atFrame: Frame,
  ): { clips: Clip[]; label: string; rightId: string } | null {
    const clip = this.findClipById(clipId);
    if (!clip) return null;

    // Validate the split frame before any arithmetic; null = reject.
    const frame = asValidFrame(atFrame);
    if (frame === null) return null;

    const relativeFrame = frame - clip.startFrame;
    if (relativeFrame <= 0 || relativeFrame >= clip.durationFrames) return null;

    const linkedIds = new Set(this.expandLinkedClipIds([clipId]));
    const splitTargets = this.scopedTimeline().clips.filter((candidate) =>
      linkedIds.has(candidate.id)
      && frame > candidate.startFrame
      && frame < candidate.startFrame + candidate.durationFrames,
    );
    if (splitTargets.length === 0) return null;
    if (!this.canEditClipIds(splitTargets.map((target) => target.id))) return null;

    const rightLinkGroupId = splitTargets.length > 1 ? nanoid() : undefined;
    const rightIds = new Map<string, string>();
    const clips = this.scopedTimeline().clips.flatMap((candidate) => {
      if (!splitTargets.some((target) => target.id === candidate.id)) return [candidate];

      const relativeFrame = frame - candidate.startFrame;
      const rightId = nanoid();
      rightIds.set(candidate.id, rightId);
      // The left half's out point IS the right half's in point: one boundary,
      // rounded once, so a split cannot open a source gap at a fractional speed.
      const boundary = sourceFrameAtBoundary(candidate, frame);
      return [
        {
          ...candidate,
          durationFrames: relativeFrame,
          outPoint: boundary,
        },
        {
          ...candidate,
          id: rightId,
          linkGroupId: rightLinkGroupId,
          startFrame: frame,
          durationFrames: candidate.durationFrames - relativeFrame,
          inPoint: boundary,
        },
      ];
    });

    return {
      clips,
      label: splitTargets.length > 1 ? 'Split linked clips' : 'Split clip',
      rightId: rightIds.get(clipId)!,
    };
  }

  addTrack(type: 'video' | 'audio', name?: string): string {
    const existing = this.scopedTimeline().tracks.filter((t) => t.type === type);
    const trackName = name || `${type === 'video' ? 'Video' : 'Audio'} ${existing.length + 1}`;
    const track: Track = {
      id: nanoid(),
      name: trackName,
      type,
      locked: false,
      visible: true,
      syncLocked: true,
      order: this.scopedTimeline().tracks.length,
    };
    this.execute(new AddTrackCommand(track, this.getActiveTimelineId()));
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
   * Toggle solo on a track (upstream PR #428). Solo is session audition state:
   * it does not create an undo entry, but it is carried in the live serialized
   * snapshot so the main compositor and exporter apply the same selection.
   * Project-load initialization clears it again. When any track is soloed,
   * only soloed tracks are considered active for preview, export, and audio
   * playback.
   */
  toggleTrackSolo(trackId: string): void {
    const track = this.scopedTimeline().tracks.find((t) => t.id === trackId);
    if (!track) return;
    track.soloed = !track.soloed;
    this.notify();
  }

  /**
   * Return the set of track ids that are effectively active, accounting for
   * solo. If no tracks are soloed, all visible tracks are active. If any
   * tracks are soloed, only soloed tracks are active.
   */
  activeTrackIds(): Set<string> {
    const tracks = this.scopedTimeline().tracks;
    const anySoloed = tracks.some((t) => t.soloed);
    if (!anySoloed) {
      return new Set(tracks.filter((t) => t.visible !== false).map((t) => t.id));
    }
    return new Set(
      tracks
        .filter((t) => t.soloed && t.visible !== false)
        .map((t) => t.id),
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
    const track = this.scopedTimeline().tracks.find((candidate) => candidate.id === trackId);
    if (!track) return false;
    const name = resolveTrackName(rawName, this.generatedTrackLabel(track));
    if (name === null || name === track.name) return false;
    return this.updateTrack(trackId, { name }, 'Rename track');
  }

  /** The automatic label for a track's position among tracks of its type. */
  private generatedTrackLabel(track: Track): string {
    return generatedTrackLabelIn(track, this.scopedTimeline().tracks);
  }

  /**
   * Reorder, restyle, rename, and remove tracks in one atomic, undoable step
   * (upstream PR #520's `manage_tracks` surface).
   *
   * Every entry addresses a track by exactly one of `trackId` or current
   * `index`  never both (the #302 mis-targeting class). Reorder destinations
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
      throw new Error('Nothing to do  pass at least one of reorder, set, remove.');
    }

    // All selectors resolve against the current track list, up front.
    const resolveSelector = (
      entry: { trackId?: string; index?: number },
      path: string,
    ): { id: string } => {
      const tracks = this.scopedTimeline().tracks;
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

    //  Apply: reorders  sets  removes, mirroring upstream's order 
    let working = [...this.scopedTimeline().tracks];
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
      const clipCount = this.scopedTimeline().clips.filter((clip) => clip.trackId === id).length;
      if (clipCount > 0) {
        throw new Error(
          `"${track.name}" still has ${clipCount} clip(s)  move or remove them first.`,
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
    // are reassigned (descending  array head is the top compositing layer)
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
    const current = this.scopedTimeline().tracks;
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

    this.execute(new ReplaceTracksCommand(nextTracks, 'Manage tracks', this.getActiveTimelineId()));

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

  //  Clipboard: copy / cut / paste (R1, upstream EditorViewModel+Clipboard) 

  /** Snapshot the given clips into the in-app clipboard; returns the count. */
  copyClips(clipIds: Iterable<string>): number {
    const requested = new Set(clipIds);
    const tracks = this.scopedTimeline().tracks;
    const captures = this.scopedTimeline().clips
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
    const tracks = this.scopedTimeline().tracks;

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
    // span and drop the covered middle  clearRegion without ripple shift.
    const spansByTrack = new Map<string, Array<{ start: Frame; end: Frame }>>();
    for (const p of placements) {
      const list = spansByTrack.get(p.dstTrackId) ?? [];
      list.push({ start: p.dstStart, end: p.dstStart + p.clip.durationFrames });
      spansByTrack.set(p.dstTrackId, list);
    }

    const newIds: string[] = [];
    // Overwrite via the shared span-clearing helper: split survivors, drop
    // covered middles, no ripple shift.
    const clips = [
      ...this.clearTrackSpans(this.scopedTimeline().clips, spansByTrack),
    ];

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
      this.getActiveTimelineId(),
    ));
    return newIds;
  }

  //  Timeline markers (upstream PRs #542 / #560) 

  // ─── Clip settings transfer / paste attributes (R1; upstream #515) ────────

  /**
   * Copy one clip's presentation settings onto every target clip in a single
   * undoable step (upstream `applyClipSettings`). Only presentation fields
   * transfer — timing, trims, source, linkage, and fades stay the target's:
   *
   * - audio targets receive `volume`;
   * - visual targets receive opacity, position, rotation, scale, blend
   *   mode, the color grade, the LUT reference, and the effect stages
   *   (blur, vignette, grain, glow) — a source carrying grade or effects
   *   replaces the target's wholesale, clearing the stages it lacks;
   * - title/generated targets count as visual.
   *
   * Targets must be the same media kind as the source; refusals carry
   * upstream's message shape. Unchanged targets are reported rather than
   * silently skipped, and a call whose targets all match already adds no
   * history entry.
   */
  transferClipSettings(
    sourceClipId: string,
    targetClipIds: Iterable<string>,
    actionName = 'Paste clip settings',
  ): { changedClipIds: string[]; unchangedClipIds: string[] } {
    const seen = new Set<string>();
    const targets = [...targetClipIds].filter((id) => !seen.has(id) && seen.add(id));
    if (targets.length === 0) throw new Error('Provide at least one target clip.');

    const source = this.findClipById(sourceClipId);
    if (!source) throw new Error(`Clip not found: ${sourceClipId}`);

    const replacements = new Map<string, Clip>();
    for (const id of targets) {
      const target = this.findClipById(id);
      if (!target) throw new Error(`Clip not found: ${id}`);
      if (target.type !== source.type) {
        throw new Error(
          `Clip ${id} is ${target.type}; copied settings require ${source.type} clips.`,
        );
      }
      let next = target;
      if (id !== sourceClipId) {
        next =
          target.type === 'audio'
            ? {
                ...target,
                volume: source.volume,
                // Pan travels like volume (a scalar). EQ, compressor, and
                // noise reduction follow the color grade rule below:
                // wholesale-replaced when the source has one, left alone
                // when the source is neutral.
                pan: source.pan,
                ...(eqOf(source)
                  ? {
                      eqLowDb: source.eqLowDb,
                      eqMidDb: source.eqMidDb,
                      eqHighDb: source.eqHighDb,
                    }
                  : {}),
                ...(compressorOf(source) ? { compressor: source.compressor } : {}),
                ...(noiseReductionOf(source) !== null
                  ? { noiseReduction: source.noiseReduction }
                  : {}),
              }
            : {
                ...target,
                opacity: source.opacity,
                x: source.x,
                y: source.y,
                rotation: source.rotation,
                scaleX: source.scaleX,
                scaleY: source.scaleY,
                ...(source.blendMode !== undefined || target.blendMode !== undefined
                  ? { blendMode: source.blendMode }
                  : {}),
                // Shape styling travels shape-to-shape like the grade rule
                // below: wholesale when the source draws one, left alone
                // otherwise. Each key is explicit so an absent style clears
                // the target's, and sanitizers clone nothing shared.
                ...(source.type === 'shape'
                  ? {
                      shapeKind: sanitizeShapeKind(source.shapeKind),
                      shapeStrokeColor: sanitizeShapeStrokeColor(source.shapeStrokeColor),
                      shapeStrokeWidth: sanitizeShapeStrokeWidth(source.shapeStrokeWidth),
                      shapeFillColor: sanitizeShapeFillColor(source.shapeFillColor),
                    }
                  : {}),
                // Color grading (R4): transfer non-default fields only.
                ...(colorGradeOf(source) || effectsOf(source)
                  ? {
                      brightness: source.brightness,
                      contrast: source.contrast,
                      saturation: source.saturation,
                      hueRotation: source.hueRotation,
                      exposure: source.exposure,
                      temperature: source.temperature,
                      tint: source.tint,
                      vibrance: source.vibrance,
                      highlights: source.highlights,
                      shadows: source.shadows,
                      blacks: source.blacks,
                      whites: source.whites,
                      invertColors: source.invertColors,
                      // Curves travel with the grade wholesale: sanitize
                      // clones the points so the two clips never share a
                      // mutable array, and an ungraded source clears the
                      // target's curve like it clears the scalars.
                      curves: sanitizeGradeCurve(source.curves),
                      // Wheels travel the same way: sanitize clones the zones
                      // so the two clips never share a mutable object, and a
                      // graded source without wheels clears the target's.
                      wheels: sanitizeGradeWheels(source.wheels),
                      // Hue curves travel the same way: sanitize clones the
                      // points so the two clips never share a mutable array,
                      // and a graded source without hue curves clears them.
                      hueCurves: sanitizeHueCurves(source.hueCurves),
                      // The LUT reference travels the same way: sanitize
                      // clones the ref so the two clips never share a
                      // mutable object, and a graded source without a LUT
                      // clears the target's.
                      lut: sanitizeLutRef(source.lut),
                      // Effect stages travel wholesale with the same rule: a
                      // source carrying grade or effects replaces the
                      // target's stages, clearing the ones it lacks. Each
                      // key is explicit (not a spread) so an absent stage
                      // overwrites the target's with undefined, and each
                      // sanitizer clones, so clips never share objects.
                      blurRadius: sanitizeBlurRadius(source.blurRadius),
                      vignette: sanitizeVignette(source.vignette),
                      grain: sanitizeGrain(source.grain),
                      glow: sanitizeGlow(source.glow),
                    }
                  : {}),
              };
      }
      replacements.set(id, next);
    }

    // Value comparison on the transferred fields only — a rebuilt-but-
    // identical clip must count as unchanged (upstream compares Equatable).
    const settingsDiffer = (a: Clip, b: Clip): boolean => {
      if (a.type === 'audio') {
        return (
          a.volume !== b.volume
          || (a.pan ?? 0) !== (b.pan ?? 0)
          || (a.eqLowDb ?? 0) !== (b.eqLowDb ?? 0)
          || (a.eqMidDb ?? 0) !== (b.eqMidDb ?? 0)
          || (a.eqHighDb ?? 0) !== (b.eqHighDb ?? 0)
          || !compressorEquals(a.compressor, b.compressor)
          || noiseReductionOf(a) !== noiseReductionOf(b)
        );
      }
      return (
        a.opacity !== b.opacity
        || a.x !== b.x
        || a.y !== b.y
        || a.rotation !== b.rotation
        || a.scaleX !== b.scaleX
        || a.scaleY !== b.scaleY
        || (a.blendMode ?? null) !== (b.blendMode ?? null)
        || (a.shapeKind ?? null) !== (b.shapeKind ?? null)
        || (a.shapeStrokeColor ?? null) !== (b.shapeStrokeColor ?? null)
        || (a.shapeStrokeWidth ?? null) !== (b.shapeStrokeWidth ?? null)
        || (a.shapeFillColor ?? null) !== (b.shapeFillColor ?? null)
        || (a.brightness ?? null) !== (b.brightness ?? null)
        || (a.contrast ?? null) !== (b.contrast ?? null)
        || (a.saturation ?? null) !== (b.saturation ?? null)
        || (a.hueRotation ?? null) !== (b.hueRotation ?? null)
        || (a.exposure ?? null) !== (b.exposure ?? null)
        || (a.temperature ?? null) !== (b.temperature ?? null)
        || (a.tint ?? null) !== (b.tint ?? null)
        || (a.vibrance ?? null) !== (b.vibrance ?? null)
        || (a.highlights ?? null) !== (b.highlights ?? null)
        || (a.shadows ?? null) !== (b.shadows ?? null)
        || (a.blacks ?? null) !== (b.blacks ?? null)
        || (a.whites ?? null) !== (b.whites ?? null)
        || (a.invertColors ?? null) !== (b.invertColors ?? null)
        || !gradeCurvesEqual(a.curves, b.curves)
        || !gradeWheelsEqual(a.wheels, b.wheels)
        || !hueCurvesEqual(a.hueCurves, b.hueCurves)
        || !lutRefsEqual(a.lut, b.lut)
        || !clipEffectsEqual(
          { blurRadius: a.blurRadius, vignette: a.vignette, grain: a.grain, glow: a.glow },
          { blurRadius: b.blurRadius, vignette: b.vignette, grain: b.grain, glow: b.glow },
        )
      );
    };

    const changedClipIds = targets.filter((id) => {
      const current = this.findClipById(id)!;
      const replacement = replacements.get(id)!;
      if (id === sourceClipId) return false;
      return settingsDiffer(current, replacement);
    });
    if (changedClipIds.length === 0) {
      return { changedClipIds: [], unchangedClipIds: [...targets] };
    }

    const changedSet = new Set(changedClipIds);
    const clips = this.scopedTimeline().clips.map((clip) =>
      changedSet.has(clip.id) ? replacements.get(clip.id)! : clip,
    );
    this.execute(new ReplaceClipsCommand(clips, actionName, this.getActiveTimelineId()));
    return {
      changedClipIds,
      unchangedClipIds: targets.filter((id) => !changedSet.has(id)),
    };
  }

  private settingsSnapshot: {
    sourceId: string;
    kind: ClipType;
    values: Partial<Clip>;
  } | null = null;

  getSettingsSnapshot(): { sourceId: string; kind: ClipType } | null {
    return this.settingsSnapshot
      ? { sourceId: this.settingsSnapshot.sourceId, kind: this.settingsSnapshot.kind }
      : null;
  }

  /** Capture a clip's presentation fields as the paste-attributes source. */
  copySettingsSnapshot(sourceId: string): boolean {
    const clip = this.findClipById(sourceId);
    if (!clip) return false;
    const values: Partial<Clip> =
      clip.type === 'audio'
        ? { volume: clip.volume }
        : {
            opacity: clip.opacity,
            x: clip.x,
            y: clip.y,
            rotation: clip.rotation,
            scaleX: clip.scaleX,
            scaleY: clip.scaleY,
            ...(clip.blendMode !== undefined ? { blendMode: clip.blendMode } : {}),
          };
    this.settingsSnapshot = { sourceId, kind: clip.type, values };
    return true;
  }

  /**
   * Paste previously captured settings onto targets. Without `fields` every
   * captured field applies; with it, only the named groups do — the
   * property checklist from R1. One undoable step, upstream refusal shape.
   */
  pasteSettingsFromSnapshot(
    targetIds: Iterable<string>,
    fields?: Array<'transform' | 'opacity' | 'blendMode' | 'volume'>,
    actionName = 'Paste clip settings',
  ): { changedClipIds: string[]; unchangedClipIds: string[] } {
    const snap = this.settingsSnapshot;
    if (!snap) throw new Error("Copy a clip's settings first.");
    const want = (field: 'transform' | 'opacity' | 'blendMode' | 'volume'): boolean =>
      fields === undefined || fields.includes(field);

    const seen = new Set<string>();
    const targets = [...targetIds].filter((id) => !seen.has(id) && seen.add(id));
    if (targets.length === 0) throw new Error('Provide at least one target clip.');

    const replacements = new Map<string, Clip>();
    for (const id of targets) {
      const target = this.findClipById(id);
      if (!target) throw new Error(`Clip not found: ${id}`);
      if (target.type !== snap.kind) {
        throw new Error(
          `Clip ${id} is ${target.type}; copied settings require ${snap.kind} clips.`,
        );
      }
      let next = target;
      if (id !== snap.sourceId) {
        next = { ...target };
        const v = snap.values;
        if (want('transform')) {
          if (v.x !== undefined) next.x = v.x;
          if (v.y !== undefined) next.y = v.y;
          if (v.rotation !== undefined) next.rotation = v.rotation;
          if (v.scaleX !== undefined) next.scaleX = v.scaleX;
          if (v.scaleY !== undefined) next.scaleY = v.scaleY;
        }
        if (want('opacity') && v.opacity !== undefined) next.opacity = v.opacity;
        if (
          want('blendMode') && snap.kind !== 'audio'
          && (v.blendMode !== undefined || next.blendMode !== undefined)
        ) {
          if (v.blendMode === undefined) delete next.blendMode;
          else next.blendMode = v.blendMode;
        }
        if (want('volume') && snap.kind === 'audio' && v.volume !== undefined) {
          next.volume = v.volume;
        }
      }
      replacements.set(id, next);
    }

    const settingsDiffer = (a: Clip, b: Clip): boolean =>
      JSON.stringify(pickSettings(a, snap.kind, fields)) !== JSON.stringify(pickSettings(b, snap.kind, fields));

    const changedClipIds = targets.filter((id) => {
      const current = this.findClipById(id)!;
      const replacement = replacements.get(id)!;
      if (id === snap.sourceId) return false;
      return settingsDiffer(current, replacement);
    });
    if (changedClipIds.length === 0) {
      return { changedClipIds: [], unchangedClipIds: [...targets] };
    }

    const changedSet = new Set(changedClipIds);
    const clips = this.scopedTimeline().clips.map((clip) =>
      changedSet.has(clip.id) ? replacements.get(clip.id)! : clip,
    );
    this.execute(new ReplaceClipsCommand(clips, actionName, this.getActiveTimelineId()));
    return {
      changedClipIds,
      unchangedClipIds: targets.filter((id) => !changedSet.has(id)),
    };
  }

  // ─── Offline media relink (upstream EditorViewModel+Relink) ──────────────

  /**
   * Repoint assets at relocated source files in one undoable step per asset.
   * Upstream validates that the replacement file is the same media kind as
   * the asset it heals; so does this, with kind derived from the new path's
   * extension. Unknown ids are refused by name, and a bad entry leaves every
   * earlier relink in the call untouched-but-committed (each is its own undo).
   */
  relinkAsset(assetId: string, newPath: string): boolean {
    const asset = this.project.media.find((a) => a.id === assetId);
    if (!asset) throw new Error(`No media asset "${assetId}" in this project.`);
    const kind = fileKindOf(newPath);
    if (kind === null || kind !== asset.type) {
      throw new Error(
        `"${newPath}" is ${kind ?? 'an unsupported file type'}; "${asset.filename}" requires ${asset.type} media.`,
      );
    }
    const relinked: MediaAsset = { ...asset, path: newPath };
    this.execute(new ReplaceMediaCommand(relinked, `Relink "${asset.filename}"`));
    return true;
  }

  /**
   * Batch relink in ONE undoable step — the folder-scan flow hands back a
   * mapping built by the main process. Kind validation runs for every entry
   * before anything is committed; any refusal leaves all paths untouched.
   */
  relinkAssetsBatch(mapping: Record<string, string>): { relinkedAssetIds: string[] } {
    const ids = Object.keys(mapping);
    if (ids.length === 0) return { relinkedAssetIds: [] };
    for (const id of ids) {
      const asset = this.project.media.find((a) => a.id === id);
      if (!asset) throw new Error(`No media asset "${id}" in this project.`);
      const kind = fileKindOf(mapping[id]);
      if (kind === null || kind !== asset.type) {
        throw new Error(
          `"${mapping[id]}" is ${kind ?? 'an unsupported file type'}; "${asset.filename}" requires ${asset.type} media.`,
        );
      }
    }

    const idSet = new Set(ids);
    const nextMedia = this.project.media.map((asset) =>
      idSet.has(asset.id) ? { ...asset, path: mapping[asset.id] } : asset,
    );
    this.execute(
      new ReplaceProjectCommand(
        { ...this.project, media: nextMedia },
        ids.length === 1 ? 'Relink media' : `Relink ${ids.length} media`,
      ),
    );
    return { relinkedAssetIds: ids };
  }

  /** True when the clip's link group has another member (detach candidate). */
  canDetachAudio(clipId: string): boolean {
    const clip = this.findClipById(clipId);
    return clip?.linkGroupId !== undefined;
  }

  /**
   * Set stereo balance on an audio clip (roadmap R5). -1 hard left,
   * +1 hard right, 0 center. Visual clips are refused.
   */
  setClipPan(clipId: string, pan: number): boolean {
    if (!Number.isFinite(pan) || pan < -1 || pan > 1) return false;
    const receipt = this.applyClipProperties([clipId], `Set pan to ${pan.toFixed(2)}`, (draft) => {
      if (draft.type !== 'audio') return false;
      if (pan === 0) delete draft.pan;
      else draft.pan = pan;
      return true;
    });
    return receipt.changedClipIds.length > 0;
  }

  /**
   * Attach or clear a proxy file for an asset (roadmap R2). Undoable like
   * every media-field change; generation itself runs outside the editor.
   */
  setProxyState(assetId: string, proxyPath: string | null): boolean {
    const asset = this.project.media.find((a) => a.id === assetId);
    if (!asset) return false;
    const next: MediaAsset =
      proxyPath === null
        ? (() => {
            const copy = { ...asset };
            delete copy.proxyPath;
            return copy;
          })()
        : { ...asset, proxyPath };
    this.execute(new ReplaceMediaCommand(next, proxyPath ? 'Attach proxy' : 'Remove proxy'));
    return true;
  }

  /**
   * Set or clear an asset's AI description (#118 AI half). Sanitized on
   * write; null/blank clears the field. Undoable like every other
   * media-field change (ReplaceMediaCommand), so one Describe is one undo
   * step and the agent write below rides the same path as the UI button.
   */
  setAssetDescription(assetId: string, raw: string | null | undefined): boolean {
    const asset = this.project.media.find((a) => a.id === assetId);
    if (!asset) return false;
    const cleaned = sanitizeAiDescription(raw ?? '');
    const next: MediaAsset = { ...asset };
    if (cleaned === null) delete next.aiDescription;
    else next.aiDescription = cleaned;
    this.execute(new ReplaceMediaCommand(next, 'Describe media'));
    return true;
  }

  // ─── Title clips (R3 foundation) ──────────────────────────────────────────

  /**
   * Add a title clip — a self-contained text layer needing no media asset.
   * Invalid/empty text is refused by returning ''. One undoable step.
   */
  addTitleClip(params: {
    trackId: string;
    startFrame?: Frame;
    durationFrames?: Frame;
    text: string;
  }): string | '' {
    const text = sanitizeTitleText(params.text);
    if (!text) return '';
    const track = this.scopedTimeline().tracks.find((t) => t.id === params.trackId);
    if (!track || track.type !== 'video' || track.locked) return '';

    const start = clampFrame(params.startFrame ?? this.getPlayhead());
    const durationFrames = clampFrame(params.durationFrames ?? Math.round(this.project.settings.fps * 3), 1);
    const clip: Clip = {
      ...this.createPlacedClip(
        {
          id: '__title__', path: '', filename: text, type: 'video',
          duration: durationFrames, fileSize: 0, addedAt: new Date().toISOString(),
        },
        'title',
        params.trackId,
        start,
        durationFrames,
      ),
      label: text,
      text,
      titleSizeRatio: DEFAULT_TITLE_STYLE.sizeRatio,
      titleColor: DEFAULT_TITLE_STYLE.colorHex,
    };
    this.execute(new ReplaceClipsCommand(
      [...this.scopedTimeline().clips, clip],
      'Add title',
      this.getActiveTimelineId(),
    ));
    return clip.id;
  }

  /** Update a title clip's text. Returns false when refused (invalid text). */
  setTitleText(clipId: string, rawText: string): boolean {
    const text = sanitizeTitleText(rawText);
    if (!text) return false;
    const receipt = this.applyClipProperties([clipId], 'Edit title text', (draft) => {
      if (draft.type !== 'title') return false;
      draft.text = text;
      draft.label = text.slice(0, 60);
      return true;
    });
    return receipt.changedClipIds.length > 0;
  }

  // ─── Shape clips (tutorial-overlay annotations) ───────────────────────────

  /**
   * Add a shape clip — a self-contained vector layer needing no media asset.
   * Geometry defaults to a centered half-canvas box; style defaults to a
   * white outline. Refused (returns '') on a missing/non-video/locked track
   * or an unusable duration. One undoable step.
   */
  addShapeClip(params: {
    trackId: string;
    startFrame?: Frame;
    durationFrames?: Frame;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    shapeKind?: unknown;
    strokeColor?: unknown;
    strokeWidth?: unknown;
    fillColor?: unknown;
    preset?: unknown;
  }): string | '' {
    const added = this.addShapeClips([params]);
    return added.added.length > 0 ? added.added[0]!.clipId : '';
  }

  /**
   * Add several shape clips as ONE undoable step, so one agent `add_shapes`
   * call is one undo entry even with per-entry presets. Entries that fail
   * validation are reported and skipped; a batch with zero usable entries
   * adds no history entry.
   */
  addShapeClips(
    entries: Array<{
      trackId: string;
      startFrame?: Frame;
      durationFrames?: Frame;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      shapeKind?: unknown;
      strokeColor?: unknown;
      strokeWidth?: unknown;
      fillColor?: unknown;
      preset?: unknown;
    }>,
  ): { added: Array<{ clipId: string; kind: string }>; errors: string[] } {
    const settings = this.project.settings;
    const added: Array<{ clipId: string; kind: string }> = [];
    const errors: string[] = [];
    const created: Clip[] = [];

    entries.forEach((entry, index) => {
      const track = this.scopedTimeline().tracks.find((t) => t.id === entry.trackId);
      if (!track || track.type !== 'video' || track.locked) {
        errors.push(`entries[${index}]: could not place shape on track "${entry.trackId}".`);
        return;
      }
      const durationFrames = clampFrame(
        entry.durationFrames ?? Math.round(settings.fps * 3), 1,
      );
      if (durationFrames < 1) {
        errors.push(`entries[${index}]: duration is unusable.`);
        return;
      }
      const start = clampFrame(entry.startFrame ?? this.getPlayhead());
      const boxWidth = entry.width !== undefined && Number.isFinite(entry.width)
        ? Math.max(1, Math.round(entry.width))
        : Math.max(1, Math.round(settings.width / 2));
      const boxHeight = entry.height !== undefined && Number.isFinite(entry.height)
        ? Math.max(1, Math.round(entry.height))
        : Math.max(1, Math.round(settings.height / 2));
      const boxX = entry.x !== undefined && Number.isFinite(entry.x)
        ? Math.round(entry.x)
        : Math.round((settings.width - boxWidth) / 2);
      const boxY = entry.y !== undefined && Number.isFinite(entry.y)
        ? Math.round(entry.y)
        : Math.round((settings.height - boxHeight) / 2);

      const kind = sanitizeShapeKind(entry.shapeKind) ?? DEFAULT_SHAPE_STYLE.kind;
      const strokeColor = sanitizeShapeStrokeColor(entry.strokeColor)
        ?? DEFAULT_SHAPE_STYLE.strokeColor;
      const strokeWidth = sanitizeShapeStrokeWidth(entry.strokeWidth)
        ?? DEFAULT_SHAPE_STYLE.strokeWidth;
      const fillColor = sanitizeShapeFillColor(entry.fillColor);

      const clip: Clip = {
        ...this.createPlacedClip(
          {
            id: SHAPE_ASSET_ID, path: '', filename: kind, type: 'video',
            duration: durationFrames, fileSize: 0, addedAt: new Date().toISOString(),
          },
          'shape',
          entry.trackId,
          start,
          durationFrames,
        ),
        label: kind.charAt(0).toUpperCase() + kind.slice(1),
        x: boxX,
        y: boxY,
        width: boxWidth,
        height: boxHeight,
        shapeKind: kind,
        shapeStrokeColor: strokeColor,
        shapeStrokeWidth: strokeWidth,
        ...(fillColor !== undefined ? { shapeFillColor: fillColor } : {}),
      };

      const preset = typeof entry.preset === 'string'
        && (SHAPE_ANIMATION_PRESETS as readonly string[]).includes(entry.preset)
        ? (entry.preset as ShapeAnimationPreset)
        : undefined;
      if (preset) {
        const motion = shapePresetMotion(preset, {
          startFrame: start,
          durationFrames,
          fps: settings.fps,
          x: boxX,
          y: boxY,
          width: boxWidth,
          height: boxHeight,
        });
        if (motion.motionX) clip.motionX = motion.motionX;
        if (motion.motionY) clip.motionY = motion.motionY;
        if (motion.motionRot) clip.motionRot = motion.motionRot;
        if (motion.motionScaleX) clip.motionScaleX = motion.motionScaleX;
        if (motion.motionScaleY) clip.motionScaleY = motion.motionScaleY;
      }

      created.push(clip);
      added.push({ clipId: clip.id, kind });
    });

    if (created.length === 0) return { added, errors };
    this.execute(new ReplaceClipsCommand(
      [...this.scopedTimeline().clips, ...created],
      created.length === 1 ? 'Add shape' : `Add ${created.length} shapes`,
      this.getActiveTimelineId(),
    ));
    return { added, errors };
  }

  /**
   * Set constant playback speed on a visual clip (roadmap R4 groundwork).
   *
   * Timeline duration is unchanged -- the clip consumes speed× more source,
   * expressed by scaling outPoint from inPoint so every consumer that trusts
   * the trim window (export, waveforms, relink checks) follows automatically.
   * A visual clip's linked audio partners receive the same speed and trim
   * window, keeping an embedded A/V pair synchronized. Audio-only targets and
   * locked or otherwise ineligible groups are refused without partial edits.
   *
   * A COMPOUND is ineligible, exactly as it already is for
   * `setClipOpacityTrack`, and the refusal is loud rather than a bare `false`.
   * A compound's `inPoint`/`outPoint` ARE its window into the nested
   * timeline, and compound validation requires
   * `durationFrames === outPoint - inPoint` (`planFlatten`, `expandTimeline`).
   * The scaling below breaks that by construction, so accepting a compound
   * wrote a clip that drops out of `resolveRenderTimeline` and refuses to
   * flatten: a nested sequence silently disappears from preview and export
   * while the caller is told the edit succeeded. Speed belongs on the clips
   * INSIDE the nest, which stay legal -- a sped-up child is mapped through
   * the shared source-time model by `expandTimeline`.
   */
  setClipSpeed(clipId: string, speed: number): boolean {
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) return false;
    const anchor = this.findClipById(clipId);
    if (!anchor || anchor.type === 'audio' || anchor.type === 'title') return false;
    if (anchor.type === 'compound') {
      // Thrown, not returned: both callers drop a `false` on the floor (the
      // timeline context menu ignores the return, and the agent boundary
      // reports a boolean refusal with a generic reason), so a returned
      // refusal is the silent one this guard exists to end. The compound-area
      // convention is a precise Error, which the agent tool receipt carries
      // verbatim as its `error`.
      throw new Error(
        `Compound clip "${clipId}" cannot be sped up. Set the speed on its clips inside the nest instead.`,
      );
    }

    const linkedIds = new Set(this.expandLinkedClipIds([clipId]));
    const targets = this.scopedTimeline().clips.filter((clip) => linkedIds.has(clip.id));
    if (targets.length === 0 || !this.canEditClipIds(linkedIds)) return false;
    // Do not let the mutator below leave a linked group half-updated. Titles
    // have no source window to speed, so a group containing one is ineligible.
    if (targets.some((clip) => clip.type === 'title')) return false;
    // Same all-or-nothing rule for a compound member: `linkClips` links any
    // two clips of different media types and 'compound' is one, so a linked
    // group CAN hold a nest, and speeding the group would break that member's
    // nested window while its partner looked fine. The whole group is
    // ineligible, like the title case above.
    const nestedMember = targets.find((clip) => clip.type === 'compound');
    if (nestedMember) {
      throw new Error(
        `Linked group of "${clipId}" contains compound clip "${nestedMember.id}", which cannot be sped up. Set the speed inside the nest instead.`,
      );
    }

    const receipt = this.applyClipProperties(
      linkedIds,
      `Set speed to ${speed}x`,
      (draft) => {
        // Audio is ineligible as a direct target, but is the linked partner
        // that must follow a visual clip's speed change.
        draft.speed = speed;
        draft.outPoint = draft.inPoint + Math.round(draft.durationFrames * speed);
        return true;
      },
    );
    return receipt.changedClipIds.length > 0;
  }

  /**
   * Set or clear one visual clip's opacity automation track. An empty array
   * clears it; invalid/short tracks are refused. Valid values are narrowed
   * through the shared motion sanitizer and the edit is one undo step.
   */
  setClipOpacityTrack(clipId: string, points: unknown): boolean {
    const clip = this.findClipById(clipId);
    if (!clip || clip.type === 'audio' || clip.type === 'compound') return false;
    const clear = Array.isArray(points) && points.length === 0;
    const track = clear ? undefined : sanitizeOpacityTrack(points);
    if (!clear && !track) return false;
    if (clear ? clip.opacityTrack === undefined : sameOpacityTrack(clip.opacityTrack, track)) return false;

    const receipt = this.applyClipProperties(
      [clipId],
      clear ? 'Clear opacity track' : 'Set opacity track',
      (draft) => {
        if (track) draft.opacityTrack = track;
        else delete draft.opacityTrack;
        return true;
      },
    );
    return receipt.changedClipIds.length > 0;
  }

  /**
   * Import SRT content as title clips on a video track (roadmap R3).
   *
   * Each cue becomes one clip spanning [start, end) relative to
   * the playhead by default. The whole import is ONE
   * undoable step; cues that fail sanitization are skipped, and an import
   * with zero usable cues adds no history entry and returns [].
   *
   * Placement goes through the shared caption contract (`placeCaptionCue`),
   * the same one the transcriber path uses, so both surfaces anchor, clamp,
   * and sanitize identically.
   */
  importSrt(trackId: string, srtContent: string, startFrame?: Frame): string[] {
    return this.importSubtitleContent(trackId, parseSrt(srtContent), startFrame);
  }

  /** Import WebVTT subtitle content as title clips (roadmap R3). */
  importVtt(trackId: string, vttContent: string, startFrame?: Frame): string[] {
    return this.importSubtitleContent(trackId, parseVtt(vttContent), startFrame);
  }

  private importSubtitleContent(
    trackId: string,
    cues: Array<{ startSec: number; endSec: number; text: string }>,
    startFrame?: Frame,
  ): string[] {
    const track = this.scopedTimeline().tracks.find((t) => t.id === trackId);
    if (!track || track.type !== 'video' || track.locked) return [];

    const base = Math.max(0, Math.round(startFrame ?? this.getPlayhead()));
    const fps = this.project.settings.fps;
    const newIds: string[] = [];
    const created: Clip[] = [];

    for (const cue of cues) {
      const text = sanitizeTitleText(cue.text);
      if (!text) continue;
      const { startFrame: start, durationFrames: duration } = placeCaptionCue(base, cue, fps);
      const id = nanoid();
      newIds.push(id);
      created.push({
        ...this.createPlacedClip(
          {
            id: '__title__', path: '', filename: text, type: 'video',
            duration: duration, fileSize: 0, addedAt: new Date().toISOString(),
          },
          'title', trackId, start, duration,
        ),
        id,
        label: text,
        text,
        titleSizeRatio: 0.06,
        titleColor: '#ffffff',
      });
    }
    if (created.length === 0) return [];

    this.execute(new ReplaceClipsCommand(
      [...this.scopedTimeline().clips, ...created],
      created.length === 1 ? 'Import subtitle' : `Import ${created.length} subtitles`,
      this.getActiveTimelineId(),
    ));
    return newIds;
  }

  /**
   * Apply short equal-length audio fades at every hard boundary between
   * adjacent audio clips on the given track, preventing clicks at edit
   * points. One undoable step. Returns count of boundaries crossfaded.
   */
  autoCrossfadeAudio(trackId: string, fadeFrames?: Frame): number {
    const track = this.scopedTimeline().tracks.find((t) => t.id === trackId);
    if (!track || track.type !== 'audio') return -1;

    const clips = this.scopedTimeline().clips
      .filter((c) => c.trackId === trackId && !c.muted)
      .sort((a, b) => a.startFrame - b.startFrame);
    if (clips.length < 2) return -1;

    const fade = Math.min(fadeFrames ?? Math.round(this.project.settings.fps * 0.05), Math.round(this.project.settings.fps * 0.25));
    const nextClips = clips.map((c) => ({ ...c }));
    let changedCount = 0;

    for (let i = 0; i < nextClips.length; i += 1) {
      if (!nextClips[i].fadeOutFrames || nextClips[i].fadeOutFrames === 0) {
        nextClips[i].fadeOutFrames = fade;
        changedCount += 1;
      }
      if (i + 1 < nextClips.length && (!nextClips[i + 1].fadeInFrames || nextClips[i + 1].fadeInFrames === 0)) {
        nextClips[i + 1].fadeInFrames = fade;
        changedCount += 1;
      }
    }
    if (changedCount === 0) return 0;

    const clipMap = new Map(nextClips.map((c) => [c.id, c]));
    const merged = this.scopedTimeline().clips.map((c) => clipMap.get(c.id) ?? c);
    this.execute(new ReplaceClipsCommand(merged, 'Auto-crossfade audio', this.getActiveTimelineId()));
    return changedCount;
  }

  getMarkers(): TimelineMarker[] {
    return (this.scopedTimeline().markers ?? []).map((marker) => ({
      ...marker,
      status: marker.status ?? MARKER_DEFAULT_STATUS,
    }));
  }

  /**
   * Whether ripple edits carry markers along (upstream #560,
   * `rippleTimelineMarkers`, default on). Off means program-time pins: clips
   * move, markers stay.
   */
  isRippleTimelineMarkers(): boolean {
    return this.rippleTimelineMarkers;
  }

  /** Flip the marker-ripple preference. Not a document edit: no undo entry. */
  setRippleTimelineMarkers(enabled: boolean): void {
    this.rippleTimelineMarkers = enabled;
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
      status: normalizeMarkerStatus(input.status),
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
        ...(patch.status !== undefined ? { status: normalizeMarkerStatus(patch.status) } : {}),
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
        && marker.comment === current[index].comment
        && (marker.status ?? MARKER_DEFAULT_STATUS) === (current[index].status ?? MARKER_DEFAULT_STATUS),
      )
    ) {
      return null;
    }

    this.execute(new ReplaceMarkersCommand(next, actionName, this.getActiveTimelineId()));
    return { created, updated, deletedIds: [...deleteIds] };
  }

  /** Remap markers through a ripple delete; `null` when none would move. */
  private rippleMarkersClosing(
    trackHoles: readonly (readonly RippleRange[])[],
  ): TimelineMarker[] | null {
    if (!this.rippleTimelineMarkers) return null;
    if (this.getMarkers().length === 0 || trackHoles.length === 0) return null;
    return mapMarkersThroughClosingHoles(this.getMarkers(), trackHoles);
  }

  //  Manual clip linking (upstream PR #462) 

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
    const clips = this.scopedTimeline().clips.map((clip) =>
      targetIds.has(clip.id) ? { ...clip, linkGroupId: groupId } : clip,
    );
    this.execute(new ReplaceClipsCommand(clips, 'Link clips', this.getActiveTimelineId()));
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
    const clips = this.scopedTimeline().clips.map((clip) => {
      if (!targetIds.has(clip.id)) return clip;
      const next = { ...clip };
      delete next.linkGroupId;
      return next;
    });
    this.execute(new ReplaceClipsCommand(clips, 'Unlink clips', this.getActiveTimelineId()));
    return { unlinkedClipIds: [...targetIds] };
  }

  // ─── Compound clips / nested sequences (upstream issue #155, slice 1) ─────

  /**
   * Group clips into a nested sequence (upstream issue #155).
   *
   * The selection (plus auto-included linked partners, like every other
   * multi-clip op) moves verbatim into a new sub-timeline, replaced in the
   * holding scope by one compound clip — as a single undoable step. Throws a
   * precise error before mutating anything when the selection is empty,
   * unknown, on a locked track, or would nest past the depth cap.
   * `options.scopeTimelineId` overrides the ambient open scope (agent/MCP
   * path); omitted means the ambient scope (root unless a nest is open).
   */
  nestClips(
    clipIds: Iterable<string>,
    options: { name?: string; scopeTimelineId?: string | null } = {},
  ): NestReceipt {
    const scope = options.scopeTimelineId ?? this.getActiveTimelineId();
    const { project, receipt } = planNest(this.project, clipIds, { ...options, scopeTimelineId: scope });
    this.execute(
      new ReplaceProjectCommand(project, `Nest ${receipt.nestedClipIds.length} clips`),
    );
    return receipt;
  }

  /**
   * Restore one compound clip's nested content to its holding scope timeline
   * (one level, one undoable step). Throws a precise error before mutating
   * when the id is unknown, is not a compound clip, lost its timeline, or
   * sits on a locked track. Same scope-override contract as nestClips.
   */
  flattenCompound(compoundClipId: string, options: { scopeTimelineId?: string | null } = {}): FlattenReceipt {
    const scope = options.scopeTimelineId ?? this.getActiveTimelineId();
    const { project, receipt } = planFlatten(this.project, compoundClipId, { scopeTimelineId: scope });
    this.execute(new ReplaceProjectCommand(project, 'Flatten compound clip'));
    return receipt;
  }

  //  Clip media source swapping (upstream PR #500) 

  /**
   * Replace a clip's source media while keeping its edit state  timeline
   * position, duration, framing, fades  intact.
   *
   * Every linked partner sharing the anchor's source swaps with it, as one
   * undoable step. The replacement must be compatible: same media kind as
   * every target, long enough to cover each target's trimmed source window,
   * and  for video without an audio stream  never backing an audio clip.
   * A longer replacement simply leaves trim headroom: the user can extend
   * the clip into the surplus later, because `outPoint` remains free up to
   * the new asset's duration (the Windows rendering of upstream's
   * trim-end-headroom bookkeeping).
   */
  /**
   * Dry-run validation for `swapClipMedia` (upstream PR #500's arming
   * preview): the UI uses this to show which library assets are eligible
   * replacements before one is picked. Same rules, same wordings, no edit.
   */
  canSwapClipMedia(
    clipId: string,
    replacementAssetId: string,
  ): { ok: true } | { ok: false; reason: string } {
    const anchor = this.findClipById(clipId);
    if (!anchor) return { ok: false, reason: `Clip not found: ${clipId}` };
    const replacement = this.project.media.find((asset) => asset.id === replacementAssetId);
    if (!replacement) return { ok: false, reason: `No media asset "${replacementAssetId}" in this project.` };

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
      if (target.type === 'title' || target.type === 'generated' || target.type === 'shape') {
        return { ok: false, reason: 'This clip\'s source cannot be swapped.' };
      }
      // Checked before the generic kind mismatch so the common real case
      // swapping a picture-plus-linked-audio pair to a silent video  gets
      // the precise reason instead of "video vs audio".
      if (
        target.type === 'audio'
        && replacement.type === 'video'
        && !replacement.audioCodec
      ) {
        return { ok: false, reason: 'The replacement video has no audio stream to back this clip\'s audio.' };
      }
      if (sourceKindOf(target) !== replacement.type) {
        return {
          ok: false,
          reason: `Replacement is ${replacement.type} media; this clip's source is ${sourceKindOf(target)}.`,
        };
      }
      if (replacement.type !== 'image' && replacement.duration < target.outPoint - target.inPoint) {
        return {
          ok: false,
          reason: 'The replacement media is too short for this clip\'s edit. Trim it shorter first or pick longer media.',
        };
      }
    }
    if (!this.canEditClipIds(targets.map((clip) => clip.id))) {
      return { ok: false, reason: 'One or more clips are on a locked track.' };
    }
    return { ok: true };
  }

  swapClipMedia(clipId: string, replacementAssetId: string): {
    changedClipIds: string[];
    oldAssetId: string;
    newAssetId: string;
  } {
    const verdict = this.canSwapClipMedia(clipId, replacementAssetId);
    if (!verdict.ok) throw new Error(verdict.reason);

    const anchor = this.findClipById(clipId)!;
    const targets = this.expandLinkedClipIds([clipId])
      .map((id) => this.findClipById(id))
      .filter((clip): clip is Clip => clip !== undefined)
      .filter((clip) => clip.assetId === anchor.assetId);

    const targetIds = new Set(targets.map((clip) => clip.id));
    const clips = this.scopedTimeline().clips.map((clip) =>
      targetIds.has(clip.id) ? { ...clip, assetId: replacementAssetId } : clip,
    );
    this.execute(new ReplaceClipsCommand(clips, 'Replace clip source', this.getActiveTimelineId()));
    return {
      changedClipIds: [...targetIds],
      oldAssetId: anchor.assetId,
      newAssetId: replacementAssetId,
    };
  }

  private rippleMarkersOpening(frame: Frame, push: Frame): TimelineMarker[] | null {
    if (!this.rippleTimelineMarkers) return null;
    if (this.getMarkers().length === 0) return null;
    return mapMarkersOpeningAt(this.getMarkers(), frame, push);
  }

  /**
   * Commit a ripple transaction's clip changes together with any marker
   * remapping, so one user action stays exactly one undo step. Returns what
   * the edit did to markers so ripple receipts can report it (upstream #560).
   */
  private executeRipple(clips: Clip[], markers: TimelineMarker[] | null, label: string): MarkerRippleDelta {
    const delta = diffMarkers(this.getMarkers(), markers);
    if (markers === null) {
      this.execute(new ReplaceClipsCommand(clips, label, this.getActiveTimelineId()));
      return delta;
    }
    this.execute(new ReplaceProjectCommand(this.withScopedTimeline(
      { ...this.scopedTimeline(), clips, markers },
    ), label));
    return delta;
  }

  private updateTrack(trackId: string, patch: Partial<Track>, label: string): boolean {
    const track = this.scopedTimeline().tracks.find((candidate) => candidate.id === trackId);
    if (!track) return false;
    this.execute(
      new ReplaceTracksCommand(
        this.scopedTimeline().tracks.map((candidate) =>
          candidate.id === trackId ? { ...candidate, ...patch } : candidate,
        ),
        label,
        this.getActiveTimelineId(),
      ),
    );
    return true;
  }

  setPlayhead(frame: Frame): void {
    this.movePlayhead(frame, this.getActiveTimelineId());
  }

  /**
   * The one place a playhead moves, whichever scope asked for it.
   *
   * The playhead is the view cursor, not an edit, so it is written straight
   * onto the project instead of through a command: it never reaches the undo
   * stack and never displaces an entry from the capped history. That matters
   * most for the paths that land here once per pointer frame or per keystroke
   * — the preview scrub, the transport, frame stepping, ruler scrubbing and
   * the playback engine. As a whole-project `ReplaceProjectCommand` each of
   * those consumed an undo entry, so Ctrl+Z after a few seconds of scrubbing
   * answered "Move playhead" while real edits had been shifted out of the
   * 200-entry stack. `updatedAt` is left alone for the same reason: the cursor
   * is not something the user authored.
   *
   * It still notifies, tagged `playhead`, because the project object this
   * produces is what the window redraws from, what the renderer mirror pushes
   * to main — the compositor composites that pushed frame, and sibling windows
   * adopt it — and what the peer-adoption path compares to decide whether the
   * incoming snapshot is editorial work (see sameProjectExceptPlayhead).
   */
  private movePlayhead(frame: Frame, scopeId: TimelineScopeId): void {
    const target = timelineInScope(this.project, scopeId);
    const next = clampFrame(frame);
    // Nothing moved, so nothing to redraw, mirror, or recomposite.
    if (target.playheadFrame === next) return;
    this.project = withTimelineInScope(this.project, scopeId, {
      ...target,
      playheadFrame: next,
    });
    this.notify('playhead');
  }

  setInFrame(frame: Frame = this.scopedTimeline().playheadFrame): void {
    this.project = this.withScopedTimeline(
      { ...this.scopedTimeline(), inFrame: clampFrame(frame) },
    );
    this.notify();
  }

  setOutFrame(frame: Frame = this.scopedTimeline().playheadFrame): void {
    this.project = this.withScopedTimeline(
      { ...this.scopedTimeline(), outFrame: clampFrame(frame) },
    );
    this.notify();
  }

  /**
   * Set both marks at once, normalized so in <= out.
   *
   * Marking a clip is one user action, so it is one mutation and one
   * notification  setting the marks separately would publish an intermediate
   * state where out still belongs to the previously marked range, and every
   * consumer guards `out > in` by discarding the range.
   */
  setMarkedRange(inFrame: Frame, outFrame: Frame): void {
    const start = clampFrame(Math.min(inFrame, outFrame));
    const end = clampFrame(Math.max(inFrame, outFrame));
    this.project = this.withScopedTimeline(
      { ...this.scopedTimeline(), inFrame: start, outFrame: end },
    );
    this.notify();
  }

  clearMarkedRange(): void {
    this.project = this.withScopedTimeline({
      ...this.scopedTimeline(),
      inFrame: undefined,
      outFrame: undefined,
    });
    this.notify();
  }

  /**
   * Assemble a source clip segment over the marked range onto the comp track
   * (upstream PR #428). This is one undoable step: any existing comp clips in
   * the range are removed first, then the new segment is placed.
   *
   * @returns true on success, false when the range or selection is invalid.
   */
  compactTake(sourceClipId: string): boolean {
    const { inFrame, outFrame } = this.scopedTimeline();
    if (inFrame === undefined || outFrame === undefined || outFrame <= inFrame) return false;

    const sourceClip = this.scopedTimeline().clips.find((c) => c.id === sourceClipId);
    if (!sourceClip) return false;

    // The source must overlap the marked range.
    const sourceEnd = sourceClip.startFrame + sourceClip.durationFrames;
    const overlapStart = Math.max(inFrame, sourceClip.startFrame);
    const overlapEnd = Math.min(outFrame, sourceEnd);
    if (overlapEnd <= overlapStart) return false;

    // Find or create the comp track (top video track).
    let compTrackId = this.scopedTimeline().compTrackId;
    let tracks = [...this.scopedTimeline().tracks];
    if (!compTrackId || !tracks.some((t) => t.id === compTrackId)) {
      const compTrack: Track = {
        id: nanoid(),
        name: 'Comp',
        type: 'video',
        locked: false,
        visible: true,
        order: tracks.length,
      };
      tracks = [...tracks, compTrack];
      compTrackId = compTrack.id;
    }

    // The comp clip reuses the source's window, so the marked range maps
    // through the same source-time boundary as a fragment.
    const { inPoint, outPoint } = sourceWindowForSlice(
      sourceClip,
      overlapStart,
      overlapEnd,
    );
    const segmentDuration = overlapEnd - overlapStart;

    // Remove existing comp clips that overlap the range.
    let clips = this.scopedTimeline().clips.filter((c) => {
      if (c.trackId !== compTrackId) return true;
      const cEnd = c.startFrame + c.durationFrames;
      return cEnd <= overlapStart || c.startFrame >= overlapEnd;
    });

    // Place the new comp clip — spread from source to inherit visual defaults.
    const compClip: Clip = {
      ...sourceClip,
      id: nanoid(),
      trackId: compTrackId!,
      startFrame: overlapStart,
      durationFrames: segmentDuration,
      inPoint,
      outPoint,
      label: sourceClip.label ? 'Comp: ' + sourceClip.label : undefined,
    };
    clips = [...clips, compClip];

    this.execute(new ReplaceProjectCommand(this.withScopedTimeline({
      ...this.scopedTimeline(),
      tracks,
      clips,
      compTrackId,
    }), 'Compact take'));
    return true;
  }
  /**
   * Apply a grid layout to the given visual clip ids (upstream PR #410).
   * Each clip is scaled to fit its cell within the project canvas.
   * Clips are placed in order: first clip -> r1c1, second -> r1c2, etc.
   * Extra clips beyond the grid capacity are left unchanged.
   *
   * @returns The number of clips that received new geometry.
   */
  applyLayout(clipIds: string[], preset: GridLayoutPreset): number {
    if (clipIds.length === 0) return 0;

    const { width: canvasWidth, height: canvasHeight } = this.project.settings;
    const cells = resolveLayoutPreset(preset, canvasWidth, canvasHeight);

    let changed = 0;
    const targetClipIds: string[] = [];
    const patches: Array<{ id: string; x: number; y: number; width: number; height: number; scaleX: number; scaleY: number }> = [];

    for (let i = 0; i < clipIds.length; i++) {
      if (i >= cells.length) break;
      const clip = this.scopedTimeline().clips.find((c) => c.id === clipIds[i]);
      if (!clip) continue;
      if (clip.type === 'audio') continue;
      targetClipIds.push(clipIds[i]);
      patches.push({
        id: clipIds[i],
        x: cells[i]!.x,
        y: cells[i]!.y,
        width: cells[i]!.width,
        height: cells[i]!.height,
        scaleX: 1,
        scaleY: 1,
      });
      changed++;
    }

    if (targetClipIds.length === 0) return 0;

    this.applyClipProperties(
      targetClipIds,
      'Apply ' + preset + ' layout',
      (draft) => {
        const patch = patches.find((p) => p.id === draft.id);
        if (!patch) return false;
        draft.x = patch.x;
        draft.y = patch.y;
        draft.width = patch.width;
        draft.height = patch.height;
        draft.scaleX = patch.scaleX;
        draft.scaleY = patch.scaleY;
        return true;
      },
    );

    return changed;
  }

  importMediaAssets(assets: MediaAsset[]): string[] {
    if (assets.length === 0) return [];
    this.execute(new AddMediaAndClipsCommand(assets, [], 'Import media', [], this.getActiveTimelineId()));
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
    const track = this.scopedTimeline().tracks.find((candidate) => candidate.id === trackId);
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

    this.execute(new AddMediaAndClipsCommand(media, clips, label, tracks, this.getActiveTimelineId()));
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
    inPoint: Frame = 0,
  ): Clip {
    return {
      id: nanoid(),
      assetId: asset.id,
      type,
      trackId,
      linkGroupId,
      startFrame,
      durationFrames,
      inPoint,
      outPoint: inPoint + durationFrames,
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
    const candidates = [...this.scopedTimeline().tracks, ...plannedTracks]
      .filter((track) => track.type === 'audio' && !track.locked)
      .sort((left, right) => left.order - right.order);
    const allClips = [...this.scopedTimeline().clips, ...plannedClips];

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
        this.scopedTimeline().tracks.filter((candidate) => candidate.type === 'audio').length
        + plannedTracks.filter((candidate) => candidate.type === 'audio').length
        + 1
      }`,
      type: 'audio',
      locked: false,
      visible: true,
      syncLocked: true,
      order: this.scopedTimeline().tracks.length + plannedTracks.length,
    };
    plannedTracks.push(track);
    return track;
  }

  /**
   * Set a clip's layer blend mode. Only valid for visual clips 
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

  /** Set a clip's opacity (01). Valid for any visual clip. */
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
   * Batched clip-property edit  the one path every property mutation takes,
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
    const clips = this.scopedTimeline().clips;
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
      this.execute(new SetClipPropertiesCommand(nextClips, `${label}${suffix}`, this.getActiveTimelineId()));
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

    const clips = this.scopedTimeline().clips;
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
   * Pass `transition` as null to clear. Not undoable via a dedicated command 
   * uses a project replace so it's a single undo step.
   */
  setClipTransition(clipId: string, transition: ClipTransition | null): boolean {
    const clips = this.scopedTimeline().clips;
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
    this.execute(new ReplaceClipsCommand(next, 'Set transition', this.getActiveTimelineId()));
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
    const clips = this.scopedTimeline().clips;
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

    this.execute(new ReplaceClipsCommand(next, 'Cross dissolve', this.getActiveTimelineId()));
    return true;
  }

  /**
   * Remove silent ranges from a clip and ripple-close the gaps (#175).
   *
   * `silentRangesSec` are silent spans in SOURCE seconds (from the detector).
   * They are mapped to the clip's timeline window and sent through the shared
   * range-ripple transaction, so linked partners, sync-locked tracks, and
   * markers follow the same path as scoped Agent removal.
   *
   * Returns the number of source ranges requested (0 = nothing changed).
   */
  removeSilence(clipId: string, silentRangesSec: SilentRange[]): number {
    const clip = this.findClipById(clipId);
    if (!clip) return 0;

    // The legacy path receives source-second ranges, but the domain's safe
    // transaction is the same timeline-range ripple used by scoped removal.
    // Mapping first preserves the clip's trim window; rippleDeleteRanges then
    // expands linked partners, honours sync lock, remaps markers, and commits
    // clips + markers in one command.
    const report = this.rippleDeleteRanges(
      clip.trackId,
      timelineSilenceRanges(clip, this.project.settings.fps, silentRangesSec),
    );
    return report ? silentRangesSec.length : 0;
  }

  //  Project settings 

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

    const scale = fps / previous.fps;
    let timeline = this.project.timeline;
    if (fpsChanged) {
      timeline = rescaleTimelineFrames(timeline, scale);
    }
    if (resolutionChanged) {
      timeline = {
        ...timeline,
        clips: timeline.clips.map((clip) =>
          refitClipToCanvas(clip, previous.width, previous.height, width, height),
        ),
      };
    }
    // Nested timelines share the project timebase and canvas, so they ride
    // the same rescale/re-fit (compound in/out windows stay valid because
    // both sides scale by the same factor).
    let timelines = this.project.timelines;
    if (timelines && (fpsChanged || resolutionChanged)) {
      const next: typeof timelines = {};
      for (const [id, nested] of Object.entries(timelines)) {
        let reshaped = nested;
        if (fpsChanged) reshaped = rescaleTimelineFrames(reshaped, scale);
        if (resolutionChanged) {
          reshaped = {
            ...reshaped,
            clips: reshaped.clips.map((clip) =>
              refitClipToCanvas(clip, previous.width, previous.height, width, height),
            ),
          };
        }
        next[id] = reshaped;
      }
      timelines = next;
    }

    // Media durations are project-frame values too. Keep their wall-clock
    // length intact when the project timebase changes, just like clip source
    // windows; otherwise source guards interpret the old frame count at the
    // new rate and truncate the tail of every asset.
    const media = fpsChanged
      ? this.project.media.map((asset) => ({
          ...asset,
          duration: rescaleFrame(asset.duration, scale),
        }))
      : this.project.media;

    this.execute(
      new ReplaceProjectCommand(
        {
          ...this.project,
          settings: { ...previous, fps, width, height },
          media,
          timeline,
          ...(timelines === this.project.timelines ? {} : { timelines }),
          updatedAt: new Date().toISOString(),
        },
        'Change project settings',
      ),
    );
    return { fps, width, height, changed };
  }

  //  Media management (not undoable  these mutate the asset library) 

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
   * the whole request when a dependent clip sits on a locked track  a locked
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
    // Media-library scope is always the main timeline (dependents above are
    // main-timeline clips), even when a nest is open for editing.
    const dependents = this.project.timeline.clips.filter((clip) => removedSet.has(clip.assetId));
    // Linked partners share a placement, so removing one member must remove the
    // whole group rather than orphan half of it.
    const removedClipIds = this.expandLinkedClipIds(dependents.map((clip) => clip.id), this.project.timeline.clips);
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

  //  Media-library folders (upstream issue #156 slice)  

  /** Create a folder as one undoable step. Throws on an invalid or duplicate name. */
  createMediaFolder(name: string): MediaFolder {
    const cleaned = sanitizeFolderName(name);
    if (cleaned === null) throw new Error('Folder name is required');
    const existing = this.getMediaFolders();
    if (existing.some((folder) => folderNamesMatch(folder.name, cleaned))) {
      throw new Error(`Folder "${cleaned}" already exists`);
    }
    const folder: MediaFolder = { id: nanoid(), name: cleaned };
    this.execute(
      new ReplaceProjectCommand(
        {
          ...this.project,
          mediaFolders: [...existing, folder],
          updatedAt: new Date().toISOString(),
        },
        'Create folder',
      ),
    );
    return folder;
  }

  /** Rename a folder as one undoable step. Identical name is a no-op. */
  renameMediaFolder(folderId: string, name: string): MediaFolder {
    const folders = this.getMediaFolders();
    const target = folders.find((folder) => folder.id === folderId);
    if (!target) throw new Error('Folder not found');
    const cleaned = sanitizeFolderName(name);
    if (cleaned === null) throw new Error('Folder name is required');
    if (folders.some((folder) => folder.id !== folderId && folderNamesMatch(folder.name, cleaned))) {
      throw new Error(`Folder "${cleaned}" already exists`);
    }
    if (folderNamesMatch(target.name, cleaned)) return target;

    const next = folders.map((folder) => (folder.id === folderId ? { ...folder, name: cleaned } : folder));
    this.execute(
      new ReplaceProjectCommand(
        { ...this.project, mediaFolders: next, updatedAt: new Date().toISOString() },
        'Rename folder',
      ),
    );
    return { id: folderId, name: cleaned };
  }

  /**
   * Delete a folder as one undoable step. Member assets move to the library
   * root (their folderId is cleared) — they are never deleted, diverging from
   * upstream's cascade so removing organization cannot destroy media.
   */
  deleteMediaFolder(folderId: string): { deletedFolderId: string; movedAssetIds: string[] } {
    const folders = this.getMediaFolders();
    if (!folders.some((folder) => folder.id === folderId)) throw new Error('Folder not found');

    const media = this.project.media.map((asset) => {
      if (asset.folderId !== folderId) return asset;
      const copy = { ...asset };
      delete copy.folderId;
      return copy;
    });
    const movedAssetIds = media
      .filter((asset, index) => asset !== this.project.media[index])
      .map((asset) => asset.id);

    this.execute(
      new ReplaceProjectCommand(
        {
          ...this.project,
          mediaFolders: folders.filter((folder) => folder.id !== folderId),
          media,
          updatedAt: new Date().toISOString(),
        },
        'Delete folder',
      ),
    );
    return { deletedFolderId: folderId, movedAssetIds };
  }

  /**
   * Move assets into a folder (or to the root when folderId is null) as one
   * undoable step. Validates every asset id first; a no-op returns without
   * pushing history.
   */
  moveAssetsToFolder(assetIds: Iterable<string>, folderId: string | null): { movedAssetIds: string[]; folderId: string | null } {
    if (folderId !== null && !this.getMediaFolders().some((folder) => folder.id === folderId)) {
      throw new Error('Folder not found');
    }
    const requested = new Set(assetIds);
    const targets = this.project.media.filter((asset) => requested.has(asset.id));
    if (targets.length !== requested.size) throw new Error('Media not found');
    const media = this.project.media.map((asset) => {
      if (!requested.has(asset.id)) return asset;
      const current = asset.folderId ?? null;
      if (current === folderId) return asset;
      const copy = { ...asset };
      if (folderId === null) delete copy.folderId;
      else copy.folderId = folderId;
      return copy;
    });
    const movedAssetIds = media
      .filter((asset, index) => asset !== this.project.media[index])
      .map((asset) => asset.id);
    if (movedAssetIds.length === 0) return { movedAssetIds, folderId };

    this.execute(
      new ReplaceProjectCommand(
        { ...this.project, media, updatedAt: new Date().toISOString() },
        movedAssetIds.length === 1 ? 'Move media' : `Move ${movedAssetIds.length} media items`,
      ),
    );
    return { movedAssetIds, folderId };
  }

  //  Project lifecycle

  loadProject(project: Project): void {
    this.project = clearSoloState(withNarrowedCompounds(
      withNarrowedTitleVariations(withNarrowedShapes(
        withNarrowedOpacityTracks(narrowProjectGradePresetLinks(narrowMediaFolders(withNarrowedDescriptions(project)))),
      )),
    ));
    this.history.clear();
    this.settingsSnapshot = null;
    this.activeTimelinePath = [];
    this.notify();
  }

  /**
   * Replace the project WITHOUT notifying subscribers or touching history.
   * Used by the main process to mirror the renderer's authoritative state
   * (renderer -> main sync) so MCP/agent reads see live data, without
   * triggering a sync echo back to the renderer.
   */
  setProjectSilent(project: Project): void {
    this.project = withNarrowedOpacityTracks(narrowProjectGradePresetLinks(project));
    this.coerceScope();
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
    this.settingsSnapshot = null;
    this.activeTimelinePath = [];
    this.notify();
  }

  //  Subscriptions 

  subscribe(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(kind: StateChangeKind = 'edit'): void {
    for (const listener of this.listeners) {
      listener(this.project, kind);
    }
  }

  //  Serialization 

  serialize(): string {
    // Solo is a live audition/render state. Keep it in the snapshot sent to
    // the main process; durable project loads clear it through the controller
    // constructor/load boundary.
    return JSON.stringify(this.project, null, 2);
  }

  static deserialize(json: string): EditorController {
    const raw: unknown = JSON.parse(json);
    const migrated = migrateProject(raw as Record<string, unknown>);
    const project: Project = migrated as unknown as Project;
    return new EditorController(project);
  }
}
