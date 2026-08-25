/**
 * PreviewEngine — drives the 60fps real-time preview rendering loop.
 *
 * Architecture:
 * 1. Each animation frame: collect visible layers at current playhead
 * 2. For each layer: request decoded frame from main process (via IPC)
 * 3. Composite layers onto the Canvas (CPU path now, GPU path Phase 3+)
 * 4. During playback: advance playhead each frame, synced to audio clock
 *
 * The engine operates entirely in the renderer process using Canvas 2D
 * as the initial compositor. When the native addon is available, it
 * delegates compositing to the Rust/wgpu pipeline via SharedArrayBuffer.
 */

import type { Clip, Frame, Project, ProjectSettings } from '../../shared/types/project';
import { frameToSeconds } from '../../shared/utils/time';
import { colorGradeOf, toCanvasFilter } from '../../shared/editor/color-grade';
import { TITLE_BACKGROUND_PADDING_DEFAULT, applyTitleFontCase } from '../../shared/editor/title';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LayerFrame {
  clip: Clip;
  imageData: ImageBitmap | HTMLImageElement | null;
}

export interface PreviewEngineConfig {
  canvas: HTMLCanvasElement;
  onFrameRendered?: (frame: Frame) => void;
  onPlaybackEnd?: () => void;
  onError?: (error: string) => void;
}

export type EngineState = 'idle' | 'playing' | 'seeking' | 'rendering';

// ─── Frame Cache (renderer-side) ─────────────────────────────────────────────

class FrameCache {
  private cache = new Map<string, ImageBitmap>();
  private maxSize = 120; // ~4 seconds at 30fps

  get(key: string): ImageBitmap | undefined {
    return this.cache.get(key);
  }

  set(key: string, bitmap: ImageBitmap): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entries
      const entries = Array.from(this.cache.entries());
      const evictCount = Math.floor(this.maxSize * 0.25);
      for (let i = 0; i < evictCount; i++) {
        entries[i][1].close(); // Release GPU memory
        this.cache.delete(entries[i][0]);
      }
    }
    this.cache.set(key, bitmap);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    for (const bitmap of this.cache.values()) {
      bitmap.close();
    }
    this.cache.clear();
  }
}

// ─── PreviewEngine ───────────────────────────────────────────────────────────

