/**
 * Effects subgroups coverage (upstream #157: blur, vignette, grain, glow):
 * model/sanitize with identity rules, strict agent patches, preview math
 * with pinned values (each verified against FFmpeg 8.1.2 — see comments),
 * and filter emission.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLARITY,
  DEFAULT_GLOW,
  DEFAULT_GRAIN,
DEFAULT_VIGNETTE,
  EFFECT_LIMITS,
  applyBlurToRgba,
  applyClarityToRgba,
  applyEffectsToRgba,
  applyGlowToRgba,
  clarityPixel,
  clarityRadius,
  claritiesEqual,
  clipEffectsEqual,
  effectsOf,
  gblurParams,
  grainHash,
  grainPixel,
  grainsEqual,
  glowsEqual,
  hasEffects,
  iirBlurPlane,
  parseClarityPatch,
  parseGlowPatch,
  parseGrainPatch,
  parseVignettePatch,
  roundHalfEven,
  sanitizeBlurRadius,
  sanitizeClarity,
  sanitizeClipEffects,
  sanitizeGlow,
  sanitizeGrain,
  sanitizeVignette,
  screenBlend,
  toFfmpegBlurFilter,
  toFfmpegClarityFilters,
  toFfmpegGlowBlendFilter,
  toFfmpegGlowScaleFilter,
  toFfmpegGlowThresholdFilter,
  toFfmpegGrainFilter,
  toFfmpegVignetteFilter,
  vignettePixel,
  vignettesEqual,
  type ClipEffects,
} from './effects';import type { Clip } from '../types/project';

function clip(fields: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', type: 'video', trackId: 'v1',
    startFrame: 0, durationFrames: 10, inPoint: 0, outPoint: 10,
    x: 0, y: 0, width: 16, height: 9, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...fields,
  };
}

describe('model and sanitize', () => {
  it('keeps valid stages and drops identity ones', () => {
    expect(sanitizeBlurRadius(8)).toBe(8);
    expect(sanitizeBlurRadius(0)).toBeUndefined();
    expect(sanitizeBlurRadius(101)).toBeUndefined();
    expect(sanitizeVignette({ amount: -0.5 })).toEqual({ ...DEFAULT_VIGNETTE, amount: -0.5 });
    expect(sanitizeVignette({ amount: 0 })).toBeUndefined();
    expect(sanitizeVignette({ amount: 2 })).toBeUndefined();
    expect(sanitizeGrain({ amount: 0.5 })).toEqual({ ...DEFAULT_GRAIN, amount: 0.5 });
    expect(sanitizeGrain({ amount: 0 })).toBeUndefined();
    expect(sanitizeGlow({ intensity: 0.5 })).toEqual({ ...DEFAULT_GLOW, intensity: 0.5 });
    expect(sanitizeGlow({ intensity: 0 })).toBeUndefined();
  });

  it('falls back to defaults per invalid component', () => {
    expect(sanitizeVignette({ amount: -0.5, midpoint: 99 })).toEqual({ ...DEFAULT_VIGNETTE, amount: -0.5 });
    expect(sanitizeGrain({ amount: 0.5, size: 99 })).toEqual({ ...DEFAULT_GRAIN, amount: 0.5 });
    expect(sanitizeGlow({ intensity: 0.5, radius: -1 })).toEqual({ ...DEFAULT_GLOW, intensity: 0.5 });
  });

  it('narrows a degenerate glow threshold away from the smoothstep edge', () => {
    // smoothstep(1, 1, y) is undefined upstream; 0.999 isolates the same
    // full-white highlights deterministically on both backends.
    expect(sanitizeGlow({ intensity: 1, threshold: 1 })?.threshold).toBe(0.999);
  });

  it('compares structurally and extracts clip effects', () => {
    const fx: ClipEffects = { blurRadius: 8, vignette: { ...DEFAULT_VIGNETTE, amount: -0.5 } };
    expect(effectsOf(clip(fx))).toEqual(fx);
    expect(effectsOf(clip())).toBeNull();
    expect(hasEffects(clip(fx))).toBe(true);
    expect(hasEffects(clip())).toBe(false);
    expect(vignettesEqual(fx.vignette, { ...fx.vignette! })).toBe(true);
    expect(vignettesEqual(fx.vignette, undefined)).toBe(false);
    expect(grainsEqual(undefined, undefined)).toBe(true);
    expect(glowsEqual({ ...DEFAULT_GLOW, intensity: 1 }, { ...DEFAULT_GLOW, intensity: 0.5 })).toBe(false);
    expect(clipEffectsEqual(fx, { ...fx })).toBe(true);
    expect(clipEffectsEqual(fx, {})).toBe(false);
    expect(clipEffectsEqual(undefined, undefined)).toBe(true);
    expect(sanitizeClipEffects({ blurRadius: 8, nope: 1 })).toEqual({ blurRadius: 8 });
    expect(sanitizeClipEffects(null)).toEqual({});
  });

  it('models clarity with upstream ranges and an all-zero identity drop', () => {
    expect(EFFECT_LIMITS.clarity.clarity).toEqual({ min: -1, max: 1 });
    expect(EFFECT_LIMITS.clarity.dehaze).toEqual({ min: -1, max: 1 });
    expect(DEFAULT_CLARITY).toEqual({ clarity: 0, dehaze: 0 });
    // One non-zero component is enough to keep the field: upstream's guard is
    // `clarity != 0 || dehaze != 0`, not "amount must be non-zero".
    expect(sanitizeClarity({ clarity: 0, dehaze: 0 })).toBeUndefined();
    expect(sanitizeClarity({ clarity: 0.5, dehaze: 0 })).toEqual({ clarity: 0.5, dehaze: 0 });
    expect(sanitizeClarity({ clarity: 0, dehaze: -0.5 })).toEqual({ clarity: 0, dehaze: -0.5 });
    // Invalid components fall back to the default rather than refusing.
    expect(sanitizeClarity({ clarity: 9, dehaze: 0.25 })).toEqual({ clarity: 0, dehaze: 0.25 });
    expect(sanitizeClarity(null)).toBeUndefined();
    expect(sanitizeClarity([])).toBeUndefined();
    expect(claritiesEqual({ clarity: 0.5, dehaze: 0 }, { clarity: 0.5, dehaze: 0 })).toBe(true);
    expect(claritiesEqual({ clarity: 0.5, dehaze: 0 }, { clarity: 0.5, dehaze: 0.5 })).toBe(false);
    expect(claritiesEqual(undefined, undefined)).toBe(true);
    expect(claritiesEqual({ clarity: 0.5, dehaze: 0 }, undefined)).toBe(false);
    const fx: ClipEffects = { clarity: { clarity: 0.5, dehaze: 0 } };
    expect(effectsOf(clip(fx))).toEqual(fx);
    expect(clipEffectsEqual(fx, { clarity: { clarity: 0.5, dehaze: 0 } })).toBe(true);
  });

  it('parses the agent clarity patch strictly', () => {
    expect(parseClarityPatch({ clarity: 0.5 })).toEqual({ ok: true, patch: { clarity: 0.5 } });
    expect(parseClarityPatch({ dehaze: -1 })).toEqual({ ok: true, patch: { dehaze: -1 } });
    expect(parseClarityPatch({ clarity: 1.5 }).ok).toBe(false);
    expect(parseClarityPatch({ dehaze: -2 }).ok).toBe(false);
    expect(parseClarityPatch('nope').ok).toBe(false);
    expect(parseClarityPatch([]).ok).toBe(false);
    expect(parseClarityPatch({}).ok).toBe(true);
  });

  it('refuses malformed agent patches with the reason', () => {
    expect(parseVignettePatch({ amount: -0.5 })).toEqual({ ok: true, patch: { amount: -0.5 } });
    expect(parseVignettePatch({ amount: 2 }).ok).toBe(false);
    expect(parseVignettePatch('nope').ok).toBe(false);
    expect(parseGrainPatch({ amount: 1, size: 2 })).toEqual({ ok: true, patch: { amount: 1, size: 2 } });
    expect(parseGrainPatch({ size: 99 }).ok).toBe(false);
    expect(parseGlowPatch({ intensity: 1 }).ok).toBe(true);
    expect(parseGlowPatch({ warmth: -1 }).ok).toBe(false);
    expect(parseGlowPatch([]).ok).toBe(false);
  });
});

describe('clarity & dehaze math (upstream detail.clarity)', () => {
  // Upstream ships three tests in ClarityKernelTests.swift; they are the
  // behavioural spec for this kernel, so they are ported here rather than
  // invented. Every expected number below was produced by the REAL emitted
  // graph through ffmpeg 8.1.2 on the same fixtures, and the preview matched it
  // to the byte (max |diff| 0) in all four cases.
  const N = 64;
  const at = (data: Uint8Array, x: number, y: number, ch = 0): number => data[(y * N + x) * 4 + ch];
  const saturation = (r: number, g: number, b: number): number => {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    return mx <= 1e-5 ? 0 : (mx - mn) / mx;
  };
  /** Upstream's edgeImage: left half 77, right half 178, opaque. */
  function edgeFrame(): Uint8Array {
    const data = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        const i = (y * N + x) * 4;
        const v = x < N / 2 ? 77 : 178;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
    }
    return data;
  }

  it('scales the blur radius with the frame, not a fixed pixel count', () => {
    // Upstream: max(extent.width, extent.height) / 40.
    expect(clarityRadius(64, 64)).toBe(1.6);
    expect(clarityRadius(1920, 1080)).toBe(48);
    // Degenerate frames still yield a positive radius rather than dividing by 0.
    expect(clarityRadius(0, 0)).toBeCloseTo(1 / 40, 12);
  });

  it('unsharp is per channel, hue preserving, and saturating', () => {
    // clarity 1 doubles the local difference: 200 against a blurred 150 -> 250.
    expect(clarityPixel(200, 100, 50, 150, 100, 50, { clarity: 1, dehaze: 0 }))
      .toEqual([250, 100, 50]);
    // Channels whose blur equals their source do not move at all, which is what
    // keeps the operation a gain on the high-pass rather than a hue shift.
    expect(clarityPixel(200, 100, 50, 150, 100, 50, { clarity: 0.5, dehaze: 0 }))
      .toEqual([225, 100, 50]);
    // Out-of-range results clamp at the store, like every geq in the chain.
    expect(clarityPixel(200, 100, 50, 100, 100, 50, { clarity: 1, dehaze: 0 }))
      .toEqual([255, 100, 50]);
    expect(clarityPixel(200, 100, 50, 250, 100, 50, { clarity: 1, dehaze: 0 }))
      .toEqual([150, 100, 50]);
  });

  it('dehaze lifts contrast about the 0.45 pivot even with no local detail', () => {
    // A flat pixel has no high-pass at all, so the whole dehaze effect is the
    // contrast mix: 114.75 + (179-114.75) * 1.45 = 207.91, truncated to 207.
    // Hand-computed, and the saturation is unchanged because it is grey.
    expect(clarityPixel(179, 179, 179, 179, 179, 179, { clarity: 0, dehaze: 1 }))
      .toEqual([207, 207, 207]);
    // A darker pixel moves less, and not only because it sits nearer the pivot:
    // its dark channel is lower, so the smoothstep has not saturated and w is
    // ~0.93 rather than 1. Hand-computed: t = 87.25/114.75 = 0.76035,
    // ss = 0.85517, w = 0.927585, giving 114.75 - 14.75*1.41741 = 93.84.
    expect(clarityPixel(100, 100, 100, 100, 100, 100, { clarity: 0, dehaze: 1 }))
      .toEqual([93, 93, 93]);
  });

  it('upstream test 1: neutral is a no-op', () => {
    // clarityHaze guards on `clarity != 0 || dehaze != 0`, and the sanitizer
    // drops an all-zero field, so both backends leave the frame alone.
    const data = edgeFrame();
    const before = Uint8Array.from(data);
    applyClarityToRgba(data, N, N, { clarity: 0, dehaze: 0 });
    expect(Array.from(data)).toEqual(Array.from(before));
    expect(effectsOf({ clarity: { clarity: 0, dehaze: 0 } } as never)).toBeNull();
  });

  it('upstream test 2: dehaze re-saturates a washed patch', () => {
    // A bright, low-saturation (hazy) patch comes back with more contrast and
    // saturation. Upstream asserts after > before + 0.02.
    const data = new Uint8Array(N * N * 4);
    for (let i = 0; i < N * N; i += 1) {
      data[i * 4] = 179; data[i * 4 + 1] = 186; data[i * 4 + 2] = 199; data[i * 4 + 3] = 255;
    }
    const before = saturation(179, 186, 199);
    applyClarityToRgba(data, N, N, { clarity: 0, dehaze: 1 });
    const after = saturation(data[0], data[1], data[2]);
    expect(after).toBeGreaterThan(before + 0.02);
    // Pinned against the real ffmpeg graph: rgb 179,186,199 -> 203,218,246.
    expect([data[0], data[1], data[2]]).toEqual([203, 218, 246]);
    expect(after).toBeCloseTo(0.174797, 6);
  });

  it('upstream test 3: clarity boosts the edge and leaves flat regions alone', () => {
    const data = edgeFrame();
    const base = at(data, 4, 32);
    applyClarityToRgba(data, N, N, { clarity: 1, dehaze: 0 });
    // Deep in the flat region there is no local contrast, so nothing moves.
    expect(Math.abs(at(data, 4, 32) - base)).toBeLessThan(0.01);
    // Immediately left of the edge, the unsharp overshoots darker.
    expect(at(data, 31, 32) - base).toBeLessThan(-0.02);
    // Pinned against the real ffmpeg graph, row 32 red channel.
    expect([at(data, 4, 32), at(data, 31, 32), at(data, 32, 32), at(data, 40, 32)])
      .toEqual([77, 47, 208, 178]);
  });

  it('pins clarity and dehaze together (FFmpeg geq graph row 32 red)', () => {
    const data = edgeFrame();
    applyClarityToRgba(data, N, N, { clarity: 0.8, dehaze: 0.6 });
    expect([at(data, 4, 32), at(data, 31, 32), at(data, 32, 32), at(data, 40, 32)])
      .toEqual([68, 29, 239, 195]);
  });

  it('keeps the blurred copy it needs instead of overwriting the source', () => {
    // The reason this cannot reuse applyBlurToRgba: that destroys each channel
    // as it goes, so the combine would read a blurred red against an untouched
    // green. A frame with a lopsided blur must therefore not shift hue.
    const data = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 8 * 8; i += 1) {
      data[i * 4] = 200; data[i * 4 + 1] = 100; data[i * 4 + 2] = 50; data[i * 4 + 3] = 255;
    }
    const before = Array.from(data.subarray(0, 4));
    applyClarityToRgba(data, 8, 8, { clarity: 1, dehaze: 0 });
    // A perfectly flat frame has no local contrast at any radius, so the
    // unsharp is exactly identity: which it can only be if both the source and
    // the blur were available at the same time.
    expect(Array.from(data.subarray(0, 4))).toEqual(before);
  });

  it('carries alpha through untouched, like every upstream kernel here', () => {
    const data = edgeFrame();
    for (let i = 3; i < data.length; i += 4) data[i] = 128;
    applyClarityToRgba(data, N, N, { clarity: 1, dehaze: 1 });
    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(128);
  });
});

