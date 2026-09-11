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

export interface ColorGrade {
  brightness: number;
  contrast: number;
  saturation: number;
  hueRotation: number;
  exposure: number;
  temperature: number;
  tint: number;
  vibrance: number;
  invertColors?: boolean;
}

const DEFAULTS: ColorGrade = { brightness: 0, contrast: 1, saturation: 1, hueRotation: 0, exposure: 0, temperature: 6500, tint: 0, vibrance: 0, invertColors: false };

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
  return out;
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
 * bound. Unknown grade fields are stripped by `sanitizeColorGrade`.
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
    if (Object.keys(grade).length === 0) continue;
    byId.set(candidate.id, { id: candidate.id, label, grade });
    if (byId.size >= MAX_USER_GRADE_PRESETS) break;
  }
  return [...byId.values()];
}

/** Extract non-default color fields from a clip; null when no grading. */
export function colorGradeOf(clip: Clip): ColorGrade | null {
  const grade: ColorGrade = {
    brightness: clip.brightness ?? DEFAULTS.brightness,
    contrast: clip.contrast ?? DEFAULTS.contrast,
    saturation: clip.saturation ?? DEFAULTS.saturation,
    hueRotation: clip.hueRotation ?? DEFAULTS.hueRotation,
    exposure: clip.exposure ?? DEFAULTS.exposure,
    temperature: clip.temperature ?? DEFAULTS.temperature,
    tint: clip.tint ?? DEFAULTS.tint,
    vibrance: clip.vibrance ?? DEFAULTS.vibrance,
    invertColors: clip.invertColors ?? DEFAULTS.invertColors,
  };
  return isDefaultGrade(grade) ? null : grade;
}

function isDefaultGrade(g: ColorGrade): boolean {
  return g.brightness === 0 && g.contrast === 1 && g.saturation === 1 && g.hueRotation === 0 && g.exposure === 0 && g.temperature === 6500 && g.tint === 0 && g.vibrance === 0 && !g.invertColors;
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
 * The export color chain for a clip, in application order: exposure gain,
 * then eq, then hue rotation, then invert — the same order the preview pass
 * and CSS apply, so no backend disagrees about which transform sees which
 * pixels. Each entry is one FFmpeg filter; the caller joins them with ','.
 */
export function toFfmpegColorChain(grade: ColorGrade): string[] {
  const chain: string[] = [];
  // Truthy field checks, not !== default: callers pass partial grades, and
  // an absent field is unset rather than default — both skip the segment.
  const [gr, gg, gb] = channelGains(grade);
  if (gr !== 1 || gg !== 1 || gb !== 1) {
    const gain = (v: number): string => v.toFixed(6);
    // geq neither clips nor preserves alpha on its own: clamp explicitly
    // (unclamped gains wrap past ~170) and carry alpha through untouched.
    const channel = (c: 'r' | 'g' | 'b', v: number): string =>
      `min(max(${c}(X,Y)*${gain(v)},0),255)`;
    chain.push(`geq=r='${channel('r', gr)}':g='${channel('g', gg)}':b='${channel('b', gb)}':a='a(X,Y)'`);
  }
  // Truthy like the gain gate: absent counts as unset. Luma weights ride
  // explicitly because several shipped FFmpeg releases carry them swapped.
  if (grade.vibrance) {
    chain.push(
      `vibrance=${grade.vibrance}:rlum=${VIBRANCE_LUMA_R}:glum=${VIBRANCE_LUMA_G}:blum=${VIBRANCE_LUMA_B}`,
    );
  }
  const eq = toFfmpegEq(grade);
  if (eq) chain.push(eq);
  if (grade.hueRotation !== 0) chain.push(`hue=h=${grade.hueRotation.toFixed(1)}`);
  if (grade.invertColors) chain.push('negate');
  return chain;
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
  grade: Pick<ColorGrade, 'brightness' | 'contrast' | 'saturation' | 'hueRotation' | 'exposure' | 'temperature' | 'tint' | 'vibrance' | 'invertColors'>,
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
  // RGB -> YUV601 full range.
  let y = KR * vr + KG * vg + KB * vb;
  let u = -0.168736 * vr - 0.331264 * vg + 0.5 * vb + CENTER;
  let v = 0.5 * vr - 0.418688 * vg - 0.081312 * vb + CENTER;

  // eq luma: contrast about center, then the brightness offset (FFmpeg folds
  // brightness into an additive term applied AFTER contrast scaling).
  y = grade.contrast * (y - CENTER) + CENTER + grade.brightness * 255;
  // eq chroma: saturation gain about center, no brightness term.
  u = CENTER + grade.saturation * (u - CENTER);
  v = CENTER + grade.saturation * (v - CENTER);

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
  grade: Pick<ColorGrade, 'brightness' | 'contrast' | 'saturation' | 'hueRotation' | 'exposure' | 'temperature' | 'tint' | 'vibrance' | 'invertColors'>,
): void {
  for (let i = 0; i + 4 <= data.length; i += 4) {
    const [r, g, b] = gradePixel(data[i], data[i + 1], data[i + 2], grade);
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
    || clip.invertColors !== undefined;
}
