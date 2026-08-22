/**
 * Regression coverage for clip settings transfer / paste attributes (R1;
 * upstream #515): per-kind field lists, timing isolation, same-kind
 * refusals with upstream's message shape, unchanged-target reporting, and
 * the no-history no-op.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { createEmptyProject } from '../types/project';

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
      d.x = 90;
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

describe('paste-attributes snapshot (R1 checklist)', () => {
  it('copies once, pastes onto many, and clears on project load', () => {
    const ctrl = controllerWithClips();
    const source = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 0 });
    ctrl.applyClipProperties([source], 'Set', (d) => {
      d.opacity = 0.3;
      d.x = 77;
      return true;
    });
    expect(ctrl.copySettingsSnapshot(source)).toBe(true);

    const t = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 400 });
    const receipt = ctrl.pasteSettingsFromSnapshot([t]);
    expect(receipt.changedClipIds).toEqual([t]);
    const after = ctrl.getClips().find((c) => c.id === t)!;
    expect(after.opacity).toBe(0.3);
    expect(after.x).toBe(77);

    // A fresh project clears the snapshot.
    ctrl.loadProject(createEmptyProject());
    expect(() =>
      ctrl.pasteSettingsFromSnapshot([ctrl.addClip({
        assetId: 'asset-v', trackId: 'v1', startFrame: 0,
      })]),
    ).toThrow(/copy a clip's settings first/i);
  });

  it('applies only the requested field groups (the checklist)', () => {
    const ctrl = controllerWithClips();
    const source = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 0 });
    ctrl.applyClipProperties([source], 'Set', (d) => {
      d.opacity = 0.15;
      d.x = 55;
      d.blendMode = 'screen';
      return true;
    });
    ctrl.copySettingsSnapshot(source);

    const t = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 200 });
    const before = ctrl.getClips().find((c) => c.id === t)!;

    // Transform-only paste must not drag opacity or blend mode along.
    ctrl.pasteSettingsFromSnapshot([t], ['transform']);
    const afterTransform = ctrl.getClips().find((c) => c.id === t)!;
    expect(afterTransform.x).toBe(55);
    expect(afterTransform.opacity).toBe(before.opacity);
    expect(afterTransform.blendMode).toBe(before.blendMode);

    ctrl.pasteSettingsFromSnapshot([t], ['blendMode']);
    expect(ctrl.getClips().find((c) => c.id === t)?.blendMode).toBe('screen');
  });

  it('refuses without a snapshot and across kinds with upstream messages', () => {
    const ctrl = controllerWithClips();
    const audioId = ctrl.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 0 });

    expect(() => ctrl.pasteSettingsFromSnapshot([audioId]))
      .toThrow(/copy a clip's settings first/i);

    const videoSource = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 10 });
    ctrl.copySettingsSnapshot(videoSource);
    expect(() => ctrl.pasteSettingsFromSnapshot([audioId])).toThrow(
      /is audio; copied settings require video clips/i,
    );
  });

  it('pastes volume for audio snapshots', () => {
    const ctrl = controllerWithClips();
    const src = ctrl.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 0 });
    ctrl.applyClipProperties([src], 'Set', (d) => {
      d.volume = 0.4;
      return true;
    });
    ctrl.copySettingsSnapshot(src);
    const t = ctrl.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 100 });

    ctrl.pasteSettingsFromSnapshot([t], ['volume']);
    expect(ctrl.getClips().find((c) => c.id === t)?.volume).toBe(0.4);
  });

  it('never counts the snapshot source as changed', () => {
    const ctrl = controllerWithClips();
    const src = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 5 });
    ctrl.copySettingsSnapshot(src);
    const receipt = ctrl.pasteSettingsFromSnapshot([src]);
    expect(receipt).toEqual({ changedClipIds: [], unchangedClipIds: [src] });
  });
});
