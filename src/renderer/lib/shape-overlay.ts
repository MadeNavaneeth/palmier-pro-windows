/**
 * Shape-overlay geometry and gesture math.
 *
 * The Preview canvas overlay (`components/preview/ShapeOverlay.tsx`) owns
 * pointer capture and rendering; every rule about where a gesture PUTS the
 * box lives here so it is unit-tested without a DOM:
 *
 * - `clientToProject` is the canvas-display ↔ project-frames mapping. It
 *   converts through the overlay element's own bounding rect — the same
 *   `displayWidth`/`displayHeight` box `PreviewCanvas` sizes the canvas to —
 *   so there is exactly one mapping and the overlay tracks the canvas at any
 *   zoom or panel size.
 * - `effectiveBox` mirrors `preview-engine.applyBoxTransform` (motion tracks
 *   win, static fields are the fallback), so hit tests and handles sit exactly
 *   where the compositor draws the shape at the playhead.
 * - `moveBox` / `resizeBox` / `rotateBox` compute the whole gesture from the
 *   start snapshot plus the total pointer delta, the pattern upstream's
 *   `TransformOverlayView` uses (`dragStart`/`resizeStart` held for the
 *   gesture): incremental accumulation would drift over a long drag.
 *
 * Upstream reference: `Sources/PalmierPro/Preview/TransformOverlayView.swift`
 * at snapshot `b4b1333f9404a2ca8a9509443955cd1c501de480` — move gesture,
 * four corner resize handles, opposite edge pinned, no rotate handle (the
 * rotate handle is a Windows addition; upstream rotates via the Inspector).
 */

import { evaluateMotion, type MotionTrack } from '../../shared/media/motion';

/** Clip fields the overlay reads. Structurally satisfied by `Clip`; narrowed
 * so tests can build literals without a whole project. */
export interface BoxClipSource {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  anchorX: number;
  anchorY: number;
  motionX?: MotionTrack;
  motionY?: MotionTrack;
  motionRot?: MotionTrack;
  motionScaleX?: MotionTrack;
  motionScaleY?: MotionTrack;
}

/** Effective geometry at a frame: exactly what the compositor transforms. */
export interface EffectiveBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  anchorX: number;
  anchorY: number;
}

export interface ProjectPoint {
  x: number;
  y: number;
}

export type CornerId = 'nw' | 'ne' | 'sw' | 'se';

/** What the pointer is over: a chrome handle, or a shape body (topmost wins). */
export type OverlayHit =
  | { kind: 'rotate' }
  | { kind: CornerId }
  | { kind: 'body'; clipId: string };

/** Smallest box a resize may produce, in project px (matches the floor
 * `addShapeClips` clamps created shapes to). */
export const SHAPE_MIN_SIZE = 1;

/** Handle visual side length, screen CSS px — constant on screen at any zoom. */
export const HANDLE_SCREEN_PX = 9;
/** Circular grab radius around a corner handle, screen CSS px (slightly larger
 * than the visual square so the target is forgiving). */
export const HANDLE_HIT_RADIUS_PX = 7;
/** Rotate handle visual diameter, screen CSS px. */
export const ROTATE_SCREEN_PX = 10;
/** Rotate handle grab radius, screen CSS px. */
export const ROTATE_HIT_RADIUS_PX = 8;
/** Rotate handle standoff from the top edge, screen CSS px. */
export const ROTATE_OFFSET_SCREEN_PX = 16;

const DEG = Math.PI / 180;

/**
 * Client (screen) px → project px, via the overlay's own rect. The overlay is
 * positioned exactly over the canvas, so `rect` IS the displayed frame box;
 * never re-derive scale from the window.
 */
export function clientToProject(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  projectWidth: number,
  projectHeight: number,
): ProjectPoint {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: ((clientX - rect.left) * projectWidth) / rect.width,
    y: ((clientY - rect.top) * projectHeight) / rect.height,
  };
}

/** Project px per screen CSS px — scales screen-constant sizes (handles,
 * grab radii) into the viewBox. */
export function projectPerScreen(displayWidth: number, projectWidth: number): number {
  return displayWidth > 0 ? projectWidth / displayWidth : 1;
}

/**
 * Effective box at `frame`, mirroring `preview-engine.applyBoxTransform`:
 * motion tracks win per axis, static fields are the fallback. Hit tests and
 * handles must land where the compositor draws, not where the static fields
 * alone would put the box.
 */
