/**
 * Tool Executor — runs tool calls against the EditorController.
 * Shared by both the in-app agent and the MCP server.
 */

import { z } from 'zod';
import { tools, getToolByName } from './tools';
import { clampFrame } from '../../shared/utils/safe-number';
import { detectSilenceForFile } from '../media/audio-envelope';
import { DEFAULT_SILENCE_CONFIG } from '../../shared/audio/silence-detector';
import type { EditorController } from '../../shared/editor/controller';

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
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
      case 'get_timeline':
        return { success: true, data: this.editor.getTimeline() };

      case 'get_clips': {
        let clips = this.editor.getClips();
        if (args.trackId) {
          clips = clips.filter((c) => c.trackId === args.trackId);
        }
        return { success: true, data: clips };
      }

      case 'get_media':
        return { success: true, data: this.editor.getMedia() };

      // ── Write operations ──────────────────────────────────────────────────
      case 'add_clip': {
        const clipId = this.editor.addClip({
          assetId: args.assetId,
          trackId: args.trackId,
          startFrame: clampFrame(args.startFrame),
          durationFrames: args.durationFrames === undefined ? undefined : clampFrame(args.durationFrames, 1),
        });
        return { success: true, data: { clipId } };
      }

      case 'remove_clip':
        this.editor.removeClip(args.clipId);
        return { success: true, data: { removed: args.clipId } };

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

        const config = {
          ...DEFAULT_SILENCE_CONFIG,
          ...(args.thresholdDb !== undefined ? { thresholdDb: args.thresholdDb } : {}),
          ...(args.minSilenceSeconds !== undefined ? { minSilenceSec: args.minSilenceSeconds } : {}),
          ...(args.edgePaddingSeconds !== undefined ? { edgePaddingSec: args.edgePaddingSeconds } : {}),
        };

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
