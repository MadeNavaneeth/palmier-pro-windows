/**
 * Regression coverage for viewer guide geometry (upstream issue #167).
 *
 * The rules that matter: fractions of the frame stay fractions in any
 * orientation, the centre cross stays square on a non-square canvas, safe areas
 * match the broadcast percentages they claim, and nothing here produces NaN
 * coordinates that would silently blank the overlay.
 */

import { describe, it, expect } from 'vitest';
import {
  ACTION_SAFE_INSET,
  GUIDE_KINDS,
  GUIDE_LABELS,
  TITLE_SAFE_INSET,
  asGuideKind,
  centerCrossLines,
  gridLines,
  guideGeometry,
  hasVisibleGuides,
  safeAreaRect,
  thirdsLines,
  type GuideCanvas,
  type GuideLine,
} from './guides';

const LANDSCAPE: GuideCanvas = { width: 1920, height: 1080 };
const PORTRAIT: GuideCanvas = { width: 1080, height: 1920 };
const SQUARE: GuideCanvas = { width: 1080, height: 1080 };
const CANVASES: [string, GuideCanvas][] = [
  ['landscape 16:9', LANDSCAPE],
  ['portrait 9:16', PORTRAIT],
  ['square 1:1', SQUARE],
];

function allCoordinates(lines: GuideLine[]): number[] {
  return lines.flatMap((line) => [line.x1, line.y1, line.x2, line.y2]);
}

describe('thirds', () => {
  it('places two lines per axis at the third boundaries', () => {
    const lines = thirdsLines();
    expect(lines).toHaveLength(4);

    const vertical = lines.filter((line) => line.x1 === line.x2).map((line) => line.x1);
    const horizontal = lines.filter((line) => line.y1 === line.y2).map((line) => line.y1);
    expect(vertical).toEqual([1 / 3, 2 / 3]);
    expect(horizontal).toEqual([1 / 3, 2 / 3]);
  });

  it('spans the full frame', () => {
    for (const line of thirdsLines()) {
      const spansX = line.x1 === 0 && line.x2 === 1;
      const spansY = line.y1 === 0 && line.y2 === 1;
      expect(spansX || spansY).toBe(true);
    }
  });
});

describe('grid', () => {
  it('draws interior lines only, so the frame edge is not overdrawn', () => {
    const lines = gridLines(4);
    // 3 interior positions per axis.
    expect(lines).toHaveLength(6);
    const offsets = new Set(allCoordinates(lines));
    expect(offsets.has(0.25)).toBe(true);
    expect(offsets.has(0.5)).toBe(true);
    expect(offsets.has(0.75)).toBe(true);
  });

  it('rejects a division count that cannot produce an interior line', () => {
    expect(gridLines(1)).toEqual([]);
    expect(gridLines(0)).toEqual([]);
    expect(gridLines(-4)).toEqual([]);
    expect(gridLines(Number.NaN)).toEqual([]);
  });
});

