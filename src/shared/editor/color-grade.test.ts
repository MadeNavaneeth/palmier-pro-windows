import { describe, it, expect } from 'vitest';
import {
  DEFAULT_COLOR_GRADE,
  GRADE_PRESETS,
  GRADE_PRESET_NAME_MAX,
  MAX_USER_GRADE_PRESETS,
  colorGradeOf,
  gradePresetById,
  hasColorGrade,
  normalizeUserGradePresets,
  sanitizeColorGrade,
  toCanvasFilter,
  toFfmpegColorChain,
  toFfmpegEq,
} from './color-grade';
import type { Clip } from '../types/project';
import { applyGradeToRgba, exposureGain, gradePixel, highlightsShadowsPixel, blacksWhitesPixel, vibrancePixel, whiteBalanceGains } from './color-grade';
import {
  COLOR_GRADE_CURVE_LIMITS,
  COLOR_GRADE_HUE_CURVE_LIMITS,
  COLOR_GRADE_WHEEL_LIMITS,
  DEFAULT_GRADE_WHEELS,
  DEFAULT_HUE_CURVE_POINTS,
  HUE_CURVE_CHANNELS,
  HUE_CURVE_LUT_WIDTH,
  HUE_CURVE_NEUTRAL_Y,
  IDENTITY_CURVE_POINTS,
  buildGradeCurveLuts,
  buildHueCurveLuts,
  buildWheelsCoeffs,
  evalCurve,
  evalHueCurve,
  gradeCurvePixel,
  gradeCurvesEqual,
  gradeWheelsEqual,
  hsv2rgb,
  hueCurvesEqual,
  hueCurvesPixel,
  isIdentityGradeCurve,
  isIdentityGradeWheels,
  isIdentityHueCurves,
  isIdentityPoints,
  isNeutralHuePoints,
  parseGradeCurvePatch,
  parseGradeWheelsPatch,
  parseHueCurvesPatch,
  rgb2hsv,
  sanitizeGradeCurve,
  sanitizeGradeWheels,
  sanitizeHueCurves,
  toFfmpegCurveFilters,
  toFfmpegHueCurveFilters,
  toFfmpegLutSingleFilter,
  toFfmpegPostLutChain,
  toFfmpegPreLutChain,
  toFfmpegWheelsFilter,
  wheelsChromaOffset,
  wheelsCoefficients,
  wheelsHueRGB,
  wheelsPixel,
} from './color-grade';
import { parseCubeText, type LutRef } from './lut';
import type { GradeCurve, GradeWheels, HueCurves } from './color-grade';

/** Neutral grade for the pixel-math tests below. */
const IDENTITY = { brightness: 0, contrast: 1, saturation: 1, hueRotation: 0, exposure: 0, temperature: 6500, tint: 0, vibrance: 0, highlights: 0, shadows: 0, blacks: 0, whites: 0, invertColors: false };

function clip(fields: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', type: 'video', trackId: 'v1',
    startFrame: 0, durationFrames: 10, inPoint: 0, outPoint: 10,
    x: 0, y: 0, width: 16, height: 9, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    ...fields,
  };
}

describe('colorGradeOf', () => {
  it('returns null for ungraded clips', () => {
    expect(colorGradeOf(clip())).toBeNull();
    expect(colorGradeOf(clip({ brightness: 0 }))).toBeNull();
    expect(colorGradeOf(clip({ contrast: 1 }))).toBeNull();
  });

  it('returns the grade when any field differs from default', () => {
    const g = colorGradeOf(clip({ brightness: -0.2 }));
    expect(g).toEqual({ brightness: -0.2, contrast: 1, saturation: 1, hueRotation: 0, exposure: 0, temperature: 6500, tint: 0, vibrance: 0, highlights: 0, shadows: 0, blacks: 0, whites: 0, invertColors: false });
  });
});

describe('hasColorGrade', () => {
  it('is false when no color fields are set', () => {
    expect(hasColorGrade(clip())).toBe(false);
  });

  it('is true when any color field is set', () => {
    expect(hasColorGrade(clip({ saturation: 0.5 }))).toBe(true);
    expect(hasColorGrade(clip({ hueRotation: 90 }))).toBe(true);
  });
});

describe('toCanvasFilter / toFfmpegEq', () => {
  it('produces matching semantics for both consumers', () => {
    const grade = { brightness: -0.15, contrast: 1.3, saturation: 0.6, hueRotation: 45, exposure: 0, temperature: 6500, tint: 0, vibrance: 0, highlights: 0, shadows: 0, blacks: 0, whites: 0 };
    const canvas = toCanvasFilter(grade);
    const ffmpeg = toFfmpegEq(grade);
    // Canvas uses CSS function syntax.
    expect(canvas).toContain('brightness(-0.150)');
    expect(canvas).toContain('contrast(1.300)');
    expect(canvas).toContain('saturate(0.600)');
    expect(canvas).toContain('hue-rotate(45.0deg)');
    // FFmpeg eq carries only eq options.
    expect(ffmpeg).toContain('brightness=-0.150000');
    expect(ffmpeg).toContain('contrast=1.300000');
    expect(ffmpeg).toContain('saturation=0.600000');
    expect(ffmpeg).not.toContain('hue=');
  });

  it('emits hue rotation and invert as their own filters, in order', () => {
    expect(toFfmpegColorChain({
      brightness: -0.15, contrast: 1.3, saturation: 0.6, hueRotation: 45, exposure: 0, temperature: 6500, tint: 0, vibrance: 0, highlights: 0, shadows: 0, blacks: 0, whites: 0, invertColors: true,
    })).toEqual([
      'eq=brightness=-0.150000:contrast=1.300000:saturation=0.600000',
      'hue=h=45.0',
      'negate',
    ]);
    // Hue alone is still its own filter, never an eq option.
    expect(toFfmpegColorChain({
      brightness: 0, contrast: 1, saturation: 1, hueRotation: 90, exposure: 0, temperature: 6500, tint: 0, vibrance: 0, highlights: 0, shadows: 0, blacks: 0, whites: 0,
    })).toEqual(['hue=h=90.0']);
    expect(toFfmpegColorChain({
      brightness: 0, contrast: 1, saturation: 1, hueRotation: 0, exposure: 0, temperature: 6500, tint: 0, vibrance: 0, highlights: 0, shadows: 0, blacks: 0, whites: 0, invertColors: true,
    })).toEqual(['negate']);
  });

  it('returns empty strings for default grades', () => {
    const g = { brightness: 0, contrast: 1, saturation: 1, hueRotation: 0, exposure: 0, temperature: 6500, tint: 0, vibrance: 0, highlights: 0, shadows: 0, blacks: 0, whites: 0 };
    expect(toCanvasFilter(g)).toBe('');
    expect(toFfmpegEq(g)).toBe('');
  });
});

describe('sanitizeColorGrade (#157)', () => {
  it('keeps finite in-range values', () => {
    expect(sanitizeColorGrade({ brightness: -0.5, hueRotation: 90 })).toEqual({
      brightness: -0.5,
      hueRotation: 90,
    });
  });

  it('drops out-of-range values instead of clamping them to a boundary', () => {
    expect(sanitizeColorGrade({ contrast: 99 })).toEqual({});
    expect(sanitizeColorGrade({ saturation: -3 })).toEqual({});
    expect(sanitizeColorGrade({ hueRotation: 900 })).toEqual({});
  });

  it('drops non-finite values from an untrusted writer', () => {
    expect(sanitizeColorGrade({ brightness: Number.NaN })).toEqual({});
    expect(sanitizeColorGrade({ brightness: Number.POSITIVE_INFINITY })).toEqual({});
  });

  it('passes invertColors through only as a boolean', () => {
    expect(sanitizeColorGrade({ invertColors: true })).toEqual({ invertColors: true });
    // @ts-expect-error probe: a corrupt stored value must not become truthy
    expect(sanitizeColorGrade({ invertColors: 'yes' })).toEqual({});
  });

  it('returns an empty patch for absent input', () => {
    expect(sanitizeColorGrade(undefined)).toEqual({});
    expect(sanitizeColorGrade({})).toEqual({});
  });
});

describe('grade presets (#157)', () => {
  it('keeps every preset value inside the slider limits', () => {
    for (const preset of GRADE_PRESETS) {
      const sanitized = sanitizeColorGrade(preset.grade);
      expect(sanitized, preset.id).toEqual(preset.grade);
    }
  });

  it('offers Neutral as an empty grade that clears everything', () => {
    const neutral = gradePresetById('neutral');
    expect(neutral?.grade).toEqual({});
    expect(gradePresetById('nope')).toBeUndefined();
  });

  it('defaults match the neutral preset', () => {
    expect(DEFAULT_COLOR_GRADE).toEqual({
      brightness: 0,
      contrast: 1,
      saturation: 1,
      hueRotation: 0,
      exposure: 0,
      temperature: 6500,
      tint: 0,
      vibrance: 0,
      highlights: 0,
      shadows: 0,
      blacks: 0,
      whites: 0,
      invertColors: false,
    });
  });
});

describe('normalizeUserGradePresets (#157)', () => {
  it('keeps valid entries and sanitizes their grades', () => {
    const result = normalizeUserGradePresets([
      { id: 'user-abc', label: '  My Look  ', grade: { brightness: 0.2, nonsense: true } },
    ]);
    expect(result).toEqual([
      { id: 'user-abc', label: 'My Look', grade: { brightness: 0.2 } },
    ]);
  });

  it('drops entries with bad ids, names, or empty grades', () => {
    expect(normalizeUserGradePresets([
      { id: 'has spaces', label: 'X', grade: { brightness: 0.1 } },
      { id: 'ok1', label: '', grade: { brightness: 0.1 } },
      { id: 'ok2', label: 'x'.repeat(GRADE_PRESET_NAME_MAX + 1), grade: { contrast: 1.2 } },
      { id: 'ok3', label: 'Empty', grade: {} },
      { id: 'ok4', label: 'Absurd', grade: { contrast: 99 } },
      null,
      'nope',
    ])).toEqual([]);
  });

  it('never returns more than the cap and lets later duplicates win', () => {
    const many = Array.from({ length: MAX_USER_GRADE_PRESETS + 10 }, (_, index) => ({
      id: `user-${index}`,
      label: `P${index}`,
      grade: { brightness: 0.1 },
    }));
    expect(normalizeUserGradePresets(many)).toHaveLength(MAX_USER_GRADE_PRESETS);

    const dup = normalizeUserGradePresets([
      { id: 'user-1', label: 'First', grade: { brightness: 0.1 } },
      { id: 'user-1', label: 'Second', grade: { brightness: 0.2 } },
    ]);
    expect(dup).toEqual([{ id: 'user-1', label: 'Second', grade: { brightness: 0.2 } }]);
  });
});

