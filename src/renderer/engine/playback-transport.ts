/**
 * PlaybackTransport — manages play/pause/stop, J/K/L rate control,
 * and audio synchronization.
 *
 * Audio sync strategy:
 * - Uses Web Audio API AudioContext as the master clock
 * - During playback, advances playhead based on audioContext.currentTime
 *   rather than performance.now() to avoid drift between audio and video
 * - When no audio tracks are active, falls back to performance.now()
 *
 * Rate control (J/K/L):
 * - L: 1x → 2x → 4x forward
 * - J: -1x → -2x → -4x reverse
 * - K: pause
 * - Rates are integers only (matching NLE convention)
 */

import type { Frame } from '../../shared/types/project';
import type { PreviewEngine } from './preview-engine';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TransportState = 'stopped' | 'playing' | 'paused';

export interface TransportCallbacks {
  onStateChange: (state: TransportState) => void;
  onFrameAdvance: (frame: Frame) => void;
  onRateChange: (rate: number) => void;
}

// ─── Audio Clock ─────────────────────────────────────────────────────────────

class AudioClock {
  private ctx: AudioContext | null = null;
  private startContextTime: number = 0;
  private startWallTime: number = 0;
  private rate: number = 1;

  async initialize(): Promise<void> {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: 48000 });
    // Resume in case of autoplay policy
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  start(rate: number): void {
    this.rate = rate;
    if (this.ctx && this.ctx.state === 'running') {
      this.startContextTime = this.ctx.currentTime;
    } else {
      this.startContextTime = 0;
    }
    this.startWallTime = performance.now();
  }

  /**
   * Get elapsed time in seconds since start(), accounting for playback rate.
   * Uses AudioContext time when available (drift-free with audio output),
   * falls back to performance.now().
   */
  getElapsedSeconds(): number {
    if (this.ctx && this.ctx.state === 'running') {
      return (this.ctx.currentTime - this.startContextTime) * this.rate;
    }
    return ((performance.now() - this.startWallTime) / 1000) * this.rate;
  }

  setRate(rate: number): void {
    // Re-anchor the clock when rate changes
    const elapsed = this.getElapsedSeconds();
    this.rate = rate;
    if (this.ctx && this.ctx.state === 'running') {
      this.startContextTime = this.ctx.currentTime - elapsed / rate;
    } else {
      this.startWallTime = performance.now() - (elapsed / rate) * 1000;
    }
  }

  getRate(): number {
    return this.rate;
  }

  getContext(): AudioContext | null {
    return this.ctx;
  }

  destroy(): void {
    this.ctx?.close();
    this.ctx = null;
  }
}

// ─── Audio Track Player ──────────────────────────────────────────────────────

class AudioTrackPlayer {
  private audioBuffers = new Map<string, AudioBuffer>();
  private activeSources: AudioBufferSourceNode[] = [];
  private gainNode: GainNode | null = null;

  constructor(private clock: AudioClock) {}

  /**
   * Load an audio file into a buffer for instant playback.
   */
  async loadAudio(assetId: string, filePath: string): Promise<void> {
    const ctx = this.clock.getContext();
    if (!ctx) return;

    try {
      const response = await fetch(`file://${filePath}`);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      this.audioBuffers.set(assetId, audioBuffer);
    } catch (err) {
      console.warn(`[AudioTrackPlayer] Failed to load ${filePath}:`, err);
    }
  }

  /**
   * Start playing all audio clips that are active at the given frame.
   */
  startPlayback(
    clips: Array<{ assetId: string; startFrame: Frame; inPoint: Frame; durationFrames: Frame; volume: number; muted: boolean }>,
    currentFrame: Frame,
    fps: number,
  ): void {
    this.stopPlayback();

    const ctx = this.clock.getContext();
    if (!ctx) return;

    this.gainNode = ctx.createGain();
    this.gainNode.connect(ctx.destination);

    for (const clip of clips) {
      if (clip.muted) continue;

      const buffer = this.audioBuffers.get(clip.assetId);
      if (!buffer) continue;

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      // Per-clip gain
      const clipGain = ctx.createGain();
      clipGain.gain.value = clip.volume;
      source.connect(clipGain);
      clipGain.connect(this.gainNode);

      // Calculate offset: where in the source audio to start
      const clipLocalFrame = currentFrame - clip.startFrame + clip.inPoint;
      const offsetSec = Math.max(0, clipLocalFrame / fps);

      // Calculate how long to play
      const remainingFrames = clip.durationFrames - (currentFrame - clip.startFrame);
      const durationSec = remainingFrames / fps;

      source.start(0, offsetSec, durationSec);
      this.activeSources.push(source);
    }
  }

  stopPlayback(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch { /* may already be stopped */ }
    }
    this.activeSources = [];
    this.gainNode?.disconnect();
    this.gainNode = null;
  }

  setMasterVolume(volume: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = volume;
    }
  }

  isLoaded(assetId: string): boolean {
    return this.audioBuffers.has(assetId);
  }

  clearBuffers(): void {
    this.stopPlayback();
    this.audioBuffers.clear();
  }
}

// ─── PlaybackTransport ───────────────────────────────────────────────────────

export class PlaybackTransport {
  private state: TransportState = 'stopped';
  private rate: number = 1; // Playback rate: 1, 2, 4, -1, -2, -4
  private clock: AudioClock;
  private audioPlayer: AudioTrackPlayer;
  private engine: PreviewEngine | null = null;
  private callbacks: TransportCallbacks;

