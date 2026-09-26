/**
 * Effects subgroups (upstream #157: Detail, Blur, Vignette, Film Grain,
 * Glow).
 *
 * Only effects whose math maps exactly onto an FFmpeg filter are modeled
 * here — preview and export must agree, so an effect without a provable
 * counterpart is left out rather than faked (see the per-effect notes).
 *
 * Shipped (all verified against FFmpeg 8.1.2, see the tests):
 * - Gaussian Blur (`blurRadius` 0..100): upstream `blur.gaussian`
 *   (CIGaussianBlur radius) renders through FFmpeg `gblur` (Getreuer IIR,
 *   `sigma = radius`) while the preview runs the same recurrence in
 *   doubles. Apple's exact kernel is closed, so the radius mapping is a
 *   documented convention: both sides share it, so they agree with each
 *   other.
 * - Vignette (upstream `stylize.vignette`): the superellipse + smoothstep +
 *   multiplicative-gain math ported verbatim into a `geq` filter and the
 *   preview. FFmpeg's own `vignette` filter is rejected: angle-only model,
 *   no amount/midpoint/roundness/feather, dithering on by default.
 * - Film Grain (upstream `stylize.grain`): the hash13 + luma-mask math
 *   ported verbatim into a `geq` filter (frame counter `N`, clip-local like
 *   upstream's atOffset) and the preview. FFmpeg's `noise` filter is
 *   rejected: different PRNG, nondeterministic across runs.
 * - Glow (upstream `stylize.glow`): threshold + warmth tint (`geq`), blur
 *   (`gblur`), intensity scale (`geq`), screen blend (`blend` in screen
 *   mode, whose exact math is `255 - (255-A)(255-B)//255` — verified).
 *
 * Left out, with reasons:
 * - Clarity / Dehaze (`detail.clarity`): unsharp-against-gaussian-radius-
 *   max(W,H)/40 plus a dark-channel-prior dehaze trio. FFmpeg `unsharp`
 *   uses a fixed binomial/16 kernel (probed), caps its matrix at 63
 *   (a 4K frame needs ~109), and forces a YUV roundtrip on RGB input;
 *   nothing composes the dehaze math. No exact recipe exists.
 * - Sharpen (`blur.sharpen`, CISharpenLuminance): closed Apple kernel;
 *   `unsharp` is the wrong kernel on a YUV detour (same probe).
 * - Noise Reduction (`blur.noiseReduction`, CINoiseReduction): closed
 *   Apple algorithm; hqdn3d/nlmeans/atadenoise are different algorithms.
 * - Motion Blur (`blur.motion`): temporal accumulation; single-frame
 *   preview/export cannot produce it without faking.
 *
 * Pipeline slot (upstream `EffectRegistry.canonicalOrder`): blurs run after
 * the grade and before invert, grain/vignette/glow after invert. Both
 * backends apply all four effects after the full color chain including
 * invert: blur-then-invert vs invert-then-blur differ only by float
 * rounding (the IIR blur is linear and DC-preserving, invert is affine, and
 * neither stage clips in-range values), while grain/vignette/glow keep
 * their canonical post-invert order on both sides, where order genuinely
 * matters (pinned by tests).
 */

import type { Clip } from '../types/project';

// ─── Model ───────────────────────────────────────────────────────────────────

/** Vignette (upstream `stylize.vignette` params verbatim). */
export interface Vignette {
  /** Edge gain -1 (darken) .. +1 (lighten). 0 = identity. */
  amount: number;
  /** Where the falloff starts, 0..1. */
  midpoint: number;
  /** Shape morph: -1 rectangular .. +1 round. */
  roundness: number;
  /** Falloff width, 0..1. */
  feather: number;
}

/** Glow / halation (upstream `stylize.glow` params verbatim). */
export interface Glow {
  /** Screen-blend strength, 0..1. 0 = identity. */
  intensity: number;
  /** Highlight-bleed blur radius in px, 0..100. */
  radius: number;
  /** Luma threshold isolating highlights, 0..<1. */
  threshold: number;
  /** Warm red-orange cast on the bleed, 0..1. */
  warmth: number;
}

