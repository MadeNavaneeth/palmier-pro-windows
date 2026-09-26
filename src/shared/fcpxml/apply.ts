/**
 * Apply a parsed FCPXML plan (#154) onto an editor controller.
 *
 * Shared by future UI flows; the agent executor currently inlines its own
 * variant because it also owns offline reporting semantics. This module is
 * the canonical mapping and is unit-tested against exporter output.
 *
 * Contract: ADDITIVE only — fresh tracks are synthesized per lane so an
 * import never collides with existing content, mirroring the agent tool.
 * Compound imports reconstruct every reachable nested timeline and commit the
 * materialization/adjustment commands as one undo step. Flat documents keep
 * the legacy path unchanged.
 */

import { nanoid } from 'nanoid';
import type { Project, Clip, Timeline, Track } from '../types/project';
import type { EditorController } from '../editor/controller';
import type {
  ImportedClip,
  ImportedSequence,
  ParsedFcpxml,
} from './importer';
import { isImportedCompoundClip } from './importer';
import { sanitizeCrop } from '../media/source-crop';
import { effectiveSpeed } from '../media/source-time';
import { sanitizeMotion, type MotionTrack } from '../media/motion';
import { clampFrame } from '../utils/safe-number';
import {
  COMPOUND_ASSET_ID,
  COMPOUND_NAME_MAX_LENGTH,
  MAX_COMPOUND_DEPTH,
  sanitizeCompoundTimelineId,
} from '../editor/compound';
import { hasEmbeddedAudio } from '../editor/placement';
import { DEFAULT_TITLE_STYLE, sanitizeTitleText } from '../editor/title';
import {
  cropFromTrim,
  motionFromTransformKeyframes,
  placementFromTransform,
  type FcpxmlTransform,
  type FcpxmlTransformKeyframes,
  type PlacementContext,
} from './geometry';

export type { PlacementContext };

export interface ApplyFcpxmlResult {
  placedClips: number;
  titles: number;
  tracksCreated: number;
  skippedOffline: number;
}

export interface ImportedClipFields {
  opacity?: number;
  /** Constant visual speed recovered from a linear FCPXML timeMap. */
  speed?: number;
  opacityTrack?: MotionTrack;
  volume?: number;
  muted?: boolean;
  cropTrim?: { left: number; top: number; right: number; bottom: number };
  transform?: FcpxmlTransform;
  transformKeyframes?: FcpxmlTransformKeyframes;
}

/**
 * What a title element carries: the clip-side adjustments plus the title's own
 * style, which `importedClipPatch` does not own. `ImportedTitle` is structurally
 * assignable to this, so a parsed title can be handed straight over.
 */
export interface ImportedTitleFields extends ImportedClipFields {
  colorHex?: string;
  fontSizePx?: number;
  fontFamily?: string;
  /** The same narrowing `ImportedTitle.alignment` and `Clip.titleAlign` use. */
  alignment?: 'left' | 'center' | 'right';
}

/**
 * The speed half of an imported adjustment, or null when the plan clip carries
 * none. Split out of `importedClipPatch` because both halves of a linked A/V
 * group hold ONE source window: `setClipSpeed` writes `speed` and the scaled
 * `outPoint` onto every linked partner, so the audio twin needs this same rule
 * and there must be exactly one definition of it.
 *
 * Deliberately module-private: both import surfaces reach the rule through
 * `applyImportedAdjustments`, so there is one definition of the speed AND one
 * place that decides a linked twin shares it.
 */
function importedSpeedPatch(
  clip: ImportedClipFields,
): ((draft: Clip) => void) | null {
  if (clip.speed === undefined) return null;
  const speed = effectiveSpeed(clip.speed);
  return (draft) => {
    draft.speed = speed;
    // The trim pass has already established draft.inPoint; the model encodes the
    // consumed source span in outPoint just like EditorController.setClipSpeed.
    draft.outPoint = draft.inPoint + Math.round(draft.durationFrames * speed);
  };
}

/**
 * One applyClipProperties callback carrying every imported adjustment, or
 * null when the plan clip carries none — so an untouched clip adds no undo
 * history. Shared by both materializers (this module and the agent
 * executor's inline variant) so the mapping cannot drift between them.
 */
