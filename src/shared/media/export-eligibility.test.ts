/**
 * Regression coverage for export clip eligibility (upstream PR #544).
 *
 * Upstream's defect: a muted audio track still entered the composition graph,
 * muted only downstream by a zero-gain mix, and the exporter stalled on it.
 * The invariant here is the same one that fixed it — muting is a build-time
 * exclusion. The clip list feeding the extent calculation and the one feeding
 * the FFmpeg arguments must be the same list.
 */

import { describe, it, expect } from 'vitest';
import { createEmptyProject } from '../types/project';
import type { Clip, Project } from '../types/project';
import { isMutedAudioClip, selectExportClips } from './export-eligibility';

function projectWithClips(clips: Partial<Clip>[]): Project {
  const project = createEmptyProject();
  const base: Clip = {
    id: 'clip',
    assetId: 'asset',
    type: 'audio',
    trackId: 'a1',
    startFrame: 0,
    durationFrames: 100,
    inPoint: 0,
    outPoint: 100,
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
  };
  project.timeline.clips = clips.map((overrides, index) => ({
    ...base,
    id: `clip-${index}`,
    ...overrides,
  }));
  return project;
}

describe('isMutedAudioClip', () => {
  it('flags muted audio clips', () => {
    expect(isMutedAudioClip({ ...baseAudioClip(), muted: true })).toBe(true);
  });

  it('ignores unmuted audio and any video clip', () => {
    expect(isMutedAudioClip({ ...baseAudioClip(), muted: false })).toBe(false);
    // The per-clip mute flag is an audio property; it must not remove picture.
    expect(isMutedAudioClip({ ...baseAudioClip(), type: 'video', muted: true })).toBe(false);
  });
});

describe('selectExportClips', () => {
  it('keeps ordinary clips on visible tracks', () => {
    const project = projectWithClips([
      { type: 'video', trackId: 'v1' },
      { type: 'audio', trackId: 'a1' },
    ]);
    expect(selectExportClips(project)).toHaveLength(2);
  });

  it('excludes every clip on an audio-muted track (#544)', () => {
    // `visible === false` on an audio track is the mute toggle.
    const project = projectWithClips([{ type: 'audio', trackId: 'a1' }]);
    project.timeline.tracks.find((track) => track.id === 'a1')!.visible = false;
    expect(selectExportClips(project)).toHaveLength(0);
  });

  it('excludes individually muted audio clips but keeps their track (#544)', () => {
    const project = projectWithClips([
      { type: 'audio', muted: true },
      { type: 'audio', muted: false },
    ]);
    const selected = selectExportClips(project);
    expect(selected).toHaveLength(1);
    expect(selected[0].muted).toBe(false);
  });

  it('keeps a muted video clip in the export', () => {
    const project = projectWithClips([{ type: 'video', trackId: 'v1', muted: true }]);
    expect(selectExportClips(project)).toHaveLength(1);
  });

  it('excludes clips on hidden video tracks', () => {
    const project = projectWithClips([{ type: 'video', trackId: 'v1' }]);
    project.timeline.tracks.find((track) => track.id === 'v1')!.visible = false;
    expect(selectExportClips(project)).toHaveLength(0);
  });
});

/** Minimal valid audio clip for the predicate-only checks. */
function baseAudioClip(): Clip {
  return {
    id: 'c',
    assetId: 'a',
    type: 'audio',
    trackId: 'a1',
    startFrame: 0,
    durationFrames: 10,
    inPoint: 0,
    outPoint: 10,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 0,
    anchorY: 0,
    volume: 1,
    muted: false,
  };
}
