import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { createEmptyProject } from '../types/project';

describe('EditorController', () => {
  it('creates with a default empty project', () => {
    const ctrl = new EditorController();
    const project = ctrl.getProject();
    expect(project.name).toBe('Untitled Project');
    expect(project.timeline.tracks).toHaveLength(2);
    expect(project.timeline.clips).toHaveLength(0);
  });

  it('adds a track and can undo', () => {
    const ctrl = new EditorController();
    const trackId = ctrl.addTrack('video', 'Video 2');
    expect(ctrl.getTracks()).toHaveLength(3);
    expect(ctrl.getTracks().find((t) => t.id === trackId)?.name).toBe('Video 2');

    ctrl.undo();
    expect(ctrl.getTracks()).toHaveLength(2);
  });

  it('adds a clip, moves it, and undoes both', () => {
    const ctrl = new EditorController();
    // Add a media asset first
    ctrl.addMedia({
      id: 'asset-1',
      path: '/test/video.mp4',
      filename: 'video.mp4',
      type: 'video',
      duration: 300,
      fileSize: 1000000,
      addedAt: new Date().toISOString(),
    });

    const clipId = ctrl.addClip({
      assetId: 'asset-1',
      trackId: 'v1',
      startFrame: 0,
    });

    expect(ctrl.getClips()).toHaveLength(1);
    expect(ctrl.getClips()[0].startFrame).toBe(0);

    ctrl.moveClip(clipId, 30);
    expect(ctrl.getClips()[0].startFrame).toBe(30);

    ctrl.undo(); // undo move
    expect(ctrl.getClips()[0].startFrame).toBe(0);

    ctrl.undo(); // undo add
    expect(ctrl.getClips()).toHaveLength(0);
  });

  it('splits a clip into two', () => {
    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'asset-1',
      path: '/test/video.mp4',
      filename: 'video.mp4',
      type: 'video',
      duration: 300,
      fileSize: 1000000,
      addedAt: new Date().toISOString(),
    });

    const clipId = ctrl.addClip({
      assetId: 'asset-1',
      trackId: 'v1',
      startFrame: 0,
      durationFrames: 100,
    });

    const newClipId = ctrl.splitClip(clipId, 50);
    expect(newClipId).not.toBeNull();
    expect(ctrl.getClips()).toHaveLength(2);

    const left = ctrl.getClips().find((c) => c.id === clipId);
    const right = ctrl.getClips().find((c) => c.id === newClipId);
    expect(left?.durationFrames).toBe(50);
    expect(right?.startFrame).toBe(50);
    expect(right?.durationFrames).toBe(50);
  });

  it('serializes and deserializes', () => {
    const ctrl = new EditorController();
    ctrl.addTrack('audio', 'Audio 2');
    const json = ctrl.serialize();
    const ctrl2 = EditorController.deserialize(json);
    expect(ctrl2.getTracks()).toHaveLength(3);
  });
});

/**
 * Placement onto a track that does not exist (#302, upstream PR #307's
 * mis-targeting class).
 *
 * Tracks are what the timeline, the compositor and the exporter iterate, so a
 * clip naming an unknown track is invisible everywhere while still counting in
 * the clip list and toward the project duration. Reporting success for that is
 * worse than refusing: an agent that invented the track id is told the edit
 * landed and goes on to build on it.
 */
describe('EditorController.addClip track targeting', () => {
  function withAsset() {
    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'asset-1',
      path: 'C:\\media\\video.mp4',
      filename: 'video.mp4',
      type: 'video',
      duration: 300,
      fileSize: 1000,
      addedAt: '2026-07-29T00:00:00.000Z',
    });
    return ctrl;
  }

  it('refuses an unknown track instead of creating an unreachable clip', () => {
    const ctrl = withAsset();

    const clipId = ctrl.addClip({ assetId: 'asset-1', trackId: 'no-such-track', startFrame: 0 });

    expect(clipId).toBe('');
    expect(ctrl.getClips()).toHaveLength(0);
    // Nothing happened, so there is nothing to undo either.
    expect(ctrl.canUndo()).toBe(false);
  });

  it('still places onto a track that exists', () => {
    const ctrl = withAsset();
    const second = ctrl.addTrack('video', 'Video 2');

    const onDefault = ctrl.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 0 });
    const onSecond = ctrl.addClip({ assetId: 'asset-1', trackId: second, startFrame: 300 });

    expect(onDefault).not.toBe('');
    expect(onSecond).not.toBe('');
    expect(ctrl.getClips().map((clip) => clip.trackId)).toContain(second);
  });

  it('leaves no clip referencing a track that is not in the project', () => {
    const ctrl = withAsset();
    ctrl.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 0 });
    ctrl.addClip({ assetId: 'asset-1', trackId: 'ghost', startFrame: 300 });

    const trackIds = new Set(ctrl.getTracks().map((track) => track.id));
    expect(ctrl.getClips().every((clip) => trackIds.has(clip.trackId))).toBe(true);
  });
});
