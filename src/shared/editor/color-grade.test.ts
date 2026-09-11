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
import { applyGradeToRgba, gradePixel } from './color-grade';

/** Neutral grade for the pixel-math tests below. */
const IDENTITY = { brightness: 0, contrast: 1, saturation: 1, hueRotation: 0, invertColors: false };

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
    expect(g).toEqual({ brightness: -0.2, contrast: 1, saturation: 1, hueRotation: 0, invertColors: false });
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
    const grade = { brightness: -0.15, contrast: 1.3, saturation: 0.6, hueRotation: 45 };
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
      brightness: -0.15, contrast: 1.3, saturation: 0.6, hueRotation: 45, invertColors: true,
    })).toEqual([
      'eq=brightness=-0.150000:contrast=1.300000:saturation=0.600000',
      'hue=h=45.0',
      'negate',
    ]);
    // Hue alone is still its own filter, never an eq option.
    expect(toFfmpegColorChain({
      brightness: 0, contrast: 1, saturation: 1, hueRotation: 90,
    })).toEqual(['hue=h=90.0']);
    expect(toFfmpegColorChain({
      brightness: 0, contrast: 1, saturation: 1, hueRotation: 0, invertColors: true,
    })).toEqual(['negate']);
  });

  it('returns empty strings for default grades', () => {
    const g = { brightness: 0, contrast: 1, saturation: 1, hueRotation: 0 };
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
