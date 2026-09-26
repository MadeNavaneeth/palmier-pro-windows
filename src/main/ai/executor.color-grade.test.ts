/**
 * Regression coverage for the set_clip_color_grade agent tool (upstream #157):
 * partial patches leave untouched fields alone, defaults clear fields, invert
 * toggles, clear resets the whole grade, and every mutation is one undo step.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EditorController } from '../../shared/editor/controller';
import { ToolExecutor } from './executor';
import type { GradeCurve, GradeWheels, HueCurves } from '../../shared/editor/color-grade';
import type { LutRef } from '../../shared/editor/lut';
import type { Glow, Grain, Vignette } from '../../shared/editor/effects';

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
  vibrance?: number;
  highlights?: number;
  shadows?: number;
  blacks?: number;
  whites?: number;
  invertColors?: boolean;
  curves?: GradeCurve | null;
  wheels?: GradeWheels | null;
  hueCurves?: HueCurves | null;
  lut?: LutRef | null;
  blurRadius?: number;
  vignette?: Vignette | null;
  grain?: Grain | null;
  glow?: Glow | null;
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

  it('sets vibrance and reports it, clearing on the default', async () => {
    const { editor, executor, clipId } = harness();

    const result = await executor.execute('set_clip_color_grade', { clipId, vibrance: 0.5 });
    expect(result.success).toBe(true);
    expect((result.data as GradeData).vibrance).toBe(0.5);
    expect(editor.getClips()[0].vibrance).toBe(0.5);

    const cleared = await executor.execute('set_clip_color_grade', { clipId, vibrance: 0 });
    expect(cleared.success).toBe(true);
    expect(editor.getClips()[0].vibrance).toBeUndefined();
  });

  it('refuses out-of-range vibrance without touching the clip', async () => {
    const { editor, executor, clipId } = harness();

    const result = await executor.execute('set_clip_color_grade', { clipId, vibrance: 2 });
    expect(result.success).toBe(false);
    expect(editor.getClips()[0].vibrance).toBeUndefined();
  });

  it('sets tonal levels and reports them, clearing on the defaults', async () => {
    const { editor, executor, clipId } = harness();

    const result = await executor.execute('set_clip_color_grade', {
      clipId, highlights: 0.5, shadows: -0.5, blacks: 0.5, whites: -0.5,
    });
    expect(result.success).toBe(true);
    const data = result.data as GradeData;
    expect(data.highlights).toBe(0.5);
    expect(data.shadows).toBe(-0.5);
    expect(data.blacks).toBe(0.5);
    expect(data.whites).toBe(-0.5);
    expect(editor.getClips()[0]).toMatchObject({
      highlights: 0.5, shadows: -0.5, blacks: 0.5, whites: -0.5,
    });

    const cleared = await executor.execute('set_clip_color_grade', {
      clipId, highlights: 0, shadows: 0, blacks: 0, whites: 0,
    });
    expect(cleared.success).toBe(true);
    const clip = editor.getClips()[0];
    expect(clip.highlights).toBeUndefined();
    expect(clip.shadows).toBeUndefined();
    expect(clip.blacks).toBeUndefined();
    expect(clip.whites).toBeUndefined();
  });

  it('refuses out-of-range tonal levels without touching the clip', async () => {
    const { editor, executor, clipId } = harness();

    expect((await executor.execute('set_clip_color_grade', { clipId, highlights: 2 })).success).toBe(false);
    expect((await executor.execute('set_clip_color_grade', { clipId, whites: -2 })).success).toBe(false);
    expect(editor.getClips()[0].highlights).toBeUndefined();
    expect(editor.getClips()[0].whites).toBeUndefined();
  });

  it('sets curves and reports them in the receipt', async () => {
    const { editor, executor, clipId } = harness();
    const curves = {
      master: [{ x: 0, y: 0.06 }, { x: 1, y: 0.95 }],
      red: [{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }],
    };

    const result = await executor.execute('set_clip_color_grade', { clipId, curves });

    expect(result.success).toBe(true);
    const data = result.data as GradeData;
    expect(data.changed).toBe(true);
    expect(data.curves).toEqual({ master: curves.master, red: curves.red, green: [], blue: [] });
    expect(editor.getClips()[0].curves).toEqual({ master: curves.master, red: curves.red, green: [], blue: [] });
    expect(data.cleared).toBe(false);
  });

  it('merges curves per channel, like upstream GradeState.apply', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', {
      clipId,
      curves: { master: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }] },
    });

    await executor.execute('set_clip_color_grade', {
      clipId,
      curves: { blue: [{ x: 0, y: 0.2 }, { x: 1, y: 0.8 }] },
    });

    expect(editor.getClips()[0].curves).toEqual({
      master: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }],
      red: [],
      green: [],
      blue: [{ x: 0, y: 0.2 }, { x: 1, y: 0.8 }],
    });
  });

  it('clears a channel with an empty array and the field when all channels clear', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', {
      clipId,
      curves: { master: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }], red: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }] },
    });

    const clearedRed = await executor.execute('set_clip_color_grade', { clipId, curves: { red: [] } });
    expect(clearedRed.success).toBe(true);
    expect(editor.getClips()[0].curves).toEqual({
      master: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }],
      red: [],
      green: [],
      blue: [],
    });

    // Identity points clear a channel just like an empty array.
    const clearedMaster = await executor.execute('set_clip_color_grade', {
      clipId,
      curves: { master: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    });
    expect(clearedMaster.success).toBe(true);
    expect(editor.getClips()[0].curves).toBeUndefined();
    expect((clearedMaster.data as GradeData).curves).toBeNull();
    expect((clearedMaster.data as GradeData).cleared).toBe(true);
  });

  it('clear: true removes the curves with the rest of the grade', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', {
      clipId,
      brightness: 0.2,
      curves: { master: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }] },
    });

    const result = await executor.execute('set_clip_color_grade', { clipId, clear: true });

    expect(result.success).toBe(true);
    expect((result.data as GradeData).cleared).toBe(true);
    expect(editor.getClips()[0].curves).toBeUndefined();
    expect(editor.getClips()[0].brightness).toBeUndefined();
  });

  it('refuses malformed curves without touching the clip', async () => {
    const { editor, executor, clipId } = harness();

    // Out-of-range coordinates are refused at the schema boundary.
    expect((await executor.execute('set_clip_color_grade', {
      clipId, curves: { master: [{ x: 1.5, y: 0 }] },
    })).success).toBe(false);
    // Non-ascending x is refused by the strict curve parser.
    const descending = await executor.execute('set_clip_color_grade', {
      clipId, curves: { master: [{ x: 0.5, y: 0.5 }, { x: 0.4, y: 0.4 }] },
    });
    expect(descending.success).toBe(false);
    expect((descending as { error?: string }).error).toMatch(/ascending/);
    // More points than the cap, and an empty curves object, are refused.
    expect((await executor.execute('set_clip_color_grade', {
      clipId,
      curves: { master: Array.from({ length: 17 }, (_, i) => ({ x: i / 100, y: i / 100 })) },
    })).success).toBe(false);
    expect((await executor.execute('set_clip_color_grade', { clipId, curves: {} })).success).toBe(false);
    expect(editor.getClips()[0].curves).toBeUndefined();
  });

  it('is one undo step, and an identical curve patch adds no history', async () => {
    const { editor, executor, clipId } = harness();
    const curves = { master: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }] };

    await executor.execute('set_clip_color_grade', { clipId, brightness: 0.2, curves });
    // Same patch again: reported as unchanged and no second history entry.
    const repeat = await executor.execute('set_clip_color_grade', { clipId, curves });
    expect((repeat.data as GradeData).changed).toBe(false);

    expect(editor.undo()).toBe(true);
    expect(editor.getClips()[0].curves).toBeUndefined();
    expect(editor.getClips()[0].brightness).toBeUndefined();
  });

  it('sets wheels and reports them in the receipt', async () => {
    const { editor, executor, clipId } = harness();
    const wheels = { gain: { m: 1.2 }, lift: { x: 0.5, y: -0.5 } };

    const result = await executor.execute('set_clip_color_grade', { clipId, wheels });

    expect(result.success).toBe(true);
    const data = result.data as GradeData;
    expect(data.changed).toBe(true);
    expect(data.wheels).toEqual({
      lift: { x: 0.5, y: -0.5, m: 0 },
      gamma: { x: 0, y: 0, m: 1 },
      gain: { x: 0, y: 0, m: 1.2 },
    });
    expect(editor.getClips()[0].wheels).toEqual(data.wheels);
    expect(data.cleared).toBe(false);
  });

  it('merges wheels per component, like the scalar fields', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', {
      clipId,
      wheels: { lift: { m: 0.2 } },
    });

    await executor.execute('set_clip_color_grade', {
      clipId,
      wheels: { gain: { m: 1.2 } },
    });

    expect(editor.getClips()[0].wheels).toEqual({
      lift: { x: 0, y: 0, m: 0.2 },
      gamma: { x: 0, y: 0, m: 1 },
      gain: { x: 0, y: 0, m: 1.2 },
    });
  });

  it('clears the wheels when every zone returns to identity', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', {
      clipId,
      wheels: { lift: { m: 0.2 }, gain: { m: 1.2 } },
    });

    const cleared = await executor.execute('set_clip_color_grade', {
      clipId,
      wheels: { lift: { m: 0 }, gain: { m: 1 } },
    });

    expect(cleared.success).toBe(true);
    expect(editor.getClips()[0].wheels).toBeUndefined();
    expect((cleared.data as GradeData).wheels).toBeNull();
    expect((cleared.data as GradeData).cleared).toBe(true);
  });

  it('clear: true removes the wheels with the rest of the grade', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', {
      clipId,
      brightness: 0.2,
      wheels: { gamma: { m: 1.5 } },
    });

    const result = await executor.execute('set_clip_color_grade', { clipId, clear: true });

    expect(result.success).toBe(true);
    expect((result.data as GradeData).cleared).toBe(true);
    expect(editor.getClips()[0].wheels).toBeUndefined();
    expect(editor.getClips()[0].brightness).toBeUndefined();
  });

  it('refuses malformed wheels without touching the clip', async () => {
    const { editor, executor, clipId } = harness();

    // Out-of-range pad positions are refused at the schema boundary.
    expect((await executor.execute('set_clip_color_grade', {
      clipId, wheels: { lift: { x: 1.5 } },
    })).success).toBe(false);
    // Out-of-range masters are refused at the schema boundary too.
    expect((await executor.execute('set_clip_color_grade', {
      clipId, wheels: { lift: { m: 1 } },
    })).success).toBe(false);
    // A zone with no usable fields is refused by the strict wheels parser.
    const emptyZone = await executor.execute('set_clip_color_grade', { clipId, wheels: { gain: {} } });
    expect(emptyZone.success).toBe(false);
    expect((emptyZone as { error?: string }).error).toMatch(/at least one of x, y, m/);
    // An empty wheels object is refused as "pass at least one grade field".
    expect((await executor.execute('set_clip_color_grade', { clipId, wheels: {} })).success).toBe(false);
    expect(editor.getClips()[0].wheels).toBeUndefined();
  });

  it('is one undo step, and an identical wheels patch adds no history', async () => {
    const { editor, executor, clipId } = harness();
    const wheels = { gain: { m: 1.2 } };

    await executor.execute('set_clip_color_grade', { clipId, brightness: 0.2, wheels });
    // Same patch again: reported as unchanged and no second history entry.
    const repeat = await executor.execute('set_clip_color_grade', { clipId, wheels });
    expect((repeat.data as GradeData).changed).toBe(false);

    expect(editor.undo()).toBe(true);
    expect(editor.getClips()[0].wheels).toBeUndefined();
    expect(editor.getClips()[0].brightness).toBeUndefined();
  });

  it('sets hue curves and reports them in the receipt', async () => {
    const { editor, executor, clipId } = harness();
    const hueCurves = {
      hueVsSat: [{ x: 0, y: 0.8 }, { x: 0.15, y: 0.5 }],
    };

    const result = await executor.execute('set_clip_color_grade', { clipId, hueCurves });

    expect(result.success).toBe(true);
    const data = result.data as GradeData;
    expect(data.changed).toBe(true);
    expect(data.hueCurves).toEqual({
      hueVsHue: [],
      hueVsSat: [{ x: 0, y: 0.8 }, { x: 0.15, y: 0.5 }],
      hueVsLum: [],
    });
    expect(editor.getClips()[0].hueCurves).toEqual(data.hueCurves);
    expect(data.cleared).toBe(false);
  });

  it('merges hue curves per channel, like upstream GradeState.apply', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', {
      clipId,
      hueCurves: { hueVsHue: [{ x: 0, y: 0.7 }, { x: 0.5, y: 0.4 }] },
    });

    await executor.execute('set_clip_color_grade', {
      clipId,
      hueCurves: { hueVsLum: [{ x: 0.3, y: 0.8 }, { x: 0.8, y: 0.3 }] },
    });

    expect(editor.getClips()[0].hueCurves).toEqual({
      hueVsHue: [{ x: 0, y: 0.7 }, { x: 0.5, y: 0.4 }],
      hueVsSat: [],
      hueVsLum: [{ x: 0.3, y: 0.8 }, { x: 0.8, y: 0.3 }],
    });
  });

  it('clears a channel with an empty array and the field when all channels clear', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', {
      clipId,
      hueCurves: {
        hueVsHue: [{ x: 0, y: 0.7 }, { x: 0.5, y: 0.4 }],
        hueVsSat: [{ x: 0, y: 0.8 }, { x: 0.15, y: 0.5 }],
      },
    });

    const clearedSat = await executor.execute('set_clip_color_grade', { clipId, hueCurves: { hueVsSat: [] } });
    expect(clearedSat.success).toBe(true);
    expect(editor.getClips()[0].hueCurves).toEqual({
      hueVsHue: [{ x: 0, y: 0.7 }, { x: 0.5, y: 0.4 }],
      hueVsSat: [],
      hueVsLum: [],
    });

    // Neutral points clear a channel just like an empty array.
    const clearedHue = await executor.execute('set_clip_color_grade', {
      clipId,
      hueCurves: { hueVsHue: [{ x: 0, y: 0.5 }, { x: 0.5, y: 0.5 }] },
    });
    expect(clearedHue.success).toBe(true);
    expect(editor.getClips()[0].hueCurves).toBeUndefined();
    expect((clearedHue.data as GradeData).hueCurves).toBeNull();
    expect((clearedHue.data as GradeData).cleared).toBe(true);
  });

  it('clear: true removes the hue curves with the rest of the grade', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', {
      clipId,
      brightness: 0.2,
      hueCurves: { hueVsHue: [{ x: 0, y: 0.7 }, { x: 0.5, y: 0.4 }] },
    });

    const result = await executor.execute('set_clip_color_grade', { clipId, clear: true });

    expect(result.success).toBe(true);
    expect((result.data as GradeData).cleared).toBe(true);
    expect(editor.getClips()[0].hueCurves).toBeUndefined();
    expect(editor.getClips()[0].brightness).toBeUndefined();
  });

  it('refuses malformed hue curves without touching the clip', async () => {
    const { editor, executor, clipId } = harness();

    // Out-of-range coordinates are refused at the schema boundary.
    expect((await executor.execute('set_clip_color_grade', {
      clipId, hueCurves: { hueVsHue: [{ x: 1.5, y: 0.5 }] },
    })).success).toBe(false);
    // Non-ascending x is refused by the strict hue parser.
    const descending = await executor.execute('set_clip_color_grade', {
      clipId, hueCurves: { hueVsSat: [{ x: 0.5, y: 0.5 }, { x: 0.4, y: 0.4 }] },
    });
    expect(descending.success).toBe(false);
    expect((descending as { error?: string }).error).toMatch(/ascending/);
    // More points than the cap, and an empty hueCurves object, are refused.
    expect((await executor.execute('set_clip_color_grade', {
      clipId,
      hueCurves: { hueVsLum: Array.from({ length: 17 }, (_, i) => ({ x: i / 100, y: i / 100 })) },
    })).success).toBe(false);
    expect((await executor.execute('set_clip_color_grade', { clipId, hueCurves: {} })).success).toBe(false);
    expect(editor.getClips()[0].hueCurves).toBeUndefined();
  });

  it('is one undo step, and an identical hue patch adds no history', async () => {
    const { editor, executor, clipId } = harness();
    const hueCurves = { hueVsSat: [{ x: 0, y: 0.8 }, { x: 0.15, y: 0.5 }] };

    await executor.execute('set_clip_color_grade', { clipId, brightness: 0.2, hueCurves });
    // Same patch again: reported as unchanged and no second history entry.
    const repeat = await executor.execute('set_clip_color_grade', { clipId, hueCurves });
    expect((repeat.data as GradeData).changed).toBe(false);

    expect(editor.undo()).toBe(true);
    expect(editor.getClips()[0].hueCurves).toBeUndefined();
    expect(editor.getClips()[0].brightness).toBeUndefined();
  });
});

describe('set_clip_color_grade LUT (#157 LUTs)', () => {
  const INVERT_3 = [
    'LUT_3D_SIZE 2',
    '1 1 1', '0 1 1', '1 0 1', '0 0 1',
    '1 1 0', '0 1 0', '1 0 0', '0 0 0',
  ].join('\n');

  function lutFile(name: string, text: string): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lut-exec-')), name);
    fs.writeFileSync(file, text);
    return file;
  }

  it('sets a LUT from a path and reports the reference in the receipt', async () => {
    const { editor, executor, clipId } = harness();
    const file = lutFile('invert.cube', INVERT_3);

    const result = await executor.execute('set_clip_color_grade', { clipId, lutPath: file });

    expect(result.success).toBe(true);
    const data = result.data as GradeData;
    expect(data.changed).toBe(true);
    expect(data.lut).toEqual({ path: file, intensity: 1, kind: '3d', size: 2 });
    expect(editor.getClips()[0].lut).toEqual(data.lut);
    expect(data.cleared).toBe(false);
  });

  it('stores an intensity with the path and re-blends it alone', async () => {
    const { editor, executor, clipId } = harness();
    const file = lutFile('invert.cube', INVERT_3);

    await executor.execute('set_clip_color_grade', { clipId, lutPath: file, lutIntensity: 0.5 });
    expect(editor.getClips()[0].lut?.intensity).toBe(0.5);

    const reblend = await executor.execute('set_clip_color_grade', { clipId, lutIntensity: 0.25 });
    expect(reblend.success).toBe(true);
    expect((reblend.data as GradeData).lut?.intensity).toBe(0.25);
    expect(editor.getClips()[0].lut).toEqual({ path: file, intensity: 0.25, kind: '3d', size: 2 });
  });

  it('refuses missing, invalid, and intensity-only-without-LUT calls', async () => {
    const { editor, executor, clipId } = harness();

    const missing = await executor.execute('set_clip_color_grade', {
      clipId, lutPath: path.join(os.tmpdir(), 'lut-nope', 'gone.cube'),
    });
    expect(missing.success).toBe(false);
    expect(editor.getClips()[0].lut).toBeUndefined();

    const bad = lutFile('bad.cube', 'LUT_3D_SIZE 2\n0 0 0');
    const invalid = await executor.execute('set_clip_color_grade', { clipId, lutPath: bad });
    expect(invalid.success).toBe(false);
    expect(editor.getClips()[0].lut).toBeUndefined();

    const noLut = await executor.execute('set_clip_color_grade', { clipId, lutIntensity: 0.5 });
    expect(noLut.success).toBe(false);

    const badIntensity = await executor.execute('set_clip_color_grade', {
      clipId, lutPath: lutFile('ok.cube', INVERT_3), lutIntensity: 2,
    });
    expect(badIntensity.success).toBe(false);
  });

  it('clears the LUT with an empty path, and clear: true resets it with the grade', async () => {
    const { editor, executor, clipId } = harness();
    const file = lutFile('invert.cube', INVERT_3);
    await executor.execute('set_clip_color_grade', { clipId, lutPath: file });

    const cleared = await executor.execute('set_clip_color_grade', { clipId, lutPath: '' });
    expect(cleared.success).toBe(true);
    expect((cleared.data as GradeData).lut).toBeNull();
    expect(editor.getClips()[0].lut).toBeUndefined();

    await executor.execute('set_clip_color_grade', { clipId, lutPath: file });
    await executor.execute('set_clip_color_grade', { clipId, clear: true });
    expect(editor.getClips()[0].lut).toBeUndefined();
  });

  it('is one undo step, and an identical LUT patch adds no history', async () => {
    const { editor, executor, clipId } = harness();
    const file = lutFile('invert.cube', INVERT_3);

    await executor.execute('set_clip_color_grade', { clipId, brightness: 0.2, lutPath: file, lutIntensity: 0.5 });
    // Same LUT again: reported as unchanged and no second history entry.
    const repeat = await executor.execute('set_clip_color_grade', { clipId, lutPath: file, lutIntensity: 0.5 });
    expect((repeat.data as GradeData).changed).toBe(false);

    expect(editor.undo()).toBe(true);
    expect(editor.getClips()[0].lut).toBeUndefined();
    expect(editor.getClips()[0].brightness).toBeUndefined();
  });
});

describe('set_clip_color_grade effects (#157 subgroups)', () => {
  it('sets blur, vignette, grain and glow with receipt values', async () => {
    const { editor, executor, clipId } = harness();

    const result = await executor.execute('set_clip_color_grade', {
      clipId,
      blurRadius: 8,
      vignette: { amount: -0.5 },
      grain: { amount: 0.5, size: 2 },
      glow: { intensity: 0.5, threshold: 0.4 },
    });

    expect(result.success).toBe(true);
    const data = result.data as GradeData;
    expect(data.changed).toBe(true);
    expect(data.blurRadius).toBe(8);
    expect(data.vignette).toEqual({ amount: -0.5, midpoint: 0.5, roundness: 0, feather: 0.5 });
    expect(data.grain).toEqual({ amount: 0.5, size: 2 });
    expect(data.glow).toEqual({ intensity: 0.5, radius: 20, threshold: 0.4, warmth: 0 });
    expect(editor.getClips()[0]).toMatchObject({
      blurRadius: 8,
      vignette: data.vignette,
      grain: data.grain,
      glow: data.glow,
    });
    expect(data.cleared).toBe(false);
  });

  it('merges effect components and clears a stage at identity', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', { clipId, vignette: { amount: -0.5 } });
    await executor.execute('set_clip_color_grade', { clipId, vignette: { midpoint: 0.8 } });
    expect(editor.getClips()[0].vignette).toEqual({ amount: -0.5, midpoint: 0.8, roundness: 0, feather: 0.5 });

    const cleared = await executor.execute('set_clip_color_grade', { clipId, vignette: { amount: 0 } });
    expect(cleared.success).toBe(true);
    expect((cleared.data as GradeData).vignette).toBeNull();
    expect(editor.getClips()[0].vignette).toBeUndefined();

    await executor.execute('set_clip_color_grade', { clipId, blurRadius: 8 });
    await executor.execute('set_clip_color_grade', { clipId, blurRadius: 0 });
    expect(editor.getClips()[0].blurRadius).toBeUndefined();
  });

  it('refuses malformed components and out-of-range radii', async () => {
    const { editor, executor, clipId } = harness();

    expect((await executor.execute('set_clip_color_grade', { clipId, vignette: { amount: 2 } })).success).toBe(false);
    expect((await executor.execute('set_clip_color_grade', { clipId, grain: { size: 99 } })).success).toBe(false);
    expect((await executor.execute('set_clip_color_grade', { clipId, glow: { warmth: -1 } })).success).toBe(false);
    expect((await executor.execute('set_clip_color_grade', { clipId, blurRadius: 101 })).success).toBe(false);
    expect(editor.getClips()[0].vignette).toBeUndefined();
    expect(editor.getClips()[0].blurRadius).toBeUndefined();
  });

  it('resets effects with clear: true and adds no history for identical patches', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_color_grade', {
      clipId, brightness: 0.2, blurRadius: 8, vignette: { amount: -0.5 },
    });
    const repeat = await executor.execute('set_clip_color_grade', {
      clipId, blurRadius: 8, vignette: { amount: -0.5 },
    });
    expect((repeat.data as GradeData).changed).toBe(false);

    const reset = await executor.execute('set_clip_color_grade', { clipId, clear: true });
    expect(reset.success).toBe(true);
    expect((reset.data as GradeData).cleared).toBe(true);
    const graded = editor.getClips()[0];
    expect(graded.blurRadius).toBeUndefined();
    expect(graded.vignette).toBeUndefined();
    expect(graded.brightness).toBeUndefined();
  });
});
