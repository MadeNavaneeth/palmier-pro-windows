/**
 * Tool Executor — runs tool calls against the EditorController.
 * Shared by both the in-app agent and the MCP server.
 */

import { z } from 'zod';
import { tools, getToolByName } from './tools';
import { clampFrame } from '../../shared/utils/safe-number';
import { detectSilenceForFile } from '../media/audio-envelope';
import { loadSilenceSettings } from '../media/silence-settings';
import { resolveSilenceConfig } from '../../shared/audio/silence-detector';
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

export class ToolExecutor {
  constructor(private editor: EditorController) {}

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
      // ── Read operations ───────────────────────────────────────────────────
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

      // ── Write operations ──────────────────────────────────────────────────
      case 'add_clip': {
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
          return { success: false, error: 'Split failed — invalid frame or clip not found.' };
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
            error: 'Blend mode not applied — clip not found or is an audio clip (audio has no compositing stage).',
          };
        }
        return { success: true, data: { clipId: args.clipId, blendMode: args.blendMode } };
      }

      case 'remove_silence': {
        const clip = this.editor.getClips().find((c) => c.id === args.clipId);
        if (!clip) return { success: false, error: 'Clip not found.' };
        const asset = this.editor.getMedia().find((m) => m.id === clip.assetId);
        if (!asset) return { success: false, error: 'Source media for clip not found.' };

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
        // Phase 4 — placeholder
        return { success: false, error: 'Export not yet implemented (Phase 4).' };

      case 'generate_media':
        // Phase 7 — placeholder
        return { success: false, error: 'Generation not yet implemented (Phase 7).' };

      default:
        return { success: false, error: `Unhandled tool: ${name}` };
    }
  }
}
