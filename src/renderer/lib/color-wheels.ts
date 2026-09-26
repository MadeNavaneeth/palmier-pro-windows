/**
 * Color-wheels editor geometry and vector edits (upstream #157).
 *
 * The Inspector's wheels widget (`components/ColorWheels.tsx`) owns pointer
 * capture and drawing; every rule about what a gesture produces lives here, so
 * the invariants the pipeline depends on -- pad positions inside the unit
 * disk, per-zone master ranges, exact zone defaults -- are unit-tested without
 * a DOM. Upstream reference: `ColorWheelPad` (drag minimum distance 2, radius
 * clamped to the disk, double-tap resets the pad to (0, 0)) and
 * `ColorWheels.displayColor` (dark body fading to a vivid saturated rim,
 * shared by the wheel face and the puck).
 */

import {
  COLOR_GRADE_WHEEL_LIMITS,
  DEFAULT_GRADE_WHEELS,
  sanitizeGradeWheels,
  wheelsHueRGB,
  type GradeWheels,
  type GradeWheelZone,
} from '../../shared/editor/color-grade';

/** Pointer travel before a press counts as a drag (upstream's DragGesture minimumDistance). */
export const WHEEL_DRAG_THRESHOLD = 2;

/** Arrow-key nudge, in pad units: visible on a ~90px pad, still fine-grained. */
export const WHEEL_NUDGE_STEP = 0.05;

/** Wheel-face bitmap edge in pixels (upstream's `d = 160`). */
export const WHEEL_FACE_SIZE = 160;

/** A clip's sanitized wheels, or fresh defaults for a clip without any. */
export function wheelsForEditing(input: unknown): GradeWheels {
  return sanitizeGradeWheels(input) ?? {
    lift: { ...DEFAULT_GRADE_WHEELS.lift },
    gamma: { ...DEFAULT_GRADE_WHEELS.gamma },
    gain: { ...DEFAULT_GRADE_WHEELS.gain },
  };
}

/** Pad value -> editor pixels. Value +y is up; the puck is not clamped, so an
 * agent-set corner value renders where upstream puts it (past the rim). */
export function wheelValueToPixel(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  if (width <= 0 || height <= 0) return { x: 0, y: 0 };
  const size = Math.min(width, height);
  return { x: width / 2 + (x * size) / 2, y: height / 2 - (y * size) / 2 };
}

/** Editor pixels -> pad value, clamped to the unit disk (upstream's `point`). */
export function wheelPixelToValue(
  px: number,
  py: number,
  width: number,
  height: number,
): { x: number; y: number } {
  if (width <= 0 || height <= 0) return { x: 0, y: 0 };
  const size = Math.min(width, height);
  const vx = (px - width / 2) / (size / 2);
  const vy = (height / 2 - py) / (size / 2);
  return clampWheelVector(vx, vy);
}

/** Clamp a pad vector to the unit disk, preserving its angle. */
export function clampWheelVector(x: number, y: number): { x: number; y: number } {
  const mag = Math.sqrt(x * x + y * y);
  if (mag <= 1) return { x, y };
  return { x: x / mag, y: y / mag };
}

/** Clamp a master offset to its zone range. Range inputs cannot produce an
 * out-of-range value; keyboard nudges at the edge can, so they route here. */
export function clampWheelMaster(value: number, zone: GradeWheelZone): number {
  const limits = COLOR_GRADE_WHEEL_LIMITS[zone].m;
  return Math.min(limits.max, Math.max(limits.min, value));
}

/** Replace one zone's pad vector, clamped to the disk like a pointer drag. */
export function moveWheelPuck(
  wheels: GradeWheels,
  zone: GradeWheelZone,
  x: number,
  y: number,
): GradeWheels {
  const clamped = clampWheelVector(x, y);
  return {
    ...wheels,
    [zone]: { ...wheels[zone], x: clamped.x, y: clamped.y },
  };
}

/** Replace one zone's master offset, clamped to its range. */
export function setWheelMaster(wheels: GradeWheels, zone: GradeWheelZone, m: number): GradeWheels {
  return {
    ...wheels,
    [zone]: { ...wheels[zone], m: clampWheelMaster(m, zone) },
  };
}

/** Reset one zone to its defaults (lift/additive 0, gamma/gain multipliers 1). */
export function resetWheelZone(wheels: GradeWheels, zone: GradeWheelZone): GradeWheels {
  return { ...wheels, [zone]: { ...DEFAULT_GRADE_WHEELS[zone] } };
}

/** True when a zone sits exactly at its defaults, so its Reset stays hidden. */
export function isDefaultWheelZone(wheels: GradeWheels, zone: GradeWheelZone): boolean {
  const def = DEFAULT_GRADE_WHEELS[zone];
  const current = wheels[zone];
  return current.x === def.x && current.y === def.y && current.m === def.m;
}

/**
 * Wheel-face color for a pad position — upstream's `ColorWheels.displayColor`
 * verbatim: a dark, lightly tinted body fading to a vivid saturated rim. The
 * hue comes from the pipeline's own `wheelsHueRGB`, so the face, the puck,
 * and the grade math can never disagree about which angle is which hue.
 */
export function wheelDisplayColor(x: number, y: number): [number, number, number] {
  const r = Math.min(1, Math.sqrt(x * x + y * y));
  const [hr, hg, hb] = wheelsHueRGB(Math.atan2(y, x) / (2 * Math.PI));
  const v = 0.08 + 0.5 * Math.pow(r, 1.7);
  const s = Math.pow(r, 1.4);
  const t = Math.min(1, Math.max(0, (r - 0.86) / 0.14));
  const rim = t * t * (3 - 2 * t);
  const face = (h: number): number => {
    const body = v * ((1 - s) + h * s);
    return body + (h - body) * rim;
  };
  return [face(hr), face(hg), face(hb)];
}

/**
 * One backdrop pixel for face-space coords in [-1.02, 1.02] — upstream's
 * `wheelImage` loop: transparent past r = 1.02, feathered across the rim
 * band, display color inside. Unlike upstream's premultiplied bitmap the
 * channels are NOT premultiplied, which is what canvas `putImageData` takes.
 */
export function wheelFacePixel(vx: number, vy: number): [number, number, number, number] {
  const r = Math.sqrt(vx * vx + vy * vy);
  if (r > 1.02) return [0, 0, 0, 0];
  const [cr, cg, cb] = wheelDisplayColor(vx, vy);
  const a = r <= 1 ? 1 : Math.max(0, 1 - (r - 1) / 0.02);
  return [cr, cg, cb, a];
}
