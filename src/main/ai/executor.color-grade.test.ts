/**
 * Regression coverage for the set_clip_color_grade agent tool (upstream #157):
 * partial patches leave untouched fields alone, defaults clear fields, invert
 * toggles, clear resets the whole grade, and every mutation is one undo step.
 */

import { describe, expect, it } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { ToolExecutor } from './executor';

function harness() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'asset',
    path: 'C:\\media\\clip.mp4',
    filename: 'clip.mp4',
    type: 'video',
    duration: 5000,
    width: 1920,
    height: 1080,
    fileSize: 100,
    addedAt: '2026-09-01T00:00:00.000Z',
  });
  const clipId = editor.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 100 });
  return { editor, executor: new ToolExecutor(editor), clipId };
}

interface GradeData {
  changed?: boolean;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  hueRotation?: number;
  exposure?: number;
  temperature?: number;
  tint?: number;
  invertColors?: boolean;
  cleared?: boolean;
}

describe('set_clip_color_grade (#157)', () => {
  it('sets a partial grade and reports the effective values', async () => {
    const { editor, executor, clipId } = harness();

    const result = await executor.execute('set_clip_color_grade', {
      clipId,
      brightness: -0.2,
      saturation: 1.4,
    });

    expect(result.success).toBe(true);
    const data = result.data as GradeData;
    expect(data.changed).toBe(true);
    expect(data.brightness).toBe(-0.2);
    expect(data.saturation).toBe(1.4);
    expect(data.contrast).toBe(1);
    expect(data.cleared).toBe(false);
    expect(editor.getClips()[0]).toMatchObject({ brightness: -0.2, saturation: 1.4 });
  });

  it('leaves omitted fields untouched', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', { clipId, brightness: 0.3 });

    await executor.execute('set_clip_color_grade', { clipId, contrast: 1.2 });

    expect(editor.getClips()[0]).toMatchObject({ brightness: 0.3, contrast: 1.2 });
  });

  it('clears one field by passing its default', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', { clipId, contrast: 1.5, hueRotation: 45 });

    const result = await executor.execute('set_clip_color_grade', { clipId, hueRotation: 0 });

    expect(result.success).toBe(true);
    expect(editor.getClips()[0].hueRotation).toBeUndefined();
    expect(editor.getClips()[0].contrast).toBe(1.5);
  });

  it('toggles invert both ways', async () => {
    const { editor, executor, clipId } = harness();

    await executor.execute('set_clip_color_grade', { clipId, invertColors: true });
    expect(editor.getClips()[0].invertColors).toBe(true);
    expect((await executor.execute('set_clip_color_grade', { clipId, invertColors: true })).data)
      .toMatchObject({ changed: false });

    await executor.execute('set_clip_color_grade', { clipId, invertColors: false });
    expect(editor.getClips()[0].invertColors).toBeUndefined();
  });

  it('clear resets the whole grade in one step', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', {
      clipId, brightness: 0.1, contrast: 1.4, saturation: 0.5, hueRotation: 90, invertColors: true,
    });

    const result = await executor.execute('set_clip_color_grade', { clipId, clear: true });

    expect(result.success).toBe(true);
    expect((result.data as GradeData).cleared).toBe(true);
    const clip = editor.getClips()[0];
    expect(clip.brightness).toBeUndefined();
    expect(clip.contrast).toBeUndefined();
    expect(clip.saturation).toBeUndefined();
    expect(clip.hueRotation).toBeUndefined();
    expect(clip.invertColors).toBeUndefined();
  });

  it('refuses non-visual clips and unknown ids', async () => {
    const { editor, executor, clipId } = harness();
    editor.addMedia({
      id: 'a', path: 'X:/a.wav', filename: 'a.wav', type: 'audio',
      duration: 10, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const audioId = editor.addClip({ assetId: 'a', trackId: 'a1', startFrame: 0, durationFrames: 30 });

    const missing = await executor.execute('set_clip_color_grade', { clipId: 'ghost', brightness: 0.1 });
    expect(missing.success).toBe(false);
    expect((missing as { error?: string }).error).toMatch(/not found/i);

    const audio = await executor.execute('set_clip_color_grade', { clipId: audioId, brightness: 0.1 });
    expect(audio.success).toBe(false);
    expect((audio as { error?: string }).error).toMatch(/video and image/i);

    // Schema refuses an empty request outright.
    const empty = await executor.execute('set_clip_color_grade', { clipId });
    expect(empty.success).toBe(false);

    // Out-of-range values are rejected at the schema boundary.
    const outOfRange = await executor.execute('set_clip_color_grade', { clipId, contrast: 99 });
    expect(outOfRange.success).toBe(false);
  });

  it('is one undo step', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', { clipId, brightness: 0.2, saturation: 0.4 });

    expect(editor.undo()).toBe(true);

    const clip = editor.getClips()[0];
    expect(clip.brightness).toBeUndefined();
    expect(clip.saturation).toBeUndefined();
  });

  it('sets exposure and reports it, clearing on the default', async () => {
    const { editor, executor, clipId } = harness();

    const result = await executor.execute('set_clip_color_grade', { clipId, exposure: 1.5 });
    expect(result.success).toBe(true);
    expect((result.data as GradeData).exposure).toBe(1.5);
    expect(editor.getClips()[0].exposure).toBe(1.5);

    const cleared = await executor.execute('set_clip_color_grade', { clipId, exposure: 0 });
    expect(cleared.success).toBe(true);
    expect(editor.getClips()[0].exposure).toBeUndefined();
  });

  it('refuses out-of-range exposure without touching the clip', async () => {
    const { editor, executor, clipId } = harness();

    const result = await executor.execute('set_clip_color_grade', { clipId, exposure: 99 });
    expect(result.success).toBe(false);
    expect(editor.getClips()[0].exposure).toBeUndefined();
  });

  it('sets white balance and reports it, clearing on the defaults', async () => {
    const { editor, executor, clipId } = harness();

    const result = await executor.execute('set_clip_color_grade', { clipId, temperature: 3200, tint: 10 });
    expect(result.success).toBe(true);
    expect((result.data as GradeData).temperature).toBe(3200);
    expect((result.data as GradeData).tint).toBe(10);
    expect(editor.getClips()[0]).toMatchObject({ temperature: 3200, tint: 10 });

    const cleared = await executor.execute('set_clip_color_grade', { clipId, temperature: 6500, tint: 0 });
    expect(cleared.success).toBe(true);
    expect(editor.getClips()[0].temperature).toBeUndefined();
    expect(editor.getClips()[0].tint).toBeUndefined();
  });

  it('refuses out-of-range white balance without touching the clip', async () => {
    const { editor, executor, clipId } = harness();

    expect((await executor.execute('set_clip_color_grade', { clipId, temperature: 100 })).success).toBe(false);
    expect((await executor.execute('set_clip_color_grade', { clipId, tint: 200 })).success).toBe(false);
    expect(editor.getClips()[0].temperature).toBeUndefined();
    expect(editor.getClips()[0].tint).toBeUndefined();
  });
});
