/**
 * `add_clip` track targeting (#302, upstream PR #307's mis-targeting class).
 *
 * The controller refuses a placement onto a track that does not exist; this
 * covers the half the model sees. A `success: true` with a clip id would have it
 * building on an edit that never happened, and a bare refusal would have it
 * retrying the same invented id, so the error names the tracks that do exist.
 */
import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

function harness() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'asset',
    path: 'C:\\media\\take.mp4',
    filename: 'take.mp4',
    type: 'video',
    duration: 300,
    fileSize: 1000,
    addedAt: '2026-07-29T00:00:00.000Z',
  });
  return { editor, executor: new ToolExecutor(editor) };
}

describe('add_clip track targeting', () => {
  it('refuses an unknown track and names the ones that exist', async () => {
    const { executor, editor } = harness();

    const result = await executor.execute('add_clip', {
      assetId: 'asset',
      trackId: 'v9',
      startFrame: 0,
      durationFrames: 60,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('v9');
    for (const track of editor.getTracks()) {
      expect(result.error).toContain(track.id);
    }
    expect(editor.getClips()).toHaveLength(0);
  });

  it('still places onto a real track', async () => {
    const { executor, editor } = harness();

    const result = await executor.execute('add_clip', {
      assetId: 'asset',
      trackId: 'v1',
      startFrame: 0,
      durationFrames: 60,
    });

    expect(result.success).toBe(true);
    expect((result.data as { clipId: string }).clipId).not.toBe('');
    expect(editor.getClips()).toHaveLength(1);
  });

  it('places onto a track the agent just added', async () => {
    const { executor, editor } = harness();

    const added = await executor.execute('add_track', { type: 'video', name: 'Video 2' });
    expect(added.success).toBe(true);
    const trackId = (added.data as { trackId: string }).trackId;

    const result = await executor.execute('add_clip', {
      assetId: 'asset',
      trackId,
      startFrame: 0,
      durationFrames: 60,
    });

    expect(result.success).toBe(true);
    expect(editor.getClips()[0].trackId).toBe(trackId);
  });
});