/** Film grain (upstream `stylize.grain` params verbatim). */
export interface Grain {
  /** Noise strength, 0..1. 0 = identity. */
  amount: number;
  /** Grain cell size in px, 0.5..4. */
  size: number;
}

/** Registry defaults (upstream `EffectRegistry` defaultValue verbatim). */
export const DEFAULT_VIGNETTE: Vignette = { amount: 0, midpoint: 0.5, roundness: 0, feather: 0.5 };
export const DEFAULT_GLOW: Glow = { intensity: 0, radius: 20, threshold: 0.6, warmth: 0 };
export const DEFAULT_GRAIN: Grain = { amount: 0, size: 1.5 };

/** Validation bounds (upstream `EffectRegistry` ranges verbatim, exported for UI + agent). */
export const EFFECT_LIMITS = {
  blurRadius: { min: 0, max: 100 },
  vignette: {
    amount: { min: -1, max: 1 },
    midpoint: { min: 0, max: 1 },
    roundness: { min: -1, max: 1 },
    feather: { min: 0, max: 1 },
  },
  glow: {
    intensity: { min: 0, max: 1 },
    radius: { min: 0, max: 100 },
    threshold: { min: 0, max: 1 },
    warmth: { min: 0, max: 1 },
  },
  grain: {
    amount: { min: 0, max: 1 },
    size: { min: 0.5, max: 4 },
  },
} as const;

function inRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value >= min && value <= max ? value : undefined;
}

/**
 * Narrow an untrusted vignette: invalid components fall back to their
 * default (the wheels sanitizer's rule), and an amount of 0 is identity —
 * upstream's kernel guard `amount != 0` — so the whole field drops.
 */
export function sanitizeVignette(input: unknown): Vignette | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const c = input as Record<string, unknown>;
  const L = EFFECT_LIMITS.vignette;
  const vignette: Vignette = {
    amount: inRange(c.amount, L.amount.min, L.amount.max) ?? DEFAULT_VIGNETTE.amount,
    midpoint: inRange(c.midpoint, L.midpoint.min, L.midpoint.max) ?? DEFAULT_VIGNETTE.midpoint,
    roundness: inRange(c.roundness, L.roundness.min, L.roundness.max) ?? DEFAULT_VIGNETTE.roundness,
    feather: inRange(c.feather, L.feather.min, L.feather.max) ?? DEFAULT_VIGNETTE.feather,
  };
  return vignette.amount === 0 ? undefined : vignette;
}

/**
 * Narrow an untrusted glow: invalid components fall back to default, and an
 * intensity of 0 is identity (upstream's `intensity > 0` guard), dropping
 * the field. A threshold of exactly 1.0 would make the smoothstep edge
 * degenerate (Metal-UB upstream); it narrows to 0.999, an invisible step
 * down that keeps the isolation well-defined on both backends.
 */
export function sanitizeGlow(input: unknown): Glow | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const c = input as Record<string, unknown>;
  const L = EFFECT_LIMITS.glow;
  const threshold = inRange(c.threshold, L.threshold.min, L.threshold.max) ?? DEFAULT_GLOW.threshold;
  const glow: Glow = {
    intensity: inRange(c.intensity, L.intensity.min, L.intensity.max) ?? DEFAULT_GLOW.intensity,
    radius: inRange(c.radius, L.radius.min, L.radius.max) ?? DEFAULT_GLOW.radius,
    threshold: threshold >= 1 ? 0.999 : threshold,
    warmth: inRange(c.warmth, L.warmth.min, L.warmth.max) ?? DEFAULT_GLOW.warmth,
  };
  return glow.intensity === 0 ? undefined : glow;
}

/**
 * Narrow an untrusted grain: invalid components fall back to default, and
 * an amount of 0 is identity (upstream's `amount > 0` guard), dropping the
 * field.
 */
