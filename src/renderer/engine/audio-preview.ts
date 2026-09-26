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
import { resolveRenderTimeline } from '../../shared/editor/compound';
import { eqBiquadParams } from '../../shared/audio/eq';
import { compressorPreviewParams, type CompressorConfig } from '../../shared/audio/compressor';
import { denoisePreviewParams } from '../../shared/audio/denoise';

const RESYNC_THRESHOLD_SEC = 0.25;

type PoolEntry = {
  el: HTMLAudioElement;
  /** Web Audio routing for per-element pan (R5), gain, and EQ. Created lazily. */
  ctx: AudioContext | null;
  panner: StereoPannerNode | null;
  /**
   * Overall gain node (R5/#535 volume keyframes). `HTMLMediaElement.volume`
   * only accepts [0,1] and throws outside that range, but a positive-dB
   * boost keyframe resolves to linear gain above 1 — so boost is applied
   * here, not on `el.volume`, and `el.volume` stays pinned at 1 once this
   * graph exists.
   */
  gainNode: GainNode | null;
  /** Three-band EQ (upstream #158), same bands the export chain emits. */
  eqNodes: [BiquadFilterNode, BiquadFilterNode, BiquadFilterNode] | null;
  /**
   * Denoise stage (upstream #165): highpass + highshelf ahead of the
   * panner — the preview's approximation of the export chain's leading
   * `afftdn`. Always in the chain; off parks it transparent (10 Hz, 0 dB).
   */
  denoiseNodes: [BiquadFilterNode, BiquadFilterNode] | null;
  /**
   * Compressor + makeup stage (upstream #158). The node is always in the
   * chain and transparent at ratio 1, so there is no bypass branch.
   */
  compressorNode: DynamicsCompressorNode | null;
  makeupNode: GainNode | null;
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

  /** Apply linear gain via the Web Audio graph so values above 1 (dB boost) don't throw. */
  private applyGain(entry: PoolEntry, volume: number): void {
    if (entry.gainNode) {
      entry.gainNode.gain.value = Number.isFinite(volume) ? Math.max(0, volume) : 1;
      return;
    }
    // No Web Audio graph yet (first tick, or createMediaElementSource
    // failed): the element's own volume is the only lever, but it rejects
    // anything outside [0,1] — clamp defensively rather than throw.
    entry.el.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
  }

  private connectPanner(entry: PoolEntry): void {
    if (entry.panner) return;
    try {
      this.sharedCtx ??= new AudioContext();
      const source = this.sharedCtx.createMediaElementSource(entry.el);
      const panner = new StereoPannerNode(this.sharedCtx, { pan: 0 });
      // EQ sits between pan and gain; neutral bands are 0 dB, so the chain
      // is bit-transparent when no EQ is set and there is no bypass branch.
      const eqNodes = eqBiquadParams({ lowDb: 0, midDb: 0, highDb: 0 }).map((params) => {
        const node = new BiquadFilterNode(this.sharedCtx!, {
          type: params.type,
          frequency: params.frequency,
          gain: params.gain,
          ...(params.q !== undefined ? { Q: params.q } : {}),
        });
        return node;
      }) as [BiquadFilterNode, BiquadFilterNode, BiquadFilterNode];
      const compressor = new DynamicsCompressorNode(this.sharedCtx, { ratio: 1, knee: 6 });
      const makeup = new GainNode(this.sharedCtx, { gain: 1 });
      const gain = new GainNode(this.sharedCtx, { gain: 1 });
      // Denoise (#165): parked transparent here; applyDenoise pushes the
      // plan's strength each tick, same as the EQ/compressor stages.
      const denoiseOff = denoisePreviewParams(null);
      const denoiseNodes = [
        new BiquadFilterNode(this.sharedCtx, {
          type: 'highpass',
          frequency: denoiseOff.highpassFrequency,
        }),
        new BiquadFilterNode(this.sharedCtx, {
          type: 'highshelf',
          frequency: denoiseOff.highshelfFrequency,
          gain: denoiseOff.highshelfGainDb,
        }),
      ] as [BiquadFilterNode, BiquadFilterNode];
      source.connect(denoiseNodes[0]);
      denoiseNodes[0].connect(denoiseNodes[1]);
      denoiseNodes[1].connect(panner);
      panner.connect(eqNodes[0]);
      eqNodes[0].connect(eqNodes[1]);
      eqNodes[1].connect(eqNodes[2]);
      eqNodes[2].connect(compressor);
      compressor.connect(makeup);
      makeup.connect(gain);
      gain.connect(this.sharedCtx.destination);
      entry.ctx = this.sharedCtx;
      entry.sourceNode = source;
      entry.panner = panner;
      entry.eqNodes = eqNodes;
      entry.denoiseNodes = denoiseNodes;
      entry.compressorNode = compressor;
      entry.makeupNode = makeup;
      entry.gainNode = gain;
      // Gain now lives in the Web Audio graph; leave the element itself at
      // full volume so it never double-applies.
      entry.el.volume = 1;
    } catch {
      // createMediaElementSource can fail if the element is already routed
      // or the context is unavailable; audio still plays un-panned, and
      // applyGain falls back to el.volume (clamped to its [0,1] domain).
      entry.panner = null;
      entry.eqNodes = null;
      entry.denoiseNodes = null;
      entry.compressorNode = null;
      entry.makeupNode = null;
      entry.gainNode = null;
    }
  }

  /** Push the clip's three band gains into the live biquads (dB). */
  private applyEq(entry: PoolEntry, eq: { lowDb: number; midDb: number; highDb: number } | null): void {
    if (!entry.eqNodes) return;
    const params = eqBiquadParams(eq ?? { lowDb: 0, midDb: 0, highDb: 0 });
    for (let i = 0; i < 3; i++) {
      entry.eqNodes[i].gain.value = params[i].gain;
    }
  }

  /**
   * Push the clip's compressor into the live nodes. A null config resolves
   * to ratio 1 with unity makeup, which is a transparent pass — the same
   * "ratio 1 is off" contract the export chain uses to skip the filter.
   */
  private applyCompressor(entry: PoolEntry, compressor: CompressorConfig | null): void {
    if (!entry.compressorNode || !entry.makeupNode) return;
    const params = compressorPreviewParams(compressor ?? {
      thresholdDb: -18,
      ratio: 1,
      attackMs: 20,
      releaseMs: 250,
      makeupDb: 0,
    });
    entry.compressorNode.threshold.value = params.threshold;
    entry.compressorNode.ratio.value = params.ratio;
    entry.compressorNode.attack.value = params.attackSec;
    entry.compressorNode.release.value = params.releaseSec;
    entry.compressorNode.knee.value = params.kneeDb;
    entry.makeupNode.gain.value = params.makeupLinear;
  }

  /**
   * Push the plan's denoise strength into the parked biquad pair (#165).
   * Null resolves to the transparent parking (10 Hz highpass, 0 dB shelf),
   * the same off contract the export chain's missing afftdn provides.
   */
  private applyDenoise(entry: PoolEntry, amount: number | null): void {
    if (!entry.denoiseNodes) return;
    const params = denoisePreviewParams(amount);
    entry.denoiseNodes[0].frequency.value = params.highpassFrequency;
    entry.denoiseNodes[1].frequency.value = params.highshelfFrequency;
    entry.denoiseNodes[1].gain.value = params.highshelfGainDb;
  }

  /**
   * Called every engine tick (and on seek/pause). Reads project state from
   * the timeline store, matching how PlaybackEngine itself works.
   */
  sync(playhead: number, playing: boolean): void {
    const store = useTimelineStore.getState();
    const rate = store.playbackRate;

    // Preview always hears the whole project from the root: nested audio
    // resolves to ordinary clips with root-mapped timing and composed
    // volume/pan/mute, so the plan below needs no nest awareness.
    const view = resolveRenderTimeline(store.project);
    const plan =
      playing && Math.abs(rate) === 1
        ? computeAudioPlan({
            clips: view.clips,
            tracks: view.tracks,
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
        entry = {
          el, ctx: null, panner: null, gainNode: null, eqNodes: null,
          denoiseNodes: null,
          compressorNode: null, makeupNode: null, sourceNode: null, activePath: null,
        };
        this.pool.set(item.path, entry);
      }
      this.connectPanner(entry);
      this.ensurePanner(entry, item.pan);
      this.applyEq(entry, item.eq);
      this.applyCompressor(entry, item.compressor);
      this.applyDenoise(entry, item.noiseReduction);

      const expectedSourceTime = item.sourceTimeSec;
      if (entry.activePath !== item.path || entry.el.paused) {
        entry.el.currentTime = expectedSourceTime;
        this.applyGain(entry, item.volume);
        void entry.el.play().catch(() => {
          // Autoplay refusal: the user's next explicit Play click re-enters
          // with a gesture and succeeds.
        });
        entry.activePath = item.path;
        continue;
      }

      this.applyGain(entry, item.volume);
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