export class PreviewEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: PreviewEngineConfig;

  private state: EngineState = 'idle';
  private rafId: number = 0;
  private frameCache = new FrameCache();

  // Playback state
  private playheadFrame: Frame = 0;
  private playbackRate: number = 1;
  private playbackStartTime: number = 0; // performance.now() when playback began
  private playbackStartFrame: Frame = 0; // frame when playback began

  // Project state (set externally)
  private project: Project | null = null;
  private fps: number = 30;
  private canvasWidth: number = 1920;
  private canvasHeight: number = 1080;

  // Prefetch
  private prefetchAhead = 30; // prefetch 1 second ahead
  private prefetchPending = new Set<string>();

  /** Latch so a failing render reports once instead of once per animation frame. */
  private hasReportedRenderFailure = false;

  constructor(config: PreviewEngineConfig) {
    this.config = config;
    this.canvas = config.canvas;
    const ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Failed to get Canvas 2D context');
    this.ctx = ctx;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  setProject(project: Project): void {
    this.project = project;
    this.fps = project.settings.fps;
    this.canvasWidth = project.settings.width;
    this.canvasHeight = project.settings.height;
    this.canvas.width = this.canvasWidth;
    this.canvas.height = this.canvasHeight;
  }

  setPlayhead(frame: Frame): void {
    this.playheadFrame = Math.max(0, frame);
    if (this.state === 'idle') {
      this.renderFrameDetached(this.playheadFrame);
    }
  }

  play(rate: number = 1): void {
    if (this.state === 'playing') this.stop();
    this.playbackRate = rate;
    this.playbackStartTime = performance.now();
    this.playbackStartFrame = this.playheadFrame;
    this.state = 'playing';
    this.scheduleNextFrame();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'idle';
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  stop(): void {
    this.pause();
    this.playheadFrame = this.playbackStartFrame;
    this.renderFrameDetached(this.playheadFrame);
  }

  seek(frame: Frame): void {
    this.playheadFrame = Math.max(0, frame);
    this.state = 'seeking';
    // `finally`, not `then`: the state must leave 'seeking' even when the render
    // fails, or the engine stops repainting for the rest of the session.
    void this.renderFrame(this.playheadFrame)
      .catch((err: unknown) => this.reportRenderFailure(err))
      .finally(() => {
        if (this.state === 'seeking') this.state = 'idle';
      });
  }

  isPlaying(): boolean {
    return this.state === 'playing';
  }

  getState(): EngineState {
    return this.state;
  }

  getCurrentFrame(): Frame {
    return this.playheadFrame;
  }

  destroy(): void {
    this.pause();
    this.frameCache.clear();
  }

  invalidateCache(): void {
    this.frameCache.clear();
  }

  // ─── Render Loop ─────────────────────────────────────────────────────────

  private scheduleNextFrame(): void {
    this.rafId = requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    if (this.state !== 'playing') return;

    // Calculate current frame from elapsed time (audio-clock sync)
    const elapsed = performance.now() - this.playbackStartTime;
    const elapsedFrames = Math.floor((elapsed / 1000) * this.fps * this.playbackRate);
    this.playheadFrame = this.playbackStartFrame + elapsedFrames;

    // Check if we've reached the end
    const duration = this.getProjectDuration();
    if (this.playbackRate > 0 && this.playheadFrame >= duration) {
      this.playheadFrame = duration;
      this.state = 'idle';
      this.config.onPlaybackEnd?.();
      this.renderFrameDetached(this.playheadFrame);
      return;
    }
    if (this.playbackRate < 0 && this.playheadFrame <= 0) {
      this.playheadFrame = 0;
      this.state = 'idle';
      this.config.onPlaybackEnd?.();
      this.renderFrameDetached(this.playheadFrame);
      return;
    }

    // Render current frame
    this.renderFrameDetached(this.playheadFrame);
    this.config.onFrameRendered?.(this.playheadFrame);

    // Prefetch upcoming frames
    this.prefetchFrames();

    // Schedule next
    this.scheduleNextFrame();
  }

  /**
   * Start a render without waiting for it.
   *
   * The rAF loop and the seek/playhead setters cannot await a decode, so the
   * promise is detached — but explicitly, with a rejection handler, so a broken
   * render surfaces through `onError` instead of vanishing (#89).
   */
  private renderFrameDetached(frame: Frame): void {
    void this.renderFrame(frame).catch((err: unknown) => this.reportRenderFailure(err));
  }

  /** Report a render failure once per outage, not once per frame. */
  private reportRenderFailure(err: unknown): void {
    if (this.hasReportedRenderFailure) return;
    this.hasReportedRenderFailure = true;
    const message = err instanceof Error ? err.message : String(err);
    this.config.onError?.(`Preview render failed: ${message}`);
    console.error('[PreviewEngine] Render failed:', err);
  }

  private async renderFrame(frame: Frame): Promise<void> {
    if (!this.project) {
      this.clearCanvas();
      return;
    }

    // Collect visible layers at this frame
    const layers = this.getVisibleLayers(frame);

    if (layers.length === 0) {
      this.clearCanvas();
      return;
    }

    // Clear
    this.ctx.fillStyle = this.project.settings.backgroundColor;
    this.ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);

    // Sort by track order (lower order = rendered first = behind)
    const tracks = this.project.timeline.tracks;
    layers.sort((a, b) => {
      const trackA = tracks.find((t) => t.id === a.trackId)?.order ?? 0;
      const trackB = tracks.find((t) => t.id === b.trackId)?.order ?? 0;
      return trackA - trackB;
    });

    // Render each layer
    for (const clip of layers) {
      if (clip.type === 'title') {
        this.renderTitleLayer(clip);
        continue;
      }
      await this.renderLayer(clip, frame);
    }
  }

  /**
   * Draw a title clip's text, centered in its box (R3 foundation). The
   * export path renders the same content via FFmpeg drawtext with the same
   * centered alignment; fonts differ by platform but size ratio and color
   * are shared through the clip fields.
   */
  private renderTitleLayer(clip: Clip): void {
    if (!this.project || !clip.text) return;
    const fontSize = Math.max(
      8,
      Math.round((clip.titleSizeRatio ?? 0.09) * this.project.settings.height),
    );
    this.ctx.save();
    this.ctx.globalAlpha = clip.opacity;

    // The font must be set before any measureText: the fitted background box
    // has to wrap the same glyphs the fill will draw, or preview and export
    // disagree about the box size (#507).
    const weight = clip.titleBold ? 'bold ' : '';
    const family = clip.titleFontFamily || 'system-ui, sans-serif';
    this.ctx.font = `${weight}${fontSize}px ${family}`;

    // Case is applied to the string itself so every consumer — background
    // measurement, stroke, fill, drawtext — sees identical glyphs (upstream
    // #330). Line spacing adds to the shared 1.2 leading.
    const textLines = applyTitleFontCase(clip.text, clip.titleFontCase).split('\n');
    const lineSpacing = clip.titleLineSpacing ?? 0;
    const lineH = fontSize * 1.2 + lineSpacing;

    // Background box behind text, fitted per longest line with symmetric
    // padding — matching drawtext's boxborderw on all four sides (#507).
    if (clip.titleBackgroundColor) {
      let maxW = 0;
      for (const line of textLines) {
        const m = this.ctx.measureText(line);
        if (m.width > maxW) maxW = m.width;
      }
      const pad = Math.round(
        clip.titleBackgroundPadding ?? TITLE_BACKGROUND_PADDING_DEFAULT,
      );
      const blockH = textLines.length * fontSize * 1.2 + (textLines.length - 1) * lineSpacing;
      const centerX = clip.x + clip.width / 2;
      const centerY = clip.y + clip.height / 2;
      this.ctx.fillStyle = clip.titleBackgroundColor;
      this.ctx.fillRect(
        centerX - maxW / 2 - pad,
        centerY - blockH / 2 - pad,
        maxW + pad * 2,
        blockH + pad * 2,
      );
    }

    this.ctx.fillStyle = clip.titleColor ?? '#ffffff';
    this.ctx.textAlign = clip.titleAlign === 'left' ? 'left' : clip.titleAlign === 'right' ? 'right' : 'center';
    this.ctx.textBaseline = 'middle';

    // Stroke outline behind fill
    if (clip.titleStrokeWidth && clip.titleStrokeWidth > 0 && clip.titleStrokeColor) {
      this.ctx.strokeStyle = clip.titleStrokeColor;
      this.ctx.lineWidth = clip.titleStrokeWidth * 2; // canvas strokes centered
      this.ctx.lineJoin = 'round';
      const centerX = clip.x + clip.width / 2;
      const centerY = clip.y + clip.height / 2;
      for (const [i, line] of textLines.entries()) {
        const y = centerY + (i - (textLines.length - 1) / 2) * lineH;
        this.ctx.strokeText(line, centerX, y);
      }
    }

    const align = clip.titleAlign === 'left' ? 'left' : clip.titleAlign === 'right' ? 'right' : 'center';
    this.ctx.textAlign = align as CanvasTextAlign;
    const centerX = align === 'left' ? clip.x : align === 'right' ? clip.x + clip.width : clip.x + clip.width / 2;
    const centerY = clip.y + clip.height / 2;
    for (const [i, line] of textLines.entries()) {
      const y = centerY + (i - (textLines.length - 1) / 2) * lineH;
      this.ctx.fillText(line, centerX, y);
    }
    this.ctx.restore();
  }

  private async renderLayer(clip: Clip, currentFrame: Frame): Promise<void> {
    // Calculate source timestamp for this clip at current frame
    const clipLocalFrame = currentFrame - clip.startFrame + clip.inPoint;
    const timestampSec = frameToSeconds(clipLocalFrame, this.fps);

    // Get or load the frame image
    const bitmap = await this.getFrameBitmap(clip, timestampSec);
    if (!bitmap) return;

    // Apply transforms
    this.ctx.save();
    this.ctx.globalAlpha = clip.opacity;
    // Color grading (R4): Chromium canvas filter matches FFmpeg eq filter.
    const grade = colorGradeOf(clip);
    if (grade) {
      this.ctx.filter = toCanvasFilter(grade);
    }

    // Transform: translate to position, rotate around anchor, scale
    const cx = clip.x + clip.anchorX;
    const cy = clip.y + clip.anchorY;

    this.ctx.translate(cx, cy);
    if (clip.rotation !== 0) {
      this.ctx.rotate((clip.rotation * Math.PI) / 180);
    }
    this.ctx.scale(clip.scaleX, clip.scaleY);
    this.ctx.translate(-clip.anchorX, -clip.anchorY);

    // Draw
    this.ctx.drawImage(bitmap, 0, 0, clip.width, clip.height);
    this.ctx.restore();
  }

  private async getFrameBitmap(clip: Clip, timestampSec: number): Promise<ImageBitmap | null> {
    const cacheKey = `${clip.assetId}_${Math.round(timestampSec * 1000)}`;

    // Check renderer-side cache
    const cached = this.frameCache.get(cacheKey);
    if (cached) return cached;

    // For images (still frames), load once and cache
    if (clip.type === 'image') {
      return this.loadImageAsset(clip.assetId, cacheKey);
    }

    // For video clips, request frame from main process
    try {
      const result = await window.palmier.media.thumbnail(
        clip.assetId, // In real impl, resolve assetId → file path via project store
        '', // outputDir handled by main
        timestampSec,
      );

      if (result.success && result.path) {
        const response = await fetch(`file://${result.path}`);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        this.frameCache.set(cacheKey, bitmap);
        return bitmap;
      }
    } catch (err) {
      // Fallback: show placeholder
      this.config.onError?.(`Frame decode failed: ${err}`);
    }

    return null;
  }

  private async loadImageAsset(assetId: string, cacheKey: string): Promise<ImageBitmap | null> {
    const cached = this.frameCache.get(cacheKey);
    if (cached) return cached;

    try {
      // In full implementation, resolve assetId to file path from project.media
      const asset = this.project?.media.find((m) => m.id === assetId);
      if (!asset) return null;

      const response = await fetch(`file://${asset.path}`);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      this.frameCache.set(cacheKey, bitmap);
      return bitmap;
    } catch {
      return null;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private getVisibleLayers(frame: Frame): Clip[] {
    if (!this.project) return [];
    return this.project.timeline.clips.filter((clip) => {
      const clipEnd = clip.startFrame + clip.durationFrames;
      const track = this.project?.timeline.tracks.find(
        (candidate) => candidate.id === clip.trackId,
      );
      return clip.type !== 'audio'
        && track?.visible !== false
        && frame >= clip.startFrame
        && frame < clipEnd;
    });
  }

  private getProjectDuration(): Frame {
    if (!this.project) return 0;
    const clips = this.project.timeline.clips;
    if (clips.length === 0) return 0;
    return Math.max(...clips.map((c) => c.startFrame + c.durationFrames));
  }

  private clearCanvas(): void {
    const bg = this.project?.settings.backgroundColor || '#000000';
    this.ctx.fillStyle = bg;
    this.ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
  }

  private prefetchFrames(): void {
    if (!this.project) return;

    // Look ahead and preload frames that will be needed soon
    const lookAhead = this.playbackRate > 0 ? this.prefetchAhead : -this.prefetchAhead;
    const targetFrame = this.playheadFrame + lookAhead;

    const layers = this.getVisibleLayers(targetFrame);
    for (const clip of layers) {
      const clipLocalFrame = targetFrame - clip.startFrame + clip.inPoint;
      const ts = frameToSeconds(clipLocalFrame, this.fps);
      const cacheKey = `${clip.assetId}_${Math.round(ts * 1000)}`;

      if (!this.frameCache.has(cacheKey) && !this.prefetchPending.has(cacheKey)) {
        this.prefetchPending.add(cacheKey);
        // Detached and genuinely ignorable: a prefetch miss only costs the
        // decode being redone when the frame is actually needed. The pending
        // marker must be cleared either way or the key is never retried.
        void this.getFrameBitmap(clip, ts)
          .catch(() => null)
          .finally(() => {
            this.prefetchPending.delete(cacheKey);
          });
      }
    }
  }
}
