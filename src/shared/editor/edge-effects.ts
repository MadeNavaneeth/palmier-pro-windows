import type { Clip } from '../types/project';

/** Clamp an edge effect value to its persisted 0–1 domain. */
export function clampEdgeValue(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 0;
  return Math.min(1, Math.max(0, value ?? 0));
}

/** Return whether a clip has an active edge mask. */
export function hasEdgeEffects(clip: Clip): boolean {
  return clampEdgeValue(clip.edgeRounding) > 0 || clampEdgeValue(clip.edgeSoftness) > 0;
}

/**
 * Resolve the pixel geometry used by both the export expression and the
 * main-process preview mask. Keeping this in one place is important: the
 * normalized controls are interpreted against the shorter frame edge, not
 * independently by each renderer.
 */
function edgeMaskGeometry(
  edgeRounding: number,
  edgeSoftness: number,
  canvasWidth: number,
  canvasHeight: number,
): { radius: number; softness: number } {
  const extent = Math.min(
    Number.isFinite(canvasWidth) && canvasWidth > 0 ? canvasWidth : 1,
    Number.isFinite(canvasHeight) && canvasHeight > 0 ? canvasHeight : 1,
  );
  return {
    radius: clampEdgeValue(edgeRounding) * extent * 0.5,
    softness: clampEdgeValue(edgeSoftness) * extent * 0.5,
  };
}

/** The rounded-rectangle signed distance used by the export `geq` expression. */
function roundedRectDistance(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): number {
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const qx = Math.abs(x - centerX) - (centerX - radius);
  const qy = Math.abs(y - centerY) - (centerY - radius);
  return Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2)
    + Math.min(Math.max(qx, qy), 0)
    - radius;
}

/** Alpha coverage for one pixel, matching the FFmpeg `geq` edge expression. */
function edgeCoverage(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  softness: number,
): number {
  const distance = roundedRectDistance(x, y, width, height, radius);
  if (softness <= 0) return distance <= 0 ? 1 : 0;
  return Math.min(1, Math.max(0, -distance / softness));
}

/** Build a FFmpeg geq alpha expression for the rounded and softened edge mask. */
export function buildEdgeGeqExpr(
  edgeRounding: number,
  edgeSoftness: number,
  canvasWidth: number,
  canvasHeight: number,
): string {
  const { radius, softness } = edgeMaskGeometry(edgeRounding, edgeSoftness, canvasWidth, canvasHeight);
  if (radius <= 0 && softness <= 0) return 'alpha(X,Y)';

  const formatNumber = (value: number): string => value.toPrecision(15);
  const radiusText = formatNumber(radius);
  const softnessText = formatNumber(softness);
  const qx = `abs(X-(W-1)/2)-((W-1)/2-${radiusText})`;
  const qy = `abs(Y-(H-1)/2)-((H-1)/2-${radiusText})`;
  const distance =
    `sqrt(pow(max(${qx},0),2)+pow(max(${qy},0),2))+min(max(${qx},${qy}),0)-${radiusText}`;
  const coverage = softness > 0
    ? `clip(-(${distance})/${softnessText},0,1)`
    : `if(lte(${distance},0),1,0)`;

  return `alpha(X,Y)*${coverage}`;
}

/**
 * Apply the rounded/soft edge mask to decoded RGBA in place.
 *
 * This is the Node-side counterpart to `buildEdgeGeqExpr`: it uses the same
 * rounded-rectangle signed distance and the same alpha multiplication, so
 * the live main-process preview follows the export filter. The softness term
 * is the radial/edge falloff between the rounded boundary and its interior;
 * source RGB and alpha outside the mask are never recomputed.
 *
 * The caller is expected to guard this with `hasEdgeEffects(clip)`. The
 * geometry guard here is still useful for direct callers and keeps the
 * identity case free of writes.
 */
export function applyEdgeEffectsToRgba(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  edgeRounding: number | undefined,
  edgeSoftness: number | undefined,
): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return;
  const { radius, softness } = edgeMaskGeometry(
    edgeRounding ?? 0,
    edgeSoftness ?? 0,
    width,
    height,
  );
  if (radius <= 0 && softness <= 0) return;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const alpha = data[index + 3];
      if (alpha === 0) continue;
      const coverage = edgeCoverage(x, y, width, height, radius, softness);
      if (coverage === 1) continue;
      data[index + 3] = Math.round(alpha * coverage);
    }
  }
}
