/**
 * Color grading helpers (roadmap R4).
 *
 * Brightness, contrast, saturation, hue rotation and exposure are stored per
 * clip and applied identically by the canvas preview (ctx.filter) and the
 * FFmpeg export chain (eq filter). These helpers produce the values for each
 * consumer from the same clip fields so they can never disagree.
 *
 * The live preview paints raw composited pixels (putImageData ignores
 * ctx.filter, and the canvas-filter path is dead code), so preview grades
 * ride a per-pixel pass below using the same YUV math, not CSS filters.
 */

import type { Clip } from '../types/project';
import { lutPixel, sanitizeLutRef, toFfmpegLutFilter, type CubeLut, type LutRef } from './lut';
import { sanitizeClipEffects } from './effects';

export type { CubeLut, LutRef };

export interface ColorGrade {
  brightness: number;
  contrast: number;
  saturation: number;
  hueRotation: number;
  exposure: number;
  temperature: number;
  tint: number;
  vibrance: number;
  highlights: number;
  shadows: number;
  blacks: number;
  whites: number;
  invertColors?: boolean;
  curves?: GradeCurve;
  wheels?: GradeWheels;
  hueCurves?: HueCurves;
  /**
   * .cube LUT reference (upstream #157 LUTs): the file applied after the hue
   * curves, blended by `intensity`. Absent = no LUT stage. The file itself
   * is resolved on use (preview loader, export preflight); a missing file
   * skips the stage rather than failing.
   */
  lut?: LutRef;
}

const DEFAULTS: ColorGrade = { brightness: 0, contrast: 1, saturation: 1, hueRotation: 0, exposure: 0, temperature: 6500, tint: 0, vibrance: 0, highlights: 0, shadows: 0, blacks: 0, whites: 0, invertColors: false };

/** Neutral values, exported so UI and agent both reset to the same place. */
export const DEFAULT_COLOR_GRADE: ColorGrade = { ...DEFAULTS };

/**
 * Accepted ranges for the five graded fields (upstream #157's effect stack,
 * exposed to the Inspector). CSS/FFmpeg accept wider values, but past these
 * the picture is destroyed rather than graded — contrast and saturation are
 * multipliers, brightness is an offset added to the normalized signal, and
 * exposure is EV stops of multiplicative gain.
 */
export const COLOR_GRADE_LIMITS = {
  brightness: { min: -1, max: 1 },
  contrast: { min: 0, max: 3 },
  saturation: { min: 0, max: 3 },
  hueRotation: { min: -180, max: 180 },
  exposure: { min: -5, max: 5 },
  temperature: { min: 2000, max: 11000 },
  tint: { min: -100, max: 100 },
  vibrance: { min: -1, max: 1 },
  highlights: { min: -1, max: 1 },
  shadows: { min: -1, max: 1 },
  blacks: { min: -1, max: 1 },
  whites: { min: -1, max: 1 },
} as const;

export type ColorGradeField = keyof typeof COLOR_GRADE_LIMITS;

function inRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value >= min && value <= max ? value : undefined;
}

/**
 * Narrow a partial grade to finite, in-range values.
 *
 * A field that is absent, non-finite, or outside its range is dropped rather
 * than clamped: the caller may be clearing a field, and silently substituting
 * a boundary value would turn "remove this" into "set it to the maximum".
 * Consumers that want clamping express it with a range input, which cannot
 * produce an out-of-range value in the first place.
 */
export function sanitizeColorGrade(input: Partial<ColorGrade> | undefined): Partial<ColorGrade> {
  if (!input) return {};
  const out: Partial<ColorGrade> = {};
  for (const field of Object.keys(COLOR_GRADE_LIMITS) as ColorGradeField[]) {
    if (input[field] === undefined) continue;
    const value = inRange(input[field], COLOR_GRADE_LIMITS[field].min, COLOR_GRADE_LIMITS[field].max);
    if (value !== undefined) out[field] = value;
  }
  if (typeof input.invertColors === 'boolean') out.invertColors = input.invertColors;
  if (input.curves !== undefined) {
    const curves = sanitizeGradeCurve(input.curves);
    if (curves) out.curves = curves;
  }
  if (input.wheels !== undefined) {
    const wheels = sanitizeGradeWheels(input.wheels);
    if (wheels) out.wheels = wheels;
  }
  if (input.hueCurves !== undefined) {
    const hueCurves = sanitizeHueCurves(input.hueCurves);
    if (hueCurves) out.hueCurves = hueCurves;
  }
  if (input.lut !== undefined) {
    const lut = sanitizeLutRef(input.lut);
    if (lut) out.lut = lut;
  }
  return out;
}

// ─── Tone curves (upstream #157 Curves) ──────────────────────────────────────

/**
 * One control point on a tone curve, in normalized [0, 1] input/output space.
 */
export interface CurvePoint {
  x: number;
  y: number;
}

/**
 * Master (Rec.709 luma) plus per-channel R/G/B tone curves, mirroring
 * upstream's `GradeCurve`. Points are ordered by strictly ascending x; an
 * empty channel — or exactly [(0, 0), (1, 1)] — is identity.
 */
export interface GradeCurve {
  master: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

export type GradeCurveChannel = keyof GradeCurve;

export const GRADE_CURVE_CHANNELS: readonly GradeCurveChannel[] = ['master', 'red', 'green', 'blue'];

/** The neutral curve an empty channel evaluates as. */
export const IDENTITY_CURVE_POINTS: readonly CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

/** Width of the per-curve LUTs, matching upstream's `GradeCurveKernel.lutWidth`. */
export const GRADE_CURVE_LUT_WIDTH = 256;

/**
 * Curve validation bounds, exported for the future Inspector curve widget.
 *
 * Upstream has no explicit cap — its editor only keeps a 0.001 x-gap between
 * interior points — but every Windows curve becomes a nested FFmpeg
 * expression, so the port bounds the point count to keep a multi-clip export
 * inside the ~32K Windows command line. The agent boundary refuses a longer
 * channel; `sanitizeGradeCurve` drops the excess points.
 */
export const COLOR_GRADE_CURVE_LIMITS = {
  maxPointsPerChannel: 16,
} as const;

/** True when the points are the identity mapping (empty or the identity pair). */
export function isIdentityPoints(points: readonly CurvePoint[]): boolean {
  return points.length === 0
    || (points.length === 2
      && points[0].x === 0 && points[0].y === 0
      && points[1].x === 1 && points[1].y === 1);
}

/** True when every channel is identity, so the curve is a no-op. */
export function isIdentityGradeCurve(curve: GradeCurve): boolean {
  return GRADE_CURVE_CHANNELS.every((channel) => isIdentityPoints(curve[channel]));
}

/**
 * Narrow one curve channel: keep finite points inside [0, 1] whose x is
 * strictly greater than the previous kept point's, cap the count, and
 * canonicalize an identity channel to empty.
 *
 * Out-of-order points are dropped rather than re-sorted: a hand-edited file
 * must not silently re-shape a look, and the writer that produced it is the
 * one that got the ordering wrong.
 */
function sanitizeCurvePoints(input: unknown): CurvePoint[] {
  if (!Array.isArray(input)) return [];
  const points: CurvePoint[] = [];
  let previousX = Number.NEGATIVE_INFINITY;
  for (const raw of input) {
    if (points.length >= COLOR_GRADE_CURVE_LIMITS.maxPointsPerChannel) break;
    if (typeof raw !== 'object' || raw === null) continue;
    const candidate = raw as { x?: unknown; y?: unknown };
    const x = inRange(candidate.x, 0, 1);
    const y = inRange(candidate.y, 0, 1);
    if (x === undefined || y === undefined || x <= previousX) continue;
    points.push({ x, y });
    previousX = x;
  }
  return isIdentityPoints(points) ? [] : points;
}

/**
 * Narrow an untrusted curve object, dropping invalid channels and points.
 * Returns undefined when the whole curve is identity (nothing to apply).
 */
export function sanitizeGradeCurve(input: unknown): GradeCurve | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const candidate = input as Record<string, unknown>;
  const curve: GradeCurve = {
    master: sanitizeCurvePoints(candidate.master),
    red: sanitizeCurvePoints(candidate.red),
    green: sanitizeCurvePoints(candidate.green),
    blue: sanitizeCurvePoints(candidate.blue),
  };
  return isIdentityGradeCurve(curve) ? undefined : curve;
}

/** A per-channel curves patch: a provided channel replaces, an empty array clears. */
export type GradeCurvePatch = Partial<Record<GradeCurveChannel, CurvePoint[]>>;

/**
 * Strict parse of the agent's `curves` argument.
 *
 * Unlike `sanitizeGradeCurve`, which drops invalid points from an untrusted
 * project file, this refuses the whole call on the first malformed point so
 * the agent is told what was wrong instead of silently rendering a different
 * curve. A channel sent empty or identity is a request to clear it.
 */
export function parseGradeCurvePatch(
  input: unknown,
): { ok: true; patch: GradeCurvePatch } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'curves must be an object with master/red/green/blue point arrays.' };
  }
  const candidate = input as Record<string, unknown>;
  const patch: GradeCurvePatch = {};
  for (const channel of GRADE_CURVE_CHANNELS) {
    const raw = candidate[channel];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      return { ok: false, error: `curves.${channel} must be an array of {x, y} points.` };
    }
    if (raw.length > COLOR_GRADE_CURVE_LIMITS.maxPointsPerChannel) {
      return {
        ok: false,
        error: `curves.${channel} accepts at most ${COLOR_GRADE_CURVE_LIMITS.maxPointsPerChannel} points.`,
      };
    }
    const points: CurvePoint[] = [];
    let previousX = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < raw.length; index += 1) {
      const item = raw[index];
      if (typeof item !== 'object' || item === null) {
        return { ok: false, error: `curves.${channel}[${index}] must be an {x, y} point.` };
      }
      const point = item as { x?: unknown; y?: unknown };
      const x = inRange(point.x, 0, 1);
      const y = inRange(point.y, 0, 1);
      if (x === undefined) {
        return { ok: false, error: `curves.${channel}[${index}].x must be between 0 and 1.` };
      }
      if (y === undefined) {
        return { ok: false, error: `curves.${channel}[${index}].y must be between 0 and 1.` };
      }
      if (x <= previousX) {
        return { ok: false, error: `curves.${channel} points must have strictly ascending x.` };
      }
      points.push({ x, y });
      previousX = x;
    }
    patch[channel] = isIdentityPoints(points) ? [] : points;
  }
  return { ok: true, patch };
}

