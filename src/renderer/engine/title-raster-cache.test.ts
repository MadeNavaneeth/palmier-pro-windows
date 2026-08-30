/**
 * Coverage for the title-preview rasterization contract (title-preview
 * GPU-parity fix). No real OffscreenCanvas exists in the vitest node
 * environment, so these stub the global with a minimal fake that records
 * getImageData calls -- enough to pin the geometry contract (box-cropped vs
 * full-canvas, and the returned x/y) without rendering real pixels.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Clip } from '../../shared/types/project';
import { rasterizeTitle, clearTitleRasterCache } from './title-raster-cache';

interface ImageDataCall {
  x: number;
  y: number;
  w: number;
  h: number;
}

class FakeContext {
  getImageDataCalls: ImageDataCall[] = [];
  font = '';
  fillStyle = '';
  strokeStyle = '';
  textAlign = 'center';
  textBaseline = 'middle';
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  lineWidth = 0;
  lineJoin = 'miter';
  filter = 'none';
  save(): void {}
  restore(): void {}
  clearRect(): void {}
  fillRect(): void {}
  fillText(): void {}
  strokeText(): void {}
  drawImage(): void {}
  transform(): void {}
  measureText() {
    return { width: 40 };
  }
  getImageData(x: number, y: number, w: number, h: number) {
    this.getImageDataCalls.push({ x, y, w, h });
    return { data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4) };
  }
}

class FakeOffscreenCanvas {
  width: number;
  height: number;
  readonly ctx = new FakeContext();
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return this.ctx;
  }
}

/**
 * The first canvas constructed within one rasterizeTitle() call. An advanced
 * title's drawTitle() constructs a SECOND, inner layer canvas internally
 * (title-render.ts's makeLayer) -- only the first (outer) one is the canvas
 * rasterizeTitle itself calls getImageData on afterward.
 */
let firstCanvas: FakeOffscreenCanvas | undefined;

beforeEach(() => {
  firstCanvas = undefined;
  clearTitleRasterCache();
  vi.stubGlobal(
    'OffscreenCanvas',
    class extends FakeOffscreenCanvas {
      constructor(width: number, height: number) {
        super(width, height);
        if (!firstCanvas) firstCanvas = this;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function titleClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'title-1',
    assetId: '__title__',
    type: 'title',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 90,
    inPoint: 0,
    outPoint: 90,
    text: 'Hello',
    x: 100,
    y: 50,
    width: 400,
    height: 120,
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

describe('rasterizeTitle geometry contract', () => {
  it('crops a plain title to its own clip box, not the full canvas', () => {
    const clip = titleClip({ x: 100, y: 50, width: 400, height: 120 });
    const result = rasterizeTitle(clip, 1920, 1080);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({ width: 400, height: 120, x: 100, y: 50 });
    expect(firstCanvas!.ctx.getImageDataCalls).toEqual([{ x: 100, y: 50, w: 400, h: 120 }]);
  });

  it('keeps a full-canvas raster at the origin for an advanced title', () => {
    // titleFillMode makes isAdvancedTitle() true -- export's bake path
    // overlays this kind of title at the frame origin with no offset, and
    // difference-blends the whole frame for 'inverted', so cropping to the
    // clip's box would diverge from what export produces.
    const clip = titleClip({ x: 100, y: 50, width: 400, height: 120, titleFillMode: 'footage' });
    const result = rasterizeTitle(clip, 1920, 1080);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({ width: 1920, height: 1080, x: 0, y: 0 });
    expect(firstCanvas!.ctx.getImageDataCalls).toEqual([{ x: 0, y: 0, w: 1920, h: 1080 }]);
  });

  it('rounds a fractional box to integer pixels', () => {
    const clip = titleClip({ x: 100.5, y: 50.4, width: 399.5, height: 120.2 });
    const result = rasterizeTitle(clip, 1920, 1080);

    expect(result).toMatchObject({ x: 101, y: 50, width: 400, height: 120 });
  });

  it('floors a zero or negative box dimension to 1px instead of an empty/invalid rect', () => {
    const clip = titleClip({ width: 0, height: -50 });
    const result = rasterizeTitle(clip, 1920, 1080);

    expect(result).toMatchObject({ width: 1, height: 1 });
  });

  it('returns null for a non-title clip', () => {
    const clip = titleClip({ type: 'video' });
    expect(rasterizeTitle(clip, 1920, 1080)).toBeNull();
  });

  it('returns null for empty title text', () => {
    const clip = titleClip({ text: '' });
    expect(rasterizeTitle(clip, 1920, 1080)).toBeNull();
  });

  it('caches by clip content, not object identity', () => {
    const a = titleClip();
    const b = titleClip(); // same field values, different object reference
    const first = rasterizeTitle(a, 1920, 1080);
    const second = rasterizeTitle(b, 1920, 1080);

    expect(second).toBe(first); // cache hit -- no second getImageData call
    expect(firstCanvas!.ctx.getImageDataCalls).toHaveLength(1);
  });

  it('invalidates the cache entry when a style-relevant field changes', () => {
    const first = rasterizeTitle(titleClip({ text: 'Hello' }), 1920, 1080);
    const second = rasterizeTitle(titleClip({ text: 'Goodbye' }), 1920, 1080);

    expect(second).not.toBe(first);
  });
});
