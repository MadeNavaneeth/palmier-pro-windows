import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

/** 30fps project: 1 second = 30 frames. */
function setup() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'a1', path: '/v.mp4', filename: 'v.mp4', type: 'video',
    duration: 300, fileSize: 1, addedAt: new Date().toISOString(),
  });
  return ctrl;
}

describe('EditorController.removeSilence', () => {
  it('splits a clip into kept segments and reports the count', () => {
    const ctrl = setup();
    // Clip on timeline [0,300), source [0,300).
    const clipId = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 300 });

    // Silence from 3s–4s (source seconds) => frames 90–120 at 30fps.
    const removed = ctrl.removeSilence(clipId, [{ startSec: 3, endSec: 4 }]);
    expect(removed).toBe(1);

    const clips = ctrl.getClips().sort((a, b) => a.startFrame - b.startFrame);
    expect(clips).toHaveLength(2);
    // First kept segment: source [0,90), timeline [0,90)
    expect(clips[0].inPoint).toBe(0);
    expect(clips[0].outPoint).toBe(90);
    expect(clips[0].startFrame).toBe(0);
    // Second kept segment placed contiguously after the first (gap closed).
    expect(clips[1].inPoint).toBe(120);
    expect(clips[1].outPoint).toBe(300);
    expect(clips[1].startFrame).toBe(90);
  });

  it('ripples later clips on the same track left by the removed amount', () => {
    const ctrl = setup();
    const clipId = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 300 });
    // A second clip after the first at frame 300.
    const laterId = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 300, durationFrames: 60 });

    ctrl.removeSilence(clipId, [{ startSec: 3, endSec: 4 }]); // removes 30 frames

    const later = ctrl.getClips().find((c) => c.id === laterId)!;
    expect(later.startFrame).toBe(270); // 300 - 30 removed
  });

  it('is a single undoable operation', () => {
    const ctrl = setup();
    const clipId = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 300 });
    expect(ctrl.getClips()).toHaveLength(1);

    ctrl.removeSilence(clipId, [{ startSec: 3, endSec: 4 }]);
    expect(ctrl.getClips()).toHaveLength(2);

    ctrl.undo();
    const clips = ctrl.getClips();
    expect(clips).toHaveLength(1);
    expect(clips[0].id).toBe(clipId);
    expect(clips[0].durationFrames).toBe(300);
  });

  it('does nothing when no silence is supplied', () => {
    const ctrl = setup();
    const clipId = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 300 });
    expect(ctrl.removeSilence(clipId, [])).toBe(0);
    expect(ctrl.getClips()).toHaveLength(1);
  });
});
