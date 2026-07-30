/**
 * Canvas aspect ratio and resolution presets.
 *
 * Windows translation of upstream Palmier Pro PR #417 ("support custom project
 * aspect ratios"). Upstream replaced a closed enum of six aspect presets with a
 * parsed `width:height` value, so a project can use any ratio — 3:2, 2.39:1,
 * 21:9 — while the presets remain as shortcuts.
 *
 * The rules preserved from upstream, because preview, export and clip fitting
 * all depend on them:
 *
 *   - A ratio is two positive finite numbers separated by ':'.
 *   - Changing the ratio preserves the current SHORT edge, so switching 16:9 to
 *     9:16 at 1080p stays at 1080 on the short edge instead of shrinking.
 *   - Both edges are rounded to even pixels, because H.264/HEVC chroma
 *     subsampling requires even dimensions.
 *   - Neither edge may exceed 8192 px.
 */

/** Largest canvas edge an encoder in this stack will accept. */
export const MAX_CANVAS_EDGE = 8192;
/** Smallest usable canvas edge (an even value; 1x1 has no chroma plane). */
export const MIN_CANVAS_EDGE = 2;

/** Raised for any ratio or resolution the project cannot adopt. */
export class AspectRatioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AspectRatioError';
  }
}

export interface CanvasResolution {
  width: number;
  height: number;
}

export interface CanvasAspectRatio {
  horizontal: number;
  vertical: number;
}

/**
 * Parse a `width:height` ratio such as `16:9`, `3:2` or `2.39:1`.
 *
 * Throws `AspectRatioError` for anything that is not two positive finite
 * numbers, which is the same refusal upstream surfaces to both the settings
 * sheet and the agent.
 */
export function parseAspectRatio(text: string): CanvasAspectRatio {
  const invalid = new AspectRatioError(
    'Use an aspect ratio with two positive numbers, such as 3:2.',
  );
  if (typeof text !== 'string') throw invalid;

  const parts = text.split(':');
  if (parts.length !== 2) throw invalid;

  const horizontal = parseRatioComponent(parts[0]);
  const vertical = parseRatioComponent(parts[1]);
  if (horizontal === null || vertical === null) throw invalid;
  if (!Number.isFinite(horizontal / vertical)) throw invalid;

  return { horizontal, vertical };
}

/**
 * Strict numeric parse: rejects blanks, `NaN`, `Infinity`, and trailing junk
 * that `Number.parseFloat` would otherwise accept (`'16px'`).
 */
function parseRatioComponent(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d*\.?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Resolution for `ratio` that keeps `shortEdge` on the shorter side.
 *
 * The short edge is rounded up to even, the long edge is rounded to the nearest
 * even value, and an oversized result is refused rather than silently clamped —
 * clamping would quietly change the ratio the caller asked for.
 */
export function resolutionForAspectRatio(
  ratio: CanvasAspectRatio,
  shortEdge: number,
): CanvasResolution {
  if (!Number.isFinite(shortEdge) || shortEdge < MIN_CANVAS_EDGE) {
    throw new AspectRatioError(
      `Resolution must be at least ${MIN_CANVAS_EDGE} x ${MIN_CANVAS_EDGE} pixels.`,
    );
  }

  const value = ratio.horizontal / ratio.vertical;
  const short = toEven(Math.ceil(shortEdge));
  const longValue = short * Math.max(value, 1 / value);
  if (longValue > MAX_CANVAS_EDGE) {
    throw new AspectRatioError(
      `Resolution must not exceed ${MAX_CANVAS_EDGE} pixels on either edge.`,
    );
  }

  const long = toEven(Math.round(longValue));
  return value >= 1 ? { width: long, height: short } : { width: short, height: long };
}

/** Round up to the nearest even pixel count (encoders require even dimensions). */
function toEven(value: number): number {
  return value % 2 === 0 ? value : value + 1;
}

/**
 * Human-readable ratio for a resolution: the reduced integer ratio when it is
 * small enough to read (`1920x1080` -> `16:9`), otherwise a decimal form
 * (`1919x1080` -> `1.78:1`).
 */
export function aspectRatioLabel(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '—';
  }

  let a = Math.round(width);
  let b = Math.round(height);
  const reduceWidth = a;
  const reduceHeight = b;
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  const divisor = a || 1;
  const reducedWidth = reduceWidth / divisor;
  const reducedHeight = reduceHeight / divisor;
  if (Math.max(reducedWidth, reducedHeight) <= 100) {
    return `${reducedWidth}:${reducedHeight}`;
  }

  const value = width / height;
  return value >= 1
    ? `${Math.round(value * 100) / 100}:1`
    : `1:${Math.round((1 / value) * 100) / 100}`;
}

