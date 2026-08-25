/**
 * Project data model — the .vproj file schema.
 * Frame-based time throughout (integers), matching upstream Palmier Pro.
 */

import type { BlendMode } from './blend-mode';
import type { ClipTransition } from '../editor/transition';
import type { TimelineMarker } from '../editor/markers';

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
   * Lightweight mezzanine used for preview/decode only (roadmap R2).
   * Exports always read `path`.
   */
  proxyPath?: string;
}

// ─── Timeline ────────────────────────────────────────────────────────────────

export type ClipType = 'video' | 'audio' | 'image' | 'title' | 'generated';

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
  anchorX: number;
  anchorY: number;

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
  /** Outline stroke width in px at project resolution. Default 0 = off. */
  titleStrokeWidth?: number;
  /** Outline stroke color. */
  titleStrokeColor?: string;
  /**
   * Constant playback speed (R4 groundwork): 1 = normal, 2 = twice as fast.
   * Timeline duration is unchanged -- the clip consumes speed× more of its
   * source per timeline frame, expressed via outPoint and applied in the
   * shared source-time mapping. Visual clips only.
   */
  speed?: number;
  // ─── Color grading basics (R4) ──────────────────────────────────────────
  /** Brightness adjustment, -1 (black) to 1 (white overlay). Default 0. */
  brightness?: number;
  /** Contrast multiplier. Default 1 (no change); 0 = flat grey. */
  contrast?: number;
  /** Saturation multiplier. Default 1 (no change); 0 = greyscale. */
  saturation?: number;
  /** Hue rotation in degrees, -180 to 180. Default 0. */
  hueRotation?: number;
}

export type TrackType = 'video' | 'audio';

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  locked: boolean;
  visible: boolean; // video: visibility, audio: mute
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
   * Review notes anchored to timeline frames (upstream PR #542). Optional so
   * projects saved before markers existed decode unchanged; always sorted by
   * (startFrame, id) when written.
   */
  markers?: TimelineMarker[];
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
