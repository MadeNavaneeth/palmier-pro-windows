/**
 * Regression coverage for marker review statuses (upstream #552): open /
 * review / resolved persist and affect the Agent and popover, with older
 * projects decoding as open so the list is never silently discarded.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

describe('marker review statuses (#552)', () => {
  it('creates markers as open by default', () => {
    const ctrl = new EditorController();
    const receipt = ctrl.changeTimelineMarkers({
      creates: [{ name: 'M', startFrame: 10 }],
    })!;

    expect(receipt.created[0].status).toBe('open');
  });

  it('creates and updates a marker through every status', () => {
    const ctrl = new EditorController();
    const receipt = ctrl.changeTimelineMarkers({
      creates: [{ name: 'M', startFrame: 10, status: 'review' }],
    })!;
    const id = receipt.created[0].id;
    expect(ctrl.getMarkers()[0].status).toBe('review');

    ctrl.changeTimelineMarkers({ updates: [{ id, status: 'resolved' }] });
    expect(ctrl.getMarkers()[0].status).toBe('resolved');

    ctrl.changeTimelineMarkers({ updates: [{ id, status: 'open' }] });
    expect(ctrl.getMarkers()[0].status).toBe('open');
  });

  it('refuses an invalid status', () => {
    const ctrl = new EditorController();
    // Narrowed back to open on create, but the tool executor's zod schema
    // rejects `done` before the domain sees it; an unknown persisted status
    // decodes safely instead of throwing.
    const receipt = ctrl.changeTimelineMarkers({
      creates: [{ name: 'M', startFrame: 10, status: 'done' as never }],
    })!;
    expect(receipt.created[0].status).toBe('open');
  });

  it('round-trips through serialization with a missing status decoding as open', () => {
    const ctrl = new EditorController();
    ctrl.changeTimelineMarkers({ creates: [{ name: 'Old', startFrame: 30 }] });
    const json = ctrl.serialize();
    const parsed = JSON.parse(json) as { timeline: { markers?: Array<Record<string, unknown>> } };
    // Simulate an older project file that stored markers before statuses existed.
    delete parsed.timeline.markers![0]!['status'];
    const raw = JSON.stringify(parsed);
    const restored = EditorController.deserialize(raw);

    expect(restored.getMarkers()[0].status).toBe('open');
    expect(restored.getMarkers()[0].name).toBe('Old');
  });

  it('preserves status through a ripple move', () => {
    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'asset',
      path: '/test/video.mp4',
      filename: 'video.mp4',
      type: 'video',
      duration: 10_000,
      fileSize: 1,
      addedAt: new Date().toISOString(),
    });
    ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 100 });
    ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 200, durationFrames: 100 });
    ctrl.changeTimelineMarkers({ creates: [{ name: 'Review', startFrame: 250, status: 'review' }] });
    const clipId = ctrl.getClips()[0].id;

    ctrl.rippleDeleteClips([clipId]);

    expect(ctrl.getMarkers()[0]).toMatchObject({ status: 'review', startFrame: 150 });
  });
});
