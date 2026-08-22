/**
 * Regression coverage for the marquee selection model (roadmap R1):
 * region enclosure across multiple tracks, partial overlap counts, the
 * additive base captured at rubber-band start, and gap/marker-selection
 * dismissal.
 */

import { describe, it, expect } from 'vitest';
import { useTimelineStore } from './timeline';

function storeWithRegion() {
  const store = useTimelineStore;
  const controller = store.getState().controller;
  controller.addMedia({
    id: 'asset-mq',
    path: '/test/mq.mp4',
    filename: 'mq.mp4',
    type: 'video',
    duration: 5000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  // v1: two clips; a1: one clip inside the same frame span.
  const a = controller.addClip({ assetId: 'asset-mq', trackId: 'v1', startFrame: 100, durationFrames: 50 });
  const b = controller.addClip({ assetId: 'asset-mq', trackId: 'v1', startFrame: 300, durationFrames: 50 });
  const c = controller.addClip({ assetId: 'asset-mq', trackId: 'a1', startFrame: 120, durationFrames: 40 });
  return { store, controller, ids: { a, b, c } };
}

describe('marquee selection (R1)', () => {
  it('selects every clip intersecting the region on the enclosed tracks', () => {
    const { store, ids } = storeWithRegion();
    store.getState().beginMarquee(false);
    store.getState().applyMarqueeRegion(90, 200, new Set(['v1', 'a1']));

    const selected = store.getState().selectedClipIds;
    expect(selected.has(ids.a)).toBe(true);
    expect(selected.has(ids.c)).toBe(true);
    expect(selected.has(ids.b)).toBe(false); // starts at 300, outside
  });

  it('respects the track set — same frames on other tracks stay out', () => {
    const { store, ids } = storeWithRegion();
    store.getState().beginMarquee(false);
    store.getState().applyMarqueeRegion(90, 200, new Set(['v1']));

    expect(store.getState().selectedClipIds.has(ids.a)).toBe(true);
    expect(store.getState().selectedClipIds.has(ids.c)).toBe(false);
  });

  it('unions with the additive base captured at band start (Shift)', () => {
    const { store, ids } = storeWithRegion();
    // Pre-select b, then start an ADDITIVE marquee that only encloses a.
    store.getState().selectClip(ids.b);
    store.getState().beginMarquee(true);
    store.getState().applyMarqueeRegion(90, 200, new Set(['v1']));

    const selected = store.getState().selectedClipIds;
    expect(selected.has(ids.b)).toBe(true); // from the base
    expect(selected.has(ids.a)).toBe(true); // from the band

    // A replacing band drops the earlier selection.
    store.getState().beginMarquee(false);
    store.getState().applyMarqueeRegion(90, 200, new Set(['v1']));
    expect(store.getState().selectedClipIds.has(ids.b)).toBe(false);
  });

  it('clears gap and marker selections while banding', () => {
    const { store, controller } = storeWithRegion();
    controller.changeTimelineMarkers({ creates: [{ name: 'M', startFrame: 500 }] });
    const markerId = controller.getMarkers()[0].id;
    store.getState().setPlayhead(500);
    store.getState().selectMarker(markerId);

    store.getState().beginMarquee(false);
    expect(store.getState().selectedMarkerIds.size).toBe(0);
    expect(store.getState().selectedGap).toBeNull();
  });
});
