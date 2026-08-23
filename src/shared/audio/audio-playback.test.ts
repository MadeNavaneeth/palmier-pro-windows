import { describe, it, expect } from 'vitest';
import { computeAudioPlan } from './audio-playback';
import type { Clip } from '../types/project';

const fps = 30;

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', type: 'audio', trackId: 'a1',
    startFrame: 300, durationFrames: 100, inPoint: 0, outPoint: 100,
    x: 0, y: 0, width: 1, height: 1, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...overrides,
  };
}

const base = {
  tracks: [{ id: 'a1', visible: true }],
  assets: [{ id: 'a', path: 'C:/m/a.mp3' }],
  playbackRate: 1,
  fps,
};

describe('computeAudioPlan (preview audio)', () => {
  it('includes active unmuted audio with the correct source offset', () => {
    const entries = computeAudioPlan({
      ...base,
      clips: [clip({ inPoint: 30 })],
      playhead: 330, // 1s into the clip
    });
    // inPoint 30f (1s) + 1s into the clip = 2s of source.
    expect(entries).toEqual([
      { path: 'C:/m/a.mp3', sourceTimeSec: 2, volume: 1 },
    ]);
  });

  it('excludes muted clips, muted tracks, and offline sources', () => {
    const clips = [
      clip({ id: 'c-muted', muted: true }), // clip mute
      clip({ id: 'c-track-muted', trackId: 'a0' }), // on an audible-off track
      clip({ id: 'c-offline', assetId: 'gone' }), // file missing
      clip({ id: 'c-ok', assetId: 'x' }),
    ];
    const entries = computeAudioPlan({
      tracks: [
        { id: 'a1', visible: true },
        { id: 'a0', visible: false },
      ],
      assets: [
        { id: 'a', path: 'C:/a.mp3' },
        { id: 'b', path: 'C:/b.mp3' },
        { id: 'gone', path: 'D:/gone.mp3' },
        { id: 'x', path: 'C:/x.mp3' },
      ],
      offlinePaths: new Set(['D:/gone.mp3']),
      clips,
      playbackRate: 1,
      fps,
      playhead: 350,
    });
    expect(entries.map((e) => e.path)).toEqual(['C:/x.mp3']);
  });

  it('is silent during shuttle rates and outside clip spans', () => {
    const input = { ...base, clips: [clip()], playhead: 320 };
    expect(computeAudioPlan({ ...input, playbackRate: 2 })).toEqual([]);
    expect(computeAudioPlan({ ...input, playhead: 200 })).toEqual([]); // before
    expect(computeAudioPlan({ ...input, playhead: 500 })).toEqual([]); // after
  });

  it('clamps volume into [0,1]', () => {
    const entries = computeAudioPlan({
      ...base,
      clips: [clip({ volume: 7 })],
      playhead: 320,
    });
    expect(entries[0].volume).toBe(1);
  });
});
