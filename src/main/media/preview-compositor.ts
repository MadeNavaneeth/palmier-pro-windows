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
import { effectiveOpacity, fadeMultiplier } from '../../shared/editor/fade';
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
import { downscaleRgba, thumbnailSize } from '../../shared/media/thumbnail';
import { isCropped, cropRect } from '../../shared/media/source-crop';
import { evaluateMotion } from '../../shared/media/motion';
import { chromaKeyOf, applyChromaKey } from '../../shared/editor/chroma-key';
import { applyGradeToRgba, colorGradeOf } from '../../shared/editor/color-grade';
import { applyEffectsToRgba, effectsOf } from '../../shared/editor/effects';
import { applyEdgeEffectsToRgba, hasEdgeEffects } from '../../shared/editor/edge-effects';
import { resolvePreviewLut } from './lut-loader';
import { findNestedClip, resolveRenderTimeline } from '../../shared/editor/compound';
import { loadNativeAddon } from '../ipc/system';
import type { SessionSender } from '../sessions';

/**
 * Stable prefix the Rust addon puts on a lost-device failure, kept in step with
 * `native/src/gpu.rs::DEVICE_LOST_MARKER`.
 *
 * The addon has no way to push an event into the renderer, so the error message
 * is the only channel device loss can travel on. It is a marker rather than
 * prose because the caller has to act on it: retry, or latch and degrade.
 */
const GPU_DEVICE_LOST = 'PALMIER_GPU_DEVICE_LOST';

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

/**
 * Resolve opacity at a timeline frame. A track is authoritative; otherwise
 * preserve the historical static-opacity × fade path byte-for-byte.
 */
function effectiveAnimatedOpacity(clip: Clip, frame: Frame): number {
  const animated = evaluateMotion(clip.opacityTrack, frame);
  if (animated === undefined) return effectiveOpacity(clip, frame);
  return Math.min(1, Math.max(0, animated)) * fadeMultiplier(clip, frame);
}

/**
 * The no-addon / native-failure degradation: the bottom visible layer alone,
 * blitted onto a canvas-sized transparent frame at its own (x, y).
 *
 * "First layer only" still has to be a *frame*. Both consumers require exactly
 * `width * height * 4` bytes -- PreviewCanvas drops any other payload, and
 * renderThumbnail box-samples the same buffer -- so returning the layer's own
 * bytes published nothing at all, which is a worse degradation than the one
 * this path documents.
 *
 * Deliberately still just a blit: no opacity, blend mode, wipe or transform, so
 * this stays the "first layer, nothing else" preview rather than a second
 * compositor. Positions are truncated the way the native path truncates them
 * (`f32 as i32` in the CPU fallback) so the degraded frame lands where the real
 * one would have.
 */
