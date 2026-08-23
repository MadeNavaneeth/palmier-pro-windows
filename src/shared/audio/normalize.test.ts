import { describe, it, expect } from 'vitest';
import { dbToLinear, linearToDb, normalizeGain, MAX_NORMALIZE_GAIN } from './normalize';

describe('dbToLinear / linearToDb', () => {
  it('converts 0 dB to unity gain', () => {
    expect(dbToLinear(0)).toBe(1);
    expect(linearToDb(1)).toBe(0);
  });

  it('converts -6 dB to roughly half amplitude', () => {
    expect(dbToLinear(-6)).toBeCloseTo(0.5012, 3);
    expect(linearToDb(dbToLinear(-6))).toBeCloseTo(-6);
  });

  it('round-trips within floating-point tolerance', () => {
    for (const db of [-24, -12, -6, -3, 0, 3]) {
      expect(linearToDb(dbToLinear(db))).toBeCloseTo(db, 5);
    }
  });

  it('returns 0 for garbage input', () => {
    expect(dbToLinear(Number.NaN)).toBe(0);
    expect(linearToDb(0)).toBe(-Infinity);
  });
});

describe('normalizeGain', () => {
  it('computes the boost needed to reach target peak', () => {
    // Peak at -12 dBFS targeting 0 dBFS → exactly unity (×1).
    expect(normalizeGain(-12, -12)).toBe(1);
    // Peak at -12 targeting -6 → +6 dB = ×~2.
    expect(normalizeGain(-12, -6)).toBeCloseTo(1.9953, 3);
  });

  it('attenuates when the source is hotter than the target', () => {
    // Peak at 0 targeting -3 → attenuate by ~0.7.
    expect(normalizeGain(0, -3)).toBeCloseTo(0.7079, 3);
  });

  it('caps extreme boosts at MAX_NORMALIZE_GAIN', () => {
    const gain = normalizeGain(-60, 0);
    expect(gain).toBe(MAX_NORMALIZE_GAIN);
  });

  it('passes through garbage as unity', () => {
    expect(normalizeGain(Number.NaN, 0)).toBe(1);
  });
});
