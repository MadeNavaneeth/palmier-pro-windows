/**
 * Project data model — the .vproj file schema.
 * Frame-based time throughout (integers), matching upstream Palmier Pro.
 */

import type { BlendMode } from './blend-mode';
import type { ClipTransition } from '../editor/transition';

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
}

// ─── Timeline ────────────────────────────────────────────────────────────────

export type ClipType = 'video' | 'audio' | 'image' | 'title' | 'generated';

export interface Clip {
  id: string;
  assetId: string; // references MediaAsset.id
  type: ClipType;
  trackId: string;

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

  // Metadata
  label?: string;
  color?: string;
}

export type TrackType = 'video' | 'audio';

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  locked: boolean;
  visible: boolean; // video: visibility, audio: mute
  order: number; // rendering order (higher = on top for video)
}

export interface Timeline {
  tracks: Track[];
  clips: Clip[];
  playheadFrame: Frame;
  inFrame?: Frame;
  outFrame?: Frame;
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
    version: 1,
    name,
    settings: { ...DEFAULT_PROJECT_SETTINGS },
    media: [],
    timeline: {
      tracks: [
        { id: 'v1', name: 'Video 1', type: 'video', locked: false, visible: true, order: 1 },
        { id: 'a1', name: 'Audio 1', type: 'audio', locked: false, visible: true, order: 0 },
      ],
      clips: [],
      playheadFrame: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}