describe('vignette math', () => {
  const V = { amount: -1, midpoint: 0.5, roundness: 0, feather: 0.5 };

  it('darkens corners and spares the center (FFmpeg geq: (10,5,2) / (200,100,50))', () => {
    expect(vignettePixel(200, 100, 50, 0, 0, 8, 8, V)).toEqual([10, 5, 2]);
    expect(vignettePixel(200, 100, 50, 4, 4, 8, 8, V)).toEqual([200, 100, 50]);
    expect(vignettePixel(200, 100, 50, 3, 3, 8, 8, V)).toEqual([200, 100, 50]);
  });

  it('lightens edges at positive amounts and stays hue-preserving', () => {
    const [r, g, b] = vignettePixel(100, 50, 25, 0, 0, 8, 8, { ...V, amount: 1 });
    expect([r, g, b]).toEqual([194, 97, 48]);
    // Multiplicative gain preserves channel ratios (like-for-like hue).
    expect(Math.abs(r / 200 - g / 100)).toBeLessThan(0.02);
  });
});

describe('grain math', () => {
  it('is deterministic per pixel and frame, silent at amount 0', () => {
    const G = { amount: 1, size: 1.5 };
    const a = grainPixel(128, 128, 128, 3, 5, G, 0);
    expect(grainPixel(128, 128, 128, 3, 5, G, 0)).toEqual(a);
    expect(grainPixel(128, 128, 128, 3, 5, G, 20)).not.toEqual(a);
    expect(grainPixel(128, 128, 128, 3, 5, G, 0)).not.toEqual([128, 128, 128]);
    // Monochromatic: all channels shift together.
    expect(a[0] - 128).toBe(a[1] - 128);
    expect(a[1] - 128).toBe(a[2] - 128);
  });

  it('pins hash values (FFmpeg geq bit-matches these)', () => {
    expect(grainHash(0, 0, 0)).toBe(0);
    expect(grainHash(2, 10 / 3, 0)).toBeCloseTo(0.8810486932574122, 9);
    expect(grainPixel(128, 128, 128, 0, 0, { amount: 1, size: 1.5 }, 0)).toEqual([83, 83, 83]);
    expect(grainPixel(128, 128, 128, 3, 5, { amount: 1, size: 1.5 }, 0)).toEqual([162, 162, 162]);
    expect(grainPixel(128, 128, 128, 7, 7, { amount: 1, size: 1.5 }, 0)).toEqual([160, 160, 160]);
    // Near-black and near-white barely move (the 4y(1-y) gate).
    expect(grainPixel(4, 4, 4, 3, 5, { amount: 1, size: 1.5 }, 0)).toEqual([6, 6, 6]);
    expect(grainPixel(250, 250, 250, 3, 5, { amount: 1, size: 1.5 }, 0)).toEqual([252, 252, 252]);
    // Frame 1 animates (FFmpeg N=1 renders 111 too).
    expect(grainPixel(128, 128, 128, 3, 5, { amount: 1, size: 1.5 }, 1)).toEqual([111, 111, 111]);
  });
});

