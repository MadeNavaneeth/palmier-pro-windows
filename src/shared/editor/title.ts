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

import type { Frame } from '../types/project';

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
