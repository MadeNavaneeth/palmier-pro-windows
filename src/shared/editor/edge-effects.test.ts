import { hasEdgeEffects, clampEdgeValue, buildEdgeGeqExpr } from './edge-effects';
import type { Clip } from '../types/project';

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    type: 'video',
    assetId: 'a1',
    startFrame: 0,
    outPoint: 120,
    durationFrames: 120,
    inPoint: 0,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    scaleX: 1,
    scaleY: 1,
    anchorX: 960,
    anchorY: 540,
    rotation: 0,
    opacity: 1,
    volume: 1,
    muted: false,
    ...overrides,
  };
}

describe('hasEdgeEffects', () => {
  it('returns false when both fields are absent', () => {
    expect(hasEdgeEffects(makeClip())).toBe(false);
  });

  it('returns false when both are zero', () => {
    expect(hasEdgeEffects(makeClip({ edgeRounding: 0, edgeSoftness: 0 }))).toBe(false);
  });

  it('returns true when edgeRounding > 0', () => {
    expect(hasEdgeEffects(makeClip({ edgeRounding: 0.5 }))).toBe(true);
  });

  it('returns true when edgeSoftness > 0', () => {
    expect(hasEdgeEffects(makeClip({ edgeSoftness: 1 }))).toBe(true);
  });

  it('returns true when both are positive', () => {
    expect(hasEdgeEffects(makeClip({ edgeRounding: 0.1, edgeSoftness: 0.2 }))).toBe(true);
  });
});

describe('clampEdgeValue', () => {
  it('returns 0 for undefined', () => {
    expect(clampEdgeValue(undefined)).toBe(0);
  });

  it('returns 0 for NaN', () => {
    expect(clampEdgeValue(NaN)).toBe(0);
  });

  it('returns 0 for Infinity', () => {
    expect(clampEdgeValue(Infinity)).toBe(0);
  });

  it('returns 0 for negative values', () => {
    expect(clampEdgeValue(-5)).toBe(0);
  });

  it('clamps to 1', () => {
    expect(clampEdgeValue(1.5)).toBe(1);
  });

  it('passes through valid values', () => {
    expect(clampEdgeValue(0)).toBe(0);
    expect(clampEdgeValue(0.5)).toBe(0.5);
    expect(clampEdgeValue(1)).toBe(1);
  });
});

describe('buildEdgeGeqExpr', () => {
  it('returns passthrough when both values are zero', () => {
    expect(buildEdgeGeqExpr(0, 0, 1920, 1080)).toBe('alpha(X,Y)');
  });

  it('returns a non-empty string when rounding > 0', () => {
    const expr = buildEdgeGeqExpr(0.5, 0, 1920, 1080);
    expect(expr).toBeTruthy();
    expect(expr).not.toBe('alpha(X,Y)');
  });

  it('returns a non-empty string when softness > 0', () => {
    const expr = buildEdgeGeqExpr(0, 0.5, 1920, 1080);
    expect(expr).toBeTruthy();
    expect(expr).not.toBe('alpha(X,Y)');
  });

  it('returns a non-empty string when both > 0', () => {
    const expr = buildEdgeGeqExpr(0.3, 0.2, 1920, 1080);
    expect(expr).toBeTruthy();
    expect(expr).not.toBe('alpha(X,Y)');
  });

  it('includes FFmpeg symbols W and H in the expression', () => {
    const expr = buildEdgeGeqExpr(0.5, 0, 1920, 1080);
    expect(expr).toContain('W');
    expect(expr).toContain('H');
    expect(expr).toContain('X');
    expect(expr).toContain('Y');
  });

  it('uses pixel-appropriate radius for 1920x1080 with rounding=0.5', () => {
    // radius = 0.5 * min(1920, 1080) * 0.5 = 0.5 * 540 = 270
    const expr = buildEdgeGeqExpr(0.5, 0, 1920, 1080);
    expect(expr).toContain('270');
  });

  it('uses pixel-appropriate radius for 1080x1920 (portrait) with rounding=1', () => {
    // radius = 1 * min(1080, 1920) * 0.5 = 540
    const expr = buildEdgeGeqExpr(1, 0, 1080, 1920);
    expect(expr).toContain('540');
  });
});