export function sanitizeGrain(input: unknown): Grain | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const c = input as Record<string, unknown>;
  const L = EFFECT_LIMITS.grain;
  const grain: Grain = {
    amount: inRange(c.amount, L.amount.min, L.amount.max) ?? DEFAULT_GRAIN.amount,
    size: inRange(c.size, L.size.min, L.size.max) ?? DEFAULT_GRAIN.size,
  };
  return grain.amount === 0 ? undefined : grain;
}

/** Narrow an untrusted blur radius: out-of-range or 0 (off) drops the field. */
export function sanitizeBlurRadius(input: unknown): number | undefined {
  const L = EFFECT_LIMITS.blurRadius;
  const value = inRange(input, L.min, L.max);
  return value === undefined || value === 0 ? undefined : value;
}

/** Structural equality on sanitized values (undefined = identity). */
export function vignettesEqual(a: Vignette | undefined, b: Vignette | undefined): boolean {
  const x = sanitizeVignette(a);
  const y = sanitizeVignette(b);
  if (x === undefined || y === undefined) return x === y;
  return x.amount === y.amount && x.midpoint === y.midpoint
    && x.roundness === y.roundness && x.feather === y.feather;
}

export function glowsEqual(a: Glow | undefined, b: Glow | undefined): boolean {
  const x = sanitizeGlow(a);
  const y = sanitizeGlow(b);
  if (x === undefined || y === undefined) return x === y;
  return x.intensity === y.intensity && x.radius === y.radius
    && x.threshold === y.threshold && x.warmth === y.warmth;
}

export function grainsEqual(a: Grain | undefined, b: Grain | undefined): boolean {
  const x = sanitizeGrain(a);
  const y = sanitizeGrain(b);
  if (x === undefined || y === undefined) return x === y;
  return x.amount === y.amount && x.size === y.size;
}

/** The clip's active effects: every sanitized non-identity stage. */
export interface ClipEffects {
  blurRadius?: number;
  vignette?: Vignette;
  grain?: Grain;
  glow?: Glow;
}

/**
 * Extract the active effects from a clip; null when no effect stage applies.
 * File existence plays no role here (no file-backed effects exist), so this
 * is a pure shape check like `colorGradeOf`.
 */
export function effectsOf(clip: Clip): ClipEffects | null {
  const blurRadius = sanitizeBlurRadius(clip.blurRadius);
  const vignette = sanitizeVignette(clip.vignette);
  const grain = sanitizeGrain(clip.grain);
  const glow = sanitizeGlow(clip.glow);
  if (blurRadius === undefined && vignette === undefined && grain === undefined && glow === undefined) {
    return null;
  }
  return {
    ...(blurRadius !== undefined ? { blurRadius } : {}),
    ...(vignette ? { vignette } : {}),
    ...(grain ? { grain } : {}),
    ...(glow ? { glow } : {}),
  };
}

/** True when any effect stage differs from identity — used to skip no-op work. */
export function hasEffects(clip: Clip): boolean {
  return effectsOf(clip) !== null;
}

/**
 * Narrow the effect fields of an untrusted grade/preset/clip object, keeping
 * only sanitized non-identity stages. Powers the preset normalizer and the
 * transfer clone so both reuse the one validation rule.
 */
export function sanitizeClipEffects(input: unknown): ClipEffects {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const c = input as { blurRadius?: unknown; vignette?: unknown; grain?: unknown; glow?: unknown };
  const out: ClipEffects = {};
  const blurRadius = sanitizeBlurRadius(c.blurRadius);
  if (blurRadius !== undefined) out.blurRadius = blurRadius;
  const vignette = sanitizeVignette(c.vignette);
  if (vignette) out.vignette = vignette;
  const grain = sanitizeGrain(c.grain);
  if (grain) out.grain = grain;
  const glow = sanitizeGlow(c.glow);
  if (glow) out.glow = glow;
  return out;
}

