/**
 * Regression coverage for the marker UI surface in the timeline store
 * (upstream PR #542): playhead marker creation with collision-skipping
 * auto-names, selection semantics, markers-first deletion, and marker frames
 * appearing as snap targets.
 */

import { describe, it, expect } from 'vitest';
import { useTimelineStore } from './timeline';

function storeWithClips() {
  const store = useTimelineStore;
  const controller = store.getState().controller;
  // The store is a module singleton; wipe any markers earlier tests left so
  // auto-naming and index-based assertions stay deterministic.
  const staleIds = controller.getMarkers().map((marker) => marker.id);
  if (staleIds.length > 0) controller.changeTimelineMarkers({ deleteIds: staleIds });
  controller.addMedia({
    id: 'asset-m',
    path: '/test/m.mp4',
    filename: 'm.mp4',
    type: 'video',
    duration: 5000,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  controller.addClip({ assetId: 'asset-m', trackId: 'v1', startFrame: 0, durationFrames: 200 });
  return { store, controller };
}

describe('marker store surface (#542)', () => {
  it('adds a marker at the playhead and selects it', () => {
    const { store } = storeWithClips();
    store.getState().setPlayhead(120);

    const id = store.getState().addMarkerAtPlayhead();
    expect(id).not.toBeNull();
    expect(store.getState().controller.getMarkers()[0]).toMatchObject({
      id,
      name: 'Marker 1',
      startFrame: 120,
    });
    expect(store.getState().selectedMarkerIds.has(id!)).toBe(true);
    // Selecting a marker dismissed the clip selection.
    expect(store.getState().selectedClipIds.size).toBe(0);
  });

  it('skips auto-names already claimed by an earlier marker', () => {
    const { store, controller } = storeWithClips();
    controller.changeTimelineMarkers({ creates: [{ name: 'Marker 1', startFrame: 0 }] });

    const id = store.getState().addMarkerAtPlayhead();
    expect(controller.getMarkers().find((m) => m.id === id)?.name).toBe('Marker 2');
  });

  it('deletes selected markers before clips and reports whether anything went', () => {
    const { store, controller } = storeWithClips();
    const clipId = controller.getClips()[0].id;

    // No marker selection: Delete must fall through to clips.
    store.getState().selectClip(clipId);
    expect(store.getState().deleteSelectedMarkers()).toBe(false);

    const id = store.getState().addMarkerAtPlayhead();
    expect(store.getState().deleteSelectedMarkers()).toBe(true);
    expect(controller.getMarkers()).toHaveLength(0);
    expect(store.getState().selectedMarkerIds.size).toBe(0);
    void id;
  });

  it('updates one marker and refuses invalid patches without throwing', () => {
    const { store } = storeWithClips();
    const id = store.getState().addMarkerAtPlayhead()!;

    expect(store.getState().updateMarker(id, { name: 'Renamed' })).toBe(true);
    expect(store.getState().controller.getMarkers().find((m) => m.id === id)?.name).toBe('Renamed');

    // Empty name is invalid; the action must refuse quietly (UI never sees a throw).
    expect(store.getState().updateMarker(id, { name: '' })).toBe(false);
    expect(store.getState().updateMarker('ghost', { name: 'X' })).toBe(false);
  });

  it('exposes marker edges as snap targets', () => {
    const { store, controller } = storeWithClips();
    controller.changeTimelineMarkers({
      creates: [{ name: 'Range', startFrame: 100, durationFrames: 50 }],
    });

    const sources = store
      .getState()
      .getSnapPoints()
      .filter((point) => point.source === 'marker')
      .map((point) => point.frame);
    expect(sources).toEqual(expect.arrayContaining([100, 150]));
  });

  it('navigates next/previous and selects the destination marker (R1)', () => {
    const { store, controller } = storeWithClips();
    controller.changeTimelineMarkers({
      creates: [
        { name: 'A', startFrame: 100 },
        { name: 'B', startFrame: 300 },
      ],
    });
    store.getState().setPlayhead(50);

    expect(store.getState().goToNextMarker()).toBe(true);
    expect(store.getState().getPlayhead()).toBe(100);
    const firstId = controller.getMarkers().find((m) => m.name === 'A')!.id;
    expect(store.getState().selectedMarkerIds.has(firstId)).toBe(true);

    // A marker the playhead sits ON is not its own "next".
    expect(store.getState().goToNextMarker()).toBe(true);
    expect(store.getState().getPlayhead()).toBe(300);

    // End of list: no-op.
    expect(store.getState().goToNextMarker()).toBe(false);

    expect(store.getState().goToPreviousMarker()).toBe(true);
    expect(store.getState().getPlayhead()).toBe(100);

    // Before the first marker: no-op.
    store.getState().setPlayhead(40);
    expect(store.getState().goToPreviousMarker()).toBe(false);
    expect(store.getState().getPlayhead()).toBe(40);
  });
});
