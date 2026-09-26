/**
 * Loop region tests (upstream PR #428).
 *
 * The active renderer engine uses a frame accumulator, so these tests drive
 * one real animation-frame tick rather than reaching into its private state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTimelineStore } from '../store/timeline';
import { PlaybackEngine } from './PlaybackEngine';

let engine: PlaybackEngine | undefined;
let nextFrame: FrameRequestCallback | undefined;

type LoopRange = { enabled: boolean; start: number; end: number };

function startPlayback(rate: number, playhead: number, loop?: LoopRange): void {
  const store = useTimelineStore.getState();
  store.setPlayhead(playhead);
  store.setPlaybackRate(rate);
  useTimelineStore.setState({ isPlaying: true });

  engine = new PlaybackEngine();
  if (loop) engine.setLoopRange(loop.enabled, loop.start, loop.end);
  engine.start();
}

function advanceOneFrame(): void {
  expect(nextFrame).toBeTypeOf('function');
  nextFrame!(performance.now() + 40);
}

beforeEach(() => {
  nextFrame = undefined;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 1;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('window', {
    palmier: {
      preview: {
        compositeFrame: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
      },
    },
  });

  useTimelineStore.getState().resetProject();
  useTimelineStore.setState({ isPlaying: false, playbackRate: 1, loopEnabled: false });
});

afterEach(() => {
  engine?.dispose();
  engine = undefined;
  vi.unstubAllGlobals();
});

describe('loop region (upstream PR #428)', () => {
  it('toggleLoop flips loopEnabled in the store', () => {
    const before = useTimelineStore.getState().loopEnabled;
    useTimelineStore.getState().toggleLoop();
    expect(useTimelineStore.getState().loopEnabled).toBe(!before);
    useTimelineStore.getState().toggleLoop();
    expect(useTimelineStore.getState().loopEnabled).toBe(before);
  });

  it('loopEnabled defaults to false', () => {
    expect(useTimelineStore.getState().loopEnabled).toBe(false);
  });

  it('wraps forward from the marked out point to the in point', () => {
    startPlayback(1, 9, { enabled: true, start: 5, end: 10 });

    advanceOneFrame();

    expect(useTimelineStore.getState().getPlayhead()).toBe(5);
    expect(engine?.isPlaying()).toBe(true);
  });

  it('wraps reverse from the marked in point to the last in-range frame', () => {
    // In point zero is the important case: the project-start bound must not
    // win over the marked-range wrap.
    startPlayback(-1, 1, { enabled: true, start: 0, end: 10 });

    advanceOneFrame();

    expect(useTimelineStore.getState().getPlayhead()).toBe(9);
    expect(engine?.isPlaying()).toBe(true);
  });

  it('does not wrap at the marked out point when loop mode is off', () => {
    startPlayback(1, 9, { enabled: false, start: 5, end: 10 });

    advanceOneFrame();

    // Loop-off is pass-through at the marked out point; it only stops at the
    // normal project boundary.
    expect(useTimelineStore.getState().getPlayhead()).toBe(10);
    expect(engine?.isPlaying()).toBe(true);
  });

  it('stops at the project end when there is no marked range', () => {
    const duration = useTimelineStore.getState().getProjectDuration();
    startPlayback(1, duration - 1);

    advanceOneFrame();

    expect(useTimelineStore.getState().getPlayhead()).toBe(duration);
    expect(engine?.isPlaying()).toBe(false);
    expect(useTimelineStore.getState().isPlaying).toBe(false);
  });
});
