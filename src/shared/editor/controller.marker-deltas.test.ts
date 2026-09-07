/**
 * Regression coverage for marker deltas in ripple receipts (upstream PR #560,
 * agent half): ripple reports carry the new state of moved markers and the
 * ids of consumed ones, so the Agent patches notes without re-reading the
 * timeline.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function controllerWithMaterial() {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'asset-1',
    path: '/test/video.mp4',
    filename: 'video.mp4',
    type: 'video',
    duration: 10_000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  // Two clips on v1 with a gap between them.
  ctrl.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 0, durationFrames: 100 });
  ctrl.addClip({ assetId: 'asset-1', trackId: 'v1', startFrame: 200, durationFrames: 100 });
  return ctrl;
}

describe('marker deltas in ripple receipts (#560)', () => {
  it('ripple delete reports the moved marker with its new span', () => {
    const ctrl = controllerWithMaterial();
    const clips = ctrl.getClips();
    ctrl.changeTimelineMarkers({ creates: [{ name: 'On second clip', startFrame: 250 }] });

    const report = ctrl.rippleDeleteClips([clips[0].id])!;

    expect(report.removedMarkerIds).toEqual([]);
    expect(report.shiftedMarkers).toHaveLength(1);
    expect(report.shiftedMarkers[0]).toMatchObject({ name: 'On second clip', startFrame: 150 });
  });

  it('ripple delete reports a consumed marker by id', () => {
    const ctrl = controllerWithMaterial();
    const clips = ctrl.getClips();
    const created = ctrl.changeTimelineMarkers({ creates: [{ name: 'Doomed', startFrame: 50 }] })!;
    const doomedId = created.created[0].id;

    const report = ctrl.rippleDeleteClips([clips[0].id])!;

    expect(report.removedMarkerIds).toEqual([doomedId]);
    expect(report.shiftedMarkers).toEqual([]);
  });

  it('reports empty deltas when the preference pins markers', () => {
    const ctrl = controllerWithMaterial();
    const clips = ctrl.getClips();
    ctrl.changeTimelineMarkers({ creates: [{ name: 'Pinned', startFrame: 250 }] });
    ctrl.setRippleTimelineMarkers(false);

    const report = ctrl.rippleDeleteClips([clips[0].id])!;

    expect(report.shiftedMarkers).toEqual([]);
    expect(report.removedMarkerIds).toEqual([]);
  });

  it('ripple gap delete reports the remapped range marker', () => {
    const ctrl = controllerWithMaterial();
    ctrl.changeTimelineMarkers({
      creates: [{ name: 'Spanning', startFrame: 150, durationFrames: 100 }],
    });

    const report = ctrl.rippleDeleteGap('v1', { start: 100, end: 200 })!;

    expect(report.removedMarkerIds).toEqual([]);
    expect(report.shiftedMarkers[0]).toMatchObject({ startFrame: 100, durationFrames: 50 });
  });

  it('ripple ranges report consumed and moved markers', () => {
    const ctrl = controllerWithMaterial();
    const doomed = ctrl.changeTimelineMarkers({ creates: [{ name: 'Doomed', startFrame: 110 }] })!;
    ctrl.changeTimelineMarkers({ creates: [{ name: 'Later', startFrame: 250 }] });

    const report = ctrl.rippleDeleteRanges('v1', [{ start: 100, end: 200 }])!;

    expect(report.removedMarkerIds).toEqual([doomed.created[0].id]);
    expect(report.shiftedMarkers[0]).toMatchObject({ name: 'Later', startFrame: 150 });
  });

  it('ripple trim reports a stretched range marker', () => {
    const ctrl = controllerWithMaterial();
    ctrl.changeTimelineMarkers({
      creates: [{ name: 'Span', startFrame: 50, durationFrames: 200 }],
    });

    const report = ctrl.trimClipEdge(ctrl.getClips()[0].id, 'right', 40, true)!;

    expect(report.removedMarkerIds).toEqual([]);
    expect(report.shiftedMarkers[0]).toMatchObject({ durationFrames: 240 });
  });

  it('non-ripple trim reports empty marker deltas', () => {
    const ctrl = controllerWithMaterial();
    ctrl.changeTimelineMarkers({ creates: [{ name: 'M', startFrame: 250 }] });

    const report = ctrl.trimClipEdge(ctrl.getClips()[0].id, 'right', 40, false)!;

    expect(report.shiftedMarkers).toEqual([]);
    expect(report.removedMarkerIds).toEqual([]);
  });

  it('reports carry the fields even with no markers on the timeline', () => {
    const ctrl = controllerWithMaterial();
    const report = ctrl.rippleDeleteClips([ctrl.getClips()[0].id])!;

    expect(report.shiftedMarkers).toEqual([]);
    expect(report.removedMarkerIds).toEqual([]);
  });
});