  private startFrame: Frame = 0;
  private fps: number = 30;
  private totalDuration: Frame = 0;

  private rafId: number = 0;
  private masterVolume: number = 1;

  constructor(callbacks: TransportCallbacks) {
    this.callbacks = callbacks;
    this.clock = new AudioClock();
    this.audioPlayer = new AudioTrackPlayer(this.clock);
  }

  async initialize(): Promise<void> {
    await this.clock.initialize();
  }

  setEngine(engine: PreviewEngine): void {
    this.engine = engine;
  }

  setProjectParams(fps: number, totalDuration: Frame): void {
    this.fps = fps;
    this.totalDuration = totalDuration;
  }

  // ─── Transport controls ──────────────────────────────────────────────────

  play(fromFrame?: Frame): void {
    if (fromFrame !== undefined) {
      this.startFrame = fromFrame;
    } else {
      this.startFrame = this.engine?.getCurrentFrame() ?? 0;
    }

    this.clock.start(this.rate);
    this.state = 'playing';
    this.callbacks.onStateChange('playing');

    // Start audio
    this.startAudio();

    // Begin render loop
    this.scheduleFrame();
  }

  pause(): void {
    if (this.state !== 'playing') return;

    this.state = 'paused';
    this.audioPlayer.stopPlayback();
    this.cancelFrame();
    this.callbacks.onStateChange('paused');
  }

  stop(): void {
    this.state = 'stopped';
    this.audioPlayer.stopPlayback();
    this.cancelFrame();

    // Return to start frame
    this.engine?.seek(this.startFrame);
    this.callbacks.onFrameAdvance(this.startFrame);
    this.callbacks.onStateChange('stopped');
  }

  togglePlayPause(): void {
    if (this.state === 'playing') {
      this.pause();
    } else {
      this.play();
    }
  }

  /**
   * J/K/L rate control.
   * - pressL(): increases forward speed (1→2→4)
   * - pressJ(): increases reverse speed (-1→-2→-4)
   * - pressK(): pause
   */
  pressL(): void {
    if (this.rate < 0) {
      this.setRate(1);
    } else if (this.rate < 4) {
      this.setRate(Math.min(4, this.rate + 1));
    }
    if (this.state !== 'playing') this.play();
  }

  pressJ(): void {
    if (this.rate > 0) {
      this.setRate(-1);
    } else if (this.rate > -4) {
      this.setRate(Math.max(-4, this.rate - 1));
    }
    if (this.state !== 'playing') this.play();
  }

  pressK(): void {
    this.pause();
    this.setRate(1); // Reset rate on pause
  }

  setRate(rate: number): void {
    const wasPlaying = this.state === 'playing';
    const currentFrame = this.engine?.getCurrentFrame() ?? this.startFrame;

    this.rate = rate;
    this.clock.setRate(rate);
    this.callbacks.onRateChange(rate);

    // Restart audio at new rate if playing
    if (wasPlaying) {
      this.startFrame = currentFrame;
      this.clock.start(rate);
      this.audioPlayer.stopPlayback();
      // Only play audio at normal speed (rate=1 or -1 for reverse is muted)
      if (Math.abs(rate) === 1) {
        this.startAudio();
      }
    }
  }

  getRate(): number {
    return this.rate;
  }

  getState(): TransportState {
    return this.state;
  }

  // ─── Volume ──────────────────────────────────────────────────────────────

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    this.audioPlayer.setMasterVolume(this.masterVolume);
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  // ─── Audio asset management ──────────────────────────────────────────────

  async loadAudioAsset(assetId: string, filePath: string): Promise<void> {
    await this.audioPlayer.loadAudio(assetId, filePath);
  }

  clearAudioBuffers(): void {
    this.audioPlayer.clearBuffers();
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  destroy(): void {
    this.stop();
    this.audioPlayer.clearBuffers();
    this.clock.destroy();
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private scheduleFrame(): void {
    this.rafId = requestAnimationFrame(() => this.onFrame());
  }

  private cancelFrame(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private onFrame(): void {
    if (this.state !== 'playing') return;

    // Calculate current frame from clock
    const elapsedSec = this.clock.getElapsedSeconds();
    const currentFrame = this.startFrame + Math.floor(elapsedSec * this.fps);

    // Bounds check
    if (this.rate > 0 && currentFrame >= this.totalDuration) {
      this.engine?.seek(this.totalDuration);
      this.callbacks.onFrameAdvance(this.totalDuration);
      this.pause();
      this.callbacks.onStateChange('stopped');
      return;
    }
    if (this.rate < 0 && currentFrame <= 0) {
      this.engine?.seek(0);
      this.callbacks.onFrameAdvance(0);
      this.pause();
      this.callbacks.onStateChange('stopped');
      return;
    }

    // Drive the preview engine
    this.engine?.setPlayhead(currentFrame);
    this.callbacks.onFrameAdvance(currentFrame);

    // Continue loop
    this.scheduleFrame();
  }

  private startAudio(): void {
    // Audio only plays at 1x rate (standard NLE behavior)
    if (Math.abs(this.rate) !== 1) return;

    // Collect audio clips that are active at the current frame
    // This would be called with actual clip data from the timeline store
    // For now, the transport exposes the method and the Preview component
    // will call it with the right clip data.
  }
}
