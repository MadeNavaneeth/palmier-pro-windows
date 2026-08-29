import { describe, it, expect } from 'vitest';
import {
  applyChromaKey,
  buildChromaKeyFilterChain,
  chromaKeyEquals,
  chromaKeyOf,
  clampChromaValue,
  hasChromaKey,
  hexToRgb,
  mergeChromaKey,
  sanitizeChromaColor,
} from './chroma-key';
import type { Clip } from '../types/project';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1', trackId: 't1', type: 'video', assetId: 'a1',
    startFrame: 0, outPoint: 120, durationFrames: 120, inPoint: 0,
    x: 0, y: 0, width: 1920, height: 1080, scaleX: 1, scaleY: 1,
    anchorX: 960, anchorY: 540, rotation: 0, opacity: 1, volume: 1, muted: false,
    ...overrides,
  };
}

describe('clampChromaValue', () => {
  it('returns 0 for undefined, NaN, Infinity, and negatives', () => {
    expect(clampChromaValue(undefined)).toBe(0);
    expect(clampChromaValue(NaN)).toBe(0);
    expect(clampChromaValue(Infinity)).toBe(0);
    expect(clampChromaValue(-1)).toBe(0);
  });

  it('clamps above 1 down to 1 and passes valid values through', () => {
    expect(clampChromaValue(1.5)).toBe(1);
    expect(clampChromaValue(0.5)).toBe(0.5);
  });
});

describe('sanitizeChromaColor', () => {
  it('lowercases a valid hex color', () => {
    expect(sanitizeChromaColor('#00FF00')).toBe('#00ff00');
  });

  it('falls back to the default for invalid input', () => {
    expect(sanitizeChromaColor(undefined)).toBe('#00ff00');
    expect(sanitizeChromaColor('green')).toBe('#00ff00');
    expect(sanitizeChromaColor('#zzzzzz')).toBe('#00ff00');
    expect(sanitizeChromaColor('#fff')).toBe('#00ff00');
  });
});

describe('hasChromaKey / chromaKeyOf', () => {
  it('is inactive when chromaKey is absent', () => {
    expect(hasChromaKey(clip())).toBe(false);
    expect(chromaKeyOf(clip())).toBeNull();
  });

  it('is inactive when tolerance is exactly 0', () => {
    const c = clip({ chromaKey: { keyColor: '#00ff00', tolerance: 0 } });
    expect(hasChromaKey(c)).toBe(false);
    expect(chromaKeyOf(c)).toBeNull();
  });

  it('resolves defaults for softness and spill when active', () => {
    const c = clip({ chromaKey: { keyColor: '#00ff00', tolerance: 0.2 } });
    expect(chromaKeyOf(c)).toEqual({
      keyColor: '#00ff00', tolerance: 0.2, softness: 0.05, spill: 0.5,
    });
  });
});

describe('chromaKeyEquals', () => {
  it('treats two undefineds as equal and one-sided undefined as unequal', () => {
    expect(chromaKeyEquals(undefined, undefined)).toBe(true);
    expect(chromaKeyEquals({ keyColor: '#00ff00', tolerance: 0.1, softness: 0.05, spill: 0.5 }, undefined)).toBe(false);
  });

  it('compares field-by-field', () => {
    const a = { keyColor: '#00ff00', tolerance: 0.1, softness: 0.05, spill: 0.5 };
    const b = { ...a };
    expect(chromaKeyEquals(a, b)).toBe(true);
    expect(chromaKeyEquals(a, { ...b, tolerance: 0.2 })).toBe(false);
  });
});

describe('mergeChromaKey', () => {
  it('clears (returns undefined) when the merged tolerance is 0', () => {
    expect(mergeChromaKey(undefined, { tolerance: 0 })).toBeUndefined();
    expect(mergeChromaKey({ keyColor: '#00ff00', tolerance: 0.2 }, { tolerance: 0 })).toBeUndefined();
  });

  it('applies defaults on first activation', () => {
    const merged = mergeChromaKey(undefined, { tolerance: 0.15 });
    expect(merged).toEqual({ keyColor: '#00ff00', tolerance: 0.15, softness: 0.05, spill: 0.5 });
  });

  it('preserves untouched fields across a partial update', () => {
    const current = { keyColor: '#0000ff', tolerance: 0.3, softness: 0.1, spill: 0.7 };
    const merged = mergeChromaKey(current, { softness: 0.2 });
    expect(merged).toEqual({ keyColor: '#0000ff', tolerance: 0.3, softness: 0.2, spill: 0.7 });
  });

  it('returns the exact current reference for a true no-op call', () => {
    const current = { keyColor: '#00ff00', tolerance: 0.15, softness: 0.05, spill: 0.5 };
    const merged = mergeChromaKey(current, { tolerance: 0.15 });
    expect(merged).toBe(current);
  });

  it('returns a fresh object (not the current reference) when a value actually changes', () => {
    const current = { keyColor: '#00ff00', tolerance: 0.15, softness: 0.05, spill: 0.5 };
    const merged = mergeChromaKey(current, { tolerance: 0.3 });
    expect(merged).not.toBe(current);
    expect(merged?.tolerance).toBe(0.3);
  });
});

