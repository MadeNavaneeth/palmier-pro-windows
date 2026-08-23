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
}

export const DEFAULT_TITLE_STYLE: TitleStyle = {
  sizeRatio: 0.09,
  colorHex: '#ffffff',
};

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
