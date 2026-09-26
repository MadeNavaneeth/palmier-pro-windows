/**
 * Shape clip model coverage: sanitizers, narrow-on-read, content detection,
 * animation presets, controller creation/transfer, and persistence.
 */
import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { diagnoseTimeline } from './diagnostics';
import {
  SHAPE_ANIMATION_PRESETS,
  hasShapeContent,
  narrowShapeClip,
  sanitizeShapeFillColor,
  sanitizeShapeKind,
  sanitizeShapeStrokeColor,
  sanitizeShapeStrokeWidth,
  shapePresetMotion,
} from './shape';

describe('shape sanitizers', () => {
  it('accepts the four kinds and rejects the rest', () => {
    expect(sanitizeShapeKind('rect')).toBe('rect');
    expect(sanitizeShapeKind('arrow')).toBe('arrow');
    expect(sanitizeShapeKind('circle')).toBeUndefined();
    expect(sanitizeShapeKind(42)).toBeUndefined();
  });

  it('accepts #RRGGBB strokes and #RRGGBBAA fills only', () => {
    expect(sanitizeShapeStrokeColor('#ff0000')).toBe('#ff0000');
    expect(sanitizeShapeStrokeColor('#ff000080')).toBeUndefined();
    expect(sanitizeShapeStrokeColor('red')).toBeUndefined();
    expect(sanitizeShapeFillColor('#ff000080')).toBe('#ff000080');
    expect(sanitizeShapeFillColor('#ff0000')).toBeUndefined();
  });

  it('clamps stroke width to 0..64 and rejects non-numbers', () => {
    expect(sanitizeShapeStrokeWidth(4)).toBe(4);
    expect(sanitizeShapeStrokeWidth(0)).toBe(0);
    expect(sanitizeShapeStrokeWidth(500)).toBe(64);
    expect(sanitizeShapeStrokeWidth(-3)).toBe(0);
    expect(sanitizeShapeStrokeWidth(Number.NaN)).toBeUndefined();
    expect(sanitizeShapeStrokeWidth('4')).toBeUndefined();
  });
});

describe('narrowShapeClip', () => {
  it('passes non-shape clips through untouched', () => {
    const clip = { type: 'title', shapeKind: 'bogus' };
    expect(narrowShapeClip(clip)).toBe(clip);
  });

  it('returns the same reference when clean', () => {
    const clip = {
      type: 'shape', shapeKind: 'arrow', shapeStrokeColor: '#ff0000',
      shapeStrokeWidth: 4, shapeFillColor: '#00ff0080',
    };
    expect(narrowShapeClip(clip)).toBe(clip);
  });

  it('degrades hostile values to absent without throwing', () => {
    const clip = {
      type: 'shape', shapeKind: 'circle', shapeStrokeColor: 'red',
      shapeStrokeWidth: Number.NaN, shapeFillColor: '#fff',
    };
    const narrowed = narrowShapeClip(clip);
    expect(narrowed).toEqual({ type: 'shape' });
  });
});

describe('hasShapeContent', () => {
  it('needs a stroke (color plus width) or a fill', () => {
    expect(hasShapeContent({ type: 'shape' })).toBe(false);
    expect(hasShapeContent({ type: 'shape', shapeStrokeColor: '#ffffff' })).toBe(false);
    expect(hasShapeContent({ type: 'shape', shapeStrokeWidth: 4 })).toBe(false);
    expect(hasShapeContent({
      type: 'shape', shapeStrokeColor: '#ff0000', shapeStrokeWidth: 4,
    })).toBe(true);
    expect(hasShapeContent({ type: 'shape', shapeFillColor: '#fff8' })).toBe(false);
    expect(hasShapeContent({ type: 'shape', shapeFillColor: '#ffffff80' })).toBe(true);
    expect(hasShapeContent({ type: 'video' })).toBe(false);
  });
});