describe('center cross', () => {
  it('is centered on both axes', () => {
    for (const [, canvas] of CANVASES) {
      const [horizontal, vertical] = centerCrossLines(canvas);
      expect(horizontal.y1).toBeCloseTo(0.5, 10);
      expect(horizontal.y2).toBeCloseTo(0.5, 10);
      expect((horizontal.x1 + horizontal.x2) / 2).toBeCloseTo(0.5, 10);
      expect(vertical.x1).toBeCloseTo(0.5, 10);
      expect((vertical.y1 + vertical.y2) / 2).toBeCloseTo(0.5, 10);
    }
  });

  it('keeps the arms equal in device pixels on every aspect ratio', () => {
    for (const [name, canvas] of CANVASES) {
      const [horizontal, vertical] = centerCrossLines(canvas);
      const horizontalPixels = (horizontal.x2 - horizontal.x1) * canvas.width;
      const verticalPixels = (vertical.y2 - vertical.y1) * canvas.height;
      expect(horizontalPixels, name).toBeCloseTo(verticalPixels, 6);
    }
  });

  it('scales the arms off the shorter edge', () => {
    const [horizontal] = centerCrossLines(LANDSCAPE, 0.1);
    // 10% of 1080 (the short edge) = 108px, as a fraction of 1920 per arm.
    const armPixels = (horizontal.x2 - horizontal.x1) * LANDSCAPE.width;
    expect(armPixels).toBeCloseTo(2 * 108, 6);
  });

  it('returns nothing for an unusable canvas or a zero arm', () => {
    expect(centerCrossLines({ width: 0, height: 1080 })).toEqual([]);
    expect(centerCrossLines({ width: 1920, height: 0 })).toEqual([]);
    expect(centerCrossLines({ width: Number.NaN, height: 1080 })).toEqual([]);
    expect(centerCrossLines({ width: 1920, height: Number.POSITIVE_INFINITY })).toEqual([]);
    expect(centerCrossLines(LANDSCAPE, 0)).toEqual([]);
    expect(centerCrossLines(LANDSCAPE, -1)).toEqual([]);
    expect(centerCrossLines(LANDSCAPE, Number.NaN)).toEqual([]);
  });

  it('never leaves the frame, even with an oversized arm request', () => {
    const lines = centerCrossLines(SQUARE, 10);
    for (const value of allCoordinates(lines)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('safe areas', () => {
  it('covers the documented percentage of the frame', () => {
    const action = safeAreaRect(ACTION_SAFE_INSET);
    expect(action).toEqual({ x: 0.05, y: 0.05, width: 0.9, height: 0.9 });

    const title = safeAreaRect(TITLE_SAFE_INSET);
    expect(title?.width).toBeCloseTo(0.8, 10);
    expect(title?.height).toBeCloseTo(0.8, 10);
  });

  it('stays centered', () => {
    for (const inset of [0, 0.05, 0.1, 0.25]) {
      const rect = safeAreaRect(inset);
      expect(rect).not.toBeNull();
      expect(rect!.x + rect!.width / 2).toBeCloseTo(0.5, 10);
      expect(rect!.y + rect!.height / 2).toBeCloseTo(0.5, 10);
    }
  });

  it('rejects an inset that would collapse or invert the rectangle', () => {
    expect(safeAreaRect(0.5)).toBeNull();
    expect(safeAreaRect(0.75)).toBeNull();
    expect(safeAreaRect(-0.1)).toBeNull();
    expect(safeAreaRect(Number.NaN)).toBeNull();
    expect(safeAreaRect(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('title safe sits inside action safe', () => {
    const action = safeAreaRect(ACTION_SAFE_INSET)!;
    const title = safeAreaRect(TITLE_SAFE_INSET)!;
    expect(title.x).toBeGreaterThan(action.x);
    expect(title.width).toBeLessThan(action.width);
  });
});

describe('guideGeometry', () => {
  it('produces nothing when no guide is enabled', () => {
    expect(guideGeometry([], LANDSCAPE)).toEqual({ lines: [], rects: [] });
    expect(hasVisibleGuides([], LANDSCAPE)).toBe(false);
  });

  it('combines the enabled guides', () => {
    const geometry = guideGeometry(['thirds', 'center', 'actionSafe'], LANDSCAPE);
    expect(geometry.lines).toHaveLength(4 + 2);
    expect(geometry.rects).toHaveLength(1);
    expect(hasVisibleGuides(['thirds'], LANDSCAPE)).toBe(true);
  });

  it('is order-independent and deduplicates repeated kinds', () => {
    const once = guideGeometry(['thirds', 'grid'], LANDSCAPE);
    const twice = guideGeometry(['grid', 'thirds', 'thirds', 'grid'], LANDSCAPE);
    expect(twice.lines).toHaveLength(once.lines.length);
  });

  it('keeps every coordinate finite and inside the frame on any canvas', () => {
    for (const [name, canvas] of CANVASES) {
      const geometry = guideGeometry(GUIDE_KINDS, canvas);
      for (const value of allCoordinates(geometry.lines)) {
        expect(Number.isFinite(value), name).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      for (const rect of geometry.rects) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(1);
        expect(rect.y + rect.height).toBeLessThanOrEqual(1);
      }
    }
  });

  it('still returns frame-relative guides when the canvas is unusable', () => {
    // A degenerate canvas must not throw or emit NaN; only the aspect-corrected
    // centre cross drops out.
    const geometry = guideGeometry(GUIDE_KINDS, { width: 0, height: 0 });
    expect(geometry.lines.every((line) => allCoordinates([line]).every(Number.isFinite))).toBe(true);
    expect(geometry.lines).toHaveLength(6 + 4);
  });

  it('ignores kinds it does not recognize', () => {
    const geometry = guideGeometry(
      ['thirds', 'not-a-guide' as never],
      LANDSCAPE,
    );
    expect(geometry.lines).toHaveLength(4);
  });
});

describe('kind metadata', () => {
  it('labels every kind', () => {
    for (const kind of GUIDE_KINDS) {
      expect(GUIDE_LABELS[kind]?.length).toBeGreaterThan(0);
    }
    expect(Object.keys(GUIDE_LABELS)).toHaveLength(GUIDE_KINDS.length);
  });

  it('narrows persisted values and rejects anything else', () => {
    expect(asGuideKind('thirds')).toBe('thirds');
    expect(asGuideKind('titleSafe')).toBe('titleSafe');
    expect(asGuideKind('legacy-mode')).toBeNull();
    expect(asGuideKind(3)).toBeNull();
    expect(asGuideKind(null)).toBeNull();
    expect(asGuideKind(undefined)).toBeNull();
  });
});
