/**
 * Project data model — the .vproj file schema.
 * Frame-based time throughout (integers), matching upstream Palmier Pro.
 */

import type { BlendMode } from './blend-mode';
import type { ClipTransition } from '../editor/transition';
import type { TimelineMarker } from '../editor/markers';
import type { GradeCurve, GradeWheels, HueCurves, LutRef } from '../editor/color-grade';
import type { Clarity, Glow, Grain, Vignette } from '../editor/effects';
import type { MotionTrack } from '../media/motion';

// ─── Core time type ──────────────────────────────────────────────────────────

/** Frame index (0-based integer). All timing is frame-based. */
export type Frame = number;

// ─── Media ───────────────────────────────────────────────────────────────────

export interface MediaAsset {
  id: string;
  path: string;
  filename: string;
  type: 'video' | 'audio' | 'image';
  duration: Frame; // 0 for images (use as still)
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
  fileSize: number;
  thumbnailPath?: string;
  addedAt: string; // ISO timestamp
  /**
   * Embedded SMPTE start timecode (`HH:MM:SS:FF`), when the source carries
   * one (#154). Round-trips through FCPXML assets so conform workflows keep
   * the source offset.
   */
  startTimecode?: string;
  /**
   * Lightweight mezzanine used for preview/decode only (roadmap R2).
   * Exports always read `path`.
   */
  proxyPath?: string;
  /**
   * Generation provenance (upstream PR #570). Present when the asset was
   * created by an AI generation provider rather than imported from disk.
   */
  generatedBy?: {
    provider: string;
    model: string;
    costCredits?: number;
    /**
     * Local reference image the generation was conditioned on, when one was
     * supplied (image generation only). Recorded next to the provider and model
     * so the Inspector's provenance row can show what the result came from.
     */
    referenceImagePath?: string;
  };
  /**
   * On-demand vision-model description for library search (upstream #118,
   * AI half). Written only by an explicit Describe action (media tile/panel
   * button or the `describe_media` agent tool) via sanitizeAiDescription and
   * narrowed on load via narrowAiDescription; absent means undescribed.
   * Stored in the project only — never cached elsewhere — and sent to the
   * user's own configured provider only, at describe time.
   */
  aiDescription?: string;
  /**
   * Media-library folder membership (upstream issue #156 slice). Absent or
   * an unknown id means the asset sits at the library root; narrowed on
   * load via narrowMediaFolders so a dangling id degrades to root rather
   * than breaking the project.
   */
  folderId?: string;
}

/**
 * A flat media-library folder (upstream issue #156 slice). One level only
 * — no nesting — so cycles are impossible by construction and the grid's
 * drill-in UI matches the model.
 */
export interface MediaFolder {
  id: string;
  name: string;
}

// ─── Timeline ────────────────────────────────────────────────────────────────

export type ClipType = 'video' | 'audio' | 'image' | 'title' | 'generated' | 'shape' | 'compound';

export interface Clip {
  id: string;
  assetId: string; // references MediaAsset.id
  type: ClipType;
  trackId: string;
  /**
   * Clips created from the same source placement share a link group so the
   * editor can keep picture and embedded audio together. Optional for projects
   * saved before linked placement existed.
   */
  linkGroupId?: string;

  // Position on timeline (frames)
  startFrame: Frame; // where clip begins on timeline
  durationFrames: Frame; // visible duration on timeline
  inPoint: Frame; // source trim start
  outPoint: Frame; // source trim end

  // Visual properties
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // degrees
  scaleX: number;
  scaleY: number;
  opacity: number; // 0-1
  /**
   * Optional absolute-timeline opacity automation. Values are 0..1 and use the
   * shared motion-point shape/easing; an active track overrides `opacity`.
   * This is independent of the separate fadeInFrames/fadeOutFrames ramps.
   */
  opacityTrack?: MotionTrack;
  anchorX: number;
  anchorY: number;

  /**
   * ID of the named grade/shot preset that last produced this clip's look.
   * Metadata only: manual edits may make the link stale, and a deleted preset
   * leaves it inert. Narrowed on project load by the shared preset contract.
   */
  gradePresetId?: string;

