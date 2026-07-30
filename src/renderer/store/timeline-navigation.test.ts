/**
 * Regression coverage for keyboard-driven timeline navigation and marking
 * (upstream issue #164).
 *
 * These are the store actions the shortcut layer dispatches. Testing them here
 * rather than through the hook keeps the assertions about editor behaviour
 * instead of React event plumbing, and it covers the two rules that were wrong
 * before: "go to end" must land on the last frame of material rather than in the
 * timeline's trailing padding, and fit-to-window must respect the zoom ceiling.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useTimelineStore } from './timeline';

const store = () => useTimelineStore.getState();

/**
 * Timeline layout used throughout:
 *   v1: [0, 60)          [90, 120)
 *   v2:      [30, 75)
 * Edit points on all tracks: 0, 30, 60, 75, 90, 120
 */
function seedTimeline(): { secondTrack: string; clipIds: string[] } {
  store().resetProject();
  const { controller } = store();

  controller.addMedia({
    id: 'v',
    path: '/v.mp4',
    filename: 'v.mp4',
    type: 'video',
    duration: 6000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  const secondTrack = controller.addTrack('video', 'Video 2');

  const clipIds = [
    controller.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 60 }),
    controller.addClip({ assetId: 'v', trackId: 'v1', startFrame: 90, durationFrames: 30 }),
    controller.addClip({ assetId: 'v', trackId: secondTrack, startFrame: 30, durationFrames: 45 }),
  ];
  return { secondTrack, clipIds };
}

beforeEach(() => {
  seedTimeline();
});

describe('edit point navigation', () => {
  it('walks forward through every boundary and stops at the last one', () => {
    store().goToStart();
    for (const expected of [30, 60, 75, 90, 120]) {
      store().goToNextEdit();
      expect(store().getPlayhead()).toBe(expected);
    }
    // Already at the final edit — the playhead holds rather than wrapping.
    store().goToNextEdit();
    expect(store().getPlayhead()).toBe(120);
  });

  it('walks backward through every boundary and stops at the timeline start', () => {
    store().setPlayhead(120);
    for (const expected of [90, 75, 60, 30, 0]) {
      store().goToPreviousEdit();
      expect(store().getPlayhead()).toBe(expected);
    }
    store().goToPreviousEdit();
    expect(store().getPlayhead()).toBe(0);
  });

  it('scopes navigation to the tracks the selection targets', () => {
    const { clipIds } = seedTimeline();
    // Select only the two v1 clips; v2's boundaries at 30 and 75 must be skipped.
    store().selectClip(clipIds[0]);
    store().selectClip(clipIds[1], true);
    store().setPlayhead(0);

    store().goToNextEdit();
    expect(store().getPlayhead()).toBe(60);
    store().goToNextEdit();
    expect(store().getPlayhead()).toBe(90);
  });

  it('considers all tracks once the selection is cleared', () => {
    const { clipIds } = seedTimeline();
    store().selectClip(clipIds[0]);
    store().deselectAll();
    store().setPlayhead(0);

    store().goToNextEdit();
    expect(store().getPlayhead()).toBe(30);
  });

  it('does not move on an empty timeline', () => {
    store().resetProject();
    store().setPlayhead(0);
    store().goToNextEdit();
    expect(store().getPlayhead()).toBe(0);
    store().goToPreviousEdit();
    expect(store().getPlayhead()).toBe(0);
  });
});

describe('go to start and end', () => {
  it('lands on the end of the last clip, not in the trailing padding', () => {
    store().goToEnd();
    expect(store().getPlayhead()).toBe(120);
    // getProjectDuration() pads past the material so clips can be dropped after
    // the end; the playhead must not follow it there.
    expect(store().getProjectDuration()).toBeGreaterThan(120);
  });

  it('goes to frame zero from anywhere', () => {
    store().setPlayhead(95);
    store().goToStart();
    expect(store().getPlayhead()).toBe(0);
  });

  it('treats an empty timeline as ending at zero', () => {
    store().resetProject();
    store().setPlayhead(50);
    store().goToEnd();
    expect(store().getPlayhead()).toBe(0);
  });
});