export function importedClipPatch(
  clip: ImportedClipFields,
  ctx: PlacementContext,
): ((draft: Clip) => boolean) | null {
  const sets: Array<(draft: Clip) => void> = [];
  if (clip.opacity !== undefined) {
    const opacity = Math.min(1, Math.max(0, clip.opacity));
    sets.push((draft) => { draft.opacity = opacity; });
  }
  // Speed and the source window it implies stay in the same undoable batch as
  // the rest of the adjustment.
  const speedPatch = importedSpeedPatch(clip);
  if (speedPatch) sets.push(speedPatch);
  if (clip.opacityTrack) {
    // The importer already narrows the track through the shared sanitizer;
    // assign it in this callback so all imported adjustments stay one
    // applyClipProperties command.
    const track = sanitizeMotion(clip.opacityTrack);
    const bounded = track?.filter((point) => point.value >= 0 && point.value <= 1) ?? [];
    if (bounded.length >= 2) {
      sets.push((draft) => { draft.opacityTrack = bounded; });
    }
  }
  if (clip.volume !== undefined || clip.muted !== undefined) {
    const volume = clip.volume === undefined ? 1 : Math.min(1, Math.max(0, clip.volume));
    const muted = clip.muted ?? false;
    sets.push((draft) => { draft.volume = volume; draft.muted = muted; });
  }
  if (clip.cropTrim) {
    const crop = cropFromTrim(clip.cropTrim, ctx, sanitizeCrop);
    if (crop) sets.push((draft) => { draft.crop = crop; });
  }
  if (clip.transform || clip.transformKeyframes) {
    // Canonical form: the fitted box carries the size, scale carries the
    // sign, the anchor resets — rendering matches by construction. Identity
    // attributes still need the canonical placement when only keyframes were
    // written (upstream emits scale="1 1" position="0 0" plus params).
    const base: FcpxmlTransform = clip.transform
      ?? { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
    const placement = placementFromTransform(base, ctx);
    sets.push((draft) => {
      draft.x = placement.x;
      draft.y = placement.y;
      draft.width = placement.width;
      draft.height = placement.height;
      draft.rotation = placement.rotation;
      draft.scaleX = placement.scaleX;
      draft.scaleY = placement.scaleY;
      draft.anchorX = 0;
      draft.anchorY = 0;
    });
    if (clip.transformKeyframes) {
      const motion = motionFromTransformKeyframes(clip.transformKeyframes, base, ctx);
      sets.push((draft) => {
        if (motion.motionX) draft.motionX = motion.motionX;
        if (motion.motionY) draft.motionY = motion.motionY;
        if (motion.motionScaleX) draft.motionScaleX = motion.motionScaleX;
        if (motion.motionScaleY) draft.motionScaleY = motion.motionScaleY;
        if (motion.motionRot) draft.motionRot = motion.motionRot;
      });
    }
  }
  if (sets.length === 0) return null;
  return (draft) => {
    for (const set of sets) set(draft);
    return true;
  };
}

/**
 * Land one imported element's adjustments — the clip's own, plus the speed every
 * linked partner shares — as a SINGLE `applyClipProperties` command, or as
 * nothing at all when the element carries neither, so an untouched element adds
 * no undo history.
 *
 * Both halves of a linked A/V group hold one source window, and
 * `setClipSpeed` writes `speed` and the scaled `outPoint` onto every linked
 * partner, so the embedded-audio twin `addClip` just created gets the speed too.
 * Speed ALONE: the twin is an audio clip and must not inherit this element's
 * transform, opacity or crop. Ridden in the same batch, so a flat import still
 * costs one undo step per imported element — the agent tool's own receipt
 * promises exactly that — and an element with no speed adds no twin entry.
 *
 * Shared by both import surfaces (this module's flat materializer and the agent
 * executor's inline variant) so a twin cannot come out on a different window
 * from one surface than from the other.
 */
export function applyImportedAdjustments(
  editor: EditorController,
  clipId: string,
  clip: ImportedClipFields,
  ctx: PlacementContext,
): void {
  const adjustments = new Map<string, (draft: Clip) => boolean>();
  const patch = importedClipPatch(clip, ctx);
  if (patch) adjustments.set(clipId, patch);
  const twinSpeedPatch = importedSpeedPatch(clip);
  if (twinSpeedPatch) {
    for (const linkedId of editor.expandLinkedClipIds([clipId])) {
      if (linkedId === clipId || adjustments.has(linkedId)) continue;
      adjustments.set(linkedId, (draft) => {
        twinSpeedPatch(draft);
        return true;
      });
    }
  }
  if (adjustments.size > 0) {
    editor.applyClipProperties(
      [...adjustments.keys()],
      'Import clip adjustments',
      (draft) => adjustments.get(draft.id)?.(draft) ?? false,
    );
  }
}

/**
 * A title's style and adjustments, as ONE `applyClipProperties` command.
 *
 * A title has no media source, so its placement context is the canvas on both
 * axes — that is what the geometry helpers scale against, and there is nothing
 * else. Building the context here instead of taking it is deliberate: a caller
 * cannot hand a title the probed dimensions of a media asset by mistake, which
 * is the one context difference between the title and media paths.
 *
 * Composition order is the reference one: the explicit style fields first, then
 * the shared patch, so the patch wins wherever the two could collide. They are
 * disjoint today — `importedClipPatch` writes opacity, geometry, crop, volume,
 * muted and motion, never the title's own colour/size/font/alignment — so the
 * order guards a future collision rather than a present one. It is fixed here
 * anyway, in one place, so the two import surfaces cannot come to disagree.
 *
 * Titles are not linked and have no twin, so unlike `applyImportedAdjustments`
 * this is a single-clip command by nature rather than by batching.
 */
export function applyImportedTitleStyle(
  editor: EditorController,
  titleId: string,
  clip: ImportedTitleFields,
): void {
  const { width: canvasWidth, height: canvasHeight } = editor.getProject().settings;
  const patch = importedClipPatch(clip, {
    canvasWidth,
    canvasHeight,
    sourceWidth: canvasWidth,
    sourceHeight: canvasHeight,
  });
  editor.applyClipProperties([titleId], 'Import title style', (draft) => {
    if (clip.colorHex) draft.titleColor = clip.colorHex;
    if (clip.fontSizePx) draft.titleSizeRatio = clip.fontSizePx / canvasHeight;
    if (clip.fontFamily) draft.titleFontFamily = clip.fontFamily;
    if (clip.alignment) draft.titleAlign = clip.alignment;
    if (patch) patch(draft);
    return true;
  });
}

/**
 * A document rate below one frame per second is not a frame rate: every
 * `offset`/`duration` the importer read has already been rounded to whole
 * multi-second units by the time the plan reaches the applier, so the plan's
 * frame numbers cannot be rescaled back into anything the source said. Measured
 * on a 30 fps project, a `frameDuration` of 2s (0.5 fps) placed a 10/60/15/135
 * clip at 0/60/0/120 and one of 100s (0.01 fps) inflated a 60-frame clip to
 * 3000 frames, both with an empty `unsupported` list. One frame per second is
 * the floor below which a frame mapping carries no information; every rate a
 * real document can carry, and every rate the exporter can write (the project
 * rate is a positive integer, `controller.applyProjectSettings`), clears it.
 */
const MIN_IMPORT_SOURCE_FPS = 1;

/**
 * The refusal for a document rate that cannot carry a frame mapping, or null
 * when the rate is usable. The single decision both import surfaces ask: the
 * applier below, and the agent's own `import_fcpxml` tool, which inlines
 * placement rather than delegating here and so would otherwise re-derive — and
 * drift from — this rule. The note is pushed onto `plan.unsupported` and also
 * returned, so a caller whose result envelope has no `unsupported` channel (the
 * agent reports a refusal as `success: false`) reports the same wording.
 *
 * An absent rate means "use the project rate" — the identity rescale, which
 * stays allowed, so a document with no usable `<format frameDuration>` keeps its
 * existing (importer-reported) behavior.
 */
export function degenerateRateRefusal(plan: ParsedFcpxml, projectFps: number): string | null {
  const sourceFps = plan.fps ?? projectFps;
  if (Number.isFinite(sourceFps) && sourceFps >= MIN_IMPORT_SOURCE_FPS) return null;
  const note = Number.isFinite(sourceFps)
    ? `<format frameDuration> declares ${sourceFps} fps, too slow to map frames; nothing is imported.`
    : '<format frameDuration> declares an unusable frame rate; nothing is imported.';
  // Nothing left to place means the importer already refused the whole spine
  // and said so; a second note would only repeat it.
  if (plan.clips.length > 0) plan.unsupported.push(note);
  return note;
}

function importSourceFps(plan: ParsedFcpxml, projectFps: number): number | null {
  if (degenerateRateRefusal(plan, projectFps) !== null) return null;
  return plan.fps ?? projectFps;
}

/**
 * Document frames -> project frames. `clampFrame` keeps a non-finite
 * intermediate from becoming an `Infinity`/`NaN` frame value on any clip:
 * `plan.fps` reaches this module across IPC, and `??` does not catch a `0`
 * rate, so a degenerate document can still carry one.
 */
export function frameRescaler(projectFps: number, sourceFps: number): (frames: number) => number {
  const fpsScale = sourceFps > 0 ? projectFps / sourceFps : 1;
  return (frames: number): number => clampFrame(Math.round(frames * fpsScale));
}

/**
 * @param plan          Parsed plan (see importer).
 * @param assetIdByPath Library asset id per absolute asset path; entries the
 *                      caller could not add are treated as offline/skipped.
 * @param sourceDimsByPath Optional probed source dimensions per asset path,
 *                      for placing geometry and crop. Absent entries fall back
 *                      to the canvas (see geometry).
 */
export function applyFcpxmlPlan(
  editor: EditorController,
  plan: ParsedFcpxml,
  assetIdByPath: ReadonlyMap<string, string>,
  sourceDimsByPath: ReadonlyMap<string, { width?: number; height?: number }> = new Map(),
): ApplyFcpxmlResult {
  // Keep the flat path byte-for-byte compatible. Only a reachable, validated
  // sequence graph enters the compound materializer.
  if (plan.sequences && plan.sequences.length > 0) {
    return applyCompoundFcpxmlPlan(editor, plan, assetIdByPath, sourceDimsByPath);
  }

  const projectFps = editor.getProject().settings.fps;
  const sourceFps = importSourceFps(plan, projectFps);
  if (sourceFps === null) {
    return { placedClips: 0, titles: 0, tracksCreated: 0, skippedOffline: 0 };
  }
  const toFrames = frameRescaler(projectFps, sourceFps);
  const canvasWidth = editor.getProject().settings.width;
  const canvasHeight = editor.getProject().settings.height;

  // Lanes materialize as fresh video/audio tracks.
  const videoLaneTrack = new Map<number, string>();
  const audioLaneTrack = new Map<number, string>();
  const maxVLane = Math.max(0, ...plan.clips.filter((c) => c.kind !== 'audio').map((c) => c.lane));
  for (let lane = 0; lane <= maxVLane; lane++) {
    videoLaneTrack.set(lane, editor.addTrack('video'));
  }
  const audioLanes = [...new Set(plan.clips.filter((c) => c.kind === 'audio').map((c) => c.lane))].sort((a, b) => a - b);
  for (const lane of audioLanes) {
    audioLaneTrack.set(lane, editor.addTrack('audio'));
  }

  let placedClips = 0;
  let titles = 0;
  let skippedOffline = 0;

  for (const clip of plan.clips) {
    const startFrame = toFrames(clip.startFrame);
    const durationFrames = Math.max(1, toFrames(clip.durationFrames));

    if (clip.kind === 'title') {
      const trackId = videoLaneTrack.get(clip.lane);
      if (!trackId) continue;
      const titleId = editor.addTitleClip({
        trackId,
        text: clip.text,
        startFrame,
        durationFrames,
      });
      applyImportedTitleStyle(editor, titleId, clip);
      titles += 1;
      continue;
    }

    const assetId = assetIdByPath.get(clip.assetPath);
    if (!assetId) {
      skippedOffline += 1;
      continue;
    }
    const trackId = clip.kind === 'audio'
      ? audioLaneTrack.get(clip.lane)
      : videoLaneTrack.get(clip.lane);
    if (!trackId) continue;

    const sourceIn = toFrames(clip.sourceInFrame);
    const clipId = editor.addClip({
      assetId,
      trackId,
      startFrame,
      durationFrames,
    });
    // Source trim is a follow-up edit: addClip has no In/Out params.
    // The span stays UNSCALED by any recovered speed, deliberately. trimClip takes
    // source frames, but it derives the timeline length from the window via
    // trimWindowDurationFrames = round((out - in) / effectiveSpeed(clip.speed)),
    // and the clip's speed is still undefined (= 1) here because the speed lands
    // later in the importedClipPatch batch below. So a pre-scaled span would make
    // the trim derive a doubled durationFrames, which the patch would then scale
    // a second time when it rewrites outPoint: a 2x clip would import as 4x.
    // The unscaled span is what yields the correct source window, and importedClipPatch
    // converts it to the real outPoint, so both operations agree on the end state.
    if (clip.sourceInFrame > 0) {
      editor.trimClip(clipId, sourceIn, sourceIn + durationFrames);
    }
    // Imported adjustments (opacity, opacity animation, speed, volume, crop,
    // geometry) ride one undoable batch; a clip carrying none adds no history.
    // The batch carries the linked twin's share of the speed too.
    const dims = sourceDimsByPath.get(clip.assetPath);
    applyImportedAdjustments(editor, clipId, clip, {
      canvasWidth,
      canvasHeight,
      sourceWidth: dims?.width,
      sourceHeight: dims?.height,
    });
    placedClips += 1;
  }

  return {
    placedClips,
    titles,
    tracksCreated: videoLaneTrack.size + audioLaneTrack.size,
    skippedOffline,
  };
}

/**
 * The element the exporter wrote for the AUDIO half of a linked A/V group: a
 * negative lane (`-(audioTrackIndex + 1)`, the FCPXML marker for an audio lane
 * below the spine) carrying a video-bearing asset. `kind` narrows the ASSET, not
 * the lane, so the importer hands this back as `kind: 'video'` on a negative
 * lane — see `parseAssetClipTag`'s `isAudioOnly`. It is the twin, never a
 * second visual clip, and the visual element of the same group rebuilds the
 * whole pair.
 */
function isLinkedAudioHalf(clip: ImportedClip): boolean {
  return clip.kind === 'video' && clip.lane < 0;
}

function isAudioLaneClip(clip: ImportedClip): boolean {
  return clip.kind === 'audio'
    || isLinkedAudioHalf(clip)
    || (isImportedCompoundClip(clip) && clip.lane < 0);
}

function importedLane(clip: ImportedClip): number {
  return Number.isSafeInteger(clip.lane) ? clip.lane : 0;
}

function cleanImportedTimelineName(value: string | undefined): string {
  return (value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, COMPOUND_NAME_MAX_LENGTH) || 'Nested sequence';
}

/**
 * Materialize a compound document as one undoable action. Tracks, clips, clip
 * adjustments and the nested timelines themselves all land through separate
 * domain operations, and they must undo together: a transaction groups them by
 * construction instead of counting how many entries the run happened to push.
 */
function applyCompoundFcpxmlPlan(
  editor: EditorController,
  plan: ParsedFcpxml,
  assetIdByPath: ReadonlyMap<string, string>,
  sourceDimsByPath: ReadonlyMap<string, { width?: number; height?: number }>,
): ApplyFcpxmlResult {
  return editor.transaction('Import FCPXML', () =>
    materializeCompoundFcpxmlPlan(editor, plan, assetIdByPath, sourceDimsByPath),
  );
}

function materializeCompoundFcpxmlPlan(
  editor: EditorController,
  plan: ParsedFcpxml,
  assetIdByPath: ReadonlyMap<string, string>,
  sourceDimsByPath: ReadonlyMap<string, { width?: number; height?: number }>,
): ApplyFcpxmlResult {
  const initialProject = editor.getProject();
  const projectFps = initialProject.settings.fps;
  const sourceFps = importSourceFps(plan, projectFps);
  if (sourceFps === null) {
    return { placedClips: 0, titles: 0, tracksCreated: 0, skippedOffline: 0 };
  }
  const toFrames = frameRescaler(projectFps, sourceFps);
  const canvasWidth = initialProject.settings.width;
  const canvasHeight = initialProject.settings.height;

  const sequenceByRef = new Map<string, ImportedSequence>();
  for (const sequence of plan.sequences ?? []) {
    const ref = sanitizeCompoundTimelineId(sequence.ref);
    if (ref !== undefined && !sequenceByRef.has(ref)) sequenceByRef.set(ref, sequence);
  }

  // Validate again at the materialization boundary: ParsedFcpxml also crosses
  // IPC, and a caller must not be able to reintroduce a cycle or bypass depth.
  const validityMemo = new Map<string, boolean>();
  const sequenceIsValidAtDepth = (
    rawRef: string,
    depth: number,
    path: readonly string[],
  ): boolean => {
    const ref = sanitizeCompoundTimelineId(rawRef);
    if (ref === undefined || depth > MAX_COMPOUND_DEPTH || path.includes(ref)) return false;
    const key = JSON.stringify([depth, ref]);
    const memoized = validityMemo.get(key);
    if (memoized !== undefined) return memoized;
    const sequence = sequenceByRef.get(ref);
    if (!sequence) {
      validityMemo.set(key, false);
      return false;
    }
    const nextPath = [...path, ref];
    const valid = sequence.clips.every((clip) =>
      !isImportedCompoundClip(clip)
        || sequenceIsValidAtDepth(clip.compoundSequenceRef, depth + 1, nextPath),
    );
    validityMemo.set(key, valid);
    return valid;
  };

  const reachableRefs = new Set<string>();
  const depthByRef = new Map<string, number>();
  const collectReachable = (rawRef: string, depth: number, path: readonly string[]): void => {
    const ref = sanitizeCompoundTimelineId(rawRef);
    if (
      ref === undefined
      || !sequenceIsValidAtDepth(ref, depth, path)
      || !sequenceByRef.has(ref)
    ) return;
    const previousDepth = depthByRef.get(ref);
    if (previousDepth !== undefined && previousDepth <= depth) return;
    depthByRef.set(ref, depth);
    reachableRefs.add(ref);
    for (const clip of sequenceByRef.get(ref)!.clips) {
      if (isImportedCompoundClip(clip)) {
        collectReachable(clip.compoundSequenceRef, depth + 1, [...path, ref]);
      }
    }
  };
  for (const clip of plan.clips) {
    if (isImportedCompoundClip(clip)) collectReachable(clip.compoundSequenceRef, 1, []);
  }

  // Never reuse the FCPXML resource id as a local id. Allocate deterministic
  // candidates in plan preorder and skip every existing Project.timelines key.
  const existingTimelineIds = new Set(Object.keys(initialProject.timelines ?? {}));
  const localTimelineIdByRef = new Map<string, string>();
  let nextTimelineId = 1;
  for (const sequence of plan.sequences ?? []) {
    const ref = sanitizeCompoundTimelineId(sequence.ref);
    if (ref === undefined || !reachableRefs.has(ref) || localTimelineIdByRef.has(ref)) continue;
    let localId: string;
    do {
      localId = `fcpxml-nested-${nextTimelineId++}`;
    } while (existingTimelineIds.has(localId));
    existingTimelineIds.add(localId);
    localTimelineIdByRef.set(ref, localId);
  }

  // A compound-only document is the new path, so synthesize exactly the lanes
  // actually present. This avoids both empty filler tracks and unbounded loops
  // over a hostile lane number.
  const visualLanes = [...new Set(
    plan.clips.filter((clip) => !isAudioLaneClip(clip)).map(importedLane),
  )].sort((left, right) => left - right);
  const audioLanes = [...new Set(
    plan.clips.filter(isAudioLaneClip).map(importedLane),
  )].sort((left, right) => left - right);
  const videoLaneTrack = new Map<number, string>();
  const audioLaneTrack = new Map<number, string>();
  for (const lane of visualLanes) videoLaneTrack.set(lane, editor.addTrack('video'));
  for (const lane of audioLanes) audioLaneTrack.set(lane, editor.addTrack('audio'));

  let placedClips = 0;
  let titles = 0;
  let skippedOffline = 0;
  const rootPatches = new Map<string, (draft: Clip) => void>();
  const addAdjustmentPatch = (clipId: string, clip: ImportedClip): void => {
    const ctx: PlacementContext = clip.kind === 'title' || isImportedCompoundClip(clip)
      ? {
        canvasWidth,
        canvasHeight,
        sourceWidth: canvasWidth,
        sourceHeight: canvasHeight,
      }
      : {
        canvasWidth,
        canvasHeight,
        sourceWidth: sourceDimsByPath.get(clip.assetPath)?.width,
        sourceHeight: sourceDimsByPath.get(clip.assetPath)?.height,
      };
    const adjustment = importedClipPatch(clip, ctx);
    if (!adjustment) return;
    rootPatches.set(clipId, (draft) => {
      adjustment(draft);
    });
  };
  // addClip creates the embedded-audio twin itself, and that twin shares the
  // pair's ONE source window — so it needs the same speed the visual clip gets,
  // exactly as EditorController.setClipSpeed writes it onto a linked group.
  const addLinkedSpeedPatch = (clipId: string, clip: ImportedClip): void => {
    const speedPatch = importedSpeedPatch(clip);
    if (!speedPatch) return;
    for (const linkedId of editor.expandLinkedClipIds([clipId])) {
      if (linkedId === clipId) continue;
      rootPatches.set(linkedId, (draft) => {
        speedPatch(draft);
      });
    }
  };

  for (const clip of plan.clips) {
    const lane = importedLane(clip);
    const startFrame = toFrames(clip.startFrame);
    const durationFrames = Math.max(1, toFrames(clip.durationFrames));

    if (clip.kind === 'title') {
      const trackId = videoLaneTrack.get(lane);
      if (!trackId) continue;
      const titleId = editor.addTitleClip({
        trackId,
        text: clip.text,
        startFrame,
        durationFrames,
      });
      if (titleId) {
        const adjustment = importedClipPatch(clip, {
          canvasWidth,
          canvasHeight,
          sourceWidth: canvasWidth,
          sourceHeight: canvasHeight,
        });
        rootPatches.set(titleId, (draft) => {
          if (clip.colorHex) draft.titleColor = clip.colorHex;
          if (clip.fontSizePx) draft.titleSizeRatio = clip.fontSizePx / settingsHeight(editor);
          if (clip.fontFamily) draft.titleFontFamily = clip.fontFamily;
          if (clip.alignment) draft.titleAlign = clip.alignment;
          adjustment?.(draft);
        });
      }
      titles += 1;
      continue;
    }

    if (isImportedCompoundClip(clip)) {
      const ref = sanitizeCompoundTimelineId(clip.compoundSequenceRef);
      const timelineId = ref === undefined ? undefined : localTimelineIdByRef.get(ref);
      const trackId = isAudioLaneClip(clip)
        ? audioLaneTrack.get(lane)
        : videoLaneTrack.get(lane);
      if (!timelineId || !trackId) continue;
      const clipId = editor.addClip({
        assetId: COMPOUND_ASSET_ID,
        type: 'compound',
        trackId,
        startFrame,
        durationFrames,
      });
      if (!clipId) continue;
      const adjustment = importedClipPatch(clip, {
        canvasWidth,
        canvasHeight,
        sourceWidth: canvasWidth,
        sourceHeight: canvasHeight,
      });
      rootPatches.set(clipId, (draft) => {
        draft.inPoint = toFrames(clip.sourceInFrame);
        draft.outPoint = draft.inPoint + durationFrames;
        draft.compoundTimelineId = timelineId;
        draft.label = clip.label;
        adjustment?.(draft);
      });
      continue;
    }

    const assetId = assetIdByPath.get(clip.assetPath);
    if (!assetId) {
      skippedOffline += 1;
      continue;
    }
    // The visual element of a linked A/V group rebuilds the whole pair — the
    // flat path drops this element for the same reason — so materializing it
    // here would place the group twice.
    if (isLinkedAudioHalf(clip)) continue;
    const trackId = isAudioLaneClip(clip)
      ? audioLaneTrack.get(lane)
      : videoLaneTrack.get(lane);
    if (!trackId) continue;

    const sourceIn = toFrames(clip.sourceInFrame);
    const clipId = editor.addClip({
      assetId,
      trackId,
      startFrame,
      durationFrames,
    });
    if (clip.sourceInFrame > 0) {
      editor.trimClip(clipId, sourceIn, sourceIn + durationFrames);
    }
    addAdjustmentPatch(clipId, clip);
    addLinkedSpeedPatch(clipId, clip);
    placedClips += 1;
  }

  if (rootPatches.size > 0) {
    editor.applyClipProperties(
      [...rootPatches.keys()],
      'Import FCPXML clip properties',
      (draft) => {
        const patch = rootPatches.get(draft.id);
        if (!patch) return false;
        patch(draft);
        return true;
      },
    );
  }

  interface MaterializedSequence {
    timeline: Timeline;
    placedClips: number;
    titles: number;
    skippedOffline: number;
  }

  const materializeSequence = (sequence: ImportedSequence): MaterializedSequence | null => {
    const ref = sanitizeCompoundTimelineId(sequence.ref);
    if (ref === undefined) return null;
    const localId = localTimelineIdByRef.get(ref);
    if (!localId || !sequenceIsValidAtDepth(ref, depthByRef.get(ref) ?? 1, [])) return null;

    const tracks: Track[] = [];
    const visual = [...new Set(
      sequence.clips.filter((clip) => !isAudioLaneClip(clip)).map(importedLane),
    )].sort((left, right) => left - right);
    const audio = [...new Set(
      sequence.clips.filter(isAudioLaneClip).map(importedLane),
    )].sort((left, right) => left - right);
    const videoTracks = new Map<number, string>();
    const audioTracks = new Map<number, string>();
    for (const [index, lane] of visual.entries()) {
      const id = nanoid();
      videoTracks.set(lane, id);
      tracks.push({
        id,
        name: `Video ${index + 1}`,
        type: 'video',
        locked: false,
        visible: true,
        syncLocked: true,
        order: tracks.length,
      });
    }
    for (const [index, lane] of audio.entries()) {
      const id = nanoid();
      audioTracks.set(lane, id);
      tracks.push({
        id,
        name: `Audio ${index + 1}`,
        type: 'audio',
        locked: false,
        visible: true,
        syncLocked: true,
        order: tracks.length,
      });
    }

    const project = editor.getProject();
    const mediaById = new Map(project.media.map((asset) => [asset.id, asset] as const));
    const clips: Clip[] = [];
    let placed = 0;
    let titleCount = 0;
    let offline = 0;

    const resolveAudioTrack = (clip: Clip): Track => {
      const endFrame = clip.startFrame + clip.durationFrames;
      const available = tracks
        .filter((track) => track.type === 'audio')
        .sort((left, right) => left.order - right.order)
        .find((track) => clips
          .filter((candidate) => candidate.trackId === track.id)
          .every((candidate) => (
            candidate.startFrame + candidate.durationFrames <= clip.startFrame
            || candidate.startFrame >= endFrame
          )));
      if (available) return available;
      const created: Track = {
        id: nanoid(),
        name: `Audio ${tracks.filter((track) => track.type === 'audio').length + 1}`,
        type: 'audio',
        locked: false,
        visible: true,
        syncLocked: true,
        order: tracks.length,
      };
      tracks.push(created);
      return created;
    };

    for (const imported of sequence.clips) {
      const lane = importedLane(imported);
      const startFrame = toFrames(imported.startFrame);
      const durationFrames = Math.max(1, toFrames(imported.durationFrames));
      if (imported.kind === 'title') {
        const trackId = videoTracks.get(lane);
        const text = sanitizeTitleText(imported.text);
        if (!trackId || !text) continue;
        const clip: Clip = {
          id: nanoid(),
          assetId: '__title__',
          type: 'title',
          trackId,
          startFrame,
          durationFrames,
          inPoint: 0,
          outPoint: durationFrames,
          x: 0,
          y: 0,
          width: canvasWidth,
          height: canvasHeight,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          anchorX: 0,
          anchorY: 0,
          volume: 1,
          muted: false,
          label: text,
          text,
          titleSizeRatio: DEFAULT_TITLE_STYLE.sizeRatio,
          titleColor: DEFAULT_TITLE_STYLE.colorHex,
        };
        const adjustment = importedClipPatch(imported, {
          canvasWidth,
          canvasHeight,
          sourceWidth: canvasWidth,
          sourceHeight: canvasHeight,
        });
        if (adjustment) adjustment(clip);
        if (imported.colorHex) clip.titleColor = imported.colorHex;
        if (imported.fontSizePx) clip.titleSizeRatio = imported.fontSizePx / canvasHeight;
        if (imported.fontFamily) clip.titleFontFamily = imported.fontFamily;
        if (imported.alignment) clip.titleAlign = imported.alignment;
        clips.push(clip);
        titleCount += 1;
        continue;
      }

      if (isImportedCompoundClip(imported)) {
        const childRef = sanitizeCompoundTimelineId(imported.compoundSequenceRef);
        const childTimelineId = childRef === undefined
          ? undefined
          : localTimelineIdByRef.get(childRef);
        const trackId = isAudioLaneClip(imported)
          ? audioTracks.get(lane)
          : videoTracks.get(lane);
        if (!childTimelineId || !trackId) continue;
        const clip: Clip = {
          id: nanoid(),
          assetId: COMPOUND_ASSET_ID,
          type: 'compound',
          trackId,
          startFrame,
          durationFrames,
          inPoint: toFrames(imported.sourceInFrame),
          outPoint: toFrames(imported.sourceInFrame) + durationFrames,
          x: 0,
          y: 0,
          width: canvasWidth,
          height: canvasHeight,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          anchorX: 0,
          anchorY: 0,
          volume: 1,
          muted: false,
          label: imported.label,
          compoundTimelineId: childTimelineId,
        };
        const adjustment = importedClipPatch(imported, {
          canvasWidth,
          canvasHeight,
          sourceWidth: canvasWidth,
          sourceHeight: canvasHeight,
        });
        if (adjustment) adjustment(clip);
        clips.push(clip);
        continue;
      }

      const assetId = assetIdByPath.get(imported.assetPath);
      if (!assetId) {
        offline += 1;
        continue;
      }
      // The visual element of a linked A/V group rebuilds the whole pair, so
      // the audio element the exporter wrote for it is redundant here — the
      // flat path drops it for the same reason. Materializing it would give
      // every linked group a second video track and a second pair.
      if (isLinkedAudioHalf(imported)) continue;
      const trackId = isAudioLaneClip(imported)
        ? audioTracks.get(lane)
        : videoTracks.get(lane);
      if (!trackId) continue;
      const asset = mediaById.get(assetId);
      const type: Clip['type'] = asset?.type
        ?? (imported.kind === 'audio' ? 'audio' : 'video');
      const sourceIn = toFrames(imported.sourceInFrame);
      const clip: Clip = {
        id: nanoid(),
        assetId,
        type,
        trackId,
        startFrame,
        durationFrames,
        inPoint: sourceIn,
        outPoint: sourceIn + durationFrames,
        x: 0,
        y: 0,
        width: canvasWidth,
        height: canvasHeight,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        anchorX: 0,
        anchorY: 0,
        volume: 1,
        muted: false,
        label: imported.label,
      };

      if (
        type === 'video'
        && tracks.find((track) => track.id === trackId)?.type === 'video'
        && asset
        && hasEmbeddedAudio(asset)
      ) {
        const audioTrack = resolveAudioTrack(clip);
        const linkGroupId = nanoid();
        clip.linkGroupId = linkGroupId;
        clips.push(clip);
        const twin: Clip = {
          id: nanoid(),
          assetId,
          type: 'audio',
          trackId: audioTrack.id,
          linkGroupId,
          startFrame,
          durationFrames,
          inPoint: sourceIn,
          outPoint: sourceIn + durationFrames,
          x: 0,
          y: 0,
          width: canvasWidth,
          height: canvasHeight,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
          anchorX: 0,
          anchorY: 0,
          volume: 1,
          muted: false,
          label: imported.label,
        };
        // The twin is built apart from its visual sibling, so it does not ride
        // the sibling's adjustment pass. Both halves of a link group hold one
        // source window, and a recovered speed scales it on BOTH — leaving the
        // twin unscaled is a state EditorController.setClipSpeed never writes.
        importedSpeedPatch(imported)?.(twin);
        clips.push(twin);
      } else {
        clips.push(clip);
      }

      const dims = sourceDimsByPath.get(imported.assetPath);
      const adjustment = importedClipPatch(imported, {
        canvasWidth,
        canvasHeight,
        sourceWidth: dims?.width,
        sourceHeight: dims?.height,
      });
      if (adjustment) adjustment(clip);
      placed += 1;
    }

    return {
      timeline: {
        tracks,
        clips,
        playheadFrame: 0,
        name: cleanImportedTimelineName(sequence.name),
      },
      placedClips: placed,
      titles: titleCount,
      skippedOffline: offline,
    };
  };

  if (localTimelineIdByRef.size > 0) {
    const timelines = { ...(editor.getProject().timelines ?? {}) };
    for (const sequence of plan.sequences ?? []) {
      const ref = sanitizeCompoundTimelineId(sequence.ref);
      const localId = ref === undefined ? undefined : localTimelineIdByRef.get(ref);
      if (!localId) continue;
      const materialized = materializeSequence(sequence);
      if (!materialized) continue;
      timelines[localId] = materialized.timeline;
      placedClips += materialized.placedClips;
      titles += materialized.titles;
      skippedOffline += materialized.skippedOffline;
    }
    editor.adoptProject(
      { ...editor.getProject(), timelines },
      'Import FCPXML nested timelines',
    );
  }

  return {
    placedClips,
    titles,
    tracksCreated: videoLaneTrack.size + audioLaneTrack.size,
    skippedOffline,
  };
}

function settingsHeight(editor: EditorController): number {
  return (editor.getProject() as Project).settings.height;
}
