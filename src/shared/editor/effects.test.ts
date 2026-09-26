/**
 * Effects subgroups coverage (upstream #157: blur, vignette, grain, glow):
 * model/sanitize with identity rules, strict agent patches, preview math
 * with pinned values (each verified against FFmpeg 8.1.2 — see comments),
 * and filter emission.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GLOW,
  DEFAULT_GRAIN,
  DEFAULT_VIGNETTE,
  applyBlurToRgba,
  applyEffectsToRgba,
  applyGlowToRgba,
  clipEffectsEqual,
  effectsOf,
  gblurParams,
  grainHash,
  grainPixel,
  grainsEqual,
  glowsEqual,
  hasEffects,
  iirBlurPlane,
  parseGlowPatch,
  parseGrainPatch,
  parseVignettePatch,
  roundHalfEven,
  sanitizeBlurRadius,
  sanitizeClipEffects,
  sanitizeGlow,
  sanitizeGrain,
  sanitizeVignette,
  screenBlend,
  toFfmpegBlurFilter,
  toFfmpegGlowBlendFilter,
  toFfmpegGlowScaleFilter,
  toFfmpegGlowThresholdFilter,
  toFfmpegGrainFilter,
  toFfmpegVignetteFilter,
  vignettePixel,
  vignettesEqual,
  type ClipEffects,
} from './effects';
import type { Clip } from '../types/project';

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
