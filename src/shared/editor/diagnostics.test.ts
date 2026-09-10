import { describe, expect, it } from 'vitest';
import { createEmptyProject, type Clip, type Project } from '../types/project';
import { diagnoseTimeline } from './diagnostics';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', type: 'video', trackId: 'v1',
    startFrame: 0, durationFrames: 30, inPoint: 0, outPoint: 30,
    x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...overrides,
  };
}

function project(clips: Clip[] = [], markers: Project['timeline']['markers'] = []): Project {
  const base = createEmptyProject();
  base.media = [{
    id: 'a', path: 'C:/media/a.mp4', filename: 'a.mp4', type: 'video',
    duration: 100, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
  }];
  base.timeline.clips = clips;
  if (markers) base.timeline.markers = markers;
  return base;
}

describe('diagnoseTimeline (L2)', () => {
  it('is quiet on a clean project', () => {
    expect(diagnoseTimeline(project([clip()]))).toEqual([]);
  });

  it('flags clips without a track, non-positive durations, and negative starts', () => {
    const issues = diagnoseTimeline(project([
      clip({ id: 'ghost', trackId: 'nope' }),
      clip({ id: 'zero', durationFrames: 0 }),
      clip({ id: 'neg', startFrame: -5 }),
    ]));
    expect(issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['clip-not-on-track', 'zero-length-clip', 'negative-start']),
    );
    expect(issues.find((i) => i.code === 'zero-length-clip')?.clipId).toBe('zero');
  });

  it('flags missing and offline media, and source overruns', () => {
    const overrun = diagnoseTimeline(project([clip({ outPoint: 500 })]));
    expect(overrun.map((i) => i.code)).toContain('clip-outlives-source');

    const offline = diagnoseTimeline(project([clip()]), {
      offlinePaths: new Set(['C:/media/a.mp4']),
    });
    expect(offline.map((i) => i.code)).toContain('offline-media');

    const missing = diagnoseTimeline(project([clip({ assetId: 'gone' })]));
    expect(missing.map((i) => i.code)).toContain('missing-media');
  });

  it('flags overlaps per track and orphaned link groups', () => {
    const issues = diagnoseTimeline(project([
      clip({ id: 'first', startFrame: 0, durationFrames: 30 }),
      clip({ id: 'second', startFrame: 10, durationFrames: 30 }),
      clip({ id: 'linked', startFrame: 100, durationFrames: 10, linkGroupId: 'g1' }),
    ]));
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('overlapping-clips');
    expect(codes).toContain('orphaned-link');
    // A complete pair is not an orphan.
    const paired = diagnoseTimeline(project([
      clip({ id: 'v', linkGroupId: 'g2' }),
      clip({ id: 'a1', type: 'audio', trackId: 'a1', linkGroupId: 'g2' }),
    ]));
    expect(paired.map((i) => i.code)).not.toContain('orphaned-link');
  });

  it('flags fades over the clip length, empty titles, and invalid markers', () => {
    const issues = diagnoseTimeline(project(
      [
        clip({ id: 'faded', fadeInFrames: 20, fadeOutFrames: 20 }),
        clip({ id: 'title', assetId: '__title__', type: 'title', text: '   ' }),
      ],
      [
        {
          id: 'm1', name: 'Bad', startFrame: -1, durationFrames: 0,
          color: '#007AFF', comment: '', status: 'open',
        },
      ],
    ));
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('fade-exceeds-clip');
    expect(codes).toContain('empty-title');
    expect(codes).toContain('marker-invalid');
  });

  it('orders errors first and honours the issue cap', () => {
    const clips = Array.from({ length: 12 }, (_, index) =>
      clip({ id: `c${index}`, durationFrames: 0 }));
    clips.push(clip({ id: 'bad-track', trackId: 'ghost' }));
    const issues = diagnoseTimeline(project(clips), { maxIssues: 5 });
    expect(issues).toHaveLength(5);
    expect(issues.every((issue) => issue.severity === 'error')).toBe(true);
  });
});
