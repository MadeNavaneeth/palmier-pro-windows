/**
 * Geometry bridge tests (upstream #154): the FCPXML center-based model and
 * our top-left-box model must agree on where the picture lands.
 *
 * The core property: placementFromTransform inverts the export mapping, so a
 * clip exported and reimported renders identically — asserted here at the
 * mapping level (rendering equivalence), with re-export stability covered in
 * adjust.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  aspectFit,
  cropFromTrim,
  placementFromTransform,
} from './geometry';
import { sanitizeCrop } from '../media/source-crop';

const CTX = { canvasWidth: 1920, canvasHeight: 1080, sourceWidth: 1920, sourceHeight: 1080 };

describe('aspectFit (#154)', () => {
  it('fits a source into the canvas preserving aspect', () => {
    expect(aspectFit(1920, 1080, 1920, 1080)).toEqual({ w: 1920, h: 1080 });
    // Portrait source letterboxes: full height, narrowed width.
    expect(aspectFit(1080, 1920, 1920, 1080)).toEqual({ w: 607.5, h: 1080 });
  });

  it('falls back to the canvas when the source size is unknown', () => {
    expect(aspectFit(0, 0, 1920, 1080)).toEqual({ w: 1920, h: 1080 });
    expect(aspectFit(-4, 0, 1920, 1080)).toEqual({ w: 1920, h: 1080 });
  });
});

describe('placementFromTransform (#154)', () => {
  it('recovers a full-frame clip exactly', () => {
    const placement = placementFromTransform(
      { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      CTX,
    );
    expect(placement).toEqual({
      x: 0, y: 0, width: 1920, height: 1080,
      rotation: 0, scaleX: 1, scaleY: 1,
    });
  });

  it('recovers a grid cell: fitted box plus fractional scale would also draw it, but the box carries the size', () => {
    // position -44.4444/25 is the top-left 960x540 quadrant on a 1080p canvas.
    const placement = placementFromTransform(
      { positionX: -44.4444, positionY: 25, scaleX: 0.5, scaleY: 0.5, rotation: 0 },
      CTX,
    );
    expect(placement.width).toBeCloseTo(960, 1);
    expect(placement.height).toBeCloseTo(540, 1);
    expect(placement.x).toBeCloseTo(0, 0);
    expect(placement.y).toBeCloseTo(0, 0);
    expect(placement.rotation).toBe(0);
  });

  it('negates rotation back to our clockwise-positive convention', () => {
    const placement = placementFromTransform(
      { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, rotation: -15 },
      CTX,
    );
    expect(placement.rotation).toBe(15);
  });

  it('preserves flip signs in scale rather than mirroring the box', () => {
    const placement = placementFromTransform(
      { positionX: 0, positionY: 0, scaleX: -1, scaleY: 1, rotation: 0 },
      CTX,
    );
    expect(placement.width).toBeCloseTo(1920, 6);
    expect(placement.scaleX).toBe(-1);
    expect(placement.scaleY).toBe(1);
  });

  it('never produces a degenerate box', () => {
    const placement = placementFromTransform(
      { positionX: 0, positionY: 0, scaleX: 0, scaleY: 0, rotation: 0 },
      CTX,
    );
    expect(placement.width).toBeGreaterThan(0);
    expect(placement.height).toBeGreaterThan(0);
  });

  it('lands the transformed center on the FCPXML position', () => {
    // A rotated, scaled clip: the invariant is center placement, checked by
    // re-applying our own rendering equation (geometry.rs).
    const transform = { positionX: 10, positionY: -5, scaleX: 0.8, scaleY: 0.8, rotation: -30 };
    const p = placementFromTransform(transform, CTX);
    const expectedX = CTX.canvasWidth / 2 + transform.positionX * (CTX.canvasHeight / 100);
    const expectedY = CTX.canvasHeight / 2 - transform.positionY * (CTX.canvasHeight / 100);
    const rad = (p.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const hw = p.width / 2;
    const hh = p.height / 2;
    const centerX = p.x + (hw * cos * p.scaleX - hh * sin * p.scaleY);
    const centerY = p.y + (hw * sin * p.scaleX + hh * cos * p.scaleY);
    expect(centerX).toBeCloseTo(expectedX, 6);
    expect(centerY).toBeCloseTo(expectedY, 6);
  });
});

describe('cropFromTrim (#154)', () => {
  it('converts height-percent trim back to source fractions', () => {
    const crop = cropFromTrim(
      { left: 10, top: 5, right: 0, bottom: 0 },
      CTX,
      sanitizeCrop,
    );
    // Width edges are aspect-corrected: 10% of height on a 16:9 frame.
    expect(crop?.left).toBeCloseTo(0.1 * (1080 / 1920), 6);
    expect(crop?.top).toBeCloseTo(0.05, 6);
    expect(crop?.right).toBe(0);
  });

  it('drops an all-zero trim', () => {
    expect(cropFromTrim({ left: 0, top: 0, right: 0, bottom: 0 }, CTX, sanitizeCrop)).toBeUndefined();
  });

  it('caps edges at our crop rules', () => {
    const crop = cropFromTrim({ left: 90, top: 90, right: 0, bottom: 0 }, CTX, sanitizeCrop);
    expect(crop?.left).toBeLessThanOrEqual(0.45);
    expect(crop?.top).toBeLessThanOrEqual(0.45);
  });
});
