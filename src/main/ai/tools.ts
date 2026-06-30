/**
 * AI Tool Contract — the Zod-defined tool schemas that both the in-app
 * agent and the MCP server share. One contract, two transports.
 *
 * This is the core "built for AI" design inherited from Palmier Pro:
 * the agent operates the editor through the same command surface a human uses.
 */

import { z } from 'zod';
import { MAX_FRAME } from '../../shared/utils/safe-number';
import { BLEND_MODES } from '../../shared/types/blend-mode';

// ─── Shared numeric schemas ──────────────────────────────────────────────────
// Every frame-typed argument is bounded: finite, integer, non-negative, and
// capped at MAX_FRAME. This closes the overflow crash class (upstream #200)
// at the validation boundary, before any value reaches loop/array math.

/** A timeline/source frame index: finite integer in [0, MAX_FRAME]. */
const frameSchema = z
  .number()
  .finite()
  .int()
  .min(0)
  .max(MAX_FRAME);

/** A positive duration in frames: finite integer in [1, MAX_FRAME]. */
const durationSchema = z
  .number()
  .finite()
  .int()
  .min(1)
  .max(MAX_FRAME);

// ─── Tool Definitions ────────────────────────────────────────────────────────

export const tools = {
  // ── Timeline inspection ──────────────────────────────────────────────────────
  getTimeline: {
    name: 'get_timeline',
    description: 'Read the current timeline state: tracks, clips, playhead position, and project settings.',
    parameters: z.object({}),
  },

  getClips: {
    name: 'get_clips',
    description: 'List all clips on the timeline with their properties (position, duration, track, transforms).',
    parameters: z.object({
      trackId: z.string().optional().describe('Filter clips to a specific track ID.'),
    }),
  },

  getMedia: {
    name: 'get_media',
    description: 'List all media assets in the project bin.',
    parameters: z.object({}),
  },

  // ── Editing commands ─────────────────────────────────────────────────────────
  addClip: {
    name: 'add_clip',
    description: 'Add a media asset to the timeline at a given position.',
    parameters: z.object({
      assetId: z.string().describe('The ID of the media asset to place on the timeline.'),
      trackId: z.string().describe('Target track ID.'),
      startFrame: frameSchema.describe('Frame position where the clip should start.'),
      durationFrames: durationSchema.optional().describe('Duration in frames. Defaults to asset duration.'),
    }),
  },

  removeClip: {
    name: 'remove_clip',
    description: 'Remove a clip from the timeline by ID.',
    parameters: z.object({
      clipId: z.string().describe('The ID of the clip to remove.'),
    }),
  },

  moveClip: {
    name: 'move_clip',
    description: 'Move a clip to a new position on the timeline.',
    parameters: z.object({
      clipId: z.string().describe('The clip to move.'),
      startFrame: frameSchema.describe('New start frame position.'),
      trackId: z.string().optional().describe('Move to a different track (optional).'),
    }),
  },

  trimClip: {
    name: 'trim_clip',
    description: 'Trim a clip by setting new in/out points (source-relative frames).',
    parameters: z.object({
      clipId: z.string().describe('The clip to trim.'),
      inPoint: frameSchema.describe('New source in-point (frame).'),
      outPoint: durationSchema.describe('New source out-point (frame).'),
    }),
  },

  splitClip: {
    name: 'split_clip',
    description: 'Split a clip into two at the specified timeline frame.',
    parameters: z.object({
      clipId: z.string().describe('The clip to split.'),
      atFrame: frameSchema.describe('Timeline frame at which to split.'),
    }),
  },

  // ── Track management ─────────────────────────────────────────────────────────
  addTrack: {
    name: 'add_track',
    description: 'Create a new track on the timeline.',
    parameters: z.object({
      type: z.enum(['video', 'audio']).describe('Track type.'),
      name: z.string().optional().describe('Display name for the track.'),
    }),
  },

  // ── Playback / navigation ────────────────────────────────────────────────────
  setPlayhead: {
    name: 'set_playhead',
    description: 'Move the playhead to a specific frame.',
    parameters: z.object({
      frame: frameSchema.describe('Target frame.'),
    }),
  },

  // ── Compositing ──────────────────────────────────────────────────────────────
  setClipBlendMode: {
    name: 'set_clip_blend_mode',
    description:
      'Set how a visual clip blends with the layers below it (multiply, screen, overlay, etc.). Use "normal" to reset. Only valid for video/image/title clips — audio clips are rejected.',
    parameters: z.object({
      clipId: z.string().describe('The clip to restyle.'),
      blendMode: z
        .enum(BLEND_MODES as unknown as [string, ...string[]])
        .describe('Blend mode. "normal" = standard source-over.'),
    }),
  },

  removeSilence: {
    name: 'remove_silence',
    description:
      'Detect and remove silent gaps in a clip with audio, rippling the remaining clips left to close the gaps. Runs on-device (no transcription). Works on audio or video clips.',
    parameters: z.object({
      clipId: z.string().describe('The clip to de-silence.'),
      thresholdDb: z.number().finite().min(-120).max(0).optional().describe('Loudness below this (dBFS) counts as silence. Default -35.'),
      minSilenceSeconds: z.number().finite().min(0.05).max(60).optional().describe('Ignore silent gaps shorter than this. Default 0.5.'),
      edgePaddingSeconds: z.number().finite().min(0).max(5).optional().describe('Padding kept around speech so transients are not clipped. Default 0.1.'),
    }),
  },

  setClipFade: {
    name: 'set_clip_fade',
    description:
      'Set a fade-in and/or fade-out on a visual clip, in seconds. A fade-in ramps the clip up from transparent; a fade-out ramps it down. Pass 0 to clear a fade.',
    parameters: z.object({
      clipId: z.string().describe('The clip to fade.'),
      fadeInSeconds: z.number().finite().min(0).max(60).optional().describe('Fade-in length in seconds.'),
      fadeOutSeconds: z.number().finite().min(0).max(60).optional().describe('Fade-out length in seconds.'),
    }),
  },

  crossDissolve: {
    name: 'cross_dissolve',
    description:
      'Create a cross-dissolve between two adjacent clips on the same track. The second clip must immediately follow the first; it overlaps the first by the given duration and both are faded so one dissolves into the other.',
    parameters: z.object({
      firstClipId: z.string().describe('The outgoing clip.'),
      secondClipId: z.string().describe('The incoming clip, immediately following the first on the same track.'),
      durationSeconds: z.number().finite().min(0.1).max(30).describe('Overlap/dissolve length in seconds.'),
    }),
  },

  setClipTransition: {
    name: 'set_clip_transition',
    description:
      'Set or clear a geometric in-transition (wipe or slide) on a visual clip — the clip is revealed by a wipe edge or slides in from a direction over its first N seconds. Pass type "none" to clear.',
    parameters: z.object({
      clipId: z.string().describe('The clip to apply the transition to.'),
      type: z.enum(['none', 'wipe', 'slide']).describe('Transition type. "none" clears it.'),
      direction: z.enum(['left', 'right', 'up', 'down']).optional().describe('Edge the clip is revealed/enters from. Required for wipe/slide.'),
      durationSeconds: z.number().finite().min(0.05).max(30).optional().describe('Transition length in seconds.'),
      softness: z.number().finite().min(0).max(0.5).optional().describe('Wipe edge softness (fraction of dimension). Default 0.05.'),
    }),
  },

  // ── Undo/Redo ────────────────────────────────────────────────────────────────
  undo: {
    name: 'undo',
    description: 'Undo the last editing command.',
    parameters: z.object({}),
  },

  redo: {
    name: 'redo',
    description: 'Redo the last undone command.',
    parameters: z.object({}),
  },

  // ── Export ───────────────────────────────────────────────────────────────────
  exportProject: {
    name: 'export_project',
    description: 'Export the project to a video file via FFmpeg.',
    parameters: z.object({
      outputPath: z.string().describe('Output file path.'),
      format: z.enum(['mp4', 'mov', 'webm']).default('mp4').describe('Container format.'),
      quality: z.enum(['draft', 'normal', 'high']).default('normal').describe('Encoding quality preset.'),
    }),
  },

  // ── Generation (Phase 7+) ───────────────────────────────────────────────────
  generateMedia: {
    name: 'generate_media',
    description: 'Generate new media using an AI provider (image, video, or audio).',
    parameters: z.object({
      prompt: z.string().describe('Generation prompt.'),
      type: z.enum(['image', 'video', 'audio']).describe('Type of media to generate.'),
      provider: z.string().optional().describe('Provider name (e.g., "higgsfield", "fal", "replicate"). Defaults to user preference.'),
      durationSeconds: z.number().finite().min(0).max(3600).optional().describe('Duration for video/audio generation (seconds, max 1 hour).'),
      referenceAssetId: z.string().optional().describe('Asset to use as a visual reference / first frame.'),
    }),
  },
} as const;

