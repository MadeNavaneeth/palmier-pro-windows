import { describe, it, expect } from 'vitest';
import {
  transitionInProgress,
  wipeParamsFor,
  slideOffsetFor,
  WIPE_MODE,
} from './transition';
import { EditorController } from './controller';
import type { Clip } from '../types/project';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', type: 'video', trackId: 'v1',
    startFrame: 0, durationFrames: 100, inPoint: 0, outPoint: 100,
    x: 100, y: 50, width: 200, height: 100, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...overrides,
  };
}

describe('transition progress', () => {
  it('returns null with no transition', () => {
    expect(transitionInProgress(clip(), 10)).toBeNull();
  });

  it('ramps 0→1 across the window then null after', () => {
    const c = clip({ transitionIn: { type: 'wipe', direction: 'left', frames: 20 } });
    expect(transitionInProgress(c, 0)).toBe(0);
    expect(transitionInProgress(c, 10)).toBeCloseTo(0.5, 5);
    expect(transitionInProgress(c, 20)).toBeNull(); // completed → no effect
    expect(transitionInProgress(c, 50)).toBeNull();
  });
});

describe('wipeParamsFor', () => {
  it('reports mode/progress while wiping', () => {
    const c = clip({ transitionIn: { type: 'wipe', direction: 'right', frames: 10, softness: 0.1 } });
    const p = wipeParamsFor(c, 5);
    expect(p.mode).toBe(WIPE_MODE.right);
    expect(p.progress).toBeCloseTo(0.5, 5);
    expect(p.softness).toBe(0.1);
  });

  it('returns mode 0 (no mask) for slide or when complete', () => {
    expect(wipeParamsFor(clip({ transitionIn: { type: 'slide', direction: 'left', frames: 10 } }), 5).mode).toBe(0);
    expect(wipeParamsFor(clip({ transitionIn: { type: 'wipe', direction: 'left', frames: 10 } }), 99).mode).toBe(0);
  });
});

describe('slideOffsetFor', () => {
  it('offsets from the entry edge, easing to zero', () => {
    const c = clip({ width: 200, height: 100, transitionIn: { type: 'slide', direction: 'left', frames: 10 } });
    // At progress 0 the clip is fully offscreen by its width.
    expect(slideOffsetFor(c, 0)).toEqual({ dx: -200, dy: 0 });
    // Halfway.
    expect(slideOffsetFor(c, 5).dx).toBeCloseTo(-100, 5);
    // Completed → no offset.
    expect(slideOffsetFor(c, 10)).toEqual({ dx: 0, dy: 0 });
  });

  it('handles each direction', () => {
    const mk = (direction: any) => clip({ width: 200, height: 100, transitionIn: { type: 'slide', direction, frames: 10 } });
    expect(slideOffsetFor(mk('right'), 0)).toEqual({ dx: 200, dy: 0 });
    expect(slideOffsetFor(mk('up'), 0)).toEqual({ dx: 0, dy: -100 });
    expect(slideOffsetFor(mk('down'), 0)).toEqual({ dx: 0, dy: 100 });
  });

  it('returns zero for wipe (handled by the mask, not offset)', () => {
    expect(slideOffsetFor(clip({ transitionIn: { type: 'wipe', direction: 'left', frames: 10 } }), 5)).toEqual({ dx: 0, dy: 0 });
  });
});

describe('controller.setClipTransition', () => {
  it('sets and clears a transition, undoable', () => {
    const ctrl = new EditorController();
    ctrl.addMedia({ id: 'a1', path: '/v.mp4', filename: 'v.mp4', type: 'video', duration: 300, fileSize: 1, addedAt: new Date().toISOString() });
    const id = ctrl.addClip({ assetId: 'a1', trackId: 'v1', startFrame: 0, durationFrames: 100 });

    ctrl.setClipTransition(id, { type: 'wipe', direction: 'left', frames: 15 });
    expect(ctrl.getClips()[0].transitionIn).toMatchObject({ type: 'wipe', direction: 'left', frames: 15 });

    ctrl.setClipTransition(id, null);
    expect(ctrl.getClips()[0].transitionIn).toBeUndefined();

    ctrl.undo();
    expect(ctrl.getClips()[0].transitionIn).toMatchObject({ type: 'wipe' });
  });
});
