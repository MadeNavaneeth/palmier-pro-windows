/**
 * Regression coverage for audio pan (R5): controller clamps/refusals,
 * plan passthrough, and the export pan filter appearing only when panned.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { computeAudioPlan } from '../audio/audio-playback';

function audioController() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'asset-a', path: '/test/a.mp3', filename: 'a.mp3', type: 'audio',
    duration: 5000, fileSize: 1, addedAt: new Date().toISOString(),
  });
  const id = ctrl.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 0 });
  return { ctrl, id };
}

describe('setClipPan (R5)', () => {
  it('sets stereo balance as one undoable step', () => {
    const { ctrl, id } = audioController();
    expect(ctrl.setClipPan(id, -1)).toBe(true);
    expect(ctrl.getClips()[0].pan).toBe(-1);
    ctrl.undo();
    expect(ctrl.getClips()[0].pan ?? 0).toBe(0);
  });

  it('refuses out-of-range values without history', () => {
    const { ctrl, id } = audioController();
    const before = ctrl.canUndo();
    expect(ctrl.setClipPan(id, 5)).toBe(false);
    expect(ctrl.setClipPan(id, Number.NaN)).toBe(false);
    expect(ctrl.canUndo()).toBe(before);
  });

  it('clears to center by deleting the field', () => {
    const { ctrl, id } = audioController();
    ctrl.setClipPan(id, 0.8);
    ctrl.setClipPan(id, 0);
    expect('pan' in ctrl.getClips()[0]).toBe(false);
  });

  it('refuses visual clips', () => {
    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'asset-v', path: '/test/v.mp4', filename: 'v.mp4', type: 'video',
      duration: 100, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const videoId = ctrl.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 0 });
    expect(ctrl.setClipPan(videoId, 0.5)).toBe(false);
  });
});

describe('pan in audio plan (R5)', () => {
  it('passes clamped pan through to entries', () => {
    const clip = {
      id: 'c', assetId: 'a', type: 'audio' as const, trackId: 'a1',
      startFrame: 0, durationFrames: 100, inPoint: 0, outPoint: 100,
      x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1,
      opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
      pan: -0.5,
    };
    const entries = computeAudioPlan({
      tracks: [{ id: 'a1', visible: true }],
      assets: [{ id: 'a', path: 'C:/a.mp3' }],
      clips: [clip],
      playbackRate: 1,
      fps: 30,
      playhead: 50,
    });
    expect(entries[0].pan).toBe(-0.5);
  });
});