/** Structural equality on sanitized curves (undefined = identity). */
export function gradeCurvesEqual(a: GradeCurve | undefined, b: GradeCurve | undefined): boolean {
  const ca = sanitizeGradeCurve(a);
  const cb = sanitizeGradeCurve(b);
  if (ca === undefined || cb === undefined) return ca === cb;
  return GRADE_CURVE_CHANNELS.every((channel) => {
    const pa = ca[channel];
    const pb = cb[channel];
    return pa.length === pb.length
      && pa.every((point, index) => point.x === pb[index].x && point.y === pb[index].y);
  });
}

// ─── Color wheels (upstream #157 Wheels) ─────────────────────────────────────

/**
 * One wheel zone: the pad position (x, y) in the unit disk plus the master
 * luma scalar (m). Lift steers the shadows, gamma the midtones, gain the
 * highlights — upstream's `color.wheels` effect stores exactly these nine
 * numbers (`lift_x/y/m`, `gamma_x/y/m`, `gain_x/y/m`).
 */
export interface ColorWheelZone {
  x: number;
  y: number;
  m: number;
}

/**
 * Lift/gamma/gain primary wheels, mirroring upstream's `ColorWheels` model.
 * An absent field — or every zone at its default — is identity (no wheel
 * effect, no render pass, no export filter).
 */
export interface GradeWheels {
  lift: ColorWheelZone;
  gamma: ColorWheelZone;
  gain: ColorWheelZone;
}

export type GradeWheelZone = keyof GradeWheels;

export const GRADE_WHEEL_ZONES: readonly GradeWheelZone[] = ['lift', 'gamma', 'gain'];

/** The neutral wheels every zone resets to (upstream's effect defaults). */
export const DEFAULT_GRADE_WHEELS: GradeWheels = {
  lift: { x: 0, y: 0, m: 0 },
  gamma: { x: 0, y: 0, m: 1 },
  gain: { x: 0, y: 0, m: 1 },
};

/**
 * Wheel validation bounds, exported for the future Inspector wheel-pad widget.
 *
 * These are upstream's `EffectRegistry` ranges verbatim: the pad axes span the
 * unit disk (-1..1 per axis, the pad clamps the radius), the lift master is a
 * ±0.5 offset, gamma a 0.5..2 multiplier, gain a 0.5..1.5 multiplier. The
 * agent boundary refuses out-of-range values; `sanitizeGradeWheels` falls back
 * to the zone default instead.
 */
export const COLOR_GRADE_WHEEL_LIMITS = {
  lift: { x: { min: -1, max: 1 }, y: { min: -1, max: 1 }, m: { min: -0.5, max: 0.5 } },
  gamma: { x: { min: -1, max: 1 }, y: { min: -1, max: 1 }, m: { min: 0.5, max: 2 } },
  gain: { x: { min: -1, max: 1 }, y: { min: -1, max: 1 }, m: { min: 0.5, max: 1.5 } },
} as const;

/** True when every zone sits at its default, so the wheels are a no-op. */
export function isIdentityGradeWheels(wheels: GradeWheels): boolean {
  return wheels.lift.x === 0 && wheels.lift.y === 0 && wheels.lift.m === 0
    && wheels.gamma.x === 0 && wheels.gamma.y === 0 && wheels.gamma.m === 1
    && wheels.gain.x === 0 && wheels.gain.y === 0 && wheels.gain.m === 1;
}

/**
 * Narrow an untrusted wheels object, falling back to the zone default per
 * invalid component. Returns undefined when the whole wheels is identity
 * (nothing to apply).
 *
 * Like `sanitizeColorGrade`, invalid input is dropped rather than clamped: a
 * hand-edited file must not silently re-shape a look. A non-object zone falls
 * back to its full default; unknown zones are ignored.
 */
export function sanitizeGradeWheels(input: unknown): GradeWheels | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const candidate = input as Record<string, unknown>;
  const zone = (key: GradeWheelZone): ColorWheelZone => {
    const def = DEFAULT_GRADE_WHEELS[key];
    const limits = COLOR_GRADE_WHEEL_LIMITS[key];
    const raw = candidate[key];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...def };
    const c = raw as { x?: unknown; y?: unknown; m?: unknown };
    return {
      x: inRange(c.x, limits.x.min, limits.x.max) ?? def.x,
      y: inRange(c.y, limits.y.min, limits.y.max) ?? def.y,
      m: inRange(c.m, limits.m.min, limits.m.max) ?? def.m,
    };
  };
  const wheels: GradeWheels = { lift: zone('lift'), gamma: zone('gamma'), gain: zone('gain') };
  return isIdentityGradeWheels(wheels) ? undefined : wheels;
}

/** A per-zone wheels patch: a provided zone merges per component, an omitted one stays. */
export type GradeWheelsPatch = Partial<Record<GradeWheelZone, Partial<ColorWheelZone>>>;

/**
 * Strict parse of the agent's `wheels` argument.
 *
 * Unlike `sanitizeGradeWheels`, which falls back to defaults from an untrusted
 * project file, this refuses the whole call on the first malformed component
 * so the agent is told what was wrong instead of silently rendering different
 * wheels. A zone sent with no usable fields is refused, not ignored; an empty
 * `wheels` object yields an empty patch (the tool schema refuses it as "pass
 * at least one grade field"). Identity values are meaningful — they steer the
 * zone back to default — and a wholly-identity result clears the field.
 */
export function parseGradeWheelsPatch(
  input: unknown,
): { ok: true; patch: GradeWheelsPatch } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'wheels must be an object with lift/gamma/gain zones.' };
  }
  const candidate = input as Record<string, unknown>;
  const patch: GradeWheelsPatch = {};
  for (const zoneName of GRADE_WHEEL_ZONES) {
    const raw = candidate[zoneName];
    if (raw === undefined) continue;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: `wheels.${zoneName} must be an {x, y, m} object.` };
    }
    const zone = raw as { x?: unknown; y?: unknown; m?: unknown };
    const limits = COLOR_GRADE_WHEEL_LIMITS[zoneName];
    const out: Partial<ColorWheelZone> = {};
    if (zone.x !== undefined) {
      const x = inRange(zone.x, limits.x.min, limits.x.max);
      if (x === undefined) return { ok: false, error: `wheels.${zoneName}.x must be between -1 and 1.` };
      out.x = x;
    }
    if (zone.y !== undefined) {
      const y = inRange(zone.y, limits.y.min, limits.y.max);
      if (y === undefined) return { ok: false, error: `wheels.${zoneName}.y must be between -1 and 1.` };
      out.y = y;
    }
    if (zone.m !== undefined) {
      const m = inRange(zone.m, limits.m.min, limits.m.max);
      if (m === undefined) {
        return { ok: false, error: `wheels.${zoneName}.m must be between ${limits.m.min} and ${limits.m.max}.` };
      }
      out.m = m;
    }
    if (Object.keys(out).length === 0) {
      return { ok: false, error: `wheels.${zoneName} must include at least one of x, y, m.` };
    }
    patch[zoneName] = out;
  }
  return { ok: true, patch };
}

/** Structural equality on sanitized wheels (undefined = identity). */
export function gradeWheelsEqual(a: GradeWheels | undefined, b: GradeWheels | undefined): boolean {
  const wa = sanitizeGradeWheels(a);
  const wb = sanitizeGradeWheels(b);
  if (wa === undefined || wb === undefined) return wa === wb;
  return GRADE_WHEEL_ZONES.every((zoneName) =>
    wa[zoneName].x === wb[zoneName].x
    && wa[zoneName].y === wb[zoneName].y
    && wa[zoneName].m === wb[zoneName].m,
  );
}

// ─── Hue curves (upstream #157 Hue Curves) ───────────────────────────────────

/**
 * Resolve-style hue curves: each maps source hue (0..1, cyclic) to one
 * adjustment — hueVsHue rotates the hue, hueVsSat scales the saturation,
 * hueVsLum shifts the luminance — mirroring upstream's `HueCurves` model.
 * Points reuse the tone-curve `{x, y}` shape in [0, 1]; y centers on
 * `HUE_CURVE_NEUTRAL_Y` (no adjustment). An absent field — or every channel
 * neutral — is identity (no render pass, no export filter).
 */
export interface HueCurves {
  hueVsHue: CurvePoint[];
  hueVsSat: CurvePoint[];
  hueVsLum: CurvePoint[];
}

export type HueCurveChannel = keyof HueCurves;

export const HUE_CURVE_CHANNELS: readonly HueCurveChannel[] = ['hueVsHue', 'hueVsSat', 'hueVsLum'];

/** The y of "no adjustment" — upstream's `HueCurves.neutralY`. */
export const HUE_CURVE_NEUTRAL_Y = 0.5;

/** Tolerance around neutral: upstream's `isNeutral` uses 1e-4, not exactness. */
const HUE_CURVE_NEUTRAL_EPSILON = 1e-4;

/**
 * The anchors an empty channel evaluates as — upstream's
 * `HueCurves.defaultPoints` (six stops at x = i/6, all neutral). The future
 * editor widget draws these when the channel holds no points.
 */
export const DEFAULT_HUE_CURVE_POINTS: readonly CurvePoint[] = [0, 1, 2, 3, 4, 5].map((i) => ({
  x: i / 6,
  y: HUE_CURVE_NEUTRAL_Y,
}));

/**
 * Hue-curve validation bounds, exported for the future editor widget.
 *
 * Upstream's editor clamps drags to the unit square with a 0.001 x-gap and no
 * explicit point cap (like the tone-curve editor), so the port mirrors the
 * tone-curve cap: every Windows hue channel becomes nested FFmpeg
 * expressions — three LUT evals repeated per output channel across three
 * chained filters — and the cap keeps a multi-clip export inside the ~32K
 * Windows command line. The agent boundary refuses a longer channel;
 * `sanitizeHueCurvePoints` drops the excess points.
 */
export const COLOR_GRADE_HUE_CURVE_LIMITS = {
  maxPointsPerChannel: 16,
} as const;

/** True when the points adjust nothing: empty, or every y within 1e-4 of neutral. */
export function isNeutralHuePoints(points: readonly CurvePoint[]): boolean {
  return points.length === 0
    || points.every((point) => Math.abs(point.y - HUE_CURVE_NEUTRAL_Y) < HUE_CURVE_NEUTRAL_EPSILON);
}

