/**
 * PreviewCompositor  orchestrates frame decoding and GPU composition
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
import { getFrameDecoder, type DecodeRequest } from './frame-decoder';
import { blendModeToIndex } from '../../shared/types/blend-mode';
import { effectiveOpacity } from '../../shared/editor/fade';
import { wipeParamsFor, slideOffsetFor } from '../../shared/editor/transition';
import type { Project, Clip, Frame } from '../../shared/types/project';
import {
  assetDurationSeconds,
  clampSourceSeconds,
  isSourceSeekable,
  sourceSecondsForTimelineFrame,
} from '../../shared/media/source-time';
import { LatestRequestGate, type RequestToken } from './latest-request';
import { effectiveSourcePath } from '../../shared/media/proxy';
import { ByteBudgetLru } from './render-cache';
import { loadProxyMode } from './proxy-mode';

//  Types 

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

//  Preview Compositor 

export class PreviewCompositor {
  private project: Project | null = null;
  private nativeAddon: any = null;
  private readonly requests = new LatestRequestGate<number>();

  /**
   * Render cache (roadmap R2): composited frames keyed by project revision
   * token + frame + size. Any edit replaces the project object wholesale
   * (immutable model), which mints a new token and orphans the previous
   * generation's entries -- correctness for free. Scrub-backs, loops and
   * pause/resume inside one revision then skip decode+compose entirely.
   */
  private readonly renderCache = new ByteBudgetLru<Buffer>(256 * 1024 * 1024);
  private readonly projectTokens = new WeakMap<Project, number>();
  private nextToken = 1;

  constructor() {}

  setProject(project: Project): void {
    if (project !== this.project) {
      this.requests.invalidateAll();
    }
    this.project = project;
  }

  private tokenFor(project: Project): number {
    let id = this.projectTokens.get(project);
    if (id === undefined) {
      id = this.nextToken;
      this.nextToken += 1;
      this.projectTokens.set(project, id);
    }
    return id;
  }

  setNativeAddon(addon: any): void {
    this.nativeAddon = addon;
  }

  /**
   * Composite a single frame and send the result to the renderer.
   */
  async compositeFrame(frameIndex: Frame, win: BrowserWindow): Promise<void> {
    const project = this.project;
    if (!project) return;

    const request = this.requests.begin(win.webContents.id);
    const { width, height } = project.settings;

    // Render-cache hit (R2): scrub-backs, loops and pause/resume inside one
    // project revision skip decode + GPU composition entirely.
    const cacheKey = `${this.tokenFor(project)}:${frameIndex}:${width}x${height}`;
    const cached = this.renderCache.get(cacheKey);
    if (cached) {
      this.sendFrame(win, request, cached);
      return;
    }

    const composited = await this.composeToBuffer(project, frameIndex, width, height, request);
    if (composited === null || !this.requests.isCurrent(request)) return;

    this.renderCache.set(cacheKey, composited, composited.length);
    this.sendFrame(win, request, composited);
  }

  /**
   * Decode every visible layer at a frame and run the native composition.
   * Returns null when nothing could be composed or a newer request for the
   * same window superseded this one.
   */
  private async composeToBuffer(
    project: Project,
    frameIndex: Frame,
    width: number,
    height: number,
    request: RequestToken<number>,
  ): Promise<Buffer | null> {
    // Find visible clips at this frame (sorted by track order  z-index)
    const visibleClips = this.getVisibleClips(project, frameIndex);
    if (visibleClips.length === 0) {
      return Buffer.alloc(width * height * 4);
    }

    // Decode frames for each visible clip
    const decoder = getFrameDecoder();
    const layerDescs: GpuLayerDesc[] = [];
    const buffers: Buffer[] = [];

    for (const clip of visibleClips) {
      // Find the media asset
      const asset = project.media.find((m) => m.id === clip.assetId);
      if (!asset) continue;

      const decodeRequest = this.decodeRequestForClip(project, clip, frameIndex);
      if (!decodeRequest) continue;

      const decoded = await decoder.getFrame(decodeRequest);
      const frameBuffer = decoded?.data || null;

      if (!this.requests.isCurrent(request)) return null;
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
      return Buffer.alloc(width * height * 4);
    }

    // Concatenate all layer buffers
    const concatenated = Buffer.concat(buffers);

    // Call native compositor
    if (this.nativeAddon?.compositeFrameGpu) {
      return this.nativeAddon.compositeFrameGpu(
        JSON.stringify(layerDescs),
        concatenated,
        width,
        height,
      );
    }
    // Fallback: just send first layer (degraded preview)
    return buffers[0] ?? Buffer.alloc(width * height * 4);
  }

  /**
   * Prefetch frames for smooth playback.
   */
  async prefetchFrames(frames: Frame[]): Promise<void> {
    const project = this.project;
    if (!project) return;

    const decoder = getFrameDecoder();
    const { width, height } = project.settings;
    const tokenForProject = this.tokenFor(project);

    for (const frameIndex of frames) {
      // Render cache first (R2): an already-composited frame needs no
      // source decode at all, so prefetching it would only thrash.
      const cacheKey = `${tokenForProject}:${frameIndex}:${width}x${height}`;
      if (this.renderCache.get(cacheKey)) continue;

      const requests = this.decodeRequestsForFrame(project, frameIndex);
      if (requests.length > 0) {
        await decoder.prefetch(requests);
      }
    }
  }

  //  Helpers 

  /**
   * Decode requests for every visible clip at a frame.
   *
   * Prefetch and composite share this so a prefetched frame is addressed exactly
   * as the composite will ask for it; a mismatch would warm the cache with
   * entries the composite never reads and decode everything twice.
   */
  private decodeRequestsForFrame(project: Project, frameIndex: Frame): DecodeRequest[] {
    const requests: DecodeRequest[] = [];
    for (const clip of this.getVisibleClips(project, frameIndex)) {
      const request = this.decodeRequestForClip(project, clip, frameIndex);
      if (request) requests.push(request);
    }
    return requests;
  }

  /**
   * The single decode request for one clip at one timeline frame, or null when
   * the clip cannot contribute a frame.
   */
  private decodeRequestForClip(
    project: Project,
    clip: Clip,
    frameIndex: Frame,
  ): DecodeRequest | null {
    const asset = project.media.find((m) => m.id === clip.assetId);
    if (!asset) return null;
    const size = { width: clip.width, height: clip.height };

    // Preview decodes from the proxy when one exists; exports always read
    // the original (R2 proxy policy, shared/media/proxy.ts).
    const sourcePath = effectiveSourcePath(asset, 'preview', loadProxyMode());

    // A still image has one frame; there is nothing to seek.
    if (asset.type === 'image') {
      return { assetPath: sourcePath, ...size, sourceSeconds: 0 };
    }
    if (asset.type !== 'video') return null;

    // Timeline frames convert to source seconds through the PROJECT frame rate;
    // the source's own rate does not affect the seek target (#68).
    const fps = project.settings.fps;
    const durationSeconds = assetDurationSeconds(asset, fps);
    const requested = sourceSecondsForTimelineFrame(clip, frameIndex, fps);
    // A seek past the end of the source can never produce a frame, and asking
    // anyway makes the decoder scan the file until it times out.
    if (!isSourceSeekable(requested, durationSeconds)) return null;

    return {
      assetPath: sourcePath,
      ...size,
      sourceSeconds: clampSourceSeconds(requested, durationSeconds, asset.fps),
    };
  }

  private getVisibleClips(project: Project, frameIndex: Frame): Clip[] {
    return project.timeline.clips
      .filter((clip) => {
        const clipEnd = clip.startFrame + clip.durationFrames;
        const track = project.timeline.tracks.find((candidate) => candidate.id === clip.trackId);
        return clip.type !== 'audio'
          && track?.visible !== false
          && frameIndex >= clip.startFrame
          && frameIndex < clipEnd;
      })
      .sort((a, b) => {
        // Sort by track order (video tracks with higher order render on top)
        const trackA = project.timeline.tracks.find((t) => t.id === a.trackId);
        const trackB = project.timeline.tracks.find((t) => t.id === b.trackId);
        return (trackA?.order || 0) - (trackB?.order || 0);
      });
  }

  private sendFrame(
    win: BrowserWindow,
    request: RequestToken<number>,
    frame: Buffer,
  ): void {
    if (!this.requests.isCurrent(request) || win.isDestroyed()) return;
    win.webContents.send('preview:frame', frame);
  }
}

//  Register IPC handlers 

let compositorInstance: PreviewCompositor | null = null;

export function getPreviewCompositor(): PreviewCompositor {
  if (!compositorInstance) {
    compositorInstance = new PreviewCompositor();
  }
  return compositorInstance;
}

export function registerPreviewHandlers(getProject: () => Project | null): void {
  const compositor = getPreviewCompositor();

  ipcMain.handle('preview:composite-frame', async (event, frameIndex: number) => {
    const project = getProject();
    if (project) compositor.setProject(project);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      await compositor.compositeFrame(frameIndex, win);
    }
  });

  ipcMain.handle('preview:prefetch', async (_event, frames: number[]) => {
    const project = getProject();
    if (project) compositor.setProject(project);
    await compositor.prefetchFrames(frames);
  });
}
