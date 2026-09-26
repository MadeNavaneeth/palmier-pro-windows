import { describe, it, expect } from 'vitest';
import type { Clip } from '../types/project';
import {
  sanitizeTitleText,
  escapeDrawtext,
  TITLE_TEXT_MAX_LENGTH,
  DEFAULT_TITLE_STYLE,
  drawtextStyleParams,
  TITLE_BACKGROUND_PADDING_DEFAULT,
  applyTitleFontCase,
  TITLE_VARIATION_WGHT_DEFAULT,
  TITLE_VARIATION_WDTH_DEFAULT,
  TITLE_VARIATION_SLNT_DEFAULT,
  TITLE_VARIATION_ITAL_DEFAULT,
  hasTitleVariations,
  isAdvancedTitle,
  narrowTitleVariationClip,
  sanitizeTitleVariationItal,
  sanitizeTitleVariationSlnt,
  sanitizeTitleVariationWdth,
  sanitizeTitleVariationWght,
  titleVariationSettings,
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

describe('title variable-font axes (upstream #50)', () => {
  it('keeps in-range values, rounding weight/width to ints', () => {
    expect(sanitizeTitleVariationWght(700)).toBe(700);
    expect(sanitizeTitleVariationWght(700.6)).toBe(701);
    expect(sanitizeTitleVariationWdth(75)).toBe(75);
    expect(sanitizeTitleVariationWdth(75.4)).toBe(75);
    expect(sanitizeTitleVariationSlnt(-12)).toBe(-12);
    expect(sanitizeTitleVariationSlnt(12.5)).toBe(12.5);
    expect(sanitizeTitleVariationItal(1)).toBe(1);
    expect(sanitizeTitleVariationItal(0.5)).toBe(0.5);
  });

  it('drops out-of-range and non-numeric input', () => {
    expect(sanitizeTitleVariationWght(0)).toBeUndefined();
    expect(sanitizeTitleVariationWght(1001)).toBeUndefined();
    expect(sanitizeTitleVariationWght(Number.NaN)).toBeUndefined();
    expect(sanitizeTitleVariationWght('700')).toBeUndefined();
    expect(sanitizeTitleVariationWdth(49)).toBeUndefined();
    expect(sanitizeTitleVariationWdth(201)).toBeUndefined();
    expect(sanitizeTitleVariationSlnt(-91)).toBeUndefined();
    expect(sanitizeTitleVariationSlnt(91)).toBeUndefined();
    expect(sanitizeTitleVariationItal(-0.1)).toBeUndefined();
    expect(sanitizeTitleVariationItal(1.1)).toBeUndefined();
    expect(sanitizeTitleVariationItal(null)).toBeUndefined();
  });

  it('maps defaults to absent so presence always means non-default', () => {
    expect(sanitizeTitleVariationWght(TITLE_VARIATION_WGHT_DEFAULT)).toBeUndefined();
    expect(sanitizeTitleVariationWdth(TITLE_VARIATION_WDTH_DEFAULT)).toBeUndefined();
    expect(sanitizeTitleVariationSlnt(TITLE_VARIATION_SLNT_DEFAULT)).toBeUndefined();
    expect(sanitizeTitleVariationItal(TITLE_VARIATION_ITAL_DEFAULT)).toBeUndefined();
  });

  it('emits font-variation-settings only for non-default axes', () => {
    expect(titleVariationSettings({})).toBe('');
    expect(titleVariationSettings({
      titleVariationWght: TITLE_VARIATION_WGHT_DEFAULT,
      titleVariationWdth: TITLE_VARIATION_WDTH_DEFAULT,
      titleVariationSlnt: TITLE_VARIATION_SLNT_DEFAULT,
      titleVariationItal: TITLE_VARIATION_ITAL_DEFAULT,
    })).toBe('');
    expect(titleVariationSettings({ titleVariationWght: 700 })).toBe('"wght" 700');
    expect(titleVariationSettings({
      titleVariationWght: 700,
      titleVariationWdth: 75,
      titleVariationSlnt: -12,
      titleVariationItal: 1,
    })).toBe('"wght" 700, "wdth" 75, "slnt" -12, "ital" 1');
    // Invalid values never reach the canvas string.
    expect(titleVariationSettings({ titleVariationWght: 9999 })).toBe('');
  });

  it('detects the bake-routing condition', () => {
    expect(hasTitleVariations({})).toBe(false);
    expect(hasTitleVariations({ titleVariationWght: 400 })).toBe(false);
    expect(hasTitleVariations({ titleVariationWght: 9999 })).toBe(false);
    expect(hasTitleVariations({ titleVariationWght: 700 })).toBe(true);
    expect(hasTitleVariations({ titleVariationWdth: 80 })).toBe(true);
    expect(hasTitleVariations({ titleVariationSlnt: -8 })).toBe(true);
    expect(hasTitleVariations({ titleVariationItal: 1 })).toBe(true);
  });

  it('narrows hostile stored values on load without breaking', () => {
    const clean = { type: 'title', titleVariationWght: 700 };
    expect(narrowTitleVariationClip(clean)).toBe(clean);

    const tainted = {
      type: 'title',
      titleVariationWght: 9999,
      titleVariationWdth: 'wide',
      titleVariationSlnt: 0, // a stored default normalizes away
      titleVariationItal: 0.5,
    };
    const narrowed = narrowTitleVariationClip(tainted);
    expect(narrowed).not.toBe(tainted);
    expect(narrowed).toEqual({ type: 'title', titleVariationItal: 0.5 });

    // Non-title clips pass through untouched.
    const video = { type: 'video', titleVariationWght: 9999 };
    expect(narrowTitleVariationClip(video)).toBe(video);
  });
});

describe('isAdvancedTitle (the one bake gate)', () => {
  /*
   * The two definitions this predicate replaced, verbatim. They were
   * byte-identical apart from their comments, which is why collapsing them was
   * safe -- but "were identical" is a claim about the past, so both copies
   * stay here as oracles and every case below must agree with all three.
   */
  const rendererBakeGate = (clip: Clip): boolean =>
    clip.type === 'title'
    && Boolean(clip.text)
    && (
      clip.titleFillMode !== undefined
      || (clip.titleBlurRadius ?? 0) > 0
      || (clip.titleTiltXDeg ?? 0) !== 0
      || (clip.titleTiltYDeg ?? 0) !== 0
      || hasTitleVariations(clip)
    );
  const mainBakeGate = (clip: Clip): boolean =>
    clip.type === 'title'
    && Boolean(clip.text)
    && (
      clip.titleFillMode !== undefined
      || (clip.titleBlurRadius ?? 0) > 0
      || (clip.titleTiltXDeg ?? 0) !== 0
      || (clip.titleTiltYDeg ?? 0) !== 0
      || hasTitleVariations(clip)
    );

  function titleClip(overrides: Partial<Clip> = {}): Clip {
    return {
      id: 'c1',
      assetId: '__title__',
      type: 'title',
      trackId: 'v1',
      startFrame: 0,
      durationFrames: 30,
      inPoint: 0,
      outPoint: 30,
      text: 'Hello',
      x: 0,
      y: 0,
      width: 800,
      height: 200,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      anchorX: 0,
      anchorY: 0,
      volume: 1,
      muted: false,
      ...overrides,
    } as Clip;
  }

  const FILLS = [undefined, 'footage', 'inverted'] as const;
  const BLURS = [undefined, 0, 6];
  const TILT_X = [undefined, 0, 12];
  const TILT_Y = [undefined, 0, -20];
  const AXES: Array<Partial<Clip>> = [
    {},
    { titleVariationWght: 700 },
    { titleVariationWdth: 75 },
    { titleVariationSlnt: -12 },
    { titleVariationItal: 1 },
    { titleVariationWght: TITLE_VARIATION_WGHT_DEFAULT }, // default, stays plain
    { titleVariationWght: 9999 }, // rejected by the sanitizer, stays plain
  ];

  it('agrees with both former definitions across every keyed-field combination', () => {
    let cases = 0;
    for (const titleFillMode of FILLS) {
      for (const titleBlurRadius of BLURS) {
        for (const titleTiltXDeg of TILT_X) {
          for (const titleTiltYDeg of TILT_Y) {
            for (const axes of AXES) {
              const clip = titleClip({
                ...(titleFillMode !== undefined ? { titleFillMode } : {}),
                ...(titleBlurRadius !== undefined ? { titleBlurRadius } : {}),
                ...(titleTiltXDeg !== undefined ? { titleTiltXDeg } : {}),
                ...(titleTiltYDeg !== undefined ? { titleTiltYDeg } : {}),
                ...axes,
              });
              const actual = isAdvancedTitle(clip);
              expect([rendererBakeGate(clip), mainBakeGate(clip)]).toEqual([actual, actual]);
              cases += 1;
            }
          }
        }
      }
    }
    expect(cases).toBe(3 * 3 * 3 * 3 * 7);
  });

  it('classifies a plain title the same way all three copies do', () => {
    // Every field drawtext CAN express, so no bake is required.
    const plain = titleClip({
      titleColor: '#ffcc00',
      titleBold: true,
      titleFontFamily: 'Georgia',
      titleAlign: 'left',
      titleLineSpacing: 6,
      titleBackgroundColor: '#00000080',
      titleStrokeWidth: 2,
      titleStrokeColor: '#000000',
    });
    expect(isAdvancedTitle(plain)).toBe(false);
    expect(rendererBakeGate(plain)).toBe(false);
    expect(mainBakeGate(plain)).toBe(false);
  });

  it('agrees on the type and text guards, which gate every keyed field', () => {
    const cases: Clip[] = [
      titleClip({ type: 'video', titleFillMode: 'footage' }),
      titleClip({ type: 'audio', titleFillMode: 'footage' }),
      titleClip({ text: '', titleFillMode: 'footage' }),
      titleClip({ text: undefined, titleFillMode: 'footage' }),
      titleClip({ titleFillMode: 'footage' }),
    ];
    for (const clip of cases) {
      const actual = isAdvancedTitle(clip);
      expect(rendererBakeGate(clip)).toBe(actual);
      expect(mainBakeGate(clip)).toBe(actual);
    }
    // Only the clip that is a title AND has text reaches the keyed fields.
    expect(cases.map((clip) => isAdvancedTitle(clip))).toEqual([false, false, false, false, true]);
  });

  it('routes each advanced feature to a bake in all three copies', () => {
    const advanced: Clip[] = [
      titleClip({ titleFillMode: 'footage' }),
      titleClip({ titleFillMode: 'inverted' }),
      titleClip({ titleBlurRadius: 4 }),
      titleClip({ titleTiltXDeg: 12 }),
      titleClip({ titleTiltYDeg: -20 }),
      titleClip({ titleVariationWght: 700 }),
      titleClip({ titleVariationWdth: 75 }),
      titleClip({ titleVariationSlnt: -12 }),
      titleClip({ titleVariationItal: 1 }),
    ];
    for (const clip of advanced) {
      const actual = isAdvancedTitle(clip);
      expect(actual).toBe(true);
      expect(rendererBakeGate(clip)).toBe(actual);
      expect(mainBakeGate(clip)).toBe(actual);
    }
  });

  it('treats explicit zero tilt and default axes as plain', () => {
    const plain = titleClip({
      titleTiltXDeg: 0,
      titleTiltYDeg: 0,
      titleBlurRadius: 0,
      titleVariationWght: TITLE_VARIATION_WGHT_DEFAULT,
      titleVariationWdth: TITLE_VARIATION_WDTH_DEFAULT,
      titleVariationSlnt: TITLE_VARIATION_SLNT_DEFAULT,
      titleVariationItal: TITLE_VARIATION_ITAL_DEFAULT,
    });
    expect(isAdvancedTitle(plain)).toBe(false);
    expect(rendererBakeGate(plain)).toBe(false);
    expect(mainBakeGate(plain)).toBe(false);
  });
});
