/**
 * set_clip_crop semantics (#568): sanitize-on-set, clear-on-zeros, and
 * non-visual refusal.
 */
import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

function harness() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'v', path: 'X:/v.mp4', filename: 'v.mp4', type: 'video',
    duration: 60, width: 1920, height: 1080, fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  const videoId = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 60 });
  return { editor, executor: new ToolExecutor(editor), videoId };
}

describe('set_clip_crop (#568)', () => {
  it('sets a sanitized crop on the clip', async () => {
    const { editor, executor, videoId } = harness();

    const result = await executor.execute('set_clip_crop', {
      clipId: videoId, left: 0.1, right: 0.2,
    });

    expect(result.success).toBe(true);
    const clip = editor.getClips().find((c) => c.id === videoId)!;
    expect(clip.crop).toEqual({ left: 0.1, right: 0.2, top: 0, bottom: 0 });
  });

  it('clears the crop when all edges are zero', async () => {
    const { editor, executor, videoId } = harness();
    await executor.execute('set_clip_crop', { clipId: videoId, left: 0.1 });

    const result = await executor.execute('set_clip_crop', {
      clipId: videoId, left: 0, right: 0, top: 0, bottom: 0,
    });

    expect(result.success).toBe(true);
    expect(editor.getClips().find((c) => c.id === videoId)!.crop).toBeUndefined();
  });

  it('refuses edges beyond the cap at the schema boundary', async () => {
    const { editor, executor, videoId } = harness();

    // Redistribution of over-consuming edge pairs lives in sanitizeCrop and
    // is unit-tested there; the tool schema simply rejects such values.
    const result = await executor.execute('set_clip_crop', {
      clipId: videoId, left: 0.9, right: 0.9,
    });

    expect(result.success).toBe(false);
    expect(editor.getClips().find((c) => c.id === videoId)!.crop).toBeUndefined();
  });

  it('refuses audio clips', async () => {
    const { editor, executor } = harness();
    editor.addMedia({
      id: 'a', path: 'X:/a.wav', filename: 'a.wav', type: 'audio',
      duration: 10, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const audioId = editor.addClip({ assetId: 'a', trackId: 'a1', startFrame: 0 });

    const result = await executor.execute('set_clip_crop', {
      clipId: audioId, left: 0.1,
    });
    expect(result.success).toBe(false);
  });
});
