/**
 * Tool Executor â€” runs tool calls against the EditorController.
 * Shared by both the in-app agent and the MCP server.
 */

import { z } from 'zod';
import { execFile } from 'child_process';
import fsSync from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { nanoid } from 'nanoid';
import { tools, getToolByName } from './tools';
import { clampFrame } from '../../shared/utils/safe-number';
import { detectSilenceForFile } from '../media/audio-envelope';
import { loadSilenceSettings } from '../media/silence-settings';
import { probeMedia } from '../media/probe';
import {
  configuredProvidersFor,
  listGenerationProviders,
  runGeneration,
} from '../generation/manager';

/** Bounded wait for a provider render; video gens can be minutes. */
const GENERATION_TIMEOUT_MS = 600_000;
import { resolveSilenceConfig, type SilenceConfig, type SilentRange } from '../../shared/audio/silence-detector';
import {
  resolveSilenceScope,
  timelineSilenceRanges,
  type SilenceScopeResolution,
  type SilenceTrackScope,
} from '../../shared/editor/silence-scoping';
import { mergeRippleRanges, type RippleRange } from '../../shared/editor/ripple';
import { sanitizeCrop } from '../../shared/media/source-crop';
import { sanitizeMotion } from '../../shared/media/motion';
import { mergeChromaKey } from '../../shared/editor/chroma-key';
import { sanitizeVolumeKeyframes } from '../../shared/audio/volume-keyframes';
import { planCaptions } from '../../shared/captions/planner';
import { parseFcpxml } from '../../shared/fcpxml/importer';
import { layoutSlotIds } from '../../shared/editor/grid-layout';
import { exportFcpxml } from '../../shared/fcpxml/exporter';
import { createHash } from 'crypto';
import { inspectFramePath, rgbaToPng } from '../media/frame-png';
import {
  MAX_CANVAS_EDGE,
  aspectRatioLabel,
  findQualityPreset,
  parseAspectRatio,
  resolutionForAspectRatio,
  resolutionForQuality,
} from '../../shared/project/aspect-ratio';
import type { ProjectSettings } from '../../shared/types/project';
import type { EditorController } from '../../shared/editor/controller';

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
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

/** Injected capability seams â€” Electron-bound defaults live in ./ipc. */
export interface ToolExecutorDeps {
  /**
   * OpenAI-compatible runtime (baseUrl + decrypted key) for audio
   * transcription. Null = no usable provider configured.
   */
  getTranscriptionRuntime?: () => Promise<{ baseUrl: string; apiKey: string } | null>;
}

