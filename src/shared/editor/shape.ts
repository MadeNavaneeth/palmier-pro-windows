/**
 * Shape clip model (tutorial-overlay annotations).
 *
 * Shapes are native vector clips: a `shape` clip kind with a box geometry in
 * the same coordinate convention titles and transforms use (clip
 * x/y/width/height plus rotation/scale/anchor), a kind (rect/ellipse/line/
 * arrow), and a stroke/fill style. Rendering is shared: `drawShapeBox` in
 * renderer/engine/shape-render.ts draws box-local pixels for the live
 * preview, the GPU raster cache, and the export bake alike, so the three
 * paths cannot drift apart.
 *
 * Sanitization lives here so the controller, the Inspector, and the agent
 * executor share one definition: `sanitize*` on write, `narrowShapeClip` on
 * read (invalid values degrade to absent, never throw).
 *
 * Animation presets are compositions of the EXISTING keyframe model only
 * (shared/media/motion.ts: motionX/motionY/motionRot/motionScaleX/
 * motionScaleY). There is no opacity keyframe track — opacity animation rides
 * the static fadeInFrames/fadeOutFrames fields through the same fade filters
 * every other clip uses — so presets only ever emit those five axes. A
 * preset that cannot build two distinct keyframes (e.g. a 1-frame clip)
 * yields no track rather than a degenerate one.
 */

import { sanitizeMotion, type MotionTrack } from '../media/motion';

export const SHAPE_KINDS = ['rect', 'ellipse', 'line', 'arrow'] as const;

export type ShapeKind = (typeof SHAPE_KINDS)[number];

/** Synthetic asset id for shape clips, mirroring titles' `__title__`. */
export const SHAPE_ASSET_ID = '__shape__';

/** Stroke width bounds in px at project resolution. */
export const SHAPE_STROKE_WIDTH_MIN = 0;
export const SHAPE_STROKE_WIDTH_MAX = 64;

export const DEFAULT_SHAPE_STYLE = {
  kind: 'rect' as ShapeKind,
  strokeColor: '#ffffff',
  strokeWidth: 4,
};

/** A kind string is usable when it names one of the four drawn shapes. */
export function sanitizeShapeKind(raw: unknown): ShapeKind | undefined {
  return typeof raw === 'string' && (SHAPE_KINDS as readonly string[]).includes(raw)
    ? (raw as ShapeKind)
    : undefined;
}

/** Stroke color as #RRGGBB, mirroring titleColor. */
export function sanitizeShapeStrokeColor(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : undefined;
}

/** Fill color as #RRGGBBAA, mirroring titleBackgroundColor. Absent = no fill. */
export function sanitizeShapeFillColor(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^#[0-9a-fA-F]{8}$/.test(raw) ? raw : undefined;
}

/** Stroke width in px: finite, clamped to 0..64, rounded. 0 = no stroke. */
export function sanitizeShapeStrokeWidth(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.max(
    SHAPE_STROKE_WIDTH_MIN,
    Math.min(SHAPE_STROKE_WIDTH_MAX, Math.round(raw)),
  );
}

interface ShapeClipLike {
  type?: unknown;
  shapeKind?: unknown;
  shapeStrokeColor?: unknown;
  shapeStrokeWidth?: unknown;
  shapeFillColor?: unknown;
}

/**
 * Narrow a stored clip's shape fields on read: hostile or hand-edited values
 * degrade to absent (the renderers fall back to rect/white/no-fill), and a
 * non-shape clip passes through untouched. Returns the input when clean.
 */
export function narrowShapeClip<T extends ShapeClipLike>(clip: T): T {
  if (clip.type !== 'shape') return clip;
  let next: ShapeClipLike | null = null;
  const drop = (key: 'shapeKind' | 'shapeStrokeColor' | 'shapeStrokeWidth' | 'shapeFillColor'): void => {
    if (!next) next = { ...clip };
    delete next[key];
  };
  if (clip.shapeKind !== undefined && sanitizeShapeKind(clip.shapeKind) === undefined) {
    drop('shapeKind');
  }
  if (
    clip.shapeStrokeColor !== undefined
    && sanitizeShapeStrokeColor(clip.shapeStrokeColor) === undefined
  ) {
    drop('shapeStrokeColor');
  }
  if (
    clip.shapeStrokeWidth !== undefined
    && sanitizeShapeStrokeWidth(clip.shapeStrokeWidth) === undefined
  ) {
    drop('shapeStrokeWidth');
  }
  if (
    clip.shapeFillColor !== undefined
    && sanitizeShapeFillColor(clip.shapeFillColor) === undefined
  ) {
    drop('shapeFillColor');
  }
  return (next ?? clip) as T;
}

interface ShapeContentLike {
  type?: unknown;
  shapeStrokeColor?: unknown;
  shapeStrokeWidth?: unknown;
  shapeFillColor?: unknown;
}