export interface AspectPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

/** The preset ratios offered in the UI, matching upstream's set and sizes. */
export const ASPECT_PRESETS: readonly AspectPreset[] = [
  { id: '16:9', label: '16:9', width: 1920, height: 1080 },
  { id: '9:14', label: '9:14', width: 1080, height: 1680 },
  { id: '9:16', label: '9:16', width: 1080, height: 1920 },
  { id: '1:1', label: '1:1', width: 1080, height: 1080 },
  { id: '4:3', label: '4:3', width: 1440, height: 1080 },
  { id: '2.4:1', label: '2.4:1', width: 2592, height: 1080 },
] as const;

/**
 * True when a preset is the exact resolution currently applied.
 *
 * Upstream tightened this in #417: a preset is only "current" at its own
 * resolution, so 3840x2160 no longer reports as the 16:9 preset even though the
 * ratio matches. The preset menu and the quality menu are separate controls.
 */
export function aspectPresetMatches(preset: AspectPreset, width: number, height: number): boolean {
  return preset.width === width && preset.height === height;
}

export interface QualityPreset {
  id: string;
  label: string;
  shortEdge: number;
}

/** Short-edge quality presets. Scaling preserves the current ratio. */
export const QUALITY_PRESETS: readonly QualityPreset[] = [
  { id: '720p', label: '720p', shortEdge: 720 },
  { id: '1080p', label: '1080p', shortEdge: 1080 },
  { id: '2K', label: '2K', shortEdge: 1440 },
  { id: '4K', label: '4K', shortEdge: 2160 },
] as const;

/** Scale a resolution to a quality preset while preserving its aspect ratio. */
export function resolutionForQuality(
  quality: QualityPreset,
  current: CanvasResolution,
): CanvasResolution {
  const target = quality.shortEdge;
  if (current.width <= 0 || current.height <= 0) {
    return { width: target, height: target };
  }
  if (current.width <= current.height) {
    return {
      width: target,
      height: Math.round((target * current.height) / current.width),
    };
  }
  return {
    width: Math.round((target * current.width) / current.height),
    height: target,
  };
}

/** True when `resolution` sits at this quality preset's short edge. */
export function qualityPresetMatches(quality: QualityPreset, resolution: CanvasResolution): boolean {
  return Math.min(resolution.width, resolution.height) === quality.shortEdge;
}

export function findAspectPreset(id: string): AspectPreset | undefined {
  return ASPECT_PRESETS.find((preset) => preset.id === id);
}

export function findQualityPreset(id: string): QualityPreset | undefined {
  return QUALITY_PRESETS.find((preset) => preset.id === id);
}

/**
 * Ratio input for the "Custom…" editor, seeded from the current resolution.
 *
 * The seeded text is the rounded display label, so re-applying an untouched
 * value must not resize the canvas: `1919x1080` shows as `1.78`, and applying
 * `1.78:1` unchanged keeps 1919x1080 rather than snapping to 1920x1080. This is
 * upstream's `CustomAspectRatioContext` contract (#417).
 */
export interface CustomAspectRatioContext {
  width: number;
  height: number;
}

export function customRatioInput(context: CustomAspectRatioContext): {
  horizontal: string;
  vertical: string;
} {
  const [horizontal = '', vertical = ''] = aspectRatioLabel(context.width, context.height).split(':');
  return { horizontal, vertical };
}

/** Resolve a custom ratio entry against its seeding context. */
export function customRatioResolution(
  context: CustomAspectRatioContext,
  horizontal: string,
  vertical: string,
): CanvasResolution {
  const initial = customRatioInput(context);
  if (horizontal === initial.horizontal && vertical === initial.vertical) {
    return { width: context.width, height: context.height };
  }
  return resolutionForAspectRatio(
    parseAspectRatio(`${horizontal}:${vertical}`),
    Math.min(context.width, context.height),
  );
}
