/**
 * Regression coverage for constant clip speed (R4 groundwork).
 *
 * Semantics: timeline duration is unchanged; the clip consumes speed× more
 * source, expressed by scaling outPoint from inPoint. The shared source-time
 * mapping multiplies per-frame source advance by speed so preview and export
 * agree; audio and title clips refuse.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import {
  effectiveSpeed,
  clipTrimSeconds,
  sourceSecondsForTimelineFrame,
} from '../media/source-time';

describe('effectiveSpeed', () => {
  it('defaults undefined/garbage to 1', () => {
    expect(effectiveSpeed(undefined)).toBe(1);
    expect(effectiveSpeed(Number.NaN)).toBe(1);
    expect(effectiveSpeed(-2)).toBe(1); // negatives are garbage, not reverse
    expect(effectiveSpeed(2)).toBe(2);
  });
});

describe('speed-aware source mapping', () => {
  const clip = {
    startFrame: 100,
    inPoint: 50,
    outPoint: 50 + 200, // inPoint + durationFrames(100) × speed(2)
    durationFrames: 100,
    speed: 2,
  };
  const fps = 30;

  it('advances source time speed× per timeline frame', () => {
    // 10 timeline frames into the clip at 2× = 20 source frames past inPoint.
    expect(sourceSecondsForTimelineFrame(clip, 110, fps)).toBeCloseTo(70 / fps);
  });

  it('trim window covers the full consumed span', () => {
    const { start, end } = clipTrimSeconds(clip, fps);
    expect(start).toBeCloseTo(50 / fps);
    expect(end).toBeCloseTo(250 / fps);
  });

  it('unspeeded clips map exactly as before', () => {
    const normal = { ...clip, speed: undefined, outPoint: 150 };
    expect(sourceSecondsForTimelineFrame(normal, 110, fps)).toBeCloseTo(60 / fps);
  });
});

describe('EditorController.setClipSpeed', () => {
  function controllerWithVideo() {
    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'asset-v', path: '/test/v.mp4', filename: 'v.mp4', type: 'video',
      duration: 5000, fileSize: 1, addedAt: new Date().toISOString(),
    });
    return ctrl;
  }

  it('scales outPoint while keeping timeline duration and position', () => {
    const ctrl = controllerWithVideo();
    const id = ctrl.addClip({
      assetId: 'asset-video', trackId: 'v1', startFrame: 100, durationFrames: 100,
    });

    expect(ctrl.setClipSpeed(id, 2)).toBe(true);
    const after = ctrl.getClips().find((c) => c.id === id)!;
    expect(after.speed).toBe(2);
    expect(after.startFrame).toBe(100); // position unchanged
    expect(after.durationFrames).toBe(100); // timeline duration unchanged
    expect(after.outPoint - after.inPoint).toBe(200); // consumed source doubled

    ctrl.undo();
    const restored = ctrl.getClips().find((c) => c.id === id)!;
    expect(restored.outPoint).toBe(after.inPoint + 100);
    expect(restored.speed ?? 1).toBe(1);
  });

  it('rejects audio clips and invalid speeds', () => {
    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'asset-a', path: '/test/a.mp3', filename: 'a.mp3', type: 'audio',
      duration: 5000, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const audioId = ctrl.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 0 });
    expect(ctrl.setClipSpeed(audioId, 2)).toBe(false);

    const videoCtrl = controllerWithVideo();
    videoCtrl.addClip({ assetId: 'asset-video' as unknown as string, trackId: 'v1', startFrame: 0 });
    expect(videoCtrl.setClipSpeed('ghost', 2)).toBe(false);
    expect(videoCtrl.setClipSpeed('v1' as string, 0.1)).toBe(false);
  });

  it('is one undoable step that restores the previous trim window', () => {
    const ctrl = controllerWithVideo();
    const id = ctrl.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 0 });
    const before = ctrl.getClips()[0];

    expect(ctrl.setClipSpeed(id, 2)).toBe(true);
    ctrl.undo();
    const restored = ctrl.getClips()[0];
    expect(restored.outPoint).toBe(before.outPoint);
    expect(restored.speed ?? 1).toBe(1);
  });
});