/** True when every channel is neutral, so the hue curves are a no-op. */
export function isIdentityHueCurves(curves: HueCurves): boolean {
  return HUE_CURVE_CHANNELS.every((channel) => isNeutralHuePoints(curves[channel]));
}

/**
 * Narrow one hue channel: keep finite points inside [0, 1] whose x is
 * strictly greater than the previous kept point's, cap the count, and
 * canonicalize a neutral channel to empty.
 *
 * Out-of-order points are dropped rather than re-sorted, exactly like the
 * tone-curve sanitizer: a hand-edited file must not silently re-shape a look,
 * and the writer that produced it is the one that got the ordering wrong.
 */
function sanitizeHueCurvePoints(input: unknown): CurvePoint[] {
  if (!Array.isArray(input)) return [];
  const points: CurvePoint[] = [];
  let previousX = Number.NEGATIVE_INFINITY;
  for (const raw of input) {
    if (points.length >= COLOR_GRADE_HUE_CURVE_LIMITS.maxPointsPerChannel) break;
    if (typeof raw !== 'object' || raw === null) continue;
    const candidate = raw as { x?: unknown; y?: unknown };
    const x = inRange(candidate.x, 0, 1);
    const y = inRange(candidate.y, 0, 1);
    if (x === undefined || y === undefined || x <= previousX) continue;
    points.push({ x, y });
    previousX = x;
  }
  return isNeutralHuePoints(points) ? [] : points;
}

/**
 * Narrow an untrusted hue-curves object, dropping invalid channels and
 * points. Returns undefined when the whole set is neutral (nothing to apply).
 */
export function sanitizeHueCurves(input: unknown): HueCurves | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const candidate = input as Record<string, unknown>;
  const curves: HueCurves = {
    hueVsHue: sanitizeHueCurvePoints(candidate.hueVsHue),
    hueVsSat: sanitizeHueCurvePoints(candidate.hueVsSat),
    hueVsLum: sanitizeHueCurvePoints(candidate.hueVsLum),
  };
  return isIdentityHueCurves(curves) ? undefined : curves;
}

/** A per-channel hue-curves patch: a provided channel replaces, an empty array clears. */
export type HueCurvesPatch = Partial<Record<HueCurveChannel, CurvePoint[]>>;

/**
 * Strict parse of the agent's `hueCurves` argument.
 *
 * Unlike `sanitizeHueCurves`, which drops invalid points from an untrusted
 * project file, this refuses the whole call on the first malformed point so
 * the agent is told what was wrong instead of silently rendering different
 * curves. A channel sent empty or neutral is a request to clear it.
 */
export function parseHueCurvesPatch(
  input: unknown,
): { ok: true; patch: HueCurvesPatch } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'hueCurves must be an object with hueVsHue/hueVsSat/hueVsLum point arrays.' };
  }
  const candidate = input as Record<string, unknown>;
  const patch: HueCurvesPatch = {};
  for (const channel of HUE_CURVE_CHANNELS) {
    const raw = candidate[channel];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      return { ok: false, error: `hueCurves.${channel} must be an array of {x, y} points.` };
    }
    if (raw.length > COLOR_GRADE_HUE_CURVE_LIMITS.maxPointsPerChannel) {
      return {
        ok: false,
        error: `hueCurves.${channel} accepts at most ${COLOR_GRADE_HUE_CURVE_LIMITS.maxPointsPerChannel} points.`,
      };
    }
    const points: CurvePoint[] = [];
    let previousX = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < raw.length; index += 1) {
      const item = raw[index];
      if (typeof item !== 'object' || item === null) {
        return { ok: false, error: `hueCurves.${channel}[${index}] must be an {x, y} point.` };
      }
      const point = item as { x?: unknown; y?: unknown };
      const x = inRange(point.x, 0, 1);
      const y = inRange(point.y, 0, 1);
      if (x === undefined) {
        return { ok: false, error: `hueCurves.${channel}[${index}].x must be between 0 and 1.` };
      }
      if (y === undefined) {
        return { ok: false, error: `hueCurves.${channel}[${index}].y must be between 0 and 1.` };
      }
      if (x <= previousX) {
        return { ok: false, error: `hueCurves.${channel} points must have strictly ascending x.` };
      }
      points.push({ x, y });
      previousX = x;
    }
    patch[channel] = isNeutralHuePoints(points) ? [] : points;
  }
  return { ok: true, patch };
}

/** Structural equality on sanitized hue curves (undefined = identity). */
export function hueCurvesEqual(a: HueCurves | undefined, b: HueCurves | undefined): boolean {
  const ha = sanitizeHueCurves(a);
  const hb = sanitizeHueCurves(b);
  if (ha === undefined || hb === undefined) return ha === hb;
  return HUE_CURVE_CHANNELS.every((channel) => {
    const pa = ha[channel];
    const pb = hb[channel];
    return pa.length === pb.length
      && pa.every((point, index) => point.x === pb[index].x && point.y === pb[index].y);
  });
}

/**
 * Cyclic piecewise-linear interpolation — upstream's `HueCurves.eval`,
 * including its degenerate-segment guard. The curve wraps across the hue
 * seam: below the first point it interpolates from the last point shifted
 * down one turn, past the last point from the first shifted up, so there is
 * no jump at 0/1. An empty channel evaluates the neutral anchors (always
 * 0.5, i.e. no adjustment).
 */
export function evalHueCurve(points: readonly CurvePoint[], x: number): number {
  const sorted = points.length === 0
    ? [...DEFAULT_HUE_CURVE_POINTS]
    : [...points].sort((a, b) => a.x - b.x);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const lerp = (a: CurvePoint, b: CurvePoint): number => {
    const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
    return a.y + (b.y - a.y) * t;
  };
  if (x < first.x) return lerp({ x: last.x - 1, y: last.y }, first);
  for (let i = 1; i < sorted.length; i += 1) {
    if (x <= sorted[i].x) return lerp(sorted[i - 1], sorted[i]);
  }
  return lerp(last, { x: first.x + 1, y: first.y });
}

/**
 * Piecewise-linear interpolation, clamped flat outside the point range —
 * upstream's `GradeCurve.eval`, including its degenerate-segment guard. An
 * empty channel evaluates as the identity.
 */
export function evalCurve(points: readonly CurvePoint[], x: number): number {
  const sorted = points.length === 0
    ? [...IDENTITY_CURVE_POINTS]
    : [...points].sort((a, b) => a.x - b.x);
  if (x <= sorted[0].x) return sorted[0].y;
  const last = sorted[sorted.length - 1];
  if (x >= last.x) return last.y;
  for (let i = 1; i < sorted.length; i += 1) {
    if (x <= sorted[i].x) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return x;
}

/**
 * Named, built-in grade presets (upstream #157). Values stay inside
 * `COLOR_GRADE_LIMITS`, so applying one can never write a grade the sliders
 * cannot represent. `neutral` resets rather than writing defaults, which is
 * what keeps `hasColorGrade` false after a reset.
 */
export interface GradePreset {
  id: string;
  label: string;
  grade: Partial<ColorGrade>;
}

export const GRADE_PRESETS: readonly GradePreset[] = [
  { id: 'neutral', label: 'Neutral', grade: {} },
  { id: 'warm', label: 'Warm', grade: { brightness: 0.03, contrast: 1.05, saturation: 1.15, hueRotation: -8 } },
  { id: 'cool', label: 'Cool', grade: { brightness: 0.02, contrast: 1.05, saturation: 1.05, hueRotation: 10 } },
  { id: 'bw', label: 'Black & White', grade: { saturation: 0 } },
  { id: 'faded', label: 'Faded', grade: { brightness: 0.08, contrast: 0.85, saturation: 0.75 } },
  { id: 'punchy', label: 'Punchy', grade: { contrast: 1.3, saturation: 1.25 } },
  { id: 'vintage', label: 'Vintage', grade: { brightness: 0.05, contrast: 0.9, saturation: 0.8, hueRotation: -15 } },
] as const;

export function gradePresetById(id: string): GradePreset | undefined {
  return GRADE_PRESETS.find((preset) => preset.id === id);
}

export const GRADE_PRESET_NAME_MAX = 40;
export const MAX_USER_GRADE_PRESETS = 50;

/**
 * Narrow persisted user presets (upstream #157's "name and reuse" half).
 *
 * The stored file is user-writable, so every entry is validated: an id that
 * is not a safe token, an empty or over-long label, or a grade with no
 * usable fields is dropped rather than trusted. Later duplicates of an id
 * win, and the list is capped so a hand-edited file cannot grow without
 * bound. Unknown grade fields are stripped by `sanitizeColorGrade`, and
 * effect fields by `sanitizeClipEffects` (so a saved look keeps its blur,
 * vignette, grain and glow exactly like its curves).
 */
export function normalizeUserGradePresets(input: unknown): GradePreset[] {
  if (!Array.isArray(input)) return [];
  const byId = new Map<string, GradePreset>();
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { id?: unknown; label?: unknown; grade?: unknown };
    if (typeof candidate.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(candidate.id)) continue;
    if (typeof candidate.label !== 'string') continue;
    const label = candidate.label.trim();
    if (label.length === 0 || label.length > GRADE_PRESET_NAME_MAX) continue;
    const grade = sanitizeColorGrade(candidate.grade as Partial<ColorGrade> | undefined);
    const fx = sanitizeClipEffects(candidate.grade);
    const merged = { ...grade, ...fx };
    if (Object.keys(merged).length === 0) continue;
    byId.set(candidate.id, { id: candidate.id, label, grade: merged });
    if (byId.size >= MAX_USER_GRADE_PRESETS) break;
  }
  return [...byId.values()];
}

/** Extract non-default color fields from a clip; null when no grading. */
export function colorGradeOf(clip: Clip): ColorGrade | null {
  const curves = sanitizeGradeCurve(clip.curves);
  const wheels = sanitizeGradeWheels(clip.wheels);
  const hueCurves = sanitizeHueCurves(clip.hueCurves);
  const lut = sanitizeLutRef(clip.lut);
  const grade: ColorGrade = {
    brightness: clip.brightness ?? DEFAULTS.brightness,
    contrast: clip.contrast ?? DEFAULTS.contrast,
    saturation: clip.saturation ?? DEFAULTS.saturation,
    hueRotation: clip.hueRotation ?? DEFAULTS.hueRotation,
    exposure: clip.exposure ?? DEFAULTS.exposure,
    temperature: clip.temperature ?? DEFAULTS.temperature,
    tint: clip.tint ?? DEFAULTS.tint,
    vibrance: clip.vibrance ?? DEFAULTS.vibrance,
    highlights: clip.highlights ?? DEFAULTS.highlights,
    shadows: clip.shadows ?? DEFAULTS.shadows,
    blacks: clip.blacks ?? DEFAULTS.blacks,
    whites: clip.whites ?? DEFAULTS.whites,
    invertColors: clip.invertColors ?? DEFAULTS.invertColors,
    ...(curves ? { curves } : {}),
    ...(wheels ? { wheels } : {}),
    ...(hueCurves ? { hueCurves } : {}),
    ...(lut ? { lut } : {}),
  };
  return isDefaultGrade(grade) ? null : grade;
}

