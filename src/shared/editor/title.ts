/**
 * Title clip text rules (roadmap R3 foundation).
 *
 * Titles are stored as plain strings on the clip and rendered twice -- once
 * by the renderer's canvas preview, once by FFmpeg's drawtext filter on
 * export. The two paths must agree, which is why sanitization lives here:
 *
 * - sanitizeTitleText strips control characters (newlines survive) and caps
 *   length, so a 10 MB paste can never reach either renderer;
 * - escapeDrawtext makes a sanitized string safe inside FFmpeg's drawtext
 *   filter, where ':' and "'" are argument/option delimiters, '%' expands
 *   expansion sequences, and '\\' starts escapes.
 */

import type { Clip, Frame } from '../types/project';

export const TITLE_TEXT_MAX_LENGTH = 300;

/** Rendered size of title text, relative to project height (fractions). */
export interface TitleStyle {
  /** Font size as a fraction of the project height, e.g. 0.08 ≈ 86px @1080p. */
  sizeRatio: number;
  /** Hex color without alpha, e.g. '#ffffff'. */
  colorHex: string;
  /** Font family for the title. Default sans-serif. */
  fontFamily?: string;
  /** Bold text. Default false. */
  bold?: boolean;
  /** Horizontal alignment within the clip box. Default center. */
  align?: 'left' | 'center' | 'right';
  /** Background box color with alpha, e.g. '#00000080'. Undefined = none. */
  backgroundColor?: string;
  /** Background box padding in px at project resolution. Default 8. */
  backgroundPaddingPx?: number;
  /** Extra space between wrapped lines, in px at project resolution. */
  lineSpacingPx?: number;
  /** Case applied to the text before rendering. Default original. */
  fontCase?: 'original' | 'upper' | 'lower';
  /** Outline stroke width in px at project resolution. Default 0 = off. */
  strokeWidthPx?: number;
  /** Outline stroke color. */
  strokeColor?: string;
}

/** Padding around the text inside the background box, both render paths. */
export const TITLE_BACKGROUND_PADDING_DEFAULT = 8;

export type TitleFontCase = NonNullable<TitleStyle['fontCase']>;

/**
 * Apply the styled case to title text BEFORE it reaches either renderer.
 * Case is a string transform rather than a render feature so canvas and
 * drawtext consume byte-identical glyphs — the strongest form of the
 * two-paths-agree rule.
 */
export function applyTitleFontCase(text: string, mode?: TitleFontCase): string {
  if (mode === 'upper') return text.toUpperCase();
  if (mode === 'lower') return text.toLowerCase();
  return text;
}

export const DEFAULT_TITLE_STYLE: TitleStyle = {
  sizeRatio: 0.09,
  colorHex: '#ffffff',
};

/**
 * Build the FFmpeg drawtext style parameters from a clip's title fields.
 * Only non-default values are emitted so the filter string stays minimal.
 *
 * @param clip - A title-bearing clip with optional style fields.
 * @param height - Project height in pixels, for font size scaling.
 */
export function drawtextStyleParams(
  clip: { titleBold?: boolean; titleFontFamily?: string; titleBackgroundColor?: string; titleBackgroundPadding?: number; titleLineSpacing?: number; titleStrokeWidth?: number; titleStrokeColor?: string },
  height: number,
): string {
  const parts: string[] = [];
  if (clip.titleBold) parts.push('bold=1');
  if (clip.titleFontFamily) {
    // Windows system fonts are addressed by name via fontconfig's fallback.
    const family = escapeDrawtext(clip.titleFontFamily);
    parts.push(`font='${family}'`);
  }
  if (clip.titleLineSpacing !== undefined && clip.titleLineSpacing > 0) {
    parts.push(`line_spacing=${Math.round(clip.titleLineSpacing)}`);
  }
  if (clip.titleBackgroundColor) {
    const bg = clip.titleBackgroundColor.replace('#', '0x');
    const pad = Math.round(
      clip.titleBackgroundPadding ?? TITLE_BACKGROUND_PADDING_DEFAULT,
    );
    parts.push(`box=1:boxcolor=${bg}:boxborderw=${pad}`);
  }
  if (clip.titleStrokeWidth && clip.titleStrokeWidth > 0 && clip.titleStrokeColor) {
    const sc = clip.titleStrokeColor.replace('#', '0x');
    parts.push(`borderw=${Math.round(clip.titleStrokeWidth)}:bordercolor=${sc}`);
  }
  return parts.length > 0 ? ':' + parts.join(':') : '';
}

