import { describe, expect, it } from 'vitest';
import { EditorController } from './controller';
import { createEmptyProject, type Clip, type Project, type Track } from '../types/project';

function clip(
  id: string,
  trackId: string,
  startFrame: number,
  durationFrames: number,
  options: { inPoint?: number; linkGroupId?: string } = {},
): Clip {
  const inPoint = options.inPoint ?? 0;
  return {
    id,
    assetId: `${id}-asset`,
    type: trackId.startsWith('a') ? 'audio' : 'video',
    trackId,
    linkGroupId: options.linkGroupId,
    startFrame,
    durationFrames,
    inPoint,
    outPoint: inPoint + durationFrames,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 960,
    anchorY: 540,
    fadeInFrames: 5,
    fadeOutFrames: 7,
    volume: 1,
    muted: false,
  };
}

function project(clips: Clip[], tracks?: Track[]): Project {
  const value = createEmptyProject('Range extract test');
  return {
    ...value,
    timeline: {
      ...value.timeline,
      tracks: tracks || value.timeline.tracks,
      clips,
    },
  };
}

function spans(controller: EditorController, trackId: string) {
  return controller.getClips()
    .filter((item) => item.trackId === trackId)
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((item) => [item.startFrame, item.startFrame + item.durationFrames]);
}

describe('atomic ripple range deletion', () => {
  it('splits a middle cut, preserves source offsets, and keeps fades on outer edges', () => {
    const controller = new EditorController(project([
      clip('lead', 'v1', 0, 100, { inPoint: 20 }),
    ]));

    const report = controller.rippleDeleteRanges('v1', [{ start: 40, end: 50 }]);
    const fragments = controller.getClips().sort((a, b) => a.startFrame - b.startFrame);

    expect(report?.removedFrames).toBe(10);
    expect(report?.fragmentClipIds).toHaveLength(1);
    expect(spans(controller, 'v1')).toEqual([[0, 40], [40, 90]]);
    expect(fragments.map((item) => [item.inPoint, item.outPoint])).toEqual([
      [20, 60],
      [70, 120],
    ]);
    expect(fragments[0]).toMatchObject({ fadeInFrames: 5, fadeOutFrames: 0 });
    expect(fragments[1]).toMatchObject({ fadeInFrames: 0, fadeOutFrames: 7 });
  });

  it('merges overlapping cuts and shifts later clips by the total removed time', () => {
    const controller = new EditorController(project([
      clip('first', 'v1', 0, 100),
      clip('second', 'v1', 100, 100),
    ]));

    const report = controller.rippleDeleteRanges('v1', [
      { start: 20, end: 35 },
      { start: 30, end: 40 },
      { start: 150, end: 160 },
    ]);

    expect(report?.removedFrames).toBe(30);
    expect(spans(controller, 'v1')).toEqual([
      [0, 20],
      [20, 80],
      [80, 130],
      [130, 170],
    ]);
  });

  it('cuts linked partners into matching linked fragment cohorts', () => {
    const controller = new EditorController(project([
      clip('video', 'v1', 0, 100, { linkGroupId: 'source' }),
      clip('audio', 'a1', 0, 100, { linkGroupId: 'source' }),
    ]));

    controller.rippleDeleteRanges('v1', [{ start: 40, end: 50 }]);

    const video = controller.getClips()
      .filter((item) => item.trackId === 'v1')
      .sort((a, b) => a.startFrame - b.startFrame);
    const audio = controller.getClips()
      .filter((item) => item.trackId === 'a1')
      .sort((a, b) => a.startFrame - b.startFrame);
    expect(video.map((item) => item.linkGroupId)).toEqual(
      audio.map((item) => item.linkGroupId),
    );
    expect(video[0].linkGroupId).not.toBe(video[1].linkGroupId);
  });

  it('cuts content on sync-locked tracks and leaves opted-out tracks untouched', () => {
    const tracks = [
      ...createEmptyProject().timeline.tracks,
      {
        id: 'a2',
        name: 'Audio 2',
        type: 'audio' as const,
        locked: false,
        visible: true,
        syncLocked: false,
        order: 2,
      },
    ];
    const controller = new EditorController(project([
      clip('video', 'v1', 0, 100),
      clip('audio', 'a1', 0, 100),
      clip('music', 'a2', 120, 30),
    ], tracks));

    controller.rippleDeleteRanges('v1', [{ start: 40, end: 50 }]);

    expect(spans(controller, 'v1')).toEqual([[0, 40], [40, 90]]);
    expect(spans(controller, 'a1')).toEqual([[0, 40], [40, 90]]);
    expect(spans(controller, 'a2')).toEqual([[120, 150]]);
  });

  it('refuses the whole edit when an affected linked track is locked', () => {
    const tracks = createEmptyProject().timeline.tracks.map((track) =>
      track.id === 'a1' ? { ...track, locked: true, syncLocked: false } : track,
    );
    const controller = new EditorController(project([
      clip('video', 'v1', 0, 100, { linkGroupId: 'source' }),
      clip('audio', 'a1', 0, 100, { linkGroupId: 'source' }),
    ], tracks));

    expect(controller.rippleDeleteRanges('v1', [{ start: 40, end: 50 }])).toBeNull();
    expect(controller.getClips()).toHaveLength(2);
    expect(controller.undo()).toBe(false);
  });

  it('clears marks on commit and restores clips and marks with one undo', () => {
    const controller = new EditorController(project([clip('lead', 'v1', 0, 100)]));
    controller.setInFrame(30);
    controller.setOutFrame(50);

    controller.rippleDeleteRanges('v1', [{ start: 30, end: 50 }]);

    expect(controller.getTimeline()).toMatchObject({
      inFrame: undefined,
      outFrame: undefined,
    });
    expect(spans(controller, 'v1')).toEqual([[0, 30], [30, 80]]);

    expect(controller.undo()).toBe(true);
    expect(controller.getTimeline()).toMatchObject({ inFrame: 30, outFrame: 50 });
    expect(spans(controller, 'v1')).toEqual([[0, 100]]);
    expect(controller.undo()).toBe(false);
  });
});
