/**
 * Curves editor geometry and point edits (upstream #157).
 *
 * The Inspector's tone-curve widget (`components/CurveEditor.tsx`) owns pointer
 * capture and drawing; every rule about what a gesture produces lives here, so
 * the invariants the pipeline depends on -- strictly ascending x, the 0.001
 * interior gap, endpoint x locking, the 16-point cap -- are unit-tested without
 * a DOM. Upstream reference: `CurveEditorView.swift` (a drag grabs the nearest
 * point or drops a new one at the press location, then moves it; endpoints move
 * only in y; interior x clamps just inside its neighbours; double-click removes
 * an interior point while more than two remain).
 */

import {
  COLOR_GRADE_CURVE_LIMITS,
  IDENTITY_CURVE_POINTS,
  isIdentityPoints,
  sanitizeGradeCurve,
  type CurvePoint,
  type GradeCurve,
  type GradeCurveChannel,
} from '../../shared/editor/color-grade';

/** Grab radius around a rendered point, in pixels (upstream's pointHitDiameter / 2). */
export const CURVE_POINT_HIT_RADIUS = 15;

/** Pointer travel before a press counts as a drag (upstream's DragGesture minimumDistance). */
export const CURVE_DRAG_THRESHOLD = 3;

/** Minimum x spacing an interior point keeps from its neighbours (upstream's 0.001). */
export const CURVE_POINT_MIN_GAP = 0.001;

/** Arrow-key nudge, as a fraction of the curve's 0..1 space. */
export const CURVE_NUDGE_STEP = 0.01;

/** The neutral curve a clip with no curves edits against. */
export const EMPTY_GRADE_CURVE: GradeCurve = { master: [], red: [], green: [], blue: [] };

/** A clip's sanitized curves, or the empty curve an ungraded clip edits as. */
export function curveForEditing(input: unknown): GradeCurve {
  return sanitizeGradeCurve(input) ?? EMPTY_GRADE_CURVE;
}

/** The points to draw and hit-test for one channel: the identity pair when it is empty. */
export function curveEditorPoints(points: readonly CurvePoint[]): CurvePoint[] {
  const source = points.length === 0 ? IDENTITY_CURVE_POINTS : points;
  return source.map((point) => ({ ...point }));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Normalized point -> editor pixels. The editor's y grows downward. */
export function curvePointToPixel(
  point: CurvePoint,
  width: number,
  height: number,
): { x: number; y: number } {
  return { x: point.x * width, y: (1 - point.y) * height };
}

/** Editor pixels -> normalized point, clamped to the unit square. */
export function curvePixelToPoint(x: number, y: number, width: number, height: number): CurvePoint {
  return {
    x: clamp01(width === 0 ? 0 : x / width),
    y: clamp01(height === 0 ? 0 : 1 - y / height),
  };
}

/**
 * The nearest point within the grab radius, or null when a press starts a new
 * point. Ties keep the first point, like upstream's scan.
 */
export function findNearestCurvePoint(
  points: readonly CurvePoint[],
  x: number,
  y: number,
  width: number,
  height: number,
  radius = CURVE_POINT_HIT_RADIUS,
): number | null {
  let best: number | null = null;
  let bestDistance = radius;
  for (let index = 0; index < points.length; index += 1) {
    const pixel = curvePointToPixel(points[index], width, height);
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
export function addCurvePoint(
  points: readonly CurvePoint[],
  point: CurvePoint,
): { points: CurvePoint[]; index: number } | null {
  if (points.length >= COLOR_GRADE_CURVE_LIMITS.maxPointsPerChannel) return null;
  const found = points.findIndex((candidate) => candidate.x > point.x);
  const index = found === -1 ? points.length : found;
  const previous = points[index - 1];
  const next = points[index];
  const lowest = previous ? previous.x + CURVE_POINT_MIN_GAP : 0;
  const highest = next ? next.x - CURVE_POINT_MIN_GAP : 1;
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
export function moveCurvePoint(
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
    moved[index].x = highest - lowest <= CURVE_POINT_MIN_GAP * 2
      ? (lowest + highest) / 2
      : Math.min(highest - CURVE_POINT_MIN_GAP, Math.max(lowest + CURVE_POINT_MIN_GAP, point.x));
  }
  return moved;
}

/**
 * Remove an interior point, keeping the two endpoints and never leaving fewer
 * than two points -- upstream's double-click guard. Null means the removal was
 * refused.
 */
export function removeCurvePoint(points: readonly CurvePoint[], index: number): CurvePoint[] | null {
  if (points.length <= 2 || index <= 0 || index >= points.length - 1) return null;
  return points.filter((_, position) => position !== index);
}

/**
 * Replace one channel's points. An identity channel is canonicalized back to
 * empty, which is what the shared sanitizer and the agent patch semantics do
 * with it, so a reset drag commits the same shape as "clear this channel".
 */
export function withCurveChannel(
  curve: GradeCurve,
  channel: GradeCurveChannel,
  points: readonly CurvePoint[],
): GradeCurve {
  return {
    ...curve,
    [channel]: isIdentityPoints(points) ? [] : points.map((point) => ({ ...point })),
  };
}