/** Clean a raw user/agent string into storable title text, or null. */
export function sanitizeTitleText(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .split('\n')
    .map((line) =>
      [...line]
        .filter((ch) => {
          const code = ch.codePointAt(0) ?? 0;
          return code === 0x09 || code >= 0x20; // tabs survive, control chars go
        })
        .join(''),
    )
    .join('\n')
    .trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length > TITLE_TEXT_MAX_LENGTH) return null;
  return cleaned;
}

/**
 * Escape sanitized text for FFmpeg drawtext. Order matters: backslashes
 * first, then the delimiters. Newlines become literal \n escapes, which
 * drawtext renders as line breaks.
 */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\n/g, '\\n');
}


/**
 * Perspective tilt corner projection for title layers (#519), a faithful
 * port of upstream TextTiltGeometry: X-then-Y tilt around a pivot with a
 * rect-independent focal length, in top-left canvas coordinates.
 */
export interface TiltCorner {
  x: number;
  y: number;
}

export interface TiltCorners {
  topLeft: TiltCorner;
  topRight: TiltCorner;
  bottomRight: TiltCorner;
  bottomLeft: TiltCorner;
}

export function titleTiltCorners(
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  pivot: { x: number; y: number },
  rotationXDeg: number,
  rotationYDeg: number,
  canvasSize: { width: number; height: number },
): TiltCorners {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const sinX = Math.sin(rad(rotationXDeg));
  const cosX = Math.cos(rad(rotationXDeg));
  const sinY = Math.sin(rad(rotationYDeg));
  const cosY = Math.cos(rad(rotationYDeg));

  const canvasExtent = Math.max(canvasSize.width, canvasSize.height);
  if (!Number.isFinite(canvasExtent) || canvasExtent <= 0) {
    return {
      topLeft: { x: rect.minX, y: rect.minY },
      topRight: { x: rect.maxX, y: rect.minY },
      bottomRight: { x: rect.maxX, y: rect.maxY },
      bottomLeft: { x: rect.minX, y: rect.maxY },
    };
  }

  // Focal length is rect-independent so every surface shares one projection.
  const maxHalfWidth = Math.max(
    (canvasSize.width * 1) / 2,
    Math.abs(pivot.x),
    Math.abs(canvasSize.width - pivot.x),
  );
  const maxHalfHeight = Math.max(
    canvasSize.height / 2,
    Math.abs(pivot.y),
    Math.abs(canvasSize.height - pivot.y),
  );
  const maxDepth = maxHalfWidth * Math.abs(sinY) + maxHalfHeight * Math.abs(sinX * cosY);
  const focalLength = Math.max(canvasExtent * 2, maxDepth + canvasExtent / 4);

  const project = (px: number, py: number): TiltCorner => {
    const x = px - pivot.x;
    const y = -(py - pivot.y);
    const tiltedX = x * cosY + y * sinX * sinY;
    const tiltedY = y * cosX;
    const depth = -x * sinY + y * sinX * cosY;
    const scale = focalLength / (focalLength + depth);
    return {
      x: pivot.x + tiltedX * scale,
      y: pivot.y + -tiltedY * scale,
    };
  };

  return {
    topLeft: project(rect.minX, rect.minY),
    topRight: project(rect.maxX, rect.minY),
    bottomRight: project(rect.maxX, rect.maxY),
    bottomLeft: project(rect.minX, rect.maxY),
  };
}

