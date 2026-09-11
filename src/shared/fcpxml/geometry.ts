/**
 * FCPXML geometry bridge (upstream #154).
 *
 * Our clips are top-left canvas boxes with clockwise-positive rotation about a
 * pixel anchor; FCPXML is center-based — `position` is the anchor point
 * relative to the canvas center in percent of canvas height (+x right, +y up),
 * `scale` a multiplier with 1 = native, `rotation` counter-clockwise degrees,
 * `anchor "0 0"` centered. This module converts both ways. Pure, so the
 * exporter, the importer, and the tests read the same rules.
 *
 * Two documented approximations:
 * - The decode is assumed box-sized (it is requested that way), so the
 *   centering term between the decoded frame and the clip box is zero.
 * - Unknown source dimensions fall back to the canvas (a source that fills
 *   the canvas, the common case), noted at both call sites.
 */

export interface FrameSize {
  w: number;
  h: number;
}

/** Aspect-fit of a source frame into the canvas (upstream fitFractions). */
export function aspectFit(
  sourceW: number,
  sourceH: number,
  canvasW: number,
  canvasH: number,
): FrameSize {
  if (!(sourceW > 0 && sourceH > 0 && canvasW > 0 && canvasH > 0)) {
    return { w: canvasW, h: canvasH };
  }
  const fit = Math.min(canvasW / sourceW, canvasH / sourceH);
  return { w: sourceW * fit, h: sourceH * fit };
}

/** FCPXML-native transform values, as written and as parsed. */
export interface FcpxmlTransform {
  /** Anchor point relative to canvas center, percent of canvas height, y-up. */
  positionX: number;
  positionY: number;
  /** Multipliers relative to the aspect-fitted source. */
  scaleX: number;
  scaleY: number;
  /** Counter-clockwise degrees. */
  rotation: number;
}

/** Canonical clip placement: fitted box, unit-or-signed scale, top-left anchor. */
export interface ClipPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Clockwise-positive degrees, matching our rotation. */
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export interface PlacementContext {
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

/**
 * Recover a placement that renders what the FCPXML transform describes.
 *
 * The box carries the magnitude (fitted source times |scale|) and scaleX/Y
 * carry the sign, so flips survive; rotation is negated back to our
 * clockwise-positive convention; x/y solve for the transformed box center
 * landing on the FCPXML position with our top-left anchor. Rendering is exact
 * under the box-sized-decode assumption above; representation is canonical
 * rather than preserved (a grid cell reimports as fitted-box-plus-scale,
 * which draws identically).
 */
export function placementFromTransform(
  transform: FcpxmlTransform,
  ctx: PlacementContext,
): ClipPlacement {
  const { canvasWidth, canvasHeight } = ctx;
  const fitted = aspectFit(ctx.sourceWidth ?? 0, ctx.sourceHeight ?? 0, canvasWidth, canvasHeight);
  const width = Math.max(1, Math.abs(transform.scaleX) * fitted.w);
  const height = Math.max(1, Math.abs(transform.scaleY) * fitted.h);
  const scaleX = transform.scaleX < 0 ? -1 : 1;
  const scaleY = transform.scaleY < 0 ? -1 : 1;
  // Normalize -0: negating a zero rotation must stay zero, not negative zero.
  const rotation = transform.rotation === 0 ? 0 : -transform.rotation;
  const unit = canvasHeight / 100;
  const centerX = canvasWidth / 2 + transform.positionX * unit;
  const centerY = canvasHeight / 2 - transform.positionY * unit;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const halfW = width / 2;
  const halfH = height / 2;
  return {
    x: centerX - (halfW * cos * scaleX - halfH * sin * scaleY),
    y: centerY - (halfW * sin * scaleX + halfH * cos * scaleY),
    width,
    height,
    rotation,
    scaleX,
    scaleY,
  };
}

export interface TrimRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * trim-rect (% of frame height on every edge) back to source fractions.
 * Left/right fractions are of the frame width, so they are aspect-corrected;
 * the result is sanitized to our crop rules (0.45 cap per edge, zeros clear).
 */
export function cropFromTrim(
  trim: TrimRect,
  ctx: PlacementContext,
  sanitize: (input: { left?: number; right?: number; top?: number; bottom?: number }) => TrimRectFull | undefined,
): TrimRectFull | undefined {
  const frameW = ctx.sourceWidth && ctx.sourceWidth > 0 ? ctx.sourceWidth : ctx.canvasWidth;
  const frameH = ctx.sourceHeight && ctx.sourceHeight > 0 ? ctx.sourceHeight : ctx.canvasHeight;
  // Width fractions are of the frame width, but trim units are percent of
  // frame height on every edge, hence the aspect correction.
  const widthToHeight = frameW > 0 && frameH > 0 ? frameH / frameW : 9 / 16;
  return sanitize({
    left: (trim.left / 100) * widthToHeight,
    right: (trim.right / 100) * widthToHeight,
    top: trim.top / 100,
    bottom: trim.bottom / 100,
  });
}

export interface TrimRectFull {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