describe('gradePixel (#157)', () => {
  it('passes an ungraded pixel through byte-identically', () => {
    for (const pixel of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [18, 52, 86], [0, 255, 0]] as const) {
      expect(gradePixel(pixel[0], pixel[1], pixel[2], IDENTITY)).toEqual([...pixel]);
    }
  });

  it('adds brightness after contrast scaling, on luma only', () => {
    // Achromatic gray stays achromatic: (100,100,100) has Y=100 exactly.
    expect(gradePixel(100, 100, 100, { ...IDENTITY, brightness: 0.2 })).toEqual([151, 151, 151]);
    expect(gradePixel(100, 100, 100, { ...IDENTITY, brightness: -1 })).toEqual([0, 0, 0]);
    // Contrast pivots about center: 128 is invariant, extremes move apart.
    expect(gradePixel(128, 128, 128, { ...IDENTITY, contrast: 2 })).toEqual([128, 128, 128]);
  });

  it('desaturates in YUV: chroma collapses to center, luma survives', () => {
    // Y(200,100,50) = 124.2; saturation 0 must leave exactly that, thrice.
    expect(gradePixel(200, 100, 50, { ...IDENTITY, saturation: 0 })).toEqual([124, 124, 124]);
  });

  it('inverts per YUV plane, which is not RGB invert', () => {
    // Mid-gray shows the chroma-offset subtlety: U/V sit at 128, and the
    // plane flip sends them to 127, not 128 — so the result is (126,128,125),
    // while an RGB `255-v` preview would say (128,128,128) and never match
    // FFmpeg's `negate` here.
    expect(gradePixel(128, 128, 128, { ...IDENTITY, invertColors: true })).toEqual([126, 128, 125]);
    // Black: Y 0->255, U/V 128->127. In RGB that is (254,255,253), not white:
    // the +128 chroma offset flips with the plane, so an RGB `255-v` preview
    // would never match FFmpeg's `negate` here.
    expect(gradePixel(0, 0, 0, { ...IDENTITY, invertColors: true })).toEqual([254, 255, 253]);
    // Double invert is the identity, exactly.
    const once = gradePixel(18, 52, 86, { ...IDENTITY, invertColors: true });
    const twice = gradePixel(once[0], once[1], once[2], { ...IDENTITY, invertColors: true });
    expect(twice).toEqual([18, 52, 86]);
  });

  it('rotates hue and returns after a full turn', () => {
    const original: [number, number, number] = [200, 100, 50];
    const rotated = gradePixel(original[0], original[1], original[2], { ...IDENTITY, hueRotation: 360 });
    expect(rotated).toEqual([...original]);
    // A real rotation moves chroma: 180 degrees must change a saturated pixel.
    const half = gradePixel(original[0], original[1], original[2], { ...IDENTITY, hueRotation: 180 });
    expect(half).not.toEqual([...original]);
  });
});

describe('applyGradeToRgba (#157)', () => {
  it('clamps explicitly because plain byte arrays wrap on overflow', () => {
    // Contrast 3 on white drives channels to ~509; a Uint8Array would wrap
    // those to ~253 without the explicit clamp (Uint8ClampedArray hides it).
    const data = new Uint8Array([255, 255, 255, 255]);
    applyGradeToRgba(data, { ...IDENTITY, contrast: 3 });
    expect([...data]).toEqual([255, 255, 255, 255]);
  });

  it('never touches alpha', () => {
    const data = new Uint8Array([200, 100, 50, 0, 10, 20, 30, 128]);
    applyGradeToRgba(data, { ...IDENTITY, brightness: 0.5, invertColors: true });
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(128);
  });

  it('degrades non-finite input deterministically instead of writing garbage', () => {
    const data = new Uint8Array([100, 100, 100, 255]);
    applyGradeToRgba(data, { ...IDENTITY, brightness: Number.NaN });
    expect([...data.slice(0, 3)]).toEqual([0, 0, 0]);
    expect(data[3]).toBe(255);
  });

  it('leaves buffers without a grade byte-identical (the ungraded fast path)', () => {
    const data = new Uint8Array([18, 52, 86, 255, 200, 100, 50, 128]);
    const before = [...data];
    applyGradeToRgba(data, IDENTITY);
    expect([...data]).toEqual(before);
  });
});

describe('exposure (#157)', () => {
  it('maps EV stops to gain: +1 doubles, -1 halves, 0 is identity', () => {
    expect(exposureGain(0)).toBe(1);
    expect(exposureGain(1)).toBe(2);
    expect(exposureGain(-1)).toBe(0.5);
    expect(exposureGain(2)).toBe(4);
  });

  it('applies gain before every other grade operation', () => {
    // Achromatic gray isolates the gain: (100,100,100) at +1 EV is exactly
    // (200,200,200), since gain precedes the YUV pipeline.
    expect(gradePixel(100, 100, 100, { ...IDENTITY, exposure: 1 })).toEqual([200, 200, 200]);
    expect(gradePixel(100, 100, 100, { ...IDENTITY, exposure: -1 })).toEqual([50, 50, 50]);
  });

  it('clamps and truncates like the export geq expression, never wrapping', () => {
    // Gain 32x on white would wrap a plain byte array to dark garbage.
    const data = new Uint8Array([200, 200, 200, 255]);
    applyGradeToRgba(data, { ...IDENTITY, exposure: 5 });
    expect([...data]).toEqual([255, 255, 255, 255]);
    // A fractional gain truncates toward zero, mirroring the C cast.
    expect(gradePixel(100, 100, 100, { ...IDENTITY, exposure: 0.5 })).toEqual([141, 141, 141]);
  });

  it('emits vibrance with explicit luma weights, ahead of eq', () => {
    // The weights ride the filter because several shipped FFmpeg releases
    // carry them swapped; relying on per-build defaults would render the same
    // project differently per machine.
    expect(toFfmpegColorChain({ ...IDENTITY, vibrance: 0.5 })).toEqual([
      'vibrance=0.5:rlum=0.212656:glum=0.715158:blum=0.072186',
    ]);
    // Position in the chain: after the gain geq, before eq.
    expect(toFfmpegColorChain({ ...IDENTITY, exposure: 1, vibrance: 0.5, contrast: 1.2 })).toEqual([
      expect.stringContaining('geq='),
      expect.stringContaining('vibrance=0.5:'),
      expect.stringContaining('eq=contrast=1.200000'),
    ]);
  });

  it('emits the gain as a clamped geq segment ahead of eq', () => {
    expect(toFfmpegColorChain({ ...IDENTITY, exposure: 1 })).toEqual([
      "geq=r='min(max(r(X,Y)*2.000000,0),255)':g='min(max(g(X,Y)*2.000000,0),255)':b='min(max(b(X,Y)*2.000000,0),255)':a='alpha(X,Y)'",
    ]);
    // Order with the rest of the chain: exposure first, then eq, hue, negate.
    expect(toFfmpegColorChain({ ...IDENTITY, exposure: -1, contrast: 1.2, invertColors: true })[0]).toContain('geq=');
    expect(toFfmpegColorChain({ ...IDENTITY, exposure: -1, contrast: 1.2, invertColors: true })).toEqual([
      "geq=r='min(max(r(X,Y)*0.500000,0),255)':g='min(max(g(X,Y)*0.500000,0),255)':b='min(max(b(X,Y)*0.500000,0),255)':a='alpha(X,Y)'",
      'eq=contrast=1.200000',
      'negate',
    ]);
  });

  it('sanitizes exposure to -5..+5 EV, dropping the absurd', () => {
    expect(sanitizeColorGrade({ exposure: 2 })).toEqual({ exposure: 2 });
    expect(sanitizeColorGrade({ exposure: -5 })).toEqual({ exposure: -5 });
    expect(sanitizeColorGrade({ exposure: 99 })).toEqual({});
    expect(sanitizeColorGrade({ exposure: Number.NaN })).toEqual({});
  });

  it('sanitizes white balance to Kelvin/tint ranges, dropping the absurd', () => {
    expect(sanitizeColorGrade({ temperature: 3200, tint: 10 })).toEqual({ temperature: 3200, tint: 10 });
    expect(sanitizeColorGrade({ temperature: 100 })).toEqual({});
    expect(sanitizeColorGrade({ tint: 200 })).toEqual({});
  });

  it('sanitizes vibrance to -1..+1, dropping the absurd', () => {
    expect(sanitizeColorGrade({ vibrance: 0.5 })).toEqual({ vibrance: 0.5 });
    expect(sanitizeColorGrade({ vibrance: -1 })).toEqual({ vibrance: -1 });
    expect(sanitizeColorGrade({ vibrance: 2 })).toEqual({});
    expect(sanitizeColorGrade({ vibrance: Number.NaN })).toEqual({});
  });
});

describe('whiteBalanceGains (#157)', () => {
  it('is identity at D65 with no tint', () => {
    expect(whiteBalanceGains(6500, 0)).toEqual([1, 1, 1]);
  });

  it('cools warm footage and warms cool footage', () => {
    // 3200K light is warm (red-heavy), so the correction cools: blue gain
    // above red gain. 8000K is the reverse.
    const warm = whiteBalanceGains(3200, 0);
    expect(warm[0]).toBeLessThan(warm[2]);
    const cool = whiteBalanceGains(8000, 0);
    expect(cool[0]).toBeGreaterThan(cool[2]);
    for (const gains of [warm, cool]) {
      for (const gain of gains) {
        expect(gain).toBeGreaterThan(0);
        expect(Number.isFinite(gain)).toBe(true);
      }
    }
  });

  it('pushes magenta and green on the tint axis', () => {
    // Positive tint lifts red/blue against green (magenta); the formula is
    // this port's mapping, so the test pins direction, not a standard.
    expect(whiteBalanceGains(6500, 100)).toEqual([1.25, 0.75, 1.25]);
    expect(whiteBalanceGains(6500, -100)).toEqual([0.75, 1.25, 0.75]);
  });

  it('rides the same clamped geq segment as exposure, ahead of eq', () => {
    const [wr, wg, wb] = whiteBalanceGains(3200, 10);
    const chain = toFfmpegColorChain({
      brightness: 0, contrast: 1, saturation: 1, hueRotation: 0,
      exposure: 0, temperature: 3200, tint: 10, vibrance: 0,
      highlights: 0, shadows: 0, blacks: 0, whites: 0,
    });
    expect(chain).toHaveLength(1);
    expect(chain[0]).toBe(
      `geq=r='min(max(r(X,Y)*${wr.toFixed(6)},0),255)'`
      + `:g='min(max(g(X,Y)*${wg.toFixed(6)},0),255)'`
      + `:b='min(max(b(X,Y)*${wb.toFixed(6)},0),255)':a='alpha(X,Y)'`,
    );
  });

  it('folds white balance into preview pixels like export', () => {
    // Tungsten-white (3200K light, standard approximation) must land near
    // D65-white: that is what "correct for 3200K" means. A neutral gray does
    // NOT stay put — white balance is global, so setting 3200K on neutral
    // footage cools it, by design.
    const [r, g, b] = gradePixel(255, 184, 123, { ...IDENTITY, temperature: 3200, tint: 0 });
    expect(Math.abs(r - g)).toBeLessThan(8);
    expect(Math.abs(g - b)).toBeLessThan(8);
    expect(Math.min(r, g, b)).toBeGreaterThan(240);
  });
});