  /**
   * Layer blend mode. Undefined = 'normal' (source-over), kept optional for
   * backward compatibility with projects saved before blend modes existed.
   * Only meaningful for visual clips (video/image/title/generated).
   */
  blendMode?: BlendMode;

  /**
   * Transition fades, in frames. A fade-in ramps the clip's effective opacity
   * 0→1 over the first `fadeInFrames`; a fade-out ramps 1→0 over the last
   * `fadeOutFrames`. Undefined/0 = no fade. Two adjacent clips with matching
   * fade-out / fade-in over an overlap form a cross-dissolve.
   */
  fadeInFrames?: Frame;
  fadeOutFrames?: Frame;

  /**
   * Geometric in-transition (wipe or slide) over the clip's first frames.
   * See shared/editor/transition.ts. Undefined = none.
   */
  transitionIn?: ClipTransition;

  // Audio
  volume: number; // 0-1
  muted: boolean;
  /** Stereo balance, -1 hard left … +1 hard right (R5). Audio clips only. */
  pan?: number;
  /**
   * Three-band EQ in dB, ±15 (upstream #158). Low 100 Hz shelf, mid 1 kHz
   * peaking, high 3 kHz shelf — the same bands the preview biquads and the
   * FFmpeg export chain use. Absent/0 = neutral. Audio clips only.
   */
  eqLowDb?: number;
  eqMidDb?: number;
  eqHighDb?: number;
  /**
   * Compressor/limiter (upstream #158). Ratio 1 = off; ratio > 1 compresses
   * above the threshold. Preview runs a DynamicsCompressorNode, export an
   * FFmpeg `acompressor`, both driven by these five values. Audio only.
   */
  compressor?: {
    thresholdDb: number;
    ratio: number;
    attackMs: number;
    releaseMs: number;
    makeupDb: number;
  };
  /**
   * Noise reduction strength in percent, 0-100 (upstream #165). Absent/0 =
   * off. Export runs FFmpeg `afftdn`; preview approximates with a highpass
   * and highshelf pair — see shared/audio/denoise.ts for the mapping.
   * Audio clips only.
   */
  noiseReduction?: number;

  // Metadata
  label?: string;
  color?: string;

