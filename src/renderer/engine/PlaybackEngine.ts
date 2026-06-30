/**
 * PlaybackEngine — manages the requestAnimationFrame loop for real-time preview.
 *
 * Responsibilities:
 * - Advances the playhead at the project's frame rate
 * - Requests frame composition from the main process for each frame
 * - Handles J/K/L playback rates (reverse, pause, forward, 2x, 4x)
 * - Prefetches frames ahead of the playhead
 * - Syncs audio playback position (Phase 3.5)
 *
 * Runs entirely in the renderer process. Communicates with main via IPC
 * for frame decoding + composition.
 */

import { useTimelineStore } from '../store/timeline';

export type PlaybackState = 'stopped' | 'playing' | 'seeking';

export class PlaybackEngine {
  private rafId: number = 0;
  private lastTimestamp: number = 0;
  private frameAccumulator: number = 0;
  private state: PlaybackState = 'stopped';
  private disposed = false;

  // Prefetch lookahead (frames ahead of playhead to decode)
  private prefetchAhead = 15;

  constructor() {}

  start(): void {
    if (this.state === 'playing') return;
    this.state = 'playing';
    this.lastTimestamp = performance.now();
    this.frameAccumulator = 0;
    this.tick(this.lastTimestamp);
  }

  stop(): void {
    this.state = 'stopped';
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  seek(frame: number): void {
    const store = useTimelineStore.getState();
    store.setPlayhead(frame);
    this.requestComposite(frame);
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  isPlaying(): boolean {
    return this.state === 'playing';
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private tick = (timestamp: number): void => {
    if (this.disposed || this.state !== 'playing') return;

    const store = useTimelineStore.getState();
    const fps = store.getProjectFps();
    const rate = store.playbackRate;
    const frameDuration = 1000 / fps; // ms per frame

    // Calculate elapsed time
    const elapsed = timestamp - this.lastTimestamp;
    this.lastTimestamp = timestamp;

    // Accumulate sub-frame time
    this.frameAccumulator += elapsed * Math.abs(rate);

    // Advance by whole frames
    let advanced = false;
    while (this.frameAccumulator >= frameDuration) {
      this.frameAccumulator -= frameDuration;
      const current = store.getPlayhead();
      const direction = rate >= 0 ? 1 : -1;
      const next = current + direction;

      // Bounds check
      if (next < 0) {
        store.setPlayhead(0);
        this.stop();
        useTimelineStore.setState({ isPlaying: false });
        return;
      }

      const duration = store.getProjectDuration();
      if (next >= duration) {
        // Loop or stop at end
        store.setPlayhead(0); // loop for now
        advanced = true;
        continue;
      }

      store.setPlayhead(next);
      advanced = true;
    }

    // Request composite for current frame
    if (advanced) {
      const playhead = store.getPlayhead();
      this.requestComposite(playhead);
      this.requestPrefetch(playhead, rate >= 0 ? 1 : -1);
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  private async requestComposite(frame: number): Promise<void> {
    try {
      // IPC call to main process which runs frame decode + Rust compositor
      await window.palmier.preview.compositeFrame(frame);
    } catch {
      // Non-fatal — might miss a frame under load
    }
  }

  private async requestPrefetch(currentFrame: number, direction: number): Promise<void> {
    try {
      const frames: number[] = [];
      for (let i = 1; i <= this.prefetchAhead; i++) {
        frames.push(currentFrame + i * direction);
      }
      await window.palmier.preview.prefetch(frames.filter((f) => f >= 0));
    } catch {
      // Non-fatal
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let engineInstance: PlaybackEngine | null = null;

export function getPlaybackEngine(): PlaybackEngine {
  if (!engineInstance) {
    engineInstance = new PlaybackEngine();
  }
  return engineInstance;
}
