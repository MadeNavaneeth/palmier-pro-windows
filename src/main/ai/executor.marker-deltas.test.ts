/**
 * Regression coverage for marker deltas in agent ripple receipts (upstream
 * PR #560, agent half): ripple tool results carry shifted markers and removed
 * marker ids, and trim_clips reports the net delta of the whole batch, so the
 * model patches review notes without re-reading the timeline.
 */

import { describe, expect, it } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { ToolExecutor } from './executor';

function controllerWithAsset() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'asset',
    path: 'C:\\media\\clip.mp4',
    filename: 'clip.mp4',
    type: 'video',
    duration: 5000,
    fileSize: 100,
    addedAt: '2026-09-01T00:00:00.000Z',
  });
  return ctrl;
}

interface MarkerDeltaData {
  shiftedMarkers?: Array<{ id: string; startFrame: number; durationFrames: number }>;
  removedMarkerIds?: string[];
}

describe('marker deltas in agent receipts (#560)', () => {
  it('ripple_delete_clips reports the moved marker', async () => {
    const ctrl = controllerWithAsset();
    ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 100 });
    ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 200, durationFrames: 100 });
    ctrl.changeTimelineMarkers({ creates: [{ name: 'On second clip', startFrame: 250 }] });
    const executor = new ToolExecutor(ctrl);

    const result = await executor.execute('ripple_delete_clips', {
      clipIds: [ctrl.getClips()[0].id],
    });

    expect(result.success).toBe(true);
    const data = result.data as MarkerDeltaData;
    expect(data.removedMarkerIds).toEqual([]);
    expect(data.shiftedMarkers).toHaveLength(1);
    expect(data.shiftedMarkers![0]).toMatchObject({ name: 'On second clip', startFrame: 150 });
  });

  it('ripple_delete_clips reports a consumed marker by id', async () => {
    const ctrl = controllerWithAsset();
    ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 100 });
    ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 200, durationFrames: 100 });
    const created = ctrl.changeTimelineMarkers({ creates: [{ name: 'Doomed', startFrame: 50 }] })!;
    const executor = new ToolExecutor(ctrl);

    const result = await executor.execute('ripple_delete_clips', {
      clipIds: [ctrl.getClips()[0].id],
    });

    expect(result.success).toBe(true);
    const data = result.data as MarkerDeltaData;
    expect(data.removedMarkerIds).toEqual([created.created[0].id]);
    expect(data.shiftedMarkers).toEqual([]);
  });

  it('ripple_trim_clip reports the stretched range marker', async () => {
    const ctrl = controllerWithAsset();
    ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 100 });
    ctrl.changeTimelineMarkers({
      creates: [{ name: 'Span', startFrame: 50, durationFrames: 200 }],
    });
    const executor = new ToolExecutor(ctrl);

    const result = await executor.execute('ripple_trim_clip', {
      clipId: ctrl.getClips()[0].id,
      edge: 'right',
      deltaFrames: 40,
    });

    expect(result.success).toBe(true);
    const data = result.data as MarkerDeltaData;
    expect(data.removedMarkerIds).toEqual([]);
    expect(data.shiftedMarkers![0]).toMatchObject({ durationFrames: 240 });
  });

  it('trim_clips reports the net marker delta across a ripple batch', async () => {
    const ctrl = controllerWithAsset();
    const a = ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 30 });
    ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 30, durationFrames: 30 });
    ctrl.changeTimelineMarkers({ creates: [{ name: 'Tail', startFrame: 50 }] });
    const executor = new ToolExecutor(ctrl);

    // One ripple trim: the marker at 50 rides the +3 opening, ending at 53.
    const result = await executor.execute('trim_clips', {
      edits: [{ clipId: a, endFrame: 33 }],
      ripple: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as MarkerDeltaData & { touched: string[] };
    expect(data.removedMarkerIds).toEqual([]);
    expect(data.shiftedMarkers).toHaveLength(1);
    expect(data.shiftedMarkers![0]).toMatchObject({ name: 'Tail', startFrame: 53 });
    expect(ctrl.getMarkers()[0].startFrame).toBe(53);
  });

  it('trim_clips reports empty deltas for a non-ripple batch', async () => {
    const ctrl = controllerWithAsset();
    const a = ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 30 });
    ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 30, durationFrames: 30 });
    ctrl.changeTimelineMarkers({ creates: [{ name: 'Tail', startFrame: 50 }] });
    const executor = new ToolExecutor(ctrl);

    const result = await executor.execute('trim_clips', {
      edits: [{ clipId: a, endFrame: 25 }],
    });

    expect(result.success).toBe(true);
    const data = result.data as MarkerDeltaData;
    expect(data.shiftedMarkers).toEqual([]);
    expect(data.removedMarkerIds).toEqual([]);
  });
});