describe('vibrancePixel (#157)', () => {  it('leaves grey untouched at any intensity', () => {
    // Saturation driver is max-min: grey has none, so the gain cannot move it.
    expect(vibrancePixel(128, 128, 128, 1)).toEqual([128, 128, 128]);
    expect(vibrancePixel(0, 0, 0, -1)).toEqual([0, 0, 0]);
    expect(vibrancePixel(255, 255, 255, 1)).toEqual([255, 255, 255]);
  });

  it('boosts muted tones and clips the overflow', () => {
    // (200,100,50) at +0.5: hand-computed against the filter formula above.
    expect(vibrancePixel(200, 100, 50, 0.5)).toEqual([255, 85, 0]);
  });

  it('desaturates toward luma on negative intensity', () => {
    const [r, g, b] = vibrancePixel(200, 100, 50, -0.5);
    expect([r, g, b]).toEqual([183, 103, 63]);
    // Pulled toward their luma (~118): spread shrinks both ways.
    expect(r - b).toBeLessThan(200 - 50);
  });

  it('zero intensity is the identity', () => {
    expect(vibrancePixel(18, 52, 86, 0)).toEqual([18, 52, 86]);
  });
});

describe('tonal controls (#157)', () => {
  it('lifts shadows most at black and highlights most at white', () => {
    // Black + full shadows: dY = 0.5, so 0 -> 127 (truncates 127.5).
    expect(highlightsShadowsPixel(0, 0, 0, 0, 1)).toEqual([127, 127, 127]);
    // Highlights ignore black; shadows ignore white.
    expect(highlightsShadowsPixel(0, 0, 0, 1, 0)).toEqual([0, 0, 0]);
    expect(highlightsShadowsPixel(255, 255, 255, 0, 1)).toEqual([255, 255, 255]);
    // Mid gray moves both ways by the cubic mask.
    expect(highlightsShadowsPixel(128, 128, 128, 1, 0)).toEqual([144, 144, 144]);
    expect(highlightsShadowsPixel(128, 128, 128, -1, 0)).toEqual([111, 111, 111]);
  });

  it('remaps black and white points per channel', () => {
    // Blacks +1 lifts the floor: (v + 0.4) / 1.4.
    expect(blacksWhitesPixel(128, 128, 128, 1, 0)).toEqual([164, 164, 164]);
    // Blacks -1 crushes it: (v - 0.4) / 0.6.
    expect(blacksWhitesPixel(128, 128, 128, -1, 0)).toEqual([43, 43, 43]);
    // Whites +1 brightens toward clipping: v / 0.6.
    expect(blacksWhitesPixel(128, 128, 128, 0, 1)).toEqual([213, 213, 213]);
    // Whites -1 recovers the ceiling: v / 1.4.
    expect(blacksWhitesPixel(128, 128, 128, 0, -1)).toEqual([91, 91, 91]);
  });

  it('emits the tonal geq segments between vibrance and eq', () => {
    const hs = toFfmpegColorChain({ ...IDENTITY, highlights: 0.5, shadows: -0.25 });
    expect(hs).toHaveLength(1);
    expect(hs[0]).toContain('pow(');
    expect(hs[0]).toContain(":a='alpha(X,Y)'");
    const bw = toFfmpegColorChain({ ...IDENTITY, blacks: 1 });
    expect(bw).toEqual([
      "geq=r='min(max((r(X,Y)+102)/1.4,0),255)':g='min(max((g(X,Y)+102)/1.4,0),255)':b='min(max((b(X,Y)+102)/1.4,0),255)':a='alpha(X,Y)'",
    ]);
    // Full order: gain, vibrance, highlights/shadows, blacks/whites, eq.
    const full = toFfmpegColorChain({ ...IDENTITY, exposure: 1, vibrance: 0.5, highlights: 0.5, blacks: 0.5, contrast: 1.2 });
    expect(full.map((segment) => segment.slice(0, 4))).toEqual(['geq=', 'vibr', 'geq=', 'geq=', 'eq=c']);
  });

  it('sanitizes tonal fields to -1..+1, dropping the absurd', () => {
    expect(sanitizeColorGrade({ highlights: 0.5, shadows: -0.5, blacks: 0.5, whites: -0.5 })).toEqual({
      highlights: 0.5, shadows: -0.5, blacks: 0.5, whites: -0.5,
    });
    expect(sanitizeColorGrade({ highlights: 2 })).toEqual({});
    expect(sanitizeColorGrade({ whites: Number.NaN })).toEqual({});
  });
});

// ─── Tone curves (upstream #157 Curves) ──────────────────────────────────────

/** Master-only curve from the kernel tests: lifted toe, pulled highlights. */
const MASTER_CURVE: GradeCurve = {
  master: [{ x: 0, y: 0.06 }, { x: 0.5, y: 0.55 }, { x: 1, y: 0.95 }],
  red: [],
  green: [],
  blue: [],
};

/** Master plus a red boost and a blue toe — exercises both kernel stages. */
const FULL_CURVE: GradeCurve = {
  master: [{ x: 0, y: 0.06 }, { x: 0.5, y: 0.55 }, { x: 1, y: 0.95 }],
  red: [{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }],
  green: [],
  blue: [{ x: 0, y: 0.1 }, { x: 0.25, y: 0.3 }, { x: 1, y: 0.9 }],
};

/** A fresh all-identity curve (the exported identity points are readonly). */
function identityCurve(): GradeCurve {
  return { master: [...IDENTITY_CURVE_POINTS], red: [], green: [], blue: [] };
}

describe('curve model (#157 Curves)', () => {
  it('evaluates piecewise-linearly, clamped flat outside the point range', () => {
    // Empty and identity channels are the identity mapping.
    expect(evalCurve([], 0)).toBe(0);
    expect(evalCurve([], 0.25)).toBe(0.25);
    expect(evalCurve([], 1)).toBe(1);
    expect(evalCurve(IDENTITY_CURVE_POINTS, 0.25)).toBe(0.25);
    // Between two points the value interpolates linearly.
    expect(evalCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }], 0.25)).toBeCloseTo(0.4, 12);
    // Outside the first/last point the value stays flat.
    expect(evalCurve([{ x: 0.2, y: 0.1 }, { x: 0.8, y: 0.9 }], 0.1)).toBe(0.1);
    expect(evalCurve([{ x: 0.2, y: 0.1 }, { x: 0.8, y: 0.9 }], 0.95)).toBe(0.9);
    // A single point is a constant.
    expect(evalCurve([{ x: 0.5, y: 0.7 }], 0)).toBe(0.7);
    expect(evalCurve([{ x: 0.5, y: 0.7 }], 1)).toBe(0.7);
    // Upstream's eval sorts a copy, so unsorted input still interpolates.
    expect(evalCurve([{ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0.5, y: 0.8 }], 0.25)).toBeCloseTo(0.4, 12);
  });

  it('treats empty and the identity pair as identity, nothing else', () => {
    expect(isIdentityPoints([])).toBe(true);
    expect(isIdentityPoints(IDENTITY_CURVE_POINTS)).toBe(true);
    expect(isIdentityPoints([{ x: 0, y: 0 }])).toBe(false);
    expect(isIdentityPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 0.5 }])).toBe(false);
    expect(isIdentityGradeCurve({ master: [], red: [], green: [], blue: [] })).toBe(true);
    expect(isIdentityGradeCurve({ ...MASTER_CURVE, master: [...IDENTITY_CURVE_POINTS] })).toBe(true);
    expect(isIdentityGradeCurve(MASTER_CURVE)).toBe(false);
  });

  it('sanitizes untrusted curves by dropping invalid points, never clamping', () => {
    // Valid points survive exactly; identity channels canonicalize to empty.
    expect(sanitizeGradeCurve({
      master: [{ x: 0, y: 0.06 }, { x: 1, y: 0.95 }],
      red: IDENTITY_CURVE_POINTS,
      green: [],
      blue: [],
    })).toEqual({
      master: [{ x: 0, y: 0.06 }, { x: 1, y: 0.95 }],
      red: [],
      green: [],
      blue: [],
    });
    // Out-of-range, non-finite, and out-of-order points are dropped.
    expect(sanitizeGradeCurve({
      master: [{ x: -0.1, y: 0 }, { x: 0.5, y: 1.2 }, { x: 0.6, y: 0.5 }, { x: 0.6, y: 0.9 }, { x: 0.3, y: 0.4 }, { x: 0.9, y: Number.NaN }],
    })).toEqual({
      master: [{ x: 0.6, y: 0.5 }],
      red: [],
      green: [],
      blue: [],
    });
    expect(sanitizeGradeCurve({ red: [{ x: 0, y: 0 }, { x: 0.3, y: 0.4 }, { x: 0.2, y: 0.9 }, { x: 1, y: 1 }] })).toEqual({
      master: [],
      red: [{ x: 0, y: 0 }, { x: 0.3, y: 0.4 }, { x: 1, y: 1 }],
      green: [],
      blue: [],
    });
    // The point cap truncates, and anything that leaves every channel empty
    // (or identity) is "no curve" rather than an empty object.
    const many = Array.from({ length: COLOR_GRADE_CURVE_LIMITS.maxPointsPerChannel + 5 }, (_, i) => ({ x: i / 100, y: i / 100 }));
    expect(sanitizeGradeCurve({ red: many })?.red).toHaveLength(COLOR_GRADE_CURVE_LIMITS.maxPointsPerChannel);
    expect(sanitizeGradeCurve(identityCurve())).toBeUndefined();
    expect(sanitizeGradeCurve(null)).toBeUndefined();
    expect(sanitizeGradeCurve('nope')).toBeUndefined();
  });

  it('carries curves through sanitizeColorGrade and grade detection', () => {
    expect(sanitizeColorGrade({ curves: FULL_CURVE })).toEqual({ curves: FULL_CURVE });
    expect(sanitizeColorGrade({ curves: identityCurve() })).toEqual({});
    // @ts-expect-error probe: a corrupt stored value must not become truthy
    expect(sanitizeColorGrade({ curves: 'nope' })).toEqual({});

    const graded = colorGradeOf(clip({ curves: FULL_CURVE }));
    expect(graded?.curves).toEqual(FULL_CURVE);
    expect(colorGradeOf(clip({ curves: identityCurve() }))).toBeNull();
    expect(hasColorGrade(clip({ curves: FULL_CURVE }))).toBe(true);
  });

  it('parses the agent patch strictly, refusing malformed points', () => {
    const parsed = parseGradeCurvePatch({
      master: [{ x: 0, y: 0.06 }, { x: 1, y: 0.95 }],
      red: [],
    });
    expect(parsed).toEqual({
      ok: true,
      patch: { master: [{ x: 0, y: 0.06 }, { x: 1, y: 0.95 }], red: [] },
    });
    // Omitted channels stay out of the patch; identity channels clear.
    expect(parseGradeCurvePatch({ blue: IDENTITY_CURVE_POINTS })).toEqual({ ok: true, patch: { blue: [] } });

    const refusals = [
      parseGradeCurvePatch(null),
      parseGradeCurvePatch([]),
      parseGradeCurvePatch({ red: 'nope' }),
      parseGradeCurvePatch({ red: [{ x: 0, y: 0 }, 'nope'] }),
      parseGradeCurvePatch({ red: [{ x: 1.5, y: 0 }] }),
      parseGradeCurvePatch({ red: [{ x: 0, y: -0.1 }] }),
      parseGradeCurvePatch({ red: [{ x: 0, y: Number.NaN }] }),
      parseGradeCurvePatch({ red: [{ x: 0.5, y: 0.5 }, { x: 0.4, y: 0.4 }] }),
      parseGradeCurvePatch({ red: Array.from({ length: COLOR_GRADE_CURVE_LIMITS.maxPointsPerChannel + 1 }, (_, i) => ({ x: i / 100, y: i / 100 })) }),
    ];
    for (const refusal of refusals) expect(refusal.ok).toBe(false);
    if (!refusals[4].ok) expect(refusals[4].error).toMatch(/between 0 and 1/);
    if (!refusals[7].ok) expect(refusals[7].error).toMatch(/ascending/);
  });

  it('compares curves structurally, with identity equal to absent', () => {
    expect(gradeCurvesEqual(undefined, undefined)).toBe(true);
    expect(gradeCurvesEqual(undefined, identityCurve())).toBe(true);
    expect(gradeCurvesEqual(FULL_CURVE, structuredClone(FULL_CURVE))).toBe(true);
    expect(gradeCurvesEqual(FULL_CURVE, MASTER_CURVE)).toBe(false);
    const tweaked: GradeCurve = { ...FULL_CURVE, red: [{ x: 0, y: 0 }, { x: 0.5, y: 0.81 }, { x: 1, y: 1 }] };
    expect(gradeCurvesEqual(FULL_CURVE, tweaked)).toBe(false);
  });

  it('lets user presets carry curves without store changes', () => {
    const stored = normalizeUserGradePresets([
      { id: 'user-curves', label: 'Faded film', grade: { curves: FULL_CURVE } },
    ]);
    expect(stored).toEqual([{ id: 'user-curves', label: 'Faded film', grade: { curves: FULL_CURVE } }]);
    // A preset whose only grade is an identity curve is still empty.
    expect(normalizeUserGradePresets([
      { id: 'user-empty', label: 'Nothing', grade: { curves: identityCurve() } },
    ])).toEqual([]);
  });
});

