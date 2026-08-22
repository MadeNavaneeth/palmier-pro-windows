/**
 * Regression coverage for the timeline marker domain (upstream PRs #542 and
 * #560), including the two ripple-mapping fixes upstream shipped with #560:
 * multi-track deletes remap by the smallest surviving track map so a marker on
 * surviving picture is not dragged by another track's larger hole, and maps
 * that consumed a range are ignored rather than collapsing it.
 */

import { describe, it, expect } from 'vitest';
import {
  MARKER_DEFAULT_COLOR,
  MARKER_NAME_MAX_LENGTH,
  mapMarkersOpeningAt,
  mapMarkersThroughClosingHoles,
  rescaleMarker,
  sortMarkers,
  validateMarker,
  type TimelineMarker,
} from './markers';

function marker(overrides: Partial<TimelineMarker> = {}): TimelineMarker {
  return {
    id: 'm1',
    name: 'Note',
    startFrame: 100,
    durationFrames: 0,
    color: MARKER_DEFAULT_COLOR,
    comment: '',
    ...overrides,
  };
}

describe('validateMarker', () => {
  it('accepts a well-formed point and range marker', () => {
    expect(validateMarker(marker())).toBeNull();
    expect(validateMarker(marker({ durationFrames: 50 }))).toBeNull();
    expect(validateMarker(marker({ color: '#FF000080' }))).toBeNull();
  });

  it('rejects empty, over-long, or multiline names', () => {
    expect(validateMarker(marker({ name: '   ' }))).toMatch(/name/i);
    expect(validateMarker(marker({ name: 'x'.repeat(MARKER_NAME_MAX_LENGTH + 1) })))
      .toMatch(/120/);
    expect(validateMarker(marker({ name: 'two\nlines' }))).toMatch(/line/i);
  });

  it('rejects bad frames and colors', () => {
    expect(validateMarker(marker({ startFrame: -1 }))).toMatch(/start frame/i);
    expect(validateMarker(marker({ startFrame: 1.5 }))).toMatch(/start frame/i);
    expect(validateMarker(marker({ durationFrames: -5 }))).toMatch(/duration/i);
    expect(validateMarker(marker({ color: 'blue' }))).toMatch(/color/i);
    expect(validateMarker(marker({ comment: 'x'.repeat(4001) }))).toMatch(/comment/i);
  });
});

describe('sortMarkers', () => {
  it('orders by start frame then id', () => {
    const sorted = sortMarkers([
      marker({ id: 'b', startFrame: 10 }),
      marker({ id: 'a2', startFrame: 0 }),
      marker({ id: 'a1', startFrame: 0 }),
    ]);
    expect(sorted.map((m) => m.id)).toEqual(['a1', 'a2', 'b']);
  });
});

describe('rescaleMarker', () => {
  it('rounds both edges without inverting a range', () => {
    const scaled = rescaleMarker(marker({ startFrame: 33, durationFrames: 7 }), 0.5);
    expect(scaled.startFrame).toBe(17); // 16.5 rounds to 17
    expect(scaled.durationFrames).toBe(4); // 3.5 rounds to 4
    expect(scaled.durationFrames).toBeGreaterThanOrEqual(0);
  });
});

describe('mapMarkersThroughClosingHoles (#560)', () => {
  it('shifts markers left by closed holes before them', () => {
    const next = mapMarkersThroughClosingHoles(
      [marker({ startFrame: 200 })],
      [[{ start: 50, end: 100 }]],
    );
    expect(next).toEqual([marker({ startFrame: 150 })]);
  });

  it('removes a point consumed by every voting track\'s holes', () => {
    // The only track with holes removes it; a track with no holes does not
    // vote (upstream filters empty hole lists out before mapping). Every
    // marker gone is still a change, so the result is an empty list.
    expect(mapMarkersThroughClosingHoles([marker({ startFrame: 60 })], [
      [{ start: 50, end: 100 }],
      [],
    ])).toEqual([]);
  });

  it('keeps a point that at least one voting track preserves', () => {
    const next = mapMarkersThroughClosingHoles([marker({ startFrame: 250 })], [
      [{ start: 50, end: 100 }],
      [{ start: 200, end: 300 }],
    ]);
    // Track two's hole contains the point, so only track one votes — and its
    // hole sits entirely before the marker, shifting it left by 50.
    expect(next).toEqual([marker({ startFrame: 200 })]);

    // A survivor that does not move is reported as "no change" (null), which
    // tells the caller the marker array can stay untouched.
    expect(mapMarkersThroughClosingHoles([marker({ startFrame: 60 })], [
      [{ start: 50, end: 100 }],
      [{ start: 200, end: 300 }],
    ])).toBeNull();
  });

  it('takes the minimum mapped position across surviving tracks', () => {
    // Upstream remaps conservatively: the marker lands on the smallest
    // position any surviving track map produces, so it can never sit past
    // material that a cut pulled left.
    const next = mapMarkersThroughClosingHoles([marker({ startFrame: 150 })], [
      [{ start: 0, end: 100 }],
      [{ start: 120, end: 140 }],
    ]);
    expect(next).toEqual([marker({ startFrame: 50 })]);
  });

  it('shrinks ranges spanning a hole and drops fully consumed ones', () => {
    const spanning = marker({ id: 'span', name: 'S', startFrame: 40, durationFrames: 60 });
    const next = mapMarkersThroughClosingHoles([spanning], [[{ start: 50, end: 90 }]]);
    expect(next).toEqual([marker({ id: 'span', name: 'S', startFrame: 40, durationFrames: 20 })]);

    const consumed = marker({ id: 'gone', name: 'G', startFrame: 55, durationFrames: 20 });
    expect(mapMarkersThroughClosingHoles([consumed], [[{ start: 50, end: 90 }]])).toEqual([]);
  });

  it('ignores a track map that consumed the range while another shrinks it', () => {
    // Track A's hole covers the whole range; track B's covers only part.
    // The B map survives with a non-empty range and wins.
    const range = marker({ id: 'r', name: 'R', startFrame: 40, durationFrames: 60 });
    const next = mapMarkersThroughClosingHoles([range], [
      [{ start: 30, end: 110 }],
      [{ start: 50, end: 90 }],
    ]);
    expect(next).toEqual([marker({ id: 'r', name: 'R', startFrame: 40, durationFrames: 20 })]);
  });
});

describe('mapMarkersOpeningAt (#560)', () => {
  it('pushes starts at or after the frame and stretches spanning ranges', () => {
    const next = mapMarkersOpeningAt([
      marker({ id: 'before', name: 'B', startFrame: 10 }),
      marker({ id: 'at', name: 'A', startFrame: 50 }),
      marker({ id: 'span', name: 'S', startFrame: 20, durationFrames: 60 }),
    ], 50, 30);
    // Output is in canonical (startFrame, id) order.
    expect(next).toEqual([
      marker({ id: 'before', name: 'B', startFrame: 10 }),
      marker({ id: 'span', name: 'S', startFrame: 20, durationFrames: 90 }),
      marker({ id: 'at', name: 'A', startFrame: 80 }),
    ]);
  });

  it('delegates negative pushes to the closing-hole path', () => {
    const next = mapMarkersOpeningAt([marker({ startFrame: 150 })], 100, -50);
    expect(next).toEqual([marker({ startFrame: 100 })]);
  });

  it('returns null when nothing would change', () => {
    expect(mapMarkersOpeningAt([marker({ startFrame: 10 })], 50, 30)).toBeNull();
    expect(mapMarkersOpeningAt([marker({ startFrame: 10 })], 50, 0)).toBeNull();
  });
});
