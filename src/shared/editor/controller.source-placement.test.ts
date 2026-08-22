/**
 * Regression coverage for source-window placement — the three-point
 * editing primitive (roadmap R1; upstream resolvePlacement's `source`).
 *
 * source [startSec, endSec] is mutually exclusive with durationFrames, is
 * clamped to the asset, and bakes the clip's In/Out so export and preview
 * address the same span through the shared #68 mapping.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function controllerWithMedia() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'asset-video',
    path: '/test/v.mp4',
    filename: 'v.mp4',
    type: 'video',
    duration: 900, // 30s at 30fps
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  return ctrl;
}

describe('source-window placement (three-point editing)', () => {
  it('bakes the source window into In/Out with timeline duration preserved', () => {
    const ctrl = controllerWithMedia();
    const { clipIds } = ctrl.placeClipWithMode({
      assetId: 'asset-video',
      trackId: 'v1',
      mode: 'overwrite',
      startFrame: 45,
      source: [2, 5],
    })!;

    const clip = ctrl.getClips().find((c) => c.id === clipIds[0])!;
    expect(clip.inPoint).toBe(60); // 2s at 30fps
    expect(clip.durationFrames).toBe(90); // [2s, 5s) = 3s
    expect(clip.outPoint).toBe(150);
    expect(clip.startFrame).toBe(45);
  });

  it('insert mode pushes later clips by only the trimmed span', () => {
    const ctrl = controllerWithMedia();
    ctrl.addClip({
      assetId: 'asset-video', trackId: 'v1', startFrame: 200, durationFrames: 50,
    });

    ctrl.placeClipWithMode({
      assetId: 'asset-video', trackId: 'v1', mode: 'insert',
      startFrame: 100, source: [10, 12],
    });
    const follower = ctrl.getClips().sort((a, b) => a.startFrame - b.startFrame)[1];
    expect(follower.startFrame).toBe(260); // pushed by 60 frames (2s)
  });

  it('clamps an end past the asset and refuses a window past its start', () => {
    const ctrl = controllerWithMedia();
    const ok = ctrl.placeClipWithMode({
      assetId: 'asset-video', trackId: 'v1', mode: 'overwrite',
      startFrame: 0, source: [29, 999],
    })!;
    const clip = ctrl.getClips().find((c) => c.id === ok.clipIds[0])!;
    expect(clip.durationFrames).toBe(30); // clamped to the last second

    expect(() => ctrl.placeClipWithMode({
      assetId: 'asset-video', trackId: 'v1', mode: 'overwrite', source: [31, 33],
    })).toThrow(/past the end/i);
  });

  it('refuses source together with durationFrames and inverted windows', () => {
    const ctrl = controllerWithMedia();
    expect(() => ctrl.placeClipWithMode({
      assetId: 'asset-video', trackId: 'v1', source: [0, 1], durationFrames: 10,
    })).toThrow(/not both/i);
    expect(() => ctrl.placeClipWithMode({
      assetId: 'asset-video', trackId: 'v1', source: [5, 5],
    })).toThrow(/start < end/i);
  });

  it('agent add_clip accepts source and reports placed ids', async () => {
    const ctrl = controllerWithMedia();
    const { ToolExecutor } = await import('../../main/ai/executor');
    const executor = new ToolExecutor(ctrl);
    const result = await executor.execute('add_clip', {
      assetId: 'asset-video',
      trackId: 'v1',
      startFrame: 10,
      source: [1, 4],
    });
    expect(result.success).toBe(true);
    const clipId = (result.data as { clipIds: string[] }).clipIds[0];
    const clip = ctrl.getClips().find((c) => c.id === clipId)!;
    expect(clip.inPoint).toBe(30);
    expect(clip.durationFrames).toBe(90);
  });
});