describe('gaussian IIR math', () => {
  it('derives Getreuer parameters (sigma 1: nu 0.2679, postscale 0.5359)', () => {
    const p = gblurParams(1);
    expect(p.nu).toBeCloseTo(0.2679, 3);
    expect(p.postscale).toBeCloseTo(0.5359, 3);
    expect(p.boundaryscale).toBeCloseTo(1.3660, 3);
  });

  it('blurs an impulse like gblur (FFmpeg: peak 85, ring 23/6/2)', () => {
    const src = new Float64Array(8 * 8);
    src[1 * 8 + 1] = 255;
    const out = iirBlurPlane(src, 8, 8, 1);
    const at = (x: number, y: number): number => roundHalfEven(out[y * 8 + x]);
    expect(at(1, 1)).toBe(85);
    expect(at(0, 1)).toBe(23);
    expect(at(2, 2)).toBe(6);
    // Wider kernel, centered impulse (FFmpeg: 28/14/7).
    const wide = new Float64Array(16 * 16);
    wide[8 * 16 + 8] = 255;
    const wout = iirBlurPlane(wide, 16, 16, 2);
    expect(roundHalfEven(wout[8 * 16 + 8])).toBe(28);
    expect(roundHalfEven(wout[8 * 16 + 9])).toBe(14);
    expect(roundHalfEven(wout[8 * 16 + 10])).toBe(7);
    // Full-frame differential vs FFmpeg 8.1.2: 32x32 random frame at
    // sigma 3 renders bit-identical on all 3072 channel values.
  });

  it('preserves flat frames (DC gain 1) and rounds half-even like lrintf', () => {
    const src = new Float64Array(4 * 4).fill(200);
    const out = iirBlurPlane(src, 4, 4, 2);
    expect(Array.from(out, roundHalfEven).every((v) => v === 200)).toBe(true);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(126.5)).toBe(126);
  });

  it('applies per channel and leaves alpha alone', () => {
    const data = new Uint8Array(4 * 4 * 4).fill(100);
    data[3] = 255;
    applyBlurToRgba(data, 4, 4, 2);
    expect(Array.from(data.slice(0, 4))).toEqual([100, 100, 100, 255]);
    expect(data[3]).toBe(255);
  });
});

