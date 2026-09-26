/**
 * Shape rasterization cache for the live GPU preview.
 *
 * Shape clips have no backing media asset, so the main-process compositor
 * has nothing to decode for them — like titles, their pixels are produced by
 * the renderer's canvas engine and handed in through the compositor's raster
 * payload. The raster holds the box content only (drawShapeBox); placement,
 * rotation, scale, opacity, and motion are applied per frame by the
 * compositor's layer descriptor, exactly like a decoded video frame, so none
 * of those fields are cache-key material.
 *
 * The cache key includes every field drawShapeBox reads plus the box size,
 * so a style or geometry edit invalidates exactly the entries it affects.
 */

import type { Clip, Project } from '../../shared/types/project';
import { hasShapeContent } from '../../shared/editor/shape';
import { drawShapeBox } from './shape-render';

export interface RasterizedShape {
  width: number;
  height: number;
  /** Absolute canvas position this raster is meant to be placed at (top-left origin). */
  x: number;
  y: number;
  /** RGBA, width*height*4 bytes, top-left origin. */
  data: Uint8ClampedArray;
}

const cache = new Map<string, RasterizedShape>();
const MAX_ENTRIES = 64;

/** Every field drawShapeBox reads, so the key can never miss a style change. */
function styleKey(clip: Clip): string {
  return [
    clip.shapeKind,
    clip.shapeStrokeColor,
    clip.shapeStrokeWidth,
    clip.shapeFillColor,
    clip.width,
    clip.height,
  ].join('|');
}

function cacheKey(clip: Clip): string {
  return `${clip.id}|${styleKey(clip)}`;
}

/** LRU-by-recency eviction, matching the shape of the title raster cache. */
function remember(key: string, value: RasterizedShape): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
}

/**
 * Rasterize a shape clip's box to RGBA, reusing a cached bitmap when the
 * clip's rendered appearance has not changed. The buffer is cropped to the
 * clip's own box (clip.x/y/width/height), matching how a decoded video/image
 * frame is sized to its clip box. Returns null for non-shape clips and for
 * shapes with no visible content (no stroke and no fill).
 */
export function rasterizeShape(clip: Clip): RasterizedShape | null {
  if (clip.type !== 'shape' || !hasShapeContent(clip)) return null;

  const key = cacheKey(clip);
  const cached = cache.get(key);
  if (cached) {
    // Re-insert to mark most-recently-used.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const boxWidth = Math.max(1, Math.round(clip.width));
  const boxHeight = Math.max(1, Math.round(clip.height));
  const canvas = new OffscreenCanvas(boxWidth, boxHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, boxWidth, boxHeight);
  drawShapeBox(ctx, clip, { width: boxWidth, height: boxHeight });
  const imageData = ctx.getImageData(0, 0, boxWidth, boxHeight);
  const result: RasterizedShape = {
    width: boxWidth,
    height: boxHeight,
    x: Math.round(clip.x),
    y: Math.round(clip.y),
    data: imageData.data,
  };
  remember(key, result);
  return result;
}

/** Drop every cached bitmap (project switch, or when memory pressure calls for it). */
export function clearShapeRasterCache(): void {
  cache.clear();
}

/** One rasterized shape layer, shaped for the compositor IPC payload. */
export type ShapeRasterForIpc = {
  clipId: string;
  width: number;
  height: number;
  x: number;
  y: number;
  rgba: Uint8ClampedArray;
};

/**
 * Rasterize every shape clip visible at `frame`, matching the exact
 * visibility rule main/media/visible-clips.ts applies for every other
 * non-audio clip: solo-active tracks (when any track is soloed) plus
 * track-visible plus frame inside [startFrame, startFrame+durationFrames).
 *
 * Nested timelines contribute their visible-track shapes without the frame
 * filter, for the same reason titles do (see title-raster-cache.ts): the
 * compositor consumes box-content bitmaps by clip id for its resolved
 * visible set, and content caching keeps the over-scan cheap.
 *
 * Shared by the playback engine's preview requests and the marker-index
 * thumbnails, so both surfaces composite a shape the same way.
 */
export function visibleShapeRasters(project: Project, frame: number): ShapeRasterForIpc[] {
  const results: ShapeRasterForIpc[] = [];
  collectShapeRasters(project.timeline.tracks, project.timeline.clips, frame, results);
  for (const nested of Object.values(project.timelines ?? {})) {
    collectShapeRasters(nested.tracks, nested.clips, null, results);
  }
  return results;
}

/** Shapes on visible tracks; `frame: null` rasterizes regardless of position (nested timelines). */
function collectShapeRasters(
  tracks: Project['timeline']['tracks'],
  clips: Project['timeline']['clips'],
  frame: number | null,
  results: ShapeRasterForIpc[],
): void {
  const trackById = new Map(tracks.map((track) => [track.id, track] as const));
  const anySoloed = tracks.some((track) => track.soloed);
  for (const clip of clips) {
    if (clip.type !== 'shape') continue;
    const track = trackById.get(clip.trackId);
    if (!track || track.visible === false) continue;
    if (anySoloed && !track.soloed) continue;
    if (frame !== null && (frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames)) continue;
    const rasterized = rasterizeShape(clip as Clip);
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
}