/** Structural equality on sanitized effects (absent = identity). */
export function clipEffectsEqual(a: ClipEffects | undefined, b: ClipEffects | undefined): boolean {
  const x = Object.keys(sanitizeClipEffects(a)).length === 0 ? undefined : sanitizeClipEffects(a);
  const y = Object.keys(sanitizeClipEffects(b)).length === 0 ? undefined : sanitizeClipEffects(b);
  if (x === undefined || y === undefined) return x === y;
  return (x.blurRadius ?? null) === (y.blurRadius ?? null)
    && vignettesEqual(x.vignette, y.vignette)
    && grainsEqual(x.grain, y.grain)
    && glowsEqual(x.glow, y.glow);
}

// ─── Strict agent patches (refuse, don't reshape) ────────────────────────────

export type VignettePatch = Partial<Vignette>;
export type GlowPatch = Partial<Glow>;
export type GrainPatch = Partial<Grain>;

type PatchResult<T> = { ok: true; patch: T } | { ok: false; error: string };

function patchError(type: string, field: string, range: string): string {
  return `${type}.${field} must be between ${range}.`;
}

/**
 * Strict parse of the agent's `vignette` argument. Unlike `sanitizeVignette`,
 * which falls back to defaults, this refuses the whole call on the first
 * malformed component. An empty object yields an empty patch (the tool
 * schema refuses it as "pass at least one grade field").
 */
export function parseVignettePatch(input: unknown): PatchResult<VignettePatch> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'vignette must be an {amount, midpoint, roundness, feather} object.' };
  }
  const c = input as Record<string, unknown>;
  const L = EFFECT_LIMITS.vignette;
  const patch: VignettePatch = {};
  if (c.amount !== undefined) {
    const v = inRange(c.amount, L.amount.min, L.amount.max);
    if (v === undefined) return { ok: false, error: patchError('vignette', 'amount', '-1 and 1') };
    patch.amount = v;
  }
  if (c.midpoint !== undefined) {
    const v = inRange(c.midpoint, L.midpoint.min, L.midpoint.max);
    if (v === undefined) return { ok: false, error: patchError('vignette', 'midpoint', '0 and 1') };
    patch.midpoint = v;
  }
  if (c.roundness !== undefined) {
    const v = inRange(c.roundness, L.roundness.min, L.roundness.max);
    if (v === undefined) return { ok: false, error: patchError('vignette', 'roundness', '-1 and 1') };
    patch.roundness = v;
  }
  if (c.feather !== undefined) {
    const v = inRange(c.feather, L.feather.min, L.feather.max);
    if (v === undefined) return { ok: false, error: patchError('vignette', 'feather', '0 and 1') };
    patch.feather = v;
  }
  return { ok: true, patch };
}

/** Strict parse of the agent's `glow` argument (same contract as vignette). */
export function parseGlowPatch(input: unknown): PatchResult<GlowPatch> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'glow must be an {intensity, radius, threshold, warmth} object.' };
  }
  const c = input as Record<string, unknown>;
  const L = EFFECT_LIMITS.glow;
  const patch: GlowPatch = {};
  if (c.intensity !== undefined) {
    const v = inRange(c.intensity, L.intensity.min, L.intensity.max);
    if (v === undefined) return { ok: false, error: patchError('glow', 'intensity', '0 and 1') };
    patch.intensity = v;
  }
  if (c.radius !== undefined) {
    const v = inRange(c.radius, L.radius.min, L.radius.max);
    if (v === undefined) return { ok: false, error: patchError('glow', 'radius', '0 and 100') };
    patch.radius = v;
  }
  if (c.threshold !== undefined) {
    const v = inRange(c.threshold, L.threshold.min, L.threshold.max);
    if (v === undefined) return { ok: false, error: patchError('glow', 'threshold', '0 and 1') };
    patch.threshold = v;
  }
  if (c.warmth !== undefined) {
    const v = inRange(c.warmth, L.warmth.min, L.warmth.max);
    if (v === undefined) return { ok: false, error: patchError('glow', 'warmth', '0 and 1') };
    patch.warmth = v;
  }
  return { ok: true, patch };
}