describe('glow math', () => {
  it('screens with the integer formula FFmpeg blend uses', () => {
    // Probed: blend screen = 255 - (255-A)(255-B)//255, bit-exact here.
    expect(screenBlend(200, 30)).toBe(207);
    expect(screenBlend(100, 60)).toBe(137);
    expect(screenBlend(50, 90)).toBe(123);
    expect(screenBlend(0, 0)).toBe(0);
    expect(screenBlend(255, 123)).toBe(255);
  });

  it('bleeds a white spot into neighbors (FFmpeg graph: center 255, +8px ≈ 13)', () => {
    const n = 48;
    const data = new Uint8Array(n * n * 4);
    for (let y = n / 2 - 3; y < n / 2 + 3; y += 1) {
      for (let x = n / 2 - 3; x < n / 2 + 3; x += 1) {
        const i = (y * n + x) * 4;
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
      }
    }
    applyGlowToRgba(data, n, n, { intensity: 1, radius: 6, threshold: 0.3, warmth: 0 });
    const at = (x: number, y: number): number => data[(y * n + x) * 4];
    expect(at(n / 2, n / 2)).toBe(255);
    expect(at(n / 2 + 8, n / 2)).toBe(13);
    expect(data[3]).toBe(0);
  });

  it('warms the bleed with red-orange cast', () => {
    const n = 16;
    const spot = (): Uint8Array => {
      const data = new Uint8Array(n * n * 4);
      for (let y = 6; y < 10; y += 1) {
        for (let x = 6; x < 10; x += 1) {
          const i = (y * n + x) * 4;
          data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
        }
      }
      return data;
    };
    const neutral = spot();
    applyGlowToRgba(neutral, n, n, { intensity: 1, radius: 2, threshold: 0.3, warmth: 0 });
    const warm = spot();
    applyGlowToRgba(warm, n, n, { intensity: 1, radius: 2, threshold: 0.3, warmth: 1 });
    const px = (d: Uint8Array): [number, number, number] => [d[(8 * n + 12) * 4], d[(8 * n + 12) * 4 + 1], d[(8 * n + 12) * 4 + 2]];
    const [nr, , nb] = px(neutral);
    const [wr, , wb] = px(warm);
    expect(wr - wb).toBeGreaterThan(nr - nb);
  });
});

