/**
 * Per-clip noise reduction (#165): sanitizer narrow-on-read, the off
 * contract, the FFmpeg `afftdn` export mapping, and the preview biquad
 * mapping — the two numbers that must move together for preview/export
 * agreement (their order and values are pinned here and in
 * export-args.denoise.test.ts).
 */

import { describe, it, expect } from 'vitest';
import type { Clip } from '../types/project';
import {
  DEFAULT_NOISE_REDUCTION,
  NOISE_REDUCTION_LIMITS,
  buildDenoiseFilter,
  denoisePreviewParams,
  noiseReductionOf,
  sanitizeNoiseReduction,
} from './denoise';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', type: 'audio', trackId: 'a1',
    startFrame: 0, durationFrames: 10, inPoint: 0, outPoint: 10,
    x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...overrides,
  };
}

describe('sanitizeNoiseReduction (#165)', () => {
  it('keeps a finite percent inside [0,100], boundaries included', () => {
    expect(sanitizeNoiseReduction(0)).toBe(0);
    expect(sanitizeNoiseReduction(60)).toBe(60);
    expect(sanitizeNoiseReduction(NOISE_REDUCTION_LIMITS.max)).toBe(100);
  });

  it('drops hostile values instead of clamping them', () => {
    expect(sanitizeNoiseReduction(undefined)).toBeUndefined();
    expect(sanitizeNoiseReduction(null)).toBeUndefined();
    expect(sanitizeNoiseReduction(Number.NaN)).toBeUndefined();
    expect(sanitizeNoiseReduction(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(sanitizeNoiseReduction('60')).toBeUndefined();
    expect(sanitizeNoiseReduction(true)).toBeUndefined();
    expect(sanitizeNoiseReduction(150)).toBeUndefined();
    expect(sanitizeNoiseReduction(-1)).toBeUndefined();
  });
});

describe('noiseReductionOf (#165)', () => {
  it('is null when off: absent, 0, or hostile', () => {
    expect(noiseReductionOf(clip())).toBeNull();
    expect(noiseReductionOf(clip({ noiseReduction: 0 }))).toBeNull();
    expect(noiseReductionOf(clip({ noiseReduction: 150 as never }))).toBeNull();
    expect(noiseReductionOf(clip({ noiseReduction: '60' as never }))).toBeNull();
    expect(noiseReductionOf(clip({ noiseReduction: Number.NaN }))).toBeNull();
  });

  it('resolves the strength when active', () => {
    expect(DEFAULT_NOISE_REDUCTION).toBe(60);
    expect(noiseReductionOf(clip({ noiseReduction: 60 }))).toBe(60);
    expect(noiseReductionOf(clip({ noiseReduction: 100 }))).toBe(100);
  });
});

describe('buildDenoiseFilter (export afftdn mapping)', () => {
  it('maps the strength percent onto afftdn nr with two decimals', () => {
    // The pinned contract: 60 (upstream default) -> 14.40, 50 -> 12.00,
    // 100 -> 24.00 — afftdn's domain is 0.01-97, so 0.24 keeps headroom.
    expect(buildDenoiseFilter(60)).toBe('afftdn=nr=14.40');
    expect(buildDenoiseFilter(50)).toBe('afftdn=nr=12.00');
    expect(buildDenoiseFilter(100)).toBe('afftdn=nr=24.00');
  });

  it('floors a sub-floor amount at afftdn\'s 0.01 minimum', () => {
    expect(buildDenoiseFilter(0.01)).toBe('afftdn=nr=0.01');
  });

  it('throws on amounts the sanitizer would never pass through', () => {
    expect(() => buildDenoiseFilter(0)).toThrow(/percent/i);
    expect(() => buildDenoiseFilter(-5)).toThrow(/percent/i);
    expect(() => buildDenoiseFilter(101)).toThrow(/percent/i);
    expect(() => buildDenoiseFilter(Number.NaN)).toThrow(/percent/i);
  });
});

describe('denoisePreviewParams (preview biquad mapping)', () => {
  it('parks off/null at a transparent setting (10 Hz, 0 dB shelf)', () => {
    expect(denoisePreviewParams(null)).toEqual({
      highpassFrequency: 10,
      highshelfFrequency: 6000,
      highshelfGainDb: 0,
    });
    expect(denoisePreviewParams(0)).toEqual(denoisePreviewParams(null));
    expect(denoisePreviewParams(Number.NaN)).toEqual(denoisePreviewParams(null));
  });

  it('pins the documented approximation at the default strength', () => {
    // 60% -> highpass 68 Hz (20 + 60*0.8), highshelf -3.6 dB at 6 kHz.
    const params = denoisePreviewParams(60);
    expect(params.highpassFrequency).toBeCloseTo(68, 10);
    expect(params.highshelfFrequency).toBe(6000);
    expect(params.highshelfGainDb).toBeCloseTo(-3.6, 10);
  });

  it('pins the full-scale endpoint and clamps a hostile amount there', () => {
    const full = denoisePreviewParams(100);
    expect(full.highpassFrequency).toBeCloseTo(100, 10);
    expect(full.highshelfGainDb).toBeCloseTo(-6, 10);
    // A direct hostile call clamps rather than extrapolating past 100.
    expect(denoisePreviewParams(150)).toEqual(full);
  });
});
