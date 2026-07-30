import { describe, expect, it } from 'vitest';
import { EditorController } from './controller';
import type { MediaAsset } from '../types/project';

function asset(
  id: string,
  type: MediaAsset['type'],
  duration: number,
  options: Partial<MediaAsset> = {},
): MediaAsset {
  return {
    id,
    path: `C:\\media\\${id}`,
    filename: id,
    type,
    duration,
    fileSize: 100,
    addedAt: '2026-07-24T00:00:00.000Z',
    ...options,
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

  it('places embedded video audio as a linked clip on an audio track', () => {
    const controller = new EditorController();
    const result = controller.importAndPlaceMedia(
      [asset('interview.mp4', 'video', 120, { audioCodec: 'aac', channels: 2 })],
      'v1',
      24,
    );

    expect(result.clipIds).toHaveLength(2);
    const video = controller.getClips().find((clip) => clip.type === 'video');
    const audio = controller.getClips().find((clip) => clip.type === 'audio');
    expect(video).toMatchObject({
      assetId: 'interview.mp4',
      trackId: 'v1',
      startFrame: 24,
      durationFrames: 120,
    });
    expect(audio).toMatchObject({
      assetId: 'interview.mp4',
      trackId: 'a1',
      startFrame: 24,
      durationFrames: 120,
    });
    expect(video?.linkGroupId).toBeTruthy();
    expect(audio?.linkGroupId).toBe(video?.linkGroupId);
    expect(controller.expandLinkedClipIds([video!.id]).sort()).toEqual(
      [video!.id, audio!.id].sort(),
    );
  });

  it('does not create linked audio for a silent video', () => {
    const controller = new EditorController();
    const result = controller.importAndPlaceMedia(
      [asset('silent.mp4', 'video', 90, { codec: 'h264' })],
      'v1',
      0,
    );

    expect(result.clipIds).toHaveLength(1);
    expect(controller.getClips()[0].linkGroupId).toBeUndefined();
  });

  it('creates and atomically undoes an audio track when existing lanes are occupied', () => {
    const controller = new EditorController();
    controller.addMedia(asset('music.wav', 'audio', 180));
    controller.addClip({
      assetId: 'music.wav',
      trackId: 'a1',
      startFrame: 0,
      durationFrames: 180,
    });

    const result = controller.importAndPlaceMedia(
      [asset('camera.mp4', 'video', 90, { audioCodec: 'aac' })],
      'v1',
      30,
    );

    expect(result.clipIds).toHaveLength(2);
    expect(controller.getTracks().filter((track) => track.type === 'audio')).toHaveLength(2);
    const linkedAudio = controller.getClips().find(
      (clip) => result.clipIds.includes(clip.id) && clip.type === 'audio',
    );
    expect(linkedAudio?.trackId).not.toBe('a1');

    expect(controller.undo()).toBe(true);
    expect(controller.getMedia().map((item) => item.id)).toEqual(['music.wav']);
    expect(controller.getClips()).toHaveLength(1);
    expect(controller.getTracks().filter((track) => track.type === 'audio')).toHaveLength(1);

    expect(controller.redo()).toBe(true);
    expect(controller.getTracks().filter((track) => track.type === 'audio')).toHaveLength(2);
    expect(controller.getClips()).toHaveLength(3);
  });

  it('keeps a linked pair synchronized through move, trim, split, and delete', () => {
    const controller = new EditorController();
    const placed = controller.importAndPlaceMedia(
      [asset('take.mp4', 'video', 120, { audioCodec: 'aac' })],
      'v1',
      10,
    );
    const video = controller.getClips().find((clip) => clip.type === 'video')!;

    controller.moveClip(video.id, 40);
    expect(controller.getClips().map((clip) => clip.startFrame)).toEqual([40, 40]);

    controller.trimClip(video.id, 5, 95);
    expect(controller.getClips().map((clip) => ({
      inPoint: clip.inPoint,
      outPoint: clip.outPoint,
      durationFrames: clip.durationFrames,
    }))).toEqual([
      { inPoint: 5, outPoint: 95, durationFrames: 90 },
      { inPoint: 5, outPoint: 95, durationFrames: 90 },
    ]);

    const rightVideoId = controller.splitClip(video.id, 70);
    expect(rightVideoId).toBeTruthy();
    expect(controller.getClips()).toHaveLength(4);
    const rightVideo = controller.getClips().find((clip) => clip.id === rightVideoId)!;
    const rightGroup = controller.getClips().filter(
      (clip) => clip.linkGroupId === rightVideo.linkGroupId,
    );
    expect(rightGroup).toHaveLength(2);
    expect(rightGroup.map((clip) => clip.startFrame)).toEqual([70, 70]);

    controller.removeClip(rightVideo.id);
    expect(controller.getClips()).toHaveLength(2);
    expect(controller.getClips().every((clip) => clip.startFrame === 40)).toBe(true);

    expect(controller.undo()).toBe(true);
    expect(controller.getClips()).toHaveLength(4);
    expect(placed.clipIds).toHaveLength(2);
  });

  it('uses linked placement for the shared addClip command surface', () => {
    const controller = new EditorController();
    controller.addMedia(asset('agent-take.mp4', 'video', 75, { audioCodec: 'aac' }));

    const videoId = controller.addClip({
      assetId: 'agent-take.mp4',
      trackId: 'v1',
      startFrame: 15,
    });

    const linkedIds = controller.expandLinkedClipIds([videoId]);
    expect(linkedIds).toHaveLength(2);
    expect(controller.getClips().filter((clip) => linkedIds.includes(clip.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'video', trackId: 'v1', startFrame: 15 }),
        expect.objectContaining({ type: 'audio', trackId: 'a1', startFrame: 15 }),
      ]),
    );

    controller.undo();
    expect(controller.getMedia()).toHaveLength(1);
    expect(controller.getClips()).toHaveLength(0);
  });
});