function isDefaultGrade(g: ColorGrade): boolean {
  return g.brightness === 0 && g.contrast === 1 && g.saturation === 1 && g.hueRotation === 0 && g.exposure === 0 && g.temperature === 6500 && g.tint === 0 && g.vibrance === 0 && g.highlights === 0 && g.shadows === 0 && g.blacks === 0 && g.whites === 0 && !g.invertColors && g.curves === undefined && g.wheels === undefined && g.hueCurves === undefined && g.lut === undefined;
}

/**
 * Chromium canvas `ctx.filter` string, e.g.
 * `brightness(0.9) contrast(1.2) saturate(0.5) hue-rotate(30deg)`.
 */
export function toCanvasFilter(grade: ColorGrade): string {
  const parts: string[] = [];
  if (grade.brightness !== 0) parts.push(`brightness(${grade.brightness.toFixed(3)})`);
  if (grade.contrast !== 1) parts.push(`contrast(${grade.contrast.toFixed(3)})`);
  if (grade.saturation !== 1) parts.push(`saturate(${grade.saturation.toFixed(3)})`);
  if (grade.hueRotation !== 0) parts.push(`hue-rotate(${grade.hueRotation.toFixed(1)}deg)`);
  if (grade.invertColors) parts.push('invert(1)');
  return parts.join(' ');
}

/**
 * FFmpeg `eq` filter value, e.g.
 * `eq=brightness=0.100000:contrast=1.200000:saturation=0.500000`.
 *
 * Hue rotation and invert ride separate filters (`hue`, `negate`), because
 * FFmpeg rejects unknown `eq` options — embedding `hue=h=` in the eq string
 * fails the whole export. See toFfmpegColorChain for the assembled order.
 */
export function toFfmpegEq(grade: ColorGrade): string {
  const parts: string[] = [];
  if (grade.brightness !== 0) parts.push(`brightness=${grade.brightness.toFixed(6)}`);
  if (grade.contrast !== 1) parts.push(`contrast=${grade.contrast.toFixed(6)}`);
  if (grade.saturation !== 1) parts.push(`saturation=${grade.saturation.toFixed(6)}`);
  return parts.length > 0 ? `eq=${parts.join(':')}` : '';
}

/**
 * Compact number formatting for filter expressions: six decimals of
 * precision without float dust (`0.30000000000000004` would still parse, but
 * the chains are reviewed by humans too).
 */
function formatFilterNumber(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

/**
 * Exact round-trip formatting for curve literals: a coordinate that printed
 * as 0.123457 would build a slightly different LUT than the preview's
 * in-memory points, so curve expressions print the shortest exact decimal
 * instead of `formatFilterNumber`'s six-place rounding.
 */
function curveLiteral(value: number): string {
  return String(value);
}

/**
 * Nested av_expr for upstream's piecewise-linear eval of `points` at `input`:
 * flat outside the first/last point, linear between them. The association
 * matches `evalCurve` (`a.y + (b.y - a.y) * t`) so FFmpeg's 256-entry table
 * and the preview's LUT agree to the bit.
 */
function curveExpression(points: readonly CurvePoint[], input: string): string {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  if (sorted.length === 0 || isIdentityPoints(sorted)) return input;
  let expression = curveLiteral(sorted[sorted.length - 1].y);
  for (let i = sorted.length - 1; i >= 1; i -= 1) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const segment = `${curveLiteral(a.y)}+(${curveLiteral(b.y)}-${curveLiteral(a.y)})`
      + `*(((${input})-${curveLiteral(a.x)})/(${curveLiteral(b.x)}-${curveLiteral(a.x)}))`;
    expression = `if(lt(${input},${curveLiteral(b.x)}),${segment},${expression})`;
  }
  return `if(lt(${input},${curveLiteral(sorted[0].x)}),${curveLiteral(sorted[0].y)},${expression})`;
}

/** Rec.709 luma weights, the exact constants GradeCurves.metal dots with. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;
/** The kernel's near-black guard y > 1e-4, expressed in byte units (y * 255). */
const LUMA_EPSILON_BYTES = 0.0255;
/** The kernel caps the luma-preserving gain at 8x. */
const MASTER_GAIN_CAP = 8;

/**
 * The master step as one FFmpeg `geq`: it needs all three channels to form
 * the Rec.709 luma, so no per-plane filter can express it. Mirrors the Metal
 * kernel — quantized 256-step master lookup, 8x gain cap, near-black
 * passthrough — and carries alpha through untouched (`alpha(X,Y)`; a bare
 * `a(X,Y)` is not a function FFmpeg 8 accepts, and omitting the option zeroes
 * alpha).
 */
function masterCurveFilter(points: readonly CurvePoint[]): string {
  const luma = `(${LUMA_R}*r(X,Y)+${LUMA_G}*g(X,Y)+${LUMA_B}*b(X,Y))`;
  const yp = curveExpression(points, `(floor(${luma}+0.5)/255)`);
  const factor = `min(${yp}/(${luma}/255),${MASTER_GAIN_CAP})`;
  const nearBlack = curveLiteral(clampUnit(evalCurve(points, 0)) * 255);
  const channel = (c: 'r' | 'g' | 'b'): string =>
    `if(gt(${luma},${LUMA_EPSILON_BYTES}),min(max(${c}(X,Y)*${factor},0),255),${nearBlack})`;
  return `geq=r='${channel('r')}':g='${channel('g')}':b='${channel('b')}':a='alpha(X,Y)'`;
}

/**
 * Curve filters in kernel order: the master luma step first (geq, above),
 * then the per-channel LUTs. `lutrgb` is the exact per-channel half: FFmpeg
 * compiles each expression into a 256-entry table, so its store path is the
 * same quantization the kernel's channel LUT performs. Empty for an identity
 * curve.
 */
export function toFfmpegCurveFilters(curve: GradeCurve): string[] {
  if (isIdentityGradeCurve(curve)) return [];
  const filters: string[] = [];
  if (!isIdentityPoints(curve.master)) {
    filters.push(masterCurveFilter(curve.master));
  }
  const parts: string[] = [];
  for (const [channel, option] of [
    ['red', 'r'], ['green', 'g'], ['blue', 'b'],
  ] as ReadonlyArray<[GradeCurveChannel, 'r' | 'g' | 'b']>) {
    if (isIdentityPoints(curve[channel])) continue;
    // lutrgb expressions are in byte units, so the normalized curve output
    // is scaled by 255 (the preview's LUT does the same before truncating).
    parts.push(`${option}='255*(${curveExpression(curve[channel], 'val/255')})'`);
  }
  if (parts.length > 0) filters.push(`lutrgb=${parts.join(':')}`);
  return filters;
}

/**
 * The wheels step as one FFmpeg `geq`: per channel,
 * `clamp(pow(max(in * (1 - lift) + lift, 0) * gain, invGamma))` with the same
 * precomputed triplets the preview's `wheelsPixel` uses, so both sides agree
 * to the bit modulo the six-place constant printing.
 *
 * `colorbalance` (shadows/midtones/highlights offsets) is the tempting
 * alternative, but its math is luma-masked addition, not this
 * lift-offset-then-gain-then-gamma-power per channel — emitting it would
 * render a different look than the preview. A spline-based filter is rejected
 * for the same reason; `geq` is the exact per-channel half. Empty for identity
 * wheels. Clamps explicitly (geq wraps without it) and preserves alpha.
 */
export function toFfmpegWheelsFilter(wheels: GradeWheels | undefined): string {
  const coeffs = buildWheelsCoeffs(wheels);
  if (!coeffs) return '';
  const channel = (c: 'r' | 'g' | 'b', index: 0 | 1 | 2): string => {
    const lift = formatFilterNumber(coeffs.lift[index]);
    const gain = formatFilterNumber(coeffs.gain[index]);
    const invGamma = formatFilterNumber(coeffs.invGamma[index]);
    return `min(max(pow(max(${c}(X,Y)/255*(1-${lift})+${lift},0)*${gain},${invGamma})*255,0),255)`;
  };
  return `geq=r='${channel('r', 0)}':g='${channel('g', 1)}':b='${channel('b', 2)}':a='alpha(X,Y)'`;
}

/** ±30° hue swing at a full push — upstream `HueCurveKernel.maxHueShift`. */
const HUE_MAX_SHIFT = 1 / 12;
/** ±0.5 luminance swing at a full push — upstream `HueCurveKernel.maxLumShift`. */
const HUE_MAX_LUM_SHIFT = 0.5;
/** Saturation gate — upstream's `smoothstep(0.04, 0.18, sat)`. */
const HUE_GATE_LOW = 0.04;
const HUE_GATE_WIDTH = 0.14;
/** Width of the per-hue LUTs, matching upstream's `HueCurveKernel.lutWidth`. */
export const HUE_CURVE_LUT_WIDTH = 256;

/**
 * Nested av_expr for upstream's cyclic eval of `points` at `input`: wraps
 * across the seam (last-minus-one-turn below the first point, first-plus-one
 * above the last), linear between. The association matches `evalHueCurve`
 * (`a.y + (b.y - a.y) * t`) and coordinates print exactly (see
 * `curveLiteral`), so the export evaluates the same doubles the preview's
 * LUT holds. The caller guarantees a non-neutral, non-empty channel —
 * neutral channels emit the literal `0`.
 */
function hueCurveExpression(points: readonly CurvePoint[], input: string): string {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const segment = (a: CurvePoint, b: CurvePoint): string =>
    `(${curveLiteral(a.y)}+(${curveLiteral(b.y)}-${curveLiteral(a.y)})`
    + `*(((${input})-${curveLiteral(a.x)})/(${curveLiteral(b.x)}-${curveLiteral(a.x)})))`;
  let expression = segment(last, { x: first.x + 1, y: first.y });
  for (let i = sorted.length - 1; i >= 1; i -= 1) {
    expression = `if(lt(${input},${curveLiteral(sorted[i].x)}),${segment(sorted[i - 1], sorted[i])},${expression})`;
  }
  return `if(lt(${input},${curveLiteral(first.x)}),${segment({ x: last.x - 1, y: last.y }, first)},${expression})`;
}

