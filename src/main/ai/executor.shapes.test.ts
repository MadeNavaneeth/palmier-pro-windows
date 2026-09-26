/**
 * Regression coverage for the add_shapes and set_shape_style agent tools:
 * batch placement with presets as one undo step, style updates with
 * clear-semantics, refusals, motion on shapes, and settings transfer.
 */
import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

function executorWithTracks() {
  const editor = new EditorController();
  return { editor, executor: new ToolExecutor(editor) };
}

describe('add_shapes tool', () => {
  it('adds multiple shapes with defaults and reports their ids', async () => {
    const { editor, executor } = executorWithTracks();
    const result = await executor.execute('add_shapes', {
      entries: [
        { trackId: 'v1', startFrame: 0, durationFrames: 60, kind: 'arrow' },
        { trackId: 'v1', startFrame: 120, durationFrames: 90, kind: 'ellipse' },
      ],
    });
    expect(result.success).toBe(true);
    const added = (result.data as { added: Array<{ kind: string }> }).added;
    expect(added).toHaveLength(2);
    const clips = editor.getClips().filter((c) => c.type === 'shape');
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({
      shapeKind: 'arrow', shapeStrokeColor: '#ffffff', shapeStrokeWidth: 4,
    });
  });

  it('carries geometry, style, and presets at creation', async () => {
    const { editor, executor } = executorWithTracks();
    await executor.execute('add_shapes', {
      entries: [{
        trackId: 'v1', startFrame: 10, durationFrames: 60, kind: 'rect',
        x: 50, y: 60, width: 300, height: 200,
        strokeColor: '#ff0000', strokeWidth: 8, fillColor: '#00ff0040',
        preset: 'slide-in-left',
      }],
    });
    const clip = editor.getClips().find((c) => c.type === 'shape')!;
    expect(clip).toMatchObject({
      x: 50, y: 60, width: 300, height: 200,
      shapeStrokeColor: '#ff0000', shapeStrokeWidth: 8, shapeFillColor: '#00ff0040',
    });
    expect(clip.motionX).toHaveLength(2);
    expect(clip.motionX?.[1]).toMatchObject({ value: 50 });
  });

  it('is one undo step for the whole batch', async () => {
    const { editor, executor } = executorWithTracks();
    await executor.execute('add_shapes', {
      entries: [
        { trackId: 'v1', startFrame: 0, durationFrames: 30, kind: 'rect', preset: 'pop' },
        { trackId: 'v1', startFrame: 40, durationFrames: 30, kind: 'line' },
      ],
    });
    expect(editor.getClips()).toHaveLength(2);
    editor.undo();
    expect(editor.getClips()).toHaveLength(0);
    editor.redo();
    expect(editor.getClips()).toHaveLength(2);
  });

  it('reports partial success and fails when every entry is invalid', async () => {
    const { executor } = executorWithTracks();
    const partial = await executor.execute('add_shapes', {
      entries: [
        { trackId: 'ghost-track', startFrame: 0, durationFrames: 30, kind: 'rect' },
        { trackId: 'v1', startFrame: 0, durationFrames: 30, kind: 'rect' },
      ],
    });
    expect(partial.success).toBe(true);
    const data = partial.data as { added: unknown[]; errors: string[] };
    expect(data.added).toHaveLength(1);
    expect(data.errors[0]).toMatch(/ghost-track/);

    const failed = await executor.execute('add_shapes', {
      entries: [{ trackId: 'nope', startFrame: 0, durationFrames: 30, kind: 'rect' }],
    });
    expect(failed.success).toBe(false);
  });

  it('refuses locked and audio tracks without adding history', async () => {
    const { editor, executor } = executorWithTracks();
    editor.setTrackLocked('v1', true);
    expect((await executor.execute('add_shapes', {
      entries: [{ trackId: 'v1', startFrame: 0, durationFrames: 30, kind: 'rect' }],
    })).success).toBe(false);
    editor.setTrackLocked('v1', false);
    expect((await executor.execute('add_shapes', {
      entries: [{ trackId: 'a1', startFrame: 0, durationFrames: 30, kind: 'rect' }],
    })).success).toBe(false);
    expect(editor.getClips()).toHaveLength(0);
  });
});

