/**
 * Unit coverage for the Inspector's opacity-track keyframe rules.
 *
 * The repository has no DOM test setup, so the point arithmetic the component
 * submits to `setClipOpacityTrack` is pinned here as pure functions. The
 * controller refuses tracks shorter than two points, so the "first add" and
 * "remove down to two" cases are the load-bearing ones.
 */

import { describe, expect, it } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import {
  OPACITY_TRACK_MIN_POINTS,
  hasOpacityTrack,
  nextOpacityTrack,
  opacityPercent,
  removeOpacityKeyframe,
  withOpacityEasing,
} from './opacity-track';

const FPS = 30;

describe('hasOpacityTrack', () => {
  it('is false without a track and true with one', () => {
    expect(hasOpacityTrack(undefined)).toBe(false);
    expect(hasOpacityTrack([])).toBe(false);
    expect(hasOpacityTrack([{ frame: 0, value: 1 }])).toBe(true);
  });
});

describe('opacityPercent', () => {
  it('renders a 0..1 value as a percentage', () => {
    expect(opacityPercent(0)).toBe(0);
    expect(opacityPercent(0.5)).toBe(50);
    expect(opacityPercent(1)).toBe(100);
    expect(opacityPercent(0.1234)).toBe(12);
  });

  it('clamps out-of-range and non-finite values instead of printing them', () => {
    expect(opacityPercent(2)).toBe(100);
    expect(opacityPercent(-1)).toBe(0);
    expect(opacityPercent(Number.NaN)).toBe(0);
  });
});

describe('nextOpacityTrack', () => {
  it('seeds a valid two-point track on the first add', () => {
    const next = nextOpacityTrack(undefined, 10, 0.8, FPS);
    // The controller requires >= 2 points, so the first add must already be
    // a usable flat track rather than a refused single keyframe.
    expect(next).toHaveLength(OPACITY_TRACK_MIN_POINTS);
    expect(next).toEqual([
      { frame: 10, value: 0.8 },
      { frame: 10 + FPS, value: 0.8 },
    ]);
  });

  it('appends a keyframe at the playhead, sorted by frame', () => {
    const track = [
      { frame: 0, value: 0 },
      { frame: 60, value: 1 },
    ];
    expect(nextOpacityTrack(track, 30, 0.5, FPS)).toEqual([
      { frame: 0, value: 0 },
      { frame: 30, value: 0.5 },
      { frame: 60, value: 1 },
    ]);
  });

  it('replaces a point already on the playhead frame instead of duplicating it', () => {
    const track = [
      { frame: 0, value: 0.2 },
      { frame: 30, value: 0.9 },
    ];
    const next = nextOpacityTrack(track, 30, 1, FPS);
    expect(next).toHaveLength(2);
    expect(next).toContainEqual({ frame: 30, value: 0.9 });
  });

  it('captures the track value at the playhead, not the static value', () => {
    const track = [
      { frame: 0, value: 0 },
      { frame: 60, value: 1 },
    ];
    // At the midpoint the evaluated value is 0.5, so the new keyframe holds
    // the interpolated value rather than the clip's static opacity.
    const next = nextOpacityTrack(track, 30, 1, FPS);
    expect(next).toContainEqual({ frame: 30, value: 0.5 });
  });

  it('clamps the captured value into 0..1', () => {
    const next = nextOpacityTrack(undefined, 0, 5, FPS);
    expect(next.every((point) => point.value === 1)).toBe(true);
  });

  it('re-seeds a second point one second later even for a very short fps', () => {
    const next = nextOpacityTrack(undefined, 0, 0.5, 0);
    expect(next).toEqual([
      { frame: 0, value: 0.5 },
      { frame: 1, value: 0.5 },
    ]);
  });
});

describe('removeOpacityKeyframe', () => {
  const track = [
    { frame: 0, value: 0 },
    { frame: 30, value: 0.5 },
    { frame: 60, value: 1 },
  ];

  it('removes a middle keyframe while keeping a valid track', () => {
    expect(removeOpacityKeyframe(track, 30)).toEqual([
      { frame: 0, value: 0 },
      { frame: 60, value: 1 },
    ]);
  });

  it('clears the track (undefined) rather than leaving a one-point track', () => {
    // A single keyframe is not a valid opacity track; the controller would
    // refuse it, so removal to two points clears.
    expect(removeOpacityKeyframe(track, 30)).toEqual(track.slice(0, 1).concat(track.slice(2)));
    const twoPoint = [
      { frame: 0, value: 0 },
      { frame: 60, value: 1 },
    ];
    expect(removeOpacityKeyframe(twoPoint, 0)).toBeUndefined();
    expect(removeOpacityKeyframe(twoPoint, 60)).toBeUndefined();
  });

  it('is a no-op clear for a clip with no track', () => {
    expect(removeOpacityKeyframe(undefined, 0)).toBeUndefined();
  });
});