describe('curve kernel math (#157 Curves)', () => {
  it('builds 256-entry LUTs, absent for identity channels', () => {
    expect(buildGradeCurveLuts(undefined)).toBeUndefined();
    expect(buildGradeCurveLuts(identityCurve())).toBeUndefined();
    const luts = buildGradeCurveLuts(FULL_CURVE)!;
    expect(luts.master).toBeInstanceOf(Float64Array);
    expect(luts.master).toHaveLength(256);
    expect(luts.red).toHaveLength(256);
    expect(luts.green).toBeUndefined();
    expect(luts.blue).toHaveLength(256);
    // Entry i is clamp(eval(points, i / 255)), upstream's LUT build.
    expect(luts.master![0]).toBe(0.06);
    expect(luts.master![255]).toBeCloseTo(0.95, 12);
    expect(luts.red![0]).toBe(0);
    expect(luts.red![255]).toBe(1);
    expect(luts.blue![0]).toBeCloseTo(0.1, 12);
  });

  it('clamps LUT values to 0..1 like the kernel', () => {
    const luts = buildGradeCurveLuts({ master: [{ x: 0, y: 0 }, { x: 1, y: 2 }], red: [], green: [], blue: [] })!;
    expect(luts.master![255]).toBe(1);
  });

  it('mirrors the Metal kernel on pinned pixels (FFmpeg-verified)', () => {
    // Values verified with FFmpeg 8.1.2: rawvideo rgb24 → format=rgba,<chain>
    // → rgb24 over a 4096-pixel grid, byte-identical to gradePixel.
    const master = buildGradeCurveLuts(MASTER_CURVE)!;
    expect(gradeCurvePixel(0, 0, 0, master)).toEqual([15, 15, 15]);
    expect(gradeCurvePixel(0, 0, 16, master)).toEqual([0, 0, 128]);
    expect(gradeCurvePixel(128, 128, 128, master)).toEqual([140, 140, 140]);
    expect(gradeCurvePixel(200, 100, 50, master)).toEqual([222, 111, 55]);
    expect(gradeCurvePixel(255, 255, 255, master)).toEqual([242, 242, 242]);
    // Near-black uses the 8x-capped luma ratio (1.6378 * 8 = 13.1 per channel).
    expect(gradeCurvePixel(4, 1, 1, master)).toEqual([32, 8, 8]);

    const full = buildGradeCurveLuts(FULL_CURVE)!;
    expect(gradeCurvePixel(0, 0, 0, full)).toEqual([24, 15, 37]);
    expect(gradeCurvePixel(0, 0, 16, full)).toEqual([0, 0, 127]);
    expect(gradeCurvePixel(128, 128, 128, full)).toEqual([209, 140, 137]);
    expect(gradeCurvePixel(200, 100, 50, full)).toEqual([241, 111, 69]);
    expect(gradeCurvePixel(255, 255, 255, full)).toEqual([249, 242, 219]);
  });

  it('caps the shadow-lift gain so dark saturated pixels cannot blow out', () => {
    // Upstream's shadowLiftDoesNotBlowOutDarkSaturated: the uncapped ratio is
    // ~47x here; the 8x cap keeps red at 32, not white.
    const luts = buildGradeCurveLuts({ master: [{ x: 0, y: 0.3 }, { x: 1, y: 1 }], red: [], green: [], blue: [] })!;
    const [r, g, b] = gradeCurvePixel(4, 1, 1, luts);
    expect(r).toBeLessThan(128);
    expect(r).toBe(32);
    expect(g).toBe(8);
    expect(b).toBe(8);
  });

  it('routes gradePixel and applyGradeToRgba through the same tables', () => {
    const grade = { ...IDENTITY, curves: FULL_CURVE };
    for (const pixel of [[0, 0, 0], [0, 0, 16], [128, 128, 128], [200, 100, 50], [255, 255, 255]] as const) {
      expect(gradePixel(pixel[0], pixel[1], pixel[2], grade)).toEqual(gradeCurvePixel(pixel[0], pixel[1], pixel[2], buildGradeCurveLuts(FULL_CURVE)!));
    }
    // The buffer pass builds the LUTs once and still matches pixel-for-pixel.
    const pixels = [[0, 0, 0], [0, 0, 16], [128, 128, 128], [200, 100, 50], [255, 255, 255]];
    const data = new Uint8Array(pixels.flatMap(([r, g, b]) => [r, g, b, 255]));
    const before = [...data];
    applyGradeToRgba(data, grade);
    for (let i = 0; i < pixels.length; i++) {
      const expected = gradePixel(pixels[i][0], pixels[i][1], pixels[i][2], grade);
      expect([...data.slice(i * 4, i * 4 + 3)]).toEqual(expected);
    }
    expect(data[3]).toBe(before[3]);
  });
});

describe('curve export filters (#157 Curves)', () => {
  it('emits nothing for identity curves', () => {
    expect(toFfmpegCurveFilters({ master: [], red: [], green: [], blue: [] })).toEqual([]);
    expect(toFfmpegCurveFilters({ master: [...IDENTITY_CURVE_POINTS], red: [], green: [], blue: [] })).toEqual([]);
  });

  it('emits the per-channel curve as a 256-entry lutrgb table', () => {
    // The expression is the same piecewise-linear eval at val/255, scaled to
    // byte units; FFmpeg compiles it into a 256-entry table exactly like the
    // kernel's channel LUT.
    expect(toFfmpegCurveFilters({
      master: [],
      red: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }],
      green: [],
      blue: [],
    })).toEqual([
      "lutrgb=r='255*(if(lt(val/255,0),0,if(lt(val/255,1),0+(0.5-0)*(((val/255)-0)/(1-0)),0.5)))'",
    ]);
  });

  it('emits the master step as a clamped geq with the 8x cap and alpha passthrough', () => {
    const [filter, ...rest] = toFfmpegCurveFilters(MASTER_CURVE);
    expect(rest).toEqual([]);
    expect(filter.startsWith("geq=r='")).toBe(true);
    expect(filter).toContain('if(gt((0.2126*r(X,Y)+0.7152*g(X,Y)+0.0722*b(X,Y)),0.0255)');
    expect(filter).toContain('min(');
    expect(filter).toContain(',8)');
    // Near-black emits the master LUT's first entry (0.06 * 255).
    expect(filter).toContain('15.299999999999999');
    // Alpha must use the alpha() function: a bare a(X,Y) fails FFmpeg 8, and
    // omitting the option zeroes alpha.
    expect(filter).toContain(":a='alpha(X,Y)'");
  });

  it('applies master before channels, matching the kernel order', () => {
    const filters = toFfmpegCurveFilters(FULL_CURVE);
    expect(filters).toHaveLength(2);
    expect(filters[0].startsWith('geq=')).toBe(true);
    expect(filters[1].startsWith('lutrgb=')).toBe(true);
    expect(filters[1]).toContain("r='255*(");
    expect(filters[1]).toContain("b='255*(");
    expect(filters[1]).not.toContain("g='");
  });

  it('places curves after eq and before hue/invert in the chain', () => {
    const chain = toFfmpegColorChain({ ...IDENTITY, contrast: 1.2, curves: FULL_CURVE, hueRotation: 20, invertColors: true });
    expect(chain.map((segment) => segment.slice(0, 12))).toEqual([
      'eq=contrast=', "geq=r='if(gt", "lutrgb=r='25", 'hue=h=20.0', 'negate',
    ]);
  });
});

// ─── Color wheels (upstream #157 Wheels) ─────────────────────────────────────

/** Masters-only wheels: no pad deflection, so every channel shares one scalar. */
const MASTER_WHEELS: GradeWheels = {
  lift: { x: 0, y: 0, m: 0.2 },
  gamma: { x: 0, y: 0, m: 1.5 },
  gain: { x: 0, y: 0, m: 1.2 },
};