/**
 * True when a shape clip draws anything: a visible stroke (color plus a
 * positive width) or a fill. The preview rasterizer, the export baker, and
 * diagnostics share this so an empty shape renders nothing everywhere and
 * is reported, never drawn as a ghost.
 */
export function hasShapeContent(clip: ShapeContentLike): boolean {
  if (clip.type !== 'shape') return false;
  const width = sanitizeShapeStrokeWidth(clip.shapeStrokeWidth) ?? 0;
  const stroked = sanitizeShapeStrokeColor(clip.shapeStrokeColor) !== undefined && width > 0;
  const filled = sanitizeShapeFillColor(clip.shapeFillColor) !== undefined;
  return stroked || filled;
}

// ─── Animation presets ──────────────────────────────────────────────────────

export const SHAPE_ANIMATION_PRESETS = [
  'draw-on',
  'slide-in-left',
  'slide-in-right',
  'slide-in-up',
  'pop',
  'spin',
  'pulse',
] as const;

export type ShapeAnimationPreset = (typeof SHAPE_ANIMATION_PRESETS)[number];

export interface ShapePresetGeometry {
  startFrame: number;
  durationFrames: number;
  fps: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ShapePresetMotion = Partial<{
  motionX: MotionTrack;
  motionY: MotionTrack;
  motionRot: MotionTrack;
  motionScaleX: MotionTrack;
  motionScaleY: MotionTrack;
}>;

/**
 * Build the motion tracks for one animation preset. Entry-style presets
 * (slides, pop) animate over the first ~half second then hold; full-span
 * presets (spin, pulse, draw-on) run across the whole clip. All values are
 * absolute timeline frames so preview evaluation and the export overlay
 * expressions consume them unchanged.
 */
export function shapePresetMotion(
  preset: ShapeAnimationPreset,
  geometry: ShapePresetGeometry,
): ShapePresetMotion {
  const { startFrame, durationFrames, fps, x, y, width, height } = geometry;
  if (!Number.isFinite(startFrame) || !Number.isFinite(durationFrames) || durationFrames < 1) {
    return {};
  }
  const start = Math.round(startFrame);
  const entrySpan = Math.max(1, Math.min(Math.max(1, Math.round(fps / 2)), durationFrames * 2));
  const end = start + durationFrames;
  const at = (offset: number): number => start + Math.min(Math.max(1, Math.round(offset)), Math.max(1, durationFrames * 2));

  const track = (
    points: Array<{ frame: number; value: number; easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' }>,
  ): MotionTrack | undefined => sanitizeMotion(points);

  switch (preset) {
    case 'slide-in-left': {
      const from = Math.round(x - width - 48);
      const t = track([
        { frame: start, value: from, easing: 'easeOut' },
        { frame: at(entrySpan), value: Math.round(x) },
      ]);
      return t ? { motionX: t } : {};
    }
    case 'slide-in-right': {
      const from = Math.round(x + width + 48);
      const t = track([
        { frame: start, value: from, easing: 'easeOut' },
        { frame: at(entrySpan), value: Math.round(x) },
      ]);
      return t ? { motionX: t } : {};
    }
    case 'slide-in-up': {
      const from = Math.round(y + height + 48);
      const t = track([
        { frame: start, value: from, easing: 'easeOut' },
        { frame: at(entrySpan), value: Math.round(y) },
      ]);
      return t ? { motionY: t } : {};
    }
    case 'pop': {
      const tracks: ShapePresetMotion = {};
      const sx = track([
        { frame: start, value: 0.6, easing: 'easeOut' },
        { frame: at(entrySpan), value: 1 },
      ]);
      const sy = track([
        { frame: start, value: 0.6, easing: 'easeOut' },
        { frame: at(entrySpan), value: 1 },
      ]);
      if (sx) tracks.motionScaleX = sx;
      if (sy) tracks.motionScaleY = sy;
      return tracks;
    }
    case 'spin': {
      const t = track([
        { frame: start, value: 0, easing: 'linear' },
        { frame: end, value: 360 },
      ]);
      return t ? { motionRot: t } : {};
    }
    case 'pulse': {
      const mid = at(durationFrames / 2);
      const tracks: ShapePresetMotion = {};
      const sx = track([
        { frame: start, value: 1, easing: 'easeInOut' },
        { frame: mid, value: 1.15, easing: 'easeInOut' },
        { frame: end, value: 1 },
      ]);
      const sy = track([
        { frame: start, value: 1, easing: 'easeInOut' },
        { frame: mid, value: 1.15, easing: 'easeInOut' },
        { frame: end, value: 1 },
      ]);
      if (sx) tracks.motionScaleX = sx;
      if (sy) tracks.motionScaleY = sy;
      return tracks;
    }
    case 'draw-on': {
      // A reveal along the box's x axis. The epsilon start avoids a
      // zero-width FFmpeg scale, which the filter rejects.
      const t = track([
        { frame: start, value: 0.02, easing: 'linear' },
        { frame: end, value: 1 },
      ]);
      return t ? { motionScaleX: t } : {};
    }
  }
}
