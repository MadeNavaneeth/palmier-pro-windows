/**
 * Regression coverage for the playback rate model (upstream issue #212).
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  PLAYBACK_RATE_PRESETS,
  normalizePlaybackRate,
  playbackRateLabel,
  shuttleForward,
  shuttleReverse,
} from './playback-rate';

describe('playback rate presets', () => {
  it('offers quarter speed, which the upstream issue asked for', () => {
    expect(PLAYBACK_RATE_PRESETS).toContain(0.25);
    expect(Math.min(...PLAYBACK_RATE_PRESETS)).toBe(MIN_PLAYBACK_RATE);
    expect(Math.max(...PLAYBACK_RATE_PRESETS)).toBe(MAX_PLAYBACK_RATE);
  });

  it('lists rates in ascending order with no duplicates', () => {
    const rates = [...PLAYBACK_RATE_PRESETS];
    expect(rates).toEqual([...rates].sort((a, b) => a - b));
    expect(new Set(rates).size).toBe(rates.length);
  });

  it('normalizes every preset to itself', () => {
    for (const rate of PLAYBACK_RATE_PRESETS) {
      expect(normalizePlaybackRate(rate)).toBe(rate);
    }
  });
});

describe('normalizePlaybackRate', () => {
  it('preserves direction while clamping magnitude', () => {
    expect(normalizePlaybackRate(-2)).toBe(-2);
    expect(normalizePlaybackRate(-100)).toBe(-MAX_PLAYBACK_RATE);
    expect(normalizePlaybackRate(100)).toBe(MAX_PLAYBACK_RATE);
    expect(normalizePlaybackRate(0.01)).toBe(MIN_PLAYBACK_RATE);
    expect(normalizePlaybackRate(-0.01)).toBe(-MIN_PLAYBACK_RATE);
  });

  it('never returns a rate that would stall or poison the playback loop', () => {
    // The loop accumulates elapsed * |rate|; NaN or Infinity there freezes
    // playback for the rest of the session.
    expect(normalizePlaybackRate(Number.NaN)).toBe(1);
    expect(normalizePlaybackRate(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalizePlaybackRate(Number.NEGATIVE_INFINITY)).toBe(1);
    expect(normalizePlaybackRate(undefined as unknown as number)).toBe(1);
    expect(normalizePlaybackRate('2' as unknown as number)).toBe(1);
    expect(normalizePlaybackRate(0)).toBe(MIN_PLAYBACK_RATE);
  });
});

describe('J / L shuttle', () => {
  it('steps forward through the shuttle rates and stops at the top', () => {
    expect(shuttleForward(1)).toBe(2);
    expect(shuttleForward(2)).toBe(4);
    expect(shuttleForward(4)).toBe(8);
    expect(shuttleForward(8)).toBe(8);
  });

  it('reverses to forward playback before ramping up', () => {
    expect(shuttleForward(-4)).toBe(1);
    expect(shuttleReverse(2)).toBe(-1);
  });

  it('steps faster in reverse and stops at the top', () => {
    expect(shuttleReverse(-1)).toBe(-2);
    expect(shuttleReverse(-2)).toBe(-4);
    expect(shuttleReverse(-4)).toBe(-8);
    expect(shuttleReverse(-8)).toBe(-8);
  });

  it('ramps up from a slow review rate rather than jumping past it', () => {
    expect(shuttleForward(0.25)).toBe(1);
    expect(shuttleReverse(-0.25)).toBe(-1);
  });

  it('recovers from an invalid current rate', () => {
    expect(shuttleForward(Number.NaN)).toBe(2);
    expect(shuttleReverse(Number.NaN)).toBe(-1);
  });
});

describe('playbackRateLabel', () => {
  it('labels magnitude, since direction is shown by the transport', () => {
    expect(playbackRateLabel(0.25)).toBe('0.25x');
    expect(playbackRateLabel(-2)).toBe('2x');
    expect(playbackRateLabel(Number.NaN)).toBe('1x');
  });
});