/** Strict parse of the agent's `grain` argument (same contract as vignette). */
export function parseGrainPatch(input: unknown): PatchResult<GrainPatch> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'grain must be an {amount, size} object.' };
  }
  const c = input as Record<string, unknown>;
  const L = EFFECT_LIMITS.grain;
  const patch: GrainPatch = {};
  if (c.amount !== undefined) {
    const v = inRange(c.amount, L.amount.min, L.amount.max);
    if (v === undefined) return { ok: false, error: patchError('grain', 'amount', '0 and 1') };
    patch.amount = v;
  }
  if (c.size !== undefined) {
    const v = inRange(c.size, L.size.min, L.size.max);
    if (v === undefined) return { ok: false, error: patchError('grain', 'size', '0.5 and 4') };
    patch.size = v;
  }
  return { ok: true, patch };
}

// ─── Preview math ────────────────────────────────────────────────────────────

/** Truncate toward zero and clamp to a byte, mirroring the export store path. */
function truncByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.trunc(value);
}

/** Round-half-to-even, mirroring FFmpeg's `lrintf` store after `gblur`. */
export function roundHalfEven(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5 || diff > 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

function clampByteRint(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return roundHalfEven(value);
}

/**
 * Vignette on one RGB pixel — a port of `Metal/Vignette.metal`: the
 * superellipse distance in normalized frame coords (integer pixel indices,
 * matching the export `geq` X/Y), the smoothstep falloff, and the
 * hue-preserving multiplicative gain, truncated like the geq store.
 */
export function vignettePixel(
  r: number,
  g: number,
  b: number,
  x: number,
  y: number,
  width: number,
  height: number,
  vignette: Vignette,
): [number, number, number] {
  const hx = Math.max(width / 2, 1);
  const hy = Math.max(height / 2, 1);
  const dx = (x - width / 2) / hx;
  const dy = (y - height / 2) / hy;
  const p = 6 + (2 - 6) * ((vignette.roundness + 1) / 2);
  const dist = Math.pow(Math.pow(Math.abs(dx), p) + Math.pow(Math.abs(dy), p), 1 / p);
  const e0 = vignette.midpoint;
  const e1 = vignette.midpoint + vignette.feather * 1.5 + 0.05;
  const t = Math.min(1, Math.max(0, (dist - e0) / (e1 - e0)));
  const s = t * t * (3 - 2 * t);
  const gain = 1 + vignette.amount * s;
  return [truncByte(r * gain), truncByte(g * gain), truncByte(b * gain)];
}

/** Upstream `Grain.metal` hash13 in doubles (fract via x - floor(x)). */
export function grainHash(x: number, y: number, frame: number): number {
  const frac = (v: number): number => v - Math.floor(v);
  let px = frac(x * 0.1031);
  let py = frac(y * 0.1031);
  let pz = frac(frame * 0.1031);
  const d = px * (pz + 31.32) + py * (py + 31.32) + pz * (px + 31.32);
  px += d;
  py += d;
  pz += d;
  return frac((px + py) * pz);
}

/**
 * Film grain on one RGB pixel — a port of `Metal/Grain.metal`:
 * monochromatic position+frame-seeded noise (`hash13` of the integer pixel
 * index over size, matching the export `geq` X/Y/N), strongest in the
 * mid-tones via the 4y(1-y) luma mask, truncated like the geq store.
 */
export function grainPixel(
  r: number,
  g: number,
  b: number,
  x: number,
  y: number,
  grain: Grain,
  frame: number,
): [number, number, number] {
  const size = Math.max(grain.size, 0.5);
  const n = grainHash(x / size, y / size, frame) - 0.5;
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const mask = 4 * luma * (1 - luma);
  const delta = n * grain.amount * 0.35 * mask * 255;
  return [truncByte(r + delta), truncByte(g + delta), truncByte(b + delta)];
}

/**
 * Getreuer IIR gaussian parameters for one `gblur` pass (`steps = 1`,
 * FFmpeg `vf_gblur.c:set_params` in doubles): the recurrence pole `nu`,
 * the DC-restoring postscale, and the edge-conditioning boundary scale.
 * Export emits `gblur=sigma=R` with default steps, and the preview runs
 * this same recurrence, so both sides blur identically.
 */
export function gblurParams(sigma: number): { nu: number; postscale: number; boundaryscale: number } {
  const lambda = (sigma * sigma) / 2;
  const nu = (1 + 2 * lambda - Math.sqrt(1 + 4 * lambda)) / (2 * lambda);
  return {
    nu,
    postscale: Math.pow(nu / lambda, 1),
    boundaryscale: 1 / (1 - nu),
  };
}

/**
 * One plane through the Getreuer recurrence FFmpeg's `gblur` runs
 * (`vf_gblur_init.h`, float version): causal then anticausal passes
 * horizontally and vertically with the boundary conditioning, then the
 * postscale and clip. Operates in doubles; the caller rounds the store
 * (half-even, like `lrintf`) to match.
 */
export function iirBlurPlane(src: ArrayLike<number>, width: number, height: number, sigma: number): Float64Array {
  const { nu, postscale, boundaryscale } = gblurParams(sigma);
  const buf = Float64Array.from(src);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    buf[row] *= boundaryscale;
    for (let x = 1; x < width; x += 1) buf[row + x] += nu * buf[row + x - 1];
    buf[row + width - 1] *= boundaryscale;
    for (let x = width - 1; x > 0; x -= 1) buf[row + x - 1] += nu * buf[row + x];
  }
  for (let x = 0; x < width; x += 1) {
    buf[x] *= boundaryscale;
    for (let y = 1; y < height; y += 1) buf[y * width + x] += nu * buf[(y - 1) * width + x];
    buf[(height - 1) * width + x] *= boundaryscale;
    for (let y = height - 1; y > 0; y -= 1) buf[(y - 1) * width + x] += nu * buf[y * width + x];
  }
  // One postscale per axis (`postscale * postscaleV` in vf_gblur.c): each
  // directional pass carries half the DC normalization.
  const total = postscale * postscale;
  for (let i = 0; i < buf.length; i += 1) {
    buf[i] = Math.min(255, Math.max(0, buf[i] * total));
  }
  return buf;
}

