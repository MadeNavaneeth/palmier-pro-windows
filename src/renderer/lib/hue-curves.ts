/**
 * Hue-curves editor geometry and point edits (upstream #157).
 *
 * The Inspector's hue-curves widget (`components/HueCurveEditor.tsx`) owns
 * pointer capture and drawing; every rule about what a gesture produces lives
 * here, so the invariants the pipeline depends on -- strictly ascending x,
 * the 0.001 interior gap, endpoint x locking, the 16-point cap, neutral
 * canonicalization -- are unit-tested without a DOM. Upstream reference:
 * `HueCurveEditorView.swift` (segmented Hue/Sat/Luma picker, six-anchor
 * display fallback for an empty channel, the same grab-or-add/drag/double-
 * click model as the tone editor, neutral-emits-empty).
 *
 * The model is cyclic -- the eval wraps across the 0/1 seam -- but point
 * storage is an ordinary ascending list exactly like the tone curves, so
 * insertion, movement, and removal follow the same rules; only rendering
 * (via the pipeline's cyclic `evalHueCurve`) and the neutral fallback differ.
 */

import {
  COLOR_GRADE_HUE_CURVE_LIMITS,
  DEFAULT_HUE_CURVE_POINTS,
  evalHueCurve,
  isNeutralHuePoints,
  sanitizeHueCurves,
  type CurvePoint,
  type HueCurveChannel,
  type HueCurves,
} from '../../shared/editor/color-grade';

/** Grab radius around a rendered point, in pixels (upstream's pointHitDiameter / 2). */
export const HUE_POINT_HIT_RADIUS = 15;

/** Pointer travel before a press counts as a drag (upstream's DragGesture minimumDistance). */
export const HUE_DRAG_THRESHOLD = 3;

/** Minimum x spacing an interior point keeps from its neighbours (upstream's 0.001). */
export const HUE_POINT_MIN_GAP = 0.001;

/** Arrow-key nudge, as a fraction of the editor's 0..1 space. */
export const HUE_NUDGE_STEP = 0.01;

/** Curve-path samples; upstream strides its stroke at 0.01. */
export const HUE_PATH_STEPS = 100;

/** The neutral curves a clip with no hue edits draws against. */
export const EMPTY_HUE_CURVES: HueCurves = { hueVsHue: [], hueVsSat: [], hueVsLum: [] };

/** A clip's sanitized hue curves, or the empty curves an ungraded clip edits against. */
export function hueCurvesForEditing(input: unknown): HueCurves {
  return sanitizeHueCurves(input) ?? EMPTY_HUE_CURVES;
}

/**
 * The points to draw and hit-test for one channel: the six default anchors
 * when it is empty (what an empty channel evaluates as), otherwise copies.
 */