describe('filter emission', () => {
  it('emits gblur with sigma = radius on color planes only', () => {
    expect(toFfmpegBlurFilter(8)).toBe('gblur=sigma=8:planes=7');
  });

  it('emits the clarity graph: split, blur at max(W,H)/40, hstack, one geq, crop', () => {
    const lines = toFfmpegClarityFilters({ clarity: 0.5, dehaze: 0 }, 'v0mid', 'v0clar', 64, 64, 0);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('[v0mid]split[v0claritySrc][v0clarityBlurIn]');
    // radius = max(W,H)/40 = 1.6 on a 64x64 frame
    expect(lines[1]).toBe('[v0clarityBlurIn]gblur=sigma=1.6:planes=7[v0clarityBlur]');
    // The two frames go side by side so one geq can read both.
    expect(lines[2]).toBe('[v0claritySrc][v0clarityBlur]hstack=inputs=2[v0clarityStack]');
    expect(lines[3]).toContain('geq=');
    // The blurred half is read at X+W/2, which is the only reason the graph
    // works: inside a blend expression there is no r(X,Y)/g(X,Y) at all.
    expect(lines[3]).toContain('r(X+W/2,Y)');
    expect(lines[4]).toBe('[v0clarityCrop]crop=64:64:0:0[v0clar]');
  });

  it('emits only the clarity unsharp when dehaze is off, matching upstream’s guard', () => {
    const lines = toFfmpegClarityFilters({ clarity: 1, dehaze: 0 }, 'in', 'out', 8, 8, 0);
    const geq = lines[3]!;
    expect(geq).toContain('+(');
    // No dark channel, no luma, no dehaze constants at all.
    expect(geq).not.toContain('min(r(X,Y)');
    expect(geq).not.toContain('0.2126');
    expect(geq).not.toContain('114.75');
  });

  it('emits the full dehaze trio with the cross-channel terms when dehaze is on', () => {
    const lines = toFfmpegClarityFilters({ clarity: 0, dehaze: 1 }, 'in', 'out', 8, 8, 0);
    const geq = lines[3]!;
    // dark = min(r,g,b) of the SOURCE, and the smoothstep over bytes 12.75..127.5
    expect(geq).toContain('min(r(X,Y),min(g(X,Y),b(X,Y)))');
    expect(geq).toContain('-12.75)/114.75');
    expect(geq).toContain('*(3-2*(');
    // mix(float3(0.45), rgb, t) in byte space, and the luma re-saturation.
    expect(geq).toContain('114.75+');
    expect(geq).toContain('0.2126*');
    expect(geq).toContain('*0.45)');
    expect(geq).toContain('*0.5)');
  });

  it('emits the vignette geq with frame constants and the smoothstep recipe', () => {
    const filter = toFfmpegVignetteFilter({ amount: -1, midpoint: 0.5, roundness: 0, feather: 0.5 });
    expect(filter.startsWith('geq=')).toBe(true);
    expect(filter).toContain('(X-W/2)/max(W/2,1)');
    expect(filter).toContain('pow(abs(');
    expect(filter).toContain('*(3-2*(');
    expect(filter).toContain('(1+-1*(');
    expect(filter).toContain(":a='alpha(X,Y)'");
  });

  it('emits the grain geq with the hash and the clip-local frame counter', () => {
    const filter = toFfmpegGrainFilter({ amount: 1, size: 1.5 });
    expect(filter.startsWith('geq=')).toBe(true);
    expect(filter).toContain('(N)*0.1031');
    expect(filter).toContain('+31.32');
    expect(filter).toContain('4*((');
    expect(filter).toContain('*0.35*(');
  });

  it('emits the glow branch and screen blend', () => {
    const glow = { intensity: 0.5, radius: 6, threshold: 0.3, warmth: 0.25 };
    expect(toFfmpegGlowThresholdFilter(glow)).toContain('(1-0.3*0.25)');
    expect(toFfmpegGlowThresholdFilter(glow)).toContain('(1-0.55*0.25)');
    expect(toFfmpegGlowScaleFilter(glow)).toContain('*0.5');
    expect(toFfmpegGlowBlendFilter('gg', 'src', 'out')).toBe(
      "[gg][src]blend=all_mode='screen':c3_mode='normal':c3_opacity=0[out]",
    );
  });
});