/**
 * Screen blend of two bytes — FFmpeg `blend=all_mode=screen` evaluated in
 * integers (`255 - (255-A)(255-B)//255`, verified against 8.1.2), so this
 * is bit-exact, not approximate.
 */
export function screenBlend(a: number, b: number): number {
  return 255 - Math.floor(((255 - a) * (255 - b)) / 255);
}

/**
 * Apply the clip's effects to an RGBA buffer in place, in canonical order
 * (blur, grain, vignette, glow). Alpha is carried through untouched: every
 * upstream kernel preserves source alpha, and effects run ahead of edge
 * rounding, so frames are opaque here exactly like the export chain.
 *
 * `frameOffset` is the clip-local frame (timeline frame minus clip start),
 * driving the animated grain exactly like upstream's atOffset.
 */
export function applyEffectsToRgba(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  effects: ClipEffects | null,
  frameOffset: number,
): void {
  if (!effects || width <= 0 || height <= 0) return;
  if (effects.blurRadius !== undefined) applyBlurToRgba(data, width, height, effects.blurRadius);
  if (effects.grain !== undefined) {
    const { amount, size } = effects.grain;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const [r, g, b] = grainPixel(data[i], data[i + 1], data[i + 2], x, y, { amount, size }, frameOffset);
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
    }
  }
  if (effects.vignette !== undefined) {
    const vignette = effects.vignette;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const [r, g, b] = vignettePixel(data[i], data[i + 1], data[i + 2], x, y, width, height, vignette);
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
    }
  }
  if (effects.glow !== undefined) applyGlowToRgba(data, width, height, effects.glow);
}

/** Gaussian blur on an RGBA buffer (the `blur.gaussian` stage). */
export function applyBlurToRgba(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): void {
  if (radius <= 0 || width <= 0 || height <= 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    const plane = new Float64Array(width * height);
    for (let i = 0; i < width * height; i += 1) plane[i] = data[i * 4 + channel];
    const blurred = iirBlurPlane(plane, width, height, radius);
    for (let i = 0; i < width * height; i += 1) data[i * 4 + channel] = clampByteRint(blurred[i]);
  }
}

