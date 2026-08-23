import { describe, it, expect } from 'vitest';
import {
  sanitizeTitleText,
  escapeDrawtext,
  TITLE_TEXT_MAX_LENGTH,
  DEFAULT_TITLE_STYLE,
} from './title';

describe('sanitizeTitleText', () => {
  it('trims and preserves intentional newlines', () => {
    expect(sanitizeTitleText('  line one\nline two  ')).toBe('line one\nline two');
  });

  it('rejects empty results and over-length text', () => {
    expect(sanitizeTitleText('   ')).toBeNull();
    expect(sanitizeTitleText('x'.repeat(TITLE_TEXT_MAX_LENGTH + 1))).toBeNull();
    expect(sanitizeTitleText('x'.repeat(TITLE_TEXT_MAX_LENGTH))).toBe(
      'x'.repeat(TITLE_TEXT_MAX_LENGTH),
    );
  });

  it('strips control characters but keeps tabs', () => {
    expect(sanitizeTitleText('a\u0000b\u0007c')).toBe('abc');
    expect(sanitizeTitleText('col\tumn')).toBe('col\tumn');
  });
});

describe('escapeDrawtext', () => {
  it('escapes drawtext delimiters in safe order', () => {
    expect(escapeDrawtext('back\\slash')).toBe('back\\\\slash');
    expect(escapeDrawtext('a: b')).toBe('a\\: b');
    expect(escapeDrawtext("don't")).toBe("don\\'t");
    expect(escapeDrawtext('100%')).toBe('100\\%');
  });

  it('encodes newlines as literal \\n escapes', () => {
    expect(escapeDrawtext('two\nlines')).toBe('two\\nlines');
  });

  it('survives the round trip a filter parser would do', () => {
    // The parser splits options on ':' and unescapes '\\' sequences; the
    // escaped form must therefore contain no raw delimiters.
    const dangerous = String.raw`C:\path 'quoted' 100%: done`;
    const escaped = escapeDrawtext(dangerous);
    expect(escaped).not.toMatch(/(?<!\\):/);
    expect(escaped).not.toMatch(/(?<!\\)'/);
  });
});

describe('DEFAULT_TITLE_STYLE', () => {
  it('is white at roughly a tenth of the frame height', () => {
    expect(DEFAULT_TITLE_STYLE.colorHex).toBe('#ffffff');
    expect(DEFAULT_TITLE_STYLE.sizeRatio).toBeGreaterThan(0);
    expect(DEFAULT_TITLE_STYLE.sizeRatio).toBeLessThan(0.5);
  });
});
