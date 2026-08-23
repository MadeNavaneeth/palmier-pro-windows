/**
 * Preview audio playback (roadmap R2/R5 groundwork).
 *
 * A reconciling pool of HTMLAudioElements driven from the playback engine's
 * tick: every tick recomputes the pure audio plan (shared/audio/
 * audio-playback.ts) and diffs it against the live elements. This
 * self-healing design handles play, pause, seek (even external jumps),
 * rate changes to silent shuttle speeds, clip edits, and mute toggles with
 * one code path -- no event-edge bookkeeping to drift out of sync.
 *
 * Drift policy: an element more than 250 ms away from its expected source
 * time is snapped; smaller drift is left alone so we never fight the
 * element's own clock at frame rate.
 */

import { useTimelineStore } from '../store/timeline';
import { computeAudioPlan } from '../../shared/audio/audio-playback';

const RESYNC_THRESHOLD_SEC = 0.25;

type PoolEntry = {
  el: HTMLAudioElement;
  /** Web Audio routing for per-element pan (R5). Created lazily. */
  ctx: AudioContext | null;
  panner: StereoPannerNode | null;
  sourceNode: MediaElementAudioSourceNode | null;
  /** The plan path this element is currently serving, null when idle. */
  activePath: string | null;
};

export class AudioPreviewManager {
  private pool = new Map<string, PoolEntry>();
  private lastPlayhead: number | null = null;
  private sharedCtx: AudioContext | null = null;

  private ensurePanner(entry: PoolEntry, pan: number): void {
    // Route the element through a StereoPannerNode once; afterwards its
    // output permanently lives in this context, so the context is shared.
    if (!entry.ctx || !entry.panner) return;
    entry.panner.pan.value = pan;
  }

  private connectPanner(entry: PoolEntry): void {
    if (entry.panner) return;
    try {
      this.sharedCtx ??= new AudioContext();
      const source = this.sharedCtx.createMediaElementSource(entry.el);
      const panner = new StereoPannerNode(this.sharedCtx, { pan: 0 });
      source.connect(panner);
      panner.connect(this.sharedCtx.destination);
      entry.ctx = this.sharedCtx;
      entry.sourceNode = source;
      entry.panner = panner;
    } catch {
      // createMediaElementSource can fail if the element is already routed
      // or the context is unavailable; audio still plays un-panned.
      entry.panner = null;
    }
  }

  /**
   * Called every engine tick (and on seek/pause). Reads project state from
   * the timeline store, matching how PlaybackEngine itself works.
   */
  sync(playhead: number, playing: boolean): void {
    const store = useTimelineStore.getState();
    const rate = store.playbackRate;

    const plan =
      playing && Math.abs(rate) === 1
        ? computeAudioPlan({
            clips: store.project.timeline.clips,
            tracks: store.project.timeline.tracks,
            assets: store.project.media,
            offlinePaths: store.offlinePaths,
            playbackRate: rate,
            playhead,
            fps: store.getProjectFps(),
          })
        : [];

    // Elements whose path dropped out of the plan go quiet.
    const plannedPaths = new Set(plan.map((e) => e.path));
    for (const entry of this.pool.values()) {
      if (entry.activePath !== null && !plannedPaths.has(entry.activePath)) {
        entry.el.pause();
        entry.activePath = null;
      }
    }

    for (const item of plan) {
      let entry = this.pool.get(item.path);
      if (!entry) {
        const el = document.createElement('audio');
        el.src = encodeURI(`file:///${item.path.replace(/\\/g, '/')}`).replace(/#/g, '%23');
        el.preload = 'auto';
        entry = { el, ctx: null, panner: null, sourceNode: null, activePath: null };
        this.pool.set(item.path, entry);
      }
      this.connectPanner(entry);
      this.ensurePanner(entry, item.pan);

      const expectedSourceTime = item.sourceTimeSec;
      if (entry.activePath !== item.path || entry.el.paused) {
        entry.el.currentTime = expectedSourceTime;
        entry.el.volume = item.volume;
        void entry.el.play().catch(() => {
          // Autoplay refusal: the user's next explicit Play click re-enters
          // with a gesture and succeeds.
        });
        entry.activePath = item.path;
        continue;
      }

      entry.el.volume = item.volume;
      const drift = Math.abs(entry.el.currentTime - expectedSourceTime);
      if (drift > RESYNC_THRESHOLD_SEC) {
        entry.el.currentTime = expectedSourceTime;
      }
    }

    this.lastPlayhead = playhead;
  }

  stopAll(): void {
    for (const entry of this.pool.values()) {
      entry.el.pause();
      entry.activePath = null;
    }
  }

  /** External jump detection: large playhead deltas force a hard resync. */
  needsHardResync(playhead: number): boolean {
    return (
      this.lastPlayhead !== null && Math.abs(playhead - this.lastPlayhead) > 1
    );
  }
}

let instance: AudioPreviewManager | null = null;
export function getAudioPreviewManager(): AudioPreviewManager {
  instance ??= new AudioPreviewManager();
  return instance;
}
