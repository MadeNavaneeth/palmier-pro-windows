/**
 * `EditorController.transaction` and the multi-clip split it backs.
 *
 * The controller-level contract is what the agent tool, the FCPXML importer
 * and the UI all depend on: a multi-command operation is ONE undo step by
 * construction, a run that changed nothing adds no history, a partial run
 * still commits exactly one coherent entry, and a throw after a mutation
 * restores the pre-action project instead of leaving a fragment behind.
 */

import { describe, expect, it } from 'vitest';
import { EditorController } from './controller';

/** A silent video asset, so `addClip` places one clip per call. */
function controllerWithAsset(duration = 5000): EditorController {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'asset',
    path: 'C:\\media\\clip.mp4',
    filename: 'clip.mp4',
    type: 'video',
    duration,
    fileSize: 100,
    addedAt: '2026-09-01T00:00:00.000Z',
  });
  return ctrl;
}

/** The same asset with embedded audio, so placement links an A/V pair. */
function controllerWithAudibleAsset(duration = 5000): EditorController {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'audible',
    path: 'C:\\media\\av.mp4',
    filename: 'av.mp4',
    type: 'video',
    duration,
    fileSize: 100,
    audioCodec: 'aac',
    addedAt: '2026-09-01T00:00:00.000Z',
  });
  return ctrl;
}

/**
 * `count` clips on `count` tracks, each spanning [0,100), so a single frame
 * crosses every one of them. Independent targets, so each split is its own
 * command.
 */
function controllerWithSpanningClips(count = 3): { ctrl: EditorController; ids: string[] } {
  const ctrl = controllerWithAsset();
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const trackId = index === 0 ? 'v1' : ctrl.addTrack('video', `Video ${index + 1}`);
    ids.push(ctrl.addClip({ assetId: 'asset', trackId, startFrame: 0, durationFrames: 100 }));
  }
  return { ctrl, ids };
}

/** "start+duration" per clip, sorted, so clip arrays compare by geometry. */
function spans(ctrl: EditorController): string[] {
  return ctrl.getClips().map((clip) => `${clip.startFrame}+${clip.durationFrames}`).sort();
}

