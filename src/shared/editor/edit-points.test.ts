/**
 * Regression coverage for edit-point navigation (upstream issue #164).
 */

import { describe, it, expect } from 'vitest';
import {
  editPoints,
  nextEditPoint,
  previousEditPoint,
  timelineContentEnd,
  type EditPointClip,
} from './edit-points';

const clips: EditPointClip[] = [
  { startFrame: 0, durationFrames: 60, trackId: 'v1' },
  { startFrame: 90, durationFrames: 30, trackId: 'v1' },
  { startFrame: 30, durationFrames: 45, trackId: 'v2' },
];

describe('editPoints', () => {
  it('collects every distinct boundary, ascending, including the timeline start', () => {
    expect(editPoints(clips)).toEqual([0, 30, 60, 75, 90, 120]);
  });

  it('always includes the timeline start even with no clips', () => {
    expect(editPoints([])).toEqual([0]);
  });

  it('scopes to the given tracks', () => {
    expect(editPoints(clips, new Set(['v1']))).toEqual([0, 60, 90, 120]);
    expect(editPoints(clips, new Set(['v2']))).toEqual([0, 30, 75]);
    expect(editPoints(clips, new Set(['nope']))).toEqual([0]);
  });

  it('collapses boundaries shared by butted clips', () => {
    const butted: EditPointClip[] = [
      { startFrame: 0, durationFrames: 30, trackId: 'v1' },
      { startFrame: 30, durationFrames: 30, trackId: 'v1' },
    ];
    expect(editPoints(butted)).toEqual([0, 30, 60]);
  });

  it('ignores clips with unusable geometry instead of emitting NaN points', () => {
    const broken: EditPointClip[] = [
      { startFrame: Number.NaN, durationFrames: 30, trackId: 'v1' },
      { startFrame: 0, durationFrames: Number.POSITIVE_INFINITY, trackId: 'v1' },
      { startFrame: -30, durationFrames: 30, trackId: 'v1' },
      { startFrame: 10, durationFrames: 0, trackId: 'v1' },
      { startFrame: 40, durationFrames: 20, trackId: 'v1' },
    ];
    expect(editPoints(broken)).toEqual([0, 40, 60]);
  });
});

describe('navigation', () => {
  it('moves to the next boundary', () => {
    expect(nextEditPoint(clips, 0)).toBe(30);
    expect(nextEditPoint(clips, 29)).toBe(30);
    expect(nextEditPoint(clips, 30)).toBe(60);
    expect(nextEditPoint(clips, 119)).toBe(120);
  });

  it('reports no next boundary at or past the end', () => {
    expect(nextEditPoint(clips, 120)).toBeNull();
    expect(nextEditPoint(clips, 500)).toBeNull();
    expect(nextEditPoint([], 0)).toBeNull();
  });

  it('moves to the previous boundary', () => {
    expect(previousEditPoint(clips, 120)).toBe(90);
    expect(previousEditPoint(clips, 91)).toBe(90);
    expect(previousEditPoint(clips, 90)).toBe(75);
    expect(previousEditPoint(clips, 1)).toBe(0);
  });

  it('reports no previous boundary at the timeline start', () => {
    expect(previousEditPoint(clips, 0)).toBeNull();
    expect(previousEditPoint([], 0)).toBeNull();
  });

  it('lands on the timeline start when moving back from the first clip', () => {
    const later: EditPointClip[] = [{ startFrame: 300, durationFrames: 60, trackId: 'v1' }];
    expect(previousEditPoint(later, 300)).toBe(0);
  });

  it('guards a non-finite playhead', () => {
    expect(nextEditPoint(clips, Number.NaN)).toBeNull();
    expect(previousEditPoint(clips, Number.NaN)).toBeNull();
  });

  it('honours the track scope while navigating', () => {
    expect(nextEditPoint(clips, 0, new Set(['v1']))).toBe(60);
    expect(previousEditPoint(clips, 120, new Set(['v2']))).toBe(75);
  });
});

describe('timelineContentEnd', () => {
  it('reports the end of the last clip, not the padded timeline length', () => {
    expect(timelineContentEnd(clips)).toBe(120);
    expect(timelineContentEnd([])).toBe(0);
  });

  it('ignores unusable geometry', () => {
    expect(
      timelineContentEnd([
        { startFrame: 0, durationFrames: 30, trackId: 'v1' },
        { startFrame: Number.NaN, durationFrames: 900, trackId: 'v1' },
      ]),
    ).toBe(30);
  });
});
