/**
 * `splitAtPlayhead` is ONE user action, so it must be ONE undo step.
 *
 * The store used to loop over every clip the playhead crossed and call
 * `controller.splitClip` once per clip, which pushed one history entry per
 * clip. It now calls the single `splitClips` domain operation, so N splits
 * undo and redo as one step. Selection still narrows the target set exactly as
 * before.
 */

import { describe, expect, it } from 'vitest';
import { useTimelineStore } from './timeline';

/** Drive the real store; the singleton is reset so each test starts clean. */
function freshStore() {
  const store = useTimelineStore;
  store.getState().resetProject();
  return { store, controller: store.getState().controller };
}

function addVideoAsset(controller: ReturnType<typeof useTimelineStore.getState>['controller']): void {
  controller.addMedia({
    id: 'split-asset',
    path: '/test/split.mp4',
    filename: 'split.mp4',
    type: 'video',
    duration: 1000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
}

/** Three clips on three tracks, each spanning [0,100) so one frame crosses all. */
function seedThreeSpanningClips(controller: ReturnType<typeof useTimelineStore.getState>['controller']): string[] {
  addVideoAsset(controller);
  return [0, 1, 2].map((index) => {
    const trackId = index === 0 ? 'v1' : controller.addTrack('video', `Video ${index + 1}`);
    return controller.addClip({ assetId: 'split-asset', trackId, startFrame: 0, durationFrames: 100 });
  });
}

const spans = (controller: ReturnType<typeof useTimelineStore.getState>['controller']): string[] =>
  controller.getClips().map((clip) => `${clip.startFrame}+${clip.durationFrames}`).sort();

describe('splitAtPlayhead', () => {
  it('splits N clips as ONE undo step and redoes them as one', () => {
    const { store, controller } = freshStore();
    const ids = seedThreeSpanningClips(controller);
    controller.setPlayhead(50);
    const before = spans(controller);
    const baseline = controller.canUndo();

    store.getState().splitAtPlayhead();

    // All three clips split.
    expect(controller.getClips()).toHaveLength(6);
    expect(spans(controller)).toEqual(['0+50', '0+50', '0+50', '50+50', '50+50', '50+50']);

    // One undo restores all N, and nothing else was left on the stack.
    expect(controller.undo()).toBe(true);
    expect(spans(controller)).toEqual(before);
    expect(controller.getClips()).toHaveLength(3);
    expect(controller.canUndo()).toBe(baseline);

    // One redo re-splits all N.
    expect(controller.redo()).toBe(true);
    expect(controller.getClips()).toHaveLength(6);
    for (const id of ids) {
      expect(controller.getClips().find((clip) => clip.id === id)!.durationFrames).toBe(50);
    }
  });

  it('splits only the selection when clips are selected', () => {
    const { store, controller } = freshStore();
    const ids = seedThreeSpanningClips(controller);
    controller.setPlayhead(50);
    for (const id of ids) store.getState().selectClip(id, true);
    const before = spans(controller);

    store.getState().splitAtPlayhead();

    expect(controller.getClips()).toHaveLength(6);
    expect(controller.undo()).toBe(true);
    expect(spans(controller)).toEqual(before);
  });

  it('adds no history entry when the playhead is not inside any clip', () => {
    const { store, controller } = freshStore();
    seedThreeSpanningClips(controller);
    controller.setPlayhead(100); // the shared trailing edge
    const before = controller.getClips();
    const baseline = controller.canUndo();

    store.getState().splitAtPlayhead();

    expect(controller.getClips()).toEqual(before);
    expect(controller.canUndo()).toBe(baseline);
  });
});