  /**
   * Title clip content (R3 foundation). Only meaningful when `type` is
   * `'title'`; sanitized via sanitizeTitleText, rendered by the preview
   * canvas and baked into exports with FFmpeg drawtext.
   */
  text?: string;
  /** Title font size as a fraction of project height. */
  titleSizeRatio?: number;
  /** Title color as #rrggbb. */
  titleColor?: string;
  /** CSS font family for the title. Default sans-serif. */
  titleFontFamily?: string;
  /** Font weight for the title. Default normal. */
  titleBold?: boolean;
  /** Horizontal alignment within the clip box. Default center. */
  titleAlign?: 'left' | 'center' | 'right';
  /** Semi-transparent background box behind text. Undefined = none. */
  titleBackgroundColor?: string;
  /** Background box padding in px at project resolution (#507 fitted boxes). */
  titleBackgroundPadding?: number;
  /** Extra space between wrapped lines in px at project resolution (#330). */
  titleLineSpacing?: number;
  /** Case applied to the text before rendering (upstream #330). */
  titleFontCase?: 'original' | 'upper' | 'lower';
  /**
   * Advanced fill mode (upstream TextFillMode): footage knocks the glyphs
   * out of a matte band so the video shows through; inverted difference-
   * blends a white silhouette against the frame. Absent = solid color.
   */
  titleFillMode?: 'footage' | 'inverted';
  /** Gaussian blur applied to the rendered text layer, in px (#529). */
  titleBlurRadius?: number;
  /** Perspective tilt around the vertical axis, in degrees (#519). */
  titleTiltXDeg?: number;
  /** Perspective tilt around the horizontal axis, in degrees (#519). */
  titleTiltYDeg?: number;
  /** Static source crop as edge fractions, applied before position/scale (#568). */
  crop?: { left: number; right: number; top: number; bottom: number };
  /**
   * Edge rounding (corner radius) as normalized 0–1 (#369). 0 = square corners,
   * 1 = fully rounded (ellipse). Applied in compositor after crop/effects,
   * before transform/opacity. Visual clips only.
   */
  edgeRounding?: number;
  /**
   * Edge softness (feathered alpha) as normalized 0–1 (#369). 0 = hard edge,
   * 1 = maximum feather. Applied together with edgeRounding. Visual clips only.
   */
  edgeSoftness?: number;
  /**
   * Chroma key / green-blue screen removal (upstream issue #97). Absent or
   * tolerance 0 means no key. Applied after crop, before edge rounding.
   * Visual clips only.
   */
  chromaKey?: {
    keyColor: string; // #rrggbb
    tolerance: number; // 0-1, 0 = off
    softness?: number; // 0-1, edge feather
    spill?: number; // 0-1, spill suppression strength
  };
  /**
   * Position motion tracks (keyframes v1): linear x/y over the timeline.
   * Video/image/shape clips only; titles are static in v1. Absent = static x/y.
   */
  motionX?: Array<{ frame: number; value: number }>;
  motionY?: Array<{ frame: number; value: number }>;
  /** Rotation motion track in degrees (keyframes v1). */
  motionRot?: Array<{ frame: number; value: number }>;
  /** Scale X motion track (keyframes v1). Default 1 (identity). */
  motionScaleX?: Array<{ frame: number; value: number }>;
  /** Scale Y motion track (keyframes v1). Default 1 (identity). */
  motionScaleY?: Array<{ frame: number; value: number }>;
  /**
   * Volume automation in decibels (upstream #535/#539-#541 audio slice).
   * Absolute timeline frames, like the motion tracks above — not rebased
   * when the clip moves. Audio clips only. An active track is authoritative
   * over `volume` (the static linear field); absent means use `volume`.
   */
  volumeDb?: Array<{ frame: number; value: number; easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' }>;
  /** Outline stroke width in px at project resolution. Default 0 = off. */
  titleStrokeWidth?: number;
  /** Outline stroke color. */
  titleStrokeColor?: string;
  /**
   * Variable-font axes (upstream issue #50; original design — no upstream
   * implementation at b4b1333). Applied via CSS `font-variation-settings`
   * in the shared canvas title renderer, so preview and the export bake
   * agree; non-variable fonts ignore unknown axes. Absent = the font's
   * default for that axis (wght 400, wdth 100, slnt 0, ital 0), which is
   * why defaults are never stored. Sanitized on write and on read via
   * shared/editor/title.ts; a title with any axis present takes the bake
   * pipeline because drawtext cannot express axes. No fonts are bundled —
   * the axes apply to whatever variable font the user has (system or
   * project-referenced), falling back silently like any unknown family.
   */
  titleVariationWght?: number;
  titleVariationWdth?: number;
  titleVariationSlnt?: number;
  titleVariationItal?: number;
  /**
   * Shape clip kind (tutorial-overlay annotations). Only meaningful when
   * `type` is `'shape'`; sanitized via shared/editor/shape.ts, rendered by
   * the shared shape renderer in preview and baked into exports as RGBA.
   * Absent = 'rect'.
   */
  shapeKind?: 'rect' | 'ellipse' | 'line' | 'arrow';
  /** Shape stroke color as #rrggbb. Default white. */
  shapeStrokeColor?: string;
  /** Shape stroke width in px at project resolution. 0/absent = no stroke. */
  shapeStrokeWidth?: number;
  /**
   * Shape fill color as #rrggbbaa. Absent = no fill (transparent). Lines and
   * arrows are stroke-only and ignore this field.
   */
  shapeFillColor?: string;
  /**
   * Constant playback speed (R4 groundwork): 1 = normal, 2 = twice as fast.
   * Timeline duration is unchanged -- the clip consumes speed× more of its
   * source per timeline frame, expressed via outPoint and applied in the
   * shared source-time mapping. Visual clips only.
   */
  speed?: number;
  /**
   * Nested-sequence reference (upstream issue #155, slice 1). Only meaningful
   * when `type` is `'compound'`; the id keys `Project.timelines`. The clip's
   * own `inPoint`/`outPoint`/`durationFrames` are the source window into that
   * timeline — the same contract media clips use against an asset — so trim,
   * split, move, and the shared source-time mapping work unchanged. The
   * referenced timeline stores project frames (no per-timeline fps).
   */
  compoundTimelineId?: string;
  // ─── Color grading basics (R4) ──────────────────────────────────────────
  /** Brightness adjustment, -1 (black) to 1 (white overlay). Default 0. */
  brightness?: number;
  /** Contrast multiplier. Default 1 (no change); 0 = flat grey. */
  contrast?: number;
  /** Saturation multiplier. Default 1 (no change); 0 = greyscale. */
  saturation?: number;
  /** Hue rotation in degrees, -180 to 180. Default 0. */
  hueRotation?: number;
  /**
   * Exposure in EV stops, -5 to +5 (upstream #157 Tone). Multiplicative gain
   * of 2^ev applied before every other grade operation. Default 0.
   */
  exposure?: number;
  /**
   * White-balance temperature in Kelvin, 2000 to 11000 (upstream #157 Tone).
   * 6500 is neutral daylight; lower warms, higher cools. Default 6500.
   */
  temperature?: number;
  /**
   * White-balance tint, -100 (green) to +100 (magenta). Default 0.
   */
  tint?: number;
  /**
   * Vibrance (selective saturation), -1 to +1 (upstream #157 Presence).
   * Boosts muted tones more than already-saturated ones; negative values
   * desaturate toward grey. Default 0.
   */
  vibrance?: number;
  /**
   * Highlights gain, -1 to +1 (upstream #157 Tone). Luma-masked lift of
   * bright tones, peaking at white. Default 0.
   */
  highlights?: number;
  /**
   * Shadows gain, -1 to +1 (upstream #157 Tone). Luma-masked lift of dark
   * tones, peaking at black. Default 0.
   */
  shadows?: number;
  /**
   * Black-point shift, -1 to +1 (upstream #157 Tone). Negative crushes the
   * floor, positive lifts it. Default 0.
   */
  blacks?: number;
  /**
   * White-point shift, -1 to +1 (upstream #157 Tone). Positive brightens and
   * clips the ceiling, negative recovers it. Default 0.
   */
  whites?: number;
  /**
   * Invert colors effect (upstream PR #408). Complements RGB channels while
   * preserving alpha, producing a flash/negative look. Default false.
   */
  invertColors?: boolean;
  /**
   * Tone curves (upstream #157 Curves): master Rec.709 luma plus per-channel
   * R/G/B control points in [0,1], applied after the scalar grade and before
   * hue/invert. Sanitized on write and on read via
   * shared/editor/color-grade.ts; absent or identity = no curve.
   */
  curves?: GradeCurve;
  /**
   * Lift/gamma/gain color wheels (upstream #157 Wheels): pad positions plus
   * master scalars per zone, applied after the scalar grade and before the
   * tone curves. Sanitized on write and on read via
   * shared/editor/color-grade.ts; absent or identity = no wheels.
   */
  wheels?: GradeWheels;
  /**
   * Hue-vs-hue/saturation/luminance curves (upstream #157 Hue Curves):
   * hue-selective adjustments sampled at the pixel's display-space hue,
   * applied after the tone curves. Sanitized on write and on read via
   * shared/editor/color-grade.ts; absent or neutral = no hue curves.
   */
  hueCurves?: HueCurves;
  /**
   * .cube LUT reference (upstream #157 LUTs): the file applied after the
   * hue curves, blended by `intensity` (0..1, default 1). References the
   * user's file in place — validated on use, so a moved file degrades to
   * ungraded with a diagnostic instead of failing the load. Sanitized on
   * write and on read via shared/editor/color-grade.ts; absent = no LUT.
   */
  lut?: LutRef;
  /**
   * Gaussian blur radius in px, 0..100 (upstream #157 `blur.gaussian`).
   * Applied after the full color grade; absent or 0 = sharp. Sanitized via
   * shared/editor/effects.ts.
   */
  blurRadius?: number;
  /**
   * Clarity & Dehaze (upstream #157 `detail.clarity`, upstream's only Detail
   * entry): local-contrast unsharp against a blur of max(W,H)/40 plus a
   * dark-channel-prior dehaze. Runs after the color grade and ahead of the
   * blur, per upstream's canonical order. Sanitized via
   * shared/editor/effects.ts; absent or both components 0 = off.
   */
  clarity?: Clarity;
  /**
   * Vignette (upstream #157 `stylize.vignette`): edge gain plus shape,
   * applied after the color grade. Sanitized via shared/editor/effects.ts;
   * absent or amount 0 = no vignette.
   */
  vignette?: Vignette;
  /**
   * Film grain (upstream #157 `stylize.grain`): animated monochromatic
   * noise, applied after the color grade. Sanitized via
   * shared/editor/effects.ts; absent or amount 0 = no grain.
   */
  grain?: Grain;
  /**
   * Glow / halation (upstream #157 `stylize.glow`): blurred highlights
   * screen-blended back, applied after the color grade. Sanitized via
   * shared/editor/effects.ts; absent or intensity 0 = no glow.
   */
  glow?: Glow;
}

export type TrackType = 'video' | 'audio';

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  locked: boolean;
  visible: boolean; // video: visibility, audio: mute
  /** UI-only solo state — never persisted, cleared on project load. */
  soloed?: boolean;
  /**
   * Participates in ripple edits initiated on another track. Optional so
   * projects saved before sync lock support retain the professional default.
   */
  syncLocked?: boolean;
  order: number; // rendering order (higher = on top for video)
}

