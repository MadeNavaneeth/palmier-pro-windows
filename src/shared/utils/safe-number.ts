/**
 * Numeric safety helpers.
 *
 * Prevents the class of crash reported upstream in Palmier Pro #200, where
 * untrusted numeric tool arguments (from the AI agent or any client on the
 * local MCP socket) flowed into integer conversions / loop bounds / array
 * sizing without range checks. In Swift that traps on `Int(Double)`; in
 * JavaScript an out-of-range value instead silently produces absurd loop
 * counts, multi-gigabyte allocations, or `Infinity`/`NaN` that corrupt state.
 *
 * Every untrusted Double -> integer-frame conversion in the editor must go
 * through these helpers.
 */

import type { Frame } from '../types/project';

/**
 * Maximum representable frame. 2^31 - 1 frames is ~828 days at 30fps and
 * ~414 days at 60fps — far beyond any real project — while staying inside
 * the 32-bit range that downstream native code (Rust u32/i32, wgpu) and
 * FFmpeg expect. Anything larger is treated as malicious/buggy and clamped.
 */
export const MAX_FRAME = 2 ** 31 - 1;

/** Largest sane pixel dimension for canvas / layer sizing. */
export const MAX_DIMENSION = 16384; // 16K — above any real export target

/** True only for a real, finite JS number (rejects NaN, +/-Infinity). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Convert an untrusted value to a safe integer, or return `fallback`.
 * Rejects NaN, Infinity, and values outside the safe integer range.
 */
export function safeInt(value: unknown, fallback = 0): number {
  if (!isFiniteNumber(value)) return fallback;
  if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) return fallback;
  return Math.trunc(value);
}

/**
 * Clamp a number into [min, max] in the floating-point domain BEFORE any
 * integer conversion, so the conversion itself can never overflow.
 * NaN collapses to `min`; +/-Infinity clamp to `max`/`min` by sign.
 */
export function clampNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return min;
  if (value < min) return min; // includes -Infinity
  if (value > max) return max; // includes +Infinity
  return value;
}

/**
 * Clamp an untrusted value to a valid frame index in [min, MAX_FRAME].
 * This is the canonical guard for every frame-typed tool argument.
 */
export function clampFrame(value: unknown, min: Frame = 0, max: Frame = MAX_FRAME): Frame {
  const bounded = clampNumber(value, Math.max(0, min), Math.min(MAX_FRAME, max));
  return Math.trunc(bounded);
}

/**
 * Validate that a value is a usable frame index without clamping.
 * Returns null if the value is non-finite, negative, or out of range —
 * callers should reject the operation rather than guess.
 */
export function asValidFrame(value: unknown): Frame | null {
  if (!isFiniteNumber(value)) return null;
  const truncated = Math.trunc(value);
  if (truncated < 0 || truncated > MAX_FRAME) return null;
  return truncated;
}

/**
 * Clamp a pixel dimension to [1, MAX_DIMENSION]. Used for layer/canvas sizes
 * sent to the GPU compositor so a bad value can't request an enormous texture.
 * NaN/non-numbers fall back; +Infinity clamps to MAX_DIMENSION.
 */
export function clampDimension(value: unknown, fallback = 1): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.trunc(clampNumber(value, 1, MAX_DIMENSION));
}
