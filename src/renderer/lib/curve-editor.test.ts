/**
 * Curves-editor geometry and edit rules (upstream #157).
 *
 * The widget is a pointer surface over the pipeline's `GradeCurve` model, so
 * the tests here pin what each gesture produces: identity fallback, sorted
 * insertion under the 16-point cap, the 0.001 interior gap with endpoints
 * locked in x, interior-only removal, and y clamping. The last block proves
 * the edits survive the sanitizer the commit path runs, i.e. no gesture can
 * put an invalid point into the project.
 */

import { describe, it, expect } from 'vitest';
import {
  COLOR_GRADE_CURVE_LIMITS,
  evalCurve,
  sanitizeGradeCurve,
  type CurvePoint,
  type GradeCurve,
} from '../../shared/editor/color-grade';
import {
  CURVE_POINT_HIT_RADIUS,
  CURVE_POINT_MIN_GAP,
  EMPTY_GRADE_CURVE,
  addCurvePoint,
  curveEditorPoints,
  curveForEditing,
  curvePixelToPoint,
  curvePointToPixel,
  findNearestCurvePoint,
  moveCurvePoint,
  removeCurvePoint,
  withCurveChannel,
} from './curve-editor';

const IDENTITY: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

describe('curveForEditing', () => {
  it('sanitizes stored curves and falls back to empty', () => {
    expect(curveForEditing(undefined)).toEqual(EMPTY_GRADE_CURVE);
    expect(curveForEditing({ master: [{ x: 2, y: 0 }] })).toEqual(EMPTY_GRADE_CURVE);
    expect(curveForEditing({ master: [{ x: 0.5, y: 0.4 }] }).master)
      .toEqual([{ x: 0.5, y: 0.4 }]);
  });
});

describe('curveEditorPoints', () => {
  it('shows the identity pair for an empty channel', () => {
    expect(curveEditorPoints([])).toEqual(IDENTITY);
  });

  it('returns a copy so a drag cannot touch stored points', () => {
    const stored = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
    const shown = curveEditorPoints(stored);
    shown[1].y = 0.9;
    expect(stored[1].y).toBe(0.5);
  });
});

