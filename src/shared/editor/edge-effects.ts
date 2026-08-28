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

/** Build a FFmpeg geq alpha expression for the rounded and softened edge mask. */
export function buildEdgeGeqExpr(
  edgeRounding: number,
  edgeSoftness: number,
  canvasWidth: number,
  canvasHeight: number,
): string {
  const extent = Math.min(
    Number.isFinite(canvasWidth) && canvasWidth > 0 ? canvasWidth : 1,
    Number.isFinite(canvasHeight) && canvasHeight > 0 ? canvasHeight : 1,
  );
  const radius = clampEdgeValue(edgeRounding) * extent * 0.5;
  const softness = clampEdgeValue(edgeSoftness) * extent * 0.5;
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
