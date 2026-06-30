import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { blendModeToIndex, isBlendMode, BLEND_MODES } from '../types/blend-mode';

function withClip(): { ctrl: EditorController; clipId: string } {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'a1', path: '/v.mp4', filename: 'v.mp4', type: 'video',
    duration: 300, fileSize: 1, addedAt: new Date().toISOString(),
  });
  const clipId = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 100 });
  return { ctrl, clipId };
}

describe('blend modes', () => {
  it('maps modes to stable indices (must match shader)', () => {
    expect(blendModeToIndex('normal')).toBe(0);
    expect(blendModeToIndex('multiply')).toBe(1);
    expect(blendModeToIndex('screen')).toBe(2);
    expect(blendModeToIndex('exclusion')).toBe(11);
    expect(blendModeToIndex(undefined)).toBe(0);
  });

  it('validates untrusted blend mode strings', () => {
    expect(isBlendMode('multiply')).toBe(true);
    expect(isBlendMode('normal')).toBe(true);
    expect(isBlendMode('plaid')).toBe(false);
    expect(isBlendMode(42)).toBe(false);
    expect(isBlendMode(null)).toBe(false);
  });

  it('sets a blend mode on a visual clip and undoes it', () => {
    const { ctrl, clipId } = withClip();
    expect(ctrl.setClipBlendMode(clipId, 'multiply')).toBe(true);
    expect(ctrl.getClips()[0].blendMode).toBe('multiply');

    ctrl.undo();
    expect(ctrl.getClips()[0].blendMode).toBeUndefined();
  });

  it('clears the property when set to normal (keeps saved projects clean)', () => {
    const { ctrl, clipId } = withClip();
    ctrl.setClipBlendMode(clipId, 'screen');
    expect(ctrl.getClips()[0].blendMode).toBe('screen');

    ctrl.setClipBlendMode(clipId, 'normal');
    expect(ctrl.getClips()[0].blendMode).toBeUndefined();
  });

  it('rejects blend modes on audio clips', () => {
    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'au', path: '/a.mp3', filename: 'a.mp3', type: 'audio',
      duration: 300, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const clipId = ctrl.addClip({ assetId: 'au', trackId: 'a1', startFrame: 0, durationFrames: 100, type: 'audio' });
    expect(ctrl.setClipBlendMode(clipId, 'multiply')).toBe(false);
    expect(ctrl.getClips()[0].blendMode).toBeUndefined();
  });

  it('survives serialization round-trip', () => {
    const { ctrl, clipId } = withClip();
    ctrl.setClipBlendMode(clipId, 'overlay');
    const json = ctrl.serialize();
    const restored = EditorController.deserialize(json);
    expect(restored.getClips()[0].blendMode).toBe('overlay');
  });

  it('clamps opacity to [0,1] and is undoable', () => {
    const { ctrl, clipId } = withClip();
    ctrl.setClipOpacity(clipId, 0.5);
    expect(ctrl.getClips()[0].opacity).toBe(0.5);
    ctrl.setClipOpacity(clipId, 5);
    expect(ctrl.getClips()[0].opacity).toBe(1);
    ctrl.undo();
    expect(ctrl.getClips()[0].opacity).toBe(0.5);
  });

  it('every blend mode has a stable unique index', () => {
    const indices = BLEND_MODES.map(blendModeToIndex);
    expect(new Set(indices).size).toBe(BLEND_MODES.length);
  });
});
