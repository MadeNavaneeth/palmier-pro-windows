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
import { visualClipsAtFrame } from './visible-clips';
import { isCropped, cropRect } from '../../shared/media/source-crop';
import { evaluateMotion } from '../../shared/media/motion';
import { chromaKeyOf, applyChromaKey } from '../../shared/editor/chroma-key';

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

/** Renderer-rasterized title-clip RGBA, keyed by clip id (title-preview parity). */
export interface TitleRasterInput {
  clipId: string;
  width: number;
  height: number;
  /** Canvas position to place this raster at (top-left origin). See title-raster-cache.ts. */
  x: number;
  y: number;
  rgba: Uint8Array | Buffer;
}

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
   *
   * `titles` are renderer-rasterized title-clip layers for this exact
   * frame (title clips have no decodable media asset, so the renderer's
   * canvas/font engine produces their pixels and hands them in here rather
   * than this compositor decoding them). A title's rasterized content is a
   * pure function of its Clip fields, which live inside the project object,
   * so the existing project-token cache key already invalidates correctly
   * on a style/text edit -- no extra key material needed.
   */
  async compositeFrame(
    frameIndex: Frame,
    win: BrowserWindow,
    titles: TitleRasterInput[] = [],
  ): Promise<void> {
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

    const composited = await this.composeToBuffer(project, frameIndex, width, height, request, titles);
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
    titles: TitleRasterInput[] = [],
  ): Promise<Buffer | null> {
    // Find visible clips at this frame (sorted by track order  z-index).
    // One O(clips+tracks) pass (#556); the media index below spares the
    // per-clip asset scans as well.
    const visibleClips = visualClipsAtFrame(project, frameIndex);
    if (visibleClips.length === 0) {
      return Buffer.alloc(width * height * 4);
    }
    const mediaById = new Map(project.media.map((asset) => [asset.id, asset] as const));
    const titleByClipId = new Map(titles.map((title) => [title.clipId, title] as const));

    // Decode frames for each visible clip
    const decoder = getFrameDecoder();
    const layerDescs: GpuLayerDesc[] = [];
    const buffers: Buffer[] = [];

    for (const clip of visibleClips) {
      // Title clips carry no decodable media asset -- the renderer already
      // rasterized this frame's title layers (title-raster-cache.ts) and
      // handed the RGBA in via `titles`; a title with no matching entry
      // (renderer hasn't caught up yet, or drawTitle produced nothing for
      // empty text) contributes no layer rather than blocking the frame.
      if (clip.type === 'title') {
        const raster = titleByClipId.get(clip.id);
        if (!raster) continue;
        const wipe = wipeParamsFor(clip, frameIndex);
        const slide = slideOffsetFor(clip, frameIndex);
        layerDescs.push({
          width: raster.width,
          height: raster.height,
          // raster.x/y is the box position title-raster-cache.ts already
          // resolved (the clip's own box for a plain title, the canvas
          // origin for an advanced/baked one) -- title clips cannot carry a
          // position motion track (set_clip_motion refuses non-video/image
          // clips, and transferClipSettings never copies motion fields), so
          // unlike the video/image branch below there is no motion track to
          // evaluate here.
          x: Math.round(raster.x + slide.dx),
          y: Math.round(raster.y + slide.dy),
          opacity: effectiveOpacity(clip, frameIndex),
          // Export's title paths (drawtext and the baked overlay) never
          // rotate, scale, or offset-anchor a title, so this layer keeps an
          // identity transform to match -- a rotated/scaled title in preview
          // that exported unrotated would be a worse bug than the one this
          // branch fixes.
          rotation_deg: 0,
          scale_x: 1,
          scale_y: 1,
          anchor_x: 0,
          anchor_y: 0,
          blend_mode: blendModeToIndex(clip.blendMode),
          wipe_mode: wipe.mode,
          wipe_progress: wipe.progress,
          wipe_softness: wipe.softness,
        });
        buffers.push(Buffer.isBuffer(raster.rgba) ? raster.rgba : Buffer.from(raster.rgba));
        continue;
      }

      // Find the media asset
      const asset = mediaById.get(clip.assetId);
      if (!asset) continue;

      const decodeRequest = this.decodeRequestForClip(project, clip, frameIndex, mediaById);
      if (!decodeRequest) continue;

      const decoded = await decoder.getFrame(decodeRequest);
      if (!decoded || !this.requests.isCurrent(request)) return null;
      let frameBuffer: Buffer = decoded.data;
      let frameWidth = decoded.width;
      let frameHeight = decoded.height;

      // Static crop (#568): proportional sub-rect of the decoded (uniformly
      // scaled) frame is pixel-equivalent to cropping the source ahead of
      // scale, so preview and export agree without native descriptor changes.
      const crop = clip.crop;
      if (isCropped(crop) && frameWidth > 0 && frameHeight > 0) {
        const rect = cropRect(crop, frameWidth, frameHeight);
        const cropped = Buffer.alloc(rect.width * rect.height * 4);
        for (let row = 0; row < rect.height; row++) {
          const srcStart = ((rect.y + row) * frameWidth + rect.x) * 4;
          decoded.data.copy(
            cropped,
            row * rect.width * 4,
            srcStart,
            srcStart + rect.width * 4,
          );
        }
        frameBuffer = cropped;
        frameWidth = rect.width;
        frameHeight = rect.height;
      }

      // Chroma key (#97): same per-pixel pass export's FFmpeg colorkey+despill
      // chain performs, run here so the live preview shows the keyed result
      // instead of only the exported file. Before the native compositor's
      // rotation/blend so a keyed-out pixel's alpha is not later touched by
      // an unrelated stage.
      const chromaKey = chromaKeyOf(clip);
      if (chromaKey) {
        // The GPU layer texture the native addon uploads is read-only from
        // its perspective, so this buffer must already carry the final
        // pixels; frameBuffer may still be the decoder's shared buffer here,
        // so copy before mutating in place.
        if (frameBuffer === decoded.data) frameBuffer = Buffer.from(frameBuffer);
        applyChromaKey(frameBuffer, chromaKey);
      }

      const wipe = wipeParamsFor(clip, frameIndex);
      const slide = slideOffsetFor(clip, frameIndex);

      layerDescs.push({
        width: frameWidth,
        height: frameHeight,
        // Motion tracks (keyframes v1) override static x/y; cropping keeps the
        // box centered since it shrinks the source rather than moving it.
        x: Math.round(
          (evaluateMotion(clip.motionX, frameIndex) ?? clip.x)
          + (clip.width - frameWidth) / 2
          + slide.dx,
        ),
        y: Math.round(
          (evaluateMotion(clip.motionY, frameIndex) ?? clip.y)
          + (clip.height - frameHeight) / 2
          + slide.dy,
        ),
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
    const mediaById = new Map(project.media.map((asset) => [asset.id, asset] as const));
    for (const clip of visualClipsAtFrame(project, frameIndex)) {
      const request = this.decodeRequestForClip(project, clip, frameIndex, mediaById);
      if (request) requests.push(request);
    }
    return requests;
  }

  /**
   * The single decode request for one clip at one timeline frame, or null when
   * the clip cannot contribute a frame. `mediaById` is the caller's per-pass
   * asset index; building it here would reintroduce a scan per clip.
   */
  private decodeRequestForClip(
    project: Project,
    clip: Clip,
    frameIndex: Frame,
    mediaById: ReadonlyMap<string, Project['media'][number]>,
  ): DecodeRequest | null {
    const asset = mediaById.get(clip.assetId);
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

  ipcMain.handle('preview:composite-frame', async (event, frameIndex: number, titles?: TitleRasterInput[]) => {
    const project = getProject();
    if (project) compositor.setProject(project);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      await compositor.compositeFrame(frameIndex, win, Array.isArray(titles) ? titles : []);
    }
  });

  ipcMain.handle('preview:prefetch', async (_event, frames: number[]) => {
    const project = getProject();
    if (project) compositor.setProject(project);
    await compositor.prefetchFrames(frames);
  });
}