/**
 * Stage A: normalized RGB to HSV, the `rgb2hsv` half of HueCurves.metal in
 * selection form (`mix`/`step` spelled as `if`/`gte` — with g == b both
 * spellings coincide, so `max`/`min` read identically). Outputs hue,
 * saturation and value scaled to bytes. Every output is explicitly `floor`ed:
 * the values are non-negative, so the floor is exact and the geq store mode
 * (truncate vs round) cannot matter — the preview floors identically (see
 * `hueCurvesPixel`).
 */
function hueStageAFilter(): string {
  const R = 'r(X,Y)/255';
  const G = 'g(X,Y)/255';
  const B = 'b(X,Y)/255';
  const PX = `max(${G},${B})`;
  const PY = `min(${G},${B})`;
  const PZ = `if(gte(${G},${B}),0,${curveLiteral(-1 / 3)})`;
  const PW = `if(gte(${G},${B}),${curveLiteral(-1 / 3)},${curveLiteral(2 / 3)})`;
  const C = `gte(${R},${PX})`;
  const QX = `if(${C},${R},${PX})`;
  const QY = PY;
  const QZ = `if(${C},${PZ},${PW})`;
  const QW = `if(${C},${PX},${R})`;
  // Parenthesized: these embed into larger products and quotients, and
  // av_expr would otherwise rebind `*` and `/` around the top-level `-`.
  const D = `(${QX}-min(${QW},${QY}))`;
  const S = `(${D}/(${QX}+1e-10))`;
  const V = `(${QX})`;
  const H = `(abs(${QZ}+(${QW}-${QY})/(6*${D}+1e-10)))`;
  const Hf = `(${H}-floor(${H}))`;
  return `geq=r='floor((${Hf})*255)':g='floor((${S})*255)':b='floor((${V})*255)':a='alpha(X,Y)'`;
}

/**
 * Stage B: the hue LUTs plus the saturation gate. Reads the (h, s, v) bytes
 * stage A wrote, so every atom is a cheap byte read — the LUT evals stay
 * small despite repeating per output channel. The stored hue byte IS the LUT
 * index on both sides (the preview looks up the same byte), so no
 * re-quantization idiom is needed.
 */
function hueStageBFilter(curves: HueCurves): string {
  const H = 'r(X,Y)/255';
  const S = 'g(X,Y)/255';
  const V = 'b(X,Y)/255';
  const lut = (
    channel: HueCurveChannel,
    scale: (evalExpr: string) => string,
  ): string => (isNeutralHuePoints(curves[channel])
    ? '0'
    : scale(hueCurveExpression(curves[channel], H)));
  const dh = lut('hueVsHue', (e) => `((${e}-0.5)*2*${curveLiteral(HUE_MAX_SHIFT)})`);
  const sk = lut('hueVsSat', (e) => `((${e}-0.5)*2)`);
  const dl = lut('hueVsLum', (e) => `((${e}-0.5)*2*${curveLiteral(HUE_MAX_LUM_SHIFT)})`);
  const T = `(min(max((${S}-${HUE_GATE_LOW})/${HUE_GATE_WIDTH},0),1))`;
  const GATE = `(${T}*${T}*(3-2*${T}))`;
  const H2 = `(${H}+(${dh})*(${GATE}))`;
  const H2f = `(${H2}-floor(${H2}))`;
  const S2 = `(min(max(${S}*(1+(${sk})*(${GATE})),0),1))`;
  const V2 = `(min(max(${V}+(${dl})*(${GATE}),0),1))`;
  return `geq=r='floor((${H2f})*255)':g='floor((${S2})*255)':b='floor((${V2})*255)':a='alpha(X,Y)'`;
}

/**
 * Stage C: HSV back to RGB plus the final byte store, the `hsv2rgb` half of
 * HueCurves.metal (`floor(out*255)`, clamped — the preview's `truncByte`
 * lands on the same integer for these non-negative values).
 */
function hueStageCFilter(): string {
  const H2 = 'r(X,Y)/255';
  const S2 = 'g(X,Y)/255';
  const V2 = 'b(X,Y)/255';
  const P = (k: number): string => `abs(((${H2})+${curveLiteral(k)}-floor((${H2})+${curveLiteral(k)}))*6-3)`;
  const channel = (p: string): string =>
    `min(max(floor((${V2})*(1+(min(max(${p}-1,0),1)-1)*(${S2}))*255),0),255)`;
  return `geq=r='${channel(P(1))}':g='${channel(P(2 / 3))}':b='${channel(P(1 / 3))}':a='alpha(X,Y)'`;
}

/**
 * Hue-curve filters in kernel order: RGB→HSV (A), LUT lookups plus the
 * saturation gate (B), HSV→RGB with the byte store (C). Empty for identity
 * hue curves.
 *
 * No single-plane filter can express this: the stage is hue-selective (each
 * output channel needs the pixel's hue, all three LUTs, and the gate), so
 * `hue` (global rotation), `colorbalance` (luma-masked RGB offsets) and
 * `curves`/`lutrgb` (per-channel functions of the channel itself, blind to
 * hue) are all the wrong model family — each would render a different look
 * than the preview. A generated 3D LUT (`lut3d`) is rejected too: it would
 * break the export builder's purity (sidecar files) and its tetrahedral
 * interpolation cannot promise byte parity. A 16-bit intermediate chain
 * (`format=rgba64le` sandwich) is rejected as well: swscale dithers its depth
 * conversions (a constant 200*257 round-trips as 201), which no preview math
 * can mirror. Three chained 8-bit `geq`s are the exact per-pixel half: every
 * intermediate is an explicitly floored byte, so the store mode cannot matter
 * (verified byte-identical with FFmpeg 8.1.2).
 */
export function toFfmpegHueCurveFilters(curves: HueCurves | undefined): string[] {
  const clean = sanitizeHueCurves(curves);
  if (!clean) return [];
  return [hueStageAFilter(), hueStageBFilter(clean), hueStageCFilter()];
}

/**
 * The export color chain for a clip, in application order: exposure gain,
 * vibrance, tonal controls, eq, color wheels, tone curves, hue curves, LUT,
 * hue rotation, then invert — the same order the preview pass applies, so no
 * backend disagrees about which transform sees which pixels. Each entry is
 * one FFmpeg filter; the caller joins them with ','.
 *
 * The wheels', curves', hue-curves' and LUT slots follow upstream's canonical
 * effect order (`Compositing/EffectRegistry.swift` `canonicalOrder`, applied
 * per layer by `Compositing/FrameRenderer.swift` after crop): `color.wheels`
 * sits after the saturation stage and before `color.curves`, which sits
 * before `color.hueCurves`, which sits before `color.lut`, before invert.
 * `eq` carries this port's contrast and saturation, so wheels land
 * immediately after it, curves after wheels, hue curves after curves, and
 * the LUT after hue curves.
 *
 * A partial LUT intensity (0 < i < 1) cannot be one comma filter — blending
 * needs two frames — so the chain only carries full-intensity LUTs; the
 * export builder expands a partial blend into a split/blend graph at this
 * same slot (see `toFfmpegPreLutChain` / `toFfmpegPostLutChain`).
 */
export function toFfmpegColorChain(grade: ColorGrade): string[] {
  return [
    ...toFfmpegPreLutChain(grade),
    ...toFfmpegLutSingleFilter(grade.lut),
    ...toFfmpegPostLutChain(grade),
  ];
}

/**
 * Everything `toFfmpegColorChain` emits up to and including the hue curves —
 * the half of the chain ahead of the LUT slot. The export builder reuses it
 * for the partial-intensity path, where the LUT becomes a split/blend graph
 * (no single comma filter can blend two frames) instead of one filter.
 */
export function toFfmpegPreLutChain(grade: ColorGrade): string[] {
  const chain: string[] = [];
  const [gr, gg, gb] = channelGains(grade);
  if (gr !== 1 || gg !== 1 || gb !== 1) {
    const gain = (v: number): string => v.toFixed(6);
    const channel = (c: 'r' | 'g' | 'b', v: number): string =>
      `min(max(${c}(X,Y)*${gain(v)},0),255)`;
    chain.push(`geq=r='${channel('r', gr)}':g='${channel('g', gg)}':b='${channel('b', gb)}':a='alpha(X,Y)'`);
  }
  if (grade.vibrance) {
    chain.push(
      `vibrance=${grade.vibrance}:rlum=${VIBRANCE_LUMA_R}:glum=${VIBRANCE_LUMA_G}:blum=${VIBRANCE_LUMA_B}`,
    );
  }
  if (grade.highlights || grade.shadows) {
    const luma = '(0.2126*r(X,Y)+0.7152*g(X,Y)+0.0722*b(X,Y))/255';
    const delta = `(((${formatFilterNumber(grade.highlights ?? 0)}*pow(${luma},3)+${formatFilterNumber(grade.shadows ?? 0)}*pow(1-(${luma}),3))*0.5)*255)`;
    const channel = (c: 'r' | 'g' | 'b'): string =>
      `min(max(${c}(X,Y)+${delta},0),255)`;
    chain.push(`geq=r='${channel('r')}':g='${channel('g')}':b='${channel('b')}':a='alpha(X,Y)'`);
  }
  if (grade.blacks || grade.whites) {
    const blackPoint = -(grade.blacks ?? 0) * 0.4;
    const whitePoint = 1.0 - (grade.whites ?? 0) * 0.4;
    const range = Math.max(0.05, whitePoint - blackPoint);
    const offset = -blackPoint * 255;
    const channel = (c: 'r' | 'g' | 'b'): string =>
      `min(max((${c}(X,Y)${offset < 0 ? '' : '+'}${formatFilterNumber(offset)})/${formatFilterNumber(range)},0),255)`;
    chain.push(`geq=r='${channel('r')}':g='${channel('g')}':b='${channel('b')}':a='alpha(X,Y)'`);
  }
  const eq = toFfmpegEq(grade);
  if (eq) chain.push(eq);
  const wheels = toFfmpegWheelsFilter(grade.wheels);
  if (wheels) chain.push(wheels);
  if (grade.curves) chain.push(...toFfmpegCurveFilters(grade.curves));
  if (grade.hueCurves) chain.push(...toFfmpegHueCurveFilters(grade.hueCurves));
  return chain;
}

