/**
 * Coverage for advanced title detection and tilt geometry (#519).
 *
 * isAdvancedTitle gates which clips take the bake pipeline; the corner
 * projection is a faithful port of upstream TextTiltGeometry, so the tests
 * pin identity when untilted and perspective foreshortening (area shrink,
 * edge convergence) when tilted.
 */
import { describe, it, expect } from 'vitest';
import type { Clip } from '../../shared/types/project';
import { titleTiltCorners } from '../../shared/editor/title';
import { isAdvancedTitle } from './title-render';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    assetId: 'a',
    type: 'title',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 30,
    inPoint: 0,
    outPoint: 30,
    text: 'Hello',
    x: 0,
    y: 0,
    width: 800,
    height: 200,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 0,
    anchorY: 0,
    volume: 1,
    muted: false,
    ...overrides,
  } as Clip;
}

describe('isAdvancedTitle', () => {
  it('is false for a plain solid title', () => {
    expect(isAdvancedTitle(clip())).toBe(false);
  });

  it('is false for a non-title clip even with style fields', () => {
    expect(isAdvancedTitle(clip({ type: 'video', titleFillMode: 'footage' }))).toBe(false);
  });

  it('is true for fill mode, blur, and either tilt axis', () => {
    expect(isAdvancedTitle(clip({ titleFillMode: 'footage' }))).toBe(true);
    expect(isAdvancedTitle(clip({ titleBlurRadius: 4 }))).toBe(true);
    expect(isAdvancedTitle(clip({ titleTiltYDeg: -20 }))).toBe(true);
    expect(isAdvancedTitle(clip({ titleTiltXDeg: 12 }))).toBe(true);
  });

  it('ignores explicit zero tilt', () => {
    expect(isAdvancedTitle(clip({ titleTiltXDeg: 0, titleTiltYDeg: 0 }))).toBe(false);
  });
});

describe('titleTiltCorners (#519)', () => {
  const rect = { minX: 0, minY: 0, maxX: 1920, maxY: 1080 };
  const pivot = { x: 960, y: 540 };
  const size = { width: 1920, height: 1080 };

  it('returns the input rectangle when untilted', () => {
    const c = titleTiltCorners(rect, pivot, 0, 0, size);
    expect(c.topLeft).toEqual({ x: 0, y: 0 });
    expect(c.topRight).toEqual({ x: 1920, y: 0 });
    expect(c.bottomRight).toEqual({ x: 1920, y: 1080 });
    expect(c.bottomLeft).toEqual({ x: 0, y: 1080 });
  });

  it('foreshortens the far horizontal edge under a pure Y tilt', () => {
    const c = titleTiltCorners(rect, pivot, 0, 45, size);

    // depth = -x·sinY: the right half (x>0) swings toward the viewer, so its
    // vertical edge projects LONGER than the receding left edge.
    const leftEdge = Math.hypot(c.bottomLeft.x - c.topLeft.x, c.bottomLeft.y - c.topLeft.y);
    const rightEdge = Math.hypot(c.bottomRight.x - c.topRight.x, c.bottomRight.y - c.topRight.y);
    expect(rightEdge).toBeGreaterThan(leftEdge);
    // Top and bottom rows share the same x-depths, so they stay equal-length.
    expect(c.topRight.x - c.topLeft.x).toBeCloseTo(c.bottomRight.x - c.bottomLeft.x, 6);
  });

  it('foreshortens the far horizontal row under a pure X tilt', () => {
    const c = titleTiltCorners(rect, pivot, 45, 0, size);

    // depth = y·sinX·cosY: rows differ, columns do not.
    const topRow = c.topRight.x - c.topLeft.x;
    const bottomRow = c.bottomRight.x - c.bottomLeft.x;
    expect(bottomRow).not.toBeCloseTo(topRow, 3);
    expect(c.topRight.y - c.topLeft.y).toBeCloseTo(0, 6);
  });
});