describe('shapePresetMotion', () => {
  const geometry = {
    startFrame: 30, durationFrames: 60, fps: 30, x: 100, y: 200, width: 400, height: 120,
  };

  it('builds two-point entry tracks for slides and pop', () => {
    for (const preset of ['slide-in-left', 'slide-in-right', 'slide-in-up', 'pop'] as const) {
      const motion = shapePresetMotion(preset, geometry);
      const tracks = Object.values(motion);
      expect(tracks.length).toBeGreaterThan(0);
      for (const track of tracks) expect(track.length).toBe(2);
    }
    expect(shapePresetMotion('slide-in-left', geometry).motionX?.[1]).toMatchObject({ value: 100 });
    expect(shapePresetMotion('slide-in-up', geometry).motionY?.[1]).toMatchObject({ value: 200 });
  });

  it('runs full-span tracks for spin, pulse, and draw-on', () => {
    expect(shapePresetMotion('spin', geometry).motionRot).toEqual([
      { frame: 30, value: 0 },
      { frame: 90, value: 360 },
    ]);
    const pulse = shapePresetMotion('pulse', geometry);
    expect(pulse.motionScaleX).toHaveLength(3);
    expect(pulse.motionScaleX?.[1]?.value).toBe(1.15);
    // Epsilon start: never a zero-width scale for the export filter.
    expect(shapePresetMotion('draw-on', geometry).motionScaleX?.[0]?.value).toBeGreaterThan(0);
  });

  it('yields no track for unusable timing', () => {
    expect(shapePresetMotion('spin', { ...geometry, durationFrames: 0 })).toEqual({});
    expect(shapePresetMotion('pop', { ...geometry, durationFrames: 0 })).toEqual({});
  });

  it('covers exactly the documented preset set', () => {
    expect([...SHAPE_ANIMATION_PRESETS].sort()).toEqual(
      ['draw-on', 'pop', 'pulse', 'slide-in-left', 'slide-in-right', 'slide-in-up', 'spin'].sort(),
    );
  });
});

