import { describe, expect, it } from 'vitest';
import { EditorController } from './controller';
import { createEmptyProject, type Clip, type MediaAsset, type Project, type Track } from '../types/project';

function asset(id: string, duration = 200): MediaAsset {
  return {
    id,
    path: `C:\\media\\${id}.mp4`,
    filename: `${id}.mp4`,
    type: 'video',
    duration,
    fileSize: 100,
    addedAt: '2026-07-25T00:00:00.000Z',
  };
}

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
    assetId: id,
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
    volume: 1,
    muted: false,
  };
}

function project(clips: Clip[], tracks?: Track[]): Project {
  const value = createEmptyProject('Ripple trim test');
  return {
    ...value,
    media: clips.map((item) => asset(item.assetId)),
    timeline: {
      ...value.timeline,
      tracks: tracks || value.timeline.tracks,
      clips,
    },
  };
}

describe('edge trim and gap ripple editing', () => {
  it('moves a normal left trim edge while preserving the clip end', () => {
    const controller = new EditorController(project([
      clip('lead', 'v1', 20, 80, { inPoint: 20 }),
    ]));

    controller.trimClipEdge('lead', 'left', 10);

    expect(controller.getClips()[0]).toMatchObject({
      startFrame: 30,
      durationFrames: 70,
      inPoint: 30,
      outPoint: 100,
    });
  });

  it('ripple trims linked clips and shifts downstream clips on both tracks', () => {
    const controller = new EditorController(project([
      clip('v1', 'v1', 0, 100, { linkGroupId: 'lead' }),
      clip('a1', 'a1', 0, 100, { linkGroupId: 'lead' }),
      clip('v2', 'v1', 100, 40, { linkGroupId: 'follow' }),
      clip('a2', 'a1', 100, 40, { linkGroupId: 'follow' }),
    ]));

    const report = controller.trimClipEdge('v1', 'right', 20, true);

    expect(report?.resizedClipIds.sort()).toEqual(['a1', 'v1']);
    expect(report?.shiftedClipIds.sort()).toEqual(['a2', 'v2']);
    expect(controller.getClips().map((item) => [item.id, item.startFrame, item.durationFrames]).sort())
      .toEqual([
        ['a1', 0, 120],
        ['a2', 120, 40],
        ['v1', 0, 120],
        ['v2', 120, 40],
      ]);
    expect(controller.undo()).toBe(true);
    expect(controller.getClips().find((item) => item.id === 'v2')?.startFrame).toBe(100);
  });

  it('clamps a shrinking ripple trim before a sync-locked collision', () => {
    const tracks = [
      ...createEmptyProject().timeline.tracks,
      {
        id: 'a2',
        name: 'Audio 2',
        type: 'audio' as const,
        locked: false,
        visible: true,
        syncLocked: true,
        order: 2,
      },
    ];
    const controller = new EditorController(project([
      clip('lead', 'v1', 0, 100),
      clip('wall', 'a2', 60, 30),
      clip('follow', 'a2', 120, 30),
    ], tracks));

    const report = controller.trimClipEdge('lead', 'right', -50, true);

    expect(report?.durationDelta).toBe(-30);
    expect(controller.getClips().find((item) => item.id === 'lead')?.durationFrames).toBe(70);
    expect(controller.getClips().find((item) => item.id === 'follow')?.startFrame).toBe(90);
  });

  it('closes a bounded gap on the anchor and sync-locked tracks', () => {
    const controller = new EditorController(project([
      clip('v1', 'v1', 0, 50),
      clip('v2', 'v1', 100, 50),
      clip('a1', 'a1', 120, 30),
    ]));

    const report = controller.rippleDeleteGap('v1', { start: 50, end: 100 });

    expect(report?.shiftedClipIds.sort()).toEqual(['a1', 'v2']);
    expect(controller.getClips().find((item) => item.id === 'v2')?.startFrame).toBe(50);
    expect(controller.getClips().find((item) => item.id === 'a1')?.startFrame).toBe(70);
  });

  it('refuses a gap close that would collide on a sync-locked track', () => {
    const controller = new EditorController(project([
      clip('v1', 'v1', 0, 50),
      clip('v2', 'v1', 100, 50),
      clip('wall', 'a1', 0, 55),
      clip('follow', 'a1', 100, 30),
    ]));

    expect(controller.rippleDeleteGap('v1', { start: 50, end: 100 })).toBeNull();
    expect(controller.getClips().find((item) => item.id === 'v2')?.startFrame).toBe(100);
    expect(controller.undo()).toBe(false);
  });

  it('rejects reversed gap bounds without guessing a replacement range', () => {
    const controller = new EditorController(project([
      clip('v1', 'v1', 0, 50),
      clip('v2', 'v1', 100, 50),
    ]));

    expect(controller.rippleDeleteGap('v1', { start: 100, end: 50 })).toBeNull();
    expect(controller.getClips().find((item) => item.id === 'v2')?.startFrame).toBe(100);
  });
});