/**
 * Everything after the LUT slot: hue rotation, then invert — the same order
 * the preview pass applies, so the split/blend export path rejoins on the
 * same pixels the linear chain would have seen.
 */
export function toFfmpegPostLutChain(
  grade: Pick<ColorGrade, 'hueRotation' | 'invertColors'>,
): string[] {
  const chain: string[] = [];
  // Truthy, not !== 0: callers pass partial grades, and an absent rotation
  // is unset rather than 0 — both skip the filter.
  if (grade.hueRotation) chain.push(`hue=h=${grade.hueRotation.toFixed(1)}`);
  if (grade.invertColors) chain.push('negate');
  return chain;
}

/**
 * The LUT stage as a single comma-chain filter: the `lut3d`/`lut1d` lookup
 * at full intensity. Empty when there is no LUT or the intensity is 0 (a
 * zero blend renders the original, so no filter runs). A partial intensity
 * cannot be one filter — the export builder expands it into a split/blend
 * graph at this same slot — so it also yields nothing here.
 */
export function toFfmpegLutSingleFilter(lut: LutRef | undefined): string[] {
  const clean = sanitizeLutRef(lut);
  if (!clean || clean.intensity <= 0 || clean.intensity < 1) return [];
  return [toFfmpegLutFilter(clean)];
}

/**
 * Multiplicative gain for an exposure value in EV stops: +1 doubles the
 * signal, -1 halves it. Shared by the preview pixel pass and the export
 * geq expression so the two can never disagree on the amount.
 */
export function exposureGain(evStops: number): number {
  return 2 ** evStops;
}

/**
 * Luma weights for the vibrance operation (upstream #157 Presence).
 *
 * These exact constants ride the export filter explicitly
 * (`vibrance=…:rlum=0.212656:glum=0.715158:blum=0.072186`) because several
 * shipped FFmpeg releases carry them swapped (rlum/blum transposed, fixed
 * upstream only in 2025) — relying on each build's defaults would render the
 * same project differently per machine. The preview uses the same constants
 * below, so both sides agree regardless of the local FFmpeg.
 */
export const VIBRANCE_LUMA_R = 0.212656;
export const VIBRANCE_LUMA_G = 0.715158;
export const VIBRANCE_LUMA_B = 0.072186;

/**
 * Vibrance on one RGB pixel (integers in, integers out): selective
 * saturation from the chroma range, lerped about Rec.709 luma, truncated and
 * clipped exactly like the filter's store path.
 */
export function vibrancePixel(r: number, g: number, b: number, intensity: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const saturation = Math.max(rn, gn, bn) - Math.min(rn, gn, bn);
  const luma = gn * VIBRANCE_LUMA_G + rn * VIBRANCE_LUMA_R + bn * VIBRANCE_LUMA_B;
  // alternate=0, default balances: the sign term is -sign(intensity).
  const sign = intensity === 0 ? 0 : -Math.sign(intensity);
  const gain = 1 + intensity * (1 - sign * saturation);
  const out = (c: number): number => {
    const v = luma + (c - luma) * gain;
    return Math.trunc(Math.min(255, Math.max(0, v * 255)));
  };
  return [out(rn), out(gn), out(bn)];
}

/**
 * Highlights and shadows on one RGB pixel (integers in, integers out).
 *
 * Upstream's HighlightsShadows kernel, ported exactly: Rec.709 luma masks a
 * luminance delta added to every channel — highlights peak at white (y^3),
 * shadows at black ((1-y)^3) — then saturate. Alpha untouched. Inputs arrive
 * as truncated integers from the previous stage, matching per-filter store
 * truncation on the export side.
 */
export function highlightsShadowsPixel(
  r: number,
  g: number,
  b: number,
  highlights: number,
  shadows: number,
): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const y = 0.2126 * rn + 0.7152 * gn + 0.0722 * bn;
  const delta = (highlights * y * y * y + shadows * (1 - y) * (1 - y) * (1 - y)) * 0.5;
  const out = (c: number): number => Math.trunc(Math.min(255, Math.max(0, (c + delta) * 255)));
  return [out(rn), out(gn), out(bn)];
}

/**
 * Black/white-point remap on one RGB pixel (integers in, integers out).
 *
 * Upstream's Levels kernel, ported exactly: independent per-channel linear
 * stretch. Blacks below zero crush the floor, above zero lift it; whites
 * above zero brighten toward clipping, below zero recover the ceiling. The
 * 0.05 floor keeps the range non-degenerate.
 */
export function blacksWhitesPixel(
  r: number,
  g: number,
  b: number,
  blacks: number,
  whites: number,
): [number, number, number] {
  const blackPoint = -blacks * 0.4;
  const whitePoint = 1.0 - whites * 0.4;
  const range = Math.max(0.05, whitePoint - blackPoint);
  const out = (c: number): number =>
    Math.trunc(Math.min(255, Math.max(0, ((c / 255 - blackPoint) / range) * 255)));
  return [out(r), out(g), out(b)];
}

// ─── Tone-curve pixel math (upstream GradeCurves.metal) ─────────────────────

/**
 * The 256-entry tables upstream's kernel builds once per curve: R/G/B channel
 * tables plus one master (luma) table. Entry i is clamp(eval(points, i/255)).
 * An identity channel is absent: that stage is then a passthrough, matching
 * the export chain, which emits no filter for it (and avoiding an identity
 * table's v/255*255 round-trip truncation).
 */
export interface GradeCurveLuts {
  master?: Float64Array;
  red?: Float64Array;
  green?: Float64Array;
  blue?: Float64Array;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Truncate toward zero and clamp to a byte, mirroring FFmpeg's store path. */
function truncByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.trunc(value);
}

function buildCurveLut(points: readonly CurvePoint[]): Float64Array {
  const table = new Float64Array(GRADE_CURVE_LUT_WIDTH);
  for (let i = 0; i < GRADE_CURVE_LUT_WIDTH; i += 1) {
    table[i] = clampUnit(evalCurve(points, i / (GRADE_CURVE_LUT_WIDTH - 1)));
  }
  return table;
}

/**
 * Build the per-curve LUTs. Called once per grade application (frame), never
 * per pixel — the preview's `applyGradeToRgba` builds them once and hands the
 * same tables to every pixel. Returns undefined for an identity curve so the
 * caller skips the stage entirely, like the kernel's `isIdentity` guard.
 */
export function buildGradeCurveLuts(curve: GradeCurve | undefined): GradeCurveLuts | undefined {
  if (!curve || isIdentityGradeCurve(curve)) return undefined;
  const luts: GradeCurveLuts = {};
  if (!isIdentityPoints(curve.master)) luts.master = buildCurveLut(curve.master);
  if (!isIdentityPoints(curve.red)) luts.red = buildCurveLut(curve.red);
  if (!isIdentityPoints(curve.green)) luts.green = buildCurveLut(curve.green);
  if (!isIdentityPoints(curve.blue)) luts.blue = buildCurveLut(curve.blue);
  return luts;
}

/**
 * Curves on one RGB pixel (integers in, integers out) — a port of upstream's
 * GradeCurves.metal:
 *
 *   1. master: y = Rec.709 luma of the byte inputs; yp = masterLut[y];
 *      rgb *= min(yp / y, 8), or rgb = yp when y is at/below 1e-4;
 *   2. per-channel: R/G/B each pass through their own 256-entry LUT.
 *
 * The master lookup is quantized to the 256-entry table (index = round(y *
 * 255)), the 256-step LUT quantization of the kernel's master sampler; an
 * identity master skips the luma step entirely, matching the export chain
 * (and avoiding the identity table rounding near-black pixels to zero).
 * Identity channels likewise pass through untouched. Both stages store bytes
 * between filters exactly like the FFmpeg chain (`geq` then `lutrgb`), so
 * preview and export see the same integers.
 */
export function gradeCurvePixel(
  r: number,
  g: number,
  b: number,
  luts: GradeCurveLuts,
): [number, number, number] {
  let mr = r;
  let mg = g;
  let mb = b;
  const master = luts.master;
  if (master) {
    const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    if (luma > LUMA_EPSILON_BYTES) {
      const yp = master[Math.round(luma)];
      const factor = Math.min(yp / (luma / 255), MASTER_GAIN_CAP);
      mr = truncByte(r * factor);
      mg = truncByte(g * factor);
      mb = truncByte(b * factor);
    } else {
      mr = truncByte(master[0] * 255);
      mg = mr;
      mb = mr;
    }
  }
  return [
    luts.red ? truncByte(luts.red[mr] * 255) : mr,
    luts.green ? truncByte(luts.green[mg] * 255) : mg,
    luts.blue ? truncByte(luts.blue[mb] * 255) : mb,
  ];
}

// ─── Color-wheel pixel math (upstream ColorWheels.swift + Wheels.metal) ───────

/** Per-channel lift / gain / inverse-gamma, precomputed once per grade. */
export interface WheelsCoeffs {
  lift: [number, number, number];
  gain: [number, number, number];
  invGamma: [number, number, number];
}

/** Chroma strength per zone: how far a full-deflection pad reaches. */
const WHEELS_CHROMA_LIFT = 0.2;
const WHEELS_CHROMA_GAIN = 0.35;
const WHEELS_CHROMA_GAMMA = 0.35;

/**
 * Fully-saturated hue at h in [0, 1) — upstream's `ColorWheels.hueRGB`,
 * including its negative-h normalization through floor.
 */
export function wheelsHueRGB(h: number): [number, number, number] {
  const x = (h - Math.floor(h)) * 6;
  const f = x - Math.floor(x);
  switch (Math.floor(x) % 6) {
    case 0: return [1, f, 0];
    case 1: return [1 - f, 1, 0];
    case 2: return [0, 1, f];
    case 3: return [0, 1 - f, 1];
    case 4: return [f, 0, 1];
    default: return [1, 0, 1 - f];
  }
}

/**
 * Luma-neutral per-channel offset for a pad position (angle = hue, radius =
 * strength) — upstream's `ColorWheels.chromaOffset`, including the 1e-6
 * dead zone around center and the radius clamp to the unit disk.
 */
