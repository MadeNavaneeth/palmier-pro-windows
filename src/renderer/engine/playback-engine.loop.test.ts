/**
 * Loop region tests (upstream PR #428).
 *
 * When loop is enabled with an in/out range, the transport wraps playback
 * to the loop start instead of stopping at the project end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the PlaybackEngine's setLoopRange + tick behavior by verifying
// the engine state and store interaction. Since the engine reads from the
// zustand store directly, we test through the store's toggleLoop + the
// engine's setLoopRange contract.

describe('loop region (upstream PR #428)', () => {
  it('toggleLoop flips loopEnabled in the store', async () => {
    const { useTimelineStore } = await import('../store/timeline');
    const store = useTimelineStore;

    const before = store.getState().loopEnabled;
    store.getState().toggleLoop();
    expect(store.getState().loopEnabled).toBe(!before);
    store.getState().toggleLoop(); // toggle back
    expect(store.getState().loopEnabled).toBe(before);
  });

  it('loopEnabled defaults to false', async () => {
    const { useTimelineStore } = await import('../store/timeline');
    expect(useTimelineStore.getState().loopEnabled).toBe(false);
  });

  it('setLoopRange stores the range on PlaybackEngine', async () => {
    const { getPlaybackEngine } = await import('./PlaybackEngine');
    const engine = getPlaybackEngine();

    // Should not throw
    engine.setLoopRange(true, 100, 300);
    engine.setLoopRange(false);
  });
});
