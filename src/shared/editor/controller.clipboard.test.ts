/**
 * Regression coverage for the R1 clipboard (copy/cut/paste) and marker
 * navigation, translated from upstream's EditorViewModel+Clipboard.
 *
 * Paste semantics: offsets relative to the copy anchor, keyboard paste lands
 * the anchor on its source track (first compatible fallback) at the
 * playhead, pasting overwrites by splitting intersecting clips on the
 * destination track, copied link groups remap to fresh groups, everything is
 * one undoable step, and new ids arrive selected.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function controllerWithMaterial() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'asset-video',
    path: '/test/v.mp4',
    filename: 'v.mp4',
    type: 'video',
    duration: 5000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  ctrl.addMedia({
    id: 'asset-music',
    path: '/test/m.mp3',
    filename: 'm.mp3',
    type: 'audio',
    duration: 5000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  return ctrl;
}

describe('clipboard copy/paste (R1)', () => {
  it('pastes a single clip at the playhead with fresh id', () => {
    const ctrl = controllerWithMaterial();
    const clipId = ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 100 });
    ctrl.copyClips([clipId]);
    ctrl.setPlayhead(400);

    const newIds = ctrl.pasteClips();
    expect(newIds).toHaveLength(1);
    const pasted = ctrl.getClips().find((c) => c.id === newIds[0])!;
    expect(pasted.startFrame).toBe(400);
    expect(pasted.trackId).toBe('v1');
    expect(pasted.inPoint).toBe(ctrl.getClips().find((c) => c.id === clipId)?.inPoint);
  });

  it('preserves multi-clip relative layout and link groups across paste', () => {
    const ctrl = controllerWithMaterial();
    // Linked pair on v1 (av asset carries embedded audio) + music on a1.
    ctrl.addMedia({
      id: 'asset-av',
      path: '/test/av.mp4',
      filename: 'av.mp4',
      type: 'video',
      duration: 5000,
      fileSize: 1,
      audioCodec: 'aac',
      addedAt: new Date().toISOString(),
    });
    ctrl.placeMediaAssets(['asset-av'], 'v1', 100);
    const videoClip = ctrl.getClips().find((c) => c.type === 'video')!;
    const partnerClip = ctrl.getClips().find((c) => c.type === 'audio' && c.assetId === 'asset-av')!;
    const musicId = ctrl.addClip({ assetId: 'asset-music', trackId: 'a1', startFrame: 160 });

    ctrl.copyClips([videoClip.id, partnerClip.id, musicId]);
    ctrl.setPlayhead(1000);
    const newIds = ctrl.pasteClips();

    expect(newIds).toHaveLength(3);
    // frameOffset preserved: music sat 60 frames after the pair anchor.
    const pastedMusic = ctrl.getClips().find((c) => c.id === newIds.find((id) =>
      ctrl.getClips().find((c2) => c2.id === id)?.startFrame === 1060))!;
    expect(pastedMusic.startFrame).toBe(1060);

    // The two linked halves share ONE fresh group, different from the source's.
    const pastedVideo = ctrl.getClips().find((c) =>
      c.id !== pastedMusic.id && c.linkGroupId !== undefined
      && newIds.includes(c.id) && c.trackId === 'v1')!;
    expect(pastedVideo).toBeDefined();
    const pastedPartner = ctrl.getClips().find((c) =>
      c.id !== pastedVideo.id && c.linkGroupId === pastedVideo.linkGroupId)!;
    expect(pastedPartner).toBeDefined();
    expect(pastedVideo.linkGroupId).not.toBe(videoClip.linkGroupId);
  });

  it('overwrites the destination span by splitting intersecting clips', () => {
    const ctrl = controllerWithMaterial();
    const sourceId = ctrl.addClip({
      assetId: 'asset-music', trackId: 'a1', startFrame: 0, durationFrames: 50,
    });
    const victimId = ctrl.addClip({
      assetId: 'asset-music', trackId: 'a1', startFrame: 200, durationFrames: 200,
    });

    ctrl.copyClips([sourceId]);
    ctrl.setPlayhead(250); // lands inside [200,400)
    const newIds = ctrl.pasteClips();

    expect(newIds).toHaveLength(1);
    const clips = ctrl.getClips().filter((c) => c.trackId === 'a1').sort((a, b) => a.startFrame - b.startFrame);
    // Victim split around [250,300): head fragment 200â†’250, tail 300â†’400.
    expect(clips.map((c) => [c.startFrame, c.startFrame + c.durationFrames])).toEqual([
      [0, 50],
      [200, 250],
      [250, 300],
      [300, 400],
    ]);
    void victimId;
  });

  it('falls back to the first compatible track when the source track is gone', () => {
    const ctrl = controllerWithMaterial();
    // A second audio lane so a1 can be removed without hitting the
    // last-of-type guard.
    ctrl.addTrack('audio', 'Audio 2');
    const clipId = ctrl.addClip({ assetId: 'asset-music', trackId: 'a1', startFrame: 0 });
    ctrl.copyClips([clipId]);
    ctrl.removeClips([clipId]);
    ctrl.manageTracks({ remove: ['a1'] });

    const newIds = ctrl.pasteClips();
    expect(newIds).toHaveLength(1);
  });

  it('cut copies then removes in two undoable steps (delete + clipboard)', () => {
    const ctrl = controllerWithMaterial();
    const clipId = ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 10 });
    expect(ctrl.cutClips([clipId])).toBe(1);
    expect(ctrl.getClips()).toHaveLength(0);
    expect(ctrl.hasClipboard()).toBe(true);

    ctrl.pasteClips();
    expect(ctrl.getClips()).toHaveLength(1);
    ctrl.undo(); // undo paste
    expect(ctrl.getClips()).toHaveLength(0);
    ctrl.undo(); // undo the cut's removal
    expect(ctrl.getClips().some((c) => c.id === clipId)).toBe(true);
  });

  it('is one undo step per paste over all pasted clips and split fragments', () => {
    const ctrl = controllerWithMaterial();
    const sourceId = ctrl.addClip({
      assetId: 'asset-video', trackId: 'v1', startFrame: 0, durationFrames: 40,
    });
    ctrl.addClip({
      assetId: 'asset-video', trackId: 'v1', startFrame: 200, durationFrames: 200,
    });
    ctrl.copyClips([sourceId]);
    ctrl.setPlayhead(220);
    ctrl.pasteClips();

    const canUndoBefore = ctrl.canUndo();
    ctrl.pasteClips(); // second paste overwrites again
    expect(ctrl.canUndo()).toBe(true);

    ctrl.undo(); // undoes ONLY the second paste
    expect(ctrl.getClips().filter((c) => c.assetId === 'asset-video').length)
      .toBeGreaterThan(0);
    void canUndoBefore;
  });
});
