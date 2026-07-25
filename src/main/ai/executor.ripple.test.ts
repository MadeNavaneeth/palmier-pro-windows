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
});
