/**
 * Coverage for per-frame visible-layer resolution (#556).
 *
 * The compositor resolves layers on every composite and prefetch request;
 * upstream's sparse-timeline stall is this scan scaling with TRACK count
 * even when those tracks hold nothing at the requested frame. These tests
 * pin the semantics (audio exclusion, hidden tracks, half-open frame range,
 * track-order layering) and keep the cost bounded as both counts grow.
 */
import { describe, it, expect } from 'vitest';
import type { Clip, MediaAsset, Project, Track } from '../../shared/types/project';
import { visualClipsAtFrame } from './visible-clips';

let clipSeq = 0;

function track(id: string, order: number, overrides: Partial<Track> = {}): Track {
  return {
    id,
    name: id,
    type: 'video',
    locked: false,
    visible: true,
    syncLocked: true,
    order,
    ...overrides,
  } as Track;
}

function clip(trackId: string, startFrame: number, durationFrames = 100): Clip {
  return {
    id: `c${++clipSeq}`,
    assetId: 'asset',
    label: 'clip',
    type: 'video',
    trackId,
    startFrame,
    durationFrames,
    inPoint: 0,
    outPoint: durationFrames,
  } as Clip;
}

function project(tracks: Track[], clips: Clip[], media: MediaAsset[] = []): Project {
  return {
    version: 2,
    name: 'bench',
    settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000, backgroundColor: '#000000' },
    media,
    timeline: { tracks, clips, playheadFrame: 0 },
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  } as Project;
}

describe('visualClipsAtFrame', () => {
  it('excludes audio clips and clips on hidden tracks', () => {
    const p = project(
      [track('v1', 0), track('v2', 1, { visible: false })],
      [clip('v1', 0), clip('v2', 0), clip('a1', 0)],
    );
    // The audio clip sits on an unknown-to-this-list track; either way it
    // must never reach the compositor.
    (p.timeline.clips[2] as Clip).type = 'audio';
    p.timeline.clips[2].trackId = 'v1';

    expect(visualClipsAtFrame(p, 10).map((c) => c.trackId)).toEqual(['v1']);
  });

  it('uses a half-open frame range: start inclusive, end exclusive', () => {
    const p = project([track('v1', 0)], [clip('v1', 50, 100)]);

    expect(visualClipsAtFrame(p, 49)).toEqual([]);
    expect(visualClipsAtFrame(p, 50)).toHaveLength(1);
    expect(visualClipsAtFrame(p, 149)).toHaveLength(1);
    expect(visualClipsAtFrame(p, 150)).toEqual([]);
  });

  it('layers by track order regardless of clip array order', () => {
    const bottom = clip('v1', 0);
    const top = clip('v2', 0);
    const p = project([track('v2', 1), track('v1', 0)], [top, bottom]);

    expect(visualClipsAtFrame(p, 0)).toEqual([bottom, top]);
  });

  it('drops clips whose track no longer exists', () => {
    const orphaned = clip('ghost', 0);
    const kept = clip('v1', 0);
    const p = project([track('v1', 0)], [orphaned, kept]);

    expect(visualClipsAtFrame(p, 0)).toEqual([kept]);
  });

  it('stays fast on a sparse many-track timeline (#556 regression guard)', () => {
    const TRACKS = 40;
    const CLIPS = 3000;
    const tracks = Array.from({ length: TRACKS }, (_, i) => track(`t${i}`, i));
    // Sparse: most clips live on the first few tracks, like a real session
    // that grew lanes nobody uses anymore.
    const clips = Array.from({ length: CLIPS }, (_, i) =>
      clip(`t${i % 6}`, (i * 37) % 5000),
    );
    const p = project(tracks, clips);

    const started = performance.now();
    let seen = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      seen += visualClipsAtFrame(p, frame * 7).length;
    }
    const elapsedMs = performance.now() - started;

    // Sanity: the sweep actually resolved layers.
    expect(seen).toBeGreaterThan(0);
    // 120 resolutions across 40 tracks / 3000 clips must stay trivially
    // cheap; the pre-fix scans made each resolution O(clips x tracks).
    expect(elapsedMs).toBeLessThan(250);
  });
});

