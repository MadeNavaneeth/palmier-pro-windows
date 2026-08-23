import { describe, it, expect } from 'vitest';
import { clampPan, stereoBalanceGains, ffmpegPanFilter } from './pan';

describe('stereoBalanceGains', () => {
  it('is identity at center', () => {
    expect(stereoBalanceGains(0)).toEqual({ left: 1, right: 1 });
  });

  it('attenuates right when panning left, and vice versa', () => {
    expect(stereoBalanceGains(-1)).toEqual({ left: 1, right: 0 });
    expect(stereoBalanceGains(1)).toEqual({ left: 0, right: 1 });
    const half = stereoBalanceGains(0.5);
    expect(half.left).toBeCloseTo(0.5);
    expect(half.right).toBe(1);
  });

  it('clamps out-of-range and garbage to center gains', () => {
    expect(stereoBalanceGains(5)).toEqual({ left: 0, right: 1 });
    expect(stereoBalanceGains(Number.NaN)).toEqual({ left: 1, right: 1 });
  });
});

describe('ffmpegPanFilter', () => {
  it('produces the balance pan string', () => {
    expect(ffmpegPanFilter(-1)).toBe('pan=stereo|c0=c0*1.0000|c1=c1*0.0000');
    expect(ffmpegPanFilter(0.5)).toContain('c0=c0*0.5000');
  });

  it('is identity at center so callers can skip the filter', () => {
    expect(ffmpegPanFilter(0)).toBe('pan=stereo|c0=c0*1.0000|c1=c1*1.0000');
  });
});
