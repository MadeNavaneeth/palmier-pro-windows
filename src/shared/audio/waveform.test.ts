import { describe, it, expect } from 'vitest';
import { bucketPeaks, slicePeaks } from './waveform';

describe('bucketPeaks', () => {
  it('takes the max of each hop range', () => {
    const peaks = bucketPeaks([0.1, 0.9, 0.2, 0.8, 0.3, 0.7], 3);
    expect(peaks).toEqual([0.9, 0.8, 0.7]);
  });

  it('always returns exactly the requested bucket count', () => {
    expect(bucketPeaks([0.5], 64)).toHaveLength(64);
    expect(bucketPeaks([], 16)).toEqual(new Array(16).fill(0));
  });

  it('clamps values into [0,1]', () => {
    expect(bucketPeaks([-5, 2], 2)).toEqual([0, 1]);
  });
});

describe('slicePeaks', () => {
  const ramp = [0, 0.25, 0.5, 0.75, 1];

  it('returns the full curve for a full-length window', () => {
    expect(slicePeaks(ramp, 0, 1, 5)).toEqual(ramp);
  });

  it('slices to the trimmed window with linear resampling', () => {
    // Middle half of the ramp: values between 0.25 and 0.75.
    const out = slicePeaks(ramp, 0.25, 0.75, 5);
    expect(out[0]).toBeCloseTo(0.25);
    expect(out[4]).toBeCloseTo(0.75);
    expect(out[2]).toBeCloseTo(0.5);
  });

  it('pads empty sources and clamps inverted windows', () => {
    expect(slicePeaks([], 0, 1, 8)).toHaveLength(8);
    expect(slicePeaks(ramp, 0.8, 0.2, 3).every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});
