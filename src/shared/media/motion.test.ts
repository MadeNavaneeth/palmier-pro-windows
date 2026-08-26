/**
 * Motion track coverage (keyframes v1): sanitize normalization and the
 * linear evaluation contract — clamp at ends, exact interpolation between
 * keypoints, undefined fallback for absent tracks.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeMotion, evaluateMotion } from './motion';

describe('sanitizeMotion', () => {
  it('sorts, rounds frames, dedupes duplicates last-wins', () => {
    const track = sanitizeMotion([
      { frame: 30, value: 3 },
      { frame: 10.4, value: 1 },
      { frame: 10, value: 2 },
      { frame: 20, value: 5 },
    ]);
    expect(track).toEqual([
      { frame: 10, value: 2 },
      { frame: 20, value: 5 },
      { frame: 30, value: 3 },
    ]);
  });

  it('drops single-point and non-finite input', () => {
    expect(sanitizeMotion([{ frame: 0, value: 1 }])).toBeUndefined();
    expect(sanitizeMotion([{ frame: Number.NaN, value: 1 }, { frame: 5, value: 2 }])).toBeUndefined();
    expect(sanitizeMotion(undefined)).toBeUndefined();
  });
});

describe('evaluateMotion', () => {
  const track = [
    { frame: 0, value: 100 },
    { frame: 30, value: 400 },
    { frame: 90, value: 100 },
  ];

  it('clamps outside the first/last keyframe', () => {
    expect(evaluateMotion(track, -5)).toBe(100);
    expect(evaluateMotion(track, 200)).toBe(100);
  });

  it('interpolates exactly at keyframes and halfway', () => {
    expect(evaluateMotion(track, 0)).toBe(100);
    expect(evaluateMotion(track, 30)).toBe(400);
    expect(evaluateMotion(track, 15)).toBe(250);
    expect(evaluateMotion(track, 60)).toBe(250);
  });

  it('returns undefined for an absent track so callers use the static field', () => {
    expect(evaluateMotion(undefined, 10)).toBeUndefined();
  });
});
