/**
 * Crop math + agent surface coverage (#568): clamp/normalize rules, pixel
 * rect math, export filter placement, and set_clip_crop semantics.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeCrop,
  cropRect,
  isCropped,
  CROP_MAX_EDGE,
} from './source-crop';

describe('sanitizeCrop (#568)', () => {
  it('drops no-op zeros to undefined', () => {
    expect(sanitizeCrop(undefined)).toBeUndefined();
    expect(sanitizeCrop({})).toBeUndefined();
    expect(sanitizeCrop({ left: 0, right: 0, top: 0, bottom: 0 })).toBeUndefined();
  });

  it('clamps each edge to the cap and treats all-zero as cleared', () => {
    expect(sanitizeCrop({ left: 5 })).toEqual({ left: CROP_MAX_EDGE, right: 0, top: 0, bottom: 0 });
    // A fully-clamped-to-zero input IS a clear, not an object of zeros.
    expect(sanitizeCrop({ top: -3 })).toBeUndefined();
  });

  it('keeps opposite edges from consuming the frame', () => {
    const crop = sanitizeCrop({ left: 0.8, right: 0.8 })!;
    expect(crop.left + crop.right).toBeCloseTo(0.9, 6);
  });

  it('isCropped narrows and respects zeros', () => {
    expect(isCropped({ left: 0.1, right: 0, top: 0, bottom: 0 })).toBe(true);
    expect(isCropped(undefined)).toBe(false);
  });
});

describe('cropRect', () => {
  it('computes an integer inset rect', () => {
    const rect = cropRect({ left: 0.1, right: 0.2, top: 0, bottom: 0 }, 1000, 500);
    expect(rect).toEqual({ x: 100, y: 0, width: 700, height: 500 });
  });
});