/**
 * Glow on an RGBA buffer — the `Metal/Glow.metal` pipeline through the same
 * byte stores the export chain has: threshold + warmth isolation truncated
 * per channel, the radius blur rounded half-even, the intensity scale
 * truncated, then the integer screen blend over the source.
 */
export function applyGlowToRgba(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  glow: Glow,
): void {
  if (glow.intensity <= 0 || width <= 0 || height <= 0) return;
  const count = width * height;
  const hiR = new Float64Array(count);
  const hiG = new Float64Array(count);
  const hiB = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const t = Math.min(1, Math.max(0, (y - glow.threshold) / (1 - glow.threshold)));
    const s = t * t * (3 - 2 * t);
    hiR[i] = truncByte(r * s);
    hiG[i] = truncByte(g * s * (1 - 0.3 * glow.warmth));
    hiB[i] = truncByte(b * s * (1 - 0.55 * glow.warmth));
  }
  const blurred: Array<Float64Array> = [hiR, hiG, hiB].map((plane) => {
    if (glow.radius <= 0) return plane;
    const out = iirBlurPlane(plane, width, height, glow.radius);
    for (let i = 0; i < count; i += 1) out[i] = clampByteRint(out[i]);
    return out;
  });
  for (let i = 0; i < count; i += 1) {
    const g0 = truncByte(Math.min(blurred[0][i] * glow.intensity, 255));
    const g1 = truncByte(Math.min(blurred[1][i] * glow.intensity, 255));
    const g2 = truncByte(Math.min(blurred[2][i] * glow.intensity, 255));
    data[i * 4] = screenBlend(data[i * 4], g0);
    data[i * 4 + 1] = screenBlend(data[i * 4 + 1], g1);
    data[i * 4 + 2] = screenBlend(data[i * 4 + 2], g2);
  }
}

// ─── Export filter emission ──────────────────────────────────────────────────

/** Exact round-trip literal for coordinates the preview holds as doubles. */
function filterLiteral(value: number): string {
  return String(value);
}

/**
 * Gaussian blur as one filter: `gblur` with `sigma = radius` (default single
 * step, matching the preview's one-pass recurrence). `planes=7` blurs color
 * only: the preview never touches alpha (every upstream kernel preserves
 * source alpha, and effects run ahead of edge rounding), so an alpha-blurring
 * export would disagree on transparent sources.
 */
export function toFfmpegBlurFilter(radius: number): string {
  return `gblur=sigma=${filterLiteral(radius)}:planes=7`;
}

/**
 * Film grain as one `geq`: the hash13 + luma-mask math inline per channel
 * (monochromatic — the same hash feeds r, g and b), with the clip-local
 * frame counter `N` exactly where upstream passes atOffset. av_expr
 * evaluates in doubles like the preview, and every store truncates on both
 * sides, so the two agree to the bit modulo float dust.
 */
export function toFfmpegGrainFilter(grain: Grain): string {
  const S = filterLiteral(Math.max(grain.size, 0.5));
  const A = filterLiteral(grain.amount);
  // Fraction helper: av_expr has no fract(), so x - floor(x) throughout.
  const fract = (expr: string): string => `(${expr}-floor(${expr}))`;
  const px = fract(`(X/${S})*0.1031`);
  const py = fract(`(Y/${S})*0.1031`);
  const pz = fract(`(N)*0.1031`);
  const d = `(${px}*((${pz})+31.32)+${py}*((${py})+31.32)+${pz}*((${px})+31.32))`;
  const qx = `(${px}+(${d}))`;
  const qy = `(${py}+(${d}))`;
  const qz = `(${pz}+(${d}))`;
  const n = `(${fract(`((${qx})+(${qy}))*(${qz})`)}-0.5)`;
  const luma = `((0.2126*r(X,Y)+0.7152*g(X,Y)+0.0722*b(X,Y))/255)`;
  const mask = `(4*(${luma})*(1-(${luma})))`;
  const channel = (c: 'r' | 'g' | 'b'): string =>
    `min(max(${c}(X,Y)+(${n})*${A}*0.35*(${mask})*255,0),255)`;
  return `geq=r='${channel('r')}':g='${channel('g')}':b='${channel('b')}':a='alpha(X,Y)'`;
}