export function wheelsChromaOffset(x: number, y: number): [number, number, number] {
  const r = Math.min(1, Math.sqrt(x * x + y * y));
  if (r <= 1e-6) return [0, 0, 0];
  const [cr, cg, cb] = wheelsHueRGB(Math.atan2(y, x) / (2 * Math.PI));
  const mean = (cr + cg + cb) / 3;
  return [(cr - mean) * r, (cg - mean) * r, (cb - mean) * r];
}

/**
 * Per-channel lift / gain / inverse-gamma for one wheels grade — upstream's
 * `ColorWheels.coefficients`: the pad offset scaled by the zone's chroma
 * strength rides the master (lift adds, gain multiplies, gamma divides with a
 * 0.01 floor so the inverse can never blow up).
 */
export function wheelsCoefficients(wheels: GradeWheels): WheelsCoeffs {
  const lift = wheelsChromaOffset(wheels.lift.x, wheels.lift.y);
  const gamma = wheelsChromaOffset(wheels.gamma.x, wheels.gamma.y);
  const gain = wheelsChromaOffset(wheels.gain.x, wheels.gain.y);
  const liftM = wheels.lift.m;
  const gammaM = wheels.gamma.m;
  const gainM = wheels.gain.m;
  return {
    lift: [
      liftM + lift[0] * WHEELS_CHROMA_LIFT,
      liftM + lift[1] * WHEELS_CHROMA_LIFT,
      liftM + lift[2] * WHEELS_CHROMA_LIFT,
    ],
    gain: [
      gainM * (1 + gain[0] * WHEELS_CHROMA_GAIN),
      gainM * (1 + gain[1] * WHEELS_CHROMA_GAIN),
      gainM * (1 + gain[2] * WHEELS_CHROMA_GAIN),
    ],
    invGamma: [
      1 / Math.max(0.01, gammaM * (1 + gamma[0] * WHEELS_CHROMA_GAMMA)),
      1 / Math.max(0.01, gammaM * (1 + gamma[1] * WHEELS_CHROMA_GAMMA)),
      1 / Math.max(0.01, gammaM * (1 + gamma[2] * WHEELS_CHROMA_GAMMA)),
    ],
  };
}

/**
 * Build the per-grade wheels coefficients. Called once per grade application
 * (frame), never per pixel — the preview's `applyGradeToRgba` builds them once
 * and hands the same triplets to every pixel. Returns undefined for an
 * identity wheels so the caller skips the stage entirely, like the kernel's
 * `isNeutral` guard.
 */
export function buildWheelsCoeffs(wheels: GradeWheels | undefined): WheelsCoeffs | undefined {
  if (!wheels || isIdentityGradeWheels(wheels)) return undefined;
  return wheelsCoefficients(wheels);
}

/**
 * Wheels on one RGB pixel (integers in, integers out) — a port of upstream's
 * Wheels.metal: per channel, `clamp(pow(max(in * (1 - lift) + lift, 0) * gain,
 * invGamma))`, truncated and clipped exactly like the export geq store.
 * Alpha untouched. Inputs arrive as truncated integers from the previous
 * stage, matching per-filter store truncation on the export side.
 */
export function wheelsPixel(
  r: number,
  g: number,
  b: number,
  coeffs: WheelsCoeffs,
): [number, number, number] {
  const channel = (c: number, index: 0 | 1 | 2): number => {
    const lit = Math.max((c / 255) * (1 - coeffs.lift[index]) + coeffs.lift[index], 0)
      * coeffs.gain[index];
    return truncByte(Math.pow(lit, coeffs.invGamma[index]) * 255);
  };
  return [channel(r, 0), channel(g, 1), channel(b, 2)];
}

// ─── Hue-curve pixel math (upstream HueCurves.metal) ─────────────────────────

/**
 * Display-space RGB to HSV — the `rgb2hsv` half of HueCurves.metal in
 * selection form (`mix`/`step` spelled as ternaries/`Math.max`: with g == b
 * both spellings coincide). Inputs are normalized bytes, so the outputs land
 * in [0, 1] up to the kernel's own 1e-10 guards.
 */
export function rgb2hsv(r: number, g: number, b: number): [number, number, number] {
  const px = Math.max(g, b);
  const py = Math.min(g, b);
  const pz = g >= b ? 0 : -1 / 3;
  const pw = g >= b ? -1 / 3 : 2 / 3;
  const c = r >= px;
  const qx = c ? r : px;
  const qy = py;
  const qz = c ? pz : pw;
  const qw = c ? px : r;
  const d = qx - Math.min(qw, qy);
  const h = Math.abs(qz + (qw - qy) / (6 * d + 1e-10));
  const s = d / (qx + 1e-10);
  return [h, s, qx];
}

/**
 * Display-space HSV to RGB — the `hsv2rgb` half of HueCurves.metal. With
 * s == 0 the mix collapses to grey regardless of h, which is what keeps
 * gated-out pixels achromatic.
 */
export function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const mixc = (k: number): number => {
    const p = Math.abs((h + k - Math.floor(h + k)) * 6 - 3);
    return v * (1 + (Math.min(Math.max(p - 1, 0), 1) - 1) * s);
  };
  return [mixc(1), mixc(2 / 3), mixc(1 / 3)];
}

/**
 * The 256-entry tables upstream's kernel samples once per hue: R holds the
 * hue delta (turns), G the saturation-scale offset, B the luminance shift.
 * Entry i is the triple at hue i/255. Neutral channels are all zeros, so a
 * partially-pushed set still builds every table — matching the export, which
 * emits the literal `0` for a neutral channel.
 */
export interface HueCurveLuts {
  hue: Float64Array;
  sat: Float64Array;
  lum: Float64Array;
}

/**
 * Build the per-hue LUTs. Called once per grade application (frame), never
 * per pixel — the preview's `applyGradeToRgba` builds them once and hands the
 * same tables to every pixel. Returns undefined for neutral hue curves so the
 * caller skips the stage entirely, like the kernel's `isIdentity` guard.
 */
export function buildHueCurveLuts(curves: HueCurves | undefined): HueCurveLuts | undefined {
  const clean = sanitizeHueCurves(curves);
  if (!clean) return undefined;
  const table = (channel: HueCurveChannel, scale: (e: number) => number): Float64Array => {
    const lut = new Float64Array(HUE_CURVE_LUT_WIDTH);
    for (let i = 0; i < HUE_CURVE_LUT_WIDTH; i += 1) {
      lut[i] = scale(evalHueCurve(clean[channel], i / (HUE_CURVE_LUT_WIDTH - 1)));
    }
    return lut;
  };
  return {
    hue: table('hueVsHue', (e) => (e - 0.5) * 2 * HUE_MAX_SHIFT),
    sat: table('hueVsSat', (e) => (e - 0.5) * 2),
    lum: table('hueVsLum', (e) => (e - 0.5) * 2 * HUE_MAX_LUM_SHIFT),
  };
}

/** One 8-bit intermediate store, mirroring the export's explicit floors. */
function quantizeHueByte(value: number): number {
  return Math.floor(value * 255);
}

/**
 * Hue curves on one RGB pixel (integers in, integers out) — a port of
 * upstream's HueCurves.metal through the same three stages the export chain
 * runs: RGB→HSV, LUT lookups plus the saturation gate, HSV→RGB with the byte
 * store. The stages communicate in explicitly floored bytes on both sides, so
 * the geq store mode cannot matter; the stored hue byte doubles as the LUT
 * index (0..253 — a fract is always below 1), so no re-quantization idiom is
 * needed to agree with the export.
 */
export function hueCurvesPixel(
  r: number,
  g: number,
  b: number,
  luts: HueCurveLuts,
): [number, number, number] {
  const [h, s, v] = rgb2hsv(r / 255, g / 255, b / 255);
  const hb = quantizeHueByte(h - Math.floor(h));
  const sb = quantizeHueByte(s);
  const vb = quantizeHueByte(v);
  const hq = hb / 255;
  const sq = sb / 255;
  const vq = vb / 255;
  const t = Math.min(Math.max((sq - HUE_GATE_LOW) / HUE_GATE_WIDTH, 0), 1);
  const gate = t * t * (3 - 2 * t);
  const h2 = hq + luts.hue[hb] * gate;
  const s2 = Math.min(Math.max(sq * (1 + luts.sat[hb] * gate), 0), 1);
  const v2 = Math.min(Math.max(vq + luts.lum[hb] * gate, 0), 1);
  const h2b = quantizeHueByte(h2 - Math.floor(h2));
  const s2b = quantizeHueByte(s2);
  const v2b = quantizeHueByte(v2);
  const [r2, g2, b2] = hsv2rgb(h2b / 255, s2b / 255, v2b / 255);
  return [truncByte(r2 * 255), truncByte(g2 * 255), truncByte(b2 * 255)];
}

/**
 * White-balance channel gains for a Kelvin temperature and green-magenta
 * tint (upstream #157 Tone: 2000-11000K, default 6500; tint -100..+100).
 *
 * Temperature follows the standard Tanner Helland Kelvin-to-RGB
 * approximation, normalized so 6500K is exactly identity; tint pushes
 * magenta (+) by lifting red/blue against green, or green (−) the reverse.
 * The tint coefficient is this port's mapping (Apple's CI filter is closed),
 * documented here rather than hidden: preview and export share this one
 * function, so whatever look it defines, both render identically.
 */
export function whiteBalanceGains(temperatureKelvin: number, tint: number): [number, number, number] {
  const toRgb = (kelvin: number): [number, number, number] => {
    const temp = Math.min(11000, Math.max(2000, kelvin)) / 100;
    const r = temp <= 66 ? 255 : 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    const g = temp <= 66
      ? 99.4708025861 * Math.log(temp) - 161.1195681661
      : 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    const b = temp >= 66 ? 255 : temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
    const clamp = (v: number): number => Math.min(255, Math.max(0, v));
    return [clamp(r), clamp(g), clamp(b)];
  };
  const [neutralR, neutralG, neutralB] = toRgb(6500);
  const [r, g, b] = toRgb(temperatureKelvin);
  const tintFactor = tint / 100;
  return [
    (neutralR / r) * (1 + tintFactor * 0.25),
    (neutralG / g) * (1 - tintFactor * 0.25),
    (neutralB / b) * (1 + tintFactor * 0.25),
  ];
}

/**
 * Combined per-channel gains: exposure times white balance. One triple feeds
 * both the preview pixel pass and the export geq expression.
 */
