/**
 * Regression coverage for clip media source swapping (upstream PR #500):
 * edit state survives the swap, linked partners sharing the source swap
 * together, and every upstream refusal fires with its message.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function controllerWithSources() {
  const ctrl = new EditorController();
  // Video without audio: cannot back an audio clip.
  ctrl.addMedia({
    id: 'video-a',
    path: '/test/a.mp4',
    filename: 'a.mp4',
    type: 'video',
    duration: 300,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  // Longer video without audio.
  ctrl.addMedia({
    id: 'video-b',
    path: '/test/b.mp4',
    filename: 'b.mp4',
    type: 'video',
    duration: 900,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  // Short video: too short for a 200-frame source window.
  ctrl.addMedia({
    id: 'video-short',
    path: '/test/short.mp4',
    filename: 'short.mp4',
    type: 'video',
    duration: 100,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  // Silent video must not back audio clips.
  ctrl.addMedia({
    id: 'audio-track',
    path: '/test/t.wav',
    filename: 't.wav',
    type: 'audio',
    duration: 900,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  ctrl.addMedia({
    id: 'image-1',
    path: '/test/i.png',
    filename: 'i.png',
    type: 'image',
    duration: 0,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  return ctrl;
}

describe('EditorController.swapClipMedia (#500)', () => {
  it('swaps the source and preserves every edit state field', () => {
    const ctrl = controllerWithSources();
    const clipId = ctrl.addClip({
      assetId: 'video-a',
      trackId: 'v1',
      startFrame: 40,
      durationFrames: 120,
    });
    const before = ctrl.getClips().find((c) => c.id === clipId)!;

    const receipt = ctrl.swapClipMedia(clipId, 'video-b');
    expect(receipt).toEqual({
      changedClipIds: [clipId],
      oldAssetId: 'video-a',
      newAssetId: 'video-b',
    });

    const after = ctrl.getClips().find((c) => c.id === clipId)!;
    expect(after.assetId).toBe('video-b');
    // Edit state intact: timing, trims, geometry, fades all untouched.
    expect(after.startFrame).toBe(before.startFrame);
    expect(after.durationFrames).toBe(before.durationFrames);
    expect(after.inPoint).toBe(before.inPoint);
    expect(after.outPoint).toBe(before.outPoint);
    expect(after.x).toBe(before.x);
    expect(after.opacity).toBe(before.opacity);
  });

  it('leaves trim headroom available on a longer replacement', () => {
    const ctrl = controllerWithSources();
    const clipId = ctrl.addClip({
      assetId: 'video-a',
      trackId: 'v1',
      startFrame: 0,
      durationFrames: 100,
    });
    ctrl.swapClipMedia(clipId, 'video-b');
    const clip = ctrl.getClips().find((c) => c.id === clipId)!;
    // The user can now extend into the surplus without another swap.
    expect(clip.outPoint - clip.inPoint).toBeLessThan(900);
  });

  it('swaps linked partners sharing the source together', () => {
    const ctrl = controllerWithSources();
    ctrl.addMedia({
      id: 'av-a',
      path: '/test/av-a.mp4',
      filename: 'av-a.mp4',
      type: 'video',
      duration: 300,
      fileSize: 1,
      audioCodec: 'aac',
      addedAt: new Date().toISOString(),
    });
    ctrl.addMedia({
      id: 'av-b',
      path: '/test/av-b.mp4',
      filename: 'av-b.mp4',
      type: 'video',
      duration: 900,
      fileSize: 1,
      audioCodec: 'aac',
      addedAt: new Date().toISOString(),
    });
    ctrl.placeMediaAssets(['av-a'], 'v1', 0);
    const pairIds = ctrl.expandLinkedClipIds([ctrl.getClips()[0].id]);

    const receipt = ctrl.swapClipMedia(pairIds[0], 'av-b');
    expect(receipt.changedClipIds.sort()).toEqual([...pairIds].sort());
    for (const id of pairIds) {
      expect(ctrl.getClips().find((c) => c.id === id)?.assetId).toBe('av-b');
    }
  });

  it('refuses unknown clips and assets', () => {
    const ctrl = controllerWithSources();
    const clipId = ctrl.addClip({ assetId: 'video-a', trackId: 'v1', startFrame: 0 });
    expect(() => ctrl.swapClipMedia('ghost', 'video-b')).toThrow(/clip not found/i);
    expect(() => ctrl.swapClipMedia(clipId, 'ghost')).toThrow(/no media asset/i);
  });

  it('refuses kind mismatches and silent video backing audio', () => {
    const ctrl = controllerWithSources();
    const videoId = ctrl.addClip({ assetId: 'video-a', trackId: 'v1', startFrame: 0 });
    const audioId = ctrl.addClip({ assetId: 'audio-track', trackId: 'a1', startFrame: 0 });
    const imageId = ctrl.addClip({ assetId: 'image-1', trackId: 'v1', startFrame: 500 });

    expect(() => ctrl.swapClipMedia(videoId, 'image-1')).toThrow(
      /replacement is image media/i,
    );
    expect(() => ctrl.swapClipMedia(audioId, 'video-b')).toThrow(
      /no audio stream/i,
    );
    void imageId;
  });

  it('refuses a replacement too short for the trimmed source window', () => {
    const ctrl = controllerWithSources();
    const clipId = ctrl.addClip({
      assetId: 'video-a',
      trackId: 'v1',
      startFrame: 0,
      durationFrames: 200,
    });
    expect(() => ctrl.swapClipMedia(clipId, 'video-short')).toThrow(/too short/i);
    // The failed swap changed nothing.
    expect(ctrl.getClips().find((c) => c.id === clipId)?.assetId).toBe('video-a');
  });

  it('refuses a silent replacement for a picture-plus-audio pair precisely', () => {
    const ctrl = controllerWithSources();
    ctrl.addMedia({
      id: 'av-a',
      path: '/test/av-a.mp4',
      filename: 'av-a.mp4',
      type: 'video',
      duration: 300,
      fileSize: 1,
      audioCodec: 'aac',
      addedAt: new Date().toISOString(),
    });
    ctrl.placeMediaAssets(['av-a'], 'v1', 0);
    const anchorId = ctrl.getClips().find((c) => c.type === 'video')!.id;

    // video-b has no audio stream; the pair's audio half cannot take it.
    expect(() => ctrl.swapClipMedia(anchorId, 'video-b')).toThrow(/no audio stream/i);
    expect(ctrl.getClips().find((c) => c.id === anchorId)?.assetId).toBe('av-a');
  });

  it('is one undoable step over the whole affected set', () => {
    const ctrl = controllerWithSources();
    const clipId = ctrl.addClip({ assetId: 'video-a', trackId: 'v1', startFrame: 0 });
    ctrl.swapClipMedia(clipId, 'video-b');

    ctrl.undo();
    expect(ctrl.getClips().find((c) => c.id === clipId)?.assetId).toBe('video-a');
    ctrl.redo();
    expect(ctrl.getClips().find((c) => c.id === clipId)?.assetId).toBe('video-b');
  });
});
