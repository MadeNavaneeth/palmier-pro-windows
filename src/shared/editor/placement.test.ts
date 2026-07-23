import { describe, expect, it } from 'vitest';
import { EditorController } from './controller';
import type { MediaAsset } from '../types/project';

function asset(
  id: string,
  type: MediaAsset['type'],
  duration: number,
): MediaAsset {
  return {
    id,
    path: `C:\\media\\${id}`,
    filename: id,
    type,
    duration,
    fileSize: 100,
    addedAt: '2026-07-24T00:00:00.000Z',
  };
}

describe('atomic media placement', () => {
  it('imports all media and sequentially places compatible assets', () => {
    const controller = new EditorController();
    const result = controller.importAndPlaceMedia(
      [
        asset('video.mp4', 'video', 90),
        asset('audio.wav', 'audio', 60),
        asset('still.png', 'image', 0),
      ],
      'v1',
      30,
    );

    expect(result.assetIds).toHaveLength(3);
    expect(result.clipIds).toHaveLength(2);
    expect(controller.getMedia()).toHaveLength(3);
    expect(controller.getClips().map((clip) => ({
      assetId: clip.assetId,
      startFrame: clip.startFrame,
      durationFrames: clip.durationFrames,
    }))).toEqual([
      { assetId: 'video.mp4', startFrame: 30, durationFrames: 90 },
      { assetId: 'still.png', startFrame: 120, durationFrames: 150 },
    ]);
  });

  it('undoes import and placement together after transient playhead movement', () => {
    const controller = new EditorController();
    controller.importAndPlaceMedia([asset('video.mp4', 'video', 90)], 'v1', 12);
    controller.setPlayhead(12);

    expect(controller.undo()).toBe(true);
    expect(controller.getMedia()).toHaveLength(0);
    expect(controller.getClips()).toHaveLength(0);
    expect(controller.getPlayhead()).toBe(12);

    expect(controller.redo()).toBe(true);
    expect(controller.getMedia()).toHaveLength(1);
    expect(controller.getClips()).toHaveLength(1);
  });

  it('imports incompatible media without placing it on the wrong track', () => {
    const controller = new EditorController();
    const result = controller.importAndPlaceMedia(
      [asset('dialogue.wav', 'audio', 60)],
      'v1',
      0,
    );

    expect(result.assetIds).toEqual(['dialogue.wav']);
    expect(result.clipIds).toEqual([]);
    expect(controller.getMedia()).toHaveLength(1);
    expect(controller.getClips()).toHaveLength(0);
  });

  it('places existing media without removing it on undo', () => {
    const controller = new EditorController();
    controller.addMedia(asset('video.mp4', 'video', 90));

    const result = controller.placeMediaAssets(['video.mp4'], 'v1', 45);
    expect(result.clipIds).toHaveLength(1);
    expect(controller.getClips()[0].startFrame).toBe(45);

    controller.undo();
    expect(controller.getMedia()).toHaveLength(1);
    expect(controller.getClips()).toHaveLength(0);
  });
});