describe('set_shape_style tool', () => {
  it('updates kind and style without touching timing', async () => {
    const { editor, executor } = executorWithTracks();
    const id = editor.addShapeClip({ trackId: 'v1', shapeKind: 'rect', startFrame: 50, durationFrames: 40 });
    const before = editor.getClips()[0];

    const result = await executor.execute('set_shape_style', {
      clipId: id, kind: 'arrow', strokeColor: '#ff0000', strokeWidth: 10,
    });
    expect(result.success).toBe(true);
    const clip = editor.getClips().find((c) => c.id === id)!;
    expect(clip).toMatchObject({ shapeKind: 'arrow', shapeStrokeColor: '#ff0000', shapeStrokeWidth: 10 });
    expect(clip.startFrame).toBe(before.startFrame);
    expect(clip.durationFrames).toBe(before.durationFrames);
  });

  it('clears stroke at 0 and fill at null, and applies presets', async () => {
    const { editor, executor } = executorWithTracks();
    const id = editor.addShapeClip({
      trackId: 'v1', shapeKind: 'rect', strokeWidth: 6, fillColor: '#00ff0080',
    });
    await executor.execute('set_shape_style', {
      clipId: id, strokeWidth: 0, fillColor: null, preset: 'spin',
    });
    const clip = editor.getClips().find((c) => c.id === id)!;
    expect(clip.shapeStrokeWidth).toBeUndefined();
    expect(clip.shapeFillColor).toBeUndefined();
    expect(clip.motionRot?.[1]?.value).toBe(360);
  });

  it('refuses non-shapes, unknown kinds, and bad colors', async () => {
    const { editor, executor } = executorWithTracks();
    editor.addMedia({
      id: 'v', path: 'X:/v.mp4', filename: 'v.mp4', type: 'video',
      duration: 60, width: 1920, height: 1080, fileSize: 1,
      addedAt: new Date().toISOString(),
    });
    const videoId = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 30 });
    const shapeId = editor.addShapeClip({ trackId: 'v1', shapeKind: 'rect' });

    expect((await executor.execute('set_shape_style', { clipId: videoId, kind: 'arrow' })).success)
      .toBe(false);
    expect((await executor.execute('set_shape_style', { clipId: 'ghost', kind: 'arrow' })).success)
      .toBe(false);
    expect((await executor.execute('set_shape_style', { clipId: shapeId, kind: 'circle' })).success)
      .toBe(false);
    expect((await executor.execute('set_shape_style', { clipId: shapeId, strokeColor: 'red' })).success)
      .toBe(false);
    expect((await executor.execute('set_shape_style', { clipId: shapeId, preset: 'wiggle' })).success)
      .toBe(false);
  });
});

describe('shape motion and transfer', () => {
  it('animates shapes but still refuses titles and audio', async () => {
    const { editor, executor } = executorWithTracks();
    const shapeId = editor.addShapeClip({ trackId: 'v1', shapeKind: 'rect' });
    const titleId = editor.addTitleClip({ trackId: 'v1', text: 'Hi' });

    const ok = await executor.execute('set_clip_motion', {
      clipId: shapeId, axis: 'x',
      points: [{ frame: 0, value: 5 }, { frame: 10, value: 50 }],
    });
    expect(ok.success).toBe(true);
    expect(editor.getClips().find((c) => c.id === shapeId)!.motionX).toHaveLength(2);

    expect((await executor.execute('set_clip_motion', {
      clipId: titleId, axis: 'x',
      points: [{ frame: 0, value: 5 }, { frame: 10, value: 50 }],
    })).success).toBe(false);
  });

  it('carries shape style shape-to-shape and refuses cross-type transfer', async () => {
    const { editor, executor } = executorWithTracks();
    const source = editor.addShapeClip({
      trackId: 'v1', shapeKind: 'arrow', strokeColor: '#ff0000', strokeWidth: 8,
    });
    const target = editor.addShapeClip({ trackId: 'v1', shapeKind: 'rect' });

    const carried = await executor.execute('copy_clip_settings', {
      sourceClipId: source, targetClipIds: [target],
    });
    expect(carried.success).toBe(true);
    expect(editor.getClips().find((c) => c.id === target)!).toMatchObject({
      shapeKind: 'arrow', shapeStrokeColor: '#ff0000',
    });

    const titleId = editor.addTitleClip({ trackId: 'v1', text: 'Hi' });
    expect((await executor.execute('copy_clip_settings', {
      sourceClipId: source, targetClipIds: [titleId],
    })).success).toBe(false);
  });
});
