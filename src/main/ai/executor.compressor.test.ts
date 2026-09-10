/**
 * Regression coverage for the set_clip_compressor agent tool (upstream #158):
 * arming with defaults, partial patches, ratio-1/clear removal, audio-only
 * refusal, schema bounds, and one-undo-step semantics.
 */

import { describe, expect, it } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { ToolExecutor } from './executor';

function harness() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'a', path: 'X:/a.wav', filename: 'a.wav', type: 'audio',
    duration: 10, fileSize: 1, addedAt: new Date().toISOString(),
  });
  editor.addMedia({
    id: 'v', path: 'X:/v.mp4', filename: 'v.mp4', type: 'video',
    duration: 10, fileSize: 1, addedAt: new Date().toISOString(),
  });
  const clipId = editor.addClip({ assetId: 'a', trackId: 'a1', startFrame: 0, durationFrames: 60 });
  const videoId = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 60 });
  return { editor, executor: new ToolExecutor(editor), clipId, videoId };
}

interface CompressorData {
  changed?: boolean;
  compressor?: { thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; makeupDb: number } | null;
  cleared?: boolean;
}

describe('set_clip_compressor (#158)', () => {
  it('arms with defaults when only a threshold is given', async () => {
    const { editor, executor, clipId } = harness();

    const result = await executor.execute('set_clip_compressor', { clipId, thresholdDb: -30 });

    expect(result.success).toBe(true);
    const data = result.data as CompressorData;
    expect(data.changed).toBe(true);
    expect(data.compressor).toMatchObject({ thresholdDb: -30, ratio: 3, makeupDb: 0 });
    expect(editor.getClips().find((c) => c.id === clipId)?.compressor).toBeDefined();
  });

  it('patches one field and keeps the rest', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_compressor', { clipId, thresholdDb: -30, ratio: 4 });

    await executor.execute('set_clip_compressor', { clipId, makeupDb: 6 });

    expect(editor.getClips().find((c) => c.id === clipId)?.compressor).toMatchObject({
      thresholdDb: -30,
      ratio: 4,
      makeupDb: 6,
    });
  });

  it('ratio 1 removes the compressor', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_compressor', { clipId, thresholdDb: -20 });

    const result = await executor.execute('set_clip_compressor', { clipId, ratio: 1 });

    expect((result.data as CompressorData).cleared).toBe(true);
    expect(editor.getClips().find((c) => c.id === clipId)?.compressor).toBeUndefined();
  });

  it('clear removes the compressor in one step', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_compressor', { clipId, thresholdDb: -20, ratio: 6 });

    const result = await executor.execute('set_clip_compressor', { clipId, clear: true });

    expect(result.success).toBe(true);
    expect((result.data as CompressorData).compressor).toBeNull();
    expect(editor.getClips().find((c) => c.id === clipId)?.compressor).toBeUndefined();
  });

  it('refuses video clips and unknown ids, and bounds values at the schema', async () => {
    const { executor, clipId, videoId } = harness();

    const video = await executor.execute('set_clip_compressor', { clipId: videoId, ratio: 4 });
    expect(video.success).toBe(false);
    expect((video as { error?: string }).error).toMatch(/audio clips/i);

    const missing = await executor.execute('set_clip_compressor', { clipId: 'ghost', ratio: 4 });
    expect(missing.success).toBe(false);

    const over = await executor.execute('set_clip_compressor', { clipId, ratio: 40 });
    expect(over.success).toBe(false);

    const empty = await executor.execute('set_clip_compressor', { clipId });
    expect(empty.success).toBe(false);
  });

  it('is one undo step', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_compressor', { clipId, thresholdDb: -20, ratio: 5 });

    expect(editor.undo()).toBe(true);

    expect(editor.getClips().find((c) => c.id === clipId)?.compressor).toBeUndefined();
  });
});
