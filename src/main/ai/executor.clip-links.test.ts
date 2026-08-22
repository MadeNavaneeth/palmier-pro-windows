/**
 * Regression coverage for the manage_clip_links agent tool (upstream PR
 * #462): success receipts, upstream's exact refusal messages surfaced to the
 * model, and schema-level argument requirements.
 */

import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

function executorWithMaterial() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'asset-video',
    path: '/test/video.mp4',
    filename: 'video.mp4',
    type: 'video',
    duration: 10_000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  editor.addMedia({
    id: 'asset-music',
    path: '/test/music.mp3',
    filename: 'music.mp3',
    type: 'audio',
    duration: 10_000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  const videoId = editor.addClip({ assetId: 'asset-video', trackId: 'v1', startFrame: 0 });
  const audioId = editor.addClip({ assetId: 'asset-music', trackId: 'a1', startFrame: 0 });
  return { editor, executor: new ToolExecutor(editor), videoId, audioId };
}

describe('manage_clip_links tool (#462)', () => {
  it('links and reports the touched clip ids', async () => {
    const { executor, videoId, audioId } = executorWithMaterial();
    const result = await executor.execute('manage_clip_links', {
      action: 'link',
      clipIds: [videoId, audioId],
    });
    expect(result.success).toBe(true);
    expect((result.data as { linkedClipIds: string[] }).linkedClipIds.sort())
      .toEqual([audioId, videoId].sort());
  });

  it('surfaces the domain refusal message verbatim', async () => {
    const { executor, videoId } = executorWithMaterial();
    const result = await executor.execute('manage_clip_links', {
      action: 'link',
      clipIds: [videoId],
    });
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(
      /at least two clips of different media types/i,
    );
  });

  it('refuses unlinking when nothing is linked', async () => {
    const { executor, videoId } = executorWithMaterial();
    const result = await executor.execute('manage_clip_links', {
      action: 'unlink',
      clipIds: [videoId],
    });
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/none of the provided clips is linked/i);
  });

  it('unlinks after linking', async () => {
    const { editor, executor, videoId, audioId } = executorWithMaterial();
    await executor.execute('manage_clip_links', { action: 'link', clipIds: [videoId, audioId] });

    const result = await executor.execute('manage_clip_links', {
      action: 'unlink',
      clipIds: [videoId],
    });
    expect(result.success).toBe(true);
    expect(editor.getClips().every((clip) => clip.linkGroupId === undefined)).toBe(true);
  });

  it('requires a non-empty clip list', async () => {
    const { executor } = executorWithMaterial();
    const result = await executor.execute('manage_clip_links', {
      action: 'link',
      clipIds: [],
    });
    expect(result.success).toBe(false);
  });
});