describe('hexToRgb', () => {
  it('parses channel values', () => {
    expect(hexToRgb('#00ff00')).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
  });
});

describe('applyChromaKey', () => {
  it('fully keys out an exact match of the key color', () => {
    const pixels = new Uint8ClampedArray([0, 255, 0, 255]); // pure green
    applyChromaKey(pixels, { keyColor: '#00ff00', tolerance: 0.2, softness: 0, spill: 0 });
    expect(pixels[3]).toBe(0);
  });

  it('leaves a far-from-key-color pixel fully opaque', () => {
    const pixels = new Uint8ClampedArray([255, 0, 0, 255]); // pure red
    applyChromaKey(pixels, { keyColor: '#00ff00', tolerance: 0.2, softness: 0, spill: 0 });
    expect(pixels[3]).toBe(255);
  });

  it('feathers a pixel in the softness band to partial alpha', () => {
    // A pixel a small distance from pure key green — with tolerance 0 the
    // inner threshold sits at the key color itself, so this pixel's nonzero
    // distance falls inside the softness band rather than being fully keyed.
    const pixels = new Uint8ClampedArray([40, 255, 40, 255]);
    applyChromaKey(pixels, { keyColor: '#00ff00', tolerance: 0, softness: 0.5, spill: 0 });
    expect(pixels[3]).toBeGreaterThan(0);
    expect(pixels[3]).toBeLessThan(255);
  });

  it('desaturates a partially-keyed green pixel toward luma when spill > 0', () => {
    const pixels = new Uint8ClampedArray([0, 255, 0, 255]);
    applyChromaKey(pixels, { keyColor: '#00ff00', tolerance: 0, softness: 0.5, spill: 1 });
    // Full spill on a partially-keyed pixel should reduce green below 255.
    expect(pixels[1]).toBeLessThan(255);
  });

  it('skips fully transparent pixels without modifying them', () => {
    const pixels = new Uint8ClampedArray([0, 255, 0, 0]);
    applyChromaKey(pixels, { keyColor: '#00ff00', tolerance: 0.5, softness: 0, spill: 1 });
    expect([...pixels]).toEqual([0, 255, 0, 0]);
  });

  it('accepts a Uint8Array (Node Buffer) input', () => {
    const pixels = Buffer.from([0, 255, 0, 255]);
    applyChromaKey(pixels, { keyColor: '#00ff00', tolerance: 0.2, softness: 0, spill: 0 });
    expect(pixels[3]).toBe(0);
  });
});

describe('buildChromaKeyFilterChain', () => {
  it('emits a colorkey filter with the key color as 0x-prefixed hex', () => {
    const chain = buildChromaKeyFilterChain({ keyColor: '#00ff00', tolerance: 0.15, softness: 0.05, spill: 0 });
    expect(chain).toContain('colorkey=color=0x00ff00');
    expect(chain).toContain('similarity=0.150000');
    expect(chain).toContain('blend=0.050000');
  });

  it('never emits a similarity of exactly 0 (FFmpeg rejects it)', () => {
    const chain = buildChromaKeyFilterChain({ keyColor: '#00ff00', tolerance: 0, softness: 0, spill: 0 });
    expect(chain).not.toContain('similarity=0.000000');
  });

  it('omits despill when spill is 0', () => {
    const chain = buildChromaKeyFilterChain({ keyColor: '#00ff00', tolerance: 0.15, softness: 0.05, spill: 0 });
    expect(chain).not.toContain('despill');
  });

  it('adds a green-screen despill for a green key color', () => {
    const chain = buildChromaKeyFilterChain({ keyColor: '#00ff00', tolerance: 0.15, softness: 0.05, spill: 0.5 });
    expect(chain).toContain('despill=type=green');
    expect(chain).toContain('green=-0.500000');
  });

  it('adds a blue-screen despill for a blue key color', () => {
    const chain = buildChromaKeyFilterChain({ keyColor: '#0000ff', tolerance: 0.15, softness: 0.05, spill: 0.5 });
    expect(chain).toContain('despill=type=blue');
    expect(chain).toContain('blue=-0.500000');
  });
});
