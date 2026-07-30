import { describe, it, expect } from 'vitest';
import {
  detectSilentRanges,
  normalizeSilenceConfig,
  resolveSilenceConfig,
  planSilenceRemoval,
  DEFAULT_SILENCE_CONFIG,
  SILENCE_LIMITS,
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

// ─── Configurable silence removal controls (upstream PR #426) ────────────────

describe('normalizeSilenceConfig', () => {
  it('falls back to the defaults for missing input', () => {
    expect(normalizeSilenceConfig(undefined)).toEqual(DEFAULT_SILENCE_CONFIG);
    expect(normalizeSilenceConfig({})).toEqual(DEFAULT_SILENCE_CONFIG);
  });

  it('keeps values that are already in range', () => {
    expect(normalizeSilenceConfig({ thresholdDb: -40, minSilenceSec: 1.5, edgePaddingSec: 0.3 }))
      .toEqual({ thresholdDb: -40, minSilenceSec: 1.5, edgePaddingSec: 0.3 });
  });

  it('clamps each control to its documented range', () => {
    expect(normalizeSilenceConfig({ minSilenceSec: 0.01 }).minSilenceSec)
      .toBe(SILENCE_LIMITS.minSilenceSec.min);
    expect(normalizeSilenceConfig({ minSilenceSec: 900 }).minSilenceSec)
      .toBe(SILENCE_LIMITS.minSilenceSec.max);
    expect(normalizeSilenceConfig({ edgePaddingSec: -5 }).edgePaddingSec)
      .toBe(SILENCE_LIMITS.edgePaddingSec.min);
    expect(normalizeSilenceConfig({ edgePaddingSec: 9 }).edgePaddingSec)
      .toBe(SILENCE_LIMITS.edgePaddingSec.max);
    expect(normalizeSilenceConfig({ thresholdDb: 40 }).thresholdDb)
      .toBe(SILENCE_LIMITS.thresholdDb.max);
    expect(normalizeSilenceConfig({ thresholdDb: -900 }).thresholdDb)
      .toBe(SILENCE_LIMITS.thresholdDb.min);
  });

  it('rejects non-finite input, which would otherwise report everything silent', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const config = normalizeSilenceConfig({
        thresholdDb: bad,
        minSilenceSec: bad,
        edgePaddingSec: bad,
      });
      expect(config).toEqual(DEFAULT_SILENCE_CONFIG);
    }
  });

  it('rejects non-numeric input arriving over IPC or MCP', () => {
    const config = normalizeSilenceConfig({
      thresholdDb: '-35' as unknown as number,
      minSilenceSec: null as unknown as number,
      edgePaddingSec: {} as unknown as number,
    });
    expect(config).toEqual(DEFAULT_SILENCE_CONFIG);
  });

  it('falls back to a supplied base instead of the built-in defaults', () => {
    const saved = { thresholdDb: -50, minSilenceSec: 1.2, edgePaddingSec: 0.4 };

    // This is what makes a partial write behave as an override of the saved
    // controls rather than a reset of the fields it omits.
    expect(normalizeSilenceConfig({ minSilenceSec: 2 }, saved)).toEqual({
      thresholdDb: -50,
      minSilenceSec: 2,
      edgePaddingSec: 0.4,
    });
  });
});

describe('resolveSilenceConfig', () => {
  const saved = { thresholdDb: -50, minSilenceSec: 1.2, edgePaddingSec: 0.4 };

  it('uses the saved controls when no override is supplied', () => {
    // The contract upstream PR #426 documents: a remove_silence call with no
    // arguments must perform the edit the visible controls describe.
    expect(resolveSilenceConfig(saved, undefined)).toEqual(saved);
    expect(resolveSilenceConfig(saved, {})).toEqual(saved);
  });

  it('applies a supplied field as a one-shot override, leaving the rest saved', () => {
    expect(resolveSilenceConfig(saved, { minSilenceSec: 0.5 })).toEqual({
      thresholdDb: -50,
      minSilenceSec: 0.5,
      edgePaddingSec: 0.4,
    });
  });

  it('clamps an out-of-range override rather than discarding it', () => {
    // Clamping, not falling back: a request for a shorter pause than the minimum
    // still means "as short as allowed", not "leave it as it was". The Agent tool
    // schema refuses such a value earlier; this is the IPC path's backstop.
    expect(resolveSilenceConfig(saved, { minSilenceSec: 0.01 }).minSilenceSec)
      .toBe(SILENCE_LIMITS.minSilenceSec.min);
  });

  it('ignores an unusable override and keeps the saved value', () => {
    expect(resolveSilenceConfig(saved, { edgePaddingSec: Number.NaN }).edgePaddingSec)
      .toBe(saved.edgePaddingSec);
  });

  it('repairs corrupt saved settings before they can govern a removal', () => {
    // The settings file is user-writable; a hand-edited zero would cut on
    // natural speech rhythm.
    const config = resolveSilenceConfig({ minSilenceSec: 0 }, undefined);
    expect(config.minSilenceSec).toBe(SILENCE_LIMITS.minSilenceSec.min);
    expect(config.thresholdDb).toBe(DEFAULT_SILENCE_CONFIG.thresholdDb);
  });
});

describe('edge padding at the boundaries of the material', () => {
  const hop = 0.1;
  const loud = 1;
  const quiet = 0;
  const config = { thresholdDb: -35, minSilenceSec: 0.25, edgePaddingSec: 0.1 };

  it('does not pad a silent run that starts the material', () => {
    // 0.5s silence, then speech. Nothing precedes the silence, so there is no
    // transient to protect and the whole span is removable.
    const envelope = [quiet, quiet, quiet, quiet, quiet, loud, loud];
    const [range] = detectSilentRanges(envelope, hop, config);

    expect(range.startSec).toBeCloseTo(0, 6);
    // Trailing side borders speech, so it keeps the padding.
    expect(range.endSec).toBeCloseTo(0.5 - 0.1, 6);
  });

  it('does not pad a silent run that ends the material', () => {
    const envelope = [loud, loud, quiet, quiet, quiet, quiet, quiet];
    const [range] = detectSilentRanges(envelope, hop, config);

    expect(range.startSec).toBeCloseTo(0.2 + 0.1, 6);
    expect(range.endSec).toBeCloseTo(0.7, 6);
  });

  it('pads both sides of an interior run', () => {
    const envelope = [loud, quiet, quiet, quiet, quiet, quiet, loud];
    const [range] = detectSilentRanges(envelope, hop, config);

    expect(range.startSec).toBeCloseTo(0.1 + 0.1, 6);
    expect(range.endSec).toBeCloseTo(0.6 - 0.1, 6);
  });

  it('removes an entirely silent input in full', () => {
    const envelope = [quiet, quiet, quiet, quiet, quiet];
    const [range] = detectSilentRanges(envelope, hop, config);

    expect(range.startSec).toBeCloseTo(0, 6);
    expect(range.endSec).toBeCloseTo(0.5, 6);
  });

  it('still honours the minimum pause at the boundaries', () => {
    // 0.2s of leading silence is below the 0.25s minimum and stays.
    const envelope = [quiet, quiet, loud, loud, loud];
    expect(detectSilentRanges(envelope, hop, config)).toEqual([]);
  });
});
