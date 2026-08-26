/**
 * set_clip_motion semantics (keyframes v1): sanitize-on-set, clear via empty
 * points, per-axis independence, and non-visual refusal.
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
  const videoId = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 90 });
  return { editor, executor: new ToolExecutor(editor), videoId };
}

describe('set_clip_motion (keyframes v1)', () => {
  it('sets a sanitized track per axis without touching the other', async () => {
    const { editor, executor, videoId } = harness();

    await executor.execute('set_clip_motion', {
      clipId: videoId, axis: 'x',
      points: [{ frame: 30, value: 400 }, { frame: 10, value: 100 }, { frame: 30, value: 350 }],
    });

    const clip = editor.getClips().find((c) => c.id === videoId)!;
    await executor.execute('set_clip_motion', { clipId: videoId, axis: 'x', points: [{ frame: 30, value: 400 }, { frame: 10, value: 100 }, { frame: 30, value: 350 }] });
    expect(clip.motionX).toEqual([
      { frame: 10, value: 100 },
      { frame: 30, value: 350 },
    ]);
    expect(clip.motionY).toBeUndefined();
  });

  it('clears an axis with an empty points array', async () => {
    const { editor, executor, videoId } = harness();
    await executor.execute('set_clip_motion', {
      clipId: videoId, axis: 'x',
      points: [{ frame: 0, value: 1 }, { frame: 10, value: 2 }],
    });

    const result = await executor.execute('set_clip_motion', {
      clipId: videoId, axis: 'x', points: [],
    });

    expect(result.success).toBe(true);
    expect(editor.getClips().find((c) => c.id === videoId)!.motionX).toBeUndefined();
  });

  it('refuses single-point and non-visual clips', async () => {
    const { editor, executor, videoId } = harness();
    editor.addMedia({
      id: 'a', path: 'X:/a.wav', filename: 'a.wav', type: 'audio',
      duration: 10, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const audioId = editor.addClip({ assetId: 'a', trackId: 'a1', startFrame: 0 });

    expect((await executor.execute('set_clip_motion', {
      clipId: videoId, axis: 'x', points: [{ frame: 0, value: 5 }],
    })).success).toBe(false);
    expect((await executor.execute('set_clip_motion', {
      clipId: audioId, axis: 'y', points: [{ frame: 0, value: 1 }, { frame: 9, value: 2 }],
    })).success).toBe(false);
  });
});



