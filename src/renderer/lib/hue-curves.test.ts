/**
 * Hue-curves editor geometry and edit rules (upstream #157).
 *
 * The widget is a pointer surface over the pipeline's `HueCurves` model, so
 * the tests here pin what each gesture produces: the six-anchor display
 * fallback, sorted insertion under the 16-point cap, the 0.001 interior gap
 * with endpoints locked in x, interior-only removal, y clamping, and the
 * neutral-emits-empty rule (within the pipeline's 1e-4 epsilon). The path
 * block proves the drawn stroke wraps the 0/1 seam the way the cyclic eval
 * does, and the last block proves the edits survive the sanitizer the commit
 * path runs, i.e. no gesture can put an invalid point into the project.
 */

import { describe, it, expect } from 'vitest';
import {
  COLOR_GRADE_HUE_CURVE_LIMITS,
  DEFAULT_HUE_CURVE_POINTS,
  HUE_CURVE_NEUTRAL_Y,
  sanitizeHueCurves,
  type CurvePoint,
  type HueCurves,
} from '../../shared/editor/color-grade';
import {
  HUE_DRAG_THRESHOLD,
  HUE_NUDGE_STEP,
  HUE_PATH_STEPS,
  HUE_POINT_HIT_RADIUS,
  HUE_POINT_MIN_GAP,
  addHuePoint,
  findNearestHuePoint,
  hueCurvesForEditing,
  hueCurvePath,
  hueEditorPoints,
  huePixelToPoint,
  huePointToPixel,
  moveHuePoint,
  removeHuePoint,
  withHueChannel,
} from './hue-curves';

describe('hueCurvesForEditing', () => {
  it('sanitizes stored curves and falls back to empty', () => {
    expect(hueCurvesForEditing(undefined)).toEqual({ hueVsHue: [], hueVsSat: [], hueVsLum: [] });
    expect(hueCurvesForEditing({ hueVsHue: [{ x: 2, y: 0 }] })).toEqual({
      hueVsHue: [],
      hueVsSat: [],
      hueVsLum: [],
    });
    expect(hueCurvesForEditing({ hueVsSat: [{ x: 0.5, y: 0.4 }] }).hueVsSat)
      .toEqual([{ x: 0.5, y: 0.4 }]);
  });
});

describe('hueEditorPoints', () => {
  it('shows the six default anchors for an empty channel', () => {
    const shown = hueEditorPoints([]);
    expect(shown).toHaveLength(6);
    expect(shown[0]).toEqual({ x: 0, y: HUE_CURVE_NEUTRAL_Y });
    expect(shown[5]).toEqual({ x: 5 / 6, y: HUE_CURVE_NEUTRAL_Y });
    expect(shown).toEqual([...DEFAULT_HUE_CURVE_POINTS]);
  });

  it('returns copies so a drag cannot touch the shared anchors', () => {
    const shown = hueEditorPoints([]);
    shown[0].y = 0.9;
    expect(DEFAULT_HUE_CURVE_POINTS[0].y).toBe(HUE_CURVE_NEUTRAL_Y);
  });

  it('preserves a non-empty channel as copies', () => {
    const stored = [{ x: 0.2, y: 0.7 }];
    const shown = hueEditorPoints(stored);
    expect(shown).toEqual(stored);
    shown[0].x = 0.9;
    expect(stored[0].x).toBe(0.2);
  });
});

