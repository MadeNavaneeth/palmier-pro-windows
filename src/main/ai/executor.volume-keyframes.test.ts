/**
 * set_clip_volume_keyframes semantics (upstream #535/#539-#541 audio slice):
 * activation, re-set, clear-on-empty-array, no-op/refusal boundaries.
 */
import { describe, it, expect } from 'vitest';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

function harness() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'a', path: 'X:/a.wav', filename: 'a.wav', type: 'audio',
    duration: 90, fileSize: 1, addedAt: new Date().toISOString(),
  });
  const audioId = editor.addClip({ assetId: 'a', trackId: 'a1', startFrame: 0, durationFrames: 90 });
  return { editor, executor: new ToolExecutor(editor), audioId };
}

describe('set_clip_volume_keyframes (#535/#539-#541)', () => {
  it('activates a track with at least two keyframes', async () => {
    const { editor, executor, audioId } = harness();

    const result = await executor.execute('set_clip_volume_keyframes', {
      clipId: audioId,
      points: [{ frame: 0, value: 0 }, { frame: 30, value: -60 }],
    });

    expect(result.success).toBe(true);
    const clip = editor.getClips().find((c) => c.id === audioId)!;
    expect(clip.volumeDb).toEqual([{ frame: 0, value: 0 }, { frame: 30, value: -60 }]);
  });

  it('clamps an out-of-range dB value at the schema boundary', async () => {
    const { executor, audioId } = harness();

    const result = await executor.execute('set_clip_volume_keyframes', {
      clipId: audioId,
      points: [{ frame: 0, value: 0 }, { frame: 30, value: 15.01 }],
    });

    expect(result.success).toBe(false);
  });

  it('replaces the existing track on a second call', async () => {
    const { editor, executor, audioId } = harness();
    await executor.execute('set_clip_volume_keyframes', {
      clipId: audioId,
      points: [{ frame: 0, value: 0 }, { frame: 30, value: -60 }],
    });

    const result = await executor.execute('set_clip_volume_keyframes', {
      clipId: audioId,
      points: [{ frame: 0, value: -6 }, { frame: 60, value: -12 }],
    });

    expect(result.success).toBe(true);
    const clip = editor.getClips().find((c) => c.id === audioId)!;
    expect(clip.volumeDb).toEqual([{ frame: 0, value: -6 }, { frame: 60, value: -12 }]);
  });

  it('clears the track with an empty points array and restores static control', async () => {
    const { editor, executor, audioId } = harness();
    await executor.execute('set_clip_volume_keyframes', {
      clipId: audioId,
      points: [{ frame: 0, value: 0 }, { frame: 30, value: -60 }],
    });

    const result = await executor.execute('set_clip_volume_keyframes', { clipId: audioId, points: [] });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ cleared: true });
    expect(editor.getClips().find((c) => c.id === audioId)!.volumeDb).toBeUndefined();
  });

  it('refuses a single-keyframe request', async () => {
    const { executor, audioId } = harness();

    const result = await executor.execute('set_clip_volume_keyframes', {
      clipId: audioId,
      points: [{ frame: 0, value: -6 }],
    });

    expect(result.success).toBe(false);
  });

  it('refuses an unknown clip id', async () => {
    const { executor } = harness();

    const result = await executor.execute('set_clip_volume_keyframes', {
      clipId: 'missing',
      points: [{ frame: 0, value: 0 }, { frame: 30, value: -6 }],
    });

    expect(result.success).toBe(false);
  });

  it('refuses non-audio clips', async () => {
    const { editor, executor } = harness();
    editor.addMedia({
      id: 'v', path: 'X:/v.mp4', filename: 'v.mp4', type: 'video',
      duration: 90, width: 1920, height: 1080, fileSize: 1,
      addedAt: new Date().toISOString(),
    });
    const videoId = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 90 });

    const result = await executor.execute('set_clip_volume_keyframes', {
      clipId: videoId,
      points: [{ frame: 0, value: 0 }, { frame: 30, value: -6 }],
    });

    expect(result.success).toBe(false);
  });

  it('undoes a keyframe activation as one step', async () => {
    const { editor, executor, audioId } = harness();
    await executor.execute('set_clip_volume_keyframes', {
      clipId: audioId,
      points: [{ frame: 0, value: 0 }, { frame: 30, value: -60 }],
    });

    editor.undo();

    expect(editor.getClips().find((c) => c.id === audioId)!.volumeDb).toBeUndefined();
  });
});
