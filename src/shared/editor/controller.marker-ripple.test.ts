/**
 * Regression coverage for marker-aware ripple edits (upstream PR #560):
 * markers follow ripple delete/gap/ranges and ripple trim, and the whole
 * thing is one undo step.
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

describe('marker-aware ripple edits (#560)', () => {
  it('ripple-deleting a clip shifts later markers left by the removed length', () => {
    const ctrl = controllerWithMaterial();
    const clips = ctrl.getClips();
    ctrl.changeTimelineMarkers({
      creates: [{ name: 'On second clip', startFrame: 250 }],
    });

    ctrl.rippleDeleteClips([clips[0].id]);
    expect(ctrl.getMarkers()[0].startFrame).toBe(150);
  });

  it('a marker inside the deleted span is removed', () => {
    const ctrl = controllerWithMaterial();
    const clips = ctrl.getClips();
    ctrl.changeTimelineMarkers({ creates: [{ name: 'Doomed', startFrame: 50 }] });

    ctrl.rippleDeleteClips([clips[0].id]);
    expect(ctrl.getMarkers()).toHaveLength(0);
  });

  it('ripple gap delete closes the gap under a range marker', () => {
    const ctrl = controllerWithMaterial();
    ctrl.changeTimelineMarkers({
      creates: [{ name: 'Spanning', startFrame: 150, durationFrames: 100 }],
    });

    ctrl.rippleDeleteGap('v1', { start: 100, end: 200 });
    const [marker] = ctrl.getMarkers();
    // The start sits inside the closed hole and collapses to its start; the
    // end shifts left by the hole's full length.
    expect(marker.startFrame).toBe(100);
    expect(marker.durationFrames).toBe(50);
  });

  it('ripple trim opening space stretches a spanning marker', () => {
    const ctrl = controllerWithMaterial();
    ctrl.changeTimelineMarkers({
      creates: [{ name: 'Span', startFrame: 50, durationFrames: 200 }],
    });

    const firstClipId = ctrl.getClips()[0].id;
    const report = ctrl.trimClipEdge(firstClipId, 'right', 40, true);
    expect(report).not.toBeNull();
    expect(ctrl.getMarkers()[0].durationFrames).toBe(240);
  });

  it('is one undo step for both clips and markers', () => {
    const ctrl = controllerWithMaterial();
    const clips = ctrl.getClips();
    ctrl.changeTimelineMarkers({ creates: [{ name: 'M', startFrame: 250 }] });

    ctrl.rippleDeleteClips([clips[0].id]);
    expect(ctrl.canUndo()).toBe(true);

    ctrl.undo();
    expect(ctrl.getMarkers()[0].startFrame).toBe(250);
    expect(ctrl.getClips()).toHaveLength(2);
    expect(ctrl.getClips().map((c) => c.startFrame).sort((a, b) => a - b)).toEqual([0, 200]);
  });
});
