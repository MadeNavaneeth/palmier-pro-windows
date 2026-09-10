import { describe, it, expect } from 'vitest';
import type { Clip } from '../types/project';
import {
  COMPRESSOR_LIMITS,
  DEFAULT_COMPRESSOR,
  buildCompressorFilter,
  compressorEquals,
  compressorOf,
  compressorPreviewParams,
  dbToLinear,
  hasCompressor,
  mergeCompressor,
  normalizeCompressor,
} from './compressor';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', type: 'audio', trackId: 'a1',
    startFrame: 0, durationFrames: 10, inPoint: 0, outPoint: 10,
    x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...overrides,
  };
}

describe('compressorOf / hasCompressor (#158)', () => {
  it('is null and false without a compressor or at ratio 1', () => {
    expect(compressorOf(clip())).toBeNull();
    expect(hasCompressor(clip())).toBe(false);
    expect(compressorOf(clip({ compressor: { ...DEFAULT_COMPRESSOR, ratio: 1 } }))).toBeNull();
  });

  it('resolves defaults for missing fields', () => {
    const active = clip({ compressor: { thresholdDb: -24, ratio: 4 } as never });
    expect(compressorOf(active)).toEqual({
      thresholdDb: -24,
      ratio: 4,
      attackMs: DEFAULT_COMPRESSOR.attackMs,
      releaseMs: DEFAULT_COMPRESSOR.releaseMs,
      makeupDb: DEFAULT_COMPRESSOR.makeupDb,
    });
  });

  it('clamps corrupt stored values into range', () => {
    const resolved = compressorOf(clip({
      compressor: { thresholdDb: 99, ratio: 40, attackMs: -5, releaseMs: 1e9, makeupDb: -3 },
    }));
    expect(resolved).toEqual({
      thresholdDb: COMPRESSOR_LIMITS.thresholdDb.max,
      ratio: COMPRESSOR_LIMITS.ratio.max,
      attackMs: COMPRESSOR_LIMITS.attackMs.min,
      releaseMs: COMPRESSOR_LIMITS.releaseMs.max,
      makeupDb: COMPRESSOR_LIMITS.makeupDb.min,
    });
  });
});

describe('mergeCompressor (#158)', () => {
  it('arms with defaults when only one field is given', () => {
    expect(mergeCompressor(undefined, { thresholdDb: -30 })).toEqual({
      ...DEFAULT_COMPRESSOR,
      thresholdDb: -30,
    });
  });

  it('patches a field and keeps the rest', () => {
    const merged = mergeCompressor(DEFAULT_COMPRESSOR, { ratio: 8 });
    expect(merged).toEqual({ ...DEFAULT_COMPRESSOR, ratio: 8 });
  });

  it('returns undefined when the merged ratio is 1', () => {
    expect(mergeCompressor(DEFAULT_COMPRESSOR, { ratio: 1 })).toBeUndefined();
    expect(mergeCompressor(undefined, { ratio: 1, thresholdDb: -10 })).toBeUndefined();
  });

  it('returns the same reference for a no-op merge', () => {
    const current = { ...DEFAULT_COMPRESSOR };
    expect(mergeCompressor(current, { ratio: current.ratio })).toBe(current);
    expect(compressorEquals(current, { ...current })).toBe(true);
  });
});

describe('dbToLinear', () => {
  it('matches the standard amplitude conversion', () => {
    expect(dbToLinear(0)).toBeCloseTo(1, 10);
    expect(dbToLinear(-6)).toBeCloseTo(0.501187, 5);
    expect(dbToLinear(6)).toBeCloseTo(1.995262, 5);
  });
});

describe('buildCompressorFilter (#158)', () => {
  it('converts threshold and makeup to linear for FFmpeg', () => {
    const filter = buildCompressorFilter({ thresholdDb: -20, ratio: 3, attackMs: 20, releaseMs: 250, makeupDb: 6 });
    expect(filter).toMatch(/^acompressor=threshold=0\.100000:ratio=3\.00:attack=20\.00:release=250\.00:makeup=1\.995262$/);
  });

  it('keeps the threshold inside FFmpeg\'s accepted domain at the limit', () => {
    const filter = buildCompressorFilter({ thresholdDb: -60, ratio: 20, attackMs: 1, releaseMs: 10, makeupDb: 0 });
    // -60 dB is 0.001 linear, above FFmpeg's 0.00097563 floor.
    expect(filter).toContain('threshold=0.001000');
    expect(filter).toContain('makeup=1.000000');
  });
});

describe('compressorPreviewParams (#158)', () => {
  it('maps ms to seconds and exposes makeup as linear gain', () => {
    expect(compressorPreviewParams({
      thresholdDb: -18, ratio: 4, attackMs: 50, releaseMs: 300, makeupDb: 6,
    })).toEqual({
      threshold: -18,
      ratio: 4,
      attackSec: 0.05,
      releaseSec: 0.3,
      kneeDb: 6,
      makeupLinear: dbToLinear(6),
    });
  });
});

describe('normalizeCompressor', () => {
  it('uses the fallback for absent or unusable fields', () => {
    expect(normalizeCompressor(undefined)).toEqual(DEFAULT_COMPRESSOR);
    expect(normalizeCompressor({ ratio: Number.NaN }, { ...DEFAULT_COMPRESSOR, ratio: 5 }).ratio).toBe(5);
  });
});