function firstLayerOnCanvas(
  layer: GpuLayerDesc,
  rgba: Buffer,
  width: number,
  height: number,
): Buffer {
  const canvas = Buffer.alloc(width * height * 4);
  const lx = Math.trunc(layer.x);
  const ly = Math.trunc(layer.y);
  // Clip the layer rectangle to the canvas; nothing to copy means the layer is
  // entirely off-screen and the frame stays transparent.
  const x0 = Math.max(0, lx);
  const y0 = Math.max(0, ly);
  const x1 = Math.min(width, lx + layer.width);
  const y1 = Math.min(height, ly + layer.height);
  for (let y = y0; y < y1; y++) {
    const srcStart = ((y - ly) * layer.width + (x0 - lx)) * 4;
    rgba.copy(canvas, (y * width + x0) * 4, srcStart, srcStart + (x1 - x0) * 4);
  }
  return canvas;
}

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
  /**
   * Set once the native composite call has thrown, so a broken addon costs one
   * failed call per session instead of one per frame. See composeNative.
   */
  private nativeCompositeFailed = false;
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

  /**
   * Marker thumbnails (upstream #552) run on their own latest-wins gate so a
   * scroll through the marker list cannot cancel the live preview's frame
   * requests, and a burst of rows only ever publishes the newest result.
   */
  private readonly thumbnailRequests = new LatestRequestGate<number>();
  /**
   * Bounded by entry count, keyed by project token + frame + size, so an
   * edit (which mints a new token) invalidates every entry at once. The
   * bound matters because each entry holds decoded pixels.
   */
  private readonly thumbnailCache = new Map<string, { width: number; height: number; rgba: Buffer }>();

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
    // Compound clips expand to ordinary clips with composed transforms
    // (shared/editor/compound.ts), so visibility, layering, grade, motion,
    // and decode below all run on one flat shape — identical to export.
    const view: Project = { ...project, timeline: resolveRenderTimeline(project) };
    // Find visible clips at this frame (sorted by track order  z-index).
    // One O(clips+tracks) pass (#556); the media index below spares the
    // per-clip asset scans as well.
    const visibleClips = visualClipsAtFrame(view, frameIndex);
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
        // Nested titles: the renderer rasterizes box content from the STORED
        // (inner) fields, while this layer resolves the composed placement —
        // the delta keeps preview on the same box export composites.
        const storedTitle = findNestedClip(project, clip.id);
        const titleDx = storedTitle ? clip.x - storedTitle.x : 0;
        const titleDy = storedTitle ? clip.y - storedTitle.y : 0;
        layerDescs.push({
          width: raster.width,
          height: raster.height,
          // raster.x/y is the box position title-raster-cache.ts already
          // resolved (the clip's own box for a plain title, the canvas
          // origin for an advanced/baked one) -- title clips cannot carry a
          // position motion track (set_clip_motion refuses title clips, and
          // transferClipSettings never copies motion fields), so unlike the
          // video/image branch below there is no motion track to
          // evaluate here.
          x: Math.round(raster.x + titleDx + slide.dx),
          y: Math.round(raster.y + titleDy + slide.dy),
          opacity: effectiveAnimatedOpacity(clip, frameIndex),
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

      // Shape clips carry no decodable media asset either — the renderer
      // rasterized the vector box (shape-raster-cache.ts) and handed the
      // RGBA in through the same payload as titles. Unlike titles, the
      // raster is box content only, so this layer carries the clip's real
      // transform: motion tracks evaluate here exactly like the video/image
      // branch, and export's shape overlay applies the same expressions.
      if (clip.type === 'shape') {
        const raster = titleByClipId.get(clip.id);
        if (!raster) continue;
        const wipe = wipeParamsFor(clip, frameIndex);
        const slide = slideOffsetFor(clip, frameIndex);
        // Same raster/box split as titles: with no motion track the layer
        // sits on the renderer-computed box, shifted by the composed nest
        // offset; a motion track already carries composed values.
        const storedShape = findNestedClip(project, clip.id);
        const shapeDx = storedShape ? clip.x - storedShape.x : 0;
        const shapeDy = storedShape ? clip.y - storedShape.y : 0;
        layerDescs.push({
          width: raster.width,
          height: raster.height,
          x: Math.round(
            (evaluateMotion(clip.motionX, frameIndex) ?? (raster.x + shapeDx)) + slide.dx,
          ),
          y: Math.round(
            (evaluateMotion(clip.motionY, frameIndex) ?? (raster.y + shapeDy)) + slide.dy,
          ),
          opacity: effectiveAnimatedOpacity(clip, frameIndex),
          rotation_deg: evaluateMotion(clip.motionRot, frameIndex) ?? clip.rotation,
          scale_x: evaluateMotion(clip.motionScaleX, frameIndex) ?? clip.scaleX,
          scale_y: evaluateMotion(clip.motionScaleY, frameIndex) ?? clip.scaleY,
          anchor_x: clip.anchorX,
          anchor_y: clip.anchorY,
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

      // Color grade (#157): the same YUV math the export filters perform, run
      // here so the live preview shows the graded result instead of only the
      // exported file. After chroma (which decides alpha) and before the
      // native compositor's rotation/blend, like the export chain order. The
      // .cube table resolves once per frame through the cached loader; a
      // missing/unreadable LUT resolves to null and that stage degrades to
      // ungraded (the Inspector's validate IPC names the file).
      const grade = colorGradeOf(clip);
      if (grade) {
        if (frameBuffer === decoded.data) frameBuffer = Buffer.from(frameBuffer);
        applyGradeToRgba(frameBuffer, grade, resolvePreviewLut(grade.lut?.path) ?? undefined);
      }

      // Effects subgroups (#157: blur, grain, vignette, glow): neighborhood
      // and frame-animated stages the point-wise grade core cannot express,
      // run here in canonical order so the live preview shows them exactly
      // like the export chain. The grain frame is clip-local (timeline frame
      // minus clip start), matching the export's post-setpts counter.
      const effects = effectsOf(clip);
      if (effects) {
        if (frameBuffer === decoded.data) frameBuffer = Buffer.from(frameBuffer);
        applyEffectsToRgba(frameBuffer, frameWidth, frameHeight, effects, frameIndex - clip.startFrame);
      }

      // Edge rounding and softness (#369): apply the shared RGBA mask after
      // chroma, grade/effects/LUT, and before native rotation/scale/blend.
      // This is the same order as export's geq stage, which follows the
      // processed color/effects chain and precedes fades and overlay. The
      // guard keeps the identity path on the original decoder buffer and
      // byte-identical.
      if (hasEdgeEffects(clip)) {
        if (frameBuffer === decoded.data) frameBuffer = Buffer.from(frameBuffer);
        applyEdgeEffectsToRgba(
          frameBuffer,
          frameWidth,
          frameHeight,
          clip.edgeRounding,
          clip.edgeSoftness,
        );
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
        // Fade ramps multiply the resolved static/animated opacity (transition rendering).
        opacity: effectiveAnimatedOpacity(clip, frameIndex),
        // Motion tracks are absolute timeline-frame curves. Keep the static
        // fields as the fallback per axis so clips without tracks retain the
        // existing path byte-for-byte.
        rotation_deg: evaluateMotion(clip.motionRot, frameIndex) ?? clip.rotation,
        scale_x: evaluateMotion(clip.motionScaleX, frameIndex) ?? clip.scaleX,
        scale_y: evaluateMotion(clip.motionScaleY, frameIndex) ?? clip.scaleY,
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
    if (this.nativeAddon?.compositeFrameGpu && !this.nativeCompositeFailed) {
      const composed = this.composeNative(layerDescs, concatenated, width, height);
      if (composed) return composed;
    }
    // Fallback: the bottom visible layer alone, on a correctly sized canvas.
    return firstLayerOnCanvas(layerDescs[0]!, buffers[0]!, width, height);
  }

  /**
   * Run the native composite, or report that the addon cannot be used.
   *
   * The addon is a progressive enhancement, so a failing call has to degrade to
   * the first-layer fallback rather than reject: a rejected `preview:composite-
   * frame` invoke leaves the preview blank for that request and tells the caller
   * nothing, whereas the fallback is the behaviour the codebase already
   * documents as the degraded path.
   *
   * A lost GPU device is the one failure that must NOT latch. `GPU_DEVICE_LOST`
   * is a stable prefix the Rust addon puts on a device it has already dropped
   * (TDR, driver reset, device removal -- see `gpu.rs::DEVICE_LOST_MARKER`), and
   * it rebuilds device + pipeline on the next call, so latching here would pin
   * the preview to the CPU fallback for the rest of the session over one
   * recoverable event. It costs one log line and a single retried frame; the
   * Rust side spends at most one rebuild attempt, so a GPU that is gone for
   * good does not pay `request_adapter` per frame.
   *
   * Everything else -- a contract mismatch between the addon and this call
   * site, a bad buffer, a validation failure -- is a build problem that will not
   * fix itself per frame, and keeps the latch.
   */
  private composeNative(
    layerDescs: GpuLayerDesc[],
    concatenated: Buffer,
    width: number,
    height: number,
  ): Buffer | null {
    try {
      return this.nativeAddon.compositeFrameGpu(
        JSON.stringify(layerDescs),
        concatenated,
        width,
        height,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes(GPU_DEVICE_LOST)) {
        console.warn(
          '[preview] GPU device lost; the addon will rebuild it on the next frame.',
          message,
        );
        return null;
      }
      this.nativeCompositeFailed = true;
      console.error(
        '[preview] Native compositor call failed; falling back to the first visible layer.',
        err,
      );
      return null;
    }
  }

  /**
   * Compose one frame and downscale it for the marker index (upstream #552).
   *
   * Composes at the project canvas exactly like the live preview — same
   * visibility, layering, grade, chroma key, crop, and motion rules — then
   * box-samples down to a bounded thumbnail before returning, so the IPC
   * payload is kilobytes instead of the multi-megabyte canvas. Titles ride
   * the same `titles` path the live preview uses, so a marker over a title
   * shows the title.
   *
   * Returns null when there is no project or a newer thumbnail superseded
   * this one.
   */
  async renderThumbnail(
    frameIndex: Frame,
    targetHeight = 36,
    maxWidth = 160,
    titles: TitleRasterInput[] = [],
  ): Promise<{ width: number; height: number; rgba: Buffer } | null> {
    const project = this.project;
    if (!project) return null;
    const { width, height } = project.settings;
    const target = thumbnailSize(width, height, targetHeight, maxWidth);
    const key = `${this.tokenFor(project)}:${frameIndex}:${target.width}x${target.height}`;
    const cached = this.thumbnailCache.get(key);
    if (cached) return cached;

    const request = this.thumbnailRequests.begin(0);
    const composited = await this.composeToBuffer(project, frameIndex, width, height, request, titles);
    if (composited === null || !this.thumbnailRequests.isCurrent(request)) return null;

    const result = {
      width: target.width,
      height: target.height,
      rgba: Buffer.from(downscaleRgba(composited, width, height, target.width, target.height)),
    };
    if (this.thumbnailCache.size >= 256) this.thumbnailCache.clear();
    this.thumbnailCache.set(key, result);
    return result;
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
    const view: Project = { ...project, timeline: resolveRenderTimeline(project) };
    for (const clip of visualClipsAtFrame(view, frameIndex)) {
      const request = this.decodeRequestForClip(view, clip, frameIndex, mediaById);
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

//  Per-session registry (#137 Slice 3) 

/**
 * One compositor per session, constructed on demand. Each instance owns its
 * current project, its latest-request gates, and its render/thumbnail
 * caches, so two sessions previewing different projects cannot invalidate
 * each other's in-flight frames (the Slice 1 singleton's last-writer-wins
 * `setProject`) or race for one cache budget. Frames are still sent to the
 * window that asked — `compositeFrame` carries that window through to
 * `sendFrame` — so a late frame from session A can only ever land in
 * session A's window.
 */
const sessionCompositors = new Map<string, PreviewCompositor>();

/** The shared addon once the one process-wide load has settled. */
let sharedNativeAddon: any = null;
/** A load is in flight; the pass at settle time covers every live compositor. */
let nativeAddonPending = false;

/**
 * Give every compositor the process-wide native addon.
 *
 * One addon backs the process (the Rust side holds a single GPU device and a
 * single render pipeline in a OnceLock), while compositors are per session, so
 * the load happens once here and the result is handed to each compositor.
 *
 * `getPreviewCompositorFor` is synchronous, so the load is not awaited: it is
 * started by the first caller and applied to the whole registry when it
 * settles. A compositor created while the load is in flight is already in the
 * registry by then, so it is covered; one created after it settles picks the
 * cached result up immediately. A compositor that composes a frame before the
 * addon arrives falls back to the CPU path for that frame, exactly as it would
 * without an addon.
 */
function attachSharedNativeAddon(): void {
  if (sharedNativeAddon !== null) {
    for (const compositor of sessionCompositors.values()) {
      compositor.setNativeAddon(sharedNativeAddon);
    }
    return;
  }
  if (nativeAddonPending) return;
  nativeAddonPending = true;
  void loadNativeAddon().then((addon) => {
    nativeAddonPending = false;
    if (!addon) return;
    sharedNativeAddon = addon;
    for (const compositor of sessionCompositors.values()) {
      compositor.setNativeAddon(addon);
    }
  });
}

/** This session's compositor, created on first preview request. */
export function getPreviewCompositorFor(sessionId: string): PreviewCompositor {
  let compositor = sessionCompositors.get(sessionId);
  if (!compositor) {
    compositor = new PreviewCompositor();
    sessionCompositors.set(sessionId, compositor);
    // Registered before the attach so a load already in flight still covers it.
    attachSharedNativeAddon();
  }
  return compositor;
}

/** Forget a closed session's compositor so its frame caches die with it. */
export function disposePreviewCompositor(sessionId: string): void {
  sessionCompositors.delete(sessionId);
}

/** The session id + project a preview IPC sender resolves to (#137). */
export interface PreviewRequestContext {
  sessionId: string;
  project: Project;
}

/**
 * Register preview IPC.
 *
 * `resolve` maps the requesting sender to its session id and session
 * project (#137 Slice 3). Every request runs on that session's own
 * compositor instance: a setProject from one session invalidates only that
 * session's in-flight frames, never another window's.
 */
export function registerPreviewHandlers(
  resolve: (sender: SessionSender) => PreviewRequestContext | null,
): void {
  ipcMain.handle('preview:composite-frame', async (event, frameIndex: number, titles?: TitleRasterInput[]) => {
    const ctx = resolve(event.sender);
    if (!ctx) return;
    const compositor = getPreviewCompositorFor(ctx.sessionId);
    compositor.setProject(ctx.project);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      await compositor.compositeFrame(frameIndex, win, Array.isArray(titles) ? titles : []);
    }
  });

  ipcMain.handle('preview:prefetch', async (event, frames: number[]) => {
    const ctx = resolve(event.sender);
    if (!ctx) return;
    const compositor = getPreviewCompositorFor(ctx.sessionId);
    compositor.setProject(ctx.project);
    await compositor.prefetchFrames(frames);
  });

  // Marker-index thumbnails (upstream #552): compose at the canvas, return a
  // bounded RGBA thumbnail the renderer paints into a small canvas. Titles
  // are renderer-rasterized and arrive in the same shape the preview uses.
  ipcMain.handle(
    'preview:thumbnail',
    async (event, frameIndex: unknown, targetHeight?: unknown, titles?: unknown) => {
      const frame = typeof frameIndex === 'number' && Number.isFinite(frameIndex)
        ? Math.max(0, Math.floor(frameIndex))
        : null;
      if (frame === null) return { success: false, error: 'Invalid frame.' };
      const height = typeof targetHeight === 'number' && Number.isFinite(targetHeight)
        ? Math.min(96, Math.max(16, Math.floor(targetHeight)))
        : 36;
      const ctx = resolve(event.sender);
      if (!ctx) return { success: false };
      const compositor = getPreviewCompositorFor(ctx.sessionId);
      compositor.setProject(ctx.project);
      const result = await compositor.renderThumbnail(
        frame,
        height,
        160,
        Array.isArray(titles) ? (titles as TitleRasterInput[]) : [],
      );
      if (!result) return { success: false };
      return { success: true, width: result.width, height: result.height, rgba: result.rgba };
    },
  );
}

