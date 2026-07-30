/**
 * Regression coverage for undoable media deletion from the media browser
 * (upstream PR #409's `deleteMediaAssets`). Deleting an asset must take its
 * dependent clips with it, in one undo step, and must respect track locks.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function asset(id: string, type: 'video' | 'audio' = 'video') {
  return {
    id,
    path: `/${id}.${type === 'audio' ? 'mp3' : 'mp4'}`,
    filename: `${id}.${type === 'audio' ? 'mp3' : 'mp4'}`,
    type,
    duration: 300,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  } as const;
}

function withMedia() {
  const ctrl = new EditorController();
  ctrl.addMedia(asset('a1'));
  ctrl.addMedia(asset('a2'));
  ctrl.addMedia(asset('unused'));
  const clip1 = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 60 });
  const clip2 = ctrl.addClip({ assetId: 'a2', trackId: 'v1', startFrame: 60, durationFrames: 60 });
  return { ctrl, clip1, clip2 };
}

describe('removeMediaAssets', () => {
  it('removes an asset and its dependent clips in one undoable step', () => {
    const { ctrl, clip1, clip2 } = withMedia();

    const report = ctrl.removeMediaAssets(['a1']);

    expect(report).toEqual({ removedAssetIds: ['a1'], removedClipIds: [clip1] });
    expect(ctrl.getMedia().map((item) => item.id)).toEqual(['a2', 'unused']);
    expect(ctrl.getClips().map((clip) => clip.id)).toEqual([clip2]);

    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getMedia().map((item) => item.id)).toEqual(['a1', 'a2', 'unused']);
    expect(ctrl.getClips().map((clip) => clip.id)).toEqual([clip1, clip2]);

    ctrl.redo();
    expect(ctrl.getClips().map((clip) => clip.id)).toEqual([clip2]);
  });

  it('removes several assets and all their clips in one step', () => {
    const { ctrl } = withMedia();

    const report = ctrl.removeMediaAssets(['a1', 'a2', 'missing']);

    expect(report!.removedAssetIds).toEqual(['a1', 'a2']);
    expect(report!.removedClipIds).toHaveLength(2);
    expect(ctrl.getClips()).toEqual([]);
    expect(ctrl.getMedia().map((item) => item.id)).toEqual(['unused']);

    ctrl.undo();
    expect(ctrl.getClips()).toHaveLength(2);
    expect(ctrl.getMedia()).toHaveLength(3);
  });

  it('removes an unused asset without touching the timeline', () => {
    const { ctrl, clip1, clip2 } = withMedia();

    const report = ctrl.removeMediaAssets(['unused']);

    expect(report).toEqual({ removedAssetIds: ['unused'], removedClipIds: [] });
    expect(ctrl.getClips().map((clip) => clip.id)).toEqual([clip1, clip2]);
  });

  it('takes linked audio with the video it was placed from', () => {
    const ctrl = new EditorController();
    // audioCodec marks embedded audio, so placement creates a linked A/V pair.
    ctrl.addMedia({ ...asset('av'), audioCodec: 'aac' });
    ctrl.addClip({ assetId: 'av', trackId: 'v1', startFrame: 0, durationFrames: 60 });
    expect(ctrl.getClips()).toHaveLength(2);

    const report = ctrl.removeMediaAssets(['av']);

    expect(report!.removedClipIds).toHaveLength(2);
    expect(ctrl.getClips()).toEqual([]);

    ctrl.undo();
    expect(ctrl.getClips()).toHaveLength(2);
  });

  it('returns null when nothing matches', () => {
    const { ctrl } = withMedia();
    const before = ctrl.getProject();

    expect(ctrl.removeMediaAssets([])).toBeNull();
    expect(ctrl.removeMediaAssets(['nope'])).toBeNull();
    expect(ctrl.getProject()).toBe(before);
    expect(ctrl.canUndo()).toBe(true); // only the setup edits remain
  });

  it('refuses to delete media whose clips sit on a locked track', () => {
    const { ctrl } = withMedia();
    ctrl.setTrackLocked('v1', true);
    const before = ctrl.getProject();

    expect(ctrl.removeMediaAssets(['a1'])).toBeNull();
    expect(ctrl.getProject()).toBe(before);

    // An asset with no clips is still deletable while the track is locked.
    expect(ctrl.removeMediaAssets(['unused'])).not.toBeNull();
  });
});