describe('addShapeClips (controller)', () => {
  it('creates a defaulted shape and refuses bad tracks in one step', () => {
    const ctrl = new EditorController();
    const id = ctrl.addShapeClip({ trackId: 'v1', shapeKind: 'arrow' });
    expect(id).not.toBe('');
    const clip = ctrl.getClips().find((c) => c.id === id)!;
    expect(clip.type).toBe('shape');
    expect(clip.shapeKind).toBe('arrow');
    expect(clip.shapeStrokeColor).toBe('#ffffff');
    expect(clip.shapeStrokeWidth).toBe(4);
    expect(clip.label).toBe('Arrow');
    // Centered half-canvas box on the default 1920x1080 project.
    expect(clip).toMatchObject({ x: 480, y: 270, width: 960, height: 540 });

    ctrl.setTrackLocked('v1', true);
    expect(ctrl.addShapeClip({ trackId: 'v1', shapeKind: 'rect' })).toBe('');
    ctrl.setTrackLocked('v1', false);
    expect(ctrl.addShapeClip({ trackId: 'a1', shapeKind: 'rect' })).toBe('');
    expect(ctrl.getClips()).toHaveLength(1);
  });

  it('batches several entries as one undoable step', () => {
    const ctrl = new EditorController();
    const result = ctrl.addShapeClips([
      { trackId: 'v1', startFrame: 0, durationFrames: 30, shapeKind: 'rect' },
      { trackId: 'ghost', startFrame: 0, durationFrames: 30, shapeKind: 'rect' },
      {
        trackId: 'v1', startFrame: 60, durationFrames: 30, shapeKind: 'ellipse',
        strokeColor: '#ff0000', strokeWidth: 8, fillColor: '#00ff0040',
        preset: 'pop',
      },
    ]);
    expect(result.added).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/ghost/);
    const styled = ctrl.getClips().find((c) => c.shapeKind === 'ellipse')!;
    expect(styled.shapeStrokeColor).toBe('#ff0000');
    expect(styled.motionScaleX).toHaveLength(2);

    ctrl.undo();
    expect(ctrl.getClips()).toHaveLength(0);
    ctrl.redo();
    expect(ctrl.getClips()).toHaveLength(2);
  });

  it('round-trips shape fields through serialize/deserialize', () => {
    const ctrl = new EditorController();
    ctrl.addShapeClip({
      trackId: 'v1', startFrame: 10, durationFrames: 30, shapeKind: 'arrow',
      strokeColor: '#ff0000', strokeWidth: 6, fillColor: '#00000080', x: 5, y: 6,
    });
    const restored = EditorController.deserialize(ctrl.serialize());
    expect(restored.getClips()).toHaveLength(1);
    expect(restored.getClips()[0]).toMatchObject({
      type: 'shape',
      shapeKind: 'arrow',
      shapeStrokeColor: '#ff0000',
      shapeStrokeWidth: 6,
      shapeFillColor: '#00000080',
    });
  });

  it('narrows hostile stored values on load', () => {
    const ctrl = new EditorController();
    ctrl.addShapeClip({ trackId: 'v1', shapeKind: 'rect' });
    const raw = JSON.parse(ctrl.serialize()) as {
      timeline: { clips: Array<Record<string, unknown>> };
    };
    raw.timeline.clips[0]!.shapeKind = 'circle';
    raw.timeline.clips[0]!.shapeStrokeColor = 'red';
    const restored = EditorController.deserialize(JSON.stringify(raw));
    expect(restored.getClips()[0]!.shapeKind).toBeUndefined();
    expect(restored.getClips()[0]!.shapeStrokeColor).toBeUndefined();
  });

  it('carries shape style shape-to-shape via transferClipSettings', () => {
    const ctrl = new EditorController();
    const source = ctrl.addShapeClip({
      trackId: 'v1', shapeKind: 'arrow', strokeColor: '#ff0000', strokeWidth: 8,
    });
    const target = ctrl.addShapeClip({ trackId: 'v1', shapeKind: 'rect' });
    const receipt = ctrl.transferClipSettings(source, [target]);
    expect(receipt.changedClipIds).toEqual([target]);
    expect(ctrl.getClips().find((c) => c.id === target)!).toMatchObject({
      shapeKind: 'arrow', shapeStrokeColor: '#ff0000', shapeStrokeWidth: 8,
    });
    // Identical repeat is a no-op with no history entry.
    const repeat = ctrl.transferClipSettings(source, [target]);
    expect(receipt.changedClipIds).toHaveLength(1);
    expect(repeat.changedClipIds).toHaveLength(0);
    ctrl.undo();
    expect(ctrl.getClips().find((c) => c.id === target)!.shapeKind).toBe('rect');
  });

  it('refuses swap and reports empty shapes in diagnostics', () => {    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'v', path: 'D:/footage/v.mp4', filename: 'v.mp4', type: 'video',
      duration: 500, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const id = ctrl.addShapeClip({ trackId: 'v1', shapeKind: 'rect' });
    const verdict = ctrl.canSwapClipMedia(id, 'v');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/cannot be swapped/);

    const issues = diagnoseTimeline(ctrl.getProject());
    expect(issues.some((i) => i.code === 'missing-media')).toBe(false);

    ctrl.applyClipProperties([id], 'Empty', (draft) => {
      delete draft.shapeStrokeColor;
      delete draft.shapeFillColor;
      return true;
    });
    expect(diagnoseTimeline(ctrl.getProject()).some((i) => i.code === 'empty-shape')).toBe(true);
  });

  it('rides ripple deletes exactly like a title clip', () => {
    const ctrl = new EditorController();
    const titleId = ctrl.addTitleClip({ trackId: 'v1', text: 'Lead', startFrame: 0, durationFrames: 30 });
    const shapeId = ctrl.addShapeClip({ trackId: 'v1', shapeKind: 'rect', startFrame: 30, durationFrames: 30 });
    const report = ctrl.rippleDeleteClips([titleId])!;
    expect(report.removedClipIds).toEqual([titleId]);
    expect(report.shiftedClipIds).toEqual([shapeId]);
    expect(ctrl.getClips().find((c) => c.id === shapeId)!.startFrame).toBe(0);
    ctrl.undo();
    expect(ctrl.getClips().find((c) => c.id === shapeId)!.startFrame).toBe(30);
  });
});
