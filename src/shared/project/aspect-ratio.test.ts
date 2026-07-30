/**
 * Regression coverage for custom project aspect ratios (upstream PR #417).
 * The parametrized cases mirror upstream's CustomAspectRatioTests so the two
 * implementations cannot drift on rounding or refusal behaviour.
 */

import { describe, it, expect } from 'vitest';
import {
  ASPECT_PRESETS,
  AspectRatioError,
  MAX_CANVAS_EDGE,
  QUALITY_PRESETS,
  aspectPresetMatches,
  aspectRatioLabel,
  customRatioInput,
  customRatioResolution,
  findAspectPreset,
  findQualityPreset,
  parseAspectRatio,
  qualityPresetMatches,
  resolutionForAspectRatio,
  resolutionForQuality,
} from './aspect-ratio';

function resolve(ratio: string, shortEdge: number) {
  return resolutionForAspectRatio(parseAspectRatio(ratio), shortEdge);
}

describe('aspect ratio parsing', () => {
  it.each(['', '16', ':9', '16:', '0:1', '1:0', '-1:1', 'nan:1', '1:inf', '16:9:1', '1.2.3:1'])(
    'rejects %s',
    (ratio) => {
      expect(() => parseAspectRatio(ratio)).toThrow(AspectRatioError);
    },
  );

  it('accepts integer and decimal ratios with surrounding whitespace', () => {
    expect(parseAspectRatio('16:9')).toEqual({ horizontal: 16, vertical: 9 });
    expect(parseAspectRatio(' 2.39 : 1 ')).toEqual({ horizontal: 2.39, vertical: 1 });
    expect(parseAspectRatio('.5:1')).toEqual({ horizontal: 0.5, vertical: 1 });
  });
});

describe('resolution for a ratio', () => {
  it.each([
    ['3:2', 1080, 1620, 1080],
    ['9:16', 2160, 2160, 3840],
    ['2.39:1', 1080, 2582, 1080],
    ['2.4:1', 1080, 2592, 1080],
    ['16:9', 1080, 1920, 1080],
    ['1:1', 1080, 1080, 1080],
  ])('%s at short edge %i gives %ix%i', (ratio, shortEdge, width, height) => {
    expect(resolve(ratio as string, shortEdge as number)).toEqual({ width, height });
  });

  it('keeps both edges even so encoders accept the canvas', () => {
    const { width, height } = resolve('2.39:1', 721);
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
    expect(height).toBe(722);
  });

  it('refuses a resolution that would exceed the encoder limit', () => {
    expect(() => resolve('100:1', 1080)).toThrow(AspectRatioError);
    expect(() => resolve('16:9', MAX_CANVAS_EDGE)).toThrow(AspectRatioError);
  });

  it('refuses a short edge below the minimum', () => {
    expect(() => resolve('16:9', 1)).toThrow(AspectRatioError);
    expect(() => resolve('16:9', 0)).toThrow(AspectRatioError);
    expect(() => resolve('16:9', Number.NaN)).toThrow(AspectRatioError);
  });
});

describe('aspect ratio label', () => {
  it('reduces to an integer ratio when it is readable', () => {
    expect(aspectRatioLabel(1920, 1080)).toBe('16:9');
    expect(aspectRatioLabel(1080, 1920)).toBe('9:16');
    expect(aspectRatioLabel(1080, 1080)).toBe('1:1');
    expect(aspectRatioLabel(2592, 1080)).toBe('12:5');
  });

  it('falls back to a decimal ratio when the reduced form is unreadable', () => {
    expect(aspectRatioLabel(1919, 1080)).toBe('1.78:1');
    expect(aspectRatioLabel(1080, 1919)).toBe('1:1.78');
  });

  it('reports a placeholder for a degenerate canvas', () => {
    expect(aspectRatioLabel(0, 1080)).toBe('—');
    expect(aspectRatioLabel(1920, Number.NaN)).toBe('—');
  });
});

describe('custom ratio editing', () => {
  it('preserves the resolution when the seeded input is left untouched', () => {
    const context = { width: 1919, height: 1080 };
    const input = customRatioInput(context);

    expect(input).toEqual({ horizontal: '1.78', vertical: '1' });
    // Applying the rounded value the field displayed must not resize the canvas.
    expect(customRatioResolution(context, input.horizontal, input.vertical)).toEqual(context);
  });

  it('resolves an edited ratio against the current short edge', () => {
    const context = { width: 1920, height: 1080 };

    expect(customRatioResolution(context, '3', '2')).toEqual({ width: 1620, height: 1080 });
    expect(customRatioResolution(context, '9', '16')).toEqual({ width: 1080, height: 1920 });
  });

  it('propagates the refusal for an invalid edit', () => {
    expect(() => customRatioResolution({ width: 1920, height: 1080 }, '0', '1')).toThrow(
      AspectRatioError,
    );
  });
});

describe('presets', () => {
  it('matches a preset only at its own resolution', () => {
    const sixteenNine = findAspectPreset('16:9')!;
    expect(aspectPresetMatches(sixteenNine, 1920, 1080)).toBe(true);
    expect(aspectPresetMatches(sixteenNine, 3840, 2160)).toBe(false);
  });

  it('exposes preset resolutions that are themselves valid canvases', () => {
    for (const preset of ASPECT_PRESETS) {
      expect(preset.width % 2).toBe(0);
      expect(preset.height % 2).toBe(0);
      expect(Math.max(preset.width, preset.height)).toBeLessThanOrEqual(MAX_CANVAS_EDGE);
    }
  });

  it('scales quality presets while preserving the aspect ratio', () => {
    const fourK = findQualityPreset('4K')!;
    expect(resolutionForQuality(fourK, { width: 1920, height: 1080 })).toEqual({
      width: 3840,
      height: 2160,
    });
    expect(resolutionForQuality(fourK, { width: 1080, height: 1920 })).toEqual({
      width: 2160,
      height: 3840,
    });
  });

  it('reports the quality preset a canvas currently sits at', () => {
    const fullHd = findQualityPreset('1080p')!;
    expect(qualityPresetMatches(fullHd, { width: 1920, height: 1080 })).toBe(true);
    expect(qualityPresetMatches(fullHd, { width: 1080, height: 1920 })).toBe(true);
    expect(qualityPresetMatches(fullHd, { width: 3840, height: 2160 })).toBe(false);
  });

  it('combines a custom ratio with a quality short edge', () => {
    const fourK = findQualityPreset('4K')!;
    // Upstream's MCP case: 2.39:1 at 4K resolves to 5162x2160.
    expect(resolutionForAspectRatio(parseAspectRatio('2.39:1'), fourK.shortEdge)).toEqual({
      width: 5162,
      height: 2160,
    });
  });

  it('keeps preset ids unique and non-empty', () => {
    const aspectIds = ASPECT_PRESETS.map((preset) => preset.id);
    const qualityIds = QUALITY_PRESETS.map((preset) => preset.id);
    expect(new Set(aspectIds).size).toBe(aspectIds.length);
    expect(new Set(qualityIds).size).toBe(qualityIds.length);
    expect(findAspectPreset('nope')).toBeUndefined();
    expect(findQualityPreset('nope')).toBeUndefined();
  });
});
