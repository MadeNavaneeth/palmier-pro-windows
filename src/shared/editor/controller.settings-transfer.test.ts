/**
 * Regression coverage for clip settings transfer / paste attributes (R1;
 * upstream #515): per-kind field lists, timing isolation, same-kind
 * refusals with upstream's message shape, unchanged-target reporting, and
 * the no-history no-op.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function controllerWithClips() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'asset-v',
    path: '/test/v.mp4',
    filename: 'v.mp4',
    type: 'video',
    duration: 5000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  ctrl.addMedia({
    id: 'asset-a',
    path: '/test/a.mp3',
    filename: 'a.mp3',
    type: 'audio',
    duration: 5000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  return ctrl;
}

describe('transferClipSettings (R1, #515)', () => {
  it('copies visual presentation fields and leaves timing/trims alone', () => {
    const ctrl = controllerWithClips();
    const source = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 0 });
    ctrl.applyClipProperties([source], 'Set', (draft) => {
      draft.opacity = 0.4;
      draft.x = 120;
      draft.y = 60;
      draft.rotation = 15;
      draft.scaleX = 1.5;
      draft.scaleY = 0.75;
      return true;
    });
    const targetId = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 500 });
    const targetBefore = ctrl.getClips().find((c) => c.id === targetId)!;

    const receipt = ctrl.transferClipSettings(source, [targetId]);
    expect(receipt.changedClipIds).toEqual([targetId]);

    const after = ctrl.getClips().find((c) => c.id === targetId)!;
    expect(after.opacity).toBe(0.4);
    expect(after.x).toBe(120);
    expect(after.rotation).toBe(15);
    expect(after.scaleY).toBe(0.75);
    expect(after.blendMode).toBeUndefined();
    // Timing and trims are the target's own.
    expect(after.startFrame).toBe(targetBefore.startFrame);
    expect(after.inPoint).toBe(targetBefore.inPoint);
    expect(after.outPoint).toBe(targetBefore.outPoint);
  });

  it('transfers volume for audio and refuses cross-kind targets', () => {
    const ctrl = controllerWithClips();
    const audioSource = ctrl.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 0 });
    ctrl.applyClipProperties([audioSource], 'Set', (draft) => {
      draft.volume = 0.25;
      return true;
    });

    const targetId = ctrl.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 100 });
    expect(ctrl.transferClipSettings(audioSource, [targetId]).changedClipIds).toEqual([targetId]);
    expect(ctrl.getClips().find((c) => c.id === targetId)?.volume).toBe(0.25);

    const videoId = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 200 });
    expect(() => ctrl.transferClipSettings(audioSource, [videoId])).toThrow(
      /copied settings require audio clips/i,
    );
  });

  it('reports unchanged targets and skips history when everything matched', () => {
    const ctrl = controllerWithClips();
    const source = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 0 });
    const twin = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 300 });
    ctrl.transferClipSettings(source, [twin]); // make the twin identical
    const canUndoBefore = ctrl.canUndo();

    const receipt = ctrl.transferClipSettings(source, [twin]);
    expect(receipt).toEqual({ changedClipIds: [], unchangedClipIds: [twin] });
    expect(ctrl.canUndo()).toBe(canUndoBefore);
  });

  it('refuses unknown ids by name', () => {
    const ctrl = controllerWithClips();
    const source = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 0 });
    expect(() => ctrl.transferClipSettings(source, ['ghost'])).toThrow(/ghost/);
    expect(() => ctrl.transferClipSettings('missing', ['x'])).toThrow(/not found/i);
    expect(() => ctrl.transferClipSettings('missing', [])).toThrow(/at least one target/i);
  });

  it('is one undoable step across multiple targets', () => {
    const ctrl = controllerWithClips();
    const source = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 0 });
    ctrl.applyClipProperties([source], 'Set', (d) => {
      d.opacity = 0.2;
      return true;
    });
    const t1 = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 300 });
    const t2 = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 600 });

    ctrl.transferClipSettings(source, [t1, t2]);
    ctrl.undo();
    expect(ctrl.getClips().find((c) => c.id === t1)?.opacity).not.toBe(0.2);
    expect(ctrl.getClips().find((c) => c.id === t2)?.opacity).not.toBe(0.2);
  });
});
