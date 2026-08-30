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
import { normalizePlaybackRate } from '../../shared/editor/playback-rate';
import { rasterizeTitle } from './title-raster-cache';
import type { Clip, Project } from '../../shared/types/project';

export type PlaybackState = 'stopped' | 'playing' | 'seeking';

type TitleRasterForIpc = { clipId: string; width: number; height: number; x: number; y: number; rgba: Uint8ClampedArray };

/**
 * Rasterize every title clip visible at `frame`, matching the exact
 * visibility rule main/media/visible-clips.ts applies for every other
 * non-audio clip: solo-active tracks (when any track is soloed) plus
 * track-visible plus frame inside [startFrame, startFrame+durationFrames).
 * A title clip is not excluded from the solo filter just because it has no
 * media asset -- title clips participate in solo/hide exactly like video
 * and image clips do on the main-process side, and this must agree or
 * soloing a track would hide its video but leave its titles behind.
 */
function visibleTitleRasters(project: Project, frame: number): TitleRasterForIpc[] {
  const { width, height } = project.settings;
  const trackById = new Map(project.timeline.tracks.map((track) => [track.id, track] as const));
  const anySoloed = project.timeline.tracks.some((track) => track.soloed);
  const results: TitleRasterForIpc[] = [];
  for (const clip of project.timeline.clips) {
    if (clip.type !== 'title') continue;
    const track = trackById.get(clip.trackId);
    if (!track || track.visible === false) continue;
    if (anySoloed && !track.soloed) continue;
    if (frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
    const rasterized = rasterizeTitle(clip as Clip, width, height);
    if (!rasterized) continue;
    results.push({
      clipId: clip.id,
      width: rasterized.width,
      height: rasterized.height,
      x: rasterized.x,
      y: rasterized.y,
      rgba: rasterized.data,
    });
  }
  return results;
}

/**
 * Largest frame gap the loop will try to make up. Anything longer is dropped
 * rather than replayed frame by frame.
 */
const MAX_CATCHUP_MS = 250;

/**
 * Consecutive composite failures before the engine says something.
 *
 * A single dropped frame under load is normal and must stay silent. A run of
 * them means the decoder or compositor is broken, which previously showed up
 * only as a frozen preview with nothing in the log to explain it (upstream #89).
 */
const COMPOSITE_FAILURE_REPORT_THRESHOLD = 30;

export class PlaybackEngine {
  private rafId: number = 0;
  private lastTimestamp: number = 0;
  private frameAccumulator: number = 0;
  private state: PlaybackState = 'stopped';
  private disposed = false;

  // Loop state (upstream #428)
  private loopEnabled = false;
  private loopStart = 0;
  private loopEnd = 0;
  private consecutiveCompositeFailures = 0;
  private hasReportedCompositeFailure = false;
  /** Per-tick observers (preview audio reconciliation, R2). */
  private tickListeners = new Set<(playhead: number) => void>();

  // ─── Playback health (R2 dropped-frame indicator) ─────────────────────────
  /** Composites that outlived their frame budget during playback. */
  private slowComposites = 0;
  /** Ticks where more than one frame was advanced at once (real drops). */
  private multiFrameTicks = 0;
  private lastTickAdvanced = 1;

  /** Snapshot for the UI's preview-health indicator. */
  getPlaybackHealth(): { slowComposites: number; multiFrameTicks: number } {
    return {
      slowComposites: this.slowComposites,
      multiFrameTicks: this.multiFrameTicks,
    };
  }

  resetPlaybackHealth(): void {
    this.slowComposites = 0;
    this.multiFrameTicks = 0;
    this.lastTickAdvanced = 1;
  }

  /** Subscribe to playhead movement during playback. Returns an unsubscribe. */
  addTickListener(listener: (playhead: number) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

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
    for (const listener of this.tickListeners) listener(frame);
    // Detached on purpose: a seek must not block the caller on a decode.
    void this.requestComposite(frame);
  }

  setLoopRange(enabled: boolean, start?: number, end?: number): void {
    this.loopEnabled = enabled;
    this.loopStart = start ?? 0;
    this.loopEnd = end ?? 0;
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
    const rate = normalizePlaybackRate(store.playbackRate);
    const frameDuration = 1000 / fps; // ms per frame

    // Elapsed time, bounded. A backgrounded window, a long GC pause, or a
    // blocked main process can hand back a gap of many seconds; without the
    // bound the catch-up loop below would run thousands of iterations in one
    // frame and stall the renderer instead of dropping the missed time.
    const elapsed = Math.min(Math.max(0, timestamp - this.lastTimestamp), MAX_CATCHUP_MS);
    this.lastTimestamp = timestamp;

    // Accumulate sub-frame time. Slow rates (0.25x) advance a frame every few
    // ticks, which is exactly what the accumulator is for.
    this.frameAccumulator += elapsed * Math.abs(rate);

    // Advance by whole frames
    let advanced = false;
    let advancedCount = 0;
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
        // Loop (upstream #428): wrap to loop start if active, else loop to 0
        const loopTarget = this.loopEnabled && this.loopEnd > this.loopStart ? this.loopStart : 0;
        store.setPlayhead(loopTarget);
        advanced = true;
        advancedCount += 1;
        continue;
      }

      store.setPlayhead(next);
      advanced = true;
      advancedCount += 1;
    }

    // Health: a tick that advanced more than one frame means the composite
    // pipeline did not keep up with the clock (dropped frames, R2).
    if (advanced && advancedCount > 1) this.multiFrameTicks += 1;

    // Request composite for current frame. Detached on purpose: the loop must
    // keep the clock moving whether or not this frame arrives in time.
    if (advanced) {
      const playhead = store.getPlayhead();
      void this.requestComposite(playhead);
      void this.requestPrefetch(playhead, rate >= 0 ? 1 : -1);
      for (const listener of this.tickListeners) listener(store.getPlayhead());
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  /**
   * Ask the main process to composite one frame.
   *
   * A miss is non-fatal — dropping a frame is better than stalling the clock —
   * but a sustained run of misses is a real fault and is reported once rather
   * than discarded silently (#89).
   */
  private async requestComposite(frame: number): Promise<void> {
    const store = useTimelineStore.getState();
    const startedAt = this.state === 'playing' ? performance.now() : null;
    try {
      // Title clips have no decodable media asset, so only the renderer's
      // canvas/font engine can produce their pixels; rasterize whichever
      // are visible at this frame and hand the buffers to the main-process
      // compositor alongside the frame index (#title-preview parity).
      const titles = visibleTitleRasters(store.project, frame);
      // IPC call to main process which runs frame decode + Rust compositor
      await window.palmier.preview.compositeFrame(frame, titles);
      this.consecutiveCompositeFailures = 0;
      this.hasReportedCompositeFailure = false;
      if (startedAt !== null) {
        const frameBudgetMs = 1000 / Math.max(1, store.getProjectFps() * Math.abs(normalizePlaybackRate(store.playbackRate)));
        if (performance.now() - startedAt > frameBudgetMs) {
          this.slowComposites += 1;
        }
      }
    } catch (err) {
      this.consecutiveCompositeFailures += 1;
      if (
        this.consecutiveCompositeFailures >= COMPOSITE_FAILURE_REPORT_THRESHOLD
        && !this.hasReportedCompositeFailure
      ) {
        // Reported once per outage, so a broken compositor is diagnosable
        // without flooding the console at frame rate.
        this.hasReportedCompositeFailure = true;
        console.error(
          `[PlaybackEngine] ${this.consecutiveCompositeFailures} consecutive frame `
          + 'composite failures. Preview is not updating.',
          err,
        );
      }
    }
  }

  /**
   * Warm the decoder ahead of the playhead.
   *
   * Failures are genuinely ignorable: a prefetch miss only costs the decode
   * being redone when the frame is actually needed.
   */
  private async requestPrefetch(currentFrame: number, direction: number): Promise<void> {
    try {
      const frames: number[] = [];
      for (let i = 1; i <= this.prefetchAhead; i++) {
        frames.push(currentFrame + i * direction);
      }
      await window.palmier.preview.prefetch(frames.filter((f) => f >= 0));
    } catch {
      // Ignorable by design: the frame is decoded on demand if this missed.
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
