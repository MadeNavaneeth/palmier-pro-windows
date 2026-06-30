import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function setup() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'a1', path: '/v.mp4', filename: 'v.mp4', type: 'video',
    duration: 600, fileSize: 1, addedAt: new Date().toISOString(),
  });
  return ctrl;
}

describe('fades and cross-dissolve', () => {
  it('sets and clamps clip fades, undoable', () => {
    const ctrl = setup();
    const id = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 100 });

    ctrl.setClipFade(id, 15, 20);
    let c = ctrl.getClips()[0];
    expect(c.fadeInFrames).toBe(15);
    expect(c.fadeOutFrames).toBe(20);

    // Clamp to clip duration.
    ctrl.setClipFade(id, 999, undefined);
    expect(ctrl.getClips()[0].fadeInFrames).toBe(100);

    ctrl.undo();
    expect(ctrl.getClips()[0].fadeInFrames).toBe(15);
  });

  it('clears a fade when set to 0', () => {
    const ctrl = setup();
    const id = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 100 });
    ctrl.setClipFade(id, 10, 10);
    ctrl.setClipFade(id, 0, undefined);
    expect(ctrl.getClips()[0].fadeInFrames).toBeUndefined();
    expect(ctrl.getClips()[0].fadeOutFrames).toBe(10);
  });

  it('creates a cross-dissolve between two adjacent clips', () => {
    const ctrl = setup();
    const a = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 100 });
    const b = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 100, durationFrames: 100 });

    expect(ctrl.createCrossDissolve(a, b, 30)).toBe(true);

    const clipA = ctrl.getClips().find((c) => c.id === a)!;
    const clipB = ctrl.getClips().find((c) => c.id === b)!;
    expect(clipA.fadeOutFrames).toBe(30);
    expect(clipB.fadeInFrames).toBe(30);
    // B shifted left by 30 to overlap A's tail.
    expect(clipB.startFrame).toBe(70);
  });

  it('rejects a cross-dissolve when clips are not adjacent', () => {
    const ctrl = setup();
    const a = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 100 });
    const b = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 150, durationFrames: 100 });
    expect(ctrl.createCrossDissolve(a, b, 30)).toBe(false);
  });

  it('rejects a cross-dissolve longer than a clip', () => {
    const ctrl = setup();
    const a = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 20 });
    const b = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 20, durationFrames: 100 });
    expect(ctrl.createCrossDissolve(a, b, 30)).toBe(false);
  });
});
