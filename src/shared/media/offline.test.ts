/**
 * Regression coverage for offline-media classification (R0/R1) and the
 * exporter's loud pre-flight refusal.
 */

import { describe, it, expect } from 'vitest';
import { createEmptyProject } from '../types/project';
import type { MediaAsset } from '../types/project';
import {
  findOfflineAssets,
  offlineExportBlockers,
  formatOfflineNames,
} from './offline';

function projectWithMedia(
  media: Array<{ id: string; path: string; type: MediaAsset['type'] }>,
  clips: Array<{ assetId: string; trackId: string; muted?: boolean }>,
) {
  const project = createEmptyProject();
  project.media = media.map((m, i) => ({
    id: m.id,
    path: m.path,
    filename: `f${i}.bin`,
    type: m.type,
    duration: 100,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  }));
  project.timeline.clips = clips.map((c, i) => ({
    id: `clip-${i}`,
    assetId: c.assetId,
    type: c.assetId.startsWith('a') ? ('audio' as const) : ('video' as const),
    trackId: c.trackId,
    startFrame: 0,
    durationFrames: 10,
    inPoint: 0,
    outPoint: 10,
    x: 0, y: 0, width: 16, height: 9, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0,
    volume: 1,
    muted: c.muted ?? false,
  }));
  return project;
}

const existsTrue = () => true;
const existsFalse = () => false;

describe('findOfflineAssets', () => {
  it('flags assets whose file is missing', () => {
    const project = projectWithMedia(
      [
        { id: 'v-online', path: 'C:/here.mp4', type: 'video' },
        { id: 'v-offline', path: 'D:/gone.mp4', type: 'video' },
      ],
      [{ assetId: 'v-online', trackId: 'v1' }],
    );
    const exists = (p: string) => p === 'C:/here.mp4';
    expect(findOfflineAssets(project, exists).map((a) => a.id)).toEqual(['v-offline']);
    expect(findOfflineAssets(project, existsTrue)).toHaveLength(0);
    void existsFalse;
  });
});

describe('offlineExportBlockers', () => {
  it('blocks offline assets consumed by visible, unmuted clips', () => {
    const project = projectWithMedia(
      [{ id: 'v-off', path: 'D:/gone.mp4', type: 'video' }],
      [{ assetId: 'v-off', trackId: 'v1' }],
    );
    expect(offlineExportBlockers(project, existsFalse).map((a) => a.id))
      .toEqual(['v-off']);
  });

  it('ignores offline media no visible clip consumes (#544 eligibility)', () => {
    const project = projectWithMedia(
      [{ id: 'a-off-muted', path: 'D:/gone.mp3', type: 'audio' }],
      [],
    );
    // Referenced only by a muted audio clip on an audio-muted track:
    const project2 = projectWithMedia(
      [{ id: 'a-off', path: 'D:/gone.mp3', type: 'audio' }],
      [{ assetId: 'a-off', trackId: 'a1', muted: true }],
    );
    project2.timeline.tracks.find((t) => t.id === 'a1')!.visible = false;
    expect(offlineExportBlockers(project2, existsFalse)).toHaveLength(0);
    expect(offlineExportBlockers(project, existsFalse)).toHaveLength(0);
  });

  it('formats names for the refusal message', () => {
    const project = projectWithMedia(
      [
        { id: 'x', path: 'D:/1.mp4', type: 'video' },
        { id: 'y', path: 'E:/2.mp4', type: 'video' },
      ],
      [],
    );
    expect(formatOfflineNames(findOfflineAssets(project, existsFalse))).toBe('f0.bin, f1.bin');
  });
});
