/**
 * Title rasterization cache for the live GPU preview.
 *
 * Title clips have no backing media asset, so the main-process compositor
 * (which decodes frames by asset path) has nothing to decode for them and
 * silently skips them -- title clips render in FFmpeg export and nowhere
 * else. This cache rasterizes a title clip to RGBA in the renderer, using
 * the exact same drawTitle() function export's bake pipeline calls, so the
 * pixels handed to the GPU compositor are the same ones export would
 * produce. The renderer is the only process with a canvas/font engine;
 * feeding the result into the compositor's ordinary layer list (rather than
 * drawing it as a DOM overlay) is what lets a title's opacity, blend mode,
 * and wipe/slide transitions composite identically to a video/image layer
 * instead of only approximating it from outside the GPU stack. Rotation and
 * scale are deliberately NOT part of that parity -- see the transform note
 * below.
 *
 * Cache key includes every field drawTitle reads plus the canvas size, so a
 * style edit or a project-resolution change invalidates exactly the entries
 * it affects and nothing else. Entries are plain ImageData -- cheap to keep
 * many of, since a title layer is typically much smaller in byte count than
 * a decoded video frame once trimmed to its clip box.
 *
 * The returned buffer is cropped to the clip's own box (clip.x/y/width/height)
 * for a plain title, matching how a decoded video/image frame is sized to its
 * clip box rather than the full canvas -- this keeps the box-relative model
 * drawTitle() itself uses (centerX/centerY = clip.x/y + width/height / 2) and
 * lets a wipe transition mask sweep across the title's own box instead of the
 * whole frame, same as every other clip type.
 *
 * Advanced titles (footage/inverted/tilt fill modes, see isAdvancedTitle) stay
 * full-canvas instead: export's bake path (ExportDialog.tsx + export-args.ts)
 * overlays the baked PNG at the frame origin with no x/y offset, and inverted
 * mode difference-blends the ENTIRE frame, not just the clip's box. Cropping
 * those to the box would truncate a tilt's projected overflow and scope an
 * inverted silhouette's blend to the wrong area, diverging from export.
 *
 * Neither case applies clip.rotation/scaleX/scaleY/anchor -- export's title
 * paths (drawtext and the baked overlay) never rotate or scale a title, so
 * the GPU layer built from this raster must use an identity transform too, or
 * preview would show a rotated/scaled title that exports unrotated.
 */

import type { Clip } from '../../shared/types/project';
import { drawTitle, isAdvancedTitle } from './title-render';

export interface RasterizedTitle {
  width: number;
  height: number;
  /** Absolute canvas position this raster is meant to be placed at (top-left origin). */
  x: number;
  y: number;
  /** RGBA, width*height*4 bytes, top-left origin -- matches a decoded video/image frame's sizing. */
  data: Uint8ClampedArray;
}

const cache = new Map<string, RasterizedTitle>();
const MAX_ENTRIES = 64;

/** Every field drawTitle()/isAdvancedTitle() read, so the key can never miss a style change. */
function styleKey(clip: Clip): string {
  return [
    clip.text,
    clip.titleSizeRatio,
    clip.titleColor,
    clip.titleFontFamily,
    clip.titleBold,
    clip.titleAlign,
    clip.titleBackgroundColor,
    clip.titleBackgroundPadding,
    clip.titleLineSpacing,
    clip.titleFontCase,
    clip.titleStrokeWidth,
    clip.titleStrokeColor,
    clip.titleFillMode,
    clip.titleBlurRadius,
    clip.titleTiltXDeg,
    clip.titleTiltYDeg,
    clip.opacity,
    clip.x,
    clip.y,
    clip.width,
    clip.height,
  ].join('|');
}

function cacheKey(clip: Clip, canvasWidth: number, canvasHeight: number): string {
  return `${clip.id}|${canvasWidth}x${canvasHeight}|${styleKey(clip)}`;
}

/** LRU-by-recency eviction, matching the shape of the other renderer media caches. */
function remember(key: string, value: RasterizedTitle): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
}

/**
 * Rasterize a title clip to RGBA, reusing a cached bitmap when the clip's
 * rendered appearance has not changed. A plain title's buffer is cropped to
 * the clip's own box; an advanced title (isAdvancedTitle) stays full-canvas
 * to match export's bake contract (see module doc). `x`/`y` on the result is
 * always where the caller should place it on the canvas.
 */
export function rasterizeTitle(
  clip: Clip,
  canvasWidth: number,
  canvasHeight: number,
): RasterizedTitle | null {
  if (clip.type !== 'title' || !clip.text) return null;

  const key = cacheKey(clip, canvasWidth, canvasHeight);
  const cached = cache.get(key);
  if (cached) {
    // Re-insert to mark most-recently-used.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // Tilt/footage/inverted modes draw onto their own internal layer inside
  // drawTitle and composite the result onto ctx; a plain title draws
  // straight onto ctx. Either way one drawTitle call produces the final
  // full-canvas pixels, exactly like the export bake path -- drawTitle's
  // internal math (centerX/centerY, tilt corner projection) is written in
  // absolute canvas coordinates and must keep seeing the real canvas size.
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  drawTitle(ctx, clip, { width: canvasWidth, height: canvasHeight });

  let result: RasterizedTitle;
  if (isAdvancedTitle(clip)) {
    // Matches the export bake path exactly: full canvas, placed at the origin.
    const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
    result = { width: canvasWidth, height: canvasHeight, x: 0, y: 0, data: imageData.data };
  } else {
    // Crop to the clip's own box after drawing. getImageData returns
    // transparent black for any part of the requested rect outside the
    // canvas, which is exactly the right result for a box that extends past
    // an edge -- no separate bounds handling needed here.
    const boxWidth = Math.max(1, Math.round(clip.width));
    const boxHeight = Math.max(1, Math.round(clip.height));
    const boxX = Math.round(clip.x);
    const boxY = Math.round(clip.y);
    const imageData = ctx.getImageData(boxX, boxY, boxWidth, boxHeight);
    result = { width: boxWidth, height: boxHeight, x: boxX, y: boxY, data: imageData.data };
  }
  remember(key, result);
  return result;
}

/** Drop every cached bitmap (project switch, or when memory pressure calls for it). */
export function clearTitleRasterCache(): void {
  cache.clear();
}
