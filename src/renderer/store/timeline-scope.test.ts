/**
 * Timeline-store editing scope (upstream issue #155, slice 2).
 *
 * The controller owns the breadcrumb path; the store mirrors it (scope id +
 * breadcrumbs) on every notification, shows the open scope through
 * getClips/getTracks/getScopeTimeline, and clears cross-scope selection on
 * navigation. Preview/export/save keep reading the full project snapshot.
 */
import { describe, it, expect } from 'vitest';
import { useTimelineStore } from './timeline';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip } from '../../shared/types/project';

let seq = 0;
function videoClip(overrides: Partial<Clip>): Clip {
  seq += 1;
  return {
    id: `clip-${seq}`,
    assetId: 'asset',
    type: 'video',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 60,
    inPoint: 0,
    outPoint: 60,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 0,
    anchorY: 0,
    volume: 1,
    muted: false,
    ...overrides,
  };
}

function seed() {
  const store = useTimelineStore;
  const controller = store.getState().controller;
  const project = createEmptyProject();
  project.media = [{
    id: 'asset', path: '/test/asset.mp4', filename: 'asset.mp4', type: 'video',
    duration: 1000, fileSize: 1, addedAt: new Date().toISOString(),
  }];
  project.timeline.clips = [
    videoClip({ id: `a-${seq}`, startFrame: 0 }),
    videoClip({ id: `b-${seq}`, startFrame: 60, durationFrames: 40, inPoint: 10, outPoint: 50 }),
  ];
  const a = project.timeline.clips[0].id;
  const b = project.timeline.clips[1].id;
  controller.loadProject(project);
  return { store, controller, a, b };
}

describe('timeline store scope', () => {
  it('opens a compound clip: lanes follow, snapshot stays whole', () => {
    const { store, controller, a, b } = seed();
    const receipt = controller.nestClips([a, b], { name: 'Intro' });
    expect(store.getState().openCompoundClip(receipt.compoundClipId)).toBe(true);

    const state = store.getState();
    expect(state.activeTimelineId).toBe(receipt.timelineId);
    expect(state.timelinePath.map((crumb) => crumb.name)).toEqual(['Main', 'Intro']);
    expect(state.getClips().map((clip) => clip.id).sort()).toEqual([a, b].sort());
    // The full project snapshot still carries the root compound for
    // preview/export/save consumers.
    expect(state.project.timeline.clips).toHaveLength(1);
    expect(state.project.timelines?.[receipt.timelineId]).toBeDefined();
  });

  it('clears selection on navigation and refuses dangling opens', () => {
    const { store, controller, a, b } = seed();
    const receipt = controller.nestClips([a, b]);
    store.getState().selectClip(a);
    expect(store.getState().selectedClipIds.size).toBe(1);

    expect(store.getState().openCompoundClip(receipt.compoundClipId)).toBe(true);
    expect(store.getState().selectedClipIds.size).toBe(0);
    expect(store.getState().openCompoundClip('ghost')).toBe(false);
    expect(store.getState().activeTimelineId).toBe(receipt.timelineId);

    expect(store.getState().navigateScopeUp()).toBe(true);
    expect(store.getState().activeTimelineId).toBeNull();
    expect(store.getState().navigateScopeUp()).toBe(false);
    expect(store.getState().navigateScopeTo('ghost')).toBe(false);
  });

  it('nests the selection inside the open scope', () => {
    const { store, controller, a, b } = seed();
    const receipt = controller.nestClips([a, b]);
    store.getState().openCompoundClip(receipt.compoundClipId);
    store.getState().selectClip(a);
    const compoundId = store.getState().nestSelected();
    expect(compoundId).not.toBeNull();
    // The new compound lives in the open nest, selected for the next edit.
    expect(store.getState().getClips().some((clip) => clip.id === compoundId)).toBe(true);
    expect(store.getState().selectedClipIds).toEqual(new Set([compoundId]));
    expect(controller.getProject().timeline.clips).toHaveLength(1);
  });

  it('drives ambient vs root playheads explicitly', () => {
    const { store, controller, a, b } = seed();
    const receipt = controller.nestClips([a, b]);
    store.getState().openCompoundClip(receipt.compoundClipId);

    store.getState().setPlayhead(12);
    expect(store.getState().getPlayhead()).toBe(12);
    expect(store.getState().project.timeline.playheadFrame).toBe(0);

    store.getState().setPlayhead(30, null);
    expect(store.getState().project.timeline.playheadFrame).toBe(30);
    expect(store.getState().getPlayhead()).toBe(12);
  });
});
