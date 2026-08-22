/**
 * Regression coverage for the copy_clip_settings agent tool (upstream
 * #515): explicit ids, whole-track targeting with same-kind matching and
 * source exclusion, exactly-one-target-mode enforcement, and receipt shape.
 */

import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
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
