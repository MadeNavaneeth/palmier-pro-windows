/**
 * Static source crop on clips (#568).
 *
 * Fractions of the source frame removed from each edge, applied BEFORE
 * position/scale in every consumer: the preview crops its decoded RGBA
 * buffer (proportional crop of a uniformly scaled frame is identical to
 * cropping the source), and the exporter emits an FFmpeg crop filter ahead
 * of scale. Kept static by design â€” animated crop belongs to the keyframes
 * contract.
 */

export interface SourceCrop {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Per-edge cap; two opposite edges together can never exceed 0.9. */
export const CROP_MAX_EDGE = 0.45;

const clamp01 = (v: number | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(CROP_MAX_EDGE, Math.max(0, v)) : 0;

/** Normalize untrusted values into a valid crop, dropping no-op zeros. */
export function sanitizeCrop(input: { left?: number; right?: number; top?: number; bottom?: number } | undefined | null): SourceCrop | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const crop: SourceCrop = {
    left: clamp01(input.left),
    right: clamp01(input.right),
    top: clamp01(input.top),
    bottom: clamp01(input.bottom),
  };
  const horizontalSum = crop.left + crop.right;
  if (horizontalSum > 0.9) {
    const excess = horizontalSum - 0.9;
    crop.left -= excess / 2;
    crop.right -= excess / 2;
  }
  const verticalSum = crop.top + crop.bottom;
  if (verticalSum > 0.9) {
    const excess = verticalSum - 0.9;
    crop.top -= excess / 2;
    crop.bottom -= excess / 2;
  }
  const isZero =
    crop.left === 0 && crop.right === 0 && crop.top === 0 && crop.bottom === 0;
  return isZero ? undefined : crop;
}

export function isCropped(crop: SourceCrop | undefined): crop is SourceCrop {
  return Boolean(
    crop
      && (crop.left > 0 || crop.right > 0 || crop.top > 0 || crop.bottom > 0),
  );
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Integer pixel rect for a crop against a concrete frame size. */
export function cropRect(crop: SourceCrop, frameWidth: number, frameHeight: number): PixelRect {
  const width = Math.max(1, Math.round(frameWidth * (1 - crop.left - crop.right)));
  const height = Math.max(1, Math.round(frameHeight * (1 - crop.top - crop.bottom)));
  return {
    x: Math.round(frameWidth * crop.left),
    y: Math.round(frameHeight * crop.top),
    width,
    height,
  };
}

