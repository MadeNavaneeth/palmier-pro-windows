import { describe, it, expect } from 'vitest';
import type { Clip } from '../types/project';
import {
  EQ_LIMITS,
  eqBiquadParams,
  eqFilterChain,
  eqOf,
  hasEq,
  sanitizeEq,
} from './eq';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', type: 'audio', trackId: 'a1',
    startFrame: 0, durationFrames: 10, inPoint: 0, outPoint: 10,
    x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...overrides,
  };
}

describe('eqOf / hasEq (#158)', () => {
  it('is null and false for a structurally neutral clip', () => {
    expect(eqOf(clip())).toBeNull();
    expect(hasEq(clip())).toBe(false);
    expect(eqOf(clip({ eqLowDb: 0, eqMidDb: 0, eqHighDb: 0 }))).toBeNull();
  });

  it('returns the bands when any differs from neutral', () => {
    expect(eqOf(clip({ eqHighDb: 6 }))).toEqual({ lowDb: 0, midDb: 0, highDb: 6 });
    expect(hasEq(clip({ eqHighDb: 6 }))).toBe(true);
  });
});

describe('sanitizeEq (#158)', () => {
  it('keeps finite in-range values and drops out-of-range ones', () => {
    expect(sanitizeEq({ lowDb: 6, midDb: -3 })).toEqual({ lowDb: 6, midDb: -3 });
    expect(sanitizeEq({ lowDb: 99 })).toEqual({});
    expect(sanitizeEq({ midDb: -40 })).toEqual({});
    expect(sanitizeEq({ highDb: Number.NaN })).toEqual({});
    expect(sanitizeEq(undefined)).toEqual({});
  });

  it('accepts every boundary value', () => {
    expect(sanitizeEq({ lowDb: EQ_LIMITS.lowDb.min })).toEqual({ lowDb: EQ_LIMITS.lowDb.min });
    expect(sanitizeEq({ highDb: EQ_LIMITS.highDb.max })).toEqual({ highDb: EQ_LIMITS.highDb.max });
  });
});

describe('eqFilterChain (#158)', () => {
  it('emits bass/equalizer/treble for the set bands only', () => {
    expect(eqFilterChain({ lowDb: 3, midDb: -2, highDb: 6 })).toBe(
      'bass=g=+3,equalizer=f=1000:t=q:w=1:g=-2,treble=g=+6',
    );
    expect(eqFilterChain({ lowDb: 0, midDb: 4, highDb: 0 })).toBe(
      'equalizer=f=1000:t=q:w=1:g=+4',
    );
  });

  it('is empty when neutral', () => {
    expect(eqFilterChain({ lowDb: 0, midDb: 0, highDb: 0 })).toBe('');
  });
});

describe('eqBiquadParams (#158)', () => {
  it('matches the export bands: 100 Hz shelf, 1 kHz bell (Q 1), 3 kHz shelf', () => {
    const params = eqBiquadParams({ lowDb: 3, midDb: -2, highDb: 6 });
    expect(params).toEqual([
      { type: 'lowshelf', frequency: 100, gain: 3 },
      { type: 'peaking', frequency: 1000, q: 1, gain: -2 },
      { type: 'highshelf', frequency: 3000, gain: 6 },
    ]);
  });
});
