/**
 * Regression coverage for the placement collision modes (roadmap R1;
 * upstream pairs add_clips / insert_clips).
 *
 * overwrite clears the destination span (splitting survivors), insert
 * ripple-pushes the target track's later clips plus linked partners on their
 * own tracks, append lands after the last clip. Locked tracks refuse.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function controllerWithMedia() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'asset-video',
    path: '/test/v.mp4',
    filename: 'v.mp4',
    type: 'video',
    duration: 1000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  return ctrl;
}

describe('placeClipWithMode (R1)', () => {
  it('append lands after the last clip and ignores startFrame', () => {
    const ctrl = controllerWithMedia();
    ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 0, durationFrames: 50 });
    ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 80, durationFrames: 40 });

    const { clipIds } = ctrl.placeClipWithMode({
      assetId: 'asset-video', trackId: 'v1', mode: 'append', startFrame: 5, durationFrames: 30,
    })!;
    const pasted = ctrl.getClips().find((c) => c.id === clipIds[0])!;
    expect(pasted.startFrame).toBe(120); // after the 80+40 tail
  });

  it('overwrite splits the victim under the span and keeps head/tail fragments', () => {
    const ctrl = controllerWithMedia();
    ctrl.addClip({
      assetId: 'asset-video', trackId: 'v1', startFrame: 200, durationFrames: 200,
    });

    const { clipIds } = ctrl.placeClipWithMode({
      assetId: 'asset-video', trackId: 'v1', mode: 'overwrite',
      startFrame: 250, durationFrames: 60,
    })!;

    const spans = ctrl.getClips()
      .filter((c) => c.trackId === 'v1')
      .map((c) => [c.startFrame, c.startFrame + c.durationFrames])
      .sort((a, b) => a[0] - b[0]);
    expect(spans).toEqual([
      [200, 250],
      [250, 310], // the placed clip
      [310, 400],
    ]);
    void clipIds;
  });

  it('insert pushes later clips on the track by the placed length', () => {
    const ctrl = controllerWithMedia();
    ctrl.addClip({
      assetId: 'asset-video', trackId: 'v1', startFrame: 200, durationFrames: 100,
    });
    ctrl.addClip({
      assetId: 'asset-video', trackId: 'v1', startFrame: 400, durationFrames: 50,
    });

    ctrl.placeClipWithMode({
      assetId: 'asset-video', trackId: 'v1', mode: 'insert',
      startFrame: 150, durationFrames: 60,
    });
    const clips = ctrl.getClips().sort((a, b) => a.startFrame - b.startFrame);
    expect(clips.map((c) => c.startFrame)).toEqual([150, 260, 460]);
  });

  it('insert moves linked partners on other tracks with their picture half', () => {
    const ctrl = controllerWithMedia();
    ctrl.addMedia({
      id: 'asset-av',
      path: '/test/av.mp4',
      filename: 'av.mp4',
      type: 'video',
      duration: 1000,
      fileSize: 1,
      audioCodec: 'aac',
      addedAt: new Date().toISOString(),
    });
    ctrl.placeMediaAssets(['asset-av'], 'v1', 200);
    const videoBefore = ctrl.getClips().find((c) => c.type === 'video')!;

    ctrl.placeClipWithMode({
      assetId: 'asset-av', trackId: 'v1', mode: 'insert',
      startFrame: 100, durationFrames: 80,
    });

    const videoAfter = ctrl.getClips().find((c) => c.id === videoBefore.id)!;
    expect(videoAfter.startFrame).toBe(280); // pushed by the insertion
    // The linked audio partner moved the same amount on its own lane.
    const partner = ctrl.getClips().find((c) =>
      c.linkGroupId === videoAfter.linkGroupId && c.id !== videoAfter.id)!;
    expect(partner.startFrame - videoBefore.startFrame).toBe(80);
  });

  it('refuses locked tracks and unknown assets without mutating', () => {
    const ctrl = controllerWithMedia();
    ctrl.setTrackLocked('v1', true);
    expect(ctrl.placeClipWithMode({ assetId: 'asset-video', trackId: 'v1' })).toBeNull();
    ctrl.setTrackLocked('v1', false);
    expect(ctrl.placeClipWithMode({ assetId: 'ghost', trackId: 'v1' })).toBeNull();
    expect(ctrl.placeClipWithMode({ assetId: 'asset-video', trackId: 'a1' })).toBeNull();
    expect(ctrl.getClips()).toHaveLength(0);
  });

  it('is one undo step per placement', () => {
    const ctrl = controllerWithMedia();
    ctrl.addClip({
      assetId: 'asset-video', trackId: 'v1', startFrame: 200, durationFrames: 100,
    });

    ctrl.placeClipWithMode({
      assetId: 'asset-video', trackId: 'v1', mode: 'insert',
      startFrame: 100, durationFrames: 50,
    });
    const clipsAfterInsert = ctrl.getClips().length;

    ctrl.undo();
    expect(ctrl.getClips()).toHaveLength(1);
    expect(ctrl.getClips()[0].startFrame).toBe(200);
    void clipsAfterInsert;
  });
});