describe('marking the selection', () => {
  it('marks the full span the selection covers', () => {
    const { clipIds } = seedTimeline();
    store().selectClip(clipIds[0]); // [0, 60)
    store().selectClip(clipIds[1], true); // [90, 120)
    store().markSelectedClip();

    expect(store().project.timeline.inFrame).toBe(0);
    expect(store().project.timeline.outFrame).toBe(120);
  });

  it('marks a single clip exactly', () => {
    const { clipIds } = seedTimeline();
    store().selectClip(clipIds[2]); // [30, 75)
    store().markSelectedClip();

    expect(store().project.timeline.inFrame).toBe(30);
    expect(store().project.timeline.outFrame).toBe(75);
  });

  it('leaves existing marks alone when nothing is selected', () => {
    store().setPlayhead(10);
    store().setInFrame();
    store().setPlayhead(40);
    store().setOutFrame();

    store().deselectAll();
    store().markSelectedClip();

    expect(store().project.timeline.inFrame).toBe(10);
    expect(store().project.timeline.outFrame).toBe(40);
  });

  it('seeks to each mark and ignores a seek when the mark is unset', () => {
    store().clearMarkedRange();
    store().setPlayhead(55);
    store().goToInPoint();
    expect(store().getPlayhead()).toBe(55);
    store().goToOutPoint();
    expect(store().getPlayhead()).toBe(55);

    const { clipIds } = seedTimeline();
    store().selectClip(clipIds[2]);
    store().markSelectedClip();

    store().goToInPoint();
    expect(store().getPlayhead()).toBe(30);
    store().goToOutPoint();
    expect(store().getPlayhead()).toBe(75);
  });

  it('normalizes an inverted range so consumers do not discard it', () => {
    store().controller.setMarkedRange(90, 20);
    expect(store().project.timeline.inFrame).toBe(20);
    expect(store().project.timeline.outFrame).toBe(90);
  });
});

describe('select all', () => {
  it('selects every clip on every track', () => {
    const { clipIds } = seedTimeline();
    store().selectAllClips();
    expect(store().selectedClipIds).toEqual(new Set(clipIds));
  });

  it('is a no-op on an empty timeline', () => {
    store().resetProject();
    store().selectAllClips();
    expect(store().selectedClipIds.size).toBe(0);
  });
});

describe('snapping toggle', () => {
  it('flips and restores', () => {
    const initial = store().snapEnabled;
    store().toggleSnap();
    expect(store().snapEnabled).toBe(!initial);
    store().toggleSnap();
    expect(store().snapEnabled).toBe(initial);
  });
});

describe('fit to viewport', () => {
  it('uses the published lane width', () => {
    store().setViewportWidth(1050);
    store().fitToViewport();

    const duration = store().getProjectDuration();
    expect(store().viewport.pixelsPerFrame).toBeCloseTo(1050 / duration, 5);
    expect(store().viewport.scrollFrame).toBe(0);
  });

  it('does nothing before a width has been measured', () => {
    store().setViewportWidth(0);
    const before = store().viewport.pixelsPerFrame;
    store().fitToViewport();
    expect(store().viewport.pixelsPerFrame).toBe(before);
  });

  it('never zooms past the viewport limits', () => {
    // A very short project over a wide lane would otherwise compute a
    // pixels-per-frame far above the ruler's supported range.
    store().resetProject();
    store().setViewportWidth(20000);
    store().fitToViewport();
    expect(store().viewport.pixelsPerFrame).toBeLessThanOrEqual(
      store().viewport.maxPxPerFrame,
    );

    store().setViewportWidth(1);
    store().fitToViewport();
    expect(store().viewport.pixelsPerFrame).toBeGreaterThanOrEqual(
      store().viewport.minPxPerFrame,
    );
  });

  it('rejects a non-finite or negative measurement', () => {
    store().setViewportWidth(800);
    store().setViewportWidth(Number.NaN);
    expect(store().viewportWidth).toBe(800);
    store().setViewportWidth(-10);
    expect(store().viewportWidth).toBe(800);
  });
});