export interface Timeline {
  tracks: Track[];
  clips: Clip[];
  playheadFrame: Frame;
  inFrame?: Frame;
  outFrame?: Frame;
  /**
   * Display name for a nested sequence (`Project.timelines`). Optional so
   * older projects decode unchanged; the main timeline never needs one.
   */
  name?: string;
  /**
   * Review notes anchored to timeline frames (upstream PR #542). Optional so
   * projects saved before markers existed decode unchanged; always sorted by
   * (startFrame, id) when written.
   */
  markers?: TimelineMarker[];
  /** Comp track id for take auditioning (upstream PR #428). */
  compTrackId?: string;
}

// ─── Project ─────────────────────────────────────────────────────────────────

export interface ProjectSettings {
  width: number; // canvas width (px)
  height: number; // canvas height (px)
  fps: number; // project frame rate
  sampleRate: number; // audio sample rate
  backgroundColor: string; // hex
}

export interface Project {
  version: number; // schema version
  name: string;
  settings: ProjectSettings;
  media: MediaAsset[];
  timeline: Timeline;
  /**
   * Nested sequences by id (upstream issue #155, slice 1). Absent for
   * projects saved before compound clips existed; a `compound` clip's
   * `compoundTimelineId` keys this record.
   */
  timelines?: Record<string, Timeline>;
  /**
   * Flat media-library folders (upstream issue #156 slice). Absent for
   * projects saved before folders existed; `MediaAsset.folderId` points
   * into this list and degrades to root when the id is unknown.
   */
  mediaFolders?: MediaFolder[];
  createdAt: string;
  updatedAt: string;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  sampleRate: 48000,
  backgroundColor: '#000000',
};

export function createEmptyProject(name = 'Untitled Project'): Project {
  const now = new Date().toISOString();
  return {
    version: 2,
    name,
    settings: { ...DEFAULT_PROJECT_SETTINGS },
    media: [],
    timeline: {
      tracks: [
        {
          id: 'v1',
          name: 'Video 1',
          type: 'video',
          locked: false,
          visible: true,
          syncLocked: true,
          order: 1,
        },
        {
          id: 'a1',
          name: 'Audio 1',
          type: 'audio',
          locked: false,
          visible: true,
          syncLocked: true,
          order: 0,
        },
      ],
      clips: [],
      playheadFrame: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}