// ─── Variable-font axes (upstream issue #50) ─────────────────────────────
// Original design: upstream has no variable-font implementation at b4b1333,
// so the axis set follows CSS `font-variation-settings` reality — the four
// registered axes every variable font may interpolate (wght/wdth/slnt/ital).
//
// The axes ride `fontVariationSettings` in the shared canvas title renderer
// (renderer/engine/title-render.ts), so preview and the export bake see
// identical pixels for free; a non-variable font ignores unknown axes
// harmlessly. FFmpeg drawtext cannot express axes, so a title with
// non-default axes takes the bake pipeline (see isAdvancedTitle); when its
// bake is missing, export degrades to solid drawtext with the axes dropped
// rather than failing.
//
// Like every other title field: sanitize on write, narrow on read, absent =
// default. Defaults are never stored — a default value sanitizes to
// undefined — so field presence alone means "non-default, bake me".

/** Weight axis, OpenType wght 1–1000. Default 400 (regular). */
export const TITLE_VARIATION_WGHT_MIN = 1;
export const TITLE_VARIATION_WGHT_MAX = 1000;
export const TITLE_VARIATION_WGHT_DEFAULT = 400;
/** Width axis, CSS font-stretch 50–200%. Default 100 (normal). */
export const TITLE_VARIATION_WDTH_MIN = 50;
export const TITLE_VARIATION_WDTH_MAX = 200;
export const TITLE_VARIATION_WDTH_DEFAULT = 100;
/** Slant axis, CSS oblique −90–90°. Default 0 (upright). */
export const TITLE_VARIATION_SLNT_MIN = -90;
export const TITLE_VARIATION_SLNT_MAX = 90;
export const TITLE_VARIATION_SLNT_DEFAULT = 0;
/** Italic axis, 0 (roman) to 1 (italic). Default 0. */
export const TITLE_VARIATION_ITAL_MIN = 0;
export const TITLE_VARIATION_ITAL_MAX = 1;
export const TITLE_VARIATION_ITAL_DEFAULT = 0;

/** Weight axis: finite, rounded to an int, in range; default/absent → undefined. */
export function sanitizeTitleVariationWght(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const value = Math.round(raw);
  if (value < TITLE_VARIATION_WGHT_MIN || value > TITLE_VARIATION_WGHT_MAX) return undefined;
  return value === TITLE_VARIATION_WGHT_DEFAULT ? undefined : value;
}

/** Width axis: finite, rounded to an int, in range; default/absent → undefined. */
export function sanitizeTitleVariationWdth(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const value = Math.round(raw);
  if (value < TITLE_VARIATION_WDTH_MIN || value > TITLE_VARIATION_WDTH_MAX) return undefined;
  return value === TITLE_VARIATION_WDTH_DEFAULT ? undefined : value;
}

/** Slant axis: finite, in range; default/absent → undefined. */
export function sanitizeTitleVariationSlnt(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (raw < TITLE_VARIATION_SLNT_MIN || raw > TITLE_VARIATION_SLNT_MAX) return undefined;
  return raw === TITLE_VARIATION_SLNT_DEFAULT ? undefined : raw;
}

/** Italic axis: finite, in range; default/absent → undefined. */
export function sanitizeTitleVariationItal(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (raw < TITLE_VARIATION_ITAL_MIN || raw > TITLE_VARIATION_ITAL_MAX) return undefined;
  return raw === TITLE_VARIATION_ITAL_DEFAULT ? undefined : raw;
}

interface TitleVariationLike {
  type?: unknown;
  titleVariationWght?: unknown;
  titleVariationWdth?: unknown;
  titleVariationSlnt?: unknown;
  titleVariationItal?: unknown;
}

