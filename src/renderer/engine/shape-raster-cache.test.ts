/**
 * Coverage for the shape rasterization contract: box-cropped buffers at the
 * clip position, null for non-shapes and empty shapes, and content-keyed
 * caching. Stubs OffscreenCanvas like the title cache tests do.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Clip } from '../../shared/types/project';
import { rasterizeShape, clearShapeRasterCache } from './shape-raster-cache';

interface ImageDataCall {
  x: number;
  y: number;
  w: number;
  h: number;
}

class FakeContext {
  getImageDataCalls: ImageDataCall[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  lineJoin = 'miter';
  lineCap = 'butt';
  save(): void {}
  restore(): void {}
  clearRect(): void {}
  beginPath(): void {}
  rect(): void {}
  ellipse(): void {}
  moveTo(): void {}
  lineTo(): void {}
  fill(): void {}
  stroke(): void {}
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

let firstCanvas: FakeOffscreenCanvas | undefined;

beforeEach(() => {
  firstCanvas = undefined;
  clearShapeRasterCache();
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

function shapeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'shape-1',
    assetId: '__shape__',
    type: 'shape',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 90,
    inPoint: 0,
    outPoint: 90,
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
    shapeKind: 'arrow',
    shapeStrokeColor: '#ff0000',
    shapeStrokeWidth: 6,
    ...overrides,
  } as Clip;
}

describe('rasterizeShape geometry contract', () => {
  it('crops to the clip box at the clip position', () => {
    const result = rasterizeShape(shapeClip());

    expect(result).not.toBeNull();
    expect(result).toMatchObject({ width: 400, height: 120, x: 100, y: 50 });
    expect(result!.data).toHaveLength(400 * 120 * 4);
    expect(firstCanvas!.ctx.getImageDataCalls).toEqual([{ x: 0, y: 0, w: 400, h: 120 }]);
  });

  it('returns null for non-shape clips and content-free shapes', () => {
    expect(rasterizeShape(shapeClip({ type: 'video' }))).toBeNull();
    expect(rasterizeShape(shapeClip({ shapeStrokeWidth: 0 }))).toBeNull();
  });

  it('caches by content and invalidates on style or box change', () => {
    const first = rasterizeShape(shapeClip());
    const second = rasterizeShape(shapeClip());
    expect(second).toBe(first);
    expect(firstCanvas!.ctx.getImageDataCalls).toHaveLength(1);

    expect(rasterizeShape(shapeClip({ shapeStrokeColor: '#00ff00' }))).not.toBe(first);
    expect(rasterizeShape(shapeClip({ width: 401 }))).not.toBe(first);
  });
});
