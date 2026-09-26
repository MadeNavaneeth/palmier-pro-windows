/**
 * Regression coverage for the wheels editor helpers (upstream #157).
 *
 * Pins what each gesture produces: the unit-disk mapping (value +y is up),
 * the radius clamp, per-zone master ranges, zone defaults, and the shared
 * display-color math. The last block proves the agent vocabulary round-trips:
 * x/y in -1..1 with angle = hue and radius = strength display exactly where
 * the pipeline grades them.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GRADE_WHEELS,
  sanitizeGradeWheels,
} from '../../shared/editor/color-grade';
import {
  WHEEL_DRAG_THRESHOLD,
  WHEEL_FACE_SIZE,
  WHEEL_NUDGE_STEP,
  clampWheelMaster,
  clampWheelVector,
  isDefaultWheelZone,
  moveWheelPuck,
  resetWheelZone,
  setWheelMaster,
  wheelDisplayColor,
  wheelFacePixel,
  wheelPixelToValue,
  wheelValueToPixel,
  wheelsForEditing,
} from './color-wheels';

const SIZE = 200;

describe('wheelsForEditing', () => {
  it('sanitizes stored wheels and falls back to fresh defaults', () => {
    expect(wheelsForEditing(undefined)).toEqual(DEFAULT_GRADE_WHEELS);
    const fallback = wheelsForEditing({ lift: { x: 99, y: 0, m: 0 }, gamma: 'nope' });
    // Out-of-range x falls back to the zone default, not a clamp.
    expect(fallback?.lift).toEqual({ x: 0, y: 0, m: 0 });
  });

  it('returns copies so a drag cannot touch the frozen defaults', () => {
    const editing = wheelsForEditing(undefined);
    editing.lift.x = 0.5;
    expect(DEFAULT_GRADE_WHEELS.lift.x).toBe(0);
  });
});

describe('wheelValueToPixel / wheelPixelToValue', () => {
  it('maps value +y upward with the center at rest', () => {
    expect(wheelValueToPixel(0, 0, SIZE, SIZE)).toEqual({ x: 100, y: 100 });
    expect(wheelValueToPixel(1, 0, SIZE, SIZE)).toEqual({ x: 200, y: 100 });
    expect(wheelValueToPixel(0, 1, SIZE, SIZE)).toEqual({ x: 100, y: 0 });
  });

  it('clamps a press outside the disk onto its edge, preserving the angle', () => {
    const pressed = wheelPixelToValue(200, 0, SIZE, SIZE);
    const expected = 1 / Math.sqrt(2);
    expect(pressed.x).toBeCloseTo(expected, 12);
    expect(pressed.y).toBeCloseTo(expected, 12);
  });

  it('round-trips on-disk values the agent writes', () => {
    for (const [x, y] of [[0.3, -0.4], [-0.75, 0.2], [0, 0], [0.6, 0.8]] as Array<[number, number]>) {
      const pixel = wheelValueToPixel(x, y, SIZE, SIZE);
      const back = wheelPixelToValue(pixel.x, pixel.y, SIZE, SIZE);
      expect(back.x).toBeCloseTo(x, 12);
      expect(back.y).toBeCloseTo(y, 12);
    }
  });

  it('survives a not-yet-measured box', () => {
    expect(wheelPixelToValue(10, 10, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(wheelValueToPixel(0.5, 0.5, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('clampWheelVector', () => {
  it('leaves inside values alone and scales outside ones onto the rim', () => {
    expect(clampWheelVector(0.3, -0.4)).toEqual({ x: 0.3, y: -0.4 });
    const clamped = clampWheelVector(2, 0);
    expect(clamped).toEqual({ x: 1, y: 0 });
    expect(Math.hypot(clampWheelVector(1, 1).x, clampWheelVector(1, 1).y)).toBeCloseTo(1, 12);
  });
});

describe('clampWheelMaster', () => {
  it('enforces each zone range from COLOR_GRADE_WHEEL_LIMITS', () => {
    expect(clampWheelMaster(0.25, 'lift')).toBe(0.25);
    expect(clampWheelMaster(5, 'lift')).toBe(0.5);
    expect(clampWheelMaster(-5, 'lift')).toBe(-0.5);
    expect(clampWheelMaster(0, 'gamma')).toBe(0.5);
    expect(clampWheelMaster(3, 'gamma')).toBe(2);
    expect(clampWheelMaster(0, 'gain')).toBe(0.5);
    expect(clampWheelMaster(9, 'gain')).toBe(1.5);
  });
});

describe('moveWheelPuck', () => {
  const wheels = wheelsForEditing(undefined);

  it('moves one zone and clamps the landing to the disk', () => {
    const moved = moveWheelPuck(wheels, 'lift', 2, 0);
    expect(moved.lift).toEqual({ x: 1, y: 0, m: 0 });
    expect(moved.gamma).toEqual(wheels.gamma);
  });

  it('applies small deltas and never mutates the input', () => {
    const moved = moveWheelPuck(
      wheels, 'gain', wheels.gain.x + WHEEL_NUDGE_STEP, wheels.gain.y - WHEEL_NUDGE_STEP,
    );
    expect(moved.gain.x).toBeCloseTo(WHEEL_NUDGE_STEP, 12);
    expect(moved.gain.y).toBeCloseTo(-WHEEL_NUDGE_STEP, 12);
    expect(wheels.gain).toEqual({ x: 0, y: 0, m: 1 });
  });

  it('parks an over-deflected landing on the rim instead of outside it', () => {
    const moved = moveWheelPuck(wheels, 'lift', 1.49, 0);
    expect(moved.lift.x).toBeCloseTo(1, 12);
    expect(moved.lift.y).toBeCloseTo(0, 12);
  });
});

describe('setWheelMaster', () => {
  it('writes one zone master through its range', () => {
    const wheels = wheelsForEditing(undefined);
    expect(setWheelMaster(wheels, 'gamma', 1.75).gamma.m).toBe(1.75);
    expect(setWheelMaster(wheels, 'lift', -9).lift.m).toBe(-0.5);
    expect(setWheelMaster(wheels, 'gain', 0).gain.m).toBe(0.5);
  });
});

describe('resetWheelZone / isDefaultWheelZone', () => {
  it('a fresh clip has every zone at default', () => {
    const wheels = wheelsForEditing(undefined);
    for (const zone of ['lift', 'gamma', 'gain'] as const) {
      expect(isDefaultWheelZone(wheels, zone)).toBe(true);
    }
  });

  it('reset restores one zone and leaves the others alone', () => {
    const edited = setWheelMaster(moveWheelPuck(wheelsForEditing(undefined), 'lift', 0.4, 0.2), 'lift', 0.2);
    const gain = moveWheelPuck(edited, 'gain', -0.3, 0.3);
    expect(isDefaultWheelZone(gain, 'lift')).toBe(false);

    const reset = resetWheelZone(gain, 'lift');
    expect(isDefaultWheelZone(reset, 'lift')).toBe(true);
    expect(reset.gain).toEqual({ x: -0.3, y: 0.3, m: 1 });
  });
});

describe('wheelDisplayColor', () => {
  it('is a dark neutral body at the center', () => {
    const [r, g, b] = wheelDisplayColor(0, 0);
    expect(r).toBeCloseTo(0.08, 12);
    expect(g).toBeCloseTo(0.08, 12);
    expect(b).toBeCloseTo(0.08, 12);
  });

  it('is a vivid saturated rim matching the pipeline hue', () => {
    // East is red (upstream hueRGB(0)), north is chartreuse (hueRGB(0.25)).
    expect(wheelDisplayColor(1, 0)).toEqual([1, 0, 0]);
    expect(wheelDisplayColor(0, 1)).toEqual([0.5, 1, 0]);
    expect(wheelDisplayColor(-1, 0)).toEqual([0, 1, 1]);
  });

  it('shows the stored hue at full strength on the rim', () => {
    const stored = sanitizeGradeWheels({ gain: { x: 0.5, y: -0.5, m: 1.2 } });
    expect(stored?.gain).toEqual({ x: 0.5, y: -0.5, m: 1.2 });
    // Same angle at full deflection is the vivid rim, not a washed-out mix.
    const angle = Math.atan2(-0.5, 0.5);
    const [r, g, b] = wheelDisplayColor(Math.cos(angle), Math.sin(angle));
    expect(Math.max(r, g, b)).toBeGreaterThan(0.9);
  });
});

describe('wheelFacePixel', () => {
  it('is transparent past the feather band and opaque inside', () => {
    expect(wheelFacePixel(1.5, 0)).toEqual([0, 0, 0, 0]);
    expect(wheelFacePixel(0, 0)[3]).toBe(1);
    const edge = wheelFacePixel(1.01, 0);
    expect(edge[3]).toBeGreaterThan(0);
    expect(edge[3]).toBeLessThan(1);
  });

  it('matches the shared display color on the face', () => {
    const [r, g, b, a] = wheelFacePixel(1, 0);
    const [dr, dg, db] = wheelDisplayColor(1, 0);
    expect([r, g, b, a]).toEqual([dr, dg, db, 1]);
  });
});

describe('wheel constants', () => {
  it('mirror the upstream interaction values', () => {
    expect(WHEEL_DRAG_THRESHOLD).toBe(2);
    expect(WHEEL_FACE_SIZE).toBe(160);
    expect(WHEEL_NUDGE_STEP).toBeGreaterThan(0);
  });
});
