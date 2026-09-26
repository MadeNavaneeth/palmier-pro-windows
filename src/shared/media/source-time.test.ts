/**
 * Regression coverage for timeline-frame to source-time mapping
 * (upstream issue #68).
 */

import { describe, it, expect } from 'vitest';
import {
  assetDurationSeconds,
  clampSourceSeconds,
  clipTrimSeconds,
  isSourceSeekable,
  projectFramesToSeconds,
  secondsToProjectFrames,
  sourceFrameForSeconds,
  sourceSecondsForTimelineFrame,
  timelineFrameForSourceSeconds,
} from './source-time';

const clip = { startFrame: 300, inPoint: 60, outPoint: 960, durationFrames: 900 };

describe('project frame conversion', () => {
  it('converts frames to seconds with the project rate', () => {
    expect(projectFramesToSeconds(30, 30)).toBe(1);
    expect(projectFramesToSeconds(45, 30)).toBe(1.5);
    expect(secondsToProjectFrames(1.5, 30)).toBe(45);
  });

  it('refuses unusable rates and values instead of producing Infinity or NaN', () => {
    expect(projectFramesToSeconds(30, 0)).toBe(0);
    expect(projectFramesToSeconds(30, -30)).toBe(0);
    expect(projectFramesToSeconds(30, Number.NaN)).toBe(0);
    expect(projectFramesToSeconds(Number.POSITIVE_INFINITY, 30)).toBe(0);
    expect(secondsToProjectFrames(Number.NaN, 30)).toBe(0);
  });
});

describe('source seconds for a timeline frame', () => {
  it('maps through the project rate, not the source rate', () => {
    // 10s into the clip at 30 fps project rate: 300 timeline frames past the
    // clip start, plus a 2s trim in.
    expect(sourceSecondsForTimelineFrame(clip, 600, 30)).toBeCloseTo(12, 6);
  });

  it('gives the same source time for a 60 fps and a 24 fps source', () => {
    // The source frame rate must not influence the seek target. Before the fix,
    // a 60 fps source in a 30 fps timeline landed at half this value.
    const at = sourceSecondsForTimelineFrame(clip, 900, 30);
    expect(at).toBeCloseTo(22, 6);
  });

  it('scales with the project rate', () => {
    const sixty = { startFrame: 600, inPoint: 120, outPoint: 1920, durationFrames: 1800 };
    // Same wall-clock layout at 60 fps: 10s in, 2s trim.
    expect(sourceSecondsForTimelineFrame(sixty, 1200, 60)).toBeCloseTo(12, 6);
  });

  it('starts at the trim point for the clip first frame', () => {
    expect(sourceSecondsForTimelineFrame(clip, clip.startFrame, 30)).toBeCloseTo(2, 6);
  });

  it('never returns a negative offset for a frame before the clip', () => {
    expect(sourceSecondsForTimelineFrame(clip, 0, 30)).toBe(0);
  });

  it('guards a non-finite frame', () => {
    expect(sourceSecondsForTimelineFrame(clip, Number.NaN, 30)).toBe(0);
  });
});