describe('EditorController.transaction', () => {
  it('publishes several domain operations as one history entry', () => {
    const { ctrl, ids } = controllerWithSpanningClips();
    const before = ctrl.getClips().map((clip) => clip.id);
    const baseline = ctrl.canUndo();

    expect(ctrl.splitClips(ids, 50)).toHaveLength(3);
    expect(ctrl.getClips()).toHaveLength(6);

    // One undo restores every split, and nothing is left above the entry the
    // fixture itself created.
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.canUndo()).toBe(baseline);
    expect(ctrl.getClips().map((clip) => clip.id)).toEqual(before);
  });

  it('adds no history entry when the body changes nothing', () => {
    const { ctrl } = controllerWithSpanningClips();
    const canUndoBefore = ctrl.canUndo();
    const descriptionBefore = ctrl.getLastCommandDescription();

    expect(ctrl.transaction('Pointless', () => 'done')).toBe('done');

    expect(ctrl.canUndo()).toBe(canUndoBefore);
    expect(ctrl.getLastCommandDescription()).toBe(descriptionBefore);
  });

  it('adds no history entry when a refused operation produced no command', () => {
    const { ctrl, ids } = controllerWithSpanningClips();
    const canUndoBefore = ctrl.canUndo();
    const before = ctrl.getClips();

    // splitClip refuses: an unknown clip, a non-finite frame, and a frame that
    // does not fall strictly inside the clip.
    expect(ctrl.splitClip('missing', 50)).toBeNull();
    expect(ctrl.splitClip(ids[0], Number.POSITIVE_INFINITY)).toBeNull();
    expect(ctrl.splitClip(ids[0], 0)).toBeNull();
    expect(ctrl.splitClip(ids[0], 100)).toBeNull();

    expect(ctrl.canUndo()).toBe(canUndoBefore);
    expect(ctrl.getClips()).toEqual(before);
  });

  it('commits exactly one entry for an early return after partial mutation', () => {
    const { ctrl, ids } = controllerWithSpanningClips();
    const before = ctrl.getClips().map((clip) => clip.id);
    const baseline = ctrl.canUndo();

    // A cancellation shape: the first edit lands, then the run stops early.
    const result = ctrl.transaction('Cancels midway', () => {
      ctrl.splitClip(ids[0], 50);
      return 'cancelled' as const;
    });

    expect(result).toBe('cancelled');
    expect(ctrl.getClips()).toHaveLength(4);

    // Exactly one coherent entry, never a fragment: one undo takes the split
    // back and nothing is left above the pre-action state.
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.canUndo()).toBe(baseline);
    expect(ctrl.getClips().map((clip) => clip.id)).toEqual(before);
  });

  it('restores the pre-action project when the body throws after mutating', () => {
    const { ctrl, ids } = controllerWithSpanningClips();
    const before = ctrl.getProject();
    const baseline = ctrl.canUndo();

    expect(() =>
      ctrl.transaction('Explodes midway', () => {
        ctrl.splitClip(ids[0], 50);
        ctrl.splitClip(ids[1], 50);
        throw new Error('media probe failed');
      }),
    ).toThrow('media probe failed');

    // Either the pre-action project or one coherent entry — never a mix of
    // unrelated commands left behind.
    expect(ctrl.getClips()).toEqual(before.timeline.clips);
    expect(ctrl.getTracks()).toEqual(before.timeline.tracks);
    expect(ctrl.canUndo()).toBe(baseline);
  });

  it('rethrows and leaves the project untouched when the body never mutated', () => {
    const { ctrl } = controllerWithSpanningClips();
    const before = ctrl.getProject();

    expect(() =>
      ctrl.transaction('Explodes immediately', () => {
        throw new Error('refused downstream');
      }),
    ).toThrow('refused downstream');
    expect(ctrl.getProject()).toBe(before);
  });

  it('joins a nested transaction into one entry', () => {
    const { ctrl, ids } = controllerWithSpanningClips(4);
    const before = ctrl.getClips().map((clip) => clip.id);
    const baseline = ctrl.canUndo();

    ctrl.transaction('Outer', () => {
      ctrl.splitClip(ids[0], 50);
      ctrl.transaction('Inner', () => {
        ctrl.splitClip(ids[1], 50);
        ctrl.splitClip(ids[2], 50);
      });
      ctrl.splitClip(ids[3], 50);
    });

    expect(ctrl.getClips()).toHaveLength(before.length + 4);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.canUndo()).toBe(baseline);
    expect(ctrl.getClips().map((clip) => clip.id)).toEqual(before);
  });

  it('keeps undo/redo ordering correct around an interleaved edit', () => {
    const { ctrl, ids } = controllerWithSpanningClips();
    const before = ctrl.getClips().map((clip) => clip.id);
    const baseline = ctrl.canUndo();

    ctrl.transaction('Batched', () => {
      ctrl.splitClip(ids[0], 50);
      ctrl.splitClip(ids[1], 50);
    });
    // An unrelated edit AFTER the transaction must sit on top of it.
    const trackId = ctrl.addTrack('video', 'Later');

    // Undo order: the unrelated edit first, then the batch in one step.
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getTracks().some((track) => track.id === trackId)).toBe(false);
    // The batch is still pending as ONE entry.
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.canUndo()).toBe(baseline);
    expect(ctrl.getClips().map((clip) => clip.id)).toEqual(before);

    // Redo replays both, in order.
    expect(ctrl.redo()).toBe(true);
    expect(ctrl.getClips()).toHaveLength(before.length + 2);
    expect(ctrl.redo()).toBe(true);
    expect(ctrl.getTracks().some((track) => track.id === trackId)).toBe(true);
  });
});