/** Lift/gamma/gain each deflected, exercising the chroma-offset path per zone. */
const FULL_WHEELS: GradeWheels = {
  lift: { x: 0.5, y: 0.3, m: 0.1 },
  gamma: { x: -0.4, y: 0.6, m: 1.2 },
  gain: { x: 0.2, y: -0.7, m: 0.9 },
};

describe('wheel model (#157 Wheels)', () => {
  it('treats every zone at default as identity, nothing else', () => {
    expect(isIdentityGradeWheels(DEFAULT_GRADE_WHEELS)).toBe(true);
    expect(isIdentityGradeWheels({ lift: { x: 0, y: 0, m: 0 }, gamma: { x: 0, y: 0, m: 1 }, gain: { x: 0, y: 0, m: 1 } })).toBe(true);
    expect(isIdentityGradeWheels(MASTER_WHEELS)).toBe(false);
    expect(isIdentityGradeWheels(FULL_WHEELS)).toBe(false);
    expect(isIdentityGradeWheels({ ...DEFAULT_GRADE_WHEELS, lift: { x: 0.1, y: 0, m: 0 } })).toBe(false);
  });

  it('sanitizes untrusted wheels per component, falling back to the default', () => {
    // Valid zones survive exactly.
    expect(sanitizeGradeWheels(FULL_WHEELS)).toEqual(FULL_WHEELS);
    // Out-of-range and non-finite components fall back to the zone default.
    expect(sanitizeGradeWheels({
      lift: { x: 99, y: 0, m: 0 },
      gamma: { x: 0, y: Number.NaN, m: 1 },
      gain: { x: 0, y: 0, m: 1 },
    })).toBeUndefined();
    expect(sanitizeGradeWheels({
      lift: { x: 0.5, y: 0, m: 99 },
      gamma: { x: 0, y: 0, m: 1 },
      gain: { x: 0, y: 0, m: 1 },
    })).toEqual({
      lift: { x: 0.5, y: 0, m: 0 },
      gamma: { x: 0, y: 0, m: 1 },
      gain: { x: 0, y: 0, m: 1 },
    });
    // A non-object zone falls back to its full default; unknown zones are ignored.
    expect(sanitizeGradeWheels({ lift: 'nope', extra: { x: 1, y: 1, m: 1 } })).toBeUndefined();
    // Anything that leaves every zone at default is "no wheels".
    expect(sanitizeGradeWheels(DEFAULT_GRADE_WHEELS)).toBeUndefined();
    expect(sanitizeGradeWheels({})).toBeUndefined();
    expect(sanitizeGradeWheels(null)).toBeUndefined();
    expect(sanitizeGradeWheels('nope')).toBeUndefined();
  });

  it('carries wheels through sanitizeColorGrade and grade detection', () => {
    expect(sanitizeColorGrade({ wheels: FULL_WHEELS })).toEqual({ wheels: FULL_WHEELS });
    expect(sanitizeColorGrade({ wheels: DEFAULT_GRADE_WHEELS })).toEqual({});
    // @ts-expect-error probe: a corrupt stored value must not become truthy
    expect(sanitizeColorGrade({ wheels: 'nope' })).toEqual({});

    const graded = colorGradeOf(clip({ wheels: FULL_WHEELS }));
    expect(graded?.wheels).toEqual(FULL_WHEELS);
    expect(colorGradeOf(clip({ wheels: DEFAULT_GRADE_WHEELS }))).toBeNull();
    expect(hasColorGrade(clip({ wheels: FULL_WHEELS }))).toBe(true);
    expect(hasColorGrade(clip({ wheels: DEFAULT_GRADE_WHEELS }))).toBe(true);
  });

  it('parses the agent patch strictly, refusing malformed components', () => {
    const parsed = parseGradeWheelsPatch({ gain: { m: 1.2 } });
    expect(parsed).toEqual({ ok: true, patch: { gain: { m: 1.2 } } });
    // Omitted zones and components stay out of the patch.
    expect(parseGradeWheelsPatch({ lift: { x: 0.5, y: -0.5 } })).toEqual({
      ok: true,
      patch: { lift: { x: 0.5, y: -0.5 } },
    });

    const refusals = [
      parseGradeWheelsPatch(null),
      parseGradeWheelsPatch([]),
      parseGradeWheelsPatch({ lift: 'nope' }),
      parseGradeWheelsPatch({ lift: {} }),
      parseGradeWheelsPatch({ lift: { x: 1.5 } }),
      parseGradeWheelsPatch({ gamma: { y: -2 } }),
      parseGradeWheelsPatch({ lift: { m: 1 } }),
      parseGradeWheelsPatch({ gamma: { m: 0.4 } }),
      parseGradeWheelsPatch({ gain: { m: 1.6 } }),
      parseGradeWheelsPatch({ gain: { x: Number.NaN } }),
    ];
    for (const refusal of refusals) expect(refusal.ok).toBe(false);
    if (!refusals[4].ok) expect(refusals[4].error).toMatch(/between -1 and 1/);
    if (!refusals[6].ok) expect(refusals[6].error).toMatch(/between -0.5 and 0.5/);
    if (!refusals[7].ok) expect(refusals[7].error).toMatch(/between 0.5 and 2/);
    if (!refusals[8].ok) expect(refusals[8].error).toMatch(/between 0.5 and 1.5/);
  });

  it('compares wheels structurally, with identity equal to absent', () => {
    expect(gradeWheelsEqual(undefined, undefined)).toBe(true);
    expect(gradeWheelsEqual(undefined, DEFAULT_GRADE_WHEELS)).toBe(true);
    expect(gradeWheelsEqual(FULL_WHEELS, structuredClone(FULL_WHEELS))).toBe(true);
    expect(gradeWheelsEqual(FULL_WHEELS, MASTER_WHEELS)).toBe(false);
    const tweaked: GradeWheels = { ...FULL_WHEELS, gain: { x: 0.2, y: -0.7, m: 0.91 } };
    expect(gradeWheelsEqual(FULL_WHEELS, tweaked)).toBe(false);
  });

  it('lets user presets carry wheels without store changes', () => {
    const stored = normalizeUserGradePresets([
      { id: 'user-wheels', label: 'Teal shadows', grade: { wheels: FULL_WHEELS } },
    ]);
    expect(stored).toEqual([{ id: 'user-wheels', label: 'Teal shadows', grade: { wheels: FULL_WHEELS } }]);
    // A preset whose only grade is identity wheels is still empty.
    expect(normalizeUserGradePresets([
      { id: 'user-empty', label: 'Nothing', grade: { wheels: DEFAULT_GRADE_WHEELS } },
    ])).toEqual([]);
  });

  it('exposes the upstream ranges for the future wheel-pad widget', () => {
    expect(COLOR_GRADE_WHEEL_LIMITS.lift.m).toEqual({ min: -0.5, max: 0.5 });
    expect(COLOR_GRADE_WHEEL_LIMITS.gamma.m).toEqual({ min: 0.5, max: 2 });
    expect(COLOR_GRADE_WHEEL_LIMITS.gain.m).toEqual({ min: 0.5, max: 1.5 });
    for (const zone of ['lift', 'gamma', 'gain'] as const) {
      expect(COLOR_GRADE_WHEEL_LIMITS[zone].x).toEqual({ min: -1, max: 1 });
      expect(COLOR_GRADE_WHEEL_LIMITS[zone].y).toEqual({ min: -1, max: 1 });
    }
  });
});

