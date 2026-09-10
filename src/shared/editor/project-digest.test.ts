import { describe, expect, it } from 'vitest';
import { createEmptyProject, type Clip } from '../types/project';
import { buildProjectDigest } from './project-digest';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', type: 'video', trackId: 'v1',
    startFrame: 0, durationFrames: 30, inPoint: 0, outPoint: 30,
    x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...overrides,
  };
}

describe('buildProjectDigest (L4)', () => {
  it('summarizes an empty project without inventing content', () => {
    const digest = buildProjectDigest(createEmptyProject());
    expect(digest).toContain('## Current project');
    expect(digest).toContain('"Untitled Project" — 1920x1080 @ 30 fps, content 0s');
    expect(digest).toContain('Tracks: 1 video, 1 audio');
    expect(digest).toContain('Clips: 0 total');
    expect(digest).toContain('Media: 0 assets');
    expect(digest).toContain('Markers: 0');
    expect(digest).toContain('Structural audit: 0 error(s), 0 warning(s)');
  });

  it('counts clips by type, track flags, markers, and content length', () => {
    const project = createEmptyProject();
    project.name = 'Reel';
    project.media = [{
      id: 'a', path: 'C:/media/a.mp4', filename: 'a.mp4', type: 'video',
      duration: 600, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
    }];
    project.timeline.tracks[0].locked = true;
    project.timeline.tracks[1].visible = false;
    project.timeline.clips = [
      clip({ id: 'v1c', startFrame: 0, durationFrames: 300 }),
      clip({ id: 'a1c', type: 'audio', trackId: 'a1', startFrame: 0, durationFrames: 600 }),
      clip({ id: 't1', type: 'title', text: 'Hi', assetId: '__title__' }),
    ];
    project.timeline.markers = [
      { id: 'm1', name: 'A', startFrame: 0, durationFrames: 0, color: '#007AFF', comment: '', status: 'open' },
      { id: 'm2', name: 'B', startFrame: 10, durationFrames: 0, color: '#007AFF', comment: '', status: 'resolved' },
    ];

    const digest = buildProjectDigest(project);

    expect(digest).toContain('"Reel" — 1920x1080 @ 30 fps, content 20s');
    expect(digest).toContain('Tracks: 1 video, 1 audio (1 locked) (1 hidden)');
    expect(digest).toContain('Clips: 3 total — 1 video, 1 audio, 0 image, 1 title');
    expect(digest).toContain('Markers: 2 (1 open, 0 in review)');
  });

  it('surfaces structural problems with a pointer to the audit tool', () => {
    const project = createEmptyProject();
    // The clip's media must exist, or the zero-length defect would be joined
    // by a missing-media error and the count would no longer isolate it.
    project.media = [{
      id: 'a', path: 'C:/media/a.mp4', filename: 'a.mp4', type: 'video',
      duration: 600, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
    }];
    project.timeline.clips = [clip({ id: 'bad', durationFrames: 0 })];

    const digest = buildProjectDigest(project);

    expect(digest).toContain('Structural audit: 1 error(s), 0 warning(s) — run verify_timeline for detail');
  });

  it('is deterministic for the same project state', () => {
    const project = createEmptyProject();
    project.timeline.clips = [clip()];
    expect(buildProjectDigest(project)).toBe(buildProjectDigest(project));
  });
});