export function effectiveBox(clip: BoxClipSource, frame: number): EffectiveBox {
  return {
    x: evaluateMotion(clip.motionX, frame) ?? clip.x,
    y: evaluateMotion(clip.motionY, frame) ?? clip.y,
    width: clip.width,
    height: clip.height,
    rotation: evaluateMotion(clip.motionRot, frame) ?? clip.rotation,
    scaleX: evaluateMotion(clip.motionScaleX, frame) ?? clip.scaleX,
    scaleY: evaluateMotion(clip.motionScaleY, frame) ?? clip.scaleY,
    anchorX: clip.anchorX,
    anchorY: clip.anchorY,
  };
}

/** The fixed point rotation/scale are about: (x + anchorX, y + anchorY). */
export function boxPivot(box: EffectiveBox): ProjectPoint {
  return { x: box.x + box.anchorX, y: box.y + box.anchorY };
}

/**
 * Box-local → project, in the same order the canvas applies it:
 * `translate(pivot); rotate; scale; translate(-anchor)` — i.e.
 * `world = pivot + R·S·(local − anchor)`.
 */
export function boxToWorld(box: EffectiveBox, localX: number, localY: number): ProjectPoint {
  const rad = box.rotation * DEG;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const vx = (localX - box.anchorX) * box.scaleX;
  const vy = (localY - box.anchorY) * box.scaleY;
  return {
    x: box.x + box.anchorX + vx * cos - vy * sin,
    y: box.y + box.anchorY + vx * sin + vy * cos,
  };
}

/** Inverse of `boxToWorld`. A degenerate (≈0) scale falls back to ±ε so the
 * division stays finite; the resulting point then simply misses every test. */
export function worldToBox(box: EffectiveBox, world: ProjectPoint): ProjectPoint {
  const rad = box.rotation * DEG;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = world.x - (box.x + box.anchorX);
  const dy = world.y - (box.y + box.anchorY);
  const rx = dx * cos + dy * sin;
  const ry = -dx * sin + dy * cos;
  const sx = Math.abs(box.scaleX) < 1e-6 ? (box.scaleX < 0 ? -1e-6 : 1e-6) : box.scaleX;
  const sy = Math.abs(box.scaleY) < 1e-6 ? (box.scaleY < 0 ? -1e-6 : 1e-6) : box.scaleY;
  return { x: rx / sx + box.anchorX, y: ry / sy + box.anchorY };
}

/** The four rendered corners, in project px. */
export function boxCorners(box: EffectiveBox): Record<CornerId, ProjectPoint> {
  return {
    nw: boxToWorld(box, 0, 0),
    ne: boxToWorld(box, box.width, 0),
    sw: boxToWorld(box, 0, box.height),
    se: boxToWorld(box, box.width, box.height),
  };
}

export function pointInBox(box: EffectiveBox, point: ProjectPoint): boolean {
  const local = worldToBox(box, point);
  return local.x >= 0 && local.x <= box.width && local.y >= 0 && local.y <= box.height;
}

/**
 * Rotate handle: the top-edge midpoint pushed outward along the centre→edge
 * ray, so the standoff stays perpendicular to the edge under any rotation and
 * non-uniform scale.
 */
export function rotateHandlePoint(box: EffectiveBox, offsetProject: number): ProjectPoint {
  const mid = boxToWorld(box, box.width / 2, 0);
  const center = boxToWorld(box, box.width / 2, box.height / 2);
  let dx = mid.x - center.x;
  let dy = mid.y - center.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    // Degenerate box: fall back to straight "up" in rotated space, R·(0,−1).
    const rad = box.rotation * DEG;
    dx = Math.sin(rad);
    dy = -Math.cos(rad);
  } else {
    dx /= len;
    dy /= len;
  }
  return { x: mid.x + dx * offsetProject, y: mid.y + dy * offsetProject };
}

/**
 * What the pointer grabs. Chrome handles win over bodies (you must be able to
 * catch a handle even where another shape overlaps); among bodies the caller
 * passes topmost-first, so the first hit is the one under the cursor.
 */
export function hitTestOverlay(
  point: ProjectPoint,
  chrome: {
    box: EffectiveBox;
    cornerRadius: number;
    rotateRadius: number;
    rotateOffset: number;
  } | null,
  bodies: ReadonlyArray<{ clipId: string; box: EffectiveBox }>,
): OverlayHit | null {
  if (chrome) {
    const handle = rotateHandlePoint(chrome.box, chrome.rotateOffset);
    if (Math.hypot(point.x - handle.x, point.y - handle.y) <= chrome.rotateRadius) {
      return { kind: 'rotate' };
    }
    const corners = boxCorners(chrome.box);
    for (const id of ['nw', 'ne', 'sw', 'se'] as const) {
      const corner = corners[id];
      if (Math.hypot(point.x - corner.x, point.y - corner.y) <= chrome.cornerRadius) {
        return { kind: id };
      }
    }
  }
  for (const body of bodies) {
    if (pointInBox(body.box, point)) return { kind: 'body', clipId: body.clipId };
  }
  return null;
}

