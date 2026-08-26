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

describe('easing curves (keyframes v1.5)', () => {
  const track = [
    { frame: 0, value: 0, easing: 'easeInOut' as const },
    { frame: 100, value: 100 },
  ];

  it('easeInOut hits quarter points: slow-fast-slow', () => {
    expect(evaluateMotion(track, 25)).toBeCloseTo(2 * 0.25 * 0.25 * 100, 6); // 12.5
    expect(evaluateMotion(track, 50)).toBe(50);
    expect(evaluateMotion(track, 75)).toBeCloseTo(100 - Math.pow(-1.5 + 2, 2) / 2 * 100 + 0, 4);
  });

  it('per-segment easing comes from the segment start point', () => {
    const mixed = [
      { frame: 0, value: 0, easing: 'easeIn' as const },
      { frame: 10, value: 100, easing: 'linear' as const },
      { frame: 20, value: 200 },
    ];
    // easeIn at midpoint of seg1: u=0.5 -> 0.25
    expect(evaluateMotion(mixed, 5)).toBeCloseTo(25, 6);
    // linear seg2 midpoint: exact half.
    expect(evaluateMotion(mixed, 15)).toBe(150);
  });

  it('sanitizer preserves recognized easings and drops unknown ones', () => {
    const track = sanitizeMotion([
      { frame: 0, value: 0, easing: 'easeOut' },
      { frame: 10, value: 10, easing: 'wobble' },
    ]);
    // Recognized easing survives; unknown 'wobble' normalizes to linear
    // (dropped from storage, since linear is the default).
    expect(track![0].easing).toBe('easeOut');
    expect(track![1].easing).toBeUndefined();
  });

  it('emits pow/if expressions for eased export segments', async () => {
    const { motionExpression } = await import('./motion');
    const expr = motionExpression([
      { frame: 0, value: 0, easing: 'easeIn' },
      { frame: 30, value: 300 },
    ], 1 / 30);
    expect(expr).toContain('+300.000000*pow');
    expect(expr).toContain('(t)');

    const io = motionExpression([
      { frame: 0, value: 0, easing: 'easeInOut' },
      { frame: 30, value: 300 },
    ], 1 / 30);
    expect(io).toContain('if(lte');
    expect(io).toContain('pow');
  });
});
