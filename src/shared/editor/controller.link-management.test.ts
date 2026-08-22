/**
 * Regression coverage for manual clip link management (upstream PR #462).
 *
 * The gating contract is upstream's: linking needs at least two clips, at
 * least two distinct media types, and must not be a no-op on a set that is
 * already one group; unlinking refuses when nothing resolved is linked. Both
 * operations expand requests to whole existing groups first, so linking two
 * half-groups merges them and unlinking one partner frees both.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function controllerWithMaterial() {
  const ctrl = new EditorController();
  // No audioCodec: placement must not auto-create a linked audio partner, so
  // these clips start unlinked and manual linking is exercised cleanly.
  ctrl.addMedia({
    id: 'asset-video',
    path: '/test/video.mp4',
    filename: 'video.mp4',
    type: 'video',
    duration: 10_000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  ctrl.addMedia({
    id: 'asset-music',
    path: '/test/music.mp3',
    filename: 'music.mp3',
    type: 'audio',
    duration: 10_000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  return ctrl;
}

describe('EditorController.linkClips (#462)', () => {
  it('links a video clip and an audio clip under one new group', () => {
    const ctrl = controllerWithMaterial();
    const videoId = ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 0 });
    const audioId = ctrl.addClip({ assetId: 'asset-music', trackId: 'a1', startFrame: 0 });

    const { linkedClipIds } = ctrl.linkClips([videoId, audioId]);
    expect(linkedClipIds.sort()).toEqual([audioId, videoId].sort());

    const groupId = ctrl.getClips().find((c) => c.id === videoId)?.linkGroupId;
    expect(groupId).toBeDefined();
    expect(ctrl.getClips().find((c) => c.id === audioId)?.linkGroupId).toBe(groupId);
  });

  it('merges two existing groups into one', () => {
    const ctrl = controllerWithMaterial();
    const v1 = ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 0 });
    const a1 = ctrl.addClip({ assetId: 'asset-music', trackId: 'a1', startFrame: 0 });
    const v2 = ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 500 });
    const a2 = ctrl.addClip({ assetId: 'asset-music', trackId: 'a1', startFrame: 500 });
    ctrl.linkClips([v1, a1]);
    ctrl.linkClips([v2, a2]);

    ctrl.linkClips([a1, v2]);
    const groupId = ctrl.getClips().find((c) => c.id === a1)?.linkGroupId;
    for (const id of [v1, a1, v2, a2]) {
      expect(ctrl.getClips().find((c) => c.id === id)?.linkGroupId).toBe(groupId);
    }
  });

  it('refuses the exact upstream refusal cases', () => {
    const ctrl = controllerWithMaterial();
    const videoId = ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 0 });
    const audioId = ctrl.addClip({ assetId: 'asset-music', trackId: 'a1', startFrame: 0 });

    // Same media type only.
    const v2 = ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 500 });
    expect(() => ctrl.linkClips([videoId, v2])).toThrow(
      /at least two clips of different media types/i,
    );

    // Already one group.
    ctrl.linkClips([videoId, audioId]);
    expect(() => ctrl.linkClips([videoId, audioId])).toThrow(/already one link group/i);

    // Unknown id.
    expect(() => ctrl.linkClips(['ghost'])).toThrow(/clip not found/i);
  });

  it('is one undoable step that restores prior groups exactly', () => {
    const ctrl = controllerWithMaterial();
    const videoId = ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 0 });
    const audioId = ctrl.addClip({ assetId: 'asset-music', trackId: 'a1', startFrame: 0 });

    ctrl.linkClips([videoId, audioId]);
    ctrl.undo();
    expect(ctrl.getClips().find((c) => c.id === videoId)?.linkGroupId).toBeUndefined();
    expect(ctrl.getClips().find((c) => c.id === audioId)?.linkGroupId).toBeUndefined();
    ctrl.redo();
    const groupId = ctrl.getClips().find((c) => c.id === videoId)?.linkGroupId;
    expect(ctrl.getClips().find((c) => c.id === audioId)?.linkGroupId).toBe(groupId);
  });

  it('keeps linked selection semantics working after a manual link', () => {
    const ctrl = controllerWithMaterial();
    const videoId = ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 0 });
    const audioId = ctrl.addClip({ assetId: 'asset-music', trackId: 'a1', startFrame: 0 });
    ctrl.linkClips([videoId, audioId]);

    // The expansion helper drives every mutating op; it must see the group.
    expect(new Set(ctrl.expandLinkedClipIds([videoId]))).toEqual(
      new Set([videoId, audioId]),
    );
  });

  it('merges an auto-created placement group with a manual link', () => {
    // A video asset WITH embedded audio auto-links its picture to a new audio
    // clip on placement. Manually linking that group to another clip must
    // absorb the whole existing group, not just the requested clip.
    const ctrl = controllerWithMaterial();
    ctrl.addMedia({
      id: 'asset-av',
      path: '/test/av.mp4',
      filename: 'av.mp4',
      type: 'video',
      duration: 10_000,
      fileSize: 1,
      audioCodec: 'aac',
      addedAt: new Date().toISOString(),
    });
    ctrl.placeMediaAssets(['asset-av'], 'v1', 0);
    const avVideoId = ctrl.getClips().find((c) => c.type === 'video')!.id;
    expect(ctrl.expandLinkedClipIds([avVideoId])).toHaveLength(2); // auto pair

    const musicId = ctrl.addClip({ assetId: 'asset-music', trackId: 'a1', startFrame: 500 });
    ctrl.linkClips([avVideoId, musicId]);

    const groupId = ctrl.getClips().find((c) => c.id === avVideoId)?.linkGroupId;
    for (const clip of ctrl.getClips()) {
      expect(clip.linkGroupId).toBe(groupId);
    }
  });
});

describe('EditorController.unlinkClips (#462)', () => {
  it('clears the group from the whole expanded set', () => {
    const ctrl = controllerWithMaterial();
    const videoId = ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 0 });
    const audioId = ctrl.addClip({ assetId: 'asset-music', trackId: 'a1', startFrame: 0 });
    ctrl.linkClips([videoId, audioId]);

    // Requesting one partner frees both.
    const { unlinkedClipIds } = ctrl.unlinkClips([videoId]);
    expect(unlinkedClipIds.sort()).toEqual([audioId, videoId].sort());
    for (const id of [videoId, audioId]) {
      expect(ctrl.getClips().find((c) => c.id === id)?.linkGroupId).toBeUndefined();
    }
  });

  it('refuses when none of the provided clips is linked', () => {
    const ctrl = controllerWithMaterial();
    const videoId = ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 0 });
    expect(() => ctrl.unlinkClips([videoId])).toThrow(/none of the provided clips is linked/i);
  });

  it('is one undoable step', () => {
    const ctrl = controllerWithMaterial();
    const videoId = ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 0 });
    const audioId = ctrl.addClip({ assetId: 'asset-music', trackId: 'a1', startFrame: 0 });
    ctrl.linkClips([videoId, audioId]);
    const groupId = ctrl.getClips().find((c) => c.id === videoId)?.linkGroupId;

    ctrl.unlinkClips([videoId]);
    ctrl.undo();
    expect(ctrl.getClips().find((c) => c.id === videoId)?.linkGroupId).toBe(groupId);
    expect(ctrl.getClips().find((c) => c.id === audioId)?.linkGroupId).toBe(groupId);
  });
});
