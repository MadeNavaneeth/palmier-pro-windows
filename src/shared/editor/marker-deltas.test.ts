import { describe, expect, it } from 'vitest';
import { diffMarkers, type TimelineMarker } from './markers';

function marker(overrides: Partial<TimelineMarker> & { id: string }): TimelineMarker {
  return {
    name: 'M',
    startFrame: 0,
    durationFrames: 0,
    color: '#007AFF',
    comment: '',
    status: 'open',
    ...overrides,
  };
}

describe('diffMarkers', () => {
  it('diffs a null after-side to empty', () => {
    expect(diffMarkers([marker({ id: 'a', startFrame: 10 })], null)).toEqual({
      shiftedMarkers: [],
      removedMarkerIds: [],
    });
  });

  it('reports moved spans with their new state', () => {
    const before = [marker({ id: 'a', startFrame: 250 }), marker({ id: 'b', startFrame: 10 })];
    const after = [marker({ id: 'b', startFrame: 10 }), marker({ id: 'a', startFrame: 150 })];

    const delta = diffMarkers(before, after);

    expect(delta.removedMarkerIds).toEqual([]);
    expect(delta.shiftedMarkers).toEqual([marker({ id: 'a', startFrame: 150 })]);
  });

  it('reports resized ranges as shifted', () => {
    const before = [marker({ id: 'a', startFrame: 100, durationFrames: 100 })];
    const after = [marker({ id: 'a', startFrame: 100, durationFrames: 50 })];

    const delta = diffMarkers(before, after);

    expect(delta.shiftedMarkers).toHaveLength(1);
    expect(delta.shiftedMarkers[0]).toMatchObject({ id: 'a', durationFrames: 50 });
    expect(delta.removedMarkerIds).toEqual([]);
  });

  it('reports consumed markers by id', () => {
    const before = [marker({ id: 'a', startFrame: 50 }), marker({ id: 'b', startFrame: 250 })];
    const after = [marker({ id: 'b', startFrame: 150 })];

    expect(diffMarkers(before, after)).toEqual({
      shiftedMarkers: [marker({ id: 'b', startFrame: 150 })],
      removedMarkerIds: ['a'],
    });
  });

  it('ignores markers whose span did not move', () => {
    const before = [marker({ id: 'a', startFrame: 10, name: 'Old' })];
    const after = [marker({ id: 'a', startFrame: 10, name: 'New' })];

    // A ripple remap never renames; a same-span marker is untouched.
    expect(diffMarkers(before, after)).toEqual({ shiftedMarkers: [], removedMarkerIds: [] });
  });

  it('is empty when nothing changed', () => {
    const before = [marker({ id: 'a', startFrame: 10 })];
    expect(diffMarkers(before, [...before])).toEqual({ shiftedMarkers: [], removedMarkerIds: [] });
    expect(diffMarkers([], [])).toEqual({ shiftedMarkers: [], removedMarkerIds: [] });
  });
});
