/**
 * Regression coverage for the `rippleTimelineMarkers` preference (upstream
 * PR #560): with it off, ripple edits move clips but leave markers pinned;
 * with it on (the default), markers ride the edit as before.
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

describe('rippleTimelineMarkers preference (#560)', () => {
  it('defaults to on, matching upstream', () => {
    expect(new EditorController().isRippleTimelineMarkers()).toBe(true);
  });

  it('leaves markers pinned when a ripple delete removes clips', () => {
    const ctrl = controllerWithMaterial();
    const clips = ctrl.getClips();
    ctrl.changeTimelineMarkers({ creates: [{ name: 'On second clip', startFrame: 250 }] });
    ctrl.setRippleTimelineMarkers(false);

    ctrl.rippleDeleteClips([clips[0].id]);

    expect(ctrl.getMarkers()[0].startFrame).toBe(250);
    expect(ctrl.getClips()).toHaveLength(1);
  });

  it('keeps a doomed marker when the preference is off', () => {
    const ctrl = controllerWithMaterial();
    const clips = ctrl.getClips();
    ctrl.changeTimelineMarkers({ creates: [{ name: 'Doomed', startFrame: 50 }] });
    ctrl.setRippleTimelineMarkers(false);

    ctrl.rippleDeleteClips([clips[0].id]);

    expect(ctrl.getMarkers()).toHaveLength(1);
    expect(ctrl.getMarkers()[0].startFrame).toBe(50);
  });

  it('leaves markers pinned through a ripple trim', () => {
    const ctrl = controllerWithMaterial();
    ctrl.changeTimelineMarkers({
      creates: [{ name: 'Span', startFrame: 50, durationFrames: 200 }],
    });
    ctrl.setRippleTimelineMarkers(false);

    const report = ctrl.trimClipEdge(ctrl.getClips()[0].id, 'right', 40, true);

    expect(report).not.toBeNull();
    expect(ctrl.getMarkers()[0].startFrame).toBe(50);
    expect(ctrl.getMarkers()[0].durationFrames).toBe(200);
  });

  it('stays one undo step with the preference off', () => {
    const ctrl = controllerWithMaterial();
    const clips = ctrl.getClips();
    ctrl.changeTimelineMarkers({ creates: [{ name: 'M', startFrame: 250 }] });
    ctrl.setRippleTimelineMarkers(false);

    ctrl.rippleDeleteClips([clips[0].id]);
    ctrl.undo();

    expect(ctrl.getMarkers()[0].startFrame).toBe(250);
    expect(ctrl.getClips()).toHaveLength(2);
  });

  it('remaps again after the preference is turned back on', () => {
    const ctrl = controllerWithMaterial();
    const clips = ctrl.getClips();
    ctrl.changeTimelineMarkers({ creates: [{ name: 'On second clip', startFrame: 250 }] });
    ctrl.setRippleTimelineMarkers(false);
    ctrl.setRippleTimelineMarkers(true);

    ctrl.rippleDeleteClips([clips[0].id]);

    expect(ctrl.getMarkers()[0].startFrame).toBe(150);
  });
});
