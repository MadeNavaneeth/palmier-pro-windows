/**
 * RGBA downscaling for marker-index thumbnails (upstream #552's
 * MarkerThumbnailView).
 *
 * The preview compositor renders at the project canvas; thumbnails need a
 * bounded size before they cross IPC (a 1920x1080 frame is 8.3 MB of RGBA,
 * a 96 px-wide thumbnail is about 20 KB). Box sampling — the average of the
 * source pixels that map to each destination pixel — is what a
 * `drawImage`-style downscale does, so the small preview matches what the
 * canvas shows rather than aliasing like nearest-neighbour.
 *
 * Pure and tiny: the main process calls it right after composition, and the
 * unit tests exercise it without Electron or a GPU.
 */

/** Canvas-proportioned thumbnail size, capped so extreme ratios stay bounded. */
export function thumbnailSize(
  canvasWidth: number,
  canvasHeight: number,
  targetHeight: number,
  maxWidth = 160,
): { width: number; height: number } {
  if (canvasWidth <= 0 || canvasHeight <= 0 || targetHeight <= 0) {
    return { width: 64, height: 36 };
  }
  const width = Math.max(1, Math.min(maxWidth, Math.round((canvasWidth * targetHeight) / canvasHeight)));
  const height = Math.max(1, Math.round((width * canvasHeight) / canvasWidth));
  return { width, height };
}

/**
 * Box-sample an RGBA buffer down to `dstWidth` x `dstHeight`.
 *
 * Returns the source unchanged (same reference) when the target size matches,
 * and falls back to returning the source when the geometry is unusable, so a
 * caller can never end up with an empty buffer from bad math.
 */
export function downscaleRgba(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Uint8Array {
  if (srcWidth <= 0 || srcHeight <= 0 || src.length < srcWidth * srcHeight * 4) return src;
  const width = Math.max(1, Math.min(dstWidth, srcWidth));
  const height = Math.max(1, Math.min(dstHeight, srcHeight));
  if (width === srcWidth && height === srcHeight) return src;

  const out = new Uint8Array(width * height * 4);
  for (let dy = 0; dy < height; dy++) {
    const y0 = Math.floor((dy * srcHeight) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * srcHeight) / height));
    for (let dx = 0; dx < width; dx++) {
      const x0 = Math.floor((dx * srcWidth) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * srcWidth) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        let index = (sy * srcWidth + x0) * 4;
        for (let sx = x0; sx < x1; sx++) {
          r += src[index];
          g += src[index + 1];
          b += src[index + 2];
          a += src[index + 3];
          count += 1;
          index += 4;
        }
      }
      const outIndex = (dy * width + dx) * 4;
      out[outIndex] = Math.round(r / count);
      out[outIndex + 1] = Math.round(g / count);
      out[outIndex + 2] = Math.round(b / count);
      out[outIndex + 3] = Math.round(a / count);
    }
  }
  return out;
}