/** True when any axis is present and non-default — the bake-routing condition. */
export function hasTitleVariations(clip: TitleVariationLike): boolean {
  return sanitizeTitleVariationWght(clip.titleVariationWght) !== undefined
    || sanitizeTitleVariationWdth(clip.titleVariationWdth) !== undefined
    || sanitizeTitleVariationSlnt(clip.titleVariationSlnt) !== undefined
    || sanitizeTitleVariationItal(clip.titleVariationItal) !== undefined;
}

/**
 * Build the CSS `font-variation-settings` value for a clip (`'"wght" 700,
 * "wdth" 75'`), or '' when no axis is non-default. Only sanitized values
 * are emitted, so preview and bake agree by construction.
 */
export function titleVariationSettings(clip: TitleVariationLike): string {
  const parts: string[] = [];
  const wght = sanitizeTitleVariationWght(clip.titleVariationWght);
  if (wght !== undefined) parts.push(`"wght" ${wght}`);
  const wdth = sanitizeTitleVariationWdth(clip.titleVariationWdth);
  if (wdth !== undefined) parts.push(`"wdth" ${wdth}`);
  const slnt = sanitizeTitleVariationSlnt(clip.titleVariationSlnt);
  if (slnt !== undefined) parts.push(`"slnt" ${slnt}`);
  const ital = sanitizeTitleVariationItal(clip.titleVariationItal);
  if (ital !== undefined) parts.push(`"ital" ${ital}`);
  return parts.join(', ');
}

/**
 * Narrow a stored clip's variation axes on read: hostile, hand-edited, or
 * default-valued entries degrade to absent (the renderers fall back to the
 * font's default axis), and a non-title clip passes through untouched.
 * Returns the input when clean.
 */
export function narrowTitleVariationClip<T extends TitleVariationLike>(clip: T): T {
  if (clip.type !== 'title') return clip;
  let next: TitleVariationLike | null = null;
  const drop = (
    key: 'titleVariationWght' | 'titleVariationWdth' | 'titleVariationSlnt' | 'titleVariationItal',
  ): void => {
    if (!next) next = { ...clip };
    delete next[key];
  };
  if (
    clip.titleVariationWght !== undefined
    && sanitizeTitleVariationWght(clip.titleVariationWght) === undefined
  ) {
    drop('titleVariationWght');
  }
  if (
    clip.titleVariationWdth !== undefined
    && sanitizeTitleVariationWdth(clip.titleVariationWdth) === undefined
  ) {
    drop('titleVariationWdth');
  }
  if (
    clip.titleVariationSlnt !== undefined
    && sanitizeTitleVariationSlnt(clip.titleVariationSlnt) === undefined
  ) {
    drop('titleVariationSlnt');
  }
  if (
    clip.titleVariationItal !== undefined
    && sanitizeTitleVariationItal(clip.titleVariationItal) === undefined
  ) {
    drop('titleVariationItal');
  }
  return (next ?? clip) as T;
}

/**
 * True when the clip needs the bake pipeline instead of drawtext — the single
 * bake gate. It lives here, beside the fields it reads, because the renderer
 * (preview and delivery panel) and the main process (FFmpeg graph) must agree:
 * a title that one side bakes and the other renders as drawtext silently
 * loses its styling, so the two used to hold separate copies of this
 * predicate and drift.
 */
export function isAdvancedTitle(clip: Clip): boolean {
  return clip.type === 'title'
    && Boolean(clip.text)
    && (
      clip.titleFillMode !== undefined
      || (clip.titleBlurRadius ?? 0) > 0
      || (clip.titleTiltXDeg ?? 0) !== 0
      || (clip.titleTiltYDeg ?? 0) !== 0
      // Variable-font axes (#50): drawtext has no variation parameter, so a
      // non-default axis always bakes — the shared drawTitle in
      // renderer/engine/title-render.ts carries the axes into the baked PNG
      // for free.
      || hasTitleVariations(clip)
    );
}
