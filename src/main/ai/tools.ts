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
import { COLOR_GRADE_CURVE_LIMITS, COLOR_GRADE_HUE_CURVE_LIMITS } from '../../shared/editor/color-grade';
import { GRADE_PRESET_NAME_MAX, GRADE_PRESET_PROPAGATE_MODES } from '../../shared/editor/grade-preset-store';
import { MAX_LUT_PATH_CHARS } from '../../shared/editor/lut';
import { MEDIA_FOLDER_NAME_MAX_LENGTH } from '../../shared/media/folders';

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

/** One tone-curve control point: normalized input/output in [0, 1]. */
const curvePointSchema = z.object({
  x: z.number().finite().min(0).max(1).describe('Input position, 0-1.'),
  y: z.number().finite().min(0).max(1).describe('Output value, 0-1.'),
});

/** One curve channel: control points with strictly ascending x. */
const curveChannelSchema = z
  .array(curvePointSchema)
  .max(COLOR_GRADE_CURVE_LIMITS.maxPointsPerChannel);

/** One hue-curve channel: hue-indexed control points with strictly ascending x. */
const hueCurveChannelSchema = z
  .array(curvePointSchema)
  .max(COLOR_GRADE_HUE_CURVE_LIMITS.maxPointsPerChannel);

/** One wheel pad position plus its master scalar; each component is optional (omitted stays). */
const liftZoneSchema = z.object({
  x: z.number().finite().min(-1).max(1).optional().describe('Lift pad x, -1 to 1. 0 = centered.'),
  y: z.number().finite().min(-1).max(1).optional().describe('Lift pad y, -1 to 1. 0 = centered.'),
  m: z.number().finite().min(-0.5).max(0.5).optional().describe('Lift master offset, -0.5 to 0.5. 0 = unchanged.'),
});

/** Gamma (midtones) wheel zone: pad x/y plus the gamma master multiplier. */
const gammaZoneSchema = z.object({
  x: z.number().finite().min(-1).max(1).optional().describe('Gamma pad x, -1 to 1. 0 = centered.'),
  y: z.number().finite().min(-1).max(1).optional().describe('Gamma pad y, -1 to 1. 0 = centered.'),
  m: z.number().finite().min(0.5).max(2).optional().describe('Gamma master multiplier, 0.5 to 2. 1 = unchanged.'),
});

/** Gain (highlights) wheel zone: pad x/y plus the gain master multiplier. */
const gainZoneSchema = z.object({
  x: z.number().finite().min(-1).max(1).optional().describe('Gain pad x, -1 to 1. 0 = centered.'),
  y: z.number().finite().min(-1).max(1).optional().describe('Gain pad y, -1 to 1. 0 = centered.'),
  m: z.number().finite().min(0.5).max(1.5).optional().describe('Gain master multiplier, 0.5 to 1.5. 1 = unchanged.'),
});

// ─── Reference image (generate_media) ────────────────────────────────────────
// A generation can be conditioned on an existing picture. The path itself is
// checked in the main process (the executor, where the filesystem is), but the
// accepted file types and the size cap are part of the published contract, so
// they live beside the schema the model reads.

/** Image types accepted as a reference — the same set the importer treats as images. */
export const REFERENCE_IMAGE_EXTENSIONS: readonly string[] = [
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
];

/** Largest reference image accepted, refused before any provider call. A still, not a frame dump. */
export const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;

// ─── Tool Definitions ────────────────────────────────────────────────────────