export function hueEditorPoints(points: readonly CurvePoint[]): CurvePoint[] {
  const source = points.length === 0 ? DEFAULT_HUE_CURVE_POINTS : points;
  return source.map((point) => ({ ...point }));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Normalized point -> editor pixels. The editor's y grows downward. */
export function huePointToPixel(
  point: CurvePoint,
  width: number,
  height: number,
): { x: number; y: number } {
  return { x: point.x * width, y: (1 - point.y) * height };
}

/** Editor pixels -> normalized point, clamped to the unit square. */
export function huePixelToPoint(x: number, y: number, width: number, height: number): CurvePoint {
  return {
    x: clamp01(width === 0 ? 0 : x / width),
    y: clamp01(height === 0 ? 0 : 1 - y / height),
  };
}

/**
 * The nearest point within the grab radius, or null when a press starts a new
 * point. Ties keep the first point, like upstream's scan.
 */
export function findNearestHuePoint(
  points: readonly CurvePoint[],
  x: number,
  y: number,
  width: number,
  height: number,
  radius = HUE_POINT_HIT_RADIUS,
): number | null {
  let best: number | null = null;
  let bestDistance = radius;
  for (let index = 0; index < points.length; index += 1) {
    const pixel = huePointToPixel(points[index], width, height);
    const distance = Math.hypot(pixel.x - x, pixel.y - y);
    if (distance <= radius && (best === null || distance < bestDistance)) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Insert a point at (or just past) its x position, keeping the channel
 * strictly ascending. Returns null when the point cap is reached or the two
 * neighbours it falls between leave no room for the minimum gap, so a refused
 * add never reaches the project.
 */
export function addHuePoint(
  points: readonly CurvePoint[],
  point: CurvePoint,
): { points: CurvePoint[]; index: number } | null {
  if (points.length >= COLOR_GRADE_HUE_CURVE_LIMITS.maxPointsPerChannel) return null;
  const found = points.findIndex((candidate) => candidate.x > point.x);
  const index = found === -1 ? points.length : found;
  const previous = points[index - 1];
  const next = points[index];
  const lowest = previous ? previous.x + HUE_POINT_MIN_GAP : 0;
  const highest = next ? next.x - HUE_POINT_MIN_GAP : 1;
  if (lowest > highest) return null;
  const inserted = points.map((candidate) => ({ ...candidate }));
  inserted.splice(index, 0, {
    x: clamp01(Math.min(highest, Math.max(lowest, point.x))),
    y: clamp01(point.y),
  });
  return { points: inserted, index };
}

/**
 * Move one point: y clamps to [0, 1] for every point; interior points clamp
 * their x 0.001 inside their neighbours, and the two endpoints never move in x
 * (upstream's `moved`). Neighbours closer than two gaps -- only possible in a
 * hand-edited project -- park the point at their midpoint instead of letting
 * the clamp invert the order.
 */
export function moveHuePoint(
  points: readonly CurvePoint[],
  index: number,
  point: CurvePoint,
): CurvePoint[] {
  const moved = points.map((candidate) => ({ ...candidate }));
  if (index < 0 || index >= moved.length) return moved;
  moved[index].y = clamp01(point.y);
  if (index > 0 && index < moved.length - 1) {
    const lowest = moved[index - 1].x;
    const highest = moved[index + 1].x;
    moved[index].x = highest - lowest <= HUE_POINT_MIN_GAP * 2
      ? (lowest + highest) / 2
      : Math.min(highest - HUE_POINT_MIN_GAP, Math.max(lowest + HUE_POINT_MIN_GAP, point.x));
  }
  return moved;
}

/**
 * Remove an interior point, keeping the two endpoints and never leaving fewer
 * than two points -- upstream's double-click guard. Null means the removal was
 * refused.
 */
export function removeHuePoint(points: readonly CurvePoint[], index: number): CurvePoint[] | null {
  if (points.length <= 2 || index <= 0 || index >= points.length - 1) return null;
  return points.filter((_, position) => position !== index);
}

/**
 * Replace one channel's points. A neutral channel is canonicalized back to
 * empty -- within the 1e-4 epsilon the pipeline uses -- which is what the
 * shared sanitizer and the agent patch semantics do with it, so a reset drag
 * commits the same shape as "clear this channel".
 */
export function withHueChannel(
  curves: HueCurves,
  channel: HueCurveChannel,
  points: readonly CurvePoint[],
): HueCurves {
  return {
    ...curves,
    [channel]: isNeutralHuePoints(points) ? [] : points.map((point) => ({ ...point })),
  };
}

/**
 * The drawn curve as an SVG path in 0..100 space, sampled through the
 * pipeline's cyclic eval so the stroke wraps the 0/1 seam exactly the way the
 * grade does: no jump at either edge.
 */
export function hueCurvePath(points: readonly CurvePoint[], steps = HUE_PATH_STEPS): string {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const x = index / steps;
    const y = evalHueCurve(points, x);
    return `${index === 0 ? 'M' : 'L'} ${(x * 100).toFixed(2)} ${((1 - y) * 100).toFixed(2)}`;
  }).join(' ');
}
