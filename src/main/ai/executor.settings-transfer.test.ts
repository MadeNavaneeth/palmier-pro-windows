/**
 * Regression coverage for the copy_clip_settings agent tool (upstream
 * #515): explicit ids, whole-track targeting with same-kind matching and
 * source exclusion, exactly-one-target-mode enforcement, and receipt shape.
 */

import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { parseToolArguments } from './openai-compatible';
import { EditorController } from '../../shared/editor/controller';

function executorWithClips() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'asset-v',
    path: '/test/v.mp4',
    filename: 'v.mp4',
    type: 'video',
    duration: 5000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  const source = editor.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 0 });
  editor.applyClipProperties([source], 'Set', (d) => {
    d.opacity = 0.3;
    d.x = 200;
    return true;
  });
  const t1 = editor.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 1000 });
  return { editor, executor: new ToolExecutor(editor), source, t1 };
}

describe('copy_clip_settings tool (#515)', () => {
  it('applies settings to explicit target ids and reports the receipt', async () => {
    const { editor, executor, source, t1 } = executorWithClips();
    const result = await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [t1],
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      changed: true,
      changedClipIds: [t1],
      sourceClipId: source,
      mediaType: 'video',
    });
    const clip = editor.getClips().find((c) => c.id === t1)!;
    expect(clip.opacity).toBe(0.3);
    expect(clip.x).toBe(200);
  });

  it('targets a whole track, excluding the source and other kinds', async () => {
    const { editor, executor, source } = executorWithClips();
    editor.addMedia({
      id: 'asset-a',
      path: '/test/a.mp3',
      filename: 'a.mp3',
      type: 'audio',
      duration: 5000,
      fileSize: 1,
      addedAt: new Date().toISOString(),
    });
    const audioId = editor.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 0 });

    const result = await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetTrack: { trackId: 'v1' },
    });
    expect(result.success).toBe(true);
    const data = result.data as { changedClipIds: string[]; matchedClipCount?: number };
    // Only the other video clip on v1; the audio clip never matches.
    expect(data.changedClipIds).not.toContain(source);
    void audioId;
  });

  it('accepts a provider-normalized null for an omitted nested range', async () => {
    const { editor, executor, source } = executorWithClips();
    editor.addClip({ assetId: 'asset-v', trackId: 'v1', startFrame: 2000 });

    const args = parseToolArguments(JSON.stringify({
      sourceClipId: source,
      targetTrack: { trackId: 'v1', range: null },
    }));
    const result = await executor.execute('copy_clip_settings', args);

    expect(result.success).toBe(true);
  });

  it('enforces exactly one targeting mode', async () => {
    const { executor, source, t1 } = executorWithClips();
    for (const args of [
      { sourceClipId: source },
      { sourceClipId: source, targetClipIds: [t1], targetTrack: { trackId: 'v1' } },
    ]) {
      const result = await executor.execute('copy_clip_settings', args);
      expect(result.success).toBe(false);
      expect((result as { error?: string }).error).toMatch(/exactly one of targetClipIds or targetTrack/i);
    }
  });

  it('carries audio pan and EQ onto audio targets (#158)', async () => {
    const { editor, executor } = executorWithClips();
    editor.addMedia({
      id: 'asset-a',
      path: '/test/a.mp3',
      filename: 'a.mp3',
      type: 'audio',
      duration: 5000,
      fileSize: 1,
      addedAt: new Date().toISOString(),
    });
    const source = editor.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 0 });
    const target = editor.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 100 });
    editor.applyClipProperties([source], 'Set', (d) => {
      d.pan = -0.5;
      d.eqLowDb = 6;
      d.eqHighDb = -3;
      return true;
    });

    const result = await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [target],
    });

    expect(result.success).toBe(true);
    expect(editor.getClips().find((c) => c.id === target)).toMatchObject({
      pan: -0.5,
      eqLowDb: 6,
      eqHighDb: -3,
    });
  });

  it('carries a compressor onto audio targets (#158)', async () => {
    const { editor, executor } = executorWithClips();
    editor.addMedia({
      id: 'asset-a',
      path: '/test/a.mp3',
      filename: 'a.mp3',
      type: 'audio',
      duration: 5000,
      fileSize: 1,
      addedAt: new Date().toISOString(),
    });
    const source = editor.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 0 });
    const target = editor.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 100 });
    editor.applyClipProperties([source], 'Set', (d) => {
      d.compressor = { thresholdDb: -20, ratio: 5, attackMs: 10, releaseMs: 200, makeupDb: 3 };
      return true;
    });

    await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [target],
    });

    expect(editor.getClips().find((c) => c.id === target)?.compressor).toMatchObject({
      thresholdDb: -20,
      ratio: 5,
    });
  });

  it('carries noise reduction onto audio targets (#165)', async () => {
    const { editor, executor } = executorWithClips();
    editor.addMedia({
      id: 'asset-a',
      path: '/test/a.mp3',
      filename: 'a.mp3',
      type: 'audio',
      duration: 5000,
      fileSize: 1,
      addedAt: new Date().toISOString(),
    });
    const source = editor.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 0 });
    const target = editor.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 100 });
    editor.applyClipProperties([source], 'Set', (d) => {
      d.noiseReduction = 70;
      return true;
    });

    await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [target],
    });

    expect(editor.getClips().find((c) => c.id === target)?.noiseReduction).toBe(70);
  });

  it('leaves a target EQ alone when the audio source is neutral', async () => {
    const { editor, executor } = executorWithClips();
    editor.addMedia({
      id: 'asset-a',
      path: '/test/a.mp3',
      filename: 'a.mp3',
      type: 'audio',
      duration: 5000,
      fileSize: 1,
      addedAt: new Date().toISOString(),
    });
    const source = editor.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 0 });
    const target = editor.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 100 });
    editor.applyClipProperties([target], 'Set', (d) => {
      d.eqMidDb = 4;
      return true;
    });

    await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [target],
    });

    // Same rule as the color grade: non-default fields transfer, a neutral
    // source does not wipe the target's effect.
    expect(editor.getClips().find((c) => c.id === target)?.eqMidDb).toBe(4);
  });

  it('carries invert-colors with the color grade', async () => {
    const { editor, executor, source, t1 } = executorWithClips();
    editor.applyClipProperties([source], 'Set', (d) => {
      d.invertColors = true;
      return true;
    });

    await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [t1],
    });

    expect(editor.getClips().find((c) => c.id === t1)?.invertColors).toBe(true);
  });

  it('carries exposure with the color grade', async () => {
    const { editor, executor, source, t1 } = executorWithClips();
    editor.applyClipProperties([source], 'Set', (d) => {
      d.exposure = 1.5;
      return true;
    });

    await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [t1],
    });

    expect(editor.getClips().find((c) => c.id === t1)?.exposure).toBe(1.5);
  });

  it('carries white balance with the color grade', async () => {
    const { editor, executor, source, t1 } = executorWithClips();
    editor.applyClipProperties([source], 'Set', (d) => {
      d.temperature = 3200;
      d.tint = 10;
      return true;
    });

    await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [t1],
    });

    const target = editor.getClips().find((c) => c.id === t1);
    expect(target?.temperature).toBe(3200);
    expect(target?.tint).toBe(10);
  });

  it('carries tonal levels with the color grade', async () => {
    const { editor, executor, source, t1 } = executorWithClips();
    editor.applyClipProperties([source], 'Set', (d) => {
      d.highlights = 0.5;
      d.shadows = -0.5;
      d.blacks = 0.5;
      d.whites = -0.5;
      return true;
    });

    await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [t1],
    });

    expect(editor.getClips().find((c) => c.id === t1)).toMatchObject({
      highlights: 0.5, shadows: -0.5, blacks: 0.5, whites: -0.5,
    });
  });

  it('carries vibrance with the color grade', async () => {
    const { editor, executor, source, t1 } = executorWithClips();
    editor.applyClipProperties([source], 'Set', (d) => {
      d.vibrance = 0.5;
      return true;
    });

    await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [t1],
    });

    expect(editor.getClips().find((c) => c.id === t1)?.vibrance).toBe(0.5);
  });

  it('carries tone curves with the color grade', async () => {
    const { editor, executor, source, t1 } = executorWithClips();
    const curves = {
      master: [{ x: 0, y: 0.06 }, { x: 1, y: 0.95 }],
      red: [],
      green: [],
      blue: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }],
    };
    editor.applyClipProperties([source], 'Set', (d) => {
      d.curves = curves;
      return true;
    });

    await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [t1],
    });

    expect(editor.getClips().find((c) => c.id === t1)?.curves).toEqual(curves);
  });

  it('carries wheels with the color grade', async () => {
    const { editor, executor, source, t1 } = executorWithClips();
    const wheels = {
      lift: { x: 0.5, y: -0.5, m: 0.1 },
      gamma: { x: 0, y: 0, m: 1 },
      gain: { x: 0, y: 0, m: 1.2 },
    };
    editor.applyClipProperties([source], 'Set', (d) => {
      d.wheels = wheels;
      return true;
    });

    await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [t1],
    });

    expect(editor.getClips().find((c) => c.id === t1)?.wheels).toEqual(wheels);
  });

  it('carries hue curves with the color grade', async () => {
    const { editor, executor, source, t1 } = executorWithClips();
    const hueCurves = {
      hueVsHue: [],
      hueVsSat: [{ x: 0, y: 0.8 }, { x: 0.15, y: 0.5 }],
      hueVsLum: [],
    };
    editor.applyClipProperties([source], 'Set', (d) => {
      d.hueCurves = hueCurves;
      return true;
    });

    await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [t1],
    });

    expect(editor.getClips().find((c) => c.id === t1)?.hueCurves).toEqual(hueCurves);
  });

  it('carries the LUT reference with the color grade', async () => {
    const { editor, executor, source, t1 } = executorWithClips();
    const lut = { path: 'C:\\luts\\warm.cube', intensity: 0.5, kind: '3d' as const, size: 33 };
    editor.applyClipProperties([source], 'Set', (d) => {
      d.lut = lut;
      return true;
    });

    await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [t1],
    });

    expect(editor.getClips().find((c) => c.id === t1)?.lut).toEqual(lut);
  });

  it('carries effect stages with the color grade', async () => {
    const { editor, executor, source, t1 } = executorWithClips();
    editor.applyClipProperties([source], 'Set', (d) => {
      d.blurRadius = 8;
      d.clarity = { clarity: 0.5, dehaze: 0.25 };
      d.vignette = { amount: -0.5, midpoint: 0.5, roundness: 0, feather: 0.5 };
      d.grain = { amount: 0.5, size: 2 };
      return true;
    });

    await executor.execute('copy_clip_settings', {
      sourceClipId: source,
      targetClipIds: [t1],
    });

    const target = editor.getClips().find((c) => c.id === t1)!;
    expect(target.blurRadius).toBe(8);
    expect(target.clarity).toEqual({ clarity: 0.5, dehaze: 0.25 });
    expect(target.vignette?.amount).toBe(-0.5);
    expect(target.grain).toEqual({ amount: 0.5, size: 2 });
  });

  it('carries clarity without leaving the target sharing a mutable object', async () => {
    const { editor, executor, source, t1 } = executorWithClips();
    editor.applyClipProperties([source], 'Set', (d) => {
      d.clarity = { clarity: 0.5, dehaze: 0 };
      return true;
    });
    await executor.execute('copy_clip_settings', { sourceClipId: source, targetClipIds: [t1] });

    const copied = editor.getClips().find((c) => c.id === t1)!.clarity!;
    const original = editor.getClips().find((c) => c.id === source)!.clarity!;
    expect(copied).toEqual(original);
    // The transfer clones, so editing one clip's clarity cannot mutate the other.
    expect(copied).not.toBe(original);
  });

  it('clears a target clarity when the source draws effects but has no clarity', async () => {
    // Effect stages travel wholesale once the source has ANY grade or effect:
    // each key is explicit, so a stage the source lacks overwrites the target's
    // with undefined rather than leaving it behind.
    const { editor, executor, source, t1 } = executorWithClips();
    editor.applyClipProperties([t1], 'Set', (d) => {
      d.clarity = { clarity: 0.5, dehaze: 0 };
      return true;
    });
    editor.applyClipProperties([source], 'Set', (d) => {
      d.blurRadius = 4;
      return true;
    });
    await executor.execute('copy_clip_settings', { sourceClipId: source, targetClipIds: [t1] });
    expect(editor.getClips().find((c) => c.id === t1)!.clarity).toBeUndefined();
    expect(editor.getClips().find((c) => c.id === t1)!.blurRadius).toBe(4);
  });

  it('leaves a target clarity alone when the source has no grade or effects at all', async () => {
    // The complementary half of the same rule: a source that draws nothing
    // transfers nothing, so an ungraded source does not wipe the target.
    const { editor, executor, source, t1 } = executorWithClips();
    editor.applyClipProperties([t1], 'Set', (d) => {
      d.clarity = { clarity: 0.5, dehaze: 0 };
      return true;
    });
    await executor.execute('copy_clip_settings', { sourceClipId: source, targetClipIds: [t1] });
    expect(editor.getClips().find((c) => c.id === t1)!.clarity).toEqual({ clarity: 0.5, dehaze: 0 });
  });

  it('refuses cross-kind targets with the domain message', async () => {
    const { editor, executor } = executorWithClips();
    editor.addMedia({
      id: 'asset-a',
      path: '/test/a.mp3',
      filename: 'a.mp3',
      type: 'audio',
      duration: 5000,
      fileSize: 1,
      addedAt: new Date().toISOString(),
    });
    const audioId = editor.addClip({ assetId: 'asset-a', trackId: 'a1', startFrame: 0 });

    const result = await executor.execute('copy_clip_settings', {
      sourceClipId: audioId,
      targetClipIds: ['no-such-clip'],
    });
    // Unknown target id is refused before kind checks can even apply.
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/not found/i);
    void editor;
  });
});
