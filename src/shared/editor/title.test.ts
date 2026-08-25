import { describe, it, expect } from 'vitest';
import {
  sanitizeTitleText,
  escapeDrawtext,
  TITLE_TEXT_MAX_LENGTH,
  DEFAULT_TITLE_STYLE,
  drawtextStyleParams,
  TITLE_BACKGROUND_PADDING_DEFAULT,
  applyTitleFontCase,
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

describe('drawtextStyleParams background box (#507 fitted boxes)', () => {
  const height = 1080;

  it('pads the box with the clip value when one is set', () => {
    const params = drawtextStyleParams(
      { titleBackgroundColor: '#00000080', titleBackgroundPadding: 24 },
      height,
    );
    expect(params).toContain('box=1:boxcolor=0x00000080');
    expect(params).toContain('boxborderw=24');
  });

  it('falls back to the shared default padding so both render paths agree', () => {
    const params = drawtextStyleParams({ titleBackgroundColor: '#11223344' }, height);
    expect(params).toContain(`boxborderw=${TITLE_BACKGROUND_PADDING_DEFAULT}`);
  });

  it('emits no box without a background color, padding alone included', () => {
    expect(drawtextStyleParams({ titleBackgroundPadding: 40 }, height)).toBe('');
  });

  it('emits line_spacing only when a positive spacing is set', () => {
    expect(drawtextStyleParams({ titleLineSpacing: 12 }, height)).toContain('line_spacing=12');
    expect(drawtextStyleParams({ titleLineSpacing: 0 }, height)).toBe('');
    expect(drawtextStyleParams({}, height)).toBe('');
  });
});

describe('applyTitleFontCase (upstream #330)', () => {
  it('transforms the whole string including newlines', () => {
    expect(applyTitleFontCase('Mixed Case\nsecond line', 'upper')).toBe('MIXED CASE\nSECOND LINE');
    expect(applyTitleFontCase('Mixed Case', 'lower')).toBe('mixed case');
  });

  it('leaves text untouched for original and unset modes', () => {
    const text = 'MiXeD';
    expect(applyTitleFontCase(text, 'original')).toBe(text);
    expect(applyTitleFontCase(text, undefined)).toBe(text);
  });
});