describe('buffer orchestration', () => {
  it('applies blur, grain, vignette and glow in canonical order', () => {    const data = new Uint8Array(8 * 8 * 4).fill(128);
    data[3] = 255;
    const fx: ClipEffects = {
      blurRadius: 1,
      grain: { amount: 0.5, size: 1.5 },
      vignette: { amount: -0.5, midpoint: 0.5, roundness: 0, feather: 0.5 },
      glow: { intensity: 0.5, radius: 1, threshold: 0.3, warmth: 0 },
    };
    applyEffectsToRgba(data, 8, 8, fx, 0);
    // Corners darken (vignette), the flat field gains texture (grain).
    expect(data[(0 * 8 + 0) * 4]).toBeLessThan(data[(4 * 8 + 4) * 4]);
    expect(data[3]).toBe(255);
    // A null bundle is a no-op over any size, including degenerate.
    const before = Array.from(data);
    applyEffectsToRgba(data, 8, 8, null, 0);
    applyEffectsToRgba(data, 0, 0, fx, 0);
    expect(Array.from(data)).toEqual(before);
  });

  it('runs clarity ahead of the blur, per upstream canonicalOrder', () => {
    // detail.clarity sits after every color.* stage and BEFORE blur.* upstream,
    // so the preview must blur an already-clarified frame, not the other way
    // round. On a frame where clarity lifts a flat region and the blur would
    // pull it back toward the neighbourhood, the order is observable.
    const n = 16;
    const make = (): Uint8Array => {
      const d = new Uint8Array(n * n * 4);
      for (let y = 0; y < n; y += 1) {
        for (let x = 0; x < n; x += 1) {
          const i = (y * n + x) * 4;
          const v = x < n / 2 ? 60 : 200;
          d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
        }
      }
      return d;
    };
    const clarity: ClipEffects = { clarity: { clarity: 0.8, dehaze: 0 }, blurRadius: 4 };
    const inOrder = make();
    applyEffectsToRgba(inOrder, n, n, clarity, 0);
    // The same two stages the other way round, spelled out.
    const reversed = make();
    applyBlurToRgba(reversed, n, n, 4);
    applyClarityToRgba(reversed, n, n, { clarity: 0.8, dehaze: 0 });
    expect(Array.from(inOrder)).not.toEqual(Array.from(reversed));
  });

  it('pins that vignette and invert do not commute (order matters)', () => {
    // The export chain runs vignette after invert (canonical slot), so the
    // preview must too: gain-then-negate differs from negate-then-gain.
    const V = { amount: -1, midpoint: 0.5, roundness: 0, feather: 0.5 };
    const corner: [number, number, number] = [200, 100, 50];
    const [vr, vg, vb] = vignettePixel(...corner, 0, 0, 8, 8, V);
    const invertThenVignette = vignettePixel(255 - corner[0], 255 - corner[1], 255 - corner[2], 0, 0, 8, 8, V);
    const vignetteThenInvert: [number, number, number] = [255 - vr, 255 - vg, 255 - vb];
    expect(invertThenVignette).not.toEqual(vignetteThenInvert);
    // Pinned: negate-then-vignette (the chain order) darkens the inverted
    // corner to near-black.
    expect(invertThenVignette).toEqual([2, 8, 10]);
  });
});