describe('wheel kernel math (#157 Wheels)', () => {
  it('maps hue to fully-saturated RGB like upstream hueRGB', () => {
    expect(wheelsHueRGB(0)).toEqual([1, 0, 0]);
    expect(wheelsHueRGB(0.25)).toEqual([0.5, 1, 0]);
    expect(wheelsHueRGB(0.5)).toEqual([0, 1, 1]);
    // Negative hues normalize through floor, like the Swift version.
    expect(wheelsHueRGB(-0.25)).toEqual([0.5, 0, 1]);
  });

  it('builds luma-neutral pad offsets with a center dead zone', () => {
    expect(wheelsChromaOffset(0, 0)).toEqual([0, 0, 0]);
    // Full deflection toward red: red lifts, green/blue sink equally, and the
    // offset sums to zero (luma-neutral) up to float dust.
    const [r, g, b] = wheelsChromaOffset(1, 0);
    expect(r).toBeCloseTo(2 / 3, 12);
    expect(g).toBeCloseTo(-1 / 3, 12);
    expect(b).toBeCloseTo(-1 / 3, 12);
    expect(r + g + b).toBeCloseTo(0, 12);
    // Radius clamps to the unit disk: (2, 0) deflects like (1, 0).
    expect(wheelsChromaOffset(2, 0)).toEqual(wheelsChromaOffset(1, 0));
  });

  it('derives per-channel triplets from masters alone', () => {
    // No pad deflection: every channel shares the master.
    expect(wheelsCoefficients(MASTER_WHEELS)).toEqual({
      lift: [0.2, 0.2, 0.2],
      gain: [1.2, 1.2, 1.2],
      invGamma: [2 / 3, 2 / 3, 2 / 3],
    });
  });

  it('scales the pad offset by the zone chroma strength', () => {
    const coeffs = wheelsCoefficients(FULL_WHEELS);
    // Hand-computed against ColorWheels.coefficients (0.2/0.35 strengths).
    expect(coeffs.lift[0]).toBeCloseTo(0.157685, 6);
    expect(coeffs.gain[1]).toBeCloseTo(0.765024, 6);
    expect(coeffs.invGamma[1]).toBeCloseTo(0.716485, 6);
  });

  it('builds coefficient triplets once per grade, absent for identity', () => {
    expect(buildWheelsCoeffs(undefined)).toBeUndefined();
    expect(buildWheelsCoeffs(DEFAULT_GRADE_WHEELS)).toBeUndefined();
    const coeffs = buildWheelsCoeffs(FULL_WHEELS)!;
    expect(coeffs.lift).toHaveLength(3);
    expect(coeffs.gain).toHaveLength(3);
    expect(coeffs.invGamma).toHaveLength(3);
  });

  it('mirrors the Metal kernel on pinned pixels (FFmpeg-verified)', () => {
    // Values verified with FFmpeg 8.1.2: rawvideo rgb24 →
    // format=rgba,<wheels geq> → rgb24 over a 4106-pixel grid, byte-identical
    // to wheelsPixel and to gradePixel end to end.
    const gain = buildWheelsCoeffs({ lift: { x: 0, y: 0, m: 0 }, gamma: { x: 0, y: 0, m: 1 }, gain: { x: 0, y: 0, m: 1.2 } })!;
    expect(wheelsPixel(100, 100, 100, gain)).toEqual([120, 120, 120]);
    expect(wheelsPixel(200, 100, 50, gain)).toEqual([240, 120, 60]);
    expect(wheelsPixel(255, 255, 255, gain)).toEqual([255, 255, 255]);

    const lift = buildWheelsCoeffs({ lift: { x: 0, y: 0, m: 0.2 }, gamma: { x: 0, y: 0, m: 1 }, gain: { x: 0, y: 0, m: 1 } })!;
    expect(wheelsPixel(0, 0, 0, lift)).toEqual([51, 51, 51]);
    expect(wheelsPixel(128, 128, 128, lift)).toEqual([153, 153, 153]);
    expect(wheelsPixel(200, 100, 50, lift)).toEqual([211, 131, 91]);

    const gamma = buildWheelsCoeffs({ lift: { x: 0, y: 0, m: 0 }, gamma: { x: 0, y: 0, m: 2 }, gain: { x: 0, y: 0, m: 1 } })!;
    expect(wheelsPixel(0, 0, 0, gamma)).toEqual([0, 0, 0]);
    expect(wheelsPixel(128, 128, 128, gamma)).toEqual([180, 180, 180]);
    expect(wheelsPixel(200, 100, 50, gamma)).toEqual([225, 159, 112]);

    const full = buildWheelsCoeffs(FULL_WHEELS)!;
    expect(wheelsPixel(0, 0, 0, full)).toEqual([44, 40, 14]);
    expect(wheelsPixel(128, 128, 128, full)).toEqual([146, 137, 141]);
    expect(wheelsPixel(200, 100, 50, full)).toEqual([200, 119, 67]);
    expect(wheelsPixel(255, 255, 255, full)).toEqual([241, 210, 253]);
  });

  it('clamps instead of wrapping past the byte range', () => {
    // Gain 1.5 on white would wrap a plain byte array to dark garbage.
    const coeffs = buildWheelsCoeffs({ lift: { x: 0, y: 0, m: 0 }, gamma: { x: 0, y: 0, m: 1 }, gain: { x: 0, y: 0, m: 1.5 } })!;
    expect(wheelsPixel(255, 255, 255, coeffs)).toEqual([255, 255, 255]);
    expect(wheelsPixel(200, 200, 200, coeffs)).toEqual([255, 255, 255]);
  });

  it('routes gradePixel and applyGradeToRgba through the same triplets', () => {
    const grade = { ...IDENTITY, wheels: FULL_WHEELS };
    const coeffs = buildWheelsCoeffs(FULL_WHEELS)!;
    for (const pixel of [[0, 0, 0], [128, 128, 128], [200, 100, 50], [255, 255, 255], [100, 100, 100]] as const) {
      expect(gradePixel(pixel[0], pixel[1], pixel[2], grade)).toEqual(wheelsPixel(pixel[0], pixel[1], pixel[2], coeffs));
    }
    const pixels = [[0, 0, 0], [128, 128, 128], [200, 100, 50], [255, 255, 255]];
    const data = new Uint8Array(pixels.flatMap(([r, g, b]) => [r, g, b, 255]));
    applyGradeToRgba(data, grade);
    for (let i = 0; i < pixels.length; i++) {
      const expected = gradePixel(pixels[i][0], pixels[i][1], pixels[i][2], grade);
      expect([...data.slice(i * 4, i * 4 + 3)]).toEqual(expected);
    }
  });

  it('applies after eq: the same lift lands differently on pre-scaled luma', () => {
    // Gray 100 at contrast 2 is 72 before the wheels see it; lift 0.2 then
    // gives 108. Wheels-first would give 134 — the two orders do not commute,
    // so this pins upstream's saturation-before-wheels slot on the preview.
    const wheels = { lift: { x: 0, y: 0, m: 0.2 }, gamma: { x: 0, y: 0, m: 1 }, gain: { x: 0, y: 0, m: 1 } };
    expect(gradePixel(100, 100, 100, { ...IDENTITY, contrast: 2, wheels })).toEqual([108, 108, 108]);
  });
});

describe('wheel export filters (#157 Wheels)', () => {
  it('emits nothing for identity wheels', () => {
    expect(toFfmpegWheelsFilter(undefined)).toBe('');
    expect(toFfmpegWheelsFilter(DEFAULT_GRADE_WHEELS)).toBe('');
  });

  it('emits the wheels step as a clamped geq with alpha passthrough', () => {
    const filter = toFfmpegWheelsFilter({ lift: { x: 0, y: 0, m: 0.2 }, gamma: { x: 0, y: 0, m: 1 }, gain: { x: 0, y: 0, m: 1 } });
    expect(filter.startsWith("geq=r='")).toBe(true);
    // Lift 0.2, unity gain, unity gamma: pow(...,1) is the identity power.
    expect(filter).toContain('r(X,Y)/255*(1-0.2)+0.2');
    expect(filter).toContain('pow(');
    expect(filter).toContain(":a='alpha(X,Y)'");
  });

  it('places wheels after eq and before curves in the chain', () => {
    const chain = toFfmpegColorChain({
      ...IDENTITY, contrast: 1.2, wheels: FULL_WHEELS, curves: FULL_CURVE, hueRotation: 20, invertColors: true,
    });
    expect(chain.map((segment) => segment.slice(0, 12))).toEqual([
      'eq=contrast=', "geq=r='min(m", "geq=r='if(gt", "lutrgb=r='25", 'hue=h=20.0', 'negate',
    ]);
  });

  it('matches preview through the combined wheels+curves stages (FFmpeg-verified)', () => {
    // Same pair verified byte-identical over the 4106-pixel grid with FFmpeg
    // 8.1.2; these two pins guard the wheels-before-curves order.
    const wheels = { lift: { x: 0.5, y: 0.3, m: 0.1 }, gamma: { x: 0, y: 0, m: 1 }, gain: { x: 0, y: 0, m: 1.1 } };
    const curves = { master: [{ x: 0, y: 0.06 }, { x: 1, y: 0.95 }], red: [], green: [], blue: [] };
    expect(gradePixel(128, 128, 128, { ...IDENTITY, wheels, curves })).toEqual([160, 152, 144]);
    expect(gradePixel(200, 100, 50, { ...IDENTITY, wheels, curves })).toEqual([227, 126, 63]);
  });
});

// ─── Hue curves (upstream #157 Hue Curves) ───────────────────────────────────

/** Push only the red band of hue-vs-hue; everything else holds at neutral. */
const RED_ONLY_HUE: HueCurves = {
  hueVsHue: [
    { x: 0, y: 0.8 }, { x: 1 / 6, y: 0.5 }, { x: 2 / 6, y: 0.5 },
    { x: 3 / 6, y: 0.5 }, { x: 4 / 6, y: 0.5 }, { x: 5 / 6, y: 0.5 },
  ],
  hueVsSat: [],
  hueVsLum: [],
};

/** Boost red saturation; the peak sits exactly on red. */
const SAT_PUSH_HUE: HueCurves = {
  hueVsHue: [],
  hueVsSat: [
    { x: 0, y: 1 }, { x: 1 / 6, y: 0.5 }, { x: 2 / 6, y: 0.5 },
    { x: 3 / 6, y: 0.5 }, { x: 4 / 6, y: 0.5 }, { x: 5 / 6, y: 0.5 },
  ],
  hueVsLum: [],
};

/** Lift green luminance; points sorted ascending like the editor keeps them. */
const LUM_PUSH_HUE: HueCurves = {
  hueVsHue: [],
  hueVsSat: [],
  hueVsLum: [
    { x: 0, y: 0.5 }, { x: 1 / 6, y: 0.5 }, { x: 1 / 3, y: 0.9 },
    { x: 1 / 2, y: 0.5 }, { x: 2 / 3, y: 0.5 }, { x: 5 / 6, y: 0.5 },
  ],
};

/** Every channel deflected, exercising all three LUTs at once. */
const FULL_HUE: HueCurves = {
  hueVsHue: [{ x: 0, y: 0.7 }, { x: 0.5, y: 0.4 }, { x: 0.9, y: 0.6 }],
  hueVsSat: [{ x: 0.1, y: 0.9 }, { x: 0.6, y: 0.2 }],
  hueVsLum: [{ x: 0.3, y: 0.8 }, { x: 0.8, y: 0.3 }],
};

/** A fresh all-neutral set (what the editor holds before any push). */
function neutralHueCurves(): HueCurves {
  return { hueVsHue: [], hueVsSat: [], hueVsLum: [] };
}

