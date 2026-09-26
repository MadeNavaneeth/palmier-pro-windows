/**
 * set_clip_opacity_keyframes semantics: the separate opacity automation track,
 * decoded-media eligibility, validation boundaries, receipts, and one-undo
 * behavior. Fades remain independent and are intentionally not touched here.
 */
import { describe, expect, it } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { ToolExecutor } from './executor';

function harness() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'v', path: 'X:/v.mp4', filename: 'v.mp4', type: 'video',
    duration: 120, width: 1920, height: 1080, fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  const videoId = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 90 });
  return { editor, executor: new ToolExecutor(editor), videoId };
}

interface OpacityReceipt {
  clipId: string;
  changed: boolean;
  cleared: boolean;
  keyframes: Array<{ frame: number; value: number; easing?: string }>;
}

describe('set_clip_opacity_keyframes', () => {
  it('sets, updates, and clears the separate opacity track with receipts', async () => {
    const { editor, executor, videoId } = harness();

    const set = await executor.execute('set_clip_opacity_keyframes', {
      clipId: videoId,
      points: [
        { frame: 30, value: 0.2 },
        { frame: 0, value: 0.8, easing: 'easeInOut' },
      ],
    });
    expect(set.success).toBe(true);
    expect((set.data as OpacityReceipt)).toMatchObject({
      clipId: videoId, changed: true, cleared: false,
    });
    expect(editor.getClips()[0]!.opacityTrack).toEqual([
      { frame: 0, value: 0.8, easing: 'easeInOut' },
      { frame: 30, value: 0.2 },
    ]);

    const update = await executor.execute('set_clip_opacity_keyframes', {
      clipId: videoId,
      points: [{ frame: 60, value: 1 }, { frame: 0, value: 0.1 }],
    });
    expect(update.success).toBe(true);
    expect((update.data as OpacityReceipt).changed).toBe(true);
    expect(editor.getClips()[0]!.opacityTrack).toEqual([
      { frame: 0, value: 0.1 },
      { frame: 60, value: 1 },
    ]);

    const cleared = await executor.execute('set_clip_opacity_keyframes', {
      clipId: videoId,
      points: [],
    });
    expect(cleared.success).toBe(true);
    expect(cleared.data).toMatchObject({ changed: true, cleared: true, keyframes: [] });
    expect(editor.getClips()[0]!.opacityTrack).toBeUndefined();

    const historyAfterClear = editor.getLastCommandDescription();
    const projectAfterClear = editor.getProject();
    const clearAgain = await executor.execute('set_clip_opacity_keyframes', { clipId: videoId, points: [] });
    expect(clearAgain.data).toMatchObject({ changed: false, cleared: false, keyframes: [] });
    expect(editor.getLastCommandDescription()).toBe(historyAfterClear);
    expect(editor.getProject()).toBe(projectAfterClear);
  });

  it('returns a no-change receipt without adding history for a repeated track', async () => {
    const { editor, executor, videoId } = harness();
    const points = [{ frame: 0, value: 0.2 }, { frame: 60, value: 0.8 }];
    await executor.execute('set_clip_opacity_keyframes', { clipId: videoId, points });
    const projectAfterSet = editor.getProject();
    const historyAfterSet = editor.getLastCommandDescription();

    const result = await executor.execute('set_clip_opacity_keyframes', { clipId: videoId, points });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ changed: false, cleared: false, keyframes: points });
    expect(editor.getProject()).toBe(projectAfterSet);
    expect(editor.getLastCommandDescription()).toBe(historyAfterSet);
  });

  it('uses exactly one undo entry for setting the track', async () => {
    const { editor, executor, videoId } = harness();
    const historyBefore = editor.getLastCommandDescription();

    await executor.execute('set_clip_opacity_keyframes', {
      clipId: videoId,
      points: [{ frame: 0, value: 0 }, { frame: 60, value: 1 }],
    });
    expect(editor.getLastCommandDescription()).not.toBe(historyBefore);

    expect(editor.undo()).toBe(true);
    expect(editor.getClips()[0]!.opacityTrack).toBeUndefined();
    expect(editor.getLastCommandDescription()).toBe(historyBefore);
  });

  it('refuses hostile or short tracks before mutation', async () => {
    const { editor, executor, videoId } = harness();
    const projectBefore = editor.getProject();
    const historyBefore = editor.getLastCommandDescription();
    const invalidRequests = [
      { clipId: videoId, points: [{ frame: 0, value: 0.5 }] },
      { clipId: videoId, points: [{ frame: 0, value: -0.1 }, { frame: 30, value: 0.8 }] },
      { clipId: videoId, points: [{ frame: 0, value: Number.NaN }, { frame: 30, value: 0.8 }] },
      { clipId: videoId, points: 'not-an-array' },
      {
        clipId: videoId,
        points: [{ frame: 0, value: 0.1, easing: 'unsupported' }, { frame: 30, value: 0.8 }],
      },
    ];

    for (const request of invalidRequests) {
      const result = await executor.execute('set_clip_opacity_keyframes', request);
      expect(result.success).toBe(false);
      expect(editor.getProject()).toBe(projectBefore);
      expect(editor.getLastCommandDescription()).toBe(historyBefore);
    }
    expect(editor.getClips()[0]!.opacityTrack).toBeUndefined();
  });

  it('uses the Inspector decoded-media eligibility rule', async () => {
    const { editor, executor, videoId } = harness();
    editor.addMedia({
      id: 'a', path: 'X:/a.wav', filename: 'a.wav', type: 'audio',
      duration: 90, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const audioId = editor.addClip({ assetId: 'a', trackId: 'a1', startFrame: 0, durationFrames: 90 });
    const titleId = editor.addTitleClip({ trackId: 'v1', text: 'Title', startFrame: 120, durationFrames: 30 });
    const shapeId = editor.addShapeClip({ trackId: 'v1', shapeKind: 'rect', startFrame: 180, durationFrames: 30 });
    const projectBefore = editor.getProject();
    const historyBefore = editor.getLastCommandDescription();

    for (const clipId of [audioId, titleId, shapeId]) {
      const result = await executor.execute('set_clip_opacity_keyframes', {
        clipId,
        points: [{ frame: 0, value: 0.2 }, { frame: 30, value: 0.8 }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/video, image, and generated/i);
      expect(editor.getProject()).toBe(projectBefore);
      expect(editor.getLastCommandDescription()).toBe(historyBefore);
    }

    // Generated media follows the same decoded-media path and is accepted.
    const generatedId = editor.addClip({
      assetId: 'v', trackId: 'v1', type: 'generated', startFrame: 240, durationFrames: 30,
    });
    const generated = await executor.execute('set_clip_opacity_keyframes', {
      clipId: generatedId,
      points: [{ frame: 240, value: 0.2 }, { frame: 270, value: 0.8 }],
    });
    expect(generated.success).toBe(true);
    expect((generated.data as OpacityReceipt).changed).toBe(true);
    expect(editor.getClips().find((clip) => clip.id === videoId)!.opacityTrack).toBeUndefined();
    expect(editor.getClips().find((clip) => clip.id === generatedId)!.opacityTrack).toHaveLength(2);
  });
});
