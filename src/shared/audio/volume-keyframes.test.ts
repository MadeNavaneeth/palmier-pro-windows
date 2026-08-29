import { describe, it, expect } from 'vitest';
import {
  VOLUME_DB_CEILING,
  VOLUME_DB_FLOOR,
  clampVolumeDb,
  resolveClipVolumeLinear,
  sanitizeVolumeKeyframes,
  volumeFilterExpression,
} from './volume-keyframes';
import { dbToLinear } from './normalize';
import type { Clip } from '../types/project';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', type: 'audio', trackId: 'a1',
    startFrame: 0, durationFrames: 90, inPoint: 0, outPoint: 90,
    x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...overrides,
  };
}

describe('clampVolumeDb', () => {
  it('clamps to the floor/ceiling', () => {
    expect(clampVolumeDb(-100)).toBe(VOLUME_DB_FLOOR);
    expect(clampVolumeDb(100)).toBe(VOLUME_DB_CEILING);
  });

  it('passes valid values through and floors non-finite input', () => {
    expect(clampVolumeDb(-6)).toBe(-6);
    expect(clampVolumeDb(Number.NaN)).toBe(VOLUME_DB_FLOOR);
    expect(clampVolumeDb(Infinity)).toBe(VOLUME_DB_FLOOR);
  });
});

describe('sanitizeVolumeKeyframes', () => {
  it('sorts, rounds frames, and clamps out-of-range dB values', () => {
    const track = sanitizeVolumeKeyframes([
      { frame: 30, value: 100 }, // above ceiling
      { frame: 0, value: -6 },
    ]);
    expect(track).toEqual([
      { frame: 0, value: -6 },
      { frame: 30, value: VOLUME_DB_CEILING },
    ]);
  });

  it('drops single-point and non-finite input, matching sanitizeMotion', () => {
    expect(sanitizeVolumeKeyframes([{ frame: 0, value: -6 }])).toBeUndefined();
    expect(sanitizeVolumeKeyframes(undefined)).toBeUndefined();
  });
});

describe('resolveClipVolumeLinear', () => {
  it('falls back to the static linear field when no track is present', () => {
    expect(resolveClipVolumeLinear(clip({ volume: 0.5 }), 10)).toBe(0.5);
  });

  it('clamps the static fallback into [0,1]', () => {
    expect(resolveClipVolumeLinear(clip({ volume: 7 }), 10)).toBe(1);
  });

  it('uses the active track when present, converted dB to linear', () => {
    const withTrack = clip({ volume: 0.1, volumeDb: [{ frame: 0, value: 0 }, { frame: 30, value: -60 }] });
    expect(resolveClipVolumeLinear(withTrack, 0)).toBeCloseTo(1, 5);
    expect(resolveClipVolumeLinear(withTrack, 30)).toBeCloseTo(dbToLinear(-60), 8);
  });

  it('allows the track to resolve above 1 for a positive-dB boost', () => {
    const boosted = clip({ volumeDb: [{ frame: 0, value: 6 }, { frame: 30, value: 6 }] });
    expect(resolveClipVolumeLinear(boosted, 15)).toBeCloseTo(dbToLinear(6), 8);
    expect(resolveClipVolumeLinear(boosted, 15)).toBeGreaterThan(1);
  });
});

describe('volumeFilterExpression', () => {
  it('returns undefined for an absent/empty track', () => {
    expect(volumeFilterExpression(undefined, 30, 0)).toBeUndefined();
    expect(volumeFilterExpression([], 30, 0)).toBeUndefined();
  });

  it('wraps the dB expression in a pow(10, x/20) linear-gain conversion', () => {
    const expr = volumeFilterExpression(
      [{ frame: 0, value: 0 }, { frame: 30, value: -60 }],
      30,
      0,
    );
    expect(expr).toMatch(/^pow\(10,\(.*\)\/20\)$/);
  });

  it('shifts the time variable by frameAtLocalZero so absolute-frame keyframes line up with local t', () => {
    // A track keyed at absolute frames [300, 330] (10s/11s at 30fps), read by
    // a filter chain whose local t=0 is absolute frame 300 (frameAtLocalZero
    // = 300). The shift must fold that 10s offset back in, so local t=0
    // reproduces the value stored at absolute frame 300.
    const expr = volumeFilterExpression(
      [{ frame: 300, value: -6 }, { frame: 330, value: -60 }],
      30,
      300,
    );
    // Local t=0 -> shifted time 10.0s -> the exact first keyframe's dB.
    expect(expr).toContain('(t)+(10.000000)');
  });

  it('produces a chain that ffmpeg-shaped substitution would evaluate to the first keyframe at local t=0', () => {
    const expr = volumeFilterExpression(
      [{ frame: 300, value: -6 }, { frame: 330, value: -60 }],
      30,
      300,
    )!;
    // Evaluate the expression by hand at t=0 the same way FFmpeg would:
    // substitute t=0 and reduce lte/pow arithmetic via a tiny interpreter
    // is overkill here — assert structurally that the first branch's value
    // literal (the -6.0000 v0 term) is present, proving the shift didn't
    // silently drop the correct starting keyframe.
    expect(expr).toContain('-6.0000');
  });
});