/**
 * A whole move gesture: start box plus total pointer delta. Translation is
 * pre-rotation, so the delta applies to x/y directly — every rendered point
 * shifts by exactly (dx, dy) regardless of rotation or scale.
 *
 * The delta rounds to whole project px: a press that ends where it began
 * computes a delta of 0 and reproduces the start box exactly, which is what
 * lets `applyClipProperties` see an unchanged draft and add no history entry.
 */
export function moveBox(start: EffectiveBox, dx: number, dy: number): { x: number; y: number } {
  return { x: start.x + Math.round(dx), y: start.y + Math.round(dy) };
}

/**
 * A whole resize gesture: drag `corner` to `pointer`, pinning the opposite
 * corner in project space (upstream's "stop the dragged edge at the opposite
 * edge" contract, but solved in the rotated/scaled frame so the box under the
 * pointer is the box that renders).
 *
 * `w' = σ·S⁻¹R⁻¹(pointer − opposite)` gives the new extent along each local
 * axis; the pivot is then re-derived from the pinned opposite corner so x/y
 * follow. Values within half a px of the start snap back to the start (a
 * released press that never really moved adds no history); otherwise the
 * result rounds to whole px and never drops below `SHAPE_MIN_SIZE`.
 */
export function resizeBox(
  start: EffectiveBox,
  corner: CornerId,
  pointer: ProjectPoint,
): { x: number; y: number; width: number; height: number } {
  const signX = corner === 'ne' || corner === 'se' ? 1 : -1;
  const signY = corner === 'se' || corner === 'sw' ? 1 : -1;
  const corners = boxCorners(start);
  const opposite =
    corner === 'nw' ? corners.se
      : corner === 'se' ? corners.nw
        : corner === 'ne' ? corners.sw
          : corners.ne;

  const rad = start.rotation * DEG;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = pointer.x - opposite.x;
  const dy = pointer.y - opposite.y;
  const rx = dx * cos + dy * sin;
  const ry = -dx * sin + dy * cos;
  const sx = Math.abs(start.scaleX) < 1e-6 ? (start.scaleX < 0 ? -1e-6 : 1e-6) : start.scaleX;
  const sy = Math.abs(start.scaleY) < 1e-6 ? (start.scaleY < 0 ? -1e-6 : 1e-6) : start.scaleY;

  const rawWidth = signX * (rx / sx);
  const rawHeight = signY * (ry / sy);
  const snap = (raw: number, from: number): number =>
    Math.abs(raw - from) < 0.5 ? from : Math.round(raw);
  const width = Math.max(SHAPE_MIN_SIZE, snap(rawWidth, start.width));
  const height = Math.max(SHAPE_MIN_SIZE, snap(rawHeight, start.height));

  // Re-derive the pivot from the pinned opposite corner at the NEW size.
  const oppositeLocalX = signX === 1 ? 0 : width;
  const oppositeLocalY = signY === 1 ? 0 : height;
  const vx = (oppositeLocalX - start.anchorX) * start.scaleX;
  const vy = (oppositeLocalY - start.anchorY) * start.scaleY;
  const pivotX = opposite.x - (vx * cos - vy * sin);
  const pivotY = opposite.y - (vx * sin + vy * cos);

  const rawX = pivotX - start.anchorX;
  const rawY = pivotY - start.anchorY;
  return { x: snap(rawX, start.x), y: snap(rawY, start.y), width, height };
}

/**
 * A whole rotate gesture: the angle swept around the pivot, in degrees,
 * normalized to (−180, 180] so a pointer crossing the ±π seam counts as a
 * small step rather than a full lap. A sweep under 0.05° returns the start
 * rotation unchanged (a released press that never really moved adds no
 * history); otherwise the delta rounds to 0.1°.
 */
export function rotateBox(
  start: EffectiveBox,
  startPointer: ProjectPoint,
  pointer: ProjectPoint,
): number {
  const pivot = boxPivot(start);
  const startAngle = Math.atan2(startPointer.y - pivot.y, startPointer.x - pivot.x);
  const angle = Math.atan2(pointer.y - pivot.y, pointer.x - pivot.x);
  let delta = (angle - startAngle) / DEG;
  delta = (((delta + 180) % 360) + 360) % 360 - 180;
  if (Math.abs(delta) < 0.05) return start.rotation;
  return start.rotation + Math.round(delta * 10) / 10;
}