describe('curvePointToPixel / curvePixelToPoint', () => {
  it('maps y upward and round-trips', () => {
    expect(curvePointToPixel({ x: 0.25, y: 0.75 }, 200, 100)).toEqual({ x: 50, y: 25 });
    expect(curvePixelToPoint(50, 25, 200, 100)).toEqual({ x: 0.25, y: 0.75 });
  });

  it('clamps pixels outside the box to the unit square', () => {
    expect(curvePixelToPoint(-20, -5, 200, 100)).toEqual({ x: 0, y: 1 });
    expect(curvePixelToPoint(400, 300, 200, 100)).toEqual({ x: 1, y: 0 });
  });

  it('survives a not-yet-measured box', () => {
    expect(curvePixelToPoint(10, 10, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('findNearestCurvePoint', () => {
  it('finds a point inside the grab radius and nothing outside it', () => {
    expect(findNearestCurvePoint(IDENTITY, 0, 100, 200, 100)).toBe(0);
    expect(findNearestCurvePoint(IDENTITY, CURVE_POINT_HIT_RADIUS, 100, 200, 100)).toBe(0);
    expect(findNearestCurvePoint(IDENTITY, CURVE_POINT_HIT_RADIUS + 1, 100, 200, 100)).toBeNull();
  });

  it('returns the nearest of several candidates', () => {
    const points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
    expect(findNearestCurvePoint(points, 104, 40, 200, 100)).toBe(1);
    expect(findNearestCurvePoint(points, 190, 10, 200, 100)).toBe(2);
  });

  it('keeps the first point when two are equally close', () => {
    const points: CurvePoint[] = [{ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.5 }];
    expect(findNearestCurvePoint(points, 101, 50, 200, 100)).toBe(0);
  });
});

describe('addCurvePoint', () => {
  it('inserts at the pressed x and reports the new index', () => {
    const result = addCurvePoint(IDENTITY, { x: 0.4, y: 0.7 });
    expect(result?.index).toBe(1);
    expect(result?.points).toEqual([{ x: 0, y: 0 }, { x: 0.4, y: 0.7 }, { x: 1, y: 1 }]);
  });

  it('keeps x strictly ascending when the press lands on a point', () => {
    const result = addCurvePoint(IDENTITY, { x: 0, y: 0.5 });
    expect(result?.points.map((point) => point.x)).toEqual([0, CURVE_POINT_MIN_GAP, 1]);
  });

  it('clamps y and x into the unit square', () => {
    const result = addCurvePoint([], { x: -1, y: 2 });
    expect(result?.points).toEqual([{ x: 0, y: 1 }]);
  });

  it('refuses the point past the per-channel cap', () => {
    const full: CurvePoint[] = Array.from(
      { length: COLOR_GRADE_CURVE_LIMITS.maxPointsPerChannel },
      (_, index) => ({ x: index / (COLOR_GRADE_CURVE_LIMITS.maxPointsPerChannel - 1), y: 0.5 }),
    );
    expect(addCurvePoint(full, { x: 0.5, y: 0.5 })).toBeNull();
  });

  it('refuses when the neighbours leave no room for the minimum gap', () => {
    const tight: CurvePoint[] = [{ x: 0.5, y: 0 }, { x: 0.5005, y: 1 }];
    expect(addCurvePoint(tight, { x: 0.5002, y: 0.5 })).toBeNull();
  });

  it('falls back to one corner when it has to use the extreme', () => {
    const result = addCurvePoint([{ x: 0, y: 0 }], { x: 0, y: 0.25 });
    expect(result?.points).toEqual([{ x: 0, y: 0 }, { x: CURVE_POINT_MIN_GAP, y: 0.25 }]);
  });
});

describe('moveCurvePoint', () => {
  it('moves y freely and clamps it to the unit square', () => {
    expect(moveCurvePoint(IDENTITY, 0, { x: 0.9, y: -0.5 })[0]).toEqual({ x: 0, y: 0 });
    expect(moveCurvePoint(IDENTITY, 1, { x: 0.1, y: 2 })[1]).toEqual({ x: 1, y: 1 });
  });

  it('locks the endpoints to x 0 and x 1', () => {
    const moved = moveCurvePoint(IDENTITY, 0, { x: 0.4, y: 0.3 });
    expect(moved[0]).toEqual({ x: 0, y: 0.3 });
    expect(moved[1]).toEqual({ x: 1, y: 1 });
  });

  it('clamps an interior point one gap inside each neighbour', () => {
    const points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
    expect(moveCurvePoint(points, 1, { x: 0, y: 0.5 })[1].x).toBe(CURVE_POINT_MIN_GAP);
    expect(moveCurvePoint(points, 1, { x: 2, y: 0.5 })[1].x).toBe(1 - CURVE_POINT_MIN_GAP);
    expect(moveCurvePoint(points, 1, { x: 0.3, y: 0.5 })[1].x).toBe(0.3);
  });

  it('keeps the order when a hand-edited file left neighbours closer than two gaps', () => {
    const tight: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 0.1, y: 0.1 },
      { x: 0.1002, y: 0.2 },
      { x: 0.1005, y: 0.3 },
      { x: 1, y: 1 },
    ];
    const moved = moveCurvePoint(tight, 2, { x: 0.9, y: 0.9 });
    expect(moved[2].x).toBeGreaterThan(moved[1].x);
    expect(moved[2].x).toBeLessThan(moved[3].x);
    expect(moved[2].x).toBeCloseTo(0.10025, 6);
  });

  it('never mutates the input', () => {
    const points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
    moveCurvePoint(points, 1, { x: 0.9, y: 0.9 });
    expect(points[1]).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('removeCurvePoint', () => {
  it('removes an interior point', () => {
    const points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
    expect(removeCurvePoint(points, 1)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it('refuses endpoints and the last two points', () => {
    const points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
    expect(removeCurvePoint(points, 0)).toBeNull();
    expect(removeCurvePoint(points, 2)).toBeNull();
    expect(removeCurvePoint(IDENTITY, 0)).toBeNull();
    expect(removeCurvePoint(IDENTITY, 1)).toBeNull();
  });
});

describe('withCurveChannel', () => {
  it('replaces only the named channel', () => {
    const curve = withCurveChannel(EMPTY_GRADE_CURVE, 'red', [{ x: 0.3, y: 0.6 }]);
    expect(curve.red).toEqual([{ x: 0.3, y: 0.6 }]);
    expect(curve.master).toEqual([]);
    expect(curve.green).toEqual([]);
    expect(curve.blue).toEqual([]);
  });

  it('canonicalizes an identity channel back to empty', () => {
    const curve = withCurveChannel(
      { ...EMPTY_GRADE_CURVE, blue: [{ x: 0.2, y: 0 }] },
      'blue',
      IDENTITY,
    );
    expect(curve.blue).toEqual([]);
  });
});

describe('edits stay valid for the commit path', () => {
  it('a whole drag sequence survives sanitizeGradeCurve point for point', () => {
    let curve: GradeCurve = { ...EMPTY_GRADE_CURVE };
    let points = curveEditorPoints(curve.master);

    const added = addCurvePoint(points, { x: 0.3, y: 0.8 });
    expect(added).not.toBeNull();
    points = added!.points;

    // Drag the new point far past both neighbours and off the top, then the
    // black point above its neighbour: every clamp has to keep the channel
    // acceptable to the sanitizer that the commit runs.
    points = moveCurvePoint(points, 1, { x: 5, y: 5 });
    points = moveCurvePoint(points, 0, { x: 0.9, y: 0.4 });

    curve = withCurveChannel(curve, 'master', points);
    const sanitized = sanitizeGradeCurve(curve);
    expect(sanitized?.master).toEqual(points);
  });

  it('a committed channel evaluates exactly like the preview LUT input', () => {
    const points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 0.5, y: 0.9 }, { x: 1, y: 1 }];
    const curve = withCurveChannel(EMPTY_GRADE_CURVE, 'green', points);
    const sanitized = sanitizeGradeCurve(curve);
    expect(sanitized?.green).toEqual(points);
    expect(evalCurve(sanitized!.green, 0.25)).toBeCloseTo(0.45, 6);
  });
});
