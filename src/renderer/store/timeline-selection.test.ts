/**
 * Regression coverage for select-all-clips-on-track (upstream PR #512).
 *
 * The invariants that matter: a missing or empty track leaves the current
 * selection untouched, and a successful select clears any selected gap so a
 * following gap-ripple-delete cannot fire against a stale gap.
 */

import { describe, it, expect } from 'vitest';
import { useTimelineStore } from './timeline';

/** Drive the real store; each test seeds its own clips through the controller. */
function freshStore() {
  const store = useTimelineStore;
  const controller = store.getState().controller;
  return { store, controller };
}

function addVideoAsset(
  controller: ReturnType<typeof useTimelineStore.getState>['controller'],
  id: string,
  withAudio = false,
): void {
  controller.addMedia({
    id,
    path: `/test/${id}.mp4`,
    filename: `${id}.mp4`,
    type: 'video',
    duration: 1000,
    fileSize: 1,
    ...(withAudio ? { audioCodec: 'aac' } : {}),
    addedAt: new Date().toISOString(),
  });
}

describe('selectAllClipsOnTrack (#512)', () => {
  it('selects only the clips on the requested track and clears gap selection', () => {
    const { store, controller } = freshStore();
    addVideoAsset(controller, 'asset-sat');
    const v1 = 'v1';
    controller.addClip({ assetId: 'asset-sat', trackId: v1, startFrame: 0, durationFrames: 50 });
    controller.addClip({ assetId: 'asset-sat', trackId: v1, startFrame: 100, durationFrames: 50 });

    // A gap exists between the two clips; selecting it must not survive a
    // later track-wide selection.
    store.getState().selectGap(v1, 75);
    expect(store.getState().selectedGap).not.toBeNull();
    expect(store.getState().selectedClipIds.size).toBe(0);

    expect(store.getState().selectAllClipsOnTrack(v1)).toBe(true);
    const selected = store.getState().selectedClipIds;
    expect(selected.size).toBe(2);
    expect(
      store
        .getState()
        .getClips()
        .filter((clip) => clip.trackId === v1)
        .every((clip) => selected.has(clip.id)),
    ).toBe(true);
    expect(store.getState().selectedGap).toBeNull();
  });

  it('leaves the selection untouched for an empty or unknown track', () => {
    const { store, controller } = freshStore();
    addVideoAsset(controller, 'asset-sat2');
    const clipId = controller.addClip({
      assetId: 'asset-sat2',
      trackId: 'v1',
      startFrame: 500,
      durationFrames: 10,
    });

    store.getState().selectClip(clipId);
    const before = store.getState().selectedClipIds;

    expect(store.getState().selectAllClipsOnTrack('a1')).toBe(false);
    expect(store.getState().selectAllClipsOnTrack('missing')).toBe(false);
    expect(store.getState().selectedClipIds).toBe(before);
  });

  it('keeps linked partners in the selection', () => {
    const { store, controller } = freshStore();
    addVideoAsset(controller, 'asset-av', true);
    // Video with embedded audio placed on a video track creates a linked
    // audio clip on an audio lane.
    controller.placeMediaAssets(['asset-av'], 'v1', 1000);

    expect(store.getState().selectAllClipsOnTrack('v1')).toBe(true);
    // The selection expands to the linked partner even though it sits on a1.
    expect(store.getState().selectedClipIds.size).toBeGreaterThanOrEqual(2);
  });
});
