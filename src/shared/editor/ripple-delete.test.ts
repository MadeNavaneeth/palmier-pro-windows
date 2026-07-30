import { describe, expect, it } from 'vitest';
import { EditorController } from './controller';
import { createEmptyProject, type Clip, type Project, type Track } from '../types/project';

function clip(
  id: string,
  trackId: string,
  startFrame: number,
  durationFrames: number,
  linkGroupId?: string,
): Clip {
  return {
    id,
    assetId: `${id}-asset`,
    type: trackId.startsWith('a') ? 'audio' : 'video',
    trackId,
    linkGroupId,
    startFrame,
    durationFrames,
    inPoint: 0,
    outPoint: durationFrames,
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
  const value = createEmptyProject('Ripple test');
  return {
    ...value,
    timeline: {
      ...value.timeline,
      tracks: tracks || value.timeline.tracks,
      clips,
    },
  };
}

describe('atomic ripple delete', () => {
  it('removes a linked pair and shifts its downstream pair exactly once', () => {
    const controller = new EditorController(project([
      clip('v1', 'v1', 0, 50, 'lead'),
      clip('a1', 'a1', 0, 50, 'lead'),
      clip('v2', 'v1', 50, 40, 'follow'),
      clip('a2', 'a1', 50, 40, 'follow'),
    ]));

    const report = controller.rippleDeleteClips(['v1']);

    expect(report?.removedClipIds.sort()).toEqual(['a1', 'v1']);
    expect(report?.shiftedClipIds.sort()).toEqual(['a2', 'v2']);
    expect(controller.getClips().map((item) => [item.id, item.startFrame]).sort()).toEqual([
      ['a2', 0],
      ['v2', 0],
    ]);

    expect(controller.undo()).toBe(true);
    expect(controller.getClips()).toHaveLength(4);
    expect(controller.getClips().find((item) => item.id === 'v2')?.startFrame).toBe(50);
    expect(controller.undo()).toBe(false);

    expect(controller.redo()).toBe(true);
    expect(controller.getClips()).toHaveLength(2);
  });

  it('shifts an unrelated follower on a sync-locked track', () => {
    const base = createEmptyProject().timeline.tracks;
    const tracks = [
      ...base,
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
      clip('lead', 'v1', 10, 30),
      clip('music', 'a2', 80, 20),
    ], tracks));

    controller.rippleDeleteClips(['lead']);

    expect(controller.getClips().find((item) => item.id === 'music')?.startFrame).toBe(50);
  });

  it('leaves tracks with sync lock disabled in place', () => {
    const tracks = createEmptyProject().timeline.tracks.map((track) =>
      track.id === 'a1' ? { ...track, syncLocked: false } : track,
    );
    const controller = new EditorController(project([
      clip('lead', 'v1', 10, 30),
      clip('music', 'a1', 80, 20),
    ], tracks));

    controller.rippleDeleteClips(['lead']);

    expect(controller.getClips().find((item) => item.id === 'music')?.startFrame).toBe(80);
  });

  it('accumulates noncontiguous removed ranges on the edited track', () => {
    const controller = new EditorController(project([
      clip('remove-1', 'v1', 0, 20),
      clip('keep-1', 'v1', 20, 20),
      clip('remove-2', 'v1', 40, 20),
      clip('keep-2', 'v1', 60, 20),
    ]));

    controller.rippleDeleteClips(['remove-1', 'remove-2']);

    expect(controller.getClips().map((item) => [item.id, item.startFrame])).toEqual([
      ['keep-1', 0],
      ['keep-2', 20],
    ]);
  });

  it('refuses to mutate a selected clip on a locked track', () => {
    const tracks = createEmptyProject().timeline.tracks.map((track) =>
      track.id === 'v1' ? { ...track, locked: true } : track,
    );
    const controller = new EditorController(project([clip('protected', 'v1', 0, 30)], tracks));

    expect(controller.rippleDeleteClips(['protected'])).toBeNull();
    expect(controller.removeClip('protected')).toBe(false);
    expect(controller.getClips()).toHaveLength(1);
    expect(controller.undo()).toBe(false);
  });

  it('makes track state toggles undoable and treats legacy sync lock as enabled', () => {
    const controller = new EditorController();
    expect(controller.getTracks().find((track) => track.id === 'v1')?.syncLocked).toBe(true);

    expect(controller.setTrackSyncLocked('v1', false)).toBe(true);
    expect(controller.getTracks().find((track) => track.id === 'v1')?.syncLocked).toBe(false);

    expect(controller.undo()).toBe(true);
    expect(controller.getTracks().find((track) => track.id === 'v1')?.syncLocked).toBe(true);
  });
});
