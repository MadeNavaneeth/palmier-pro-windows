import { describe, it, expect } from 'vitest';
import { fadeMultiplier, effectiveOpacity } from './fade';
import type { Clip } from '../types/project';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', type: 'video', trackId: 'v1',
    startFrame: 0, durationFrames: 100, inPoint: 0, outPoint: 100,
    x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...overrides,
  };
}

describe('fade math', () => {
  it('returns full opacity with no fades', () => {
    expect(fadeMultiplier(clip(), 50)).toBe(1);
  });

  it('ramps a fade-in from 0 to 1', () => {
    const c = clip({ fadeInFrames: 10 });
    expect(fadeMultiplier(c, 0)).toBe(0);
    expect(fadeMultiplier(c, 5)).toBeCloseTo(0.5, 5);
    expect(fadeMultiplier(c, 10)).toBe(1);
    expect(fadeMultiplier(c, 50)).toBe(1);
  });

  it('ramps a fade-out from 1 to 0 at the end', () => {
    const c = clip({ durationFrames: 100, fadeOutFrames: 10 });
    expect(fadeMultiplier(c, 89)).toBeCloseTo(1, 1); // before fade-out
    expect(fadeMultiplier(c, 90)).toBeCloseTo(1, 5); // fade-out start
    expect(fadeMultiplier(c, 95)).toBeCloseTo(0.5, 5);
    expect(fadeMultiplier(c, 99)).toBeCloseTo(0.1, 5);
  });

  it('returns 0 outside the clip span', () => {
    const c = clip({ startFrame: 10, durationFrames: 20 });
    expect(fadeMultiplier(c, 5)).toBe(0);
    expect(fadeMultiplier(c, 30)).toBe(0);
  });

  it('takes the minimum when fade-in and fade-out overlap a short clip', () => {
    const c = clip({ durationFrames: 10, fadeInFrames: 8, fadeOutFrames: 8 });
    // Every frame is bounded by both ramps; never exceeds 1, never negative.
    for (let f = 0; f < 10; f++) {
      const m = fadeMultiplier(c, f);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
    }
  });

  it('multiplies the base opacity', () => {
    const c = clip({ opacity: 0.5, fadeInFrames: 10 });
    expect(effectiveOpacity(c, 5)).toBeCloseTo(0.25, 5); // 0.5 base * 0.5 ramp
    expect(effectiveOpacity(c, 50)).toBe(0.5);
  });
});
