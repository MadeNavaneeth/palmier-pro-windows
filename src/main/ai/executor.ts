/**
 * Tool Executor — runs tool calls against the EditorController.
 * Shared by both the in-app agent and the MCP server.
 */

import { z } from 'zod';
import { execFile } from 'child_process';
import fsSync from 'fs';
import fs from 'fs/promises';
import { writeProjectFile } from '../services/project-writer';
import os from 'os';
import path from 'path';
import { nanoid } from 'nanoid';
import { tools, getToolByName, MAX_REFERENCE_IMAGE_BYTES, REFERENCE_IMAGE_EXTENSIONS } from './tools';
import { defaultSkillsDir, loadSkillBody } from './skills';
import { clampFrame } from '../../shared/utils/safe-number';
import type { TrimEdge } from '../../shared/editor/controller';
import { detectSilenceForFile } from '../media/audio-envelope';
import { loadSilenceSettings } from '../media/silence-settings';
import { probeMedia } from '../media/probe';
import { secondsToProjectFrames } from '../../shared/media/source-time';
import {
  configuredProvidersFor,
  listGenerationProviders,
  runGeneration,
} from '../generation/manager';
import type { GenerationType } from '../generation/types';

/** Bounded wait for a provider render; video gens can be minutes. */
const GENERATION_TIMEOUT_MS = 600_000;
import { resolveSilenceConfig, type SilenceConfig, type SilentRange } from '../../shared/audio/silence-detector';
import {
  mapSilenceRangesToTimeline,
  resolveSilenceScope,
  type OmittedSilenceRange,
  type SilenceScopeResolution,
  type SilenceTrackScope,
} from '../../shared/editor/silence-scoping';
import { mergeRippleRanges, type RippleRange } from '../../shared/editor/ripple';
import { diffMarkers } from '../../shared/editor/markers';
import { sanitizeCrop } from '../../shared/media/source-crop';
import { sanitizeMotion } from '../../shared/media/motion';
import {
  SHAPE_ANIMATION_PRESETS,
  sanitizeShapeFillColor,
  sanitizeShapeKind,
  sanitizeShapeStrokeColor,
  sanitizeShapeStrokeWidth,
  shapePresetMotion,
  type ShapeAnimationPreset,
} from '../../shared/editor/shape';
import { mergeChromaKey } from '../../shared/editor/chroma-key';
import {
  sanitizeTitleText,
  sanitizeTitleVariationItal,
  sanitizeTitleVariationSlnt,
  sanitizeTitleVariationWdth,
  sanitizeTitleVariationWght,
} from '../../shared/editor/title';
import {
  applyGradePresetTo,
  capturePresetFromClip,
  parseGradePresetPropagateMode,
  resolveGradePresetPropagation,
  type GradePresetPropagateMode,
} from '../../shared/editor/grade-preset-store';
import {
  getGradePresetRepository,
  type GradePresetRepository,
} from '../grade-preset-repository';
import {
  gradeCurvesEqual,
  gradeWheelsEqual,
  hasColorGrade,
  hueCurvesEqual,
  isIdentityGradeCurve,
  isIdentityGradeWheels,
  isIdentityHueCurves,
  parseGradeCurvePatch,
  parseGradeWheelsPatch,
  parseHueCurvesPatch,
  sanitizeColorGrade,
  sanitizeGradeCurve,
  sanitizeGradeWheels,
  sanitizeHueCurves,
  type GradeCurve,
  type GradeCurvePatch,
  type GradeWheels,
  type GradeWheelsPatch,
  type HueCurves,
  type HueCurvesPatch,
} from '../../shared/editor/color-grade';
import { lutRefsEqual, sanitizeLutRef, type LutRef } from '../../shared/editor/lut';
import {
  DEFAULT_GLOW,
  DEFAULT_GRAIN,
  DEFAULT_VIGNETTE,
  EFFECT_LIMITS,
  glowsEqual,
  grainsEqual,
  hasEffects,
  parseGlowPatch,
  parseGrainPatch,
  parseVignettePatch,
  sanitizeBlurRadius,
  sanitizeGlow,
  sanitizeGrain,
  sanitizeVignette,
  vignettesEqual,
  type GlowPatch,
  type GrainPatch,
  type VignettePatch,
} from '../../shared/editor/effects';
import { sanitizeEq } from '../../shared/audio/eq';
import { hasCompressor, mergeCompressor, normalizeCompressor } from '../../shared/audio/compressor';
import { noiseReductionOf } from '../../shared/audio/denoise';
import { diagnoseTimeline } from '../../shared/editor/diagnostics';
import { folderAssetCount } from '../../shared/media/folders';
import { normalizePlan, planSummary, type PlanStep } from '../../shared/editor/plan';
import { sanitizeVolumeKeyframes } from '../../shared/audio/volume-keyframes';
import { normalizeCaptionPlanOptions, planCaptions } from '../../shared/captions/planner';
import { applyCaptionCues } from '../../shared/captions/apply';
import type { TranscriptionResult } from './transcribe';
import {
  DEFAULT_LOCAL_MODEL,
  isKnownLocalModel,
  normalizeSttEngine,
  probeLocalBinary,
  resolveLocalSttPaths,
  resolveSttEngine,
  runLocalTranscription as runWhisperLocal,
} from '../media/whisper-local';
import { parseFcpxml } from '../../shared/fcpxml/importer';
import { exportFcpxmlWithReport } from '../../shared/fcpxml/exporter';
import { applyImportedAdjustments, applyImportedTitleStyle, degenerateRateRefusal, frameRescaler } from '../../shared/fcpxml/apply';
import { createHash } from 'crypto';
import { validateLutFile } from '../media/lut-loader';
import { inspectFramePath, rgbaToPng } from '../media/frame-png';
import {
  MAX_CANVAS_EDGE,
  aspectRatioLabel,
  findQualityPreset,
  parseAspectRatio,
  resolutionForAspectRatio,
  resolutionForQuality,
} from '../../shared/project/aspect-ratio';
import { createEmptyProject } from '../../shared/types/project';
import type { ProjectSettings } from '../../shared/types/project';
import type { ExportEventSink, ExportOptions } from '../media/exporter';
import { EditorController } from '../../shared/editor/controller';

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Omitted detected spans grouped by reason, or null when none were omitted. */
function omissionCounts(
  omitted: readonly OmittedSilenceRange[],
): Record<OmittedSilenceRange['reason'], number> | null {
  if (omitted.length === 0) return null;
  const counts = { 'outside-clip': 0, 'invalid-range': 0 } as Record<
    OmittedSilenceRange['reason'],
    number
  >;
  for (const span of omitted) counts[span.reason] += 1;
  return counts;
}

/**
 * A receipt note for detected spans that produced no cut.
 *
 * A span with no overlap in a clip is omitted rather than clamped to the
 * nearest edge, because clamping would cut audio the detector never called
 * silent. That decision is only honest if it is reported: without this note the
 * receipt reads as an absence of silence in audio that has some.
 */
function omissionNote(
  removedSomething: boolean,
  counts: Record<OmittedSilenceRange['reason'], number>,
): string {
  const total = counts['outside-clip'] + counts['invalid-range'];
  const why = [
    ...(counts['outside-clip'] > 0 ? [`${counts['outside-clip']} outside any clip's trimmed window`] : []),
    ...(counts['invalid-range'] > 0 ? [`${counts['invalid-range']} with invalid timings`] : []),
  ].join(', ');
  const spans = `silent span${total === 1 ? '' : 's'}`;
  return removedSomething
    ? `${total} detected ${spans} produced no cut: ${why}.`
    : `The detector found ${total} ${spans}, but ${why} — nothing was removed.`;
}

/**
 * Turn `set_project_settings` arguments into concrete fps/width/height
 * (upstream PR #417's `validateProjectSettings` + `resolve(for:)`).
 *
 * The rules, all of which are refusals rather than silent corrections:
 *
 *   - at least one field must be present;
 *   - width and height only arrive together;
 *   - explicit dimensions cannot be mixed with aspectRatio or quality, since
 *     that would make the resulting canvas ambiguous;
 *   - aspectRatio preserves the current short edge unless quality overrides it.
 *
 * Exported so the contract is testable without an agent transport.
 */
export function resolveProjectSettings(
  args: {
    fps?: number;
    width?: number;
    height?: number;
    aspectRatio?: string;
    quality?: string;
  },
  current: ProjectSettings,
): { fps?: number; width?: number; height?: number } {
  const hasWidth = args.width !== undefined;
  const hasHeight = args.height !== undefined;

  if (
    args.fps === undefined
    && !hasWidth
    && !hasHeight
    && args.aspectRatio === undefined
    && args.quality === undefined
  ) {
    throw new Error('Provide at least one of: fps, width, height, aspectRatio, quality');
  }
  if (hasWidth !== hasHeight) {
    throw new Error('Provide both width and height');
  }
  if (hasWidth && (args.aspectRatio !== undefined || args.quality !== undefined)) {
    throw new Error("Explicit dimensions can't be combined with aspectRatio or quality");
  }

  const quality = args.quality === undefined ? undefined : findQualityPreset(args.quality);
  if (args.quality !== undefined && !quality) {
    throw new Error(`Unknown quality '${args.quality}'.`);
  }

  let size = { width: args.width ?? current.width, height: args.height ?? current.height };
  if (args.aspectRatio !== undefined) {
    // parseAspectRatio / resolutionForAspectRatio raise AspectRatioError with a
    // user-facing message; let it surface unchanged.
    size = resolutionForAspectRatio(
      parseAspectRatio(args.aspectRatio),
      quality?.shortEdge ?? Math.min(current.width, current.height),
    );
  } else if (quality) {
    size = resolutionForQuality(quality, size);
  }

  const changesResolution = hasWidth || args.aspectRatio !== undefined || quality !== undefined;
  if (
    size.width < 1
    || size.height < 1
    || (changesResolution && (size.width > MAX_CANVAS_EDGE || size.height > MAX_CANVAS_EDGE))
  ) {
    throw new Error(
      `Resolution must be positive and no larger than ${MAX_CANVAS_EDGE} pixels on either edge`,
    );
  }

  return {
    ...(args.fps === undefined ? {} : { fps: args.fps }),
    // Leave the resolution untouched when nothing asked to change it, so an
    // fps-only edit preserves an oversized legacy canvas.
    ...(changesResolution ? { width: size.width, height: size.height } : {}),
  };
}

/** A validated reference image, or the exact reason the call is refused. */
export type ReferenceImageCheck = { ok: true; path: string } | { ok: false; error: string };

/**
 * Boundary check for `generate_media`'s reference image.
 *
 * The path is untrusted input from a model or an MCP client, so every fact is
 * established here, before a provider is contacted and before the project is
 * touched: which model it is aimed at, that the path is absolute, that it is a
 * readable file of a supported image type, and that it is within the size cap.
 * Every refusal names its reason, mirroring the LUT-path contract, so a bad
 * reference costs no provider call instead of silently degrading the result.
 *
 * A reference is only accepted for image generation: the fal.ai and Replicate
 * adapters put it in the image input their image models read. Their video
 * models take a first frame under a different parameter, and Higgs Field is
 * video-only with a hosted-URL parameter, so a reference there would be
 * dropped or rejected rather than shape the result. Refused, not ignored.
 * Exported so the contract is testable without a generation transport.
 */
