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
import { MAX_CANVAS_EDGE, QUALITY_PRESETS } from '../../shared/project/aspect-ratio';

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
      source: z.tuple([z.number().finite().min(0), z.number().finite()])
        .optional()
        .describe('[startSeconds, endSeconds] window of the asset to place — mutually exclusive with durationFrames. This is three-point editing: set it, land at the playhead, and the trim is baked in.'),
      mode: z.enum(['overwrite', 'insert', 'append']).optional().describe(
        'Collision handling. overwrite (default) replaces whatever sits in the span; insert '
        + 'pushes later clips on the track and their linked partners right by the placed length; '
        + 'append ignores startFrame and lands after the last clip on the track.',
      ),
    }),
  },

  removeClip: {
    name: 'remove_clip',
    description: 'Remove a clip from the timeline by ID.',
    parameters: z.object({
      clipId: z.string().describe('The ID of the clip to remove.'),
    }),
  },

  rippleDeleteClips: {
    name: 'ripple_delete_clips',
    description:
      'Remove timeline clips and close their gaps in one undoable edit. Linked clips and sync-locked tracks stay aligned.',
    parameters: z.object({
      clipIds: z.array(z.string()).min(1).describe('Clip IDs to remove. Linked partners are included automatically.'),
    }),
  },

  rippleDeleteGap: {
    name: 'ripple_delete_gap',
    description:
      'Close an empty timeline gap in one undoable edit, keeping sync-locked tracks aligned.',
    parameters: z.object({
      trackId: z.string().describe('Track containing the empty gap.'),
      startFrame: frameSchema.describe('Inclusive start frame of the gap.'),
      endFrame: durationSchema.describe('Exclusive end frame of the gap.'),
    }),
  },

  rippleDeleteRanges: {
    name: 'ripple_delete_ranges',
    description:
      'Cut one or more project-frame ranges from a track and close them in one undoable edit. Overlapping ranges merge; linked and sync-locked tracks remain aligned.',
    parameters: z.object({
      trackId: z.string().describe('Anchor track ID whose timeline ranges should be cut.'),
      ranges: z.array(
        z.tuple([
          frameSchema.describe('Inclusive project-frame start.'),
          durationSchema.describe('Exclusive project-frame end.'),
        ]),
      ).min(1).describe('Project-frame ranges to remove.'),
    }),
  },

  rippleTrimClip: {
    name: 'ripple_trim_clip',
    description:
      'Trim one edge of a clip and shift downstream clips atomically. Linked clips and sync-locked tracks stay aligned.',
    parameters: z.object({
      clipId: z.string().describe('Clip whose edge should be trimmed.'),
      edge: z.enum(['left', 'right']).describe('Timeline edge to trim.'),
      deltaFrames: z.number().int().describe(
        'Edge movement in frames. Positive moves the edge right; negative moves it left.',
      ),
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

  // ── Project settings ─────────────────────────────────────────────────────────
  setProjectSettings: {
    name: 'set_project_settings',
    description:
      "Change the project's frame rate, resolution, or aspect ratio. Pass fps, explicit width+height, aspectRatio, or quality. aspectRatio accepts a preset or a custom width:height value and preserves the current short-edge resolution unless quality is also supplied. Explicit width/height can't be combined with aspectRatio or quality. Existing clips are re-fitted automatically: clips that filled the old canvas fill the new one, and all frame positions/durations rescale when fps changes. Undoable.",
    parameters: z.object({
      fps: z
        .number()
        .finite()
        .int()
        .min(1)
        .max(120)
        .optional()
        .describe('Frame rate in frames per second. Common values: 24, 25, 30, 48, 50, 60.'),
      width: z
        .number()
        .finite()
        .int()
        .min(1)
        .max(MAX_CANVAS_EDGE)
        .optional()
        .describe(
          'Canvas width in pixels. Requires height for an exact resolution. Mutually exclusive with aspectRatio and quality.',
        ),
      height: z
        .number()
        .finite()
        .int()
        .min(1)
        .max(MAX_CANVAS_EDGE)
        .optional()
        .describe(
          'Canvas height in pixels. Requires width for an exact resolution. Mutually exclusive with aspectRatio and quality.',
        ),
      aspectRatio: z
        .string()
        .optional()
        .describe(
          "Canvas aspect ratio as width:height, such as '16:9', '3:2', or '2.39:1'. Preserves the current short edge, or uses quality when supplied. Mutually exclusive with width/height.",
        ),
      quality: z
        .enum(QUALITY_PRESETS.map((preset) => preset.id) as unknown as [string, ...string[]])
        .optional()
        .describe(
          'Resolution quality preset — scales the short edge to the target while preserving the current (or specified) aspect ratio.',
        ),
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
      'Detect and remove silent gaps in a clip with audio, rippling the remaining clips left to close the gaps. Runs on-device (no transcription). Works on audio or video clips. By default this uses the Minimum Pause, Speech Padding and Threshold controls shown in the Inspector; pass any of the optional values to override for this call only, without changing those controls.',
    parameters: z.object({
      clipId: z.string().describe('The clip to de-silence.'),
      // Bounds mirror SILENCE_LIMITS so the tool and the detector agree
      // (upstream PR #426).
      thresholdDb: z.number().finite().min(-120).max(0).optional().describe('Loudness below this (dBFS) counts as silence. Omit to use the current Threshold control.'),
      minSilenceSeconds: z.number().finite().min(0.25).max(3).optional().describe('Ignore silent gaps shorter than this. Range 0.25-3. Omit to use the current Minimum Pause control.'),
      edgePaddingSeconds: z.number().finite().min(0).max(0.5).optional().describe('Padding kept around speech so transients are not clipped. Not applied where the silence reaches the start or end of the source. Range 0-0.5. Omit to use the current Speech Padding control.'),
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
  copyClipSettings: {
    name: 'copy_clip_settings',
    description:
      'Copy one clip\'s presentation settings (audio: volume; visual: opacity, position, '
      + 'rotation, scale, blend mode) onto other clips of the same media kind. Timing, trims '
      + 'and source stay untouched. Provide exactly one of targetClipIds or targetTrack.',
    parameters: z.object({
      sourceClipId: z.string().describe('Clip whose settings are copied.'),
      targetClipIds: z.array(z.string().min(1)).optional()
        .describe('Explicit target clip IDs.'),
      targetTrack: z.object({
        trackId: z.string(),
        range: z.tuple([frameSchema, frameSchema]).optional()
          .describe('[startFrame, endFrame) — only clips intersecting the range.'),
      }).optional().describe('Apply to every same-kind clip on a track (source excluded).'),
    }).refine(
      (op) => op.targetClipIds !== undefined !== (op.targetTrack !== undefined),
      { message: 'Provide exactly one of targetClipIds or targetTrack' },
    ),
  },

  setClipSpeedTool: {
    name: 'set_clip_speed',
    description:
      'Set constant playback speed on a visual clip. Speeds range from 0.25x to 4x. '
      + 'Timeline duration is unchanged; the clip consumes more or less of its source.',
    parameters: z.object({
      clipId: z.string().describe('The visual clip whose speed to change.'),
      speed: z.number().finite().min(0.25).max(4)
        .describe('Playback rate multiplier (e.g. 0.5 = half speed, 2 = double speed).'),
    }),
  },

  normalizeAudioTool: {
    name: 'normalize_audio',
    description:
      'Normalize an audio clip so its peak reaches a target level (default -3 dBFS). '
      + 'Adjusts the clip volume multiplier; timeline timing is unchanged.',
    parameters: z.object({
      clipId: z.string().describe('The audio clip to normalize.'),
      targetDb: z.number().finite().min(-24).max(0).optional()
        .describe('Target peak level in dBFS. Defaults to -3.'),
    }),
  },

  setClipPanTool: {
    name: 'set_clip_pan',
    description:
      'Set stereo balance on an audio clip. -1 is hard left, +1 is hard right, '
      + '0 is center (default). Visual clips are refused.',
    parameters: z.object({
      clipId: z.string().describe('The audio clip whose balance to change.'),
      pan: z.number().finite().min(-1).max(1)
        .describe('Stereo balance: -1 = hard left, 0 = center, +1 = hard right.'),
    }),
  },

  addTexts: {
    name: 'add_texts',
    description:
      'Add one or more title text clips to the timeline. Titles are rendered in preview '
      + 'and export. Each entry needs trackId, startFrame, durationFrames and text.',
    parameters: z.object({
      entries: z.array(z.object({
        trackId: z.string().describe('Target video track ID.'),
        startFrame: frameSchema.describe('Frame position where the title should start.'),
        durationFrames: frameSchema.describe('Duration in frames.'),
        text: z.string().min(1).max(300).describe('Title text.'),
        fontSize: z.number().finite().min(8).max(400).optional()
          .describe('Font size in pixels. Defaults to ~9% of project height.'),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
          .describe('Text color as #RRGGBB. Defaults to white.'),
        bold: z.boolean().optional().describe('Bold text. Default false.'),
        fontFamily: z.string().optional()
          .describe('Font family name (e.g. "Arial", "Georgia"). Defaults to sans-serif.'),
        align: z.enum(['left', 'center', 'right']).optional()
          .describe('Horizontal alignment within the clip box. Defaults to center.'),
        backgroundColor: z.string().regex(/^#[0-9a-fA-F]{8}$/).optional()
          .describe('Background box color as #RRGGBBAA (e.g. #00000080). Omit for no box.'),
      })).min(1).describe('Titles to add.'),
    }),
  },

  importSrtTool: {
    name: 'import_srt',
    description:
      'Import SRT subtitle content as title clips on a video track. Each cue becomes '
      + 'a timed text overlay. Provide the raw SRT file content.',
    parameters: z.object({
      trackId: z.string().describe('Target video track ID.'),
      srtContent: z.string().min(1).describe('Raw SRT file content (the full text of the .srt file).'),
      startFrame: frameSchema.optional()
        .describe('Frame where the first cue should land. Defaults to playhead.'),
    }),
  },

  setTitleTextTool: {
    name: 'set_title_text',
    description: "Update the text and/or style of an existing title clip.",
    parameters: z.object({
      clipId: z.string().describe('The title clip to update.'),
      text: z.string().min(1).max(300).optional().describe('New title text.'),
      fontSize: z.number().finite().min(8).max(400).optional().describe('New font size in pixels.'),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('New text color as #RRGGBB.'),
      bold: z.boolean().optional().describe('Bold text.'),
      fontFamily: z.string().optional().describe('Font family name.'),
      backgroundColor: z.string().regex(/^#[0-9a-fA-F]{8}$/).nullable().optional()
        .describe('Background box color (#RRGGBBAA) or null to remove the background.'),
    }).refine(
      (op) => op.text !== undefined || op.fontSize !== undefined || op.color !== undefined
        || op.bold !== undefined || op.fontFamily !== undefined || op.backgroundColor !== undefined,
      { message: 'Pass at least one field to update.' },
    ),
  },

  manageTracks: {
    name: 'manage_tracks',
    description:
      'Reorder, restyle, rename, or remove timeline tracks in one step. Each entry addresses a '
      + 'track by exactly one of trackId or its current index. muted/hidden fold onto this port\'s '
      + 'single track toggle (audio: mute, video: hide); a name key present with "" restores the '
      + 'generated label; removals require an empty track.',
    parameters: z.object({
      reorder: z.array(z.object({
        trackId: z.string().optional(),
        index: z.number().int().min(0).optional(),
        to: z.number().int().min(0).describe('Destination index within the track\'s type zone.'),
      }).refine((e) => (e.trackId !== undefined) !== (e.index !== undefined), {
        message: 'pass one current trackId or index',
      })).optional().describe('Move tracks.'),
      set: z.array(z.object({
        trackId: z.string().optional(),
        index: z.number().int().min(0).optional(),
        muted: z.boolean().optional(),
        hidden: z.boolean().optional(),
        syncLocked: z.boolean().optional(),
        name: z.string().max(80).optional().describe('"" clears to the generated label.'),
      }).refine((e) => (e.trackId !== undefined) !== (e.index !== undefined), {
        message: 'pass one current trackId or index',
      }).refine(
        (e) => e.muted !== undefined || e.hidden !== undefined || e.syncLocked !== undefined
          || e.name !== undefined,
        { message: 'pass at least one of muted, hidden, syncLocked, name' },
      )).optional().describe('Change track flags or names.'),
      remove: z.array(z.union([
        z.number().int().min(0),
        z.string().min(1).describe('Track id.'),
        z.object({
          trackId: z.string().optional(),
          index: z.number().int().min(0).optional(),
        }).refine((e) => (e.trackId !== undefined) !== (e.index !== undefined), {
          message: 'pass one current trackId or index',
        }),
      ])).optional().describe('Remove empty tracks.'),
    }).refine(
      (op) => (op.reorder?.length ?? 0) + (op.set?.length ?? 0) + (op.remove?.length ?? 0) > 0,
      { message: 'Nothing to do — pass at least one of reorder, set, remove.' },
    ),
  },

  swapClipMedia: {
    name: 'swap_clip_media',
    description:
      'Replace a clip\'s source media while keeping its edit state — timing, framing, fades — intact. '
      + 'Linked partners sharing the same source swap together. The replacement must be the same media '
      + 'kind and long enough to cover the clip\'s trimmed source window.',
    parameters: z.object({
      clipId: z.string().describe('The clip whose source to replace.'),
      assetId: z.string().describe('ID of the replacement media asset (upstream\'s mediaRef).'),
    }),
  },

  manageClipLinks: {
    name: 'manage_clip_links',
    description:
      'Link or unlink clips so they select, move, trim, split, and delete together. '
      + 'Linking requires at least two clips of different media types that are not already one group; '
      + 'unlinking clears the group from the clips and everyone linked to them.',
    parameters: z.object({
      action: z.enum(['link', 'unlink']).describe('Whether to link or unlink.'),
      clipIds: z.array(z.string().min(1)).min(1).describe('Clip IDs to operate on. Linking expands each id to its whole current group first.'),
    }),
  },

  manageMarkers: {
    name: 'manage_markers',
    description:
      'Create, update, or delete timeline markers — review notes anchored to frames. '
      + 'A marker with durationFrames 0 is a point; a positive duration makes it a range.',
    parameters: z.object({
      action: z.enum(['create', 'update', 'delete']).describe('Which marker operation to perform.'),
      markerId: z.string().optional().describe('Marker ID. Required for update and delete.'),
      name: z.string().max(120).optional().describe('Marker name (single line, max 120 chars). Required for create.'),
      startFrame: frameSchema.optional().describe('Start frame. Required for create.'),
      durationFrames: frameSchema.optional().describe('Range length in frames. 0 or omitted = point marker.'),
      color: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/).optional()
        .describe('Marker color as #RRGGBB or #RRGGBBAA. Defaults to blue.'),
      comment: z.string().max(4000).optional().describe('Free-form note text (max 4000 chars).'),
    }),
  },

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