describe('huePointToPixel / huePixelToPoint', () => {
  it('maps y upward and round-trips', () => {
    expect(huePointToPixel({ x: 0.25, y: 0.75 }, 200, 100)).toEqual({ x: 50, y: 25 });
    expect(huePixelToPoint(50, 25, 200, 100)).toEqual({ x: 0.25, y: 0.75 });
  });

  it('clamps pixels outside the box to the unit square', () => {
    expect(huePixelToPoint(-20, -5, 200, 100)).toEqual({ x: 0, y: 1 });
    expect(huePixelToPoint(400, 300, 200, 100)).toEqual({ x: 1, y: 0 });
  });

  it('survives a not-yet-measured box', () => {
    expect(huePixelToPoint(10, 10, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('findNearestHuePoint', () => {
  const anchors = hueEditorPoints([]);

  it('finds a point inside the grab radius and nothing outside it', () => {
    // First anchor sits at (0, 50) in a 200x100 box.
    expect(findNearestHuePoint(anchors, 0, 50, 200, 100)).toBe(0);
    expect(findNearestHuePoint(anchors, HUE_POINT_HIT_RADIUS, 50, 200, 100)).toBe(0);
    expect(findNearestHuePoint(anchors, HUE_POINT_HIT_RADIUS + 1, 50, 200, 100)).toBeNull();
  });

  it('keeps the first point when two are equally close', () => {
    const points: CurvePoint[] = [{ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.5 }];
    expect(findNearestHuePoint(points, 101, 50, 200, 100)).toBe(0);
  });
});

describe('addHuePoint', () => {
  it('inserts at the pressed x and reports the new index', () => {
    const result = addHuePoint(hueEditorPoints([]), { x: 0.4, y: 0.7 });
    expect(result?.index).toBe(3);
    expect(result?.points.map((point) => point.x)).toEqual(
      [0, 1 / 6, 2 / 6, 0.4, 3 / 6, 4 / 6, 5 / 6],
    );
    expect(result?.points[3]).toEqual({ x: 0.4, y: 0.7 });
  });

  it('keeps x strictly ascending when the press lands on a point', () => {
    const result = addHuePoint(hueEditorPoints([]), { x: 0, y: 0.5 });
    expect(result?.points.map((point) => point.x)).toEqual(
      [0, HUE_POINT_MIN_GAP, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6],
    );
  });

  it('clamps y and x into the unit square', () => {
    const result = addHuePoint([], { x: -1, y: 2 });
    expect(result?.points).toEqual([{ x: 0, y: 1 }]);
  });

  it('refuses the point past the per-channel cap', () => {
    const full: CurvePoint[] = Array.from(
      { length: COLOR_GRADE_HUE_CURVE_LIMITS.maxPointsPerChannel },
      (_, index) => ({ x: index / (COLOR_GRADE_HUE_CURVE_LIMITS.maxPointsPerChannel - 1), y: 0.5 }),
    );
    expect(addHuePoint(full, { x: 0.5, y: 0.5 })).toBeNull();
  });

  it('refuses when the neighbours leave no room for the minimum gap', () => {
    const tight: CurvePoint[] = [{ x: 0.5, y: 0.5 }, { x: 0.5005, y: 0.5 }];
    expect(addHuePoint(tight, { x: 0.5002, y: 0.5 })).toBeNull();
  });
});

describe('moveHuePoint', () => {
  const anchors = hueEditorPoints([]);

  it('locks the endpoints to their x and clamps y', () => {
    const moved = moveHuePoint(anchors, 0, { x: 0.4, y: -0.5 });
    expect(moved[0]).toEqual({ x: 0, y: 0 });
    expect(moveHuePoint(anchors, 5, { x: 0.1, y: 2 })[5]).toEqual({ x: 5 / 6, y: 1 });
  });

  it('clamps an interior point one gap inside each neighbour', () => {
    expect(moveHuePoint(anchors, 2, { x: 0, y: 0.5 })[2].x).toBe(1 / 6 + HUE_POINT_MIN_GAP);
    expect(moveHuePoint(anchors, 2, { x: 2, y: 0.5 })[2].x).toBe(3 / 6 - HUE_POINT_MIN_GAP);
    expect(moveHuePoint(anchors, 2, { x: 0.3, y: 0.5 })[2].x).toBe(0.3);
  });

  it('keeps the order when a hand-edited file left neighbours closer than two gaps', () => {
    const tight: CurvePoint[] = [
      { x: 0, y: 0.5 },
      { x: 0.1, y: 0.5 },
      { x: 0.1002, y: 0.5 },
      { x: 0.1005, y: 0.5 },
      { x: 1, y: 0.5 },
    ];
    const moved = moveHuePoint(tight, 2, { x: 0.9, y: 0.9 });
    expect(moved[2].x).toBeGreaterThan(moved[1].x);
    expect(moved[2].x).toBeLessThan(moved[3].x);
    expect(moved[2].x).toBeCloseTo(0.10025, 6);
  });

  it('never mutates the input', () => {
    moveHuePoint(anchors, 2, { x: 0.9, y: 0.9 });
    expect(anchors[2]).toEqual({ x: 2 / 6, y: 0.5 });
  });
});

describe('removeHuePoint', () => {
  it('removes an interior point', () => {
    const points = hueEditorPoints([]);
    expect(removeHuePoint(points, 2)).toEqual(points.filter((_, index) => index !== 2));
  });

  it('refuses endpoints and two-point channels', () => {
    const points = hueEditorPoints([]);
    expect(removeHuePoint(points, 0)).toBeNull();
    expect(removeHuePoint(points, 5)).toBeNull();
    const pair: CurvePoint[] = [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }];
    expect(removeHuePoint(pair, 1)).toBeNull();
  });
});

describe('withHueChannel', () => {
  const curves: HueCurves = { hueVsHue: [], hueVsSat: [], hueVsLum: [] };

  it('canonicalizes a neutral channel back to empty', () => {
    expect(withHueChannel(curves, 'hueVsHue', hueEditorPoints([])).hueVsHue).toEqual([]);
    // Within the pipeline's 1e-4 epsilon still counts as neutral.
    expect(withHueChannel(curves, 'hueVsSat', [
      { x: 0, y: 0.50005 },
      { x: 1, y: 0.49995 },
    ]).hueVsSat).toEqual([]);
  });

  it('keeps a channel just outside the epsilon', () => {
    const points = [{ x: 0.25, y: 0.5002 }];
    expect(withHueChannel(curves, 'hueVsLum', points).hueVsLum).toEqual(points);
  });

  it('replaces only the named channel, with copies', () => {
    const points = [{ x: 0.3, y: 0.8 }];
    const next = withHueChannel(curves, 'hueVsHue', points);
    expect(next.hueVsHue).toEqual(points);
    expect(next.hueVsHue).not.toBe(points);
    expect(next.hueVsSat).toEqual([]);
  });
});

describe('hueCurvePath', () => {
  it('draws an empty channel as the flat neutral line', () => {
    const tokens = hueCurvePath([]).split(' ');
    expect(tokens).toHaveLength((HUE_PATH_STEPS + 1) * 3);
    expect(tokens.slice(0, 3)).toEqual(['M', '0.00', '50.00']);
    expect(tokens.slice(-3)).toEqual(['L', '100.00', '50.00']);
    for (let i = 2; i < tokens.length; i += 3) expect(tokens[i]).toBe('50.00');
  });

  it('wraps a lone point across the seam with no jump', () => {
    const tokens = hueCurvePath([{ x: 0.9, y: 0.8 }]).split(' ');
    // Below the point the eval reaches back one turn; past it, forward one.
    expect(tokens.slice(0, 3)).toEqual(['M', '0.00', '20.00']);
    expect(tokens.slice(-3)).toEqual(['L', '100.00', '20.00']);
  });

  it('interpolates across the seam between edge points', () => {
    const tokens = hueCurvePath([{ x: 0.1, y: 0.9 }, { x: 0.9, y: 0.1 }], 20).split(' ');
    expect(tokens.slice(0, 3)).toEqual(['M', '0.00', '50.00']);
    expect(tokens.slice(3, 6)).toEqual(['L', '5.00', '30.00']);
    expect(tokens.slice(-3)).toEqual(['L', '100.00', '50.00']);
  });
});

describe('edits stay valid for the commit path', () => {
  it('a whole drag sequence survives sanitizeHueCurves point for point', () => {
    let curves: HueCurves = { hueVsHue: [], hueVsSat: [], hueVsLum: [] };
    let points = hueEditorPoints(curves.hueVsSat);

    const added = addHuePoint(points, { x: 0.3, y: 0.8 });
    expect(added).not.toBeNull();
    points = added!.points;

    // Drag the new point far past both neighbours and off the top, then the
    // first anchor above neutral: every clamp has to keep the channel
    // acceptable to the sanitizer that the commit runs.
    points = moveHuePoint(points, 2, { x: 5, y: 5 });
    points = moveHuePoint(points, 0, { x: 0.9, y: 0.4 });

    curves = withHueChannel(curves, 'hueVsSat', points);
    const sanitized = sanitizeHueCurves(curves);
    expect(sanitized?.hueVsSat).toEqual(points);
  });
});

describe('hue constants', () => {
  it('mirror the upstream interaction values', () => {
    expect(HUE_POINT_HIT_RADIUS).toBe(15);
    expect(HUE_DRAG_THRESHOLD).toBe(3);
    expect(HUE_POINT_MIN_GAP).toBe(0.001);
    expect(HUE_NUDGE_STEP).toBeGreaterThan(0);
    expect(HUE_PATH_STEPS).toBe(100);
  });
});
