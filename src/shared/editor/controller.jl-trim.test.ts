/**
 * Regression coverage for the J/L affordance (roadmap R1): Alt-trim scopes
 * to the grabbed half of a linked pair while the pair keeps its link group,
 * so audio can extend past picture and both still move together afterwards.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function controllerWithLinkedPair() {
  const ctrl = new EditorController();
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
  return ctrl;
}

describe('Alt-trim single half (J/L, R1)', () => {
  it("extends only the audio half's out edge while linked", () => {
    const ctrl = controllerWithLinkedPair();
    const video = ctrl.getClips().find((c) => c.type === 'video')!;
    const audio = ctrl.getClips().find((c) => c.type === 'audio')!;
    const pairDur = video.durationFrames;

    // Free 50 frames of shared source headroom by shortening the picture.
    ctrl.trimClipEdge(video.id, 'right', -50);
    const vShorter = ctrl.getClips().find((c) => c.id === video.id)!;
    expect(vShorter.durationFrames).toBe(pairDur - 50);

    // Now the audio tail extends those 50 frames back: the J shape.
    const report = ctrl.trimClipEdge(audio.id, 'right', 50, false, 'single');
    expect(report).not.toBeNull();

    const vAfter = ctrl.getClips().find((c) => c.id === video.id)!;
    const aAfter = ctrl.getClips().find((c) => c.id === audio.id)!;
    expect(aAfter.durationFrames).toBe(pairDur); // audio back to full span
    expect(vAfter.durationFrames).toBe(pairDur - 50); // picture stays short
    // The group survives so the pair still moves together.
    expect(aAfter.linkGroupId).toBe(vAfter.linkGroupId);
  });

  it('default scope still moves both halves together', () => {
    const ctrl = controllerWithLinkedPair();
    const video = ctrl.getClips().find((c) => c.type === 'video')!;

    ctrl.trimClipEdge(video.id, 'right', -20);
    const vAfter = ctrl.getClips().find((c) => c.id === video.id)!;
    const aAfter = ctrl.getClips().find((c) =>
      c.type === 'audio' && c.linkGroupId === vAfter.linkGroupId)!;
    expect(vAfter.durationFrames).toBe(video.durationFrames - 20);
    expect(aAfter.durationFrames).toBe(video.durationFrames - 20);
  });

  it('a J-cut pair keeps moving as one after the asymmetric trim', () => {
    const ctrl = controllerWithLinkedPair();
    const video = ctrl.getClips().find((c) => c.type === 'video')!;
    const audio = ctrl.getClips().find((c) => c.type === 'audio')!;
    ctrl.trimClipEdge(audio.id, 'right', 30, false, 'single');

    const beforeVideoStart = video.startFrame;
    ctrl.moveClip(video.id, beforeVideoStart + 200);
    const vMoved = ctrl.getClips().find((c) => c.id === video.id)!;
    const aMoved = ctrl.getClips().find((c) =>
      c.type === 'audio' && c.linkGroupId === vMoved.linkGroupId)!;
    expect(aMoved.startFrame).toBe(audio.startFrame + 200);
  });
});
