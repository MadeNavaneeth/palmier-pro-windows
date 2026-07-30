import { describe, expect, it } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { ToolExecutor } from './executor';

describe('ripple delete tool', () => {
  it('uses the shared atomic controller command and remains undoable', async () => {
    const controller = new EditorController();
    controller.addMedia({
      id: 'asset',
      path: 'C:\\media\\clip.mp4',
      filename: 'clip.mp4',
      type: 'video',
      duration: 30,
      fileSize: 100,
      addedAt: '2026-07-25T00:00:00.000Z',
    });
    const first = controller.addClip({
      assetId: 'asset',
      trackId: 'v1',
      startFrame: 0,
      durationFrames: 30,
    });
    controller.addClip({
      assetId: 'asset',
      trackId: 'v1',
      startFrame: 30,
      durationFrames: 30,
    });
    const executor = new ToolExecutor(controller);

    const result = await executor.execute('ripple_delete_clips', { clipIds: [first] });

    expect(result.success).toBe(true);
    expect(controller.getClips()).toHaveLength(1);
    expect(controller.getClips()[0].startFrame).toBe(0);

    expect((await executor.execute('undo', {})).success).toBe(true);
    expect(controller.getClips()).toHaveLength(2);
    expect(controller.getClips()[1].startFrame).toBe(30);
  });

  it('rejects an empty clip list before mutation', async () => {
    const controller = new EditorController();
    const result = await new ToolExecutor(controller).execute('ripple_delete_clips', {
      clipIds: [],
    });

    expect(result.success).toBe(false);
    expect(controller.getClips()).toHaveLength(0);
  });

  it('exposes ripple trim and gap delete through the same controller path', async () => {
    const controller = new EditorController();
    controller.addMedia({
      id: 'asset',
      path: 'C:\\media\\clip.mp4',
      filename: 'clip.mp4',
      type: 'video',
      duration: 200,
      fileSize: 100,
      addedAt: '2026-07-25T00:00:00.000Z',
    });
    const first = controller.addClip({
      assetId: 'asset',
      trackId: 'v1',
      startFrame: 0,
      durationFrames: 50,
    });
    controller.addClip({
      assetId: 'asset',
      trackId: 'v1',
      startFrame: 100,
      durationFrames: 50,
    });
    const executor = new ToolExecutor(controller);

    const trim = await executor.execute('ripple_trim_clip', {
      clipId: first,
      edge: 'right',
      deltaFrames: 10,
    });
    expect(trim.success).toBe(true);
    expect(controller.getClips()[1].startFrame).toBe(110);

    const gap = await executor.execute('ripple_delete_gap', {
      trackId: 'v1',
      startFrame: 60,
      endFrame: 110,
    });
    expect(gap.success).toBe(true);
    expect(controller.getClips()[1].startFrame).toBe(60);
  });

  it('cuts multiple timeline ranges through one Agent transaction', async () => {
    const controller = new EditorController();
    controller.addMedia({
      id: 'asset',
      path: 'C:\\media\\clip.mp4',
      filename: 'clip.mp4',
      type: 'video',
      duration: 200,
      fileSize: 100,
      addedAt: '2026-07-25T00:00:00.000Z',
    });
    controller.addClip({
      assetId: 'asset',
      trackId: 'v1',
      startFrame: 0,
      durationFrames: 100,
    });
    const executor = new ToolExecutor(controller);

    const result = await executor.execute('ripple_delete_ranges', {
      trackId: 'v1',
      ranges: [[20, 30], [60, 70]],
    });

    expect(result.success).toBe(true);
    expect(controller.getClips().map((item) => [
      item.startFrame,
      item.durationFrames,
      item.inPoint,
    ])).toEqual([
      [0, 20, 0],
      [20, 30, 30],
      [50, 30, 70],
    ]);
    expect((await executor.execute('undo', {})).success).toBe(true);
    expect(controller.getClips()).toHaveLength(1);
  });
});
