import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { MAX_FRAME } from '../utils/safe-number';

/**
 * Regression tests for the overflow crash class reported upstream
 * (Palmier Pro #200). Untrusted numeric arguments from the agent / MCP socket
 * must never crash, hang, or corrupt the timeline.
 */
describe('EditorController overflow hardening', () => {
  function withAsset(): EditorController {
    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'asset-1',
      path: '/test/video.mp4',
      filename: 'video.mp4',
      type: 'video',
      duration: 300,
      fileSize: 1000,
      addedAt: new Date().toISOString(),
    });
    return ctrl;
  }

  it('addClip clamps an absurd startFrame instead of corrupting state', () => {
    const ctrl = withAsset();
    const id = ctrl.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 1e19 });
    const clip = ctrl.getClips().find((c) => c.id === id)!;
    expect(clip.startFrame).toBeLessThanOrEqual(MAX_FRAME);
    expect(Number.isFinite(clip.startFrame)).toBe(true);
  });

  it('addClip clamps a non-finite duration', () => {
    const ctrl = withAsset();
    const id = ctrl.addClip({
      assetId: 'asset-1',
      trackId: 'v1',
      startFrame: 0,
      durationFrames: Infinity,
    });
    const clip = ctrl.getClips().find((c) => c.id === id)!;
    expect(clip.durationFrames).toBeLessThanOrEqual(MAX_FRAME);
    expect(Number.isFinite(clip.durationFrames)).toBe(true);
  });

  it('splitClip rejects a non-finite frame without throwing', () => {
    const ctrl = withAsset();
    const id = ctrl.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 0, durationFrames: 100 });
    expect(ctrl.splitClip(id, Infinity)).toBeNull();
    expect(ctrl.splitClip(id, NaN)).toBeNull();
    expect(ctrl.splitClip(id, 1e19)).toBeNull();
    // Clip count unchanged — no partial split occurred.
    expect(ctrl.getClips()).toHaveLength(1);
  });

  it('splitClip still works for a valid in-range frame', () => {
    const ctrl = withAsset();
    const id = ctrl.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 0, durationFrames: 100 });
    const newId = ctrl.splitClip(id, 50);
    expect(newId).not.toBeNull();
    expect(ctrl.getClips()).toHaveLength(2);
  });

  it('setPlayhead clamps out-of-range frames', () => {
    const ctrl = new EditorController();
    ctrl.setPlayhead(1e19);
    expect(ctrl.getPlayhead()).toBeLessThanOrEqual(MAX_FRAME);
    ctrl.setPlayhead(-500);
    expect(ctrl.getPlayhead()).toBe(0);
  });

  it('trimClip keeps outPoint strictly after inPoint under bad input', () => {
    const ctrl = withAsset();
    const id = ctrl.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 0, durationFrames: 100 });
    ctrl.trimClip(id, 10, Infinity);
    const clip = ctrl.getClips().find((c) => c.id === id)!;
    expect(Number.isFinite(clip.inPoint)).toBe(true);
    expect(Number.isFinite(clip.outPoint)).toBe(true);
    expect(clip.outPoint).toBeGreaterThan(clip.inPoint);
  });
});
