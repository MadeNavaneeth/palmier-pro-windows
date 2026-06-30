import { describe, it, expect } from 'vitest';
import {
  detectSilentRanges,
  planSilenceRemoval,
  DEFAULT_SILENCE_CONFIG,
  type FrameRange,
} from './silence-detector';

describe('detectSilentRanges', () => {
  const hop = 0.1; // 100ms per sample

  it('finds a silent gap between two loud regions', () => {
    // 0.0-0.3 loud, 0.3-1.0 silent (0.7s), 1.0-1.3 loud
    const env = [0.5, 0.5, 0.5, ...Array(7).fill(0.0001), 0.5, 0.5, 0.5];
    const ranges = detectSilentRanges(env, hop, { thresholdDb: -35, minSilenceSec: 0.3, edgePaddingSec: 0 });
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startSec).toBeCloseTo(0.3, 5);
    expect(ranges[0].endSec).toBeCloseTo(1.0, 5);
  });

  it('ignores gaps shorter than minSilenceSec', () => {
    const env = [0.5, 0.0001, 0.0001, 0.5]; // 0.2s gap
    const ranges = detectSilentRanges(env, hop, { thresholdDb: -35, minSilenceSec: 0.5, edgePaddingSec: 0 });
    expect(ranges).toHaveLength(0);
  });

  it('applies edge padding by shrinking the silent span', () => {
    const env = [0.5, ...Array(10).fill(0.0001), 0.5]; // 1.0s silence from 0.1 to 1.1
    const ranges = detectSilentRanges(env, hop, { thresholdDb: -35, minSilenceSec: 0.3, edgePaddingSec: 0.2 });
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startSec).toBeCloseTo(0.3, 5); // 0.1 + 0.2 padding
    expect(ranges[0].endSec).toBeCloseTo(0.9, 5); // 1.1 - 0.2 padding
  });

  it('handles all-silent and all-loud inputs', () => {
    const allSilent = Array(10).fill(0.0001);
    expect(detectSilentRanges(allSilent, hop, { thresholdDb: -35, minSilenceSec: 0.3, edgePaddingSec: 0 })).toHaveLength(1);
    const allLoud = Array(10).fill(0.5);
    expect(detectSilentRanges(allLoud, hop, DEFAULT_SILENCE_CONFIG)).toHaveLength(0);
  });

  it('returns nothing for empty input', () => {
    expect(detectSilentRanges([], hop)).toHaveLength(0);
  });
});

describe('planSilenceRemoval', () => {
  it('keeps the complement of silent ranges and reports removed frames', () => {
    // clip source [0, 300); remove [100, 150) and [200, 250)
    const silent: FrameRange[] = [{ start: 100, end: 150 }, { start: 200, end: 250 }];
    const plan = planSilenceRemoval(0, 300, silent);
    expect(plan.removedFrames).toBe(100);
    expect(plan.kept).toEqual([
      { inPoint: 0, outPoint: 100 },
      { inPoint: 150, outPoint: 200 },
      { inPoint: 250, outPoint: 300 },
    ]);
  });

  it('merges overlapping silent ranges', () => {
    const silent: FrameRange[] = [{ start: 100, end: 200 }, { start: 150, end: 250 }];
    const plan = planSilenceRemoval(0, 300, silent);
    expect(plan.removedFrames).toBe(150);
    expect(plan.kept).toEqual([
      { inPoint: 0, outPoint: 100 },
      { inPoint: 250, outPoint: 300 },
    ]);
  });

  it('clamps ranges to the clip bounds', () => {
    const silent: FrameRange[] = [{ start: -50, end: 50 }, { start: 280, end: 400 }];
    const plan = planSilenceRemoval(0, 300, silent);
    expect(plan.kept).toEqual([{ inPoint: 50, outPoint: 280 }]);
    expect(plan.removedFrames).toBe(70); // 50 at head + 20 at tail
  });

  it('returns the whole clip kept when nothing is silent', () => {
    const plan = planSilenceRemoval(0, 300, []);
    expect(plan.removedFrames).toBe(0);
    expect(plan.kept).toEqual([{ inPoint: 0, outPoint: 300 }]);
  });
});