describe('withOpacityEasing', () => {
  const track = [
    { frame: 0, value: 0 },
    { frame: 30, value: 0.5 },
    { frame: 60, value: 1 },
  ];

  it('applies easing to every segment start but not the last point', () => {
    const eased = withOpacityEasing(track, 'easeInOut');
    expect(eased).toEqual([
      { frame: 0, value: 0, easing: 'easeInOut' },
      { frame: 30, value: 0.5, easing: 'easeInOut' },
      { frame: 60, value: 1 },
    ]);
  });

  it('drops the easing field when set back to linear', () => {
    const eased = withOpacityEasing(
      withOpacityEasing(track, 'easeIn'),
      'linear',
    );
    expect(eased).toEqual(track);
    expect(eased!.every((point) => !('easing' in point))).toBe(true);
  });

  it('is a no-op for a clip with no track', () => {
    expect(withOpacityEasing(undefined, 'easeIn')).toBeUndefined();
  });
});

/**
 * The seam the component depends on: every point list these helpers produce is
 * actually accepted by `setClipOpacityTrack`, one undo step per action. Without
 * this, a helper could emit a shape the controller silently refuses and the
 * control would look functional while doing nothing.
 */
describe('opacity-track edits through the controller', () => {
  function controllerWithClip(): { ctrl: EditorController; clipId: string } {
    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'v', path: '/v.mp4', filename: 'v.mp4', type: 'video',
      duration: 600, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const clipId = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 90 });
    return { ctrl, clipId };
  }

  const clipById = (ctrl: EditorController, id: string) =>
    ctrl.getClips().find((clip) => clip.id === id);

  it('accepts the first add, then each further edit, one undo step at a time', () => {
    const { ctrl, clipId } = controllerWithClip();
    const submit = (points: ReturnType<typeof nextOpacityTrack> | undefined) =>
      ctrl.setClipOpacityTrack(clipId, points ?? []);

    // First add seeds a valid pair and is accepted (a lone keyframe is not).
    let track = nextOpacityTrack(undefined, 0, 0.5, 30);
    expect(submit(track)).toBe(true);
    expect(clipById(ctrl, clipId)!.opacityTrack).toHaveLength(OPACITY_TRACK_MIN_POINTS);

    // A new frame inserts a keyframe. (Re-adding on a frame the track already
    // has keeps the evaluated value, so the controller correctly refuses it as
    // a no-op — pinned separately below.)
    track = nextOpacityTrack(clipById(ctrl, clipId)!.opacityTrack, 45, 0.5, 30);
    expect(submit(track)).toBe(true);
    expect(clipById(ctrl, clipId)!.opacityTrack).toHaveLength(3);

    // Easing applies to the segments.
    expect(submit(withOpacityEasing(clipById(ctrl, clipId)!.opacityTrack, 'easeInOut'))).toBe(true);
    expect(clipById(ctrl, clipId)!.opacityTrack?.[0].easing).toBe('easeInOut');

    // Removing a middle keyframe keeps a valid track.
    const eased = clipById(ctrl, clipId)!.opacityTrack!;
    const afterRemove = removeOpacityKeyframe(eased, 30);
    expect(afterRemove).toBeDefined();
    expect(submit(afterRemove)).toBe(true);
    expect(clipById(ctrl, clipId)!.opacityTrack).toHaveLength(2);

    // Reset clears the track in one step.
    expect(submit(undefined)).toBe(true);
    expect(clipById(ctrl, clipId)!.opacityTrack).toBeUndefined();

    // Walk the history back one action at a time; each was its own entry.
    expect(ctrl.undo()).toBe(true);
    expect(clipById(ctrl, clipId)!.opacityTrack).toHaveLength(2);
  });

  it('adds a keyframe that traces a curve authored elsewhere', () => {
    const { ctrl, clipId } = controllerWithClip();
    // A ramp, as the Agent or a pasted attribute could leave it.
    ctrl.setClipOpacityTrack(clipId, [
      { frame: 0, value: 0 },
      { frame: 60, value: 1 },
    ]);

    // Adding at the midpoint captures the interpolated value, not the static
    // opacity, so the new point does not flatten the curve.
    const track = nextOpacityTrack(clipById(ctrl, clipId)!.opacityTrack, 30, 1, 30);
    expect(track).toContainEqual({ frame: 30, value: 0.5 });
    expect(ctrl.setClipOpacityTrack(clipId, track)).toBe(true);
  });

  it('refuses a single keyframe, which is why the helper never submits one', () => {
    const { ctrl, clipId } = controllerWithClip();
    expect(ctrl.setClipOpacityTrack(clipId, [{ frame: 0, value: 0.5 }])).toBe(false);
    expect(clipById(ctrl, clipId)!.opacityTrack).toBeUndefined();
  });

  it('adds no history for a no-op re-submit of the same track', () => {
    const { ctrl, clipId } = controllerWithClip();
    const track = nextOpacityTrack(undefined, 0, 0.5, 30);
    expect(ctrl.setClipOpacityTrack(clipId, track)).toBe(true);
    const before = ctrl.canUndo();

    // Re-adding at a frame that already exists and evaluates to the same value
    // is a no-op, so history is untouched.
    expect(ctrl.setClipOpacityTrack(clipId, nextOpacityTrack(track, 0, 0.5, 30))).toBe(false);
    expect(ctrl.canUndo()).toBe(before);
  });
});