/**
 * Vignette as one `geq`: the superellipse distance (integer pixel coords,
 * frame constants W/H, center W/2/H/2), the smoothstep falloff via the
 * T²(3-2T) recipe (av_expr has no smoothstep — the hue gate in the grade
 * chain uses the same recipe), and the multiplicative gain, clamped
 * explicitly like every other geq in the chain.
 */
export function toFfmpegVignetteFilter(vignette: Vignette): string {
  const P = filterLiteral(6 + (2 - 6) * ((vignette.roundness + 1) / 2));
  const E0 = filterLiteral(vignette.midpoint);
  const E1 = filterLiteral(vignette.midpoint + vignette.feather * 1.5 + 0.05);
  const GAIN = filterLiteral(vignette.amount);
  const dx = `((X-W/2)/max(W/2,1))`;
  const dy = `((Y-H/2)/max(H/2,1))`;
  const dist = `(pow(pow(abs(${dx}),${P})+pow(abs(${dy}),${P}),1/${P}))`;
  const t = `(min(max(((${dist})-${E0})/(${E1}-${E0}),0),1))`;
  const s = `((${t})*(${t})*(3-2*(${t})))`;
  const channel = (c: 'r' | 'g' | 'b'): string =>
    `min(max(${c}(X,Y)*(1+${GAIN}*(${s})),0),255)`;
  return `geq=r='${channel('r')}':g='${channel('g')}':b='${channel('b')}':a='alpha(X,Y)'`;
}

/**
 * Glow threshold + warmth isolation as one `geq` (the export branch's first
 * filter): luma-gated highlight isolation with the red-orange halation tint,
 * truncated per channel exactly like the preview's hi store.
 */
export function toFfmpegGlowThresholdFilter(glow: Glow): string {
  const TH = filterLiteral(glow.threshold);
  const W = filterLiteral(glow.warmth);
  const luma = `((0.2126*r(X,Y)+0.7152*g(X,Y)+0.0722*b(X,Y))/255)`;
  const t = `(min(max(((${luma})-${TH})/(1-${TH}),0),1))`;
  const s = `((${t})*(${t})*(3-2*(${t})))`;
  const hi = (c: 'r' | 'g' | 'b', tint: string): string =>
    `min(max(${c}(X,Y)*(${s})*${tint},0),255)`;
  return `geq=r='${hi('r', '1')}':g='${hi('g', `(1-0.3*${W})`)}':b='${hi('b', `(1-0.55*${W})`)}':a='alpha(X,Y)'`;
}

/**
 * Glow intensity scale as one `geq` (the export branch's last filter before
 * the screen blend): upstream's `saturate(glow * intensity)`, truncated
 * like the preview's scale store.
 */
export function toFfmpegGlowScaleFilter(glow: Glow): string {
  const I = filterLiteral(glow.intensity);
  const channel = (c: 'r' | 'g' | 'b'): string => `min(max(${c}(X,Y)*${I},0),255)`;
  return `geq=r='${channel('r')}':g='${channel('g')}':b='${channel('b')}':a='alpha(X,Y)'`;
}

/**
 * Glow screen blend over the un-blurred frame (symmetric — input order is
 * free). Alpha is NOT screened: `c3_mode=normal` with `c3_opacity=0` passes
 * the source alpha straight through (verified: the top-times-zero plus
 * bottom-times-one blend yields the bottom), matching the preview and
 * upstream, which both preserve source alpha.
 */
export function toFfmpegGlowBlendFilter(glowLabel: string, sourceLabel: string, outLabel: string): string {
  return `[${glowLabel}][${sourceLabel}]blend=all_mode='screen':c3_mode='normal':c3_opacity=0[${outLabel}]`;
}
