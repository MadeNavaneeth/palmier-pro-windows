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

import { evaluateMotion, type MotionEasing, type MotionPoint, type MotionTrack } from '../media/motion';

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

/** One FCPXML keyframe of a value pair (position or scale), absolute timeline frame. */
export interface FcpxmlKeyframePair {
  frame: number;
  /** Position: percent-of-height units. Scale: FCPXML multipliers. */
  a: number;
  b: number;
  easing: MotionEasing;
}

/** One FCPXML keyframe of a scalar param (rotation), absolute timeline frame. */
export interface FcpxmlKeyframeScalar {
  frame: number;
  /** Counter-clockwise degrees. */
  value: number;
  easing: MotionEasing;
}

/** FCPXML-native transform keyframes as parsed (see exporter.transformElement). */
export interface FcpxmlTransformKeyframes {
  position?: FcpxmlKeyframePair[];
  scale?: FcpxmlKeyframePair[];
  rotation?: FcpxmlKeyframeScalar[];
}

/** Our motion-track fields, ready for a clip draft. */
export interface MotionFields {
  motionX?: MotionTrack;
  motionY?: MotionTrack;
  motionScaleX?: MotionTrack;
  motionScaleY?: MotionTrack;
  motionRot?: MotionTrack;
}

function motionPoint(frame: number, value: number, easing: MotionEasing): MotionPoint {
  // Normalize -0: negating a zero rotation/keyframe must stay zero.
  return { frame, value: value === 0 ? 0 : value, ...(easing === 'linear' ? {} : { easing }) };
}

/**
 * FCPXML transform keyframes → our motion fields, the inverse of
 * exporter.transformElement at every keyframe:
 * - position: center-based FCPXML units back to our top-left box position.
 *   The rotation used is the imported rotation track evaluated at the
 *   position keyframe's frame (the exporter does the same), falling back to
 *   the static base rotation.
 * - scale: FCPXML multipliers are relative to the aspect-fitted source, while
 *   motionScaleX/Y replace our static scaleX/Y on the imported fitted box —
 *   so the value is rescaled by the box width/height placementFromTransform
 *   chose (drawn width = box × motion scale = FCPXML scale × fitted source).
 * - rotation: counter-clockwise degrees back to our clockwise convention.
 * Linear easing is left implicit, matching sanitizeMotion.
 */
export function motionFromTransformKeyframes(
  keyframes: FcpxmlTransformKeyframes,
  base: FcpxmlTransform,
  ctx: PlacementContext,
): MotionFields {
  const placement = placementFromTransform(base, ctx);
  const fitted = aspectFit(ctx.sourceWidth ?? 0, ctx.sourceHeight ?? 0, ctx.canvasWidth, ctx.canvasHeight);
  const motion: MotionFields = {};

  const rotationTrack = keyframes.rotation?.map((k) => motionPoint(k.frame, -k.value, k.easing));
  if (rotationTrack && rotationTrack.length > 0) motion.motionRot = rotationTrack;

  if (keyframes.position && keyframes.position.length > 0) {
    const halfW = placement.width / 2;
    const halfH = placement.height / 2;
    const unit = ctx.canvasHeight / 100;
    motion.motionX = [];
    motion.motionY = [];
    for (const keyframe of keyframes.position) {
      const rotation = evaluateMotion(rotationTrack, keyframe.frame) ?? placement.rotation;
      const rad = (rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const centerX = ctx.canvasWidth / 2 + keyframe.a * unit;
      const centerY = ctx.canvasHeight / 2 - keyframe.b * unit;
      motion.motionX.push(motionPoint(keyframe.frame, centerX - (halfW * cos - halfH * sin), keyframe.easing));
      motion.motionY.push(motionPoint(keyframe.frame, centerY - (halfW * sin + halfH * cos), keyframe.easing));
    }
  }

  if (keyframes.scale && keyframes.scale.length > 0 && placement.width > 0 && placement.height > 0) {
    motion.motionScaleX = keyframes.scale.map((k) =>
      motionPoint(k.frame, (k.a * fitted.w) / placement.width, k.easing));
    motion.motionScaleY = keyframes.scale.map((k) =>
      motionPoint(k.frame, (k.b * fitted.h) / placement.height, k.easing));
  }

  return motion;
}
