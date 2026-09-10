/**
 * Regression coverage for the set_clip_eq agent tool (upstream #158):
 * partial band patches, default-clears, clear-all, audio-only refusal, and
 * one-undo-step semantics.
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

interface EqData {
  changed?: boolean;
  lowDb?: number;
  midDb?: number;
  highDb?: number;
  cleared?: boolean;
}

describe('set_clip_eq (#158)', () => {
  it('sets bands and reports the effective values', async () => {
    const { editor, executor, clipId } = harness();

    const result = await executor.execute('set_clip_eq', {
      clipId,
      lowDb: 6,
      highDb: -3,
    });

    expect(result.success).toBe(true);
    const data = result.data as EqData;
    expect(data.changed).toBe(true);
    expect(data.lowDb).toBe(6);
    expect(data.highDb).toBe(-3);
    expect(data.cleared).toBe(false);
    expect(editor.getClips().find((c) => c.id === clipId)).toMatchObject({ eqLowDb: 6, eqHighDb: -3 });
  });

  it('leaves omitted bands untouched', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_eq', { clipId, lowDb: 4 });

    await executor.execute('set_clip_eq', { clipId, midDb: -2 });

    expect(editor.getClips().find((c) => c.id === clipId))
      .toMatchObject({ eqLowDb: 4, eqMidDb: -2 });
  });

  it('clears one band by passing 0', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_eq', { clipId, lowDb: 5, midDb: 5 });

    await executor.execute('set_clip_eq', { clipId, midDb: 0 });

    const clip = editor.getClips().find((c) => c.id === clipId)!;
    expect(clip.eqLowDb).toBe(5);
    expect(clip.eqMidDb).toBeUndefined();
  });

  it('clear resets every band in one step', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_eq', { clipId, lowDb: 5, midDb: -5, highDb: 10 });

    const result = await executor.execute('set_clip_eq', { clipId, clear: true });

    expect((result.data as EqData).cleared).toBe(true);
    const clip = editor.getClips().find((c) => c.id === clipId)!;
    expect(clip.eqLowDb).toBeUndefined();
    expect(clip.eqMidDb).toBeUndefined();
    expect(clip.eqHighDb).toBeUndefined();
  });

  it('refuses video clips and unknown ids, and bounds values at the schema', async () => {
    const { executor, clipId, videoId } = harness();

    const video = await executor.execute('set_clip_eq', { clipId: videoId, lowDb: 3 });
    expect(video.success).toBe(false);
    expect((video as { error?: string }).error).toMatch(/audio clips/i);

    const missing = await executor.execute('set_clip_eq', { clipId: 'ghost', lowDb: 3 });
    expect(missing.success).toBe(false);

    const over = await executor.execute('set_clip_eq', { clipId, lowDb: 40 });
    expect(over.success).toBe(false);

    const empty = await executor.execute('set_clip_eq', { clipId });
    expect(empty.success).toBe(false);
  });

  it('is one undo step', async () => {
    const { editor, executor, clipId } = harness();
    await executor.execute('set_clip_eq', { clipId, lowDb: 6, highDb: 6 });

    expect(editor.undo()).toBe(true);

    const clip = editor.getClips().find((c) => c.id === clipId)!;
    expect(clip.eqLowDb).toBeUndefined();
    expect(clip.eqHighDb).toBeUndefined();
  });
});
