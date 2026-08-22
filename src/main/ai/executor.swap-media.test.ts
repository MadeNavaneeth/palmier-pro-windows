/**
 * Regression coverage for the swap_clip_media agent tool (upstream PR #500):
 * success receipt shape and refusal messages surfaced to the model.
 */

import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

function executorWithSources() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'video-a',
    path: '/test/a.mp4',
    filename: 'a.mp4',
    type: 'video',
    duration: 300,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  editor.addMedia({
    id: 'video-b',
    path: '/test/b.mp4',
    filename: 'b.mp4',
    type: 'video',
    duration: 900,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  const clipId = editor.addClip({ assetId: 'video-a', trackId: 'v1', startFrame: 0 });
  return { editor, executor: new ToolExecutor(editor), clipId };
}

describe('swap_clip_media tool (#500)', () => {
  it('swaps and reports old/new sources with affected ids', async () => {
    const { executor, clipId } = executorWithSources();
    const result = await executor.execute('swap_clip_media', {
      clipId,
      assetId: 'video-b',
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      changedClipIds: [clipId],
      oldAssetId: 'video-a',
      newAssetId: 'video-b',
    });
  });

  it('surfaces refusals verbatim', async () => {
    const { executor, clipId } = executorWithSources();
    const missing = await executor.execute('swap_clip_media', {
      clipId,
      assetId: 'ghost',
    });
    expect(missing.success).toBe(false);
    expect((missing as { error?: string }).error).toMatch(/no media asset/i);

    const unknown = await executor.execute('swap_clip_media', {
      clipId: 'ghost',
      assetId: 'video-b',
    });
    expect(unknown.success).toBe(false);
    expect((unknown as { error?: string }).error).toMatch(/clip not found/i);
  });

  it('leaves the source untouched on a refused swap', async () => {
    const { editor, executor, clipId } = executorWithSources();
    await executor.execute('swap_clip_media', { clipId, assetId: 'ghost' });
    expect(editor.getClips().find((c) => c.id === clipId)?.assetId).toBe('video-a');
  });
});