// ─── Type helpers ────────────────────────────────────────────────────────────

export type ToolName = (typeof tools)[keyof typeof tools]['name'];

export function getToolByName(name: string) {
  return Object.values(tools).find((t) => t.name === name);
}

/** Convert all tool schemas to JSON Schema (for MCP tool listing) */
export function toolsToJsonSchema() {
  return Object.values(tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.parameters),
  }));
}

// Minimal Zod → JSON Schema conversion for MCP compatibility
function zodToJsonSchema(schema: z.ZodType<any>): Record<string, unknown> {
  // For our use case, we rely on zod's .parse() for validation
  // and produce a simplified JSON schema for tool listing.
  // A full implementation would use zod-to-json-schema package.
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const zodField = value as z.ZodType<any>;
      properties[key] = zodFieldToSchema(zodField);
      if (!(zodField instanceof z.ZodOptional)) {
        required.push(key);
      }
    }

    return { type: 'object', properties, required: required.length > 0 ? required : undefined };
  }
  return { type: 'object' };
}

function zodFieldToSchema(field: z.ZodType<any>): Record<string, unknown> {
  if (field instanceof z.ZodString) return { type: 'string', description: field.description };
  if (field instanceof z.ZodNumber) return { type: 'number', description: field.description };
  if (field instanceof z.ZodEnum) return { type: 'string', enum: field.options, description: field.description };
  if (field instanceof z.ZodOptional) return { ...zodFieldToSchema(field.unwrap()), optional: true };
  if (field instanceof z.ZodDefault) return zodFieldToSchema(field.removeDefault());
  return { type: 'string' };
}