export function channelGains(
  grade: Pick<ColorGrade, 'exposure' | 'temperature' | 'tint'>,
): [number, number, number] {
  // Absent counts as default: callers pass partial grades, and NaN gains
  // would poison both the pixel pass and the export expression.
  const ev = grade.exposure ? exposureGain(grade.exposure) : 1;
  const temperature = grade.temperature ?? 6500;
  const tint = grade.tint ?? 0;
  const [wr, wg, wb] = temperature === 6500 && tint === 0
    ? [1, 1, 1]
    : whiteBalanceGains(temperature, tint);
  return [ev * wr, ev * wg, ev * wb];
}

/**
 * Per-pixel grade math for the live preview (upstream #157).
 *
 * The preview paints raw composited pixels, so grades ride an explicit pass
 * (see applyGradeToRgba) using the same YUV math the export filters perform —
 * full-range BT.601, eq gains about center 128, hue rotation in the UV plane,
 * per-plane negate — rather than CSS filters, which cannot express it.
 */

/** BT.601 full-range forward coefficients. */
const KR = 0.299;
const KG = 0.587;
const KB = 0.114;

/** Chroma offsets for the centered representation FFmpeg uses. */
const CENTER = 128;

function clampByte(value: number): number {
  // Explicit clamp: plain Uint8Array/Buffer assignment wraps modulo 256
  // instead of clamping, so an unclamped bright pixel would come back black.
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

/**
 * Grade one RGB pixel through the YUV pipeline, returning [r, g, b].
 *
 * Exported for tests: the parity proof is hand-computed values from the
 * documented formulas, not agreement between two implementations of the same
 * code.
 */
export function gradePixel(
  r: number,
  g: number,
  b: number,
  grade: Pick<ColorGrade, 'brightness' | 'contrast' | 'saturation' | 'hueRotation' | 'exposure' | 'temperature' | 'tint' | 'vibrance' | 'highlights' | 'shadows' | 'blacks' | 'whites' | 'invertColors' | 'curves' | 'wheels' | 'hueCurves' | 'lut'>,
  /** Prebuilt LUTs; callers looping over pixels pass the frame's tables. */
  curveLuts?: GradeCurveLuts,
  /** Prebuilt wheels triplets; callers looping over pixels pass the frame's. */
  wheelsCoeffs?: WheelsCoeffs,
  /** Prebuilt hue LUTs; callers looping over pixels pass the frame's tables. */
  hueCurveLuts?: HueCurveLuts,
  /**
   * Resolved .cube table for the grade's LUT reference (the caller loads it
   * once per frame via the main-process LUT loader). Absent — a missing or
   * unreadable file — skips the LUT stage, degrading to ungraded for it.
   */
  lutData?: CubeLut,
): [number, number, number] {
  // Gain stage first, mirroring the export chain (geq ahead of eq): the
  // combined exposure and white-balance gains on the raw channels, clamped
  // and truncated exactly like the geq expression (C-cast truncation, not
  // rounding).
  const [gainR, gainG, gainB] = channelGains(grade);
  const er = Math.trunc(Math.min(255, Math.max(0, r * gainR)));
  const eg = Math.trunc(Math.min(255, Math.max(0, g * gainG)));
  const eb = Math.trunc(Math.min(255, Math.max(0, b * gainB)));
  // Vibrance right after the gain stage, mirroring the export chain (geq,
  // vibrance, eq): the same function on the same truncated integers.
  let vr = er;
  let vg = eg;
  let vb = eb;
  if (grade.vibrance) {
    [vr, vg, vb] = vibrancePixel(er, eg, eb, grade.vibrance);
  }
  // Tonal controls after vibrance, mirroring the export chain order
  // (upstream lists exposure, contrast, highlights/shadows, then
  // blacks/whites): the same functions on the same truncated integers.
  let tr = vr;
  let tg = vg;
  let tb = vb;
  if (grade.highlights || grade.shadows) {
    [tr, tg, tb] = highlightsShadowsPixel(vr, vg, vb, grade.highlights ?? 0, grade.shadows ?? 0);
  }
  if (grade.blacks || grade.whites) {
    [tr, tg, tb] = blacksWhitesPixel(tr, tg, tb, grade.blacks ?? 0, grade.whites ?? 0);
  }
  // RGB -> YUV601 full range.
  let y = KR * tr + KG * tg + KB * tb;
  let u = -0.168736 * tr - 0.331264 * tg + 0.5 * tb + CENTER;
  let v = 0.5 * tr - 0.418688 * tg - 0.081312 * tb + CENTER;

  // eq luma: contrast about center, then the brightness offset (FFmpeg folds
  // brightness into an additive term applied AFTER contrast scaling).
  y = grade.contrast * (y - CENTER) + CENTER + grade.brightness * 255;
  // eq chroma: saturation gain about center, no brightness term.
  u = CENTER + grade.saturation * (u - CENTER);
  v = CENTER + grade.saturation * (v - CENTER);

  // Tone curves sit after eq and before hue/invert, upstream's slot for
  // color.curves (after saturation, before hue curves/LUT/invert); wheels sit
  // directly ahead of curves, upstream's slot for color.wheels (after
  // saturation, before curves); hue curves sit directly after curves,
  // upstream's slot for color.hueCurves (after curves, before LUT/invert);
  // the LUT sits directly after hue curves, upstream's slot for color.lut
  // (after hue curves, before invert). All four stages work on RGB, so
  // rebuild the pixel first. The rebuilt values are rounded
  // to the byte grid (clampByte, the preview's store convention) rather than
  // truncated: the YUV round trip of an identity eq lands a hair below the
  // original integer, and truncation would hand the wheels/curve stage 15
  // instead of 16. Each stage's own output is truncated, like the geq/lutrgb
  // stores.
  const luts = curveLuts ?? buildGradeCurveLuts(grade.curves);
  const coeffs = wheelsCoeffs ?? buildWheelsCoeffs(grade.wheels);
  const hueLuts = hueCurveLuts ?? buildHueCurveLuts(grade.hueCurves);
  const lutRef = sanitizeLutRef(grade.lut);
  const lutStage = lutData && lutRef && lutRef.intensity > 0
    ? { data: lutData, intensity: lutRef.intensity }
    : undefined;
  if (coeffs || luts || hueLuts || lutStage) {
    const pr = y + 1.402 * (v - CENTER);
    const pg = y - 0.344136 * (u - CENTER) - 0.714136 * (v - CENTER);
    const pb = y + 1.772 * (u - CENTER);
    const [wr, wg, wb] = coeffs
      ? wheelsPixel(clampByte(pr), clampByte(pg), clampByte(pb), coeffs)
      : [clampByte(pr), clampByte(pg), clampByte(pb)];
    const [cr, cg, cb] = luts ? gradeCurvePixel(wr, wg, wb, luts) : [wr, wg, wb];
    const [hr, hg, hb] = hueLuts ? hueCurvesPixel(cr, cg, cb, hueLuts) : [cr, cg, cb];
    const [lr, lg, lb] = lutStage ? lutPixel(hr, hg, hb, lutStage.data, lutStage.intensity) : [hr, hg, hb];
    if (grade.hueRotation === 0 && !grade.invertColors) return [lr, lg, lb];
    // Back to centered YUV for the filters that follow the LUT in the
    // export chain (hue, then negate).
    y = KR * lr + KG * lg + KB * lb;
    u = -0.168736 * lr - 0.331264 * lg + 0.5 * lb + CENTER;
    v = 0.5 * lr - 0.418688 * lg - 0.081312 * lb + CENTER;
  }

  // hue filter: counter-clockwise rotation in the centered UV plane.
  if (grade.hueRotation !== 0) {
    const rad = (grade.hueRotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const uc = u - CENTER;
    const vc = v - CENTER;
    u = cos * uc - sin * vc + CENTER;
    v = sin * uc + cos * vc + CENTER;
  }

  // negate: straight per-plane flip, alpha untouched (there is no alpha here).
  if (grade.invertColors) {
    y = 255 - y;
    u = 255 - u;
    v = 255 - v;
  }

  // YUV601 full range back to RGB.
  const rr = y + 1.402 * (v - CENTER);
  const gg = y - 0.344136 * (u - CENTER) - 0.714136 * (v - CENTER);
  const bb = y + 1.772 * (u - CENTER);
  return [clampByte(rr), clampByte(gg), clampByte(bb)];
}

/**
 * Apply a grade to an RGBA buffer in place, skipping alpha.
 *
 * Accepts any byte array because call sites hold Buffers (main) while tests
 * hold Uint8ClampedArrays; both index and assign the same way once values
 * are pre-clamped (see clampByte).
 */
export function applyGradeToRgba(
  data: Uint8Array | Uint8ClampedArray,
  grade: Pick<ColorGrade, 'brightness' | 'contrast' | 'saturation' | 'hueRotation' | 'exposure' | 'temperature' | 'tint' | 'vibrance' | 'highlights' | 'shadows' | 'blacks' | 'whites' | 'invertColors' | 'curves' | 'wheels' | 'hueCurves' | 'lut'>,
  /** Resolved .cube table for the grade's LUT reference (one load per frame, never per pixel). */
  lutData?: CubeLut,
): void {
  // One LUT build, one wheels-coefficient build and one hue-LUT build per
  // frame (upstream caches the tables per curve set), never per pixel: the
  // same tables are handed to every gradePixel call below. The .cube table
  // itself arrives pre-resolved (a missing file degrades to ungraded for the
  // LUT stage, decided by the caller, not here).
  const curveLuts = buildGradeCurveLuts(grade.curves);
  const wheelsCoeffs = buildWheelsCoeffs(grade.wheels);
  const hueCurveLuts = buildHueCurveLuts(grade.hueCurves);
  for (let i = 0; i + 4 <= data.length; i += 4) {
    const [r, g, b] = gradePixel(data[i], data[i + 1], data[i + 2], grade, curveLuts, wheelsCoeffs, hueCurveLuts, lutData);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

/** True when any field differs from default — used to skip no-op work. */
export function hasColorGrade(clip: Clip): boolean {
  return clip.brightness !== undefined || clip.contrast !== undefined
    || clip.saturation !== undefined || clip.hueRotation !== undefined
    || clip.exposure !== undefined || clip.temperature !== undefined
    || clip.tint !== undefined || clip.vibrance !== undefined
    || clip.highlights !== undefined || clip.shadows !== undefined
    || clip.blacks !== undefined || clip.whites !== undefined
    || clip.invertColors !== undefined || clip.curves !== undefined || clip.wheels !== undefined || clip.hueCurves !== undefined || clip.lut !== undefined;
}
