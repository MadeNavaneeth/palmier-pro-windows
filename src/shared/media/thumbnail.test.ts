import { describe, expect, it } from 'vitest';
import { downscaleRgba, thumbnailSize } from './thumbnail';

/** A 4x4 RGBA image: red in the top-left quadrant, blue elsewhere. */
function sampleImage(): Uint8Array {
  const src = new Uint8Array(4 * 4 * 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      const topLeft = x < 2 && y < 2;
      src[i] = topLeft ? 255 : 0;
      src[i + 1] = 0;
      src[i + 2] = topLeft ? 0 : 255;
      src[i + 3] = 255;
    }
  }
  return src;
}

describe('thumbnailSize (#552)', () => {
  it('preserves the canvas aspect ratio at the target height', () => {
    expect(thumbnailSize(1920, 1080, 36)).toEqual({ width: 64, height: 36 });
    expect(thumbnailSize(1080, 1920, 36)).toEqual({ width: 20, height: 36 });
  });

  it('caps the width for extreme ratios and keeps a usable size', () => {
    expect(thumbnailSize(10000, 100, 36).width).toBe(160);
    expect(thumbnailSize(0, 0, 36)).toEqual({ width: 64, height: 36 });
  });
});

describe('downscaleRgba (#552)', () => {
  it('box-averages the source into quadrants', () => {
    const out = downscaleRgba(sampleImage(), 4, 4, 2, 2);
    // Top-left destination pixel averages the red quadrant.
    expect([...out.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    // Top-right destination pixel averages the blue region.
    expect([...out.slice(4, 8)]).toEqual([0, 0, 255, 255]);
    expect(out.length).toBe(2 * 2 * 4);
  });

  it('returns the source unchanged when the size matches', () => {
    const src = sampleImage();
    expect(downscaleRgba(src, 4, 4, 4, 4)).toBe(src);
  });

  it('never produces an empty buffer from bad geometry', () => {
    const src = sampleImage();
    const out = downscaleRgba(src, 4, 4, 0, 0);
    expect(out.length).toBe(4); // clamped to 1x1
    expect(out[3]).toBe(255);
    // A short source is passed through rather than read out of bounds.
    expect(downscaleRgba(new Uint8Array(3), 4, 4, 2, 2).length).toBe(3);
  });
});
