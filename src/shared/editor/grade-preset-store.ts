/**
 * Shared named color-grade/shot preset contract (upstream #157).
 *
 * Presets are app-wide preferences, so the renderer, main-process repository,
 * and Agent/MCP executor must all narrow the same persisted shape. Grade
 * capture/apply and the optional shot-settings sibling live here as well so
 * the UI and Agent cannot drift into different snapshot semantics.
 */

import {
  COLOR_GRADE_LIMITS,
  DEFAULT_COLOR_GRADE,
  GRADE_PRESETS,
  GRADE_PRESET_NAME_MAX,
  MAX_USER_GRADE_PRESETS,
  gradePresetById,
  normalizeUserGradePresets as normalizeStoredGradePresets,
  sanitizeColorGrade,
  type ColorGrade,
  type GradePreset as StoredGradePreset,
} from './color-grade';
import { CROP_MAX_EDGE, sanitizeCrop, type SourceCrop } from '../media/source-crop';
import { sanitizeClipEffects, type ClipEffects } from './effects';
import type { Clip, Project, Timeline } from '../types/project';
import type { EditorController } from './controller';

export {
  GRADE_PRESETS,
  GRADE_PRESET_NAME_MAX,
  MAX_USER_GRADE_PRESETS,
  gradePresetById,
};

/** Maximum persisted length of a named-preset link ID. */
export const GRADE_PRESET_ID_MAX = 64;

const GRADE_PRESET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Narrow a clip's optional link to the same safe token shape as stored preset
 * IDs. Resolution is deliberately not attempted here: a valid unknown ID is
 * inert metadata, while malformed values are removed at the project boundary.
 */
export function normalizeGradePresetId(input: unknown): string | undefined {
  return typeof input === 'string' && GRADE_PRESET_ID_PATTERN.test(input) ? input : undefined;
}

/** Narrow one clip's link while preserving every other clip field by identity. */
export function narrowGradePresetLink<T extends { gradePresetId?: unknown }>(clip: T): T {
  const normalized = normalizeGradePresetId(clip.gradePresetId);
  if (normalized === undefined) {
    if (!Object.prototype.hasOwnProperty.call(clip, 'gradePresetId') || clip.gradePresetId === undefined) {
      return clip;
    }
    const copy = { ...clip };
    delete copy.gradePresetId;
    return copy as T;
  }
  return normalized === clip.gradePresetId ? clip : ({ ...clip, gradePresetId: normalized } as T);
}

function narrowTimelineGradePresetLinks(timeline: Timeline): Timeline {
  let changed = false;
  const clips = timeline.clips.map((clip) => {
    const narrowed = narrowGradePresetLink(clip);
    if (narrowed !== clip) changed = true;
    return narrowed;
  });
  return changed ? { ...timeline, clips } : timeline;
}