export class ToolExecutor {
  private deps: ToolExecutorDeps;
  constructor(private editor: EditorController, deps: ToolExecutorDeps = {}) {
    this.deps = deps;
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

  private async dispatch(name: string, args: any): Promise<ToolResult> {
    switch (name) {
      // â”€â”€ Read operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      case 'get_timeline': {
        // The tool contract promises project settings alongside the timeline, and
        // set_project_settings is only useful if the agent can read the canvas
        // back (upstream #417).
        const project = this.editor.getProject();
        return {
          success: true,
          data: {
            ...project.timeline,
            settings: project.settings,
            width: project.settings.width,
            height: project.settings.height,
            fps: project.settings.fps,
            aspectRatio: aspectRatioLabel(project.settings.width, project.settings.height),
          },
        };
      }

      case 'get_clips': {
        let clips = this.editor.getClips();
        if (args.trackId) {
          clips = clips.filter((c) => c.trackId === args.trackId);
        }
        return { success: true, data: clips };
      }

      case 'get_media':
        return { success: true, data: this.editor.getMedia() };

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
          const hasStyle = args.fontSize !== undefined || args.color !== undefined
            || args.bold !== undefined || args.fontFamily !== undefined
            || args.backgroundColor !== undefined;
          if (args.text !== undefined) {
            const ok = this.editor.setTitleText(args.clipId, args.text);
            if (!ok) {
              return { success: false, error: 'Clip not found, is not a title, or text is invalid.' };
            }
          }
          const styleFields = [args.fontSize, args.color, args.bold, args.fontFamily, args.backgroundColor, args.backgroundPadding, args.lineSpacing, args.fontCase, args.fillMode, args.blurRadius, args.tiltX, args.tiltY];
          if (styleFields.some((v) => v !== undefined)) {
            this.editor.applyClipProperties([args.clipId], 'Style title', (draft) => {
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
              return true;
            });
          }
          return { success: true, data: { updated: args.clipId } };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Text update failed.',
          };
        }
      }

      case 'set_clip_pan': {
        try {
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

      // â”€â”€ Write operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

      case 'move_clip':
        this.editor.moveClip(args.clipId, clampFrame(args.startFrame), args.trackId);
        return { success: true, data: { moved: args.clipId } };

      case 'trim_clip':
        this.editor.trimClip(args.clipId, clampFrame(args.inPoint), clampFrame(args.outPoint, 1));
        return { success: true, data: { trimmed: args.clipId } };

      case 'split_clip': {
        const newClipId = this.editor.splitClip(args.clipId, clampFrame(args.atFrame));
        if (!newClipId) {
          return { success: false, error: 'Split failed â€” invalid frame or clip not found.' };
        }
        return { success: true, data: { originalClipId: args.clipId, newClipId } };
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
            error: 'Blend mode not applied â€” clip not found or is an audio clip (audio has no compositing stage).',
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
        // socket is another caller â€” an out-of-range threshold would otherwise
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
          const removed = this.editor.removeSilence(args.clipId, ranges);
          return { success: true, data: { removed, ranges: ranges.length } };
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
            error: 'Cross-dissolve failed â€” clips must be adjacent on the same track and longer than the dissolve.',
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
        return undone
          ? { success: true, data: { action: 'undo' } }
          : { success: false, error: 'Nothing to undo.' };
      }

      case 'redo': {
        const redone = this.editor.redo();
        return redone
          ? { success: true, data: { action: 'redo' } }
          : { success: false, error: 'Nothing to redo.' };
      }

      case 'export_project':
        // Phase 4 â€” placeholder
        return { success: false, error: 'Export not yet implemented (Phase 4).' };

      case 'import_fcpxml': {
        const xml = await fs.readFile(args.path, 'utf8');
        const plan = parseFcpxml(xml);
        if (!plan.fps) {
          return { success: false, error: 'The file has no usable <format frameDuration>; frame mapping is undefined.' };
        }
        const fpsScale = this.editor.getProject().settings.fps / plan.fps;
        const toProjectFrames = (frames: number) => Math.round(frames * fpsScale);

        // Assets: probe each unique path into the library; missing files are
        // reported and their clips skipped rather than failing the import.
        const assetIdByPath = new Map<string, string>();
        const offline: string[] = [];
        for (const asset of plan.assets) {
          if (!fsSync.existsSync(asset.path)) {
            offline.push(asset.path);
            continue;
          }
          try {
            const probed = await probeMedia(asset.path);
            const id = nanoid();
            this.editor.addMedia({ id, addedAt: new Date().toISOString(), ...probed });
            assetIdByPath.set(asset.path, id);
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
            this.editor.applyClipProperties([titleId], 'Import title style', (draft) => {
              if (clip.colorHex) draft.titleColor = clip.colorHex;
              if (clip.fontSizePx) draft.titleSizeRatio = clip.fontSizePx / this.editor.getProject().settings.height;
              if (clip.fontFamily) draft.titleFontFamily = clip.fontFamily;
              if (clip.alignment) draft.titleAlign = clip.alignment;
              return true;
            });
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
        const xmlOut = exportFcpxml(this.editor.getProject());
        await fs.writeFile(args.path, xmlOut, 'utf8');
        return { success: true, data: { path: args.path } };
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
          return { success: false, error: `Could not decode a frame at ${atSeconds}s â€” check the offset against the asset duration.` };
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
        if (clip.type !== 'video' && clip.type !== 'image') {
          return { success: false, error: 'Position animation applies to video and image clips only (titles are static in v1).' };
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

      case 'transcribe_audio': {
        const asset = this.editor.getMedia().find((m) => m.id === args.assetId);
        if (!asset) return { success: false, error: 'Asset not found.' };

        // Preference order (#287): an explicit custom STT server, then the
        // AI provider runtime.
        let runtime: { baseUrl: string; apiKey: string } | null = null;
        try {
          const { getTranscribeConfig } = await import('../media/transcribe-config');
          const override = getTranscribeConfig();
          if (override.baseUrl && override.apiKey) {
            runtime = { baseUrl: override.baseUrl, apiKey: override.apiKey };
            args = { ...args, model: args.model ?? override.model };
          }
        } catch { /* electron absent in tests */ }
        if (!runtime) {
          runtime = await (this.deps.getTranscriptionRuntime?.() ?? Promise.resolve(null));
        }
        if (!runtime) {
          return {
            success: false,
            error: 'No OpenAI-compatible provider with an API key is configured for transcription. Add one under AI Settings.',
          };
        }

        const { transcribeAudio } = await import('./transcribe');
        const transcription = await transcribeAudio(runtime, asset.path, {
          model: args.model,
          language: args.language,
        });
        if (transcription.words.length === 0 && transcription.segments.length === 0) {
          return {
            success: true,
            data: { cues: 0, text: transcription.text, note: 'Transcription returned no timed words â€” nothing was placed.' },
          };
        }

        const cues = planCaptions(transcription.words);
        const fps = this.editor.getProject().settings.fps;
        const trackId = this.editor.addTrack('video');

        let placed = 0;
        for (const cue of cues) {
          const startFrame = Math.max(0, Math.round(cue.startSec * fps));
          const durationFrames = Math.max(
            1,
            Math.round(cue.endSec * fps) - startFrame,
          );
          this.editor.addTitleClip({
            trackId,
            text: cue.text,
            startFrame,
            durationFrames,
          });
          placed += 1;
        }

        return {
          success: true,
          data: {
            cues: placed,
            trackId,
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
              slots: layoutSlotIds(args.preset),
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
            error: `No generation provider with an API key supports ${args.type}. Add a key under Settings â†’ Generation (providers: ${listGenerationProviders().map((p) => p.id).join(', ')}).`,
          };
        }
        const provider = (args.providerId && configured.find((p) => p.id === args.providerId))
          ?? configured[0]!;
        const modelId = args.modelId ?? provider.getModels(args.type)[0];

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
            generatedBy: {
              provider: provider.id,
              model: modelId,
              costCredits: result.costCredits,
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
            },
          };
        } catch (err: unknown) {
          return {
            success: false,
            error: `Generated file could not be probed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      default:
        return { success: false, error: `Unhandled tool: ${name}` };
    }
  }

  /**
   * Scoped removal (upstream PR #426's `clipIds` contract): the selected
   * audio clips are the detection sources, their silence maps to timeline
   * ranges, and one ripple transaction per anchor track cuts them â€” linked
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
    const tracksById = new Map(
      this.editor.getProject().timeline.tracks.map((track) => [track.id, track]),
    );
    const clipsById = new Map(this.editor.getClips().map((clip) => [clip.id, clip]));
    const mediaById = new Map(this.editor.getMedia().map((asset) => [asset.id, asset]));

    let sections = 0;
    let removedFrames = 0;
    let editedAnyTrack = false;
    const notes: string[] = [];

    for (const scope of scopes) {
      const detection: RippleRange[] = [];
      const detectedByPath = new Map<string, SilentRange[]>();
      for (const clipId of scope.clipIds) {
        const clip = clipsById.get(clipId)!;
        const asset = mediaById.get(clip.assetId);
        if (!asset) {
          return { success: false, error: `Source media for clip ${clipId} not found.` };
        }
        let ranges = detectedByPath.get(asset.path);
        if (!ranges) {
          try {
            ranges = await detectSilenceForFile(asset.path, config);
          } catch (err: unknown) {
            return { success: false, error: `Silence detection failed: ${err instanceof Error ? err.message : String(err)}` };
          }
          detectedByPath.set(asset.path, ranges);
        }
        detection.push(...timelineSilenceRanges(clip, fps, ranges));
      }

      const merged = mergeRippleRanges(detection);
      if (merged.length === 0) continue;

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
          (track) => track.locked && track.syncLocked !== false && track.id !== scope.trackId,
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



