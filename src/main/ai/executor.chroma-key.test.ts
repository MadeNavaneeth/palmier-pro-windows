/**
 * set_clip_chroma_key semantics (upstream issue #97): activation, partial
 * updates, clear-on-zero-tolerance, no-op receipts, and non-visual refusal.
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

describe('set_clip_chroma_key (#97)', () => {
  it('activates a key with defaulted softness/spill on first set', async () => {
    const { editor, executor, videoId } = harness();

    const result = await executor.execute('set_clip_chroma_key', {
      clipId: videoId, keyColor: '#00ff00', tolerance: 0.2,
    });

    expect(result.success).toBe(true);
    const clip = editor.getClips().find((c) => c.id === videoId)!;
    expect(clip.chromaKey).toEqual({ keyColor: '#00ff00', tolerance: 0.2, softness: 0.05, spill: 0.5 });
  });

  it('applies a partial update without disturbing untouched fields', async () => {
    const { editor, executor, videoId } = harness();
    await executor.execute('set_clip_chroma_key', { clipId: videoId, keyColor: '#00ff00', tolerance: 0.2 });

    const result = await executor.execute('set_clip_chroma_key', { clipId: videoId, spill: 0.9 });

    expect(result.success).toBe(true);
    const clip = editor.getClips().find((c) => c.id === videoId)!;
    expect(clip.chromaKey).toEqual({ keyColor: '#00ff00', tolerance: 0.2, softness: 0.05, spill: 0.9 });
  });

  it('clears the key when tolerance is set to 0', async () => {
    const { editor, executor, videoId } = harness();
    await executor.execute('set_clip_chroma_key', { clipId: videoId, keyColor: '#00ff00', tolerance: 0.2 });

    const result = await executor.execute('set_clip_chroma_key', { clipId: videoId, tolerance: 0 });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ changed: true, cleared: true, chromaKey: null });
    expect(editor.getClips().find((c) => c.id === videoId)!.chromaKey).toBeUndefined();
  });

  it('reports a no-op receipt for a repeated identical call and adds no undo entry', async () => {
    const { editor, executor, videoId } = harness();
    await executor.execute('set_clip_chroma_key', { clipId: videoId, keyColor: '#00ff00', tolerance: 0.2 });
    const undoDepthBefore = editor.canUndo();

    const result = await executor.execute('set_clip_chroma_key', { clipId: videoId, tolerance: 0.2 });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ changed: false });
    expect(editor.canUndo()).toBe(undoDepthBefore);
  });

  it('refuses a call with no fields at the schema boundary', async () => {
    const { executor, videoId } = harness();

    const result = await executor.execute('set_clip_chroma_key', { clipId: videoId });

    expect(result.success).toBe(false);
  });

  it('refuses an unknown clip id', async () => {
    const { executor } = harness();

    const result = await executor.execute('set_clip_chroma_key', { clipId: 'missing', tolerance: 0.2 });

    expect(result.success).toBe(false);
  });

  it('refuses audio clips', async () => {
    const { editor, executor } = harness();
    editor.addMedia({
      id: 'a', path: 'X:/a.wav', filename: 'a.wav', type: 'audio',
      duration: 10, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const audioId = editor.addClip({ assetId: 'a', trackId: 'a1', startFrame: 0 });

    const result = await executor.execute('set_clip_chroma_key', { clipId: audioId, tolerance: 0.2 });

    expect(result.success).toBe(false);
  });

  it('refuses an invalid keyColor at the schema boundary', async () => {
    const { executor, videoId } = harness();

    const result = await executor.execute('set_clip_chroma_key', { clipId: videoId, keyColor: 'green' });

    expect(result.success).toBe(false);
  });
});