describe('timeline frame for a source offset', () => {
  it('is the inverse of sourceSecondsForTimelineFrame, speed included', () => {
    // A clip 10s long on the timeline consumes 10x speed source seconds and
    // opens its source window at the in point. Every speed must round-trip
    // back to the source second it came from within half a timeline frame:
    // silence detection reports source seconds, so this is the direction that
    // decides which audio gets cut.
    for (const speed of [0.5, 1, 1.5, 2, 4]) {
      const sped = { ...clip, speed };
      const tolerance = (0.5 * speed) / 30 + 1e-9; // half a timeline frame, in source seconds
      for (let sourceSec = 2; sourceSec <= 2 + 30 * speed; sourceSec += 0.5) {
        const frame = timelineFrameForSourceSeconds(sped, sourceSec, 30);
        expect(Math.abs(sourceSecondsForTimelineFrame(sped, frame, 30) - sourceSec))
          .toBeLessThanOrEqual(tolerance);
      }
    }
  });

  it('maps a 2x clip at half the frames a 1x clip needs', () => {
    // Source 2.0s is timeline frame 30 at 2x and 60 at normal speed. The 1x
    // value is the wrong answer for the sped-up clip, not a rounding.
    const at2x = { startFrame: 0, inPoint: 0, outPoint: 600, durationFrames: 300, speed: 2 };
    const at1x = { startFrame: 0, inPoint: 0, outPoint: 300, durationFrames: 300 };
    expect(timelineFrameForSourceSeconds(at2x, 2, 30)).toBe(30);
    expect(timelineFrameForSourceSeconds(at1x, 2, 30)).toBe(60);
  });

  it('is the same arithmetic as the forward mapping at speed 1', () => {
    // The forward test above reads frame 600 as source second 12.
    expect(timelineFrameForSourceSeconds(clip, 12, 30)).toBe(600);
  });

  it('lets a source offset before the in point land before the clip', () => {
    // Not clamped: the caller decides whether an out-of-window span overlaps.
    expect(timelineFrameForSourceSeconds(clip, 1, 30)).toBe(270);
  });
});

describe('clip trim window', () => {
  it('uses the trim points when they are ordered', () => {
    expect(clipTrimSeconds(clip, 30)).toEqual({ start: 2, end: 32 });
  });

  it('falls back to the visible duration when the out point is stale', () => {
    const stale = { startFrame: 0, inPoint: 60, outPoint: 60, durationFrames: 900 };
    expect(clipTrimSeconds(stale, 30)).toEqual({ start: 2, end: 32 });

    const inverted = { startFrame: 0, inPoint: 300, outPoint: 60, durationFrames: 150 };
    const window = clipTrimSeconds(inverted, 30);
    expect(window.start).toBe(10);
    expect(window.end).toBeGreaterThan(window.start);
  });
});

describe('seek range guards', () => {
  it('reads an asset duration through the project rate', () => {
    expect(assetDurationSeconds({ duration: 1800 }, 30)).toBe(60);
    expect(assetDurationSeconds({ duration: 1800 }, 60)).toBe(30);
    expect(assetDurationSeconds({ duration: 0 }, 30)).toBe(0);
  });

  it('rejects a seek past the end of the source', () => {
    expect(isSourceSeekable(10, 60)).toBe(true);
    expect(isSourceSeekable(60, 60)).toBe(false);
    expect(isSourceSeekable(61, 60)).toBe(false);
    expect(isSourceSeekable(-1, 60)).toBe(false);
    expect(isSourceSeekable(Number.NaN, 60)).toBe(false);
  });

  it('allows any non-negative seek when the duration is unknown or a still', () => {
    expect(isSourceSeekable(0, 0)).toBe(true);
    expect(isSourceSeekable(120, 0)).toBe(true);
  });

  it('clamps to one source frame short of the end', () => {
    expect(clampSourceSeconds(120, 60, 30)).toBeCloseTo(60 - 1 / 30, 6);
    expect(clampSourceSeconds(10, 60, 30)).toBe(10);
    expect(clampSourceSeconds(-5, 60, 30)).toBe(0);
    expect(clampSourceSeconds(120, 0, 30)).toBe(120);
  });
});

describe('source frame addressing', () => {
  it('uses the source rate when it is known', () => {
    expect(sourceFrameForSeconds(2, 60)).toBe(120);
    expect(sourceFrameForSeconds(2, 24)).toBe(48);
  });

  it('falls back to millisecond addressing so distinct times stay distinct', () => {
    expect(sourceFrameForSeconds(2, undefined)).toBe(2000);
    expect(sourceFrameForSeconds(2.001, undefined)).toBe(2001);
    expect(sourceFrameForSeconds(2, 0)).toBe(2000);
  });

  it('guards negative and non-finite input', () => {
    expect(sourceFrameForSeconds(-1, 30)).toBe(0);
    expect(sourceFrameForSeconds(Number.NaN, 30)).toBe(0);
  });
});