describe('hue curve model (#157 Hue Curves)', () => {
  it('treats empty and near-neutral channels as neutral, nothing else', () => {
    expect(isNeutralHuePoints([])).toBe(true);
    expect(isNeutralHuePoints(DEFAULT_HUE_CURVE_POINTS)).toBe(true);
    expect(isNeutralHuePoints([{ x: 0, y: 0.5 }, { x: 1, y: 0.50005 }])).toBe(true);
    expect(isNeutralHuePoints([{ x: 0, y: 0.5 }, { x: 1, y: 0.6 }])).toBe(false);
    expect(isNeutralHuePoints([{ x: 0, y: 0 }])).toBe(false);
    expect(isIdentityHueCurves(neutralHueCurves())).toBe(true);
    expect(isIdentityHueCurves({ hueVsHue: [...DEFAULT_HUE_CURVE_POINTS], hueVsSat: [], hueVsLum: [] })).toBe(true);
    expect(isIdentityHueCurves(RED_ONLY_HUE)).toBe(false);
  });

  it('exposes the neutral anchors and channel list for the future widget', () => {
    expect(HUE_CURVE_NEUTRAL_Y).toBe(0.5);
    expect(DEFAULT_HUE_CURVE_POINTS).toHaveLength(6);
    expect(DEFAULT_HUE_CURVE_POINTS[0]).toEqual({ x: 0, y: 0.5 });
    expect(HUE_CURVE_CHANNELS).toEqual(['hueVsHue', 'hueVsSat', 'hueVsLum']);
    expect(COLOR_GRADE_HUE_CURVE_LIMITS.maxPointsPerChannel).toBe(16);
  });

  it('sanitizes untrusted curves by dropping invalid points, never clamping', () => {
    expect(sanitizeHueCurves({
      hueVsHue: [{ x: 0, y: 0.7 }, { x: 0.5, y: 0.4 }],
      hueVsSat: DEFAULT_HUE_CURVE_POINTS,
      hueVsLum: [],
    })).toEqual({
      hueVsHue: [{ x: 0, y: 0.7 }, { x: 0.5, y: 0.4 }],
      hueVsSat: [],
      hueVsLum: [],
    });
    // Out-of-range, non-finite, and out-of-order points are dropped.
    expect(sanitizeHueCurves({
      hueVsHue: [{ x: -0.1, y: 0.5 }, { x: 0.5, y: 1.2 }, { x: 0.6, y: 0.7 }, { x: 0.6, y: 0.9 }, { x: 0.3, y: 0.4 }],
    })).toEqual({
      hueVsHue: [{ x: 0.6, y: 0.7 }],
      hueVsSat: [],
      hueVsLum: [],
    });
    // The point cap truncates, and anything left all-neutral is "no curves".
    const many = Array.from({ length: COLOR_GRADE_HUE_CURVE_LIMITS.maxPointsPerChannel + 5 }, (_, i) => ({ x: i / 100, y: i / 100 }));
    expect(sanitizeHueCurves({ hueVsSat: many })?.hueVsSat).toHaveLength(COLOR_GRADE_HUE_CURVE_LIMITS.maxPointsPerChannel);
    expect(sanitizeHueCurves(neutralHueCurves())).toBeUndefined();
    expect(sanitizeHueCurves({ hueVsHue: [...DEFAULT_HUE_CURVE_POINTS] })).toBeUndefined();
    expect(sanitizeHueCurves(null)).toBeUndefined();
    expect(sanitizeHueCurves('nope')).toBeUndefined();
  });

  it('carries hue curves through sanitizeColorGrade and grade detection', () => {
    expect(sanitizeColorGrade({ hueCurves: FULL_HUE })).toEqual({ hueCurves: FULL_HUE });
    expect(sanitizeColorGrade({ hueCurves: neutralHueCurves() })).toEqual({});
    // @ts-expect-error probe: a corrupt stored value must not become truthy
    expect(sanitizeColorGrade({ hueCurves: 'nope' })).toEqual({});

    const graded = colorGradeOf(clip({ hueCurves: FULL_HUE }));
    expect(graded?.hueCurves).toEqual(FULL_HUE);
    expect(colorGradeOf(clip({ hueCurves: neutralHueCurves() }))).toBeNull();
    expect(hasColorGrade(clip({ hueCurves: FULL_HUE }))).toBe(true);
  });

  it('parses the agent patch strictly, refusing malformed points', () => {
    const parsed = parseHueCurvesPatch({
      hueVsSat: [{ x: 0, y: 0.8 }, { x: 0.15, y: 0.5 }],
      hueVsLum: [],
    });
    expect(parsed).toEqual({
      ok: true,
      patch: { hueVsSat: [{ x: 0, y: 0.8 }, { x: 0.15, y: 0.5 }], hueVsLum: [] },
    });
    // Omitted channels stay out of the patch; neutral channels clear.
    expect(parseHueCurvesPatch({ hueVsHue: DEFAULT_HUE_CURVE_POINTS })).toEqual({ ok: true, patch: { hueVsHue: [] } });

    const refusals = [
      parseHueCurvesPatch(null),
      parseHueCurvesPatch([]),
      parseHueCurvesPatch({ hueVsHue: 'nope' }),
      parseHueCurvesPatch({ hueVsHue: [{ x: 0, y: 0 }, 'nope'] }),
      parseHueCurvesPatch({ hueVsHue: [{ x: 1.5, y: 0.5 }] }),
      parseHueCurvesPatch({ hueVsSat: [{ x: 0, y: -0.1 }] }),
      parseHueCurvesPatch({ hueVsSat: [{ x: 0, y: Number.NaN }] }),
      parseHueCurvesPatch({ hueVsLum: [{ x: 0.5, y: 0.5 }, { x: 0.4, y: 0.4 }] }),
      parseHueCurvesPatch({ hueVsHue: Array.from({ length: COLOR_GRADE_HUE_CURVE_LIMITS.maxPointsPerChannel + 1 }, (_, i) => ({ x: i / 100, y: i / 100 })) }),
    ];
    for (const refusal of refusals) expect(refusal.ok).toBe(false);
    if (!refusals[4].ok) expect(refusals[4].error).toMatch(/between 0 and 1/);
    if (!refusals[7].ok) expect(refusals[7].error).toMatch(/ascending/);
  });

  it('compares hue curves structurally, with neutral equal to absent', () => {
    expect(hueCurvesEqual(undefined, undefined)).toBe(true);
    expect(hueCurvesEqual(undefined, neutralHueCurves())).toBe(true);
    expect(hueCurvesEqual(FULL_HUE, structuredClone(FULL_HUE))).toBe(true);
    expect(hueCurvesEqual(FULL_HUE, RED_ONLY_HUE)).toBe(false);
    const tweaked: HueCurves = { ...FULL_HUE, hueVsSat: [{ x: 0.1, y: 0.91 }, { x: 0.6, y: 0.2 }] };
    expect(hueCurvesEqual(FULL_HUE, tweaked)).toBe(false);
  });

  it('lets user presets carry hue curves without store changes', () => {
    const stored = normalizeUserGradePresets([
      { id: 'user-hue', label: 'Red pop', grade: { hueCurves: SAT_PUSH_HUE } },
    ]);
    expect(stored).toEqual([{ id: 'user-hue', label: 'Red pop', grade: { hueCurves: SAT_PUSH_HUE } }]);
    // A preset whose only grade is neutral hue curves is still empty.
    expect(normalizeUserGradePresets([
      { id: 'user-empty', label: 'Nothing', grade: { hueCurves: neutralHueCurves() } },
    ])).toEqual([]);
  });
});

describe('hue curve eval (#157 Hue Curves)', () => {
  it('evaluates empty channels as neutral everywhere', () => {
    expect(evalHueCurve([], 0)).toBe(0.5);
    expect(evalHueCurve([], 0.37)).toBe(0.5);
    expect(evalHueCurve([], 1)).toBe(0.5);
    expect(evalHueCurve(DEFAULT_HUE_CURVE_POINTS, 0.37)).toBe(0.5);
  });

  it('interpolates linearly between points', () => {
    expect(evalHueCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }], 0.25)).toBeCloseTo(0.4, 12);
    // Upstream's eval sorts a copy, so unsorted input still interpolates.
    expect(evalHueCurve([{ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0.5, y: 0.8 }], 0.25)).toBeCloseTo(0.4, 12);
  });

  it('wraps across the hue seam instead of jumping', () => {
    // Just past the last point heads toward the first, one turn up.
    const pts = [{ x: 0, y: 0.9 }, { x: 5 / 6, y: 0.2 }];
    expect(evalHueCurve(pts, 0)).toBe(0.9);
    expect(evalHueCurve(pts, 0.999)).toBeCloseTo(0.8958, 3);
    // Below the first point it reaches back one turn to the last.
    expect(evalHueCurve([{ x: 0.2, y: 0.1 }, { x: 0.8, y: 0.9 }], 0.1)).toBeCloseTo(0.3, 12);
    // A single point is a constant.
    expect(evalHueCurve([{ x: 0.5, y: 0.7 }], 0)).toBe(0.7);
    expect(evalHueCurve([{ x: 0.5, y: 0.7 }], 1)).toBe(0.7);
  });
});

describe('hue kernel math (#157 Hue Curves)', () => {
  it('converts between display-space RGB and HSV like the kernel', () => {
    const [h, s, v] = rgb2hsv(1, 0, 0);
    expect(h).toBe(0);
    expect(s).toBeCloseTo(1, 8);
    expect(v).toBe(1);
    expect(rgb2hsv(0.5, 0.5, 0.5)).toEqual([0, 0, 0.5]);
    expect(rgb2hsv(0, 0, 1)[0]).toBeCloseTo(2 / 3, 12);
    expect(hsv2rgb(0, 1, 1)).toEqual([1, 0, 0]);
    const [r, g, b] = hsv2rgb(0.5, 0.5, 0.5);
    expect(r).toBeCloseTo(0.25, 12);
    expect(g).toBeCloseTo(0.5, 12);
    expect(b).toBeCloseTo(0.5, 12);
  });

  it('builds 256-entry LUTs, absent for neutral curves', () => {
    expect(buildHueCurveLuts(undefined)).toBeUndefined();
    expect(buildHueCurveLuts(neutralHueCurves())).toBeUndefined();
    const luts = buildHueCurveLuts(RED_ONLY_HUE)!;
    expect(luts.hue).toBeInstanceOf(Float64Array);
    expect(luts.hue).toHaveLength(HUE_CURVE_LUT_WIDTH);
    expect(luts.sat).toHaveLength(HUE_CURVE_LUT_WIDTH);
    expect(luts.lum).toHaveLength(HUE_CURVE_LUT_WIDTH);
    // Entry i is the scaled eval at i/255: (0.8-0.5)*2/12 at hue 0.
    expect(luts.hue[0]).toBeCloseTo(0.05, 12);
    // Neutral channels build all-zero tables.
    expect(luts.sat[0]).toBe(0);
    expect(luts.sat[128]).toBe(0);
    expect(luts.lum[255]).toBe(0);
  });

  it('rotates the red band toward orange and leaves blue put (FFmpeg-verified)', () => {
    // Values verified with FFmpeg 8.1.2: rawvideo rgb24 →
    // format=rgba,<hue geq chain> → rgb24 over a 4115-pixel grid,
    // byte-identical to hueCurvesPixel and to gradePixel end to end.
    const luts = buildHueCurveLuts(RED_ONLY_HUE)!;
    const [r, g, b] = hueCurvesPixel(255, 0, 0, luts);
    expect(r).toBe(255);
    expect(g).toBeGreaterThan(0.1 * 255);
    expect(g).toBe(72);
    expect(b).toBe(0);
    // Blue sits far from the pushed band: within 0.03 (upstream's bound).
    const [br, bg, bb] = hueCurvesPixel(0, 0, 255, luts);
    expect(Math.max(Math.abs(br - 0), Math.abs(bg - 0), Math.abs(bb - 255))).toBeLessThanOrEqual(8);
    expect([br, bg, bb]).toEqual([0, 1, 255]);
  });

  it('never tints greys, exactly (FFmpeg-verified)', () => {
    // Saturate, rotate and shift everything; the gate zeroes the push, so
    // achromatic pixels round-trip byte-identically (tighter than upstream's
    // 0.02 bound, which the port meets with room to spare).
    const pushed: HueCurves = {
      hueVsHue: [0, 1, 2, 3, 4, 5].map((i) => ({ x: i / 6, y: 1 })),
      hueVsSat: [0, 1, 2, 3, 4, 5].map((i) => ({ x: i / 6, y: 1 })),
      hueVsLum: [0, 1, 2, 3, 4, 5].map((i) => ({ x: i / 6, y: 1 })),
    };
    const luts = buildHueCurveLuts(pushed)!;
    for (const v of [51, 128, 204]) {
      expect(hueCurvesPixel(v, v, v, luts)).toEqual([v, v, v]);
    }
  });

  it('mirrors the Metal kernel on pinned pixels (FFmpeg-verified)', () => {
    const sat = buildHueCurveLuts(SAT_PUSH_HUE)!;
    expect(hueCurvesPixel(255, 0, 0, sat)).toEqual([255, 0, 0]);
    expect(hueCurvesPixel(200, 100, 50, sat)).toEqual([200, 65, 0]);
    expect(hueCurvesPixel(128, 128, 128, sat)).toEqual([128, 128, 128]);

    const lum = buildHueCurveLuts(LUM_PUSH_HUE)!;
    expect(hueCurvesPixel(0, 128, 0, lum)).toEqual([0, 230, 0]);
    expect(hueCurvesPixel(200, 100, 50, lum)).toEqual([200, 99, 50]);
    expect(hueCurvesPixel(128, 128, 128, lum)).toEqual([128, 128, 128]);

    const full = buildHueCurveLuts(FULL_HUE)!;
    expect(hueCurvesPixel(255, 0, 0, full)).toEqual([255, 47, 0]);
    expect(hueCurvesPixel(200, 100, 50, full)).toEqual([214, 105, 0]);
    expect(hueCurvesPixel(0, 0, 255, full)).toEqual([98, 102, 238]);
    expect(hueCurvesPixel(0, 255, 0, full)).toEqual([0, 255, 0]);
    expect(hueCurvesPixel(128, 128, 128, full)).toEqual([128, 128, 128]);
  });

  it('routes gradePixel and applyGradeToRgba through the same tables', () => {
    const grade = { ...IDENTITY, hueCurves: FULL_HUE };
    const luts = buildHueCurveLuts(FULL_HUE)!;
    for (const pixel of [[255, 0, 0], [128, 128, 128], [200, 100, 50], [0, 0, 255], [0, 255, 0]] as const) {
      expect(gradePixel(pixel[0], pixel[1], pixel[2], grade)).toEqual(hueCurvesPixel(pixel[0], pixel[1], pixel[2], luts));
    }
    const pixels = [[255, 0, 0], [128, 128, 128], [200, 100, 50], [0, 0, 255]];
    const data = new Uint8Array(pixels.flatMap(([r, g, b]) => [r, g, b, 255]));
    applyGradeToRgba(data, grade);
    for (let i = 0; i < pixels.length; i++) {
      const expected = gradePixel(pixels[i][0], pixels[i][1], pixels[i][2], grade);
      expect([...data.slice(i * 4, i * 4 + 3)]).toEqual(expected);
    }
  });

  it('applies after tone curves: the orders do not commute', () => {
    // Curves-then-hue (upstream's canonical order) lands here; hue-then-curves
    // lands elsewhere, so this pins the slot on the preview side too.
    const curves = { master: [{ x: 0, y: 0.06 }, { x: 1, y: 0.95 }], red: [], green: [], blue: [] };
    const grade = { ...IDENTITY, curves, hueCurves: RED_ONLY_HUE };
    const forward = gradePixel(200, 100, 50, grade);
    const curveLuts = buildGradeCurveLuts(curves)!;
    const hueLuts = buildHueCurveLuts(RED_ONLY_HUE)!;
    const [cr, cg, cb] = gradeCurvePixel(200, 100, 50, curveLuts);
    expect(forward).toEqual(hueCurvesPixel(cr, cg, cb, hueLuts));
    const [hr, hg, hb] = hueCurvesPixel(200, 100, 50, hueLuts);
    expect(forward).not.toEqual(gradeCurvePixel(hr, hg, hb, curveLuts));
  });
});

