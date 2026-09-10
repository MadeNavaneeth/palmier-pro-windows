import { describe, it, expect } from 'vitest';
import {
  DEFAULT_COLOR_GRADE,
  GRADE_PRESETS,
  colorGradeOf,
  gradePresetById,
  hasColorGrade,
  sanitizeColorGrade,
  toCanvasFilter,
  toFfmpegEq,
} from './color-grade';
import type { Clip } from '../types/project';

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
    // FFmpeg uses key=value pairs.
    expect(ffmpeg).toContain('brightness=-0.150000');
    expect(ffmpeg).toContain('contrast=1.300000');
    expect(ffmpeg).toContain('saturation=0.600000');
    expect(ffmpeg).toContain('hue=h=45.0');
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