describe('EditorController.splitClips', () => {
  it('splits every named clip and reports the new right-hand ids in order', () => {
    const { ctrl, ids } = controllerWithSpanningClips();

    const rightIds = ctrl.splitClips(ids, 50);

    expect(rightIds).toHaveLength(3);
    expect(ctrl.getClips()).toHaveLength(6);
    expect(spans(ctrl)).toEqual(['0+50', '0+50', '0+50', '50+50', '50+50', '50+50']);
    for (const rightId of rightIds) {
      expect(ctrl.getClips().find((clip) => clip.id === rightId)!.startFrame).toBe(50);
    }
  });

  it('undoes all N splits in one step and redoes them all', () => {
    const { ctrl, ids } = controllerWithSpanningClips();
    const before = spans(ctrl);
    const beforeIds = ctrl.getClips().map((clip) => clip.id).sort();

    const rightIds = ctrl.splitClips(ids, 50);
    expect(ctrl.getClips()).toHaveLength(6);

    expect(ctrl.undo()).toBe(true);
    expect(spans(ctrl)).toEqual(before);
    expect(ctrl.getClips()).toHaveLength(3);

    expect(ctrl.redo()).toBe(true);
    expect(ctrl.getClips().map((clip) => clip.id).sort()).toEqual(
      [...beforeIds, ...rightIds].sort(),
    );
  });

  it('skips targets the frame does not fall strictly inside', () => {
    const ctrl = controllerWithAsset();
    // a covers [0,30), b covers [20,60): a split at 40 misses a and splits b.
    const a = ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 30 });
    const b = ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 20, durationFrames: 40 });
    const before = spans(ctrl);
    const baseline = ctrl.canUndo();

    const rightIds = ctrl.splitClips([a, b], 40);

    expect(rightIds).toHaveLength(1);
    expect(ctrl.getClips().find((clip) => clip.id === rightIds[0])!.startFrame).toBe(40);
    // A run that split exactly one clip publishes that clip's own entry, not a
    // relabelled composite.
    expect(ctrl.getLastCommandDescription()).toBe('replaceClips');
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.canUndo()).toBe(baseline);
    expect(spans(ctrl)).toEqual(before);
  });

  it('adds no history entry when no clip can be split', () => {
    const { ctrl, ids } = controllerWithSpanningClips();
    const before = ctrl.getClips();
    const baseline = ctrl.canUndo();

    expect(ctrl.splitClips(ids, 0)).toEqual([]);       // on every leading edge
    expect(ctrl.splitClips(ids, 100)).toEqual([]);     // on every trailing edge
    expect(ctrl.splitClips(ids, Number.NaN)).toEqual([]);
    expect(ctrl.splitClips(['missing'], 50)).toEqual([]);
    expect(ctrl.splitClips([], 50)).toEqual([]);

    expect(ctrl.canUndo()).toBe(baseline);
    expect(ctrl.getClips()).toEqual(before);
  });

  it('splits a linked A/V pair together, as splitClip does', () => {
    const ctrl = controllerWithAudibleAsset();
    ctrl.placeMediaAssets(['audible'], 'v1', 100);
    const baseline = ctrl.canUndo();
    const video = ctrl.getClips().find((clip) => clip.type === 'video')!;
    const audio = ctrl.getClips().find((clip) => clip.type === 'audio')!;

    // One target, one command: the linked partner splits with it, and the
    // partner passed as a second target is refused rather than split twice.
    const rightIds = ctrl.splitClips([video.id, audio.id], 140);

    expect(ctrl.getClips()).toHaveLength(4);
    expect(ctrl.getClips().filter((clip) => clip.startFrame === 140)).toHaveLength(2);
    expect(rightIds).toHaveLength(1);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.canUndo()).toBe(baseline);
    expect(ctrl.getClips()).toHaveLength(2);
  });

  it('refuses a target on a locked track and still splits the rest as one entry', () => {
    const { ctrl, ids } = controllerWithSpanningClips();
    ctrl.setTrackLocked('v1', true);
    const baseline = ctrl.canUndo();
    const lockedBefore = ctrl.getClips().find((clip) => clip.id === ids[0])!;

    const rightIds = ctrl.splitClips(ids, 50);

    // The locked target contributes nothing; the two editable ones split.
    expect(rightIds).toHaveLength(2);
    expect(ctrl.getClips().find((clip) => clip.id === ids[0])!.durationFrames)
      .toBe(lockedBefore.durationFrames);
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.canUndo()).toBe(baseline);
    expect(ctrl.getClips()).toHaveLength(3);
  });

  it('adds no history entry when every target is refused', () => {
    const { ctrl, ids } = controllerWithSpanningClips();
    ctrl.setTrackLocked('v1', true);
    for (const track of ctrl.getTracks()) ctrl.setTrackLocked(track.id, true);
    const before = ctrl.getClips();
    const baseline = ctrl.canUndo();

    expect(ctrl.splitClips(ids, 50)).toEqual([]);
    expect(ctrl.canUndo()).toBe(baseline);
    expect(ctrl.getClips()).toEqual(before);
  });

  it('keeps splitClip behavior identical to before the refactor', () => {
    const { ctrl, ids } = controllerWithSpanningClips();
    const rightId = ctrl.splitClip(ids[0], 50);
    expect(rightId).not.toBeNull();
    const left = ctrl.getClips().find((clip) => clip.id === ids[0])!;
    const right = ctrl.getClips().find((clip) => clip.id === rightId!)!;
    expect(left.durationFrames).toBe(50);
    expect(left.outPoint).toBe(50);
    expect(right.startFrame).toBe(50);
    expect(right.durationFrames).toBe(50);
    expect(right.inPoint).toBe(50);
    expect(right.linkGroupId).toBeUndefined();
    // A single split keeps its own history entry.
    expect(ctrl.getLastCommandDescription()).toBe('replaceClips');
  });
});