export function validateReferenceImage(
  raw: string,
  target: { type: GenerationType; providerName: string; model: string },
): ReferenceImageCheck {
  if (target.type !== 'image') {
    return {
      ok: false,
      error: `${target.providerName} ${target.model} is a ${target.type} model and reads no reference image, so it would be ignored. Drop referenceImagePath, or generate the image first and place it on the timeline with add_clip.`,
    };
  }

  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (candidate.length === 0) {
    return { ok: false, error: 'referenceImagePath is empty.' };
  }
  if (!path.isAbsolute(candidate)) {
    return { ok: false, error: `referenceImagePath must be an absolute path (got "${candidate}").` };
  }

  let stats: fsSync.Stats;
  try {
    stats = fsSync.statSync(candidate);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { ok: false, error: `Reference image not found: ${candidate}` };
    return {
      ok: false,
      error: `Reference image could not be read: ${candidate} (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  if (!stats.isFile()) return { ok: false, error: `Reference image is not a file: ${candidate}` };

  const extension = path.extname(candidate).toLowerCase();
  if (!REFERENCE_IMAGE_EXTENSIONS.includes(extension)) {
    return {
      ok: false,
      error: `Reference image must be one of ${REFERENCE_IMAGE_EXTENSIONS.join(', ')} (got "${extension || candidate}").`,
    };
  }

  if (stats.size === 0) return { ok: false, error: `Reference image is empty: ${candidate}` };
  if (stats.size > MAX_REFERENCE_IMAGE_BYTES) {
    const mib = (bytes: number): string => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
    return {
      ok: false,
      error: `Reference image is ${mib(stats.size)}; the cap is ${mib(MAX_REFERENCE_IMAGE_BYTES)}: ${candidate}`,
    };
  }

  return { ok: true, path: candidate };
}

/** Injected capability seams — Electron-bound defaults live in ./ipc. */
export interface ToolExecutorDeps {
  /**
   * OpenAI-compatible runtime (baseUrl + decrypted key) for audio
   * transcription. Null = no usable provider configured.
   */
  getTranscriptionRuntime?: () => Promise<{ baseUrl: string; apiKey: string } | null>;
  /**
   * Desktop app-data directory for the local whisper.cpp engine (#39).
   * Null = local transcription unavailable (tests, non-Electron hosts).
   * Defaults to Electron userData in the main process.
   */
  getLocalSttDir?: () => Promise<string | null> | string | null;
  /**
   * Local transcription runner. Defaults to the real whisper.cpp runner;
   * tests inject a stub so `transcribe_audio` is covered without a binary.
   */
  runLocalTranscription?: (input: {
    audioPath: string;
    language?: string;
    modelId: string;
  }) => Promise<TranscriptionResult>;
  /**
   * Vision runtime for `describe_media` (BYOK; Anthropic or
   * OpenAI-compatible). Null = no usable vision provider configured.
   * Tests inject a stub so no network is needed.
   */
  getVisionRuntime?: () => Promise<{
    kind: 'anthropic' | 'openai-compatible';
    baseUrl?: string;
    apiKey: string;
    model: string;
    providerId?: string;
  } | null>;
  /**
   * Vision transport stub. Defaults to the real `./describe` module;
   * tests inject a fake so `describe_media` is covered without network.
   */
  describeImage?: (
    runtime: {
      kind: 'anthropic' | 'openai-compatible';
      baseUrl?: string;
      apiKey: string;
      model: string;
      providerId?: string;
    },
    imagePath: string,
  ) => Promise<{ description: string; model: string; provider: string }>;
  /**
   * FFmpeg export runner. Defaults to the real exporter (`media/exporter`);
   * tests inject a fake so `export_project` is covered without encoding.
   */
  runExport?: (
    project: ReturnType<EditorController['getProject']>,
    options: ExportOptions,
    sink: ExportEventSink,
  ) => Promise<void>;
  /**
   * Session plan updates (L3). The plan is UI state, so the executor reports
   * it outward instead of storing it anywhere near the project.
   */
  onPlanUpdate?: (plan: PlanStep[]) => void;
  /**
   * Skills root for `load_skill` (Track 2, L7). Defaults to the bundled
   * `skills/` directory; tests inject a fixture root.
   */
  skillsDir?: string;
  /** App-wide named preset repository shared by IPC, Agent, and MCP. */
  gradePresets?: GradePresetRepository;
}

/**
 * Electron userData for the local STT engine. Electron-absent hosts (unit
 * tests) resolve null so the resolver treats local as unavailable.
 */
async function defaultLocalSttDir(): Promise<string | null> {
  try {
    const { app } = await import('electron');
    const dir = (app as { getPath?: (name: string) => string } | undefined)?.getPath?.('userData');
    return typeof dir === 'string' && dir.length > 0 ? dir : null;
  } catch {
    return null;
  }
}

export class ToolExecutor {
  private deps: ToolExecutorDeps;
  private gradePresets: GradePresetRepository;
  constructor(private editor: EditorController, deps: ToolExecutorDeps = {}) {
    this.deps = deps;
    this.gradePresets = deps.gradePresets ?? getGradePresetRepository();
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = getToolByName(toolName);
    if (!tool) {
      return { success: false, error: `Unknown tool: ${toolName}` };
    }

    // Validate args against schema
    try {
      const validated = tool.parameters.parse(args);
      return await this.dispatch(toolName, validated);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        return { success: false, error: `Validation error: ${err.errors.map((e) => e.message).join(', ')}` };
      }
      return { success: false, error: err.message };
    }
  }

  /**
   * trim_clips — batch edge trims by absolute project frames, optionally
   * rippling, as one undoable action (upstream `upstream/trim-clips`
   * 46b297e). Validation runs against the current state before any mutation,
   * so a refused call changes nothing; the edits then execute through the
   * same trimClipEdge domain operation the UI drag uses, inside one
   * controller transaction so the whole batch is a single undo step. Because
   * each edit reads live state, an earlier extend that overwrites a later
   * edit's clip is reported and skipped rather than corrupting the timeline.
   */
  private trimClips(args: {
    edits: { clipId: string; startFrame?: number; endFrame?: number }[];
    ripple?: boolean;
  }): ToolResult {
    const ripple = args.ripple === true;

    interface PlannedEdge {
      path: string;
      clipId: string;
      edge: TrimEdge;
      delta: number;
      requestedDurationDelta: number;
      requestedFrame: number;
      edgeName: 'start' | 'end';
    }

    // Pass 1 — validate and plan without mutating, so any refusal leaves the
    // timeline exactly as it was.
    const edgeEdits: PlannedEdge[] = [];
    const claimed = new Set<string>();
    for (const [idx, edit] of args.edits.entries()) {
      const path = `edits[${idx}]`;
      if (edit.startFrame === undefined && edit.endFrame === undefined) {
        return { success: false, error: `${path}: at least one of 'startFrame' or 'endFrame' is required.` };
      }
      const clip = this.editor.getClips().find((c) => c.id === edit.clipId);
      if (!clip) {
        return { success: false, error: `${path}: clip not found: ${edit.clipId}` };
      }

      const currentEnd = clip.startFrame + clip.durationFrames;
      const newStart = edit.startFrame ?? clip.startFrame;
      const newEnd = edit.endFrame ?? currentEnd;
      if (newEnd <= newStart) {
        return {
          success: false,
          error: `${path}: resulting duration must be at least 1 frame (start ${newStart}, end ${newEnd}).`,
        };
      }

      // Plan the end edge first so both edges of one clip carry correct
      // deltas regardless of order.
      const clipEdges: PlannedEdge[] = [];
      if (edit.endFrame !== undefined && edit.endFrame !== currentEnd) {
        clipEdges.push({
          path,
          clipId: clip.id,
          edge: 'right',
          delta: edit.endFrame - currentEnd,
          requestedDurationDelta: edit.endFrame - currentEnd,
          requestedFrame: edit.endFrame,
          edgeName: 'end',
        });
      }
      if (edit.startFrame !== undefined && edit.startFrame !== clip.startFrame) {
        clipEdges.push({
          path,
          clipId: clip.id,
          edge: 'left',
          delta: edit.startFrame - clip.startFrame,
          requestedDurationDelta: -(edit.startFrame - clip.startFrame),
          requestedFrame: edit.startFrame,
          edgeName: 'start',
        });
      }

      // A clip, its linked partners, and (in ripple mode) everything that
      // would shift with it may appear in at most one edit.
      const group = new Set(this.editor.expandLinkedClipIds([clip.id]));
      for (const id of group) {
        if (claimed.has(id)) {
          return {
            success: false,
            error: `${path}: clip ${edit.clipId} overlaps an earlier edit — the same clip or a linked partner that trims together.`,
          };
        }
      }
      for (const id of group) claimed.add(id);
      edgeEdits.push(...clipEdges);
    }

    const notes: string[] = [];
    if (edgeEdits.length === 0) {
      notes.push('No change: every requested edge matches the clip\u2019s current frames.');
      return { success: true, data: { touched: args.edits.map((edit) => edit.clipId), notes } };
    }

    // Pass 2 — execute. Every trim goes through the shared undoable domain
    // operation, and the whole batch runs inside one transaction so it lands as
    // a single undo step by construction rather than by counting entries.
    // Marker spans are snapshotted up front so the receipt reports the net
    // marker delta of the whole batch (upstream #560) instead of per-edge
    // fragments.
    const markersBefore = this.editor.getMarkers();
    this.editor.transaction('Trim clips (Agent)', () => {
      for (const planned of edgeEdits) {
        const live = this.editor.getClips().find((c) => c.id === planned.clipId);
        if (!live) {
          notes.push(`${planned.path}: clip was removed when an earlier edit extended over it — this trim was skipped.`);
          continue;
        }
        const report = this.editor.trimClipEdge(planned.clipId, planned.edge, planned.delta, ripple);
        if (!report) {
          notes.push(
            `${planned.path}: ${planned.edgeName} edge could not move ${planned.delta > 0 ? '+' : ''}${planned.delta} frames (no headroom, or a linked clip sits on a locked track) — skipped.`,
          );
          continue;
        }
        if (report.durationDelta !== planned.requestedDurationDelta) {
          notes.push(
            `${planned.path}: ${planned.edgeName} edge clamped to ${Math.abs(report.durationDelta)} of the requested ${Math.abs(planned.requestedDurationDelta)} frames.`,
          );
        }

        // ripple=false contract (upstream): extending overwrites whatever the
        // new span overlaps on that track — through the same span-clearing the
        // overwrite-placement mode uses, so partially overlapped neighbors are
        // split and the covered middle dropped with source mapping intact.
        if (!ripple && planned.edge === 'right') {
          const lead = this.editor.getClips().find((c) => c.id === planned.clipId);
          if (lead) {
            const overwrite = this.editor.overwriteClearSpan(
              { start: lead.startFrame + 1, end: lead.startFrame + lead.durationFrames },
              this.editor.expandLinkedClipIds([planned.clipId]),
            );
            if (overwrite === null) {
              notes.push(
                `${planned.path}: the extended span overlaps a locked track — covered clips were left in place.`,
              );
            } else {
              if (overwrite.removedClipIds.length > 0) {
                notes.push(
                  `${planned.path}: extending the end edge overwrote ${overwrite.removedClipIds.join(', ')} (fully covered).`,
                );
              }
              if (overwrite.trimmedClipIds.length > 0) {
                notes.push(
                  `${planned.path}: extending the end edge trimmed covered parts of ${overwrite.trimmedClipIds.join(', ')}.`,
                );
              }
            }
          }
        }
      }
    });

    // Receipt: report where every edge actually landed so the caller verifies
    // against the result instead of assuming the requested frames held, plus
    // the net marker delta so review notes can be patched without re-reading
    // the timeline (upstream #560).
    const markerDelta = diffMarkers(markersBefore, this.editor.getMarkers());
    if (!ripple) {
      for (const planned of edgeEdits) {
        const clip = this.editor.getClips().find((c) => c.id === planned.clipId);
        if (!clip) continue;
        const landed = planned.edge === 'left' ? clip.startFrame : clip.startFrame + clip.durationFrames;
        if (landed !== planned.requestedFrame) {
          notes.push(
            `${planned.path}: ${planned.edgeName} edge landed at frame ${landed}, not the requested ${planned.requestedFrame} (source bounds or an overwrite from an earlier edit).`,
          );
        }
      }
    }

    return {
      success: true,
      data: {
        touched: args.edits.map((edit) => edit.clipId),
        notes,
        shiftedMarkers: markerDelta.shiftedMarkers,
        removedMarkerIds: markerDelta.removedMarkerIds,
      },
    };
  }

  private async dispatch(name: string, args: any): Promise<ToolResult> {
    switch (name) {
      // ── Read operations ───────────────────────────────────────────────────
      case 'get_timeline': {
        // The tool contract promises project settings alongside the timeline, and
        // set_project_settings is only useful if the agent can read the canvas
        // back (upstream #417).
        const project = this.editor.getProject();
        // Explicit scope only: an omitted scopeTimelineId reads the main
        // timeline (exactly today's behavior), never the UI's open nest.
        let timeline = project.timeline;
        let scopeTimelineId: string | null = null;
        if (args.scopeTimelineId !== undefined) {
          try {
            timeline = this.editor.getTimelineInScope(args.scopeTimelineId);
            scopeTimelineId = args.scopeTimelineId;
          } catch (err) {
            return {
              success: false,
              error: err instanceof Error ? err.message : 'Scope lookup failed.',
            };
          }
        }
        const nested = project.timelines ?? {};
        return {
          success: true,
          data: {
            ...timeline,
            settings: project.settings,
            width: project.settings.width,
            height: project.settings.height,
            fps: project.settings.fps,
            aspectRatio: aspectRatioLabel(project.settings.width, project.settings.height),
            scopeTimelineId,
            ...(Object.keys(nested).length > 0
              ? {
                timelines: Object.entries(nested).map(([id, nestedTimeline]) => ({
                  id,
                  name: nestedTimeline.name ?? 'Nested sequence',
                  clipCount: nestedTimeline.clips.length,
                })),
              }
              : {}),
          },
        };
      }

      case 'get_clips': {
        // Explicit scope only, like get_timeline: omitted means the main
        // timeline even if the UI has a nest open elsewhere.
        let scoped;
        try {
          scoped = this.editor.getTimelineInScope(args.scopeTimelineId ?? null);
        } catch {
          return { success: false, error: `Nested timeline "${args.scopeTimelineId}" no longer exists.` };
        }
        let clips = [...scoped.clips];
        if (args.trackId) {
          clips = clips.filter((c) => c.trackId === args.trackId);
        }
        return { success: true, data: clips };
      }

      case 'get_media':
        return { success: true, data: this.editor.getMedia() };

      case 'list_grade_presets':
        return { success: true, data: { presets: this.gradePresets.list() } };

      case 'update_plan': {
        const steps = normalizePlan(args.steps);
        // Reported to the session, never persisted: no project change, no
        // undo entry, and an empty plan is a valid "clear".
        this.deps.onPlanUpdate?.(steps);
        return {
          success: true,
          data: { steps, summary: planSummary(steps), count: steps.length },
        };
      }

      case 'load_skill': {
        // L7: advisory text only. The body is returned as data; nothing in it
        // is interpreted, dispatched, or executed — a skill cannot invoke
        // tools or mutate state by itself. No project access, no undo entry.
        const loaded = loadSkillBody(this.deps.skillsDir ?? defaultSkillsDir(), args.name);
        if (!loaded.ok) return { success: false, error: loaded.reason };
        return {
          success: true,
          data: {
            name: loaded.skill.name,
            description: loaded.skill.description,
            body: loaded.skill.body,
          },
        };
      }

      case 'verify_timeline': {
        const project = this.editor.getProject();
        // The audit is pure; the executor supplies the one fact it cannot
        // know, whether each library file is still on disk.
        const offlinePaths = new Set(
          project.media
            .filter((asset) => !fsSync.existsSync(asset.path))
            .map((asset) => asset.path),
        );
        const issues = diagnoseTimeline(project, {
          offlinePaths,
          maxIssues: typeof args.limit === 'number' ? args.limit : 50,
        });
        return {
          success: true,
          data: {
            issues,
            errorCount: issues.filter((issue) => issue.severity === 'error').length,
            warningCount: issues.filter((issue) => issue.severity === 'warning').length,
            checked: {
              clips: project.timeline.clips.length,
              markers: (project.timeline.markers ?? []).length,
              media: project.media.length,
            },
          },
        };
      }

      case 'manage_clip_links': {
        try {
          const receipt = args.action === 'link'
            ? this.editor.linkClips(args.clipIds)
            : this.editor.unlinkClips(args.clipIds);
          return { success: true, data: receipt };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Link operation failed.',
          };
        }
      }

      case 'swap_clip_media': {
        try {
          const receipt = this.editor.swapClipMedia(args.clipId, args.assetId);
          return { success: true, data: receipt };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Media swap failed.',
          };
        }
      }

      case 'normalize_audio': {
        try {
          const clip = this.editor.getClips().find((c) => c.id === args.clipId);
          if (!clip) return { success: false, error: `Clip not found: ${args.clipId}` };
          if (clip.type !== 'audio') {
            return { success: false, error: 'Only audio clips can be normalized.' };
          }
          const asset = this.editor.getMedia().find((m) => m.id === clip.assetId);
          if (!asset) return { success: false, error: `Source asset not found for clip.` };

          // Analyze via the same FFmpeg volumedetect used by the UI.
          const analysis = await new Promise<{ success: boolean; maxVolumeDb?: number; error?: string }>((resolve) => {
            execFile('ffmpeg', ['-i', asset.path, '-af', 'volumedetect', '-f', 'null', '-'],
              (err: unknown, _stdout: unknown, stderr: unknown) => {
                const output = typeof stderr === 'string' ? stderr : '';
                const match = output.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
                if (err && !match) {
                  resolve({ success: false, error: 'Volume analysis failed.' });
                } else if (!match) {
                  resolve({ success: false, error: 'No audio stream detected.' });
                } else {
                  resolve({ success: true, maxVolumeDb: parseFloat(match[1]) });
                }
              });
          });
          if (!analysis.success) return analysis;

          const targetDb = args.targetDb ?? -3;
          const currentPeak = (analysis as { maxVolumeDb: number }).maxVolumeDb;
          const delta = targetDb - currentPeak;
          const gainLinear = Math.min(16, Math.max(0, Math.pow(10, delta / 20)));
          const newVolume = Math.min(1, Math.max(0, (clip.volume ?? 1) * gainLinear));

          const receipt = this.editor.applyClipProperties(
            [args.clipId],
            `Normalize to ${targetDb} dBFS`,
            (draft) => {
              draft.volume = newVolume;
              return true;
            },
          );
          return {
            success: true,
            data: {
              normalized: args.clipId,
              peakBeforeDb: currentPeak,
              targetDb,
              volumeApplied: newVolume,
              changedClipIds: receipt.changedClipIds,
            },
          };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Normalization failed.',
          };
        }
      }

      case 'set_clip_speed': {
        try {
          const ok = this.editor.setClipSpeed(args.clipId, args.speed);
          return ok
            ? { success: true, data: { clipId: args.clipId, speed: args.speed } }
            : { success: false, error: 'Clip not found, is audio/title (visual clips only), or speed is out of range.' };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Speed change failed.',
          };
        }
      }

      case 'add_texts': {
        try {
          const results: Array<{ clipId: string; text: string }> = [];
          const errors: string[] = [];
          for (const entry of args.entries) {
            const clipId = this.editor.addTitleClip({
              trackId: entry.trackId,
              startFrame: entry.startFrame,
              durationFrames: entry.durationFrames,
              text: entry.text,
            });
            if (!clipId) {
              errors.push(`entries[${results.length}]: could not place title on track "${entry.trackId}".`);
              continue;
            }
            const styleFields = [
              entry.fontSize !== undefined, entry.color !== undefined,
              entry.bold !== undefined, entry.fontFamily !== undefined,
              entry.align !== undefined, entry.backgroundColor !== undefined,
              entry.backgroundPadding !== undefined, entry.lineSpacing !== undefined,
              entry.fontCase !== undefined, entry.fillMode !== undefined,
              entry.blurRadius !== undefined, entry.tiltX !== undefined,
              entry.tiltY !== undefined,
              entry.variationWght !== undefined, entry.variationWdth !== undefined,
              entry.variationSlnt !== undefined, entry.variationItal !== undefined,
            ];
            if (styleFields.some(Boolean)) {
              this.editor.applyClipProperties([clipId], 'Style title', (draft) => {
                if (entry.fontSize !== undefined) {
                  draft.titleSizeRatio = entry.fontSize / this.editor.getProject().settings.height;
                }
                if (entry.color !== undefined) draft.titleColor = entry.color;
                if (entry.bold !== undefined) draft.titleBold = entry.bold;
                if (entry.fontFamily !== undefined) draft.titleFontFamily = entry.fontFamily;
                if (entry.align !== undefined) {
                  draft.titleAlign = entry.align as 'left' | 'center' | 'right';
                }
                if (entry.backgroundColor !== undefined) {
                  draft.titleBackgroundColor = entry.backgroundColor;
                }
                if (entry.backgroundPadding !== undefined) {
                  draft.titleBackgroundPadding = entry.backgroundPadding;
                }
                if (entry.lineSpacing !== undefined) draft.titleLineSpacing = entry.lineSpacing;
                if (entry.fontCase !== undefined) draft.titleFontCase = entry.fontCase;
                // Absent stays solid; there is no explicit color entry here.
                if (entry.fillMode !== undefined) draft.titleFillMode = entry.fillMode;
                if (entry.blurRadius !== undefined) {
                  // 0 clears rather than storing a no-op radius.
                  if (entry.blurRadius === 0) delete draft.titleBlurRadius;
                  else draft.titleBlurRadius = entry.blurRadius;
                }
                if (entry.tiltX !== undefined) {
                  if (entry.tiltX === 0) delete draft.titleTiltXDeg;
                  else draft.titleTiltXDeg = entry.tiltX;
                }
                if (entry.tiltY !== undefined) {
                  if (entry.tiltY === 0) delete draft.titleTiltYDeg;
                  else draft.titleTiltYDeg = entry.tiltY;
                }
                // Variable-font axes (#50): sanitize maps defaults (400/100/
                // 0/0) to undefined, so a default clears like blur/tilt zeros.
                if (entry.variationWght !== undefined) {
                  const clean = sanitizeTitleVariationWght(entry.variationWght);
                  if (clean === undefined) delete draft.titleVariationWght;
                  else draft.titleVariationWght = clean;
                }
                if (entry.variationWdth !== undefined) {
                  const clean = sanitizeTitleVariationWdth(entry.variationWdth);
                  if (clean === undefined) delete draft.titleVariationWdth;
                  else draft.titleVariationWdth = clean;
                }
                if (entry.variationSlnt !== undefined) {
                  const clean = sanitizeTitleVariationSlnt(entry.variationSlnt);
                  if (clean === undefined) delete draft.titleVariationSlnt;
                  else draft.titleVariationSlnt = clean;
                }
                if (entry.variationItal !== undefined) {
                  const clean = sanitizeTitleVariationItal(entry.variationItal);
                  if (clean === undefined) delete draft.titleVariationItal;
                  else draft.titleVariationItal = clean;
                }
                return true;
              });
            }
            results.push({ clipId, text: entry.text });
          }
          if (errors.length > 0 && results.length === 0) {
            return { success: false, error: errors[0] };
          }
          return { success: true, data: { added: results, errors } };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Title creation failed.',
          };
        }
      }

      case 'import_srt': {
        const track = this.editor.getTracks().find((t) => t.id === args.trackId);
        if (!track) {
          return { success: false, error: `No track "${args.trackId}" on this timeline.` };
        }
        if (track.type !== 'video') {
          return { success: false, error: 'SRT import requires a video track.' };
        }
        if (track.locked) {
          return { success: false, error: `Track "${track.name}" is locked.` };
        }
        const ids = this.editor.importSrt(
          args.trackId,
          args.srtContent,
          args.startFrame,
        );
        if (ids.length === 0) {
          return { success: false, error: 'No usable subtitles found in that SRT content.' };
        }
        return { success: true, data: { importedClipIds: ids, count: ids.length } };
      }

      case 'import_vtt': {
        const vt = this.editor.getTracks().find((t) => t.id === args.trackId);
        if (!vt) {
          return { success: false, error: `No track "${args.trackId}" on this timeline.` };
        }
        if (vt.type !== 'video') {
          return { success: false, error: 'VTT import requires a video track.' };
        }
        if (vt.locked) {
          return { success: false, error: `Track "${vt.name}" is locked.` };
        }
        const vttIds = this.editor.importVtt(
          args.trackId,
          args.vttContent,
          args.startFrame,
        );
        if (vttIds.length === 0) {
          return { success: false, error: 'No usable subtitles found in that VTT content.' };
        }
        return { success: true, data: { importedClipIds: vttIds, count: vttIds.length } };
      }

      case 'set_title_text': {
        try {
          // Resolve and type-check before any mutation: a style-only call used
          // to reach the mutator with no guard, so a non-title clip was
          // reported as updated while the batch silently skipped it. Every
          // sibling case (set_shape_style, set_clip_edge_effects, …) refuses
          // the wrong clip type up front; this one now does too.
          const clip = this.editor.getClips().find((c) => c.id === args.clipId);
          if (!clip) return { success: false, error: 'Clip not found.' };
          if (clip.type !== 'title') {
            return { success: false, error: 'Only title clips carry title text and styling.' };
          }
          // Validated here so setTitleText's false below can only mean "the
          // text is already this", never "the text was unusable".
          if (args.text !== undefined && !sanitizeTitleText(args.text)) {
            return { success: false, error: 'Title text is invalid.' };
          }
          const styleFields = [args.fontSize, args.color, args.bold, args.fontFamily, args.backgroundColor, args.backgroundPadding, args.lineSpacing, args.fontCase, args.fillMode, args.blurRadius, args.tiltX, args.tiltY, args.variationWght, args.variationWdth, args.variationSlnt, args.variationItal];
          // One tool call is one undo step: text and style land together, so a
          // single undo reverts both. A scope collecting only one command
          // publishes it as-is, so a text-only or style-only call keeps its
          // exact existing history label.
          let textChanged = false;
          const styleReceipt = this.editor.transaction('Edit title text and style', () => {
            if (args.text !== undefined) {
              textChanged = this.editor.setTitleText(args.clipId, args.text);
            }
            if (!styleFields.some((v) => v !== undefined)) return null;
            return this.editor.applyClipProperties([args.clipId], 'Style title', (draft) => {
              if (draft.type !== 'title') return false;
              if (args.fontSize !== undefined) {
                draft.titleSizeRatio = args.fontSize / this.editor.getProject().settings.height;
              }
              if (args.color !== undefined) draft.titleColor = args.color;
              if (args.bold !== undefined) draft.titleBold = args.bold;
              if (args.fontFamily !== undefined) draft.titleFontFamily = args.fontFamily;
              if (args.backgroundColor !== undefined) {
                // Explicit null is the documented way to remove the box, so
                // the field is cleared rather than stored as null.
                if (args.backgroundColor === null) delete draft.titleBackgroundColor;
                else draft.titleBackgroundColor = args.backgroundColor;
              }
              if (args.backgroundPadding !== undefined) draft.titleBackgroundPadding = args.backgroundPadding;
              if (args.lineSpacing !== undefined) draft.titleLineSpacing = args.lineSpacing;
              if (args.fontCase !== undefined) draft.titleFontCase = args.fontCase;
              // "color" is the documented way back to solid styling.
              if (args.fillMode !== undefined) {
                if (args.fillMode === 'color') delete draft.titleFillMode;
                else draft.titleFillMode = args.fillMode;
              }
              if (args.blurRadius !== undefined) {
                if (args.blurRadius === 0) delete draft.titleBlurRadius;
                else draft.titleBlurRadius = args.blurRadius;
              }
              if (args.tiltX !== undefined) {
                if (args.tiltX === 0) delete draft.titleTiltXDeg;
                else draft.titleTiltXDeg = args.tiltX;
              }
              if (args.tiltY !== undefined) {
                if (args.tiltY === 0) delete draft.titleTiltYDeg;
                else draft.titleTiltYDeg = args.tiltY;
              }
              if (args.variationWght !== undefined) {
                const clean = sanitizeTitleVariationWght(args.variationWght);
                if (clean === undefined) delete draft.titleVariationWght;
                else draft.titleVariationWght = clean;
              }
              if (args.variationWdth !== undefined) {
                const clean = sanitizeTitleVariationWdth(args.variationWdth);
                if (clean === undefined) delete draft.titleVariationWdth;
                else draft.titleVariationWdth = clean;
              }
              if (args.variationSlnt !== undefined) {
                const clean = sanitizeTitleVariationSlnt(args.variationSlnt);
                if (clean === undefined) delete draft.titleVariationSlnt;
                else draft.titleVariationSlnt = clean;
              }
              if (args.variationItal !== undefined) {
                const clean = sanitizeTitleVariationItal(args.variationItal);
                if (clean === undefined) delete draft.titleVariationItal;
                else draft.titleVariationItal = clean;
              }
              return true;
            });
          });
          // Report what actually happened: the batch mutator skips a clip it
          // leaves unchanged, and setTitleText returns false for text that is
          // already set, so "success" here would be a lie.
          if (!textChanged && (styleReceipt?.changedClipIds.length ?? 0) === 0) {
            return { success: true, data: { updated: args.clipId, changed: false } };
          }
          return { success: true, data: { updated: args.clipId } };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Text update failed.',
          };
        }
      }

      case 'add_shapes': {
        try {
          const result = this.editor.addShapeClips(args.entries.map((entry: {
            trackId: string;
            startFrame: number;
            durationFrames: number;
            kind?: unknown;
            x?: unknown;
            y?: unknown;
            width?: unknown;
            height?: unknown;
            strokeColor?: unknown;
            strokeWidth?: unknown;
            fillColor?: unknown;
            preset?: unknown;
          }) => ({
            trackId: entry.trackId,
            startFrame: entry.startFrame,
            durationFrames: entry.durationFrames,
            shapeKind: entry.kind,
            ...(entry.x !== undefined ? { x: entry.x } : {}),
            ...(entry.y !== undefined ? { y: entry.y } : {}),
            ...(entry.width !== undefined ? { width: entry.width } : {}),
            ...(entry.height !== undefined ? { height: entry.height } : {}),
            ...(entry.strokeColor !== undefined ? { strokeColor: entry.strokeColor } : {}),
            ...(entry.strokeWidth !== undefined ? { strokeWidth: entry.strokeWidth } : {}),
            ...(entry.fillColor !== undefined ? { fillColor: entry.fillColor } : {}),
            ...(entry.preset !== undefined ? { preset: entry.preset } : {}),
          })));
          if (result.errors.length > 0 && result.added.length === 0) {
            return { success: false, error: result.errors[0] };
          }
          return { success: true, data: { added: result.added, errors: result.errors } };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Shape creation failed.',
          };
        }
      }

      case 'set_shape_style': {
        try {
          const clip = this.editor.getClips().find((c) => c.id === args.clipId);
          if (!clip) return { success: false, error: 'Clip not found.' };
          if (clip.type !== 'shape') {
            return { success: false, error: 'Only shape clips carry shape style.' };
          }
          const styleFields = [
            args.kind, args.strokeColor, args.strokeWidth, args.fillColor, args.preset,
          ];
          if (styleFields.every((v) => v === undefined)) {
            return { success: false, error: 'Pass at least one field to update.' };
          }
          if (args.kind !== undefined && sanitizeShapeKind(args.kind) === undefined) {
            return { success: false, error: 'Unknown shape kind.' };
          }
          if (args.strokeColor !== undefined && sanitizeShapeStrokeColor(args.strokeColor) === undefined) {
            return { success: false, error: 'strokeColor must be #RRGGBB.' };
          }
          if (args.strokeWidth !== undefined && sanitizeShapeStrokeWidth(args.strokeWidth) === undefined) {
            return { success: false, error: 'strokeWidth must be a finite number.' };
          }
          if (
            args.fillColor !== undefined && args.fillColor !== null
            && sanitizeShapeFillColor(args.fillColor) === undefined
          ) {
            return { success: false, error: 'fillColor must be #RRGGBBAA or null.' };
          }
          let preset: ShapeAnimationPreset | undefined;
          if (args.preset !== undefined) {
            if (
              typeof args.preset !== 'string'
              || !(SHAPE_ANIMATION_PRESETS as readonly string[]).includes(args.preset)
            ) {
              return { success: false, error: 'Unknown animation preset.' };
            }
            preset = args.preset as ShapeAnimationPreset;
          }
          const fps = this.editor.getProject().settings.fps;
          this.editor.applyClipProperties([args.clipId], 'Style shape', (draft) => {
            if (draft.type !== 'shape') return false;
            if (args.kind !== undefined) {
              const kind = sanitizeShapeKind(args.kind)!;
              draft.shapeKind = kind;
              draft.label = kind.charAt(0).toUpperCase() + kind.slice(1);
            }
            if (args.strokeColor !== undefined) {
              draft.shapeStrokeColor = sanitizeShapeStrokeColor(args.strokeColor)!;
            }
            if (args.strokeWidth !== undefined) {
              const width = sanitizeShapeStrokeWidth(args.strokeWidth)!;
              if (width === 0) delete draft.shapeStrokeWidth;
              else draft.shapeStrokeWidth = width;
            }
            if (args.fillColor !== undefined) {
              if (args.fillColor === null) delete draft.shapeFillColor;
              else draft.shapeFillColor = sanitizeShapeFillColor(args.fillColor)!;
            }
            if (preset) {
              const motion = shapePresetMotion(preset, {
                startFrame: draft.startFrame,
                durationFrames: draft.durationFrames,
                fps,
                x: draft.x,
                y: draft.y,
                width: draft.width,
                height: draft.height,
              });
              if (motion.motionX) draft.motionX = motion.motionX;
              if (motion.motionY) draft.motionY = motion.motionY;
              if (motion.motionRot) draft.motionRot = motion.motionRot;
              if (motion.motionScaleX) draft.motionScaleX = motion.motionScaleX;
              if (motion.motionScaleY) draft.motionScaleY = motion.motionScaleY;
            }
            return true;
          });
          return { success: true, data: { updated: args.clipId } };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Shape update failed.',
          };
        }
      }

      case 'set_clip_pan': {        try {
          const ok = this.editor.setClipPan(args.clipId, args.pan);
          return ok
            ? { success: true, data: { clipId: args.clipId, pan: args.pan } }
            : { success: false, error: 'Clip not found or is not an audio clip.' };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Pan change failed.',
          };
        }
      }

      case 'set_clip_eq': {
        const clip = this.editor.getClips().find((c) => c.id === args.clipId);
        if (!clip) return { success: false, error: 'Clip not found.' };
        if (clip.type !== 'audio') {
          return { success: false, error: 'EQ applies to audio clips only.' };
        }
        const clear = args.clear === true;
        const sanitized = sanitizeEq({
          ...(args.lowDb !== undefined ? { lowDb: args.lowDb } : {}),
          ...(args.midDb !== undefined ? { midDb: args.midDb } : {}),
          ...(args.highDb !== undefined ? { highDb: args.highDb } : {}),
        });
        const receipt = this.editor.applyClipProperties(
          [clip.id],
          clear ? 'Reset audio EQ' : 'Audio EQ',
          (draft) => {
            if (clear) {
              delete draft.eqLowDb;
              delete draft.eqMidDb;
              delete draft.eqHighDb;
              return true;
            }
            const fields = { lowDb: 'eqLowDb', midDb: 'eqMidDb', highDb: 'eqHighDb' } as const;
            for (const key of ['lowDb', 'midDb', 'highDb'] as const) {
              if (args[key] === undefined) continue;
              const value = sanitized[key];
              if (value === undefined) continue;
              // A band passed at 0 dB clears it, so an equalized clip can
              // return to structurally neutral without a separate clear.
              if (value === 0) delete draft[fields[key]];
              else draft[fields[key]] = value;
            }
            return true;
          },
        );
        const updated = this.editor.getClips().find((candidate) => candidate.id === clip.id);
        return {
          success: true,
          data: {
            clipId: clip.id,
            changed: receipt.changedClipIds.length > 0,
            lowDb: updated?.eqLowDb ?? 0,
            midDb: updated?.eqMidDb ?? 0,
            highDb: updated?.eqHighDb ?? 0,
            cleared:
              (updated?.eqLowDb ?? 0) === 0
              && (updated?.eqMidDb ?? 0) === 0
              && (updated?.eqHighDb ?? 0) === 0,
          },
        };
      }

      case 'set_clip_compressor': {
        const clip = this.editor.getClips().find((c) => c.id === args.clipId);
        if (!clip) return { success: false, error: 'Clip not found.' };
        if (clip.type !== 'audio') {
          return { success: false, error: 'Compression applies to audio clips only.' };
        }
        const clear = args.clear === true;
        const receipt = this.editor.applyClipProperties(
          [clip.id],
          clear ? 'Remove compressor' : 'Compressor',
          (draft) => {
            if (clear) {
              delete draft.compressor;
              return true;
            }
            const merged = mergeCompressor(draft.compressor, {
              thresholdDb: args.thresholdDb,
              ratio: args.ratio,
              attackMs: args.attackMs,
              releaseMs: args.releaseMs,
              makeupDb: args.makeupDb,
            });
            // ratio 1 (or an arming call without a ratio) resolves to 1:1
            // and removes the stage, matching the Inspector's checkbox.
            if (merged) draft.compressor = merged;
            else delete draft.compressor;
            return true;
          },
        );
        const updated = this.editor.getClips().find((candidate) => candidate.id === clip.id);
        return {
          success: true,
          data: {
            clipId: clip.id,
            changed: receipt.changedClipIds.length > 0,
            compressor: updated && hasCompressor(updated) ? normalizeCompressor(updated.compressor) : null,
            cleared: !updated || !hasCompressor(updated),
          },
        };
      }

      case 'set_clip_noise_reduction': {
        const clip = this.editor.getClips().find((c) => c.id === args.clipId);
        if (!clip) return { success: false, error: 'Clip not found.' };
        if (clip.type !== 'audio') {
          return { success: false, error: 'Noise reduction applies to audio clips only.' };
        }
        // 0 and clear both DELETE the field — the same contract as the
        // Inspector slider, which removes noiseReduction at 0 instead of
        // storing an off value (absent and 0 are both "off" for readers).
        const clear = args.clear === true || args.noiseReduction === 0;
        const receipt = this.editor.applyClipProperties(
          [clip.id],
          clear ? 'Remove noise reduction' : 'Noise reduction',
          (draft) => {
            if (clear) {
              delete draft.noiseReduction;
              return true;
            }
            draft.noiseReduction = args.noiseReduction;
            return true;
          },
        );
        const updated = this.editor.getClips().find((candidate) => candidate.id === clip.id);
        return {
          success: true,
          data: {
            clipId: clip.id,
            changed: receipt.changedClipIds.length > 0,
            noiseReduction: updated ? noiseReductionOf(updated) : null,
            cleared: !updated || noiseReductionOf(updated) === null,
          },
        };
      }

      case 'manage_tracks': {
        try {
          const receipt = this.editor.manageTracks({
            ...(args.reorder !== undefined ? { reorder: args.reorder } : {}),
            ...(args.set !== undefined ? { set: args.set } : {}),
            ...(args.remove !== undefined ? { remove: args.remove } : {}),
          });
          return receipt
            ? { success: true, data: receipt }
            : { success: true, data: { noOp: true } };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Track operation failed.',
          };
        }
      }

      case 'copy_clip_settings': {
        try {
          let targetClipIds: string[];
          let targetTrackSelection: Record<string, unknown> | undefined;
          if (args.targetClipIds !== undefined) {
            const seen = new Set<string>();
            targetClipIds = args.targetClipIds.filter((id: string) => !seen.has(id) && seen.add(id));
            if (targetClipIds.length === 0) {
              return { success: false, error: "Provide a non-empty 'targetClipIds' array" };
            }
          } else {
            const track = this.editor
              .getTracks()
              .find((t) => t.id === args.targetTrack?.trackId);
            if (!track) {
              return {
                success: false,
                error: `Track not found: ${String(args.targetTrack?.trackId)}`,
              };
            }
            const source = this.editor.getClips().find((c) => c.id === args.sourceClipId);
            if (!source) {
              return { success: false, error: `Clip not found: ${String(args.sourceClipId)}` };
            }
            const range = args.targetTrack.range;
            const scoped = this.editor
              .getClips()
              .filter(
                (clip) =>
                  clip.trackId === track.id
                  && clip.type === source.type
                  && clip.id !== source.id
                  && (!range || (clip.startFrame < range[1] && clip.startFrame + clip.durationFrames > range[0])),
              );
            targetClipIds = scoped.map((clip) => clip.id);
            targetTrackSelection = {
              trackId: track.id,
              ...(range ? { range } : {}),
            };
            if (targetClipIds.length === 0) {
              return {
                success: false,
                error: `No ${source.type} clips matched targetTrack ${track.id}`,
              };
            }
          }

          const receipt = this.editor.transferClipSettings(args.sourceClipId, targetClipIds);
          return {
            success: true,
            data: {
              ...receipt,
              changed: receipt.changedClipIds.length > 0,
              sourceClipId: args.sourceClipId,
              mediaType: this.editor.getClips().find((c) => c.id === args.sourceClipId)?.type,
              ...(targetTrackSelection ? { targetTrack: targetTrackSelection } : {}),
            },
          };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Settings transfer failed.',
          };
        }
      }

      case 'manage_markers': {
        try {
          if (args.action === 'create') {
            if (args.name === undefined || args.startFrame === undefined) {
              return { success: false, error: 'Creating a marker requires name and startFrame.' };
            }
            const receipt = this.editor.changeTimelineMarkers({
              creates: [{
                name: args.name,
                startFrame: args.startFrame,
                ...(args.durationFrames !== undefined ? { durationFrames: args.durationFrames } : {}),
                ...(args.color !== undefined ? { color: args.color } : {}),
                ...(args.comment !== undefined ? { comment: args.comment } : {}),
                ...(args.status !== undefined ? { status: args.status } : {}),
              }],
            }, 'Add marker');
            return receipt
              ? { success: true, data: { created: receipt.created } }
              : { success: true, data: { noOp: true } };
          }
          if (args.action === 'update') {
            if (args.markerId === undefined) {
              return { success: false, error: 'Updating a marker requires markerId.' };
            }
            const patch = {
              id: args.markerId,
              ...(args.name !== undefined ? { name: args.name } : {}),
              ...(args.startFrame !== undefined ? { startFrame: args.startFrame } : {}),
              ...(args.durationFrames !== undefined ? { durationFrames: args.durationFrames } : {}),
              ...(args.color !== undefined ? { color: args.color } : {}),
              ...(args.comment !== undefined ? { comment: args.comment } : {}),
              ...(args.status !== undefined ? { status: args.status } : {}),
            };
            const fields = Object.keys(patch).filter((key) => key !== 'id');
            if (fields.length === 0) {
              return { success: false, error: 'Updating a marker requires at least one field to change.' };
            }
            const receipt = this.editor.changeTimelineMarkers({ updates: [patch] }, 'Update marker');
            return receipt
              ? { success: true, data: { updated: receipt.updated } }
              : { success: true, data: { noOp: true } };
          }
          // delete
          if (args.markerId === undefined) {
            return { success: false, error: 'Deleting a marker requires markerId.' };
          }
          const receipt = this.editor.changeTimelineMarkers(
            { deleteIds: [args.markerId] },
            'Delete marker',
          );
          return receipt
            ? { success: true, data: { deletedMarkerId: args.markerId } }
            : { success: true, data: { noOp: true } };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Marker operation failed.',
          };
        }
      }

      case 'manage_media_folders': {
        try {
          if (args.action === 'list') {
            const project = this.editor.getProject();
            return {
              success: true,
              data: {
                folders: this.editor.getMediaFolders().map((folder) => ({
                  id: folder.id,
                  name: folder.name,
                  assetCount: folderAssetCount(project, folder.id),
                })),
                rootAssetCount: folderAssetCount(project, undefined),
              },
            };
          }
          if (args.action === 'create') {
            if (args.name === undefined) {
              return { success: false, error: 'Creating a folder requires name.' };
            }
            const folder = this.editor.createMediaFolder(args.name);
            return { success: true, data: { folder } };
          }
          if (args.action === 'rename') {
            if (args.folderId === undefined || args.folderId === null) {
              return { success: false, error: 'Renaming a folder requires folderId.' };
            }
            if (args.name === undefined) {
              return { success: false, error: 'Renaming a folder requires name.' };
            }
            const before = this.editor.getMediaFolders().find((f) => f.id === args.folderId);
            const folder = this.editor.renameMediaFolder(args.folderId, args.name);
            // renameMediaFolder returns the untouched target when the cleaned
            // name case-insensitively matches the current one — a no-op that
            // added no history, reported like every other no-op receipt.
            if (before && before.name === folder.name) {
              return { success: true, data: { noOp: true } };
            }
            return { success: true, data: { folder } };
          }
          if (args.action === 'delete') {
            if (args.folderId === undefined || args.folderId === null) {
              return { success: false, error: 'Deleting a folder requires folderId.' };
            }
            return { success: true, data: this.editor.deleteMediaFolder(args.folderId) };
          }
          // move_assets — an omitted or null folderId is the library root.
          if (args.assetIds === undefined) {
            return { success: false, error: 'Moving assets requires assetIds.' };
          }
          const receipt = this.editor.moveAssetsToFolder(args.assetIds, args.folderId ?? null);
          if (receipt.movedAssetIds.length === 0) {
            return { success: true, data: { noOp: true } };
          }
          return { success: true, data: receipt };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Folder operation failed.',
          };
        }
      }

      // ── Write operations ──────────────────────────────────────────────────
      case 'add_clip': {
        if (args.mode !== undefined || args.source !== undefined) {
          const placed = this.editor.placeClipWithMode({
            assetId: args.assetId,
            trackId: args.trackId,
            ...(args.mode !== undefined ? { mode: args.mode } : {}),
            ...(args.startFrame !== undefined ? { startFrame: clampFrame(args.startFrame) } : {}),
            ...(args.durationFrames !== undefined
              ? { durationFrames: clampFrame(args.durationFrames, 1) }
              : {}),
            ...(args.source !== undefined ? { source: args.source } : {}),
          });
          if (!placed) {
            return {
              success: false,
              error: `Cannot place ${String(args.assetId)} on track "${String(args.trackId)}": unknown ids, incompatible types, or the track is locked.`,
            };
          }
          return { success: true, data: { clipIds: placed.clipIds } };
        }
        const clipId = this.editor.addClip({
          assetId: args.assetId,
          trackId: args.trackId,
          startFrame: clampFrame(args.startFrame),
          durationFrames: args.durationFrames === undefined ? undefined : clampFrame(args.durationFrames, 1),
        });
        if (!clipId) {
          // Naming the tracks that do exist, because the alternative is a model
          // retrying the same invented id. Reported as a failure rather than a
          // clip id, so the model does not build on a placement that did not
          // happen.
          const available = this.editor.getTracks().map((track) => track.id).join(', ');
          return {
            success: false,
            error: `No track "${String(args.trackId)}". Available tracks: ${available}.`,
          };
        }
        return { success: true, data: { clipId } };
      }

      case 'remove_clip': {
        const removed = this.editor.removeClip(args.clipId);
        return removed
          ? { success: true, data: { removed: args.clipId } }
          : { success: false, error: 'Clip not found or its track is locked.' };
      }

      case 'ripple_delete_clips': {
        const report = this.editor.rippleDeleteClips(args.clipIds);
        return report
          ? { success: true, data: report }
          : { success: false, error: 'No matching clips found or a selected track is locked.' };
      }

      case 'ripple_delete_gap': {
        const report = this.editor.rippleDeleteGap(args.trackId, {
          start: clampFrame(args.startFrame),
          end: clampFrame(args.endFrame, 1),
        });
        return report
          ? { success: true, data: report }
          : { success: false, error: 'Gap is invalid, occupied, blocked, or has no following clips.' };
      }

      case 'ripple_delete_ranges': {
        const report = this.editor.rippleDeleteRanges(
          args.trackId,
          args.ranges.map(([start, end]: [number, number]) => ({
            start: clampFrame(start),
            end: clampFrame(end),
          })),
        );
        return report
          ? { success: true, data: report }
          : {
              success: false,
              error: 'Range extract could not be applied. Check range order, track locks, and affected clips.',
            };
      }

      case 'ripple_trim_clip': {
        const report = this.editor.trimClipEdge(
          args.clipId,
          args.edge,
          args.deltaFrames,
          true,
        );
        return report
          ? { success: true, data: report }
          : { success: false, error: 'Ripple trim could not be applied.' };
      }

      case 'trim_clips':
        return this.trimClips(args);

      case 'move_clip':
        this.editor.moveClip(args.clipId, clampFrame(args.startFrame), args.trackId);
        return { success: true, data: { moved: args.clipId } };

      case 'trim_clip':
        this.editor.trimClip(args.clipId, clampFrame(args.inPoint), clampFrame(args.outPoint, 1));
        return { success: true, data: { trimmed: args.clipId } };

      case 'split_clip': {
        const newClipId = this.editor.splitClip(args.clipId, clampFrame(args.atFrame));
        if (!newClipId) {
          return { success: false, error: 'Split failed — invalid frame or clip not found.' };
        }
        return { success: true, data: { originalClipId: args.clipId, newClipId } };
      }

      case 'nest_clips': {
        try {
          const receipt = this.editor.nestClips(args.clipIds, { name: args.name, scopeTimelineId: args.scopeTimelineId ?? null });
          return { success: true, data: receipt };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Nest failed.',
          };
        }
      }

      case 'flatten_compound': {
        try {
          const receipt = this.editor.flattenCompound(args.clipId, { scopeTimelineId: args.scopeTimelineId ?? null });
          return { success: true, data: receipt };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Flatten failed.',
          };
        }
      }

      case 'add_track': {
        const trackId = this.editor.addTrack(args.type, args.name);
        return { success: true, data: { trackId } };
      }

      case 'set_playhead': {
        const frame = clampFrame(args.frame);
        this.editor.setPlayhead(frame);
        return { success: true, data: { frame } };
      }

      case 'set_clip_blend_mode': {
        const applied = this.editor.setClipBlendMode(args.clipId, args.blendMode);
        if (!applied) {
          return {
            success: false,
            error: 'Blend mode not applied — clip not found or is an audio clip (audio has no compositing stage).',
          };
        }
        return { success: true, data: { clipId: args.clipId, blendMode: args.blendMode } };
      }

      case 'remove_silence': {
        const legacySingle = args.clipId !== undefined;
        const scoped = args.clipIds !== undefined;
        if (legacySingle && scoped) {
          return { success: false, error: 'Pass either clipId or clipIds, not both.' };
        }

        // Resolved against the user's saved controls rather than the built-in
        // defaults, so a no-argument request performs the edit the Inspector
        // describes; supplied arguments override for this call only and do not
        // rewrite the controls. Normalizing both layers matters because the MCP
        // socket is another caller — an out-of-range threshold would otherwise
        // report the whole clip silent (upstream PR #426).
        const config = resolveSilenceConfig(loadSilenceSettings(), {
          ...(args.thresholdDb !== undefined ? { thresholdDb: args.thresholdDb } : {}),
          ...(args.minSilenceSeconds !== undefined ? { minSilenceSec: args.minSilenceSeconds } : {}),
          ...(args.edgePaddingSeconds !== undefined ? { edgePaddingSec: args.edgePaddingSeconds } : {}),
        });

        if (scoped) {
          return this.removeSilenceScoped(args.clipIds as string[], config);
        }
        if (!legacySingle) {
          return this.removeSilenceTimeline(config);
        }

        const clip = this.editor.getClips().find((c) => c.id === args.clipId);
        if (!clip) return { success: false, error: 'Clip not found.' };
        const asset = this.editor.getMedia().find((m) => m.id === clip.assetId);
        if (!asset) return { success: false, error: 'Source media for clip not found.' };

        try {
          const ranges = await detectSilenceForFile(asset.path, config);
          if (ranges.length === 0) {
            return { success: true, data: { removed: 0, message: 'No silence detected above threshold.' } };
          }
          // The controller maps these spans for the cut; mapping here too is
          // what makes an omitted span reportable instead of silently absent
          // (0 from the controller means the ripple refused, e.g. a locked
          // anchor, so nothing was cut even when spans mapped).
          const mapping = mapSilenceRangesToTimeline(
            clip,
            this.editor.getProject().settings.fps,
            ranges,
          );
          const committed = this.editor.removeSilence(args.clipId, ranges);
          const omitted = omissionCounts(mapping.omitted);
          return {
            success: true,
            data: {
              removed: committed > 0 ? mapping.ranges.length : 0,
              ranges: ranges.length,
              ...(omitted ? { notes: [omissionNote(committed > 0, omitted)] } : {}),
            },
          };
        } catch (err: any) {
          return { success: false, error: `Silence detection failed: ${err.message}` };
        }
      }

      case 'set_clip_fade': {
        const fps = this.editor.getProject().settings.fps;
        const fin = args.fadeInSeconds === undefined ? undefined : Math.round(args.fadeInSeconds * fps);
        const fout = args.fadeOutSeconds === undefined ? undefined : Math.round(args.fadeOutSeconds * fps);
        const applied = this.editor.setClipFade(args.clipId, fin, fout);
        if (!applied) return { success: false, error: 'Clip not found.' };
        return { success: true, data: { clipId: args.clipId, fadeInFrames: fin, fadeOutFrames: fout } };
      }

      case 'cross_dissolve': {
        const fps = this.editor.getProject().settings.fps;
        const d = Math.round(args.durationSeconds * fps);
        const ok = this.editor.createCrossDissolve(args.firstClipId, args.secondClipId, d);
        if (!ok) {
          return {
            success: false,
            error: 'Cross-dissolve failed — clips must be adjacent on the same track and longer than the dissolve.',
          };
        }
        return { success: true, data: { durationFrames: d } };
      }

      case 'set_clip_transition': {
        const fps = this.editor.getProject().settings.fps;
        if (args.type === 'none') {
          const ok = this.editor.setClipTransition(args.clipId, null);
          return ok ? { success: true, data: { cleared: true } } : { success: false, error: 'Clip not found.' };
        }
        if (!args.direction || args.durationSeconds === undefined) {
          return { success: false, error: 'wipe/slide require a direction and durationSeconds.' };
        }
        const ok = this.editor.setClipTransition(args.clipId, {
          type: args.type,
          direction: args.direction,
          frames: Math.round(args.durationSeconds * fps),
          softness: args.softness,
        });
        return ok
          ? { success: true, data: { clipId: args.clipId, type: args.type, direction: args.direction } }
          : { success: false, error: 'Clip not found.' };
      }

      case 'set_project_settings': {
        let resolved: { fps?: number; width?: number; height?: number };
        try {
          resolved = resolveProjectSettings(args, this.editor.getProject().settings);
        } catch (err: any) {
          return { success: false, error: err.message };
        }

        const report = this.editor.applyProjectSettings(resolved);
        if (!report) {
          return {
            success: false,
            error: `Resolution must be positive and no larger than ${MAX_CANVAS_EDGE} pixels on either edge.`,
          };
        }
        return {
          success: true,
          data: {
            fps: report.fps,
            resolution: `${report.width}x${report.height}`,
            aspectRatio: aspectRatioLabel(report.width, report.height),
            changed: report.changed,
            ...(report.changed.length === 0 ? { note: 'Settings already matched.' } : {}),
          },
        };
      }

      case 'undo': {
        const undone = this.editor.undo();
        if (undone) return { success: true, data: { action: 'undo' } };
        // The stale wording comes from the controller, which shares it with the
        // editor:undo IPC so the two surfaces cannot tell the user different
        // things about the same refusal.
        return {
          success: false,
          error: this.editor.undoRefusalMessage('undo') ?? 'Nothing to undo.',
        };
      }

      case 'redo': {
        const redone = this.editor.redo();
        if (redone) return { success: true, data: { action: 'redo' } };
        return {
          success: false,
          error: this.editor.undoRefusalMessage('redo') ?? 'Nothing to redo.',
        };
      }

      case 'new_project': {
        try {
          const project = createEmptyProject(
            typeof args.name === 'string' && args.name.trim().length > 0
              ? args.name.trim()
              : 'Untitled Project',
          );
          this.editor.adoptProject(project, 'New project');
          return {
            success: true,
            data: { name: project.name, tracks: project.timeline.tracks.length, clips: 0, media: 0 },
          };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Could not create the project.' };
        }
      }

      case 'open_project': {
        if (typeof args.path !== 'string' || args.path.length === 0) {
          return { success: false, error: 'A project file path is required.' };
        }
        try {
          const json = await fs.readFile(args.path, 'utf8');
          const project = EditorController.deserialize(json).getProject();
          this.editor.adoptProject(project, 'Open project');
          return {
            success: true,
            data: {
              path: args.path,
              name: project.name,
              clips: project.timeline.clips.length,
              media: project.media.length,
              tracks: project.timeline.tracks.length,
            },
          };
        } catch (err) {
          return {
            success: false,
            error: `Could not open ${args.path}: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      case 'save_project': {
        if (typeof args.path !== 'string' || args.path.length === 0) {
          return { success: false, error: 'A project file path is required.' };
        }
        try {
          const json = this.editor.serialize();
          // Share the GUI's per-destination FIFO and unique-temp atomic write
          // contract so concurrent MCP saves cannot race on one staging path.
          await writeProjectFile(args.path, json);
          return { success: true, data: { path: args.path, bytes: Buffer.byteLength(json, 'utf8') } };
        } catch (err) {
          return {
            success: false,
            error: `Could not save ${args.path}: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      case 'export_project': {
        const outputPath = typeof args.outputPath === 'string' ? args.outputPath : '';
        if (!path.isAbsolute(outputPath)) {
          return { success: false, error: 'outputPath must be an absolute path.' };
        }
        const format = args.format ?? 'mp4';
        const quality = args.quality ?? 'normal';
        // HDR profile (upstream #59): rides the same options object as
        // format/quality, schema-validated by the tool enum; absent means
        // the SDR default. Export settings are delivery options, not project
        // state, so like format/quality they enter no undo domain.
        const hdr = args.hdr;
        const options = {
          outputPath,
          format,
          quality,
          ...(hdr !== undefined ? { hdr } : {}),
        };

        // The exporter reports through the same events the delivery panel
        // consumes; capture them so an error that only arrives as an event
        // (e.g. FFmpeg's stderr tail) reaches the caller instead of a bare
        // exit-code message, and so a layer the graph could not render
        // faithfully (a missing LUT, an unbaked shape, an advanced title
        // degraded to drawtext) is named in the receipt rather than dropped
        // silently by a zero exit code.
        const events: { error?: string; bytes?: number; warnings: string[] } = { warnings: [] };
        const sink = {
          send: (channel: string, payload?: unknown) => {
            if (channel === 'export:complete') {
              events.bytes = (payload as { bytes?: number } | undefined)?.bytes;
            }
            if (channel === 'export:error') {
              events.error = typeof payload === 'string' ? payload : String(payload);
            }
            if (channel === 'export:warning') {
              events.warnings.push(typeof payload === 'string' ? payload : String(payload));
            }
          },
        };

        try {
          if (this.deps.runExport) {
            await this.deps.runExport(this.editor.getProject(), options, sink);
          } else {
            const { getExporter } = await import('../media/exporter');
            await getExporter().export(this.editor.getProject(), options, sink);
          }
          if (events.error) return { success: false, error: events.error };
          return {
            success: true,
            data: {
              outputPath,
              format,
              quality,
              bytes: events.bytes ?? null,
              ...(hdr !== undefined ? { hdr } : {}),
              ...(events.warnings.length > 0 ? { warnings: events.warnings } : {}),
            },
          };
        } catch (err) {
          // A failed export is already loud; the warnings describe a render
          // that never delivered, so they ride the success receipt only.
          return {
            success: false,
            error: events.error ?? (err instanceof Error ? err.message : String(err)),
          };
        }
      }

      case 'import_fcpxml': {
        const xml = await fs.readFile(args.path, 'utf8');
        const plan = parseFcpxml(xml);
        const projectFps = this.editor.getProject().settings.fps;
        if (!plan.fps) {
          return { success: false, error: 'The file has no usable <format frameDuration>; frame mapping is undefined.' };
        }
        // The dialog path (shared/fcpxml/apply.ts) owns this rule and this
        // wording; asking it here keeps the two surfaces from drifting on what
        // counts as an unmappable rate. Asked before any asset is probed, so a
        // refused document leaves the library untouched.
        const rateRefusal = degenerateRateRefusal(plan, projectFps);
        if (rateRefusal !== null) {
          return { success: false, error: rateRefusal };
        }
        const toProjectFrames = frameRescaler(projectFps, plan.fps);

        // Assets: probe each unique path into the library; missing files are
        // reported and their clips skipped rather than failing the import.
        const assetIdByPath = new Map<string, string>();
        const dimsByPath = new Map<string, { width?: number; height?: number }>();
        const offline: string[] = [];
        for (const asset of plan.assets) {
          if (!fsSync.existsSync(asset.path)) {
            offline.push(asset.path);
            continue;
          }
          try {
            const probed = await probeMedia(asset.path);
            const id = nanoid();
            this.editor.addMedia({
              id,
              addedAt: new Date().toISOString(),
              ...probed,
              // The XML's source timecode fills in when the container has
              // none (#154); a container tag wins because it describes the
              // bytes.
              ...(asset.startTimecode && !probed.startTimecode
                ? { startTimecode: asset.startTimecode }
                : {}),
            });
            assetIdByPath.set(asset.path, id);
            dimsByPath.set(asset.path, { width: probed.width, height: probed.height });
          } catch {
            offline.push(asset.path);
          }
        }

        // Lanes materialize as fresh tracks so an import never collides with
        // existing content (additive contract stated in the tool description).
        const videoLaneTrack = new Map<number, string>();
        const audioLaneTrack = new Map<number, string>();
        const maxVLane = Math.max(0, ...plan.clips.filter((c) => c.kind !== 'audio').map((c) => c.lane));
        for (let lane = 0; lane <= maxVLane; lane++) {
          videoLaneTrack.set(lane, this.editor.addTrack('video'));
        }
        const audioLanes = plan.clips.filter((c) => c.kind === 'audio').map((c) => c.lane);
        for (const lane of [...new Set(audioLanes)].sort((a, b) => a - b)) {
          if (!audioLaneTrack.has(lane)) audioLaneTrack.set(lane, this.editor.addTrack('audio'));
        }

        let placed = 0;
        let titles = 0;
        for (const clip of plan.clips) {
          const startFrame = toProjectFrames(clip.startFrame);
          const durationFrames = Math.max(1, toProjectFrames(clip.durationFrames));

          if (clip.kind === 'title') {
            const trackId = videoLaneTrack.get(clip.lane);
            if (!trackId) continue;
            const titleId = this.editor.addTitleClip({
              trackId,
              text: clip.text,
              startFrame,
              durationFrames,
            });
            applyImportedTitleStyle(this.editor, titleId, clip);
            titles += 1;
            continue;
          }

          const assetId = assetIdByPath.get(clip.assetPath);
          if (!assetId) continue; // its source was offline
          const trackId = clip.kind === 'audio'
            ? audioLaneTrack.get(clip.lane)
            : videoLaneTrack.get(clip.lane);
          if (!trackId) continue;
          const sourceIn = toProjectFrames(clip.sourceInFrame);
          const newClipId = this.editor.addClip({
            assetId,
            trackId,
            startFrame,
            durationFrames,
          });
          // Source trim is a follow-up edit: addClip has no In/Out params.
          if (clip.sourceInFrame > 0) {
            this.editor.trimClip(newClipId, sourceIn, sourceIn + durationFrames);
          }
          // Imported adjustments ride one undoable batch — the linked twin's
          // share of the speed included, exactly as the dialog path does
          // (shared/fcpxml/apply.ts). A clip carrying none adds no history.
          const dims = dimsByPath.get(clip.assetPath);
          applyImportedAdjustments(this.editor, newClipId, clip, {
            canvasWidth: this.editor.getProject().settings.width,
            canvasHeight: this.editor.getProject().settings.height,
            sourceWidth: dims?.width,
            sourceHeight: dims?.height,
          });
          placed += 1;
        }

        return {
          success: true,
          data: {
            placedClips: placed,
            titles,
            assetsAdded: assetIdByPath.size,
            tracksCreated: videoLaneTrack.size + audioLaneTrack.size,
            offline,
            unsupported: plan.unsupported,
            note: 'Each placement is a separate undo step.',
          },
        };
      }

      case 'export_fcpxml': {
        const report = exportFcpxmlWithReport(this.editor.getProject());
        await fs.writeFile(args.path, report.xml, 'utf8');
        // Mirror import_fcpxml's unsupported list, truncated for context:
        // one line per skipped clip, with counts so nothing is lost silently.
        const unsupported = report.unsupported.slice(0, 20);
        return {
          success: true,
          data: {
            path: args.path,
            exportedClips: report.exportedClips,
            skippedClips: report.skippedClips,
            unsupported,
            unsupportedTotal: report.unsupported.length,
            unsupportedTruncated: report.unsupported.length > unsupported.length,
          },
        };
      }

      case 'inspect_frame': {
        const asset = this.editor.getMedia().find((m) => m.id === args.assetId);
        if (!asset) return { success: false, error: 'Asset not found.' };
        if (asset.type === 'audio') {
          return { success: false, error: 'Audio assets have no frames to inspect.' };
        }
        const atSeconds = Math.max(0, args.atSeconds);
        const width = Math.min(1920, Math.max(160, args.width ?? 640));
        const height = Math.max(90, Math.round((width / (asset.width ?? 16)) * (asset.height ?? 9)));

        const { getFrameDecoder } = await import('../media/frame-decoder');
        const decoded = await getFrameDecoder().getFrame({
          assetPath: asset.path,
          width,
          height,
          sourceSeconds: atSeconds,
        });
        if (!decoded?.data) {
          return { success: false, error: `Could not decode a frame at ${atSeconds}s — check the offset against the asset duration.` };
        }

        const hash = createHash('sha1')
          .update(`${asset.path}|${atSeconds}|${width}`)
          .digest('hex')
          .slice(0, 12);
        // Real Electron stores frames under userData; tests (where the
        // electron module is a stub) fall back to the OS temp dir.
        let baseDir: string;
        try {
          type ElectronAppHost = { app?: { getPath(name: string): string }; default?: { app?: { getPath(name: string): string } } };
          const electronModule = (await import('electron')) as unknown as ElectronAppHost;
          const app = electronModule.app ?? electronModule.default?.app;
          baseDir = app ? app.getPath('userData') : path.join(os.tmpdir(), 'palmier-inspect-frames');
        } catch {
          baseDir = path.join(os.tmpdir(), 'palmier-inspect-frames');
        }
        const outPath = inspectFramePath(baseDir, hash);
        await rgbaToPng(decoded.data, width, height, outPath);

        const timecode = `${Math.floor(atSeconds / 60)}:${String(Math.floor(atSeconds % 60)).padStart(2, '0')}`;
        const imageBase64 = decoded.data.length < 2_000_000
          ? (await fs.readFile(outPath)).toString('base64')
          : undefined;
        return {
          success: true,
          data: {
            path: outPath,
            width,
            height,
            timecode: `${timecode} (${atSeconds.toFixed(2)}s)`,
            note: 'Open/read the PNG at `path` to view this frame.',
            ...(imageBase64 ? { imageBase64 } : {}),
          },
        };
      }

      case 'set_clip_motion': {
        const clip = this.editor.getClips().find((c) => c.id === args.clipId);
        if (!clip) return { success: false, error: 'Clip not found.' };
        if (clip.type !== 'video' && clip.type !== 'image' && clip.type !== 'shape') {
          return { success: false, error: 'Motion animation applies to video, image, and shape clips only (titles are static in v1).' };
        }
        if (Array.isArray(args.points) && args.points.length === 0) {
          this.editor.applyClipProperties([args.clipId], 'Clear motion', (draft) => {
            if (args.axis === 'x') delete draft.motionX;
            else if (args.axis === 'y') delete draft.motionY;
            else if (args.axis === 'sx') delete draft.motionScaleX;
            else if (args.axis === 'sy') delete draft.motionScaleY;
            else delete draft.motionRot;
            return true;
          });
          return { success: true, data: { clipId: args.clipId, axis: args.axis, cleared: true } };
        }
        const track = sanitizeMotion(args.points);
        if (!track) {
          return { success: false, error: 'Need at least two keyframes with finite frame and value.' };
        }
        this.editor.applyClipProperties([args.clipId], 'Set motion', (draft) => {
          if (args.axis === 'x') draft.motionX = track;
          else if (args.axis === 'y') draft.motionY = track;
          else if (args.axis === 'sx') draft.motionScaleX = track;
          else if (args.axis === 'sy') draft.motionScaleY = track;
          else draft.motionRot = track;
          return true;
        });
        return {
          success: true,
          data: {
            clipId: args.clipId,
            axis: args.axis,
            keyframes: track,
          },
        };
      }

      case 'set_clip_opacity_keyframes': {
        const clip = this.editor.getClips().find((candidate) => candidate.id === args.clipId);
        if (!clip) return { success: false, error: 'Clip not found.' };
        // Match the Inspector's decoded-media eligibility: video, image, and
        // generated clips share the media alpha path. Titles, shapes, audio,
        // and compound clips use separate render/transport paths.
        if (clip.type !== 'video' && clip.type !== 'image' && clip.type !== 'generated') {
          return {
            success: false,
            error: 'Opacity keyframes apply to video, image, and generated clips only; titles, shapes, audio, and compound clips use separate render/transport paths.',
          };
        }

        if (args.points.length === 0) {
          const changed = this.editor.setClipOpacityTrack(args.clipId, []);
          const current = this.editor.getClips().find((candidate) => candidate.id === args.clipId)?.opacityTrack;
          return {
            success: true,
            data: {
              clipId: args.clipId,
              changed,
              cleared: changed,
              keyframes: current ?? [],
            },
          };
        }

        // Validate the complete track before calling the sanctioned controller
        // mutation. The schema has already rejected non-finite/out-of-range
        // values; this catches short tracks and duplicate-frame collapse.
        const track = sanitizeMotion(args.points);
        const bounded = track?.filter((point) => point.value >= 0 && point.value <= 1) ?? [];
        if (bounded.length < 2) {
          return {
            success: false,
            error: 'Opacity keyframes need at least two distinct, finite points with values from 0 to 1.',
          };
        }

        const changed = this.editor.setClipOpacityTrack(args.clipId, args.points);
        const current = this.editor.getClips().find((candidate) => candidate.id === args.clipId)?.opacityTrack;
        return {
          success: true,
          data: {
            clipId: args.clipId,
            changed,
            cleared: false,
            keyframes: current ?? bounded,
          },
        };
      }

      case 'set_clip_volume_keyframes': {
        const clip = this.editor.getClips().find((c) => c.id === args.clipId);
        if (!clip) return { success: false, error: 'Clip not found.' };
        if (clip.type !== 'audio') {
          return { success: false, error: 'Volume keyframes apply to audio clips only.' };
        }
        if (Array.isArray(args.points) && args.points.length === 0) {
          this.editor.applyClipProperties([args.clipId], 'Clear volume keyframes', (draft) => {
            delete draft.volumeDb;
            return true;
          });
          return { success: true, data: { clipId: args.clipId, cleared: true } };
        }
        const track = sanitizeVolumeKeyframes(args.points);
        if (!track) {
          return { success: false, error: 'Need at least two keyframes with finite frame and value.' };
        }
        this.editor.applyClipProperties([args.clipId], 'Set volume keyframes', (draft) => {
          draft.volumeDb = track;
          return true;
        });
        return {
          success: true,
          data: {
            clipId: args.clipId,
            keyframes: track,
          },
        };
      }

      case 'set_clip_crop': {
        const clip = this.editor.getClips().find((c) => c.id === args.clipId);
        if (!clip) return { success: false, error: 'Clip not found.' };
        if (clip.type !== 'video' && clip.type !== 'image') {
          return { success: false, error: 'Only video and image clips can be cropped.' };
        }
        const sanitized = sanitizeCrop(args);
        this.editor.applyClipProperties([args.clipId], 'Set crop', (draft) => {
          if (sanitized) draft.crop = sanitized;
          else delete draft.crop;
          return true;
        });
        return {
          success: true,
          data: {
            clipId: args.clipId,
            ...(sanitized ? { crop: sanitized } : {}),
            ...(sanitized ? {} : { cleared: true }),
          },
        };
      }

      case 'set_clip_edge_effects': {
        const clip = this.editor.getClips().find((c) => c.id === args.clipId);
        if (!clip) return { success: false, error: 'Clip not found.' };
        if (clip.type !== 'video' && clip.type !== 'image') {
          return { success: false, error: 'Edge effects apply to video and image clips only.' };
        }
        const rounding = args.edgeRounding;
        const softness = args.edgeSoftness;
        const receipt = this.editor.applyClipProperties([clip.id], 'Set edge effects', (draft) => {
          if (rounding !== undefined) {
            if (rounding === 0) delete draft.edgeRounding;
            else draft.edgeRounding = rounding;
          }
          if (softness !== undefined) {
            if (softness === 0) delete draft.edgeSoftness;
            else draft.edgeSoftness = softness;
          }
          return true;
        });
        if (receipt.changedClipIds.length === 0) {
          return {
            success: true,
            data: {
              clipId: clip.id,
              changed: false,
              edgeRounding: clip.edgeRounding ?? 0,
              edgeSoftness: clip.edgeSoftness ?? 0,
            },
          };
        }
        const updated = this.editor.getClips().find((candidate) => candidate.id === clip.id);
        return {
          success: true,
          data: {
            clipId: clip.id,
            changed: true,
            edgeRounding: updated?.edgeRounding ?? 0,
            edgeSoftness: updated?.edgeSoftness ?? 0,
            cleared: (updated?.edgeRounding ?? 0) === 0 && (updated?.edgeSoftness ?? 0) === 0,
          },
        };
      }

      case 'set_clip_chroma_key': {
        const clip = this.editor.getClips().find((c) => c.id === args.clipId);
        if (!clip) return { success: false, error: 'Clip not found.' };
        if (clip.type !== 'video' && clip.type !== 'image') {
          return { success: false, error: 'Chroma key applies to video and image clips only.' };
        }
        const merged = mergeChromaKey(clip.chromaKey, {
          keyColor: args.keyColor,
          tolerance: args.tolerance,
          softness: args.softness,
          spill: args.spill,
        });
        const receipt = this.editor.applyClipProperties([clip.id], 'Set chroma key', (draft) => {
          if (merged) draft.chromaKey = merged;
          else delete draft.chromaKey;
          return true;
        });
        if (receipt.changedClipIds.length === 0) {
          return {
            success: true,
            data: {
              clipId: clip.id,
              changed: false,
              chromaKey: clip.chromaKey ?? null,
            },
          };
        }
        const updated = this.editor.getClips().find((candidate) => candidate.id === clip.id);
        return {
          success: true,
          data: {
            clipId: clip.id,
            changed: true,
            chromaKey: updated?.chromaKey ?? null,
            cleared: !updated?.chromaKey,
          },
        };
      }

      case 'save_grade_preset': {
        const clip = this.editor.getClips().find((candidate) => candidate.id === args.clipId);
        if (!clip) return { success: false, error: 'Clip not found.' };
        if (clip.type !== 'video' && clip.type !== 'image') {
          return { success: false, error: 'Color grading applies to video and image clips only.' };
        }
        const captured = capturePresetFromClip(clip, this.editor.getProject().settings);
        const result = this.gradePresets.save(args.name, captured.grade, captured.shot);
        if (!result.ok) return { success: false, error: result.error };
        return {
          success: true,
          data: {
            clipId: clip.id,
            preset: result.preset,
            presets: result.presets,
          },
        };
      }

      case 'rename_grade_preset': {
        const result = this.gradePresets.rename(args.presetId, args.name);
        if (!result.ok) return { success: false, error: result.error };
        return {
          success: true,
          data: {
            presetId: result.preset.id,
            preset: result.preset,
            presets: result.presets,
          },
        };
      }

      case 'delete_grade_preset': {
        const referencingClipIds = this.editor.getClips()
          .filter((clip) => clip.gradePresetId === args.presetId)
          .map((clip) => clip.id);
        const result = this.gradePresets.delete(args.presetId);
        if (!result.ok) return { success: false, error: result.error };
        return {
          success: true,
          data: {
            presetId: args.presetId,
            changed: result.changed,
            referencingClipIds,
            presets: result.presets,
          },
        };
      }

      case 'apply_grade_preset': {
        const targetModes = [
          args.clipId !== undefined,
          args.clipIds !== undefined,
          args.allProjectClips !== undefined,
        ].filter(Boolean).length;
        if (targetModes !== 1) {
          return { success: false, error: 'Provide exactly one of clipId, clipIds, or allProjectClips:true.' };
        }

        const allProjectClips = args.allProjectClips === true;
        const availableClips = this.editor.getClips();
        const clipIds = allProjectClips
          ? availableClips.map((clip) => clip.id)
          : args.clipId !== undefined
            ? [args.clipId as string]
            : [...new Set(args.clipIds as string[])];
        const clips = clipIds.map((clipId) => availableClips.find((candidate) => candidate.id === clipId));
        for (const [index, clip] of clips.entries()) {
          if (!clip) {
            return { success: false, error: `Clip not found: ${clipIds[index]}` };
          }
          if (clip.type !== 'video' && clip.type !== 'image') {
            return { success: false, error: 'Color grading applies to video and image clips only.' };
          }
        }
        const preset = this.gradePresets.get(args.presetId);
        if (!preset) return { success: false, error: 'Grade preset not found.' };

        // Propagation is opt-in per call and never inferred: an omitted flag
        // resolves to the requested clips alone, and a mode this tool does not
        // know is refused rather than quietly downgraded to that.
        let propagate: GradePresetPropagateMode | undefined;
        if (args.propagate !== undefined) {
          const parsed = parseGradePresetPropagateMode(args.propagate);
          if (!parsed.ok) return { success: false, error: parsed.error };
          propagate = parsed.mode;
        }
        const cover = resolveGradePresetPropagation(
          this.editor,
          clipIds,
          propagate === undefined ? [] : [propagate],
          (clip) => clip.type === 'video' || clip.type === 'image',
        );
        if (!cover.ok) return { success: false, error: cover.error };

        const linkPreset = args.linkPreset !== false;
        const report = applyGradePresetTo(this.editor, cover.cover.clipIds, preset, linkPreset);
        return {
          success: true,
          data: {
            presetId: preset.id,
            label: preset.label,
            clipIds: cover.cover.clipIds,
            linkPreset,
            ...(allProjectClips ? { allProjectClips: true } : {}),
            ...(propagate === undefined
              ? {}
              : { propagate, relatedClipIds: cover.cover.relatedClipIds }),
            changed: report.changedClipIds.length > 0,
            changedClipIds: report.changedClipIds,
            skippedClipIds: report.skippedClipIds,
          },
        };
      }

      case 'set_clip_color_grade': {
        const clip = this.editor.getClips().find((c) => c.id === args.clipId);
        if (!clip) return { success: false, error: 'Clip not found.' };
        if (clip.type !== 'video' && clip.type !== 'image') {
          return { success: false, error: 'Color grading applies to video and image clips only.' };
        }
        const clear = args.clear === true;
        // Curves, wheels and hue curves are validated strictly: a malformed
        // point refuses the call rather than silently dropping part of the
        // requested look.
        let curvesPatch: GradeCurvePatch | undefined;
        if (args.curves !== undefined) {
          const parsed = parseGradeCurvePatch(args.curves);
          if (!parsed.ok) return { success: false, error: parsed.error };
          curvesPatch = parsed.patch;
        }
        let wheelsPatch: GradeWheelsPatch | undefined;
        if (args.wheels !== undefined) {
          const parsed = parseGradeWheelsPatch(args.wheels);
          if (!parsed.ok) return { success: false, error: parsed.error };
          wheelsPatch = parsed.patch;
        }
        let hueCurvesPatch: HueCurvesPatch | undefined;
        if (args.hueCurves !== undefined) {
          const parsed = parseHueCurvesPatch(args.hueCurves);
          if (!parsed.ok) return { success: false, error: parsed.error };
          hueCurvesPatch = parsed.patch;
        }
        // Effect stages (#157 subgroups) are validated strictly like the
        // wheels: a malformed component refuses the call rather than
        // silently rendering a different look.
        let vignettePatch: VignettePatch | undefined;
        if (args.vignette !== undefined) {
          const parsed = parseVignettePatch(args.vignette);
          if (!parsed.ok) return { success: false, error: parsed.error };
          vignettePatch = parsed.patch;
        }
        let grainPatch: GrainPatch | undefined;
        if (args.grain !== undefined) {
          const parsed = parseGrainPatch(args.grain);
          if (!parsed.ok) return { success: false, error: parsed.error };
          grainPatch = parsed.patch;
        }
        let glowPatch: GlowPatch | undefined;
        if (args.glow !== undefined) {
          const parsed = parseGlowPatch(args.glow);
          if (!parsed.ok) return { success: false, error: parsed.error };
          glowPatch = parsed.patch;
        }
        if (args.blurRadius !== undefined
          && (!Number.isFinite(args.blurRadius)
            || args.blurRadius < EFFECT_LIMITS.blurRadius.min
            || args.blurRadius > EFFECT_LIMITS.blurRadius.max)) {
          return { success: false, error: 'Blur radius must be between 0 and 100.' };
        }
        // LUT paths are validated at the boundary: a missing or invalid
        // .cube file refuses the call with the reason instead of storing a
        // dead reference that would silently render ungraded.
        let lutRef: LutRef | 'clear' | undefined;
        let lutIntensityArg: number | undefined;
        if (args.lutPath !== undefined) {
          if (args.lutPath === '') {
            lutRef = 'clear';
          } else {
            if (typeof args.lutIntensity !== 'undefined'
              && (!Number.isFinite(args.lutIntensity) || args.lutIntensity < 0 || args.lutIntensity > 1)) {
              return { success: false, error: 'LUT intensity must be between 0 and 1.' };
            }
            const intensity = args.lutIntensity !== undefined
              ? args.lutIntensity
              : sanitizeLutRef(clip.lut)?.intensity ?? 1;
            const validation = validateLutFile(args.lutPath, intensity);
            if (!validation.ok) return { success: false, error: validation.error };
            lutRef = validation.ref;
          }
        } else if (args.lutIntensity !== undefined) {
          if (!Number.isFinite(args.lutIntensity) || args.lutIntensity < 0 || args.lutIntensity > 1) {
            return { success: false, error: 'LUT intensity must be between 0 and 1.' };
          }
          if (!sanitizeLutRef(clip.lut)) {
            return { success: false, error: 'No LUT is set on this clip — pass lutPath to choose one first.' };
          }
          lutIntensityArg = args.lutIntensity;
        }
        const sanitized = sanitizeColorGrade({
          ...(args.brightness !== undefined ? { brightness: args.brightness } : {}),
          ...(args.contrast !== undefined ? { contrast: args.contrast } : {}),
          ...(args.saturation !== undefined ? { saturation: args.saturation } : {}),
          ...(args.hueRotation !== undefined ? { hueRotation: args.hueRotation } : {}),
          ...(args.exposure !== undefined ? { exposure: args.exposure } : {}),
          ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
          ...(args.tint !== undefined ? { tint: args.tint } : {}),
          ...(args.vibrance !== undefined ? { vibrance: args.vibrance } : {}),
          ...(args.highlights !== undefined ? { highlights: args.highlights } : {}),
          ...(args.shadows !== undefined ? { shadows: args.shadows } : {}),
          ...(args.blacks !== undefined ? { blacks: args.blacks } : {}),
          ...(args.whites !== undefined ? { whites: args.whites } : {}),
          ...(args.invertColors !== undefined ? { invertColors: args.invertColors } : {}),
        });
        const receipt = this.editor.applyClipProperties(
          [clip.id],
          clear ? 'Reset color grade' : 'Set color grade',
          (draft) => {
            if (clear) {
              delete draft.brightness;
              delete draft.contrast;
              delete draft.saturation;
              delete draft.hueRotation;
              delete draft.exposure;
              delete draft.temperature;
              delete draft.tint;
              delete draft.vibrance;
              delete draft.highlights;
              delete draft.shadows;
              delete draft.blacks;
              delete draft.whites;
              delete draft.invertColors;
              delete draft.curves;
              delete draft.wheels;
              delete draft.hueCurves;
              delete draft.lut;
              delete draft.blurRadius;
              delete draft.vignette;
              delete draft.grain;
              delete draft.glow;
              return true;
            }
            // A field passed at its default clears it, so a graded clip can
            // return to ungraded without a separate clear call.
            const defaults = { brightness: 0, contrast: 1, saturation: 1, hueRotation: 0, exposure: 0, temperature: 6500, tint: 0, vibrance: 0, highlights: 0, shadows: 0, blacks: 0, whites: 0 } as const;
            for (const field of ['brightness', 'contrast', 'saturation', 'hueRotation', 'exposure', 'temperature', 'tint', 'vibrance', 'highlights', 'shadows', 'blacks', 'whites'] as const) {
              if (args[field] === undefined) continue;
              const value = sanitized[field];
              if (value === undefined) continue;
              if (value === defaults[field]) delete draft[field];
              else draft[field] = value;
            }
            if (args.invertColors === true) draft.invertColors = true;
            else if (args.invertColors === false) delete draft.invertColors;
            if (curvesPatch) {
              // Per-channel merge like upstream GradeState.apply: a provided
              // channel replaces, an omitted one stays, and an empty channel
              // clears it. All-identity drops the field entirely.
              const existing: GradeCurve = sanitizeGradeCurve(draft.curves)
                ?? { master: [], red: [], green: [], blue: [] };
              const merged: GradeCurve = { ...existing, ...curvesPatch };
              const next = isIdentityGradeCurve(merged) ? undefined : merged;
              // Reference-stable no-op: clipsShallowEqual compares object
              // identity, so an identical patch must not rewrite the field.
              if (!gradeCurvesEqual(next, draft.curves)) {
                if (next) draft.curves = next;
                else delete draft.curves;
              }
            }
            if (wheelsPatch) {
              // Per-component merge like the scalar fields: a provided x, y,
              // or m replaces, an omitted one stays. All-identity drops the
              // field entirely, so steering every zone back to default clears
              // the wheels without a separate clear call.
              const existing: GradeWheels = sanitizeGradeWheels(draft.wheels)
                ?? { lift: { x: 0, y: 0, m: 0 }, gamma: { x: 0, y: 0, m: 1 }, gain: { x: 0, y: 0, m: 1 } };
              const merged: GradeWheels = {
                lift: { ...existing.lift, ...wheelsPatch.lift },
                gamma: { ...existing.gamma, ...wheelsPatch.gamma },
                gain: { ...existing.gain, ...wheelsPatch.gain },
              };
              const next = isIdentityGradeWheels(merged) ? undefined : merged;
              // Reference-stable no-op, like the curves stage above.
              if (!gradeWheelsEqual(next, draft.wheels)) {
                if (next) draft.wheels = next;
                else delete draft.wheels;
              }
            }
            if (hueCurvesPatch) {
              // Per-channel merge like the tone curves: a provided channel
              // replaces, an omitted one stays, and an empty channel clears
              // it. All-neutral drops the field entirely.
              const existing: HueCurves = sanitizeHueCurves(draft.hueCurves)
                ?? { hueVsHue: [], hueVsSat: [], hueVsLum: [] };
              const merged: HueCurves = { ...existing, ...hueCurvesPatch };
              const next = isIdentityHueCurves(merged) ? undefined : merged;
              // Reference-stable no-op, like the stages above.
              if (!hueCurvesEqual(next, draft.hueCurves)) {
                if (next) draft.hueCurves = next;
                else delete draft.hueCurves;
              }
            }
            if (lutRef === 'clear') {
              delete draft.lut;
            } else if (lutRef) {
              // Reference-stable no-op, like the stages above: an identical
              // path + intensity rewrites nothing, so the call adds no
              // history entry.
              if (!lutRefsEqual(lutRef, draft.lut)) draft.lut = lutRef;
            } else if (lutIntensityArg !== undefined) {
              // Re-blend the existing LUT (upstream's strength-only call):
              // the boundary already refused a missing LUT.
              const existing = sanitizeLutRef(draft.lut) ?? sanitizeLutRef(clip.lut);
              if (existing) {
                const next = { ...existing, intensity: lutIntensityArg };
                if (!lutRefsEqual(next, draft.lut)) draft.lut = next;
              }
            }
            // Blur radius is scalar-like: 0 clears the field, anything else
            // sets it. An identical value rewrites nothing (no history).
            if (args.blurRadius !== undefined) {
              const clean = sanitizeBlurRadius(args.blurRadius);
              if ((clean ?? null) !== (sanitizeBlurRadius(draft.blurRadius) ?? null)) {
                if (clean === undefined) delete draft.blurRadius;
                else draft.blurRadius = clean;
              }
            }
            if (vignettePatch && Object.keys(vignettePatch).length > 0) {
              // Per-component merge like the wheels: a provided component
              // replaces, an omitted one stays. All-default drops the field
              // entirely, so steering every slider back to default clears
              // the vignette without a separate clear call.
              const merged = { ...(sanitizeVignette(draft.vignette) ?? { ...DEFAULT_VIGNETTE }), ...vignettePatch };
              const next = sanitizeVignette(merged);
              if (!vignettesEqual(next, draft.vignette)) {
                if (next) draft.vignette = next;
                else delete draft.vignette;
              }
            }
            if (grainPatch && Object.keys(grainPatch).length > 0) {
              const merged = { ...(sanitizeGrain(draft.grain) ?? { ...DEFAULT_GRAIN }), ...grainPatch };
              const next = sanitizeGrain(merged);
              if (!grainsEqual(next, draft.grain)) {
                if (next) draft.grain = next;
                else delete draft.grain;
              }
            }
            if (glowPatch && Object.keys(glowPatch).length > 0) {
              const merged = { ...(sanitizeGlow(draft.glow) ?? { ...DEFAULT_GLOW }), ...glowPatch };
              const next = sanitizeGlow(merged);
              if (!glowsEqual(next, draft.glow)) {
                if (next) draft.glow = next;
                else delete draft.glow;
              }
            }
            return true;
          },
        );
        const updated = this.editor.getClips().find((candidate) => candidate.id === clip.id);
        return {
          success: true,
          data: {
            clipId: clip.id,
            changed: receipt.changedClipIds.length > 0,
            brightness: updated?.brightness ?? 0,
            contrast: updated?.contrast ?? 1,
            saturation: updated?.saturation ?? 1,
            hueRotation: updated?.hueRotation ?? 0,
            exposure: updated?.exposure ?? 0,
            temperature: updated?.temperature ?? 6500,
            tint: updated?.tint ?? 0,
            vibrance: updated?.vibrance ?? 0,
            highlights: updated?.highlights ?? 0,
            shadows: updated?.shadows ?? 0,
            blacks: updated?.blacks ?? 0,
            whites: updated?.whites ?? 0,
            invertColors: updated?.invertColors ?? false,
            curves: sanitizeGradeCurve(updated?.curves) ?? null,
            wheels: sanitizeGradeWheels(updated?.wheels) ?? null,
            hueCurves: sanitizeHueCurves(updated?.hueCurves) ?? null,
            lut: sanitizeLutRef(updated?.lut) ?? null,
            blurRadius: sanitizeBlurRadius(updated?.blurRadius) ?? 0,
            vignette: sanitizeVignette(updated?.vignette) ?? null,
            grain: sanitizeGrain(updated?.grain) ?? null,
            glow: sanitizeGlow(updated?.glow) ?? null,
            cleared: !updated || (!hasColorGrade(updated) && !hasEffects(updated)),
          },
        };
      }

      case 'transcribe_audio': {
        const asset = this.editor.getMedia().find((m) => m.id === args.assetId);
        if (!asset) return { success: false, error: 'Asset not found.' };

        // Engine resolution (#39 local half / #287): per-job `engine`, else
        // the persisted choice; `auto` prefers local when its binary + model
        // are present, then the custom endpoint, then cloud BYOK. Explicit
        // engines never fall back — the resolver refuses instead.
        let transcribeConfig: {
          baseUrl?: string; apiKey?: string; model?: string;
          engine?: unknown; localModel?: unknown; localBinaryPath?: string;
        } = {};
        try {
          const { getTranscribeConfig } = await import('../media/transcribe-config');
          transcribeConfig = getTranscribeConfig();
        } catch { /* electron absent in tests */ }
        const customRuntime = transcribeConfig.baseUrl && transcribeConfig.apiKey
          ? { baseUrl: transcribeConfig.baseUrl, apiKey: transcribeConfig.apiKey }
          : null;
        // An explicit local job never consults cloud credentials at all —
        // not just "no fallback request", no key lookup either.
        const localOnly = normalizeSttEngine(args.engine ?? transcribeConfig.engine) === 'local';
        const cloudRuntime = localOnly
          ? customRuntime
          : (customRuntime
            ?? await (this.deps.getTranscriptionRuntime?.() ?? Promise.resolve(null)));

        const localModelId = isKnownLocalModel(args.model)
          ? args.model
          : (typeof transcribeConfig.localModel === 'string' ? transcribeConfig.localModel : DEFAULT_LOCAL_MODEL);
        let localDir: string | null = null;
        try {
          localDir = await (this.deps.getLocalSttDir?.() ?? defaultLocalSttDir());
        } catch { /* unavailable host */ }
        let localAvailability = {
          binaryPresent: false,
          binaryMissingOverride: false,
          modelId: localModelId,
          modelPresent: false,
        };
        if (localDir) {
          const probe = await probeLocalBinary({
            userDataDir: localDir,
            override: transcribeConfig.localBinaryPath,
          });
          const modelPath = resolveLocalSttPaths(localDir).modelPath(localModelId);
          localAvailability = {
            binaryPresent: probe.found,
            binaryMissingOverride: probe.missingOverride,
            modelId: localModelId,
            modelPresent: !!modelPath && fsSync.existsSync(modelPath),
          };
        }

        const resolution = resolveSttEngine(
          { requested: args.engine, language: args.language, cloudAvailable: !!cloudRuntime },
          transcribeConfig,
          localAvailability,
        );
        if (resolution.kind === 'refusal') {
          return { success: false, error: resolution.error };
        }

        let transcription: TranscriptionResult;
        if (resolution.kind === 'local') {
          const runLocal = this.deps.runLocalTranscription ?? ((input) => runWhisperLocal({
            userDataDir: localDir,
            binaryOverride: transcribeConfig.localBinaryPath,
            audioPath: input.audioPath,
            language: input.language,
            modelId: input.modelId,
          }));
          try {
            transcription = await runLocal({
              audioPath: asset.path,
              language: typeof args.language === 'string' ? args.language : undefined,
              modelId: resolution.modelId,
            });
          } catch (err: unknown) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
          }
        } else {
          const runtime = resolution.kind === 'custom' ? customRuntime : cloudRuntime;
          if (!runtime) {
            return { success: false, error: 'The transcription runtime became unavailable — try again.' };
          }
          if (resolution.kind === 'custom') {
            args = { ...args, model: args.model ?? transcribeConfig.model };
          }
          try {
            const { transcribeAudio } = await import('./transcribe');
            transcription = await transcribeAudio(runtime, asset.path, {
              model: args.model,
              language: args.language,
            });
          } catch (err: unknown) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        if (transcription.words.length === 0 && transcription.segments.length === 0) {
          return {
            success: true,
            data: { cues: 0, text: transcription.text, note: 'Transcription returned no timed words — nothing was placed.' },
          };
        }

        const planOptions = normalizeCaptionPlanOptions({
          ...(args.maxWordsPerCue !== undefined ? { maxWordsPerCue: args.maxWordsPerCue } : {}),
          ...(args.maxCharsPerLine !== undefined ? { maxCharsPerLine: args.maxCharsPerLine } : {}),
          ...(args.maxLines !== undefined ? { maxLines: args.maxLines } : {}),
          ...(args.pauseBreakSec !== undefined ? { pauseBreakSec: args.pauseBreakSec } : {}),
        });
        const cues = planCaptions(transcription.words, planOptions);
        // Anchored on the source asset, so cues land over the clip the speech
        // is in rather than at frame 0 (see shared/captions/apply.ts).
        const applied = applyCaptionCues(this.editor, cues, { assetId: asset.id });

        return {
          success: true,
          data: {
            cues: applied.count,
            trackId: applied.trackId,
            words: transcription.words.length,
            model: transcription.model,
            previewText: cues[0]?.text ?? '',
          },
        };
      }

      case 'apply_layout': {
        try {
          const count = this.editor.applyLayout(args.clipIds, args.preset);
          return {
            success: true,
            data: {
              preset: args.preset,
              clipsArranged: count,
              requested: args.clipIds.length,
            },
          };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Layout application failed.',
          };
        }
      }

      case 'generate_media': {        const configured = configuredProvidersFor(args.type);
        if (configured.length === 0) {
          return {
            success: false,
            error: `No generation provider with an API key supports ${args.type}. Add a key under Settings → Generation (providers: ${listGenerationProviders().map((p) => p.id).join(', ')}).`,
          };
        }
        const provider = (args.providerId && configured.find((p) => p.id === args.providerId))
          ?? configured[0]!;
        const modelId = args.modelId ?? provider.getModels(args.type)[0];

        // A reference image is validated against the resolved model before the
        // request exists, so a refused path costs no provider call and leaves
        // the project untouched. Omitted means text-to-image exactly as before.
        let referenceImagePath: string | undefined;
        if (args.referenceImagePath !== undefined) {
          const reference = validateReferenceImage(args.referenceImagePath, {
            type: args.type,
            providerName: provider.name,
            model: modelId,
          });
          if (!reference.ok) return { success: false, error: reference.error };
          referenceImagePath = reference.path;
        }

        // The generated file lands in the generation cache; import it as a
        // first-class library asset so the model can place it like anything
        // else. A probe failure still imports nothing but reports cleanly.
        const result = await runGeneration(
          {
            type: args.type,
            prompt: args.prompt,
            provider: provider.id,
            durationSeconds: args.durationSeconds,
            width: args.width,
            height: args.height,
            negativePrompt: args.negativePrompt,
            ...(referenceImagePath ? { referenceImagePath } : {}),
            extra: { model: modelId },
          },
          { timeoutMs: GENERATION_TIMEOUT_MS },
        );
        if (result.status !== 'completed' || !result.outputPath) {
          return {
            success: false,
            error: `Generation failed: ${result.error ?? 'provider returned no output'}`,
          };
        }

        try {
          const probed = await probeMedia(result.outputPath);
          // The probe result carries technical metadata; the library asset
          // adds identity and audit fields.
          const assetId = nanoid();
          this.editor.addMedia({
            id: assetId,
            addedAt: new Date().toISOString(),
            ...probed,
            duration: Math.max(
              0,
              secondsToProjectFrames(probed.duration, this.editor.getProject().settings.fps),
            ),
            generatedBy: {
              provider: provider.id,
              model: modelId,
              ...(typeof result.costCredits === 'number' && Number.isFinite(result.costCredits)
                ? { costCredits: result.costCredits }
                : {}),
              ...(referenceImagePath ? { referenceImagePath } : {}),
            },
          });
          return {
            success: true,
            data: {
              assetId,
              path: probed.path,
              filename: probed.filename,
              provider: provider.id,
              model: modelId,
              durationSec: probed.duration,
              ...(referenceImagePath ? { referenceImagePath } : {}),
            },
          };
        } catch (err: unknown) {
          return {
            success: false,
            error: `Generated file could not be probed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      case 'describe_media': {
        const asset = this.editor.getMedia().find((m) => m.id === args.assetId);
        if (!asset) return { success: false, error: 'Asset not found.' };
        if (asset.type === 'audio') {
          return { success: false, error: 'Audio assets have no frames to describe.' };
        }
        // An injected null (tests, headless) means "no provider" and is
        // respected; the Electron store is only consulted when no injector
        // was provided at all.
        let runtime = this.deps.getVisionRuntime
          ? await this.deps.getVisionRuntime()
          : null;
        if (!runtime && !this.deps.getVisionRuntime) {
          try {
            const { getVisionRuntime } = await import('./ipc-vision');
            runtime = await getVisionRuntime();
          } catch { /* electron absent in tests */ }
        }
        if (!runtime) {
          return {
            success: false,
            error: 'No vision-capable provider with an API key is configured. Add one under AI Settings.',
          };
        }
        // Lightweight frame source: the tile thumbnail when it exists on
        // disk, the image file itself for stills, otherwise a single capped
        // decode (never the full video) — the same source the media tile
        // shows, so the model describes what the user sees.
        let imagePath: string | null = null;
        try {
          if (asset.thumbnailPath && fsSync.existsSync(asset.thumbnailPath)) {
            imagePath = asset.thumbnailPath;
          } else if (asset.type === 'image') {
            imagePath = asset.path;
          } else {
            const { getFrameDecoder } = await import('../media/frame-decoder');
            const width = 640;
            const height = Math.max(
              90,
              Math.round((width / (asset.width ?? 16)) * (asset.height ?? 9)),
            );
            const decoded = await getFrameDecoder().getFrame({
              assetPath: asset.path,
              width,
              height,
              sourceSeconds: 1,
            });
            if (!decoded?.data) {
              return { success: false, error: 'Could not decode a frame — check the source file is readable.' };
            }
            let baseDir: string;
            try {
              type ElectronAppHost = { app?: { getPath(name: string): string }; default?: { app?: { getPath(name: string): string } } };
              const electronModule = (await import('electron')) as unknown as ElectronAppHost;
              const app = electronModule.app ?? electronModule.default?.app;
              baseDir = app ? app.getPath('userData') : path.join(os.tmpdir(), 'palmier-inspect-frames');
            } catch {
              baseDir = path.join(os.tmpdir(), 'palmier-inspect-frames');
            }
            const hash = createHash('sha1')
              .update(`describe|${asset.path}|${width}`)
              .digest('hex')
              .slice(0, 12);
            const outPath = inspectFramePath(baseDir, hash);
            await rgbaToPng(decoded.data, width, height, outPath);
            imagePath = outPath;
          }
        } catch (err: unknown) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
        try {
          const runDescribe =
            this.deps.describeImage
            ?? (await import('./describe')).describeImage;
          const { truncateForReceipt } = await import('./describe');
          const out = await runDescribe(runtime, imagePath!);
          // One undoable media-field write, same path as the UI Describe
          // button (ReplaceMediaCommand via setAssetDescription).
          this.editor.setAssetDescription(asset.id, out.description);
          return {
            success: true,
            data: {
              assetId: asset.id,
              description: truncateForReceipt(out.description),
              fullLength: out.description.length,
              model: out.model,
              provider: out.provider,
              updated: true,
            },
          };
        } catch (err: unknown) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      default:
        return { success: false, error: `Unhandled tool: ${name}` };
    }
  }

  /**
   * Scoped removal (upstream PR #426's `clipIds` contract): the selected
   * audio clips are the detection sources, their silence maps to timeline
   * ranges, and one ripple transaction per anchor track cuts them — linked
   * partners and sync-locked tracks ride along. Detection runs before any
   * edit, so a missing source refuses the whole request instead of
   * half-editing it; one detector call per distinct source path.
   */
  private async removeSilenceScoped(clipIds: string[], config: SilenceConfig): Promise<ToolResult> {
    let resolution: SilenceScopeResolution;
    try {
      resolution = resolveSilenceScope(this.editor.getClips(), clipIds);
    } catch (err: unknown) {
      return { success: false, error: `remove_silence: ${err instanceof Error ? err.message : String(err)}` };
    }
    return this.removeSilenceViaRipple(resolution.scopes, config, 'in the selected clips', clipIds);
  }

  /** Whole-timeline removal: every audio track swept in track order (upstream's no-argument form). */
  private async removeSilenceTimeline(config: SilenceConfig): Promise<ToolResult> {
    const resolution = resolveSilenceScope(this.editor.getClips());
    return this.removeSilenceViaRipple(resolution.scopes, config, 'on the timeline');
  }

  private async removeSilenceViaRipple(
    scopes: SilenceTrackScope[],
    config: SilenceConfig,
    scopeLabel: string,
    clipIds?: string[],
  ): Promise<ToolResult> {
    const fps = this.editor.getProject().settings.fps;
    const initialClipsById = new Map(this.editor.getClips().map((clip) => [clip.id, clip]));
    const mediaById = new Map(this.editor.getMedia().map((asset) => [asset.id, asset]));

    // Analyze every source before the first ripple. A missing asset or detector
    // failure must not leave earlier tracks edited while the call reports
    // failure. Keep the cache outside the scope loop so a source shared by
    // multiple tracks is read once for the whole operation.
    const detectedByPath = new Map<string, SilentRange[]>();
    const sourceRangesByClip = new Map<string, SilentRange[]>();
    for (const scope of scopes) {
      for (const clipId of scope.clipIds) {
        const clip = initialClipsById.get(clipId);
        if (!clip) {
          return { success: false, error: `Source media for clip ${clipId} not found.` };
        }
        const asset = mediaById.get(clip.assetId);
        if (!asset) {
          return { success: false, error: `Source media for clip ${clipId} not found.` };
        }
        if (!detectedByPath.has(asset.path)) {
          try {
            detectedByPath.set(asset.path, await detectSilenceForFile(asset.path, config));
          } catch (err: unknown) {
            return { success: false, error: `Silence detection failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        }
        sourceRangesByClip.set(clipId, detectedByPath.get(asset.path)!);
      }
    }

    let sections = 0;
    let removedFrames = 0;
    let editedAnyTrack = false;
    const notes: string[] = [];
    const omitted: OmittedSilenceRange[] = [];

    for (const scope of scopes) {
      // A preceding ripple may have shifted this track (or a sync-locked
      // follower) left. Re-read the clip positions for every pass and map the
      // cached source ranges onto the current clip window; never reuse the
      // pre-ripple timeline snapshot.
      const currentClipsById = new Map(this.editor.getClips().map((clip) => [clip.id, clip]));
      const detection: RippleRange[] = [];
      for (const clipId of scope.clipIds) {
        const clip = currentClipsById.get(clipId);
        if (!clip) continue;
        // Spans that meet no part of the clip are kept for the receipt rather
        // than dropped: the detector reports the whole asset, the clip shows a
        // trimmed part of it, and "no dead air" over found silence is false.
        const mapping = mapSilenceRangesToTimeline(
          clip,
          fps,
          sourceRangesByClip.get(clipId) ?? [],
        );
        detection.push(...mapping.ranges);
        omitted.push(...mapping.omitted);
      }

      const merged = mergeRippleRanges(detection);
      if (merged.length === 0) continue;

      const tracksById = new Map(
        this.editor.getProject().timeline.tracks.map((track) => [track.id, track]),
      );
      const track = tracksById.get(scope.trackId);
      if (!track || track.locked) {
        if (editedAnyTrack) {
          notes.push('A later track refused: its anchor is locked. Earlier tracks were already edited.');
          break;
        }
        return { success: false, error: 'remove_silence refused: the anchor track is locked.' };
      }

      const report = this.editor.rippleDeleteRanges(scope.trackId, merged);
      if (!report) {
        // The anchor was pre-checked; null here means the engine refused or
        // nothing changed. A locked sync-locked track elsewhere blocks the
        // shift for every pass, which must surface rather than skip quietly.
        const shiftsLockedTrack = [...tracksById.values()].some(
          (candidate) => candidate.locked && candidate.syncLocked !== false && candidate.id !== scope.trackId,
        );
        if (!shiftsLockedTrack) continue;
        const reason = 'the ripple shifts a locked track';
        if (editedAnyTrack) {
          notes.push(`A later track refused: ${reason}. Earlier tracks were already edited.`);
          break;
        }
        return { success: false, error: `remove_silence refused: ${reason}.` };
      }
      sections += merged.length;
      removedFrames += report.removedFrames;
      editedAnyTrack = true;
    }

    // Named before the "no dead air" branch, because silence that was found and
    // then left in place is not the same fact as audio with no quiet sections.
    const omittedCounts = omissionCounts(omitted);
    if (omittedCounts) notes.push(omissionNote(sections > 0, omittedCounts));

    if (sections === 0 && notes.length === 0) {
      return {
        success: true,
        data: {
          removed: 0,
          ranges: 0,
          sectionsRemoved: 0,
          removedFrames: 0,
          minimumPauseSeconds: config.minSilenceSec,
          speechPaddingSeconds: config.edgePaddingSec,
          ...(clipIds ? { clipIds } : {}),
          message: `No dead air ${scopeLabel}. Speech analysis may still be running, or the audio has no quiet non-speech sections.`,
        },
      };
    }

    return {
      success: true,
      data: {
        removed: sections,
        ranges: sections,
        sectionsRemoved: sections,
        removedFrames,
        minimumPauseSeconds: config.minSilenceSec,
        speechPaddingSeconds: config.edgePaddingSec,
        ...(clipIds ? { clipIds } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      },
    };
  }
}



