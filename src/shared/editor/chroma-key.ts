/**
 * Chroma key (green/blue screen removal) on visual clips (upstream issue #97).
 *
 * A per-clip key color, tolerance, edge softness, and spill suppression
 * amount — the same four parameters as upstream's Metal kernel (`keyHue`
 * there is a hue float from an eyedropper; this port has no preview color
 * sampler, so the key is set directly as #rrggbb instead). Preview keys
 * directly on the decoded RGBA frame (Canvas has no chromakey filter, so
 * this is a JS per-pixel pass); export uses FFmpeg's native `colorkey` +
 * `despill` filters. Both consumers read the same clip fields through the
 * helpers here so they can never disagree on what "keyed" means.
 */

import type { Clip } from '../types/project';

export interface ChromaKey {
  /** Key color as #rrggbb. */
  keyColor: string;
  /** Match tolerance, 0-1. 0 = off (see hasChromaKey). */
  tolerance: number;
  /** Edge feather / falloff, 0-1. 0 = hard cutoff. */
  softness: number;
  /** Spill suppression strength, 0-1. 0 = no despill pass. */
  spill: number;
}

const DEFAULT_SOFTNESS = 0.05;
const DEFAULT_SPILL = 0.5;
export const DEFAULT_CHROMA_KEY_COLOR = '#00ff00';

/** Clamp a 0-1 chroma-key parameter; non-finite input becomes 0. */
export function clampChromaValue(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 0;
  return Math.min(1, Math.max(0, value ?? 0));
}

/** Validate/normalize a #rrggbb color string; invalid input falls back to the default key color. */
export function sanitizeChromaColor(color: string | undefined): string {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) return color.toLowerCase();
  return DEFAULT_CHROMA_KEY_COLOR;
}

/** True when the clip has an active chroma key (tolerance > 0). */
export function hasChromaKey(clip: Clip): boolean {
  return clampChromaValue(clip.chromaKey?.tolerance) > 0;
}

/** Resolved chroma key for a clip, or null when inactive. */
export function chromaKeyOf(clip: Clip): ChromaKey | null {
  if (!hasChromaKey(clip)) return null;
  const raw = clip.chromaKey!;
  return {
    keyColor: sanitizeChromaColor(raw.keyColor),
    tolerance: clampChromaValue(raw.tolerance),
    softness: clampChromaValue(raw.softness ?? DEFAULT_SOFTNESS),
    spill: clampChromaValue(raw.spill ?? DEFAULT_SPILL),
  };
}

/** Value equality for two possibly-undefined chroma key configs (reference-safe no-op detection). */
export function chromaKeyEquals(a: ChromaKey | undefined, b: ChromaKey | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.keyColor === b.keyColor && a.tolerance === b.tolerance
    && a.softness === b.softness && a.spill === b.spill;
}

/**
 * Merge partial updates onto a clip's current chroma key, applying the same
 * defaults `chromaKeyOf` would. Returns undefined when the merged tolerance
 * is 0 (the single deactivation switch, matching upstream's `tolerance`
 * gate) or when there is nothing to merge onto and no update sets a positive
 * tolerance.
 *
 * Returns the exact `current` reference (not a new object) when the merge
 * produces the same values `current` already had — `applyClipProperties`'s
 * no-op detection compares clip fields by `===`, so a fresh object with
 * identical values would otherwise be misread as a real change and open an
 * undo entry for a repeated/no-op call.
 */
export function mergeChromaKey(
  current: Clip['chromaKey'],
  update: { keyColor?: string; tolerance?: number; softness?: number; spill?: number },
): ChromaKey | undefined {
  const base: ChromaKey = {
    keyColor: sanitizeChromaColor(current?.keyColor),
    tolerance: clampChromaValue(current?.tolerance),
    softness: clampChromaValue(current?.softness ?? DEFAULT_SOFTNESS),
    spill: clampChromaValue(current?.spill ?? DEFAULT_SPILL),
  };
  const merged: ChromaKey = {
    keyColor: update.keyColor !== undefined ? sanitizeChromaColor(update.keyColor) : base.keyColor,
    tolerance: update.tolerance !== undefined ? clampChromaValue(update.tolerance) : base.tolerance,
    softness: update.softness !== undefined ? clampChromaValue(update.softness) : base.softness,
    spill: update.spill !== undefined ? clampChromaValue(update.spill) : base.spill,
  };
  if (merged.tolerance <= 0) return undefined;
  if (current && chromaKeyEquals(current as ChromaKey, merged)) return current as ChromaKey;
  return merged;
}