describe('hue curve export filters (#157 Hue Curves)', () => {
  it('emits nothing for neutral hue curves', () => {
    expect(toFfmpegHueCurveFilters(undefined)).toEqual([]);
    expect(toFfmpegHueCurveFilters(neutralHueCurves())).toEqual([]);
    expect(toFfmpegHueCurveFilters({ hueVsHue: [...DEFAULT_HUE_CURVE_POINTS], hueVsSat: [], hueVsLum: [] })).toEqual([]);
  });

  it('emits the three-stage geq chain with alpha passthrough', () => {
    const filters = toFfmpegHueCurveFilters(RED_ONLY_HUE);
    expect(filters).toHaveLength(3);
    for (const filter of filters) {
      expect(filter.startsWith("geq=r='")).toBe(true);
      expect(filter).toContain(":a='alpha(X,Y)'");
    }
    // Stage A converts to HSV, stage C back: floor stores on every channel.
    expect(filters[0]).toContain('floor((');
    expect(filters[2]).toContain('*255),0),255)');
    // The neutral sat/lum channels ride the literal 0, not an eval.
    expect(filters[1]).toContain('(0)');
  });

  it('places hue curves after tone curves and before hue/invert in the chain', () => {
    const chain = toFfmpegColorChain({
      ...IDENTITY, contrast: 1.2, curves: FULL_CURVE, hueCurves: RED_ONLY_HUE, hueRotation: 20, invertColors: true,
    });
    expect(chain.map((segment) => segment.slice(0, 12))).toEqual([
      'eq=contrast=', "geq=r='if(gt", "lutrgb=r='25", "geq=r='floor", "geq=r='floor", "geq=r='min(m", 'hue=h=20.0', 'negate',
    ]);
    // Stages A and C carry the HSV round trip; stage B is pure LUTs+gate.
    expect(chain[3]).toContain('abs(');
    expect(chain[4]).not.toContain('abs(');
    expect(chain[5]).toContain('abs(');
  });

  it('matches preview through the combined wheels+curves+hue stages (FFmpeg-verified)', () => {
    // Same triple verified byte-identical over the 4115-pixel grid with
    // FFmpeg 8.1.2; these pins guard the hue-after-curves slot end to end.
    const wheels = { lift: { x: 0, y: 0, m: 0.1 }, gamma: { x: 0, y: 0, m: 1 }, gain: { x: 0, y: 0, m: 1.1 } };
    const curves = { master: [{ x: 0, y: 0.06 }, { x: 1, y: 0.95 }], red: [], green: [], blue: [] };
    expect(gradePixel(128, 128, 128, { ...IDENTITY, wheels, curves, hueCurves: RED_ONLY_HUE })).toEqual([152, 152, 152]);
    expect(gradePixel(200, 100, 50, { ...IDENTITY, wheels, curves, hueCurves: RED_ONLY_HUE })).toEqual([224, 152, 76]);
  });
});

describe('LUT stage (#157 LUTs)', () => {
  const INVERT_TEXT = [
    'LUT_3D_SIZE 2',
    '1 1 1', '0 1 1', '1 0 1', '0 0 1',
    '1 1 0', '0 1 0', '1 0 0', '0 0 0',
  ].join('\n');

  function invertLut() {
    const parsed = parseCubeText(INVERT_TEXT);
    if (!parsed.ok) throw new Error(`bad fixture: ${parsed.error}`);
    return parsed.lut;
  }

  const LUT_REF: LutRef = { path: 'C:\\luts\\invert.cube', intensity: 1, kind: '3d', size: 2 };

  it('carries a LUT through sanitizeColorGrade and grade detection', () => {
    expect(sanitizeColorGrade({ lut: LUT_REF })).toEqual({ lut: LUT_REF });
    expect(sanitizeColorGrade({ lut: { path: 'nope.txt', intensity: 1, kind: '3d', size: 2 } })).toEqual({});
    expect(colorGradeOf(clip({ lut: LUT_REF }))?.lut).toEqual(LUT_REF);
    expect(hasColorGrade(clip({ lut: LUT_REF }))).toBe(true);
    // An invalid stored ref reads as ungraded, like an identity curve does.
    expect(colorGradeOf(clip({ lut: { path: '', intensity: 1, kind: '3d', size: 2 } }))).toBeNull();
  });

  it('places the LUT after hue curves and before hue/invert in the chain', () => {
    const chain = toFfmpegColorChain({
      ...IDENTITY, contrast: 1.2, hueCurves: RED_ONLY_HUE, lut: LUT_REF, hueRotation: 20, invertColors: true,
    });
    const lutIndex = chain.findIndex((segment) => segment.startsWith('lut3d='));
    expect(lutIndex).toBeGreaterThan(-1);
    expect(chain[lutIndex]).toContain(':interp=tetrahedral');
    expect(chain.slice(lutIndex + 1)).toEqual(['hue=h=20.0', 'negate']);
    // eq first, the three hue-curve geq stages directly ahead of the LUT.
    expect(chain[0].startsWith('eq=')).toBe(true);
    expect(chain[lutIndex - 1].startsWith('geq=')).toBe(true);
    expect(lutIndex).toBe(chain.length - 3);
  });

  it('emits the single LUT filter only at full intensity', () => {
    expect(toFfmpegLutSingleFilter(LUT_REF)).toHaveLength(1);
    expect(toFfmpegLutSingleFilter({ ...LUT_REF, intensity: 0.5 })).toEqual([]);
    expect(toFfmpegLutSingleFilter({ ...LUT_REF, intensity: 0 })).toEqual([]);
    expect(toFfmpegLutSingleFilter(undefined)).toEqual([]);
  });

  it('splits the chain around the LUT slot for the blend graph', () => {
    const grade = { ...IDENTITY, contrast: 1.2, lut: { ...LUT_REF, intensity: 0.5 }, hueRotation: 20 };
    // Pre carries everything ahead of the LUT (eq here); post carries hue.
    expect(toFfmpegPreLutChain(grade)).toEqual(['eq=contrast=1.200000']);
    expect(toFfmpegPostLutChain(grade)).toEqual(['hue=h=20.0']);
    // Reassembled without the blend, pre + single + post is the linear chain.
    expect([...toFfmpegPreLutChain({ ...grade, lut: LUT_REF }), ...toFfmpegLutSingleFilter(LUT_REF), ...toFfmpegPostLutChain(grade)])
      .toEqual(toFfmpegColorChain({ ...grade, lut: LUT_REF }));
  });

  it('grades preview pixels through the shared core (FFmpeg: (191,126,62))', () => {
    const lut = invertLut();
    expect(gradePixel(64, 128, 192, { ...IDENTITY, lut: LUT_REF }, undefined, undefined, undefined, lut))
      .toEqual([191, 127, 63]);
    // A missing table degrades to ungraded for the stage (YUV round trip).
    expect(gradePixel(64, 128, 192, { ...IDENTITY, lut: LUT_REF })).toEqual([64, 128, 192]);
  });

  it('applies the LUT after hue curves and before invert in preview', () => {
    const lut = invertLut();
    // Invert LUT then invert filter: each stage truncates through its own
    // YUV round trip, so the double inversion lands within 2 LSB, not exact.
    expect(gradePixel(64, 128, 192, { ...IDENTITY, lut: LUT_REF, invertColors: true }, undefined, undefined, undefined, lut))
      .toEqual([63, 129, 190]);
    const data = new Uint8Array([64, 128, 192, 255, 0, 0, 0, 255]);
    applyGradeToRgba(data, { ...IDENTITY, lut: LUT_REF }, lut);
    expect(Array.from(data)).toEqual([191, 127, 63, 255, 255, 255, 255, 255]);
  });
});
