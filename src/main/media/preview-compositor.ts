/**
 * PreviewCompositor — orchestrates frame decoding and GPU composition
 * for the real-time preview. Lives in the main process.
 *
 * Flow:
 * 1. Renderer requests composite for frame N via IPC
 * 2. This module resolves which clips are visible at frame N
 * 3. Decodes needed frames via FrameDecoder
 * 4. Calls native composite_frame_gpu() with layer descriptors + RGBA buffers
 * 5. Sends the composited buffer back to the renderer via IPC event
 */

import { BrowserWindow, ipcMain } from 'electron';
import { getFrameDecoder } from './frame-decoder';
import { blendModeToIndex } from '../../shared/types/blend-mode';
import { effectiveOpacity } from '../../shared/editor/fade';
import { wipeParamsFor, slideOffsetFor } from '../../shared/editor/transition';
import type { Project, Clip, Frame } from '../../shared/types/project';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GpuLayerDesc {
  width: number;
  height: number;
  x: number;
  y: number;
  opacity: number;
  rotation_deg: number;
  scale_x: number;
  scale_y: number;
  anchor_x: number;
  anchor_y: number;
  blend_mode: number;
  wipe_mode: number;
  wipe_progress: number;
  wipe_softness: number;
}

// ─── Preview Compositor ──────────────────────────────────────────────────────

export class PreviewCompositor {
  private project: Project | null = null;
  private nativeAddon: any = null;

  constructor() {}

  setProject(project: Project): void {
    this.project = project;
  }

  setNativeAddon(addon: any): void {
    this.nativeAddon = addon;
  }

  /**
   * Composite a single frame and send the result to the renderer.
   */
  async compositeFrame(frameIndex: Frame, win: BrowserWindow): Promise<void> {
    if (!this.project) return;

    const { settings, timeline } = this.project;
    const { width, height, fps } = settings;

    // Find visible clips at this frame (sorted by track order → z-index)
    const visibleClips = this.getVisibleClips(frameIndex);
    if (visibleClips.length === 0) {
      // Send a black frame
      const blackFrame = Buffer.alloc(width * height * 4);
      win.webContents.send('preview:frame', blackFrame);
      return;
    }

    // Decode frames for each visible clip
    const decoder = getFrameDecoder();
    const layerDescs: GpuLayerDesc[] = [];
    const buffers: Buffer[] = [];

    for (const clip of visibleClips) {
      // Calculate source frame within the clip
      const clipLocalFrame = frameIndex - clip.startFrame + clip.inPoint;

      // Find the media asset
      const asset = this.project.media.find((m) => m.id === clip.assetId);
      if (!asset) continue;

      let frameBuffer: Buffer | null = null;

      if (asset.type === 'image') {
        // Images: decode once, always the same frame
        const decoded = await decoder.getFrame({
          assetPath: asset.path,
          width: clip.width,
          height: clip.height,
          fps: 1,
          frameIndex: 0,
        });
        frameBuffer = decoded?.data || null;
      } else if (asset.type === 'video') {
        const decoded = await decoder.getFrame({
          assetPath: asset.path,
          width: clip.width,
          height: clip.height,
          fps: asset.fps || fps,
          frameIndex: clipLocalFrame,
        });
        frameBuffer = decoded?.data || null;
      }

      if (!frameBuffer) continue;

      const wipe = wipeParamsFor(clip, frameIndex);
      const slide = slideOffsetFor(clip, frameIndex);

      layerDescs.push({
        width: clip.width,
        height: clip.height,
        // Slide transitions offset the layer position over the transition window.
        x: clip.x + slide.dx,
        y: clip.y + slide.dy,
        // Fade ramps multiply the base opacity (transition rendering).
        opacity: effectiveOpacity(clip, frameIndex),
        rotation_deg: clip.rotation,
        scale_x: clip.scaleX,
        scale_y: clip.scaleY,
        anchor_x: clip.anchorX,
        anchor_y: clip.anchorY,
        blend_mode: blendModeToIndex(clip.blendMode),
        wipe_mode: wipe.mode,
        wipe_progress: wipe.progress,
        wipe_softness: wipe.softness,
      });
      buffers.push(frameBuffer);
    }

    if (layerDescs.length === 0) {
      const blackFrame = Buffer.alloc(width * height * 4);
      win.webContents.send('preview:frame', blackFrame);
      return;
    }

    // Concatenate all layer buffers
    const concatenated = Buffer.concat(buffers);

    // Call native compositor
    let composited: Buffer;
    if (this.nativeAddon?.compositeFrameGpu) {
      composited = this.nativeAddon.compositeFrameGpu(
        JSON.stringify(layerDescs),
        concatenated,
        width,
        height,
      );
    } else {
      // Fallback: just send first layer (degraded preview)
      composited = buffers[0] || Buffer.alloc(width * height * 4);
    }

    // Send to renderer
    win.webContents.send('preview:frame', composited);
  }

  /**
   * Prefetch frames for smooth playback.
   */
  async prefetchFrames(frames: Frame[]): Promise<void> {
    if (!this.project) return;

    const decoder = getFrameDecoder();
    const { settings } = this.project;

    for (const frameIndex of frames) {
      const visibleClips = this.getVisibleClips(frameIndex);
      const requests = visibleClips.map((clip) => {
        const asset = this.project!.media.find((m) => m.id === clip.assetId);
        if (!asset) return null;
        const clipLocalFrame = frameIndex - clip.startFrame + clip.inPoint;
        return {
          assetPath: asset.path,
          width: clip.width,
          height: clip.height,
          fps: asset.type === 'image' ? 1 : (asset.fps || settings.fps),
          frameIndex: asset.type === 'image' ? 0 : clipLocalFrame,
        };
      }).filter(Boolean) as any[];

      if (requests.length > 0) {
        await decoder.prefetch(requests);
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private getVisibleClips(frameIndex: Frame): Clip[] {
    if (!this.project) return [];

    return this.project.timeline.clips
      .filter((clip) => {
        const clipEnd = clip.startFrame + clip.durationFrames;
        return frameIndex >= clip.startFrame && frameIndex < clipEnd;
      })
      .sort((a, b) => {
        // Sort by track order (video tracks with higher order render on top)
        const trackA = this.project!.timeline.tracks.find((t) => t.id === a.trackId);
        const trackB = this.project!.timeline.tracks.find((t) => t.id === b.trackId);
        return (trackA?.order || 0) - (trackB?.order || 0);
      });
  }
}

// ─── Register IPC handlers ───────────────────────────────────────────────────

let compositorInstance: PreviewCompositor | null = null;

export function getPreviewCompositor(): PreviewCompositor {
  if (!compositorInstance) {
    compositorInstance = new PreviewCompositor();
  }
  return compositorInstance;
}

export function registerPreviewHandlers(): void {
  const compositor = getPreviewCompositor();

  ipcMain.handle('preview:composite-frame', async (event, frameIndex: number) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      await compositor.compositeFrame(frameIndex, win);
    }
  });

  ipcMain.handle('preview:prefetch', async (_event, frames: number[]) => {
    await compositor.prefetchFrames(frames);
  });
}