export const tools = {
  // ── Timeline inspection ──────────────────────────────────────────────────────
  getTimeline: {
    name: 'get_timeline',
    description: 'Read the current timeline state: tracks, clips, playhead position, and project settings.',
    parameters: z.object({
      scopeTimelineId: z.string().optional().describe('Nested timeline id to read instead of the main timeline. Omit for the main timeline.'),
    }),
  },

  getClips: {
    name: 'get_clips',
    description: 'List all clips on the timeline with their properties (position, duration, track, transforms).',
    parameters: z.object({
      trackId: z.string().optional().describe('Filter clips to a specific track ID.'),
      scopeTimelineId: z.string().optional().describe('Nested timeline id to list clips from. Omit for the main timeline.'),
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

  trimClips: {
    name: 'trim_clips',
    description:
      'Trim or extend the edges of one or many clips — move where clips start or end — as a single undoable action. Each edit gives absolute project frames: startFrame moves the leading edge, endFrame the trailing edge (end-exclusive, matching get_timeline); pass either or both. Moving an edge inward trims material away; outward extends it, revealing more source when the media has headroom (images and titles extend freely). Linked audio/video partners trim together, so list a clip or its partner, not both.\n\nripple=false (default): only the edited clips change — extending overwrites whatever the new span overlaps on that track, trimming leaves a gap.\nripple=true: like a ripple-trim drag — downstream clips and sync-locked tracks shift to close (or open) the gap. Each requested frame is read as an amount of material to add or remove at that edge, applied before the shift.\n\nRequests are clamped by source headroom and sync-locked track room; the receipt reports every clamp, skipped edge, and overwritten clip, plus shifted markers and removed marker ids when ripple edits move them — verify against it instead of assuming the exact frames landed.',
    parameters: z.object({
      edits: z.array(
        // Strict like upstream's allowed-keys validation: a typo'd frame key
        // must fail loudly instead of being stripped into a silent no-op.
        z.object({
          clipId: z.string().describe('Clip to trim (from get_timeline).'),
          startFrame: frameSchema
            .optional()
            .describe('Project frame the leading edge should move to. Greater than the current start trims the head; smaller extends it.'),
          endFrame: durationSchema
            .optional()
            .describe('Project frame the trailing edge should move to (end-exclusive). Smaller than the current end trims the tail; greater extends it.'),
        }).strict(),
      ).min(1).describe('Per-clip edge targets. A clip (or its linked partner) may appear in at most one edit.'),
      ripple: z.boolean().optional().describe('Shift downstream clips and sync-locked tracks to keep the timeline closed, like a ripple trim. Default false.'),
    }).strict(),
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

  nestClips: {
    name: 'nest_clips',
    description:
      'Group timeline clips into a nested sequence: the clips move into a new sub-timeline, replaced on the main timeline by one compound clip, as a single undoable edit. Linked partners nest together automatically. Trim, split, and move work on the compound clip afterwards; call flatten_compound to restore its content.',
    parameters: z.object({
      clipIds: z.array(z.string().min(1)).min(1).describe('Clip IDs to group into the nested sequence.'),
      name: z.string().max(120).optional().describe('Name for the nested sequence. Defaults to "Compound N".'),
      scopeTimelineId: z.string().optional().describe('Nested timeline id holding the clips. Omit for the main timeline.'),
    }),
  },

  flattenCompound: {
    name: 'flatten_compound',
    description:
      'Restore one compound clip\'s nested content to the main timeline (one level; inner nested sequences stay nested), as a single undoable edit.',
    parameters: z.object({
      clipId: z.string().describe('The compound clip to flatten.'),
      scopeTimelineId: z.string().optional().describe('Nested timeline id holding the compound clip. Omit for the main timeline.'),
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
      'Detect and remove silent gaps in audio, rippling the remaining clips left to close the gaps. Runs on-device (no transcription). Scope: pass clipIds to limit removal to those clips (they must resolve, include at least one audio clip, and share one track or one linked A/V unit), a single clipId for backwards compatibility, or nothing to sweep every audio track on the timeline. By default this uses the Minimum Pause, Speech Padding and Threshold controls shown in the Inspector; pass any of the optional values to override for this call only, without changing those controls.',
    parameters: z.object({
      clipId: z.string().optional().describe('One clip to de-silence (legacy single-clip form; may be an audio or video clip). Omit to sweep the whole timeline.'),
      clipIds: z.array(z.string()).min(1).optional().describe('Clips to de-silence as one scoped edit (upstream PR #426). Must resolve; must include at least one audio clip; all targets share one track or one link group.'),
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
    description:
      'Undo the last editing command. Only commands this tool ran on the main project are undoable '
      + 'here, and only while the project still matches: once the user edits content in the window, '
      + 'undo refuses rather than overwriting their work, and says so. Moving the playhead or the '
      + 'in/out marks does not count as an edit and does not block undo.',
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
      'Copy one clip\'s presentation settings onto other clips of the same media kind — '
      + 'audio: volume, pan, and a non-default EQ, compressor, or noise reduction; visual: opacity, position, '
      + 'rotation, scale, blend mode, and a non-default color grade (shape-to-shape also '
      + 'carries kind, stroke, and fill). Timing, trims and source stay untouched. Provide '
      + 'exactly one of targetClipIds or targetTrack.',
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
    name: 'set_clip_pan',    description:
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
        backgroundPadding: z.number().int().min(0).max(128).optional()
          .describe('Background box padding in pixels. Default 8.'),
        lineSpacing: z.number().int().min(0).max(200).optional()
          .describe('Extra space between wrapped lines, in pixels. Default 0.'),
        fontCase: z.enum(['original', 'upper', 'lower']).optional()
          .describe('Case applied to the text before rendering. Default original.'),
        fillMode: z.enum(['footage', 'inverted']).optional()
          .describe('Advanced fill (upstream TextFillMode). "footage" knocks the letters out of a matte band so the video shows through them; "inverted" difference-inverts the video inside the letterforms. Omit for solid color.'),
        blurRadius: z.number().int().min(0).max(64).optional()
          .describe('Gaussian blur on the text layer, in pixels. Default 0.'),
        tiltX: z.number().finite().min(-89).max(89).optional()
          .describe('Perspective tilt around the vertical axis, in degrees. Default 0.'),
        tiltY: z.number().finite().min(-89).max(89).optional()
          .describe('Perspective tilt around the horizontal axis, in degrees. Default 0.'),
        variationWght: z.number().int().min(1).max(1000).optional()
          .describe('Variable-font weight axis (wght 1-1000, default 400). Applies to variable fonts via font-variation-settings; other fonts ignore it. Non-default values export through the title bake path.'),
        variationWdth: z.number().int().min(50).max(200).optional()
          .describe('Variable-font width axis (wdth 50-200%, default 100). Same behavior as variationWght.'),
        variationSlnt: z.number().finite().min(-90).max(90).optional()
          .describe('Variable-font slant axis (slnt -90..90 degrees, default 0). Same behavior as variationWght.'),
        variationItal: z.number().finite().min(0).max(1).optional()
          .describe('Variable-font italic axis (ital 0-1, default 0). Same behavior as variationWght.'),
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

  importVttTool: {
    name: 'import_vtt',
    description:
      'Import WebVTT subtitle content as title clips on a video track. Same behavior '
      + 'as import_srt but for the WebVTT format.',
    parameters: z.object({
      trackId: z.string().describe('Target video track ID.'),
      vttContent: z.string().min(1).describe('Raw WebVTT file content.'),
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
      backgroundPadding: z.number().int().min(0).max(128).optional()
        .describe('Background box padding in pixels. Default 8.'),
      lineSpacing: z.number().int().min(0).max(200).optional()
        .describe('Extra space between wrapped lines, in pixels. Default 0.'),
      fontCase: z.enum(['original', 'upper', 'lower']).optional()
        .describe('Case applied to the text before rendering. Default original.'),
      fillMode: z.enum(['color', 'footage', 'inverted']).optional()
        .describe('Advanced fill. "footage"/"inverted" as in add_texts; "color" returns to solid styling.'),
      blurRadius: z.number().int().min(0).max(64).optional()
        .describe('Gaussian blur on the text layer, in pixels. 0 clears.'),
      tiltX: z.number().finite().min(-89).max(89).optional()
        .describe('Perspective tilt around the vertical axis, in degrees. 0 clears.'),
      tiltY: z.number().finite().min(-89).max(89).optional()
        .describe('Perspective tilt around the horizontal axis, in degrees. 0 clears.'),
      variationWght: z.number().int().min(1).max(1000).optional()
        .describe('Variable-font weight axis (wght 1-1000). 400 clears.'),
      variationWdth: z.number().int().min(50).max(200).optional()
        .describe('Variable-font width axis (wdth 50-200%). 100 clears.'),
      variationSlnt: z.number().finite().min(-90).max(90).optional()
        .describe('Variable-font slant axis (slnt -90..90 degrees). 0 clears.'),
      variationItal: z.number().finite().min(0).max(1).optional()
        .describe('Variable-font italic axis (ital 0-1). 0 clears.'),
    }).refine(
      (op) => op.text !== undefined || op.fontSize !== undefined || op.color !== undefined
        || op.bold !== undefined || op.fontFamily !== undefined || op.backgroundColor !== undefined
        || op.backgroundPadding !== undefined || op.lineSpacing !== undefined
        || op.fontCase !== undefined || op.fillMode !== undefined || op.blurRadius !== undefined
        || op.tiltX !== undefined || op.tiltY !== undefined
        || op.variationWght !== undefined || op.variationWdth !== undefined
        || op.variationSlnt !== undefined || op.variationItal !== undefined,
      { message: 'Pass at least one field to update.' },
    ),
  },

  addShapes: {
    name: 'add_shapes',
    description:
      'Add one or more vector shape clips (rect/ellipse/line/arrow tutorial overlays) to the timeline. '
      + 'Shapes render in preview and export from the same box geometry. Each entry needs trackId, '
      + 'startFrame, durationFrames and kind; geometry (x/y/width/height in canvas pixels) defaults to a '
      + 'centered half-canvas box. An optional animation preset composes the existing position/scale/rotation '
      + 'keyframes (draw-on, slide-in-left, slide-in-right, slide-in-up, pop, spin, pulse); there is no '
      + 'opacity preset — use fades for that. One call is one undo step.',
    parameters: z.object({
      entries: z.array(z.object({
        trackId: z.string().describe('Target video track ID.'),
        startFrame: frameSchema.describe('Frame position where the shape should start.'),
        durationFrames: frameSchema.describe('Duration in frames.'),
        kind: z.enum(['rect', 'ellipse', 'line', 'arrow']).optional()
          .describe('Shape kind. Defaults to rect. Lines and arrows run corner to corner and ignore fill.'),
        x: z.number().finite().optional()
          .describe('Box left in canvas pixels. Defaults to horizontally centered.'),
        y: z.number().finite().optional()
          .describe('Box top in canvas pixels. Defaults to vertically centered.'),
        width: z.number().finite().min(1).max(MAX_CANVAS_EDGE).optional()
          .describe('Box width in canvas pixels. Defaults to half the canvas width.'),
        height: z.number().finite().min(1).max(MAX_CANVAS_EDGE).optional()
          .describe('Box height in canvas pixels. Defaults to half the canvas height.'),
        strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
          .describe('Outline color as #RRGGBB. Defaults to white.'),
        strokeWidth: z.number().int().min(0).max(64).optional()
          .describe('Outline width in pixels. Defaults to 4; 0 means no stroke.'),
        fillColor: z.string().regex(/^#[0-9a-fA-F]{8}$/).optional()
          .describe('Fill color as #RRGGBBAA. Omit for no fill; ignored by lines and arrows.'),
        preset: z.enum(['draw-on', 'slide-in-left', 'slide-in-right', 'slide-in-up', 'pop', 'spin', 'pulse']).optional()
          .describe('Animation preset applied as motion keyframes at creation.'),
      })).min(1).describe('Shapes to add.'),
    }),
  },

  setShapeStyle: {
    name: 'set_shape_style',
    description:
      'Update the kind and/or style of an existing shape clip, and optionally apply an animation preset '
      + '(draw-on, slide-in-left, slide-in-right, slide-in-up, pop, spin, pulse) as motion keyframes. '
      + 'Timing and geometry stay untouched.',
    parameters: z.object({
      clipId: z.string().describe('The shape clip to update.'),
      kind: z.enum(['rect', 'ellipse', 'line', 'arrow']).optional().describe('New shape kind.'),
      strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('New outline color as #RRGGBB.'),
      strokeWidth: z.number().int().min(0).max(64).optional()
        .describe('New outline width in pixels. 0 clears the stroke.'),
      fillColor: z.string().regex(/^#[0-9a-fA-F]{8}$/).nullable().optional()
        .describe('New fill color (#RRGGBBAA) or null to remove the fill.'),
      preset: z.enum(['draw-on', 'slide-in-left', 'slide-in-right', 'slide-in-up', 'pop', 'spin', 'pulse']).optional()
        .describe('Animation preset applied as motion keyframes.'),
    }).refine(
      (op) => op.kind !== undefined || op.strokeColor !== undefined || op.strokeWidth !== undefined
        || op.fillColor !== undefined || op.preset !== undefined,
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
      status: z.enum(['open', 'review', 'resolved']).optional()
        .describe('Review state. Defaults to open for a new marker; updates patch only when supplied.'),
    }),
  },

  manageMediaFolders: {
    name: 'manage_media_folders',
    description:
      'Organize the media library into flat one-level folders: list them, create one, rename one, delete one, '
      + 'or move assets between them. Every mutating call is one undoable step. Deleting a folder never deletes '
      + 'media — its assets move to the library root. Call list first to get folder ids (they also appear as '
      + 'folderId on assets from get_media).',
    parameters: z.object({
      action: z.enum(['list', 'create', 'rename', 'delete', 'move_assets'])
        .describe('Which folder operation to perform.'),
      folderId: z.string().min(1).nullable().optional()
        .describe('Folder id. Required for rename and delete. For move_assets, omit it (or pass null) to move assets to the library root.'),
      name: z.string().max(MEDIA_FOLDER_NAME_MAX_LENGTH).optional()
        .describe(`Folder name (max ${MEDIA_FOLDER_NAME_MAX_LENGTH} chars). Required for create and rename.`),
      assetIds: z.array(z.string().min(1)).min(1).optional()
        .describe('Library asset ids to move. Required for move_assets.'),
    }),
  },

  updatePlan: {
    name: 'update_plan',
    description:
      'Replace the working plan for this request with a short ordered checklist (max 12 steps, at most one in_progress). '
      + 'Call it before starting a multi-step request and again as steps complete, so the user can see the shape of the work. '
      + 'The plan is session UI state only: it never touches the project or undo. Send an empty array to clear it.',
    parameters: z.object({
      steps: z.array(z.object({
        step: z.string().min(1).describe('Short imperative step description.'),
        status: z.enum(['pending', 'in_progress', 'completed'])
          .describe('Step state. At most one step may be in_progress.'),
      })).max(12).describe('The full plan, in order.'),
    }),
  },

  verifyTimeline: {
    name: 'verify_timeline',
    description:
      'Read-only structural audit of the project — no mutation, so it never needs an undo. '
      + 'Reports zero-length clips, clips reading past their source, overlapping clips, missing or offline media, '
      + 'orphaned link groups, fades longer than the clip, empty titles, and invalid markers, each with a severity, '
      + 'a code, and the owning clip/marker id. Nested timelines are audited too (dangling references, cycles, '
      + 'and over-deep chains surface as compound-invalid errors), so no scope argument is needed — it checks everything. Call it after any destructive batch (ripple delete, silence removal, '
      + 'batch trim, project settings change) before telling the user the edit is done.',
    parameters: z.object({
      limit: z.number().int().min(1).max(200).optional()
        .describe('Maximum issues to return, errors first. Default 50.'),
    }),
  },

  newProject: {
    name: 'new_project',
    description:
      'Reset the editor to an empty project (optionally named). Used by headless/MCP batch workflows to start clean without a window.',
    parameters: z.object({
      name: z.string().max(120).optional().describe('Project name. Default "Untitled Project".'),
    }),
  },

  openProject: {
    name: 'open_project',
    description:
      'Open a .vproj project file, replacing the current project. Primarily for headless/MCP batch workflows: open, edit with the normal tools, then save_project.',
    parameters: z.object({
      path: z.string().min(1).describe('Absolute path to a .vproj project file.'),
    }),
  },

  saveProject: {
    name: 'save_project',
    description:
      'Save the current project to a .vproj path, writing atomically (temp file + rename). Primarily for headless/MCP batch workflows.',
    parameters: z.object({
      path: z.string().min(1).describe('Absolute path to write.'),
    }),
  },

  exportProject: {
    name: 'export_project',
    description:
      'Render the timeline to a video or audio file with FFmpeg. The same exporter the delivery panel uses: the same clip eligibility, geometry, trim/motion mapping, grade, effects, transitions, and audio mix. '
      + 'It cannot render two layer types, because baking them needs the renderer and this tool has no window: SHAPE clips are left out of the video entirely, and ADVANCED TITLES (footage/inverted fill, blur, perspective tilt, variable-font axes) fall back to plain solid text. Every affected clip is named in the receipt\'s "warnings", so check them and report them to the user; for those layers, use the delivery panel. '
      + 'Pass hdr "hlg" or "pq" for a 10-bit BT.2020 HDR delivery (HEVC Main10, MP4/MOV only); omit it for the normal SDR export. '
      + 'Returns when the file is written (long timelines take minutes). outputPath must be absolute; the parent folder must exist.',
    parameters: z.object({
      outputPath: z.string().min(1).describe('Absolute output file path.'),
      format: z.enum(['mp4', 'mov', 'webm', 'audio']).default('mp4').describe('Container format. "audio" writes an M4A mix.'),
      quality: z.enum(['draft', 'normal', 'high']).default('normal').describe('Encoding quality preset.'),
      hdr: z.enum(['sdr', 'hlg', 'pq']).optional()
        .describe('HDR delivery profile (upstream #59). Omit or "sdr" keeps the Rec.709 8-bit path; "hlg" or "pq" encodes HEVC Main10 (yuv420p10le) with BT.2020 primaries/matrix and the HLG or PQ transfer, converting the SDR-graded timeline at the end. MP4/MOV only; hardware H.264 encoders are refused because they are 8-bit.'),
    }),
  },

  // ── Generation (Phase 7+) ───────────────────────────────────────────────────
  generateMedia: {
    name: 'generate_media',
    description:
      'Generate an image, video, or audio asset from a text prompt using a configured generation provider (fal.ai, Replicate, or HiggsField — whichever has an API key set; pass providerId to choose). The finished file is imported into the project media library and its asset id is returned. Video generations can take a few minutes. Pass referenceImagePath to generate from an existing picture.',
    parameters: z.object({
      type: z.enum(['image', 'video', 'audio']).describe('Type of media to generate.'),
      prompt: z.string().min(1).max(2000).describe('Generation prompt.'),
      negativePrompt: z.string().max(1000).optional().describe('What to avoid.'),
      providerId: z.string().optional().describe('Provider id ("fal", "replicate", "higgsfield"). Defaults to the first configured provider supporting the type.'),
      modelId: z.string().optional().describe('Provider-specific model id. Defaults to the provider\'s default for the type.'),
      durationSeconds: z.number().finite().min(1).max(60).optional().describe('Duration for video/audio generation.'),
      width: z.number().int().min(256).max(4096).optional().describe('Output width in pixels.'),
      height: z.number().int().min(256).max(4096).optional().describe('Output height in pixels.'),
      referenceImagePath: z.string().min(1).max(MAX_LUT_PATH_CHARS).optional().describe(
        'Absolute path to a local image file (png, jpg, jpeg, webp, gif, bmp) to condition an '
        + 'image generation on: the provider generates from that picture instead of from the prompt '
        + 'alone. It is refused for video and audio generation, whose models take no image input on '
        + 'this build, and a path that is missing, relative, another file type, or over '
        + `${MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024)} MB refuses the call before any provider is contacted.`,
      ),
    }),
  },

  transcribeAudio: {
    name: 'transcribe_audio',
    description:
      'Transcribe a library audio/video asset to text with word-level timestamps, then lay the result onto a video track as caption clips snapped to word boundaries (#39/#91). Engines ("engine", default "auto"): local whisper.cpp runs fully offline when its binary + model are downloaded and never sends audio anywhere; custom uses the saved OpenAI-compatible server; cloud uses a BYOK provider serving /audio/transcriptions (OpenAI, Groq); auto prefers local, then custom, then cloud. An explicit engine never falls back — it refuses with a setup message instead (local in particular never spends cloud credit). Pass language as an ISO-639-1 hint like "en" or leave it for auto-detection; it reaches the engine as a model language selection, not the system locale, and unsupported codes are refused. Optional planning controls: maxWordsPerCue, maxCharsPerLine, maxLines, pauseBreakSec (omitted fields use broadcast defaults).',
    parameters: z.object({
      assetId: z.string().describe('Library asset containing speech.'),
      language: z.string().max(12).optional().describe('ISO-639-1 language hint, e.g. "en".'),
      model: z.string().optional().describe('Transcription model id. Cloud default "whisper-1" (Groq: "whisper-large-v3"); local honours a downloaded model id (tiny/base/small/medium/large-v3-turbo).'),
      engine: z.enum(['auto', 'local', 'custom', 'cloud']).optional().describe('Transcription engine. Default "auto" (local when ready, else custom server, else cloud).'),
      maxWordsPerCue: z.number().int().min(1).max(20).optional()
        .describe('Maximum words per caption. Omit for no word ceiling.'),
      maxCharsPerLine: z.number().int().min(10).max(80).optional()
        .describe('Maximum characters per caption line. Default 42.'),
      maxLines: z.number().int().min(1).max(4).optional()
        .describe('Maximum lines per caption. Default 2.'),
      pauseBreakSec: z.number().finite().min(0.1).max(3).optional()
        .describe('Silence in seconds that forces a caption break. Default 0.6.'),
    }),
  },

  inspectFrame: {
    name: 'inspect_frame',
    description:
      'Grab a single frame from a library video/image so you can look at it before or after editing (upstream #565). The frame is saved as a PNG and its absolute path is returned — read that file to view it. Over MCP, the image itself is attached.',
    parameters: z.object({
      assetId: z.string().describe('Library asset to sample from.'),
      atSeconds: z.number().finite().min(0).describe('Offset into the source, in seconds.'),
      width: z.number().int().min(160).max(1920).optional().describe('Output width. Default 640.'),
    }),
  },

  setClipCrop: {
    name: 'set_clip_crop',
    description:
      'Crop edges off the source frame of a video/image clip, as fractions of the source (0-0.45 per edge) applied before position and scale. Static — not animatable. Passing all zeros clears the crop.',
    parameters: z.object({
      clipId: z.string().describe('The video or image clip to crop.'),
      left: z.number().finite().min(0).max(0.45).optional().describe('Fraction cropped from the left edge.'),
      right: z.number().finite().min(0).max(0.45).optional().describe('Fraction cropped from the right edge.'),
      top: z.number().finite().min(0).max(0.45).optional().describe('Fraction cropped from the top edge.'),
      bottom: z.number().finite().min(0).max(0.45).optional().describe('Fraction cropped from the bottom edge.'),
    }).refine(
      (op) => op.left !== undefined || op.right !== undefined
        || op.top !== undefined || op.bottom !== undefined,
      { message: 'Pass at least one crop edge.' },
    ),
  },

  setClipEdgeEffects: {
    name: 'set_clip_edge_effects',
    description:
      'Adjust DaVinci-style edge rounding (corner radius) and edge softness (feathered alpha) on visual clips. '
      + 'Both values are normalized 0-1. Passing 0 for both clears the effects. '
      + 'Applied in the compositor after crop/colour-grade but before transform/opacity.',
    parameters: z.object({
      clipId: z.string().describe('The video or image clip to adjust.'),
      edgeRounding: z.number().finite().min(0).max(1).optional()
        .describe('Corner radius as fraction of 0-1. 0 = square corners, 1 = fully rounded.'),
      edgeSoftness: z.number().finite().min(0).max(1).optional()
        .describe('Edge feathering as fraction of 0-1. 0 = hard edge, 1 = maximum feather.'),
    }).refine(
      (op) => op.edgeRounding !== undefined || op.edgeSoftness !== undefined,
      { message: 'Pass edgeRounding or edgeSoftness.' },
    ),
  },

  setClipChromaKey: {
    name: 'set_clip_chroma_key',
    description:
      'Key out a green/blue screen background on a video/image clip so tracks below show through '
      + '(upstream issue #97). Pass keyColor + tolerance to key; tolerance 0 clears the key. '
      + 'softness feathers the cutoff into a gradient; spill desaturates key-color contamination '
      + 'on the subject\'s edges. Applied in the compositor after crop, before edge rounding.',
    parameters: z.object({
      clipId: z.string().describe('The video or image clip to key.'),
      keyColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
        .describe('Key color as #RRGGBB, e.g. "#00ff00" for standard chroma green. Defaults to green on first set.'),
      tolerance: z.number().finite().min(0).max(1).optional()
        .describe('Match tolerance, 0-1. 0 clears the key entirely.'),
      softness: z.number().finite().min(0).max(1).optional()
        .describe('Edge feather, 0-1. 0 = hard cutoff. Defaults to 0.05 on first set.'),
      spill: z.number().finite().min(0).max(1).optional()
        .describe('Spill suppression strength, 0-1. 0 = no despill. Defaults to 0.5 on first set.'),
    }).refine(
      (op) => op.keyColor !== undefined || op.tolerance !== undefined
        || op.softness !== undefined || op.spill !== undefined,
      { message: 'Pass at least one of keyColor, tolerance, softness, spill.' },
    ),
  },

  setClipColorGrade: {
    name: 'set_clip_color_grade',
    description:
      'Grade a video/image clip\'s color (upstream #157\'s effect stack) — preview and export apply the exact same values. '
      + 'Omitted fields stay untouched; passing a field its default (0, 1, 1, 0, 0, 6500, 0, 0, 0, 0, 0, 0) clears just that field, '
      + 'and clear: true resets the whole grade back to neutral. `curves` adds piecewise-linear master luma and per-channel tone curves. '
      + '`wheels` adds lift/gamma/gain color wheels (shadows/midtones/highlights): each zone is a pad position (x, y in -1..1) plus a master (m). '
      + '`hueCurves` adds hue-vs-hue/saturation/luminance curves: each channel is a list of {x, y} points in 0-1 with strictly ascending x, sampled at the pixel hue. '
      + '`lutPath` applies a .cube LUT file (validated at the boundary — missing or invalid files refuse the call); `lutIntensity` blends it 0..1 (default 1). '
      + 'An empty lutPath clears the LUT. `blurRadius` (0-100px gaussian blur), `vignette` ({amount -1..1, midpoint, roundness, feather}), '
      + '`grain` ({amount 0..1, size 0.5..4px, animated per frame}) and `glow` ({intensity, radius, threshold, warmth}) add the #157 effect stages after the grade. '
      + 'Effect components merge per component (omitted stays); an all-identity effect clears it.',
    parameters: z.object({
      clipId: z.string().describe('The video or image clip to grade.'),
      brightness: z.number().finite().min(-1).max(1).optional()
        .describe('Brightness offset -1 to 1. 0 = unchanged.'),
      contrast: z.number().finite().min(0).max(3).optional()
        .describe('Contrast multiplier 0 to 3. 1 = unchanged, 0 = flat grey.'),
      saturation: z.number().finite().min(0).max(3).optional()
        .describe('Saturation multiplier 0 to 3. 1 = unchanged, 0 = greyscale.'),
      hueRotation: z.number().finite().min(-180).max(180).optional()
        .describe('Hue rotation in degrees -180 to 180. 0 = unchanged.'),
      exposure: z.number().finite().min(-5).max(5).optional()
        .describe('Exposure in EV stops -5 to 5, applied before every other grade operation. 0 = unchanged.'),
      temperature: z.number().finite().min(2000).max(11000).optional()
        .describe('White-balance temperature in Kelvin 2000 to 11000. 6500 = neutral daylight.'),
      tint: z.number().finite().min(-100).max(100).optional()
        .describe('White-balance tint -100 (green) to +100 (magenta). 0 = unchanged.'),
      vibrance: z.number().finite().min(-1).max(1).optional()
        .describe('Vibrance -1 to +1: selective saturation that boosts muted tones more than saturated ones. 0 = unchanged.'),
      highlights: z.number().finite().min(-1).max(1).optional()
        .describe('Highlights -1 to +1: luma-masked lift of bright tones, peaking at white. 0 = unchanged.'),
      shadows: z.number().finite().min(-1).max(1).optional()
        .describe('Shadows -1 to +1: luma-masked lift of dark tones, peaking at black. 0 = unchanged.'),
      blacks: z.number().finite().min(-1).max(1).optional()
        .describe('Blacks -1 to +1: negative crushes the floor, positive lifts it. 0 = unchanged.'),
      whites: z.number().finite().min(-1).max(1).optional()
        .describe('Whites -1 to +1: positive brightens toward clipping, negative recovers the ceiling. 0 = unchanged.'),
      invertColors: z.boolean().optional()
        .describe('Invert RGB channels while preserving alpha (the negative look).'),
      curves: z.object({
        master: curveChannelSchema.optional()
          .describe('Master (Rec.709 luma) tone curve; an empty array clears it.'),
        red: curveChannelSchema.optional()
          .describe('Red-channel tone curve; an empty array clears it.'),
        green: curveChannelSchema.optional()
          .describe('Green-channel tone curve; an empty array clears it.'),
        blue: curveChannelSchema.optional()
          .describe('Blue-channel tone curve; an empty array clears it.'),
      }).optional().describe(
        'Tone curves (upstream #157 Curves). Each channel is a piecewise-linear list of '
        + '{x, y} control points in 0-1 with strictly ascending x; empty/identity clears that '
        + 'channel. Omitted channels stay as they are; when every channel ends up identity the '
        + 'whole curve is cleared. Example: { master: [{x:0,y:0.06},{x:1,y:0.95}] } lifts the '
        + 'toe for a faded film look.',
      ),
      wheels: z.object({
        lift: liftZoneSchema.optional()
          .describe('Lift (shadows) wheel; an identity zone clears it.'),
        gamma: gammaZoneSchema.optional()
          .describe('Gamma (midtones) wheel; an identity zone clears it.'),
        gain: gainZoneSchema.optional()
          .describe('Gain (highlights) wheel; an identity zone clears it.'),
      }).optional().describe(
        'Color wheels (upstream #157 Wheels). Each zone is a pad position (x, y in '
        + '-1..1, angle = hue, radius = strength) plus a master (m): lift m in '
        + '-0.5..0.5 (default 0), gamma m in 0.5..2 (default 1), gain m in '
        + '0.5..1.5 (default 1). Omitted zones stay as they are; omitted '
        + 'components within a zone stay; when every zone ends up identity the '
        + 'whole wheels is cleared. Example: { gain: { m: 1.2 } } lifts the '
        + 'highlights.',
      ),
      hueCurves: z.object({
        hueVsHue: hueCurveChannelSchema.optional()
          .describe('Hue-vs-hue curve (hue rotation by source hue); an empty array clears it.'),
        hueVsSat: hueCurveChannelSchema.optional()
          .describe('Hue-vs-saturation curve (saturation scale by source hue); an empty array clears it.'),
        hueVsLum: hueCurveChannelSchema.optional()
          .describe('Hue-vs-luminance curve (luminance shift by source hue); an empty array clears it.'),
      }).optional().describe(
        'Hue curves (upstream #157 Hue Curves). Each channel is a cyclic '
        + 'piecewise-linear list of {x, y} control points in 0-1 with strictly '
        + 'ascending x, sampled at the pixel hue (near-greys are gated out, so '
        + 'they never tint); empty/neutral clears that channel. Omitted '
        + 'channels stay as they are; when every channel ends up neutral the '
        + 'whole hue curves is cleared. Example: { hueVsSat: '
        + '[{x:0,y:0.8},{x:0.15,y:0.5}] } boosts red saturation.',
      ),
      clear: z.boolean().optional()
        .describe('Reset the whole grade — brightness, contrast, saturation, hue, exposure, temperature, tint, vibrance, highlights, shadows, blacks, whites, curves, wheels, hue curves, LUT, blur, vignette, grain, glow, and invert — to neutral.'),
      lutPath: z.string().max(MAX_LUT_PATH_CHARS).optional()
        .describe('Absolute path to a .cube LUT file (1D or 3D). The file is validated when set — missing or invalid files refuse the call. An empty string clears the LUT.'),
      lutIntensity: z.number().finite().min(0).max(1).optional()
        .describe('LUT blend strength 0 to 1. 1 = full LUT, 0 = original frame. Defaults to 1 when a LUT is set.'),
      blurRadius: z.number().finite().min(0).max(100).optional()
        .describe('Gaussian blur radius in px, 0 to 100. 0 = sharp (clears the blur). Applied after the grade.'),
      vignette: z.object({
        amount: z.number().finite().min(-1).max(1).optional()
          .describe('Edge gain -1 (darken) to 1 (lighten). 0 = no vignette and clears it.'),
        midpoint: z.number().finite().min(0).max(1).optional()
          .describe('Where the falloff starts, 0 to 1.'),
        roundness: z.number().finite().min(-1).max(1).optional()
          .describe('Shape morph -1 (rectangular) to 1 (round).'),
        feather: z.number().finite().min(0).max(1).optional()
          .describe('Falloff width, 0 to 1.'),
      }).optional().describe(
        'Vignette (upstream #157). Components merge: omitted stay, and an '
        + 'all-default (amount 0) vignette clears the field.',
      ),
      grain: z.object({
        amount: z.number().finite().min(0).max(1).optional()
          .describe('Noise strength 0 to 1. 0 = no grain and clears it.'),
        size: z.number().finite().min(0.5).max(4).optional()
          .describe('Grain cell size in px, 0.5 to 4.'),
      }).optional().describe(
        'Film grain (upstream #157): monochromatic noise, strongest in the '
        + 'mid-tones, animated per frame. Components merge like vignette.',
      ),
      glow: z.object({
        intensity: z.number().finite().min(0).max(1).optional()
          .describe('Screen-blend strength 0 to 1. 0 = no glow and clears it.'),
        radius: z.number().finite().min(0).max(100).optional()
          .describe('Highlight-bleed blur radius in px, 0 to 100.'),
        threshold: z.number().finite().min(0).max(1).optional()
          .describe('Luma threshold isolating highlights, 0 to 1.'),
        warmth: z.number().finite().min(0).max(1).optional()
          .describe('Warm red-orange cast on the bleed, 0 to 1.'),
      }).optional().describe(
        'Glow / halation (upstream #157): blurred highlights screen-blended '
        + 'back. Components merge like vignette.',
      ),
    }).refine(
      (op) => op.clear === true || op.brightness !== undefined || op.contrast !== undefined
        || op.saturation !== undefined || op.hueRotation !== undefined || op.exposure !== undefined
        || op.temperature !== undefined || op.tint !== undefined || op.vibrance !== undefined
        || op.highlights !== undefined || op.shadows !== undefined
        || op.blacks !== undefined || op.whites !== undefined
        || op.invertColors !== undefined
        || op.lutPath !== undefined || op.lutIntensity !== undefined
        || op.blurRadius !== undefined
        || (op.vignette !== undefined && Object.keys(op.vignette).length > 0)
        || (op.grain !== undefined && Object.keys(op.grain).length > 0)
        || (op.glow !== undefined && Object.keys(op.glow).length > 0)
        || (op.curves !== undefined && Object.keys(op.curves).length > 0)
        || (op.wheels !== undefined && Object.keys(op.wheels).length > 0)
        || (op.hueCurves !== undefined && Object.keys(op.hueCurves).length > 0),
      { message: 'Pass at least one grade field, or clear: true.' },
    ),
  },

  listGradePresets: {
    name: 'list_grade_presets',
    description:
      'List the user-saved named color-grade/shot presets and their captured payloads. App-wide across editor windows.',
    parameters: z.object({}),
  },

  saveGradePreset: {
    name: 'save_grade_preset',
    description:
      'Capture the current complete color grade and normalized static shot settings of one video/image clip as a uniquely named preset. The name is trimmed; duplicate names are refused. Motion tracks are not captured and remain authoritative when present.',
    parameters: z.object({
      clipId: z.string().describe('The video or image clip whose current grade and static shot should be captured.'),
      name: z.string().min(1).describe(`Unique name for the saved preset (max ${GRADE_PRESET_NAME_MAX} characters after trimming).`),
    }),
  },

  renameGradePreset: {
    name: 'rename_grade_preset',
    description:
      'Rename a saved color-grade/shot preset. A case-insensitive collision with another preset fails without changing either row.',
    parameters: z.object({
      presetId: z.string().min(1).max(64).describe('ID returned by list_grade_presets or save_grade_preset.'),
      name: z.string().min(1).describe(`New unique preset name (max ${GRADE_PRESET_NAME_MAX} characters after trimming).`),
    }),
  },

  deleteGradePreset: {
    name: 'delete_grade_preset',
    description:
      'Delete a saved color-grade/shot preset by ID. Deleting an already absent ID is an idempotent no-op; clip links are left inert and referencing clip IDs are reported in the receipt.',
    parameters: z.object({
      presetId: z.string().min(1).max(64).describe('ID returned by list_grade_presets or save_grade_preset.'),
    }),
  },

  applyGradePreset: {
    name: 'apply_grade_preset',
    description:
      'Apply one saved grade/shot preset as a complete grade snapshot plus any carried normalized static shot fields to one clip, a selection, or every clip in the current project timeline in a single undo step. Provide exactly one target: clipId, clipIds, or allProjectClips:true; omitting all three is an error, not an all-project request. All-project mode refuses the whole call if any project clip is ineligible. Linking defaults to true; set linkPreset:false to apply the look but clear the existing link in the same undo step. Omitted grade fields reset to neutral; omitted shot fields and motion tracks are left untouched. Propagation is opt-in per call: omit propagate to touch only the requested clips, or pass propagate:"linked" to also cover the requested clips\' link groups, or propagate:"syncLock" to also cover their tracks and every track that follows sync lock. A propagated apply is still one undo step and refuses the whole call — changing nothing — if a covered clip cannot be written.',
    parameters: z.object({
      clipId: z.string().min(1).optional()
        .describe('One video or image clip to receive the saved snapshot.'),
      clipIds: z.array(z.string().min(1)).min(1).optional()
        .describe('A selection of video or image clip IDs to receive the saved snapshot.'),
      allProjectClips: z.literal(true).optional()
        .describe('Set true to target every clip in the current project timeline; use this explicit flag instead of omitting a target.'),
      linkPreset: z.boolean().optional()
        .describe('Record the applied preset ID on each target in the same undo step (default true); false clears the existing link.'),
      propagate: z.enum([...GRADE_PRESET_PROPAGATE_MODES]).optional()
        .describe('Opt in to writing past the requested clips: "linked" also covers their link groups (the A/V unit, skipping members that cannot take a grade), "syncLock" also covers their own tracks plus every track that never opted out of sync lock. Omit it to grade only the requested clips; an unknown mode is refused, never treated as off.'),
      presetId: z.string().min(1).max(64).describe('ID returned by list_grade_presets or save_grade_preset.'),
    }).refine(
      (args) => [args.clipId !== undefined, args.clipIds !== undefined, args.allProjectClips !== undefined]
        .filter(Boolean).length === 1,
      { message: 'Provide exactly one of clipId, clipIds, or allProjectClips:true.' },
    ),
  },

  setClipMotion: {
    name: 'set_clip_motion',
    description:
      'Animate a video/image/shape clip\'s position with keyframes (#535 v1.5): at least two {frame, value} points per axis; values interpolate between frames with easing and clamp at the ends. An empty points array clears that axis. Titles are static in v1. Scale axes (sx/sy) default to 1.0 (identity).',
    parameters: z.object({
      clipId: z.string().describe('The video, image, or shape clip to animate.'),
      axis: z.enum(['x', 'y', 'r', 'sx', 'sy']).describe('Which axis to animate: x position, y position, rotation (degrees), scale X, or scale Y.'),
      points: z.array(z.object({
        frame: z.number().int().min(0).describe('Timeline frame for this keyframe.'),
        value: z.number().finite().describe('Position value in pixels.'),
        easing: z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']).optional()
          .describe('Easing of the segment starting at this keyframe. Default linear.'),
      })).describe('Keyframes for this axis. At least two to animate; an empty array clears the axis.'),
    }),
  },

  setClipOpacityKeyframes: {
    name: 'set_clip_opacity_keyframes',
    description:
      'Animate opacity on a video, image, or generated clip with absolute timeline-frame keyframes: '
      + 'at least two {frame, value} points with value 0..1 and optional easing. An active track '
      + 'overrides static opacity; an empty array clears it and restores static opacity. This is '
      + 'separate from fadeInFrames/fadeOutFrames, which remain independent.',
    parameters: z.object({
      clipId: z.string().describe('The video, image, or generated clip to animate.'),
      points: z.array(z.object({
        frame: frameSchema.describe('Absolute timeline frame for this opacity keyframe.'),
        value: z.number().finite().min(0).max(1)
          .describe('Opacity at this frame, 0 (transparent) to 1 (opaque). Invalid values refuse the call.'),
        easing: z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']).optional()
          .describe('Easing of the segment starting at this keyframe. Default linear.'),
      })).describe('Opacity keyframes. At least two are required; an empty array clears the track.'),
    }),
  },

  setClipVolumeKeyframes: {
    name: 'set_clip_volume_keyframes',
    description:
      'Animate an audio clip\'s volume with decibel keyframes (upstream #535/#539-#541 audio slice): '
      + 'at least two {frame, value} points; values interpolate between frames with easing and clamp '
      + 'at the ends. An active track overrides the clip\'s static volume entirely. An empty points '
      + 'array clears the track and restores static volume control.',
    parameters: z.object({
      clipId: z.string().describe('The audio clip to animate.'),
      points: z.array(z.object({
        frame: z.number().int().min(0).describe('Timeline frame for this keyframe.'),
        value: z.number().finite().min(-60).max(15)
          .describe('Level in dB. 0 = source level, -60 = mute floor, +15 = boost ceiling.'),
        easing: z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']).optional()
          .describe('Easing of the segment starting at this keyframe. Default linear.'),
      })).describe('Keyframes for the volume track. At least two to animate; an empty array clears it.'),
    }),
  },

  setClipEq: {
    name: 'set_clip_eq',
    description:
      'Three-band EQ on an audio clip (upstream #158): low 100 Hz shelf, mid 1 kHz bell, high 3 kHz shelf, '
      + 'each -15 to +15 dB. Preview and export apply the exact same bands. Omitted bands stay untouched; '
      + 'a band passed 0 clears just that band, and clear: true resets all three.',
    parameters: z.object({
      clipId: z.string().describe('The audio clip to equalize.'),
      lowDb: z.number().finite().min(-15).max(15).optional()
        .describe('Low shelf gain at 100 Hz, -15 to 15 dB. 0 = neutral.'),
      midDb: z.number().finite().min(-15).max(15).optional()
        .describe('Mid bell gain at 1 kHz (Q 1), -15 to 15 dB. 0 = neutral.'),
      highDb: z.number().finite().min(-15).max(15).optional()
        .describe('High shelf gain at 3 kHz, -15 to 15 dB. 0 = neutral.'),
      clear: z.boolean().optional().describe('Reset all three bands to neutral.'),
    }).refine(
      (op) => op.clear === true || op.lowDb !== undefined || op.midDb !== undefined || op.highDb !== undefined,
      { message: 'Pass at least one band, or clear: true.' },
    ),
  },

  setClipCompressor: {
    name: 'set_clip_compressor',
    description:
      'Compress or limit an audio clip (upstream #158). Threshold (dBFS), ratio (1-20), attack and release (ms), '
      + 'and makeup gain (dB) drive both the live preview and the FFmpeg export. Omitted fields stay untouched; '
      + 'ratio 1 turns the compressor off, and clear: true removes it. Arm one by passing any field.',
    parameters: z.object({
      clipId: z.string().describe('The audio clip to compress.'),
      thresholdDb: z.number().finite().min(-60).max(0).optional()
        .describe('Threshold in dBFS, -60 to 0. Signals above it are compressed.'),
      ratio: z.number().finite().min(1).max(20).optional()
        .describe('Compression ratio 1-20. 1 = off and removes the compressor.'),
      attackMs: z.number().finite().min(0.01).max(2000).optional()
        .describe('Attack in milliseconds.'),
      releaseMs: z.number().finite().min(0.01).max(9000).optional()
        .describe('Release in milliseconds.'),
      makeupDb: z.number().finite().min(0).max(24).optional()
        .describe('Makeup gain in dB, 0-24.'),
      clear: z.boolean().optional().describe('Remove the compressor.'),
    }).refine(
      (op) => op.clear === true || op.thresholdDb !== undefined || op.ratio !== undefined
        || op.attackMs !== undefined || op.releaseMs !== undefined || op.makeupDb !== undefined,
      { message: 'Pass at least one compressor field, or clear: true.' },
    ),
  },

  setClipNoiseReduction: {
    name: 'set_clip_noise_reduction',
    description:
      'Reduce background noise on an audio clip (upstream #165). Strength 1-100 drives both the '
      + 'live preview and the FFmpeg export (afftdn). 0 and clear: true both remove the stage — '
      + 'matching the Inspector, whose slider deletes the field at 0 rather than storing an off value.',
    parameters: z.object({
      clipId: z.string().describe('The audio clip to denoise.'),
      noiseReduction: z.number().int().min(0).max(100).optional()
        .describe('Strength percent. 1-100 sets/overwrites; 0 removes the stage.'),
      clear: z.boolean().optional().describe('Remove the noise reduction (same effect as passing 0).'),
    }).refine(
      (op) => op.clear === true || op.noiseReduction !== undefined,
      { message: 'Pass noiseReduction, or clear: true.' },
    ),
  },

  applyLayout: {
    name: 'apply_layout',
    description:
      'Arrange visual clips into a grid mosaic (upstream #410, #493). Each clip fills an equal cell of the project canvas. '
      + 'Clip ids are mapped to cells in order (first = top-left). Audio clips are skipped. '
      + 'Grid presets: grid_2x2 (4 cells), grid_3x3 (9 cells), grid_4x4 (16 cells), three_stack (3 full-width rows: top, middle, bottom). '
      + 'Clips beyond the grid capacity are left untouched. Undoable.',
    parameters: z.object({
      clipIds: z.array(z.string().min(1)).min(1)
        .describe('Clip IDs to arrange, in row-major order (top-left to bottom-right; three_stack rows run top to bottom).'),
      preset: z.enum(['grid_2x2', 'grid_3x3', 'grid_4x4', 'three_stack'])
        .describe('Grid layout preset.'),
    }),
  },

  importFcpxml: {
    name: 'import_fcpxml',
    description:
      'Import a Final Cut Pro XML (.fcpxml) file: media assets are probed into the library, tracks are created for the lanes, and picture/audio/title clips are placed on them. Clip placement/trims, lanes, roles, titles (styling), static and keyframed opacity, transform (position/scale/rotation) including its keyframes, crop, volume and source timecode survive the trip; grades, effects, shape/generator constructs, edge rounding/softness, crop keyframes, keyframed audio volume, audio fades and title transform/opacity keyframes are skipped and reported. Additive — existing timeline content is untouched.',
    parameters: z.object({
      path: z.string().min(1).describe('Absolute path to the .fcpxml file.'),
    }),
  },

  exportFcpxml: {
    name: 'export_fcpxml',
    description:
      'Write the current timeline as Final Cut Pro XML 1.11 for Resolve / FCP / Premiere: clip placement/trims, lanes, roles, title text with styling, static and keyframed opacity, transform (position/scale/rotation) including its keyframes, crop, volume and source timecode. Grades, effects, edge rounding/softness, crop keyframes, keyframed audio volume, audio fades and title transform/opacity keyframes are not represented. Shape clips and clips with missing media are skipped and reported in the receipt (unsupported list with counts).',
    parameters: z.object({
      path: z.string().min(1).describe('Absolute destination path for the .fcpxml file.'),
    }),
  },

  describeMedia: {
    name: 'describe_media',
    description:
      'Generate a one-sentence AI description for a library image/video asset (upstream #118) from a single capped frame, using the user\'s own configured vision provider (billed to their key). Explicit only — never call it unless the user asked to describe that asset. The sentence is stored on the asset and becomes searchable in the media library. Undoable.',
    parameters: z.object({
      assetId: z.string().describe('Library asset to describe (video or image; audio is refused).'),
    }),
  },

  loadSkill: {
    name: 'load_skill',
    description:
      'Load the full workflow of one enabled agent skill (Track 2, L7): podcast cleanup, shorts reframe, subtitle burn-in. '
      + 'Enabled skill names and one-line descriptions are listed in the system prompt under "Available skills"; call this with the name to read the body before starting that kind of task. '
      + 'Returns advisory text only — it never edits the project, so follow it with the normal tools.',
    parameters: z.object({
      name: z.string().min(1).describe('Skill name from the "Available skills" index.'),
    }),
  },
} as const;

// ─── Type helpers ────────────────────────────────────────────────────────────

export type ToolName = (typeof tools)[keyof typeof tools]['name'];

export function getToolByName(name: string) {
  return Object.values(tools).find((t) => t.name === name);
}

/**
 * Tools that only observe project state (Track 2, L5 — docs/AGENTIC_ROADMAP.md).
 *
 * The agent may run a run of consecutive read-only calls concurrently, which is
 * only safe because these tools neither mutate the project nor push an undo
 * entry. Kept as a side table rather than a field on each schema: the model
 * must not see it, and the conservative default (absent ⇒ mutating ⇒ serialized)
 * means a new tool is safe until it is deliberately listed here.
 *
 * `inspect_frame` reads pixels and writes a scratch file, not project state;
 * `export_project`/`export_fcpxml` write output files and are still mutating
 * here because they read the live timeline and are far too heavy to fan out.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'get_timeline',
  'get_clips',
  'get_media',
  'list_grade_presets',
  'verify_timeline',
  'inspect_frame',
  // L7: returns advisory text as data; it neither mutates the project nor
  // pushes an undo entry, so it is safe to run alongside other reads.
  'load_skill',
]);

/** True when a tool is classified read-only; unknown tools are mutating. */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

/** Convert all tool schemas to JSON Schema (for MCP tool listing) */
export function toolsToJsonSchema() {
  return Object.values(tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.parameters),
  }));
}

const MAX_ZOD_SCHEMA_DEPTH = 12;

// Minimal Zod → JSON Schema conversion for MCP compatibility
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Runtime refinements are transparent for discovery; keep the historical
  // object fallback for a non-object top-level schema.
  const converted = zodFieldToSchema(schema, 0, new Set());
  return converted.type === 'object' ? converted : { type: 'object' };
}

function zodFieldToSchema(
  field: z.ZodTypeAny,
  depth: number,
  active: Set<z.ZodTypeAny>,
): Record<string, unknown> {
  if (depth >= MAX_ZOD_SCHEMA_DEPTH || active.has(field)) {
    return zodStringFallback(field);
  }

  active.add(field);
  try {
    if (field instanceof z.ZodString) {
      return zodWithDescription({ type: 'string', description: field.description }, field);
    }
    if (field instanceof z.ZodNumber) {
      return zodWithDescription({ type: 'number', description: field.description }, field);
    }
    if (field instanceof z.ZodBoolean) {
      return zodWithDescription({ type: 'boolean', description: field.description }, field);
    }
    if (field instanceof z.ZodEnum) {
      return zodWithDescription({ type: 'string', enum: field.options, description: field.description }, field);
    }
    if (field instanceof z.ZodLiteral) {
      const type = zodLiteralType(field.value);
      return type
        ? zodWithDescription({ type, const: field.value }, field)
        : zodStringFallback(field);
    }
    if (field instanceof z.ZodEffects) {
      return zodWithDescription(zodFieldToSchema(field.innerType(), depth, active), field);
    }
    if (field instanceof z.ZodOptional) {
      return zodWithDescription(
        { ...zodFieldToSchema(field.unwrap(), depth, active), optional: true },
        field,
      );
    }
    if (field instanceof z.ZodDefault) {
      return zodWithDescription(zodFieldToSchema(field.removeDefault(), depth, active), field);
    }
    if (field instanceof z.ZodObject) {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(field.shape)) {
        const zodField = value as z.ZodTypeAny;
        properties[key] = zodFieldToSchema(zodField, depth + 1, active);
        if (!isOptionalZodField(zodField)) required.push(key);
      }

      return zodWithDescription(
        {
          type: 'object',
          properties,
          required: required.length > 0 ? required : undefined,
        },
        field,
      );
    }
    if (field instanceof z.ZodArray) {
      return zodWithDescription(
        { type: 'array', items: zodFieldToSchema(field.element, depth + 1, active) },
        field,
      );
    }
    return zodStringFallback(field);
  } catch {
    // Tool discovery must remain available even for a malformed/unsupported
    // plugin schema. Runtime validation remains the source of truth.
    return zodStringFallback(field);
  } finally {
    active.delete(field);
  }
}

function isOptionalZodField(field: z.ZodTypeAny): boolean {
  const seen = new Set<z.ZodTypeAny>();
  let current: z.ZodTypeAny | undefined = field;

  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) return true;
    if (current instanceof z.ZodEffects) {
      current = current.innerType();
      continue;
    }
    if (current instanceof z.ZodNullable) {
      current = current.unwrap();
      continue;
    }
    return false;
  }
  return false;
}

function zodWithDescription(
  schema: Record<string, unknown>,
  field: z.ZodTypeAny,
): Record<string, unknown> {
  return field.description === undefined
    ? schema
    : { ...schema, description: field.description };
}

function zodStringFallback(field: z.ZodTypeAny): Record<string, unknown> {
  return zodWithDescription({ type: 'string' }, field);
}

function zodLiteralType(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isFinite(value) ? 'number' : undefined;
    default:
      return undefined;
  }
}