/** Narrow links on the main and every nested timeline during project read. */
export function narrowProjectGradePresetLinks(project: Project): Project {
  const timeline = narrowTimelineGradePresetLinks(project.timeline);
  let timelines = project.timelines;
  if (timelines) {
    let nestedChanged = false;
    const nextTimelines: Record<string, Timeline> = {};
    for (const [id, nested] of Object.entries(timelines)) {
      const narrowed = narrowTimelineGradePresetLinks(nested);
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

/** Canvas dimensions used to map normalized shot position to pixels. */
export interface ShotCanvasSize {
  width: number;
  height: number;
}

/**
 * Optional normalized framing stored beside (never inside) a grade.
 *
 * `x`/`y` are fractions of the project canvas. Scale values are multipliers,
 * rotation is degrees, opacity is 0..1, and anchor values are fractions of
 * the target clip box. Crop values are the existing source-edge fractions.
 * All fields are optional so a hand-authored partial shot can change one
 * static transform without resetting the rest. Motion tracks are deliberately
 * not represented; active motion tracks always win over these static values.
 */
export interface ShotSettings {
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  anchorX?: number;
  anchorY?: number;
  opacity?: number;
  crop?: SourceCrop;
}

/** A captured grade with its optional normalized shot sibling. */
export interface CapturedPreset {
  grade: GradePresetGrade;
  shot?: ShotSettings;
}

/** A persisted grade preset with an optional framing payload. */
export type GradePreset = StoredGradePreset & { shot?: ShotSettings };

/** A captured grade, including required scalar defaults and effect stages. */
export type GradePresetGrade = ColorGrade & ClipEffects;

/** A sparse, already-sanitized grade patch used by the shared helper. */
export type GradePresetPatch = Partial<ColorGrade> & ClipEffects;

const SHOT_SCALE_LIMIT = 100;
const SHOT_ROTATION_LIMIT = 360;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasShotField(input: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined;
}

function shotNumber(value: unknown, min: number, max: number, neutral: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : neutral;
}

function shotCropEdge(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= CROP_MAX_EDGE
    ? value
    : 0;
}

function neutralShotCrop(): SourceCrop {
  return { left: 0, right: 0, top: 0, bottom: 0 };
}

function normalizeShotCrop(input: unknown): SourceCrop {
  if (!isRecord(input)) return neutralShotCrop();
  const crop = sanitizeCrop({
    left: shotCropEdge(input.left),
    right: shotCropEdge(input.right),
    top: shotCropEdge(input.top),
    bottom: shotCropEdge(input.bottom),
  });
  return crop ?? neutralShotCrop();
}

/**
 * Narrow an untrusted shot payload.
 *
 * Omitted fields stay omitted for partial presets. A present but invalid field
 * becomes its neutral transform value, so hostile stored data cannot leak a
 * raw number into the clip. A non-object `shot` is discarded entirely; the
 * absence of a shot is the backward-compatible no-framing-change contract.
 */
export function normalizeShotSettings(input: unknown): ShotSettings | undefined {
  if (!isRecord(input)) return undefined;
  const shot: ShotSettings = {};
  if (hasShotField(input, 'x')) shot.x = shotNumber(input.x, 0, 1, 0);
  if (hasShotField(input, 'y')) shot.y = shotNumber(input.y, 0, 1, 0);
  if (hasShotField(input, 'scaleX')) shot.scaleX = shotNumber(input.scaleX, 0, SHOT_SCALE_LIMIT, 1);
  if (hasShotField(input, 'scaleY')) shot.scaleY = shotNumber(input.scaleY, 0, SHOT_SCALE_LIMIT, 1);
  if (hasShotField(input, 'rotation')) shot.rotation = shotNumber(input.rotation, -SHOT_ROTATION_LIMIT, SHOT_ROTATION_LIMIT, 0);
  if (hasShotField(input, 'anchorX')) shot.anchorX = shotNumber(input.anchorX, 0, 1, 0);
  if (hasShotField(input, 'anchorY')) shot.anchorY = shotNumber(input.anchorY, 0, 1, 0);
  if (hasShotField(input, 'opacity')) shot.opacity = shotNumber(input.opacity, 0, 1, 1);
  if (hasShotField(input, 'crop')) shot.crop = normalizeShotCrop(input.crop);
  return Object.keys(shot).length > 0 ? shot : undefined;
}

/**
 * Normalize one display name using the same trim/length rule as the persisted
 * list normalizer. Returning null lets repositories give a precise refusal
 * instead of silently dropping the candidate.
 */
export function normalizeGradePresetLabel(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const label = input.trim();
  return label.length > 0 && label.length <= GRADE_PRESET_NAME_MAX ? label : null;
}

/** Case-insensitive key used only for name collision checks. */
export function gradePresetNameKey(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Narrow the persisted list while preserving the optional shot sibling.
 * The underlying color/effect normalizer remains the single grade authority;
 * each candidate is passed through it once, then its shot is narrowed here.
 */
export function normalizeUserGradePresets(input: unknown): GradePreset[] {
  if (!Array.isArray(input)) return [];
  const byId = new Map<string, GradePreset>();
  for (const entry of input) {
    const normalized = normalizeStoredGradePresets([entry])[0];
    if (!normalized) continue;
    const shot = normalizeShotSettings(isRecord(entry) ? entry.shot : undefined);
    const preset: GradePreset = shot ? { ...normalized, shot } : normalized;
    byId.set(preset.id, preset);
    if (byId.size >= MAX_USER_GRADE_PRESETS) break;
  }
  return [...byId.values()];
}

/**
 * Narrow one candidate through the canonical list normalizer. This keeps id,
 * label, cap, grade/effect fields, and the optional shot on one path.
 */
export function normalizeGradePresetCandidate(input: {
  id: unknown;
  label: unknown;
  grade: unknown;
  shot?: unknown;
}): GradePreset | null {
  const label = normalizeGradePresetLabel(input.label);
  if (!label || typeof input.id !== 'string') return null;
  return normalizeUserGradePresets([{
    id: input.id,
    label,
    grade: input.grade,
    shot: input.shot,
  }])[0] ?? null;
}

/**
 * Capture a clip's complete grade. Numeric fields are filled with their
 * defaults; neutral complex/effect stages are omitted so applying a captured
 * clean look still clears those stages on the target.
 */
export function gradeFromClip(clip: Clip): GradePresetGrade {
  const grade: ColorGrade = {
    brightness: clip.brightness ?? DEFAULT_COLOR_GRADE.brightness,
    contrast: clip.contrast ?? DEFAULT_COLOR_GRADE.contrast,
    saturation: clip.saturation ?? DEFAULT_COLOR_GRADE.saturation,
    hueRotation: clip.hueRotation ?? DEFAULT_COLOR_GRADE.hueRotation,
    exposure: clip.exposure ?? DEFAULT_COLOR_GRADE.exposure,
    temperature: clip.temperature ?? DEFAULT_COLOR_GRADE.temperature,
    tint: clip.tint ?? DEFAULT_COLOR_GRADE.tint,
    vibrance: clip.vibrance ?? DEFAULT_COLOR_GRADE.vibrance,
    highlights: clip.highlights ?? DEFAULT_COLOR_GRADE.highlights,
    shadows: clip.shadows ?? DEFAULT_COLOR_GRADE.shadows,
    blacks: clip.blacks ?? DEFAULT_COLOR_GRADE.blacks,
    whites: clip.whites ?? DEFAULT_COLOR_GRADE.whites,
    invertColors: clip.invertColors ?? DEFAULT_COLOR_GRADE.invertColors,
  };
  return {
    ...grade,
    ...sanitizeColorGrade({ curves: clip.curves, wheels: clip.wheels, hueCurves: clip.hueCurves, lut: clip.lut }),
    ...sanitizeClipEffects({ blurRadius: clip.blurRadius, vignette: clip.vignette, grain: clip.grain, glow: clip.glow }),
  };
}

/** Capture the clip's static shot fields in canvas-normalized units. */
export function shotFromClip(clip: Clip, canvas: ShotCanvasSize): ShotSettings | undefined {
  if (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width <= 0 || canvas.height <= 0) {
    return undefined;
  }
  const width = Number.isFinite(clip.width) && clip.width > 0 ? clip.width : Number.NaN;
  const height = Number.isFinite(clip.height) && clip.height > 0 ? clip.height : Number.NaN;
  return normalizeShotSettings({
    x: clip.x / canvas.width,
    y: clip.y / canvas.height,
    scaleX: clip.scaleX,
    scaleY: clip.scaleY,
    rotation: clip.rotation,
    anchorX: width > 0 ? clip.anchorX / width : Number.NaN,
    anchorY: height > 0 ? clip.anchorY / height : Number.NaN,
    opacity: clip.opacity,
    // A captured neutral crop is still carried so applying the complete shot
    // clears a target crop instead of inheriting the target's old one.
    crop: clip.crop ?? neutralShotCrop(),
  });
}

/** Capture both halves of a named preset from one clip. */
export function capturePresetFromClip(clip: Clip, canvas: ShotCanvasSize): CapturedPreset {
  const shot = shotFromClip(clip, canvas);
  return { grade: gradeFromClip(clip), ...(shot ? { shot } : {}) };
}

/** Sanitize a persisted grade into the sparse patch consumed by apply. */
export function gradePresetPatch(preset: GradePreset): GradePresetPatch {
  const grade = sanitizeColorGrade(preset.grade);
  const patch: Partial<ColorGrade> = {};
  for (const field of Object.keys(COLOR_GRADE_LIMITS) as Array<keyof typeof COLOR_GRADE_LIMITS>) {
    if (grade[field] !== undefined) patch[field] = grade[field];
  }
  if (grade.invertColors !== undefined) patch.invertColors = grade.invertColors;
  if (grade.curves) patch.curves = grade.curves;
  if (grade.wheels) patch.wheels = grade.wheels;
  if (grade.hueCurves) patch.hueCurves = grade.hueCurves;
  if (grade.lut) patch.lut = grade.lut;
  return { ...patch, ...sanitizeClipEffects(preset.grade) };
}

/**
 * Apply one named-look grade snapshot to a draft. Re-narrowing here makes
 * this safe even when a caller bypasses the persisted-list normalizer; an
 * omitted or invalid grade field is neutral rather than a raw value copied
 * into the project. This function intentionally does not touch geometry.
 */
export function applyGradePatch(draft: Clip, patch: GradePresetPatch): void {
  const grade = sanitizeColorGrade(patch);
  const effects = sanitizeClipEffects(patch);
  for (const field of Object.keys(COLOR_GRADE_LIMITS) as Array<keyof typeof COLOR_GRADE_LIMITS>) {
    if (grade[field] === undefined) delete draft[field];
    else draft[field] = grade[field];
  }
  if (grade.invertColors === true) draft.invertColors = true;
  else delete draft.invertColors;
  if (grade.curves) draft.curves = grade.curves;
  else delete draft.curves;
  if (grade.wheels) draft.wheels = grade.wheels;
  else delete draft.wheels;
  if (grade.hueCurves) draft.hueCurves = grade.hueCurves;
  else delete draft.hueCurves;
  if (grade.lut) draft.lut = grade.lut;
  else delete draft.lut;
  if (effects.blurRadius !== undefined) draft.blurRadius = effects.blurRadius;
  else delete draft.blurRadius;
  if (effects.vignette) draft.vignette = effects.vignette;
  else delete draft.vignette;
  if (effects.grain) draft.grain = effects.grain;
  else delete draft.grain;
  if (effects.glow) draft.glow = effects.glow;
  else delete draft.glow;
}

/**
 * Apply a static shot patch in target-canvas pixels. Only fields carried by
 * the shot are written, so partial presets leave the rest of the target
 * framing alone. Motion tracks are never touched: an active track continues
 * to override the static field in both preview and export.
 */
export function applyShotSettings(
  draft: Clip,
  input: unknown,
  canvas: ShotCanvasSize,
): void {
  const shot = normalizeShotSettings(input);
  if (!shot || !Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width <= 0 || canvas.height <= 0) {
    return;
  }
  if (shot.x !== undefined) draft.x = Math.round(shot.x * canvas.width);
  if (shot.y !== undefined) draft.y = Math.round(shot.y * canvas.height);
  if (shot.scaleX !== undefined) draft.scaleX = shot.scaleX;
  if (shot.scaleY !== undefined) draft.scaleY = shot.scaleY;
  if (shot.rotation !== undefined) draft.rotation = shot.rotation;
  const width = Number.isFinite(draft.width) && draft.width > 0 ? draft.width : 1;
  const height = Number.isFinite(draft.height) && draft.height > 0 ? draft.height : 1;
  if (shot.anchorX !== undefined) draft.anchorX = Math.round(shot.anchorX * width);
  if (shot.anchorY !== undefined) draft.anchorY = Math.round(shot.anchorY * height);
  if (shot.opacity !== undefined) draft.opacity = shot.opacity;
  if (shot.crop !== undefined) {
    if (shot.crop.left === 0 && shot.crop.right === 0 && shot.crop.top === 0 && shot.crop.bottom === 0) {
      delete draft.crop;
    } else {
      draft.crop = shot.crop;
    }
  }
}

/**
 * Relations a caller can explicitly opt into when applying a preset.
 *
 * - `linked` — the requested clips' link groups, the canonical A/V unit that
 *   every other multi-clip op auto-includes (`expandLinkedClipIds`).
 * - `syncLock` — the requested clips' own tracks plus every track that never
 *   opted out of sync lock (`track.syncLocked !== false`, the same predicate
 *   the ripple operations use), i.e. the tracks that move with them.
 */
export const GRADE_PRESET_PROPAGATE_MODES = ['linked', 'syncLock'] as const;

export type GradePresetPropagateMode = typeof GRADE_PRESET_PROPAGATE_MODES[number];

/**
 * Narrow one propagation argument. An unknown mode refuses the call instead of
 * degrading to "off": a dropped opt-in is a silent difference in what gets
 * written, and a wrong one is a silent overwrite of unrelated clips.
 */
export function parseGradePresetPropagateMode(
  input: unknown,
): { ok: true; mode: GradePresetPropagateMode } | { ok: false; error: string } {
  if (typeof input !== 'string' || !(GRADE_PRESET_PROPAGATE_MODES as readonly string[]).includes(input)) {
    return {
      ok: false,
      error: `Unknown propagate mode ${JSON.stringify(input) ?? 'undefined'}. Use 'linked' or 'syncLock', or omit propagate to grade only the requested clips.`,
    };
  }
  return { ok: true, mode: input as GradePresetPropagateMode };
}

/** The clips one apply touches: the requested ones plus whatever propagation covered. */
export interface GradePresetPropagationCover {
  /** Requested clips first, then covered related clips in timeline order. */
  clipIds: string[];
  /** The subset propagation added beyond the requested clips. */
  relatedClipIds: string[];
}

/**
 * Resolve the covered set for an explicitly opted-in apply, or refuse.
 *
 * `accepts` is the calling surface's own "this clip can take a grade" rule (the
 * Agent's video/image rule and the Inspector's decoded-media rule differ), so a
 * relative that surface cannot grade is left out of the covered set rather than
 * refusing: refusing would make `linked` fail on every clip carrying its own
 * audio, because the audio half of an A/V unit is exactly such a relative.
 *
 * What DOES refuse is a covered clip that cannot be written at all — a clip on
 * a locked track — because silently skipping it would hand back a half-applied
 * look. Refusal happens before any mutation, so the project is untouched.
 *
 * With no modes the cover is exactly the requested clips, which is why an
 * omitted opt-in is byte-identical to a single-clip apply.
 */
export function resolveGradePresetPropagation(
  controller: EditorController,
  clipIds: readonly string[],
  modes: readonly GradePresetPropagateMode[],
  accepts: (clip: Clip) => boolean,
): { ok: true; cover: GradePresetPropagationCover } | { ok: false; error: string } {
  const requested = [...new Set(clipIds)];
  if (modes.length === 0) return { ok: true, cover: { clipIds: requested, relatedClipIds: [] } };

  const clips = controller.getClips();
  const tracks = controller.getTracks();
  const requestedIds = new Set(requested);
  const covered = new Set(requested);

  if (modes.includes('linked')) {
    for (const clipId of controller.expandLinkedClipIds(requested, clips)) covered.add(clipId);
  }

  if (modes.includes('syncLock')) {
    const anchorTrackIds = new Set(
      clips.filter((clip) => requestedIds.has(clip.id)).map((clip) => clip.trackId),
    );
    const withAnchors = new Set(
      tracks
        .filter((track) => anchorTrackIds.has(track.id) || track.syncLocked !== false)
        .map((track) => track.id),
    );
    for (const clip of clips) {
      if (withAnchors.has(clip.trackId)) covered.add(clip.id);
    }
  }

  const related = clips.filter((clip) => covered.has(clip.id) && !requestedIds.has(clip.id) && accepts(clip));

  const lockedTrackNames = new Map(
    tracks.filter((track) => track.locked).map((track) => [track.id, track.name]),
  );
  for (const clip of related) {
    const locked = lockedTrackNames.get(clip.trackId);
    if (locked) {
      return { ok: false, error: `Cannot propagate to clip ${clip.id}: track "${locked}" is locked.` };
    }
  }

  const relatedClipIds = related.map((clip) => clip.id);
  return { ok: true, cover: { clipIds: [...requested, ...relatedClipIds], relatedClipIds } };
}

/**
 * Apply a preset's grade and optional shot as one undoable controller batch.
 * When `linkPreset` is true, record the preset ID in that same batch; false
 * clears an existing link. Omit the option to leave the link untouched for
 * direct renderer callers that only want the grade/shot snapshot.
 *
 * The batch runs inside a controller transaction, so a propagated cover stays a
 * single undo step even if it ever spans more than one controller command, and
 * a failure part-way restores the pre-apply project instead of publishing a
 * fragment. A batch that collects exactly one command is published unchanged,
 * so the single-clip path keeps its own history label.
 */
export function applyGradePresetTo(
  controller: EditorController,
  clipIds: string[],
  preset: GradePreset,
  linkPreset?: boolean,
): ReturnType<EditorController['applyClipProperties']> {
  const patch = gradePresetPatch(preset);
  const shot = normalizeShotSettings(preset.shot);
  const canvas = controller.getProject().settings;
  const linkId = normalizeGradePresetId(preset.id);
  const label = `Grade: ${preset.label}`;
  return controller.transaction(label, () => controller.applyClipProperties(clipIds, label, (draft) => {
    applyGradePatch(draft, patch);
    if (shot) applyShotSettings(draft, shot, canvas);
    if (linkPreset === true) {
      if (linkId) draft.gradePresetId = linkId;
      else delete draft.gradePresetId;
    } else if (linkPreset === false) {
      delete draft.gradePresetId;
    }
    return true;
  }));
}