/** Parse #rrggbb into 0-255 channel values. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = sanitizeChromaColor(hex);
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

/**
 * Per-pixel RGB distance to the key color, normalized so 1.0 spans the full
 * 0-255 cube diagonal — the same metric FFmpeg's colorkey filter uses, so
 * preview and export key the same pixels at the same tolerance value.
 */
function colorDistance(r: number, g: number, b: number, key: { r: number; g: number; b: number }): number {
  const dr = r - key.r;
  const dg = g - key.g;
  const db = b - key.b;
  return Math.sqrt(dr * dr + dg * dg + db * db) / (255 * Math.sqrt(3));
}

/**
 * Apply chroma key + spill suppression to an RGBA buffer in place.
 *
 * `tolerance` sets the inner threshold; `softness` extends it into a linear
 * falloff band (matching FFmpeg colorkey's `blend`). Spill desaturates the
 * key-color contamination on partially-keyed edge pixels — pixels far from
 * the key color are left untouched, matching upstream's edge-only despill.
 *
 * Accepts both `Uint8ClampedArray` (canvas `ImageData.data`) and `Uint8Array`
 * (Node `Buffer`, used by the main-process preview compositor) — every
 * value written here is already a convex combination of existing 0-255
 * channels or a rounded product of one, so it never needs clamped-write
 * semantics to stay in range.
 */
export function applyChromaKey(pixels: Uint8ClampedArray | Uint8Array, key: ChromaKey): void {
  const keyRgb = hexToRgb(key.keyColor);
  const inner = key.tolerance;
  const outer = key.tolerance + key.softness;
  const band = outer - inner;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    if (a === 0) continue;

    const distance = colorDistance(r, g, b, keyRgb);
    let coverage = 1; // 1 = fully opaque (unkeyed), 0 = fully keyed out
    if (distance <= inner) {
      coverage = 0;
    } else if (distance < outer && band > 0) {
      coverage = (distance - inner) / band;
    }

    if (key.spill > 0 && coverage < 1) {
      // Desaturate toward luma in proportion to how "keyed" this pixel is,
      // so a partially-keyed edge pixel loses its green/blue tint before
      // alpha drops it out entirely.
      const spillAmount = key.spill * (1 - coverage);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      pixels[i] = r + (luma - r) * spillAmount;
      pixels[i + 1] = g + (luma - g) * spillAmount;
      pixels[i + 2] = b + (luma - b) * spillAmount;
    }

    pixels[i + 3] = Math.round(a * coverage);
  }
}

/**
 * FFmpeg filter chain fragment (no leading/trailing comma) for chroma key +
 * spill suppression, applied to an rgba-format label. The despill screen
 * type is inferred from the key color's dominant channel, matching
 * upstream's model where the key is always green or blue.
 */
export function buildChromaKeyFilterChain(key: ChromaKey): string {
  const keyRgb = hexToRgb(key.keyColor);
  const colorHex = key.keyColor.replace('#', '0x');
  // FFmpeg colorkey requires similarity in [1e-5, 1]; a clamped-but-tiny
  // tolerance must not collapse to a rejected 0 (the tiny-softness class of
  // bug fixed for edge effects).
  const similarity = Math.max(0.00001, key.tolerance).toFixed(6);
  const blend = key.softness.toFixed(6);
  let chain = `colorkey=color=${colorHex}:similarity=${similarity}:blend=${blend}`;
  if (key.spill > 0) {
    const screenType = keyRgb.b > keyRgb.g ? 'blue' : 'green';
    const greenScale = screenType === 'green' ? -key.spill : 0;
    const blueScale = screenType === 'blue' ? -key.spill : 0;
    chain += `,despill=type=${screenType}:mix=0.5:expand=0:green=${greenScale.toFixed(6)}:blue=${blueScale.toFixed(6)}`;
  }
  return chain;
}
