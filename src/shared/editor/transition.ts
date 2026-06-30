/**
 * Geometric transitions: wipe and slide (incoming-clip reveal).
 *
 * Unlike fades (opacity ramps), these are per-pixel / per-position effects:
 *  - WIPE  — a soft edge sweeps across the clip, revealing it from one side.
 *            Implemented as an alpha mask in the GPU shader (and CPU fallback).
 *  - SLIDE — the clip translates in from an offscreen edge over the window.
 *            Implemented by offsetting the layer transform (no shader change).
 *
 * A transition occupies the first `frames` of the clip (the "in" reveal), which
 * is what cross-transitions between two adjacent clips use (the incoming clip
 * wipes/slides over the outgoing one during their overlap).
 */

import type { Clip, Frame } from '../types/project';

export type TransitionDirection = 'left' | 'right' | 'up' | 'down';
export type TransitionType = 'wipe' | 'slide';

export interface ClipTransition {
  type: TransitionType;
  /** Edge the clip is revealed/enters from. */
  direction: TransitionDirection;
  frames: Frame;
  /** Wipe edge softness as a fraction of the clip dimension (0–0.5). Default ~0.05. */
  softness?: number;
}

/** Wipe mode indices — MUST match composite.wgsl and lib.rs. */
export const WIPE_MODE: Record<'none' | TransitionDirection, number> = {
  none: 0,
  left: 1,
  right: 2,
  up: 3,
  down: 4,
};

/**
 * Progress through the in-transition at a timeline frame.
 * Returns 0..1 while the transition is active, or null when there is no
 * transition or it has completed (clip fully shown — no effect).
 */
export function transitionInProgress(clip: Clip, timelineFrame: Frame): number | null {
  const t = clip.transitionIn;
  if (!t || t.frames <= 0) return null;
  const local = timelineFrame - clip.startFrame;
  if (local < 0) return 0;
  if (local >= t.frames) return null; // completed → fully visible
  return local / t.frames;
}

export interface WipeParams {
  mode: number; // WIPE_MODE value (0 = none/fully revealed)
  progress: number; // 0..1
  softness: number;
}

/** Wipe parameters for the compositor at a given frame. */
export function wipeParamsFor(clip: Clip, timelineFrame: Frame): WipeParams {
  const t = clip.transitionIn;
  if (!t || t.type !== 'wipe') return { mode: 0, progress: 1, softness: 0 };
  const p = transitionInProgress(clip, timelineFrame);
  if (p === null) return { mode: 0, progress: 1, softness: 0 }; // done → no mask
  const softness = Math.max(0, Math.min(0.5, t.softness ?? 0.05));
  return { mode: WIPE_MODE[t.direction], progress: p, softness };
}

export interface SlideOffset {
  dx: number;
  dy: number;
}

/**
 * Pixel offset for a slide-in at a given frame. The clip starts fully offscreen
 * along `direction` and moves to its resting position as progress → 1.
 */
export function slideOffsetFor(clip: Clip, timelineFrame: Frame): SlideOffset {
  const t = clip.transitionIn;
  if (!t || t.type !== 'slide') return { dx: 0, dy: 0 };
  const p = transitionInProgress(clip, timelineFrame);
  if (p === null) return { dx: 0, dy: 0 };
  const off = 1 - p; // 1 at start (offscreen), 0 at end (in place)
  switch (t.direction) {
    case 'left': return { dx: -clip.width * off, dy: 0 };
    case 'right': return { dx: clip.width * off, dy: 0 };
    case 'up': return { dx: 0, dy: -clip.height * off };
    case 'down': return { dx: 0, dy: clip.height * off };
    default: return { dx: 0, dy: 0 };
  }
}
