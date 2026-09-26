/**
 * .cube LUT coverage (upstream #157 LUT slice): parser (valid 1D/3D, TITLE
 * and DOMAIN handling, precise malformed refusals, caps), sanitize, the
 * tetrahedral/linear sampling math with pinned values (verified against
 * FFmpeg 8.1.2 `lut3d:interp=tetrahedral` / `lut1d:interp=linear` — see
 * comments), intensity blending, equality, and filter emission.
 */

import { describe, expect, it } from 'vitest';
import {
  CUBE_1D_SIZE_LIMITS,
  CUBE_3D_SIZE_LIMITS,
  DEFAULT_LUT_INTENSITY,
  LUT_INTENSITY_LIMITS,
  MAX_CUBE_FILE_BYTES,
  escapeLutFilterPath,
  lutPixel,
  lutRefsEqual,
  parseCubeText,
  sampleLut,
  sanitizeLutRef,
  toFfmpegLutFilter,
  type CubeLut,
} from './lut';

function cube3D(size: number, value: (r: number, g: number, b: number) => [number, number, number]): string {
  const lines = [`LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const [vr, vg, vb] = value(r / (size - 1), g / (size - 1), b / (size - 1));
        lines.push(`${vr} ${vg} ${vb}`);
      }
    }
  }
  return lines.join('\n');
}

const IDENTITY_3 = cube3D(2, (r, g, b) => [r, g, b]);
const INVERT_3 = cube3D(2, (r, g, b) => [1 - r, 1 - g, 1 - b]);

function parseOrThrow(text: string): CubeLut {
  const parsed = parseCubeText(text);
  if (!parsed.ok) throw new Error(`expected valid LUT: ${parsed.error}`);
  return parsed.lut;
}

describe('parseCubeText 3D', () => {
  it('parses a valid 3D LUT with TITLE ignored', () => {
    const parsed = parseCubeText(`TITLE "warm look"\n# comment\n${IDENTITY_3}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.lut.kind).toBe('3d');
    if (parsed.lut.kind !== '3d') return;
    expect(parsed.lut.size).toBe(2);
    expect(parsed.lut.table.length).toBe(2 * 2 * 2 * 3);
    // r-fastest order: second triple is the r=1 node.
    expect(Array.from(parsed.lut.table.slice(0, 6))).toEqual([0, 0, 0, 1, 0, 0]);
  });

  it('normalizes DOMAIN_MIN/MAX like upstream (span guard + clamp)', () => {
    const parsed = parseCubeText(
      'LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n'
      + '0 0 0\n2 0 0\n0 2 0\n2 2 0\n0 0 2\n2 0 2\n0 2 2\n2 2 2',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.lut.kind !== '3d') return;
    expect(Array.from(parsed.lut.table.slice(3, 6))).toEqual([1, 0, 0]);
  });

  it('refuses malformed files with the reason', () => {
    expect(parseCubeText('TITLE only, no size').ok).toBe(false);
    const missing = parseCubeText('TITLE only, no size');
    if (!missing.ok) expect(missing.error).toMatch(/LUT_3D_SIZE|LUT_1D_SIZE/);

    const badSize = parseCubeText('LUT_3D_SIZE hello\n0 0 0');
    expect(badSize.ok).toBe(false);
    if (!badSize.ok) expect(badSize.error).toMatch(/integer size/);

    const tooBig = parseCubeText(`LUT_3D_SIZE ${CUBE_3D_SIZE_LIMITS.max + 1}\n0 0 0`);
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toMatch(/between 2 and 128/);

    const short = parseCubeText('LUT_3D_SIZE 2\n0 0 0\n1 0 0');
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error).toMatch(/Expected 8 LUT entries.*found 2/);

    const badDomain = parseCubeText('LUT_3D_SIZE 2\nDOMAIN_MIN 0 0\n0 0 0');
    expect(badDomain.ok).toBe(false);
    if (!badDomain.ok) expect(badDomain.error).toMatch(/DOMAIN_MIN needs exactly 3/);

    const nonFinite = parseCubeText('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\nNaN 0 0');
    expect(nonFinite.ok).toBe(false);
    if (!nonFinite.ok) expect(nonFinite.error).toMatch(/Non-finite LUT value \(line 9\)/);

    const mixed = parseCubeText('LUT_1D_SIZE 4\nLUT_3D_SIZE 2\n0 0 0');
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.error).toMatch(/Cannot mix/);
  });

  it('refuses files over the byte cap before parsing', () => {
    const parsed = parseCubeText(`LUT_3D_SIZE 2\n${' '.repeat(MAX_CUBE_FILE_BYTES)}`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/byte cap/);
  });
});

describe('parseCubeText 1D', () => {
  it('parses a valid 1D LUT', () => {
    const parsed = parseCubeText(
      'TITLE "identity 1D"\nLUT_1D_SIZE 4\n0 0 0\n0.333333 0.333333 0.333333\n0.666667 0.666667 0.666667\n1 1 1',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.lut.kind !== '1d') return;
    expect(parsed.lut.size).toBe(4);
    expect(parsed.lut.table.length).toBe(12);
  });

  it('refuses bad 1D sizes and short value counts', () => {
    const badSize = parseCubeText(`LUT_1D_SIZE ${CUBE_1D_SIZE_LIMITS.max + 1}\n0 0 0`);
    expect(badSize.ok).toBe(false);
    if (!badSize.ok) expect(badSize.error).toMatch(/LUT_1D_SIZE must be an integer between/);

    const short = parseCubeText('LUT_1D_SIZE 4\n0 0 0\n1 1 1');
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error).toMatch(/Expected 4 LUT entries.*found 2/);
  });
});

describe('sanitizeLutRef', () => {
  const ref = { path: 'C:\\luts\\warm.cube', intensity: 0.5, kind: '3d' as const, size: 33 };

  it('keeps a valid reference and defaults a bad intensity to 1', () => {
    expect(sanitizeLutRef(ref)).toEqual(ref);
    expect(sanitizeLutRef({ ...ref, intensity: 99 })).toEqual({ ...ref, intensity: DEFAULT_LUT_INTENSITY });
  });

  it('drops references with a bad path, kind, or size', () => {
    expect(sanitizeLutRef({ ...ref, path: '' })).toBeUndefined();
    expect(sanitizeLutRef({ ...ref, path: 'warm.lut' })).toBeUndefined();
    expect(sanitizeLutRef({ ...ref, kind: '4d' })).toBeUndefined();
    expect(sanitizeLutRef({ ...ref, size: 1 })).toBeUndefined();
    expect(sanitizeLutRef({ ...ref, size: 129 })).toBeUndefined();
    expect(sanitizeLutRef(null)).toBeUndefined();
    expect(sanitizeLutRef('warm.cube')).toBeUndefined();
  });

  it('compares structurally (undefined = no LUT)', () => {
    expect(lutRefsEqual(ref, { ...ref })).toBe(true);
    expect(lutRefsEqual(ref, { ...ref, intensity: 1 })).toBe(false);
    expect(lutRefsEqual(undefined, undefined)).toBe(true);
    expect(lutRefsEqual(ref, undefined)).toBe(false);
  });
});

describe('sampling math', () => {
  it('maps corners exactly through the invert LUT', () => {
    const lut = parseOrThrow(INVERT_3);
    expect(sampleLut(lut, 0, 0, 0).map((v) => Math.round(v * 255))).toEqual([255, 255, 255]);
    expect(sampleLut(lut, 1, 1, 1).map((v) => Math.round(v * 255))).toEqual([0, 0, 0]);
  });

  it('lutPixel pins preview values (FFmpeg 8.1.2 gives (191,126,62) — ±1 float dust)', () => {
    const lut = parseOrThrow(INVERT_3);
    // Exact corners agree bit-for-bit with the export filter.
    expect(lutPixel(0, 0, 0, lut, 1)).toEqual([255, 255, 255]);
    expect(lutPixel(255, 255, 255, lut, 1)).toEqual([0, 0, 0]);
    expect(lutPixel(16, 16, 16, lut, 1)).toEqual([239, 239, 239]);
    // Interior points can sit 1 LSB above the export (float64 vs the
    // filter's float32 truncation); both round-trip the same look.
    expect(lutPixel(64, 128, 192, lut, 1)).toEqual([191, 127, 63]);
  });

  it('samples tetrahedrally, not trilinearly (white node remapped to red)', () => {
    const lut = parseOrThrow(cube3D(2, (r, g, b) => (r === 1 && g === 1 && b === 1 ? [1, 0, 0] : [r, g, b])));
    // (192, 128, 64): fractions order r > g > b, so the tetra spans
    // c000/c100/c110/c111 and G rides the (g-b) weight alone: 64.
    // Trilinear would pull G toward the white node's remapped 0 the same
    // way here, but R differs: tetra gives exactly r (192) while the
    // full-cube trilinear blend also gives r here — the pinned FFmpeg value
    // (192,64,0) agrees with the tetra weights, not an average.
    expect(lutPixel(192, 128, 64, lut, 1)).toEqual([192, 64, 0]);
  });

  it('interpolates 1D tables per channel', () => {
    const lut = parseOrThrow(
      'LUT_1D_SIZE 2\n0 0.25 0.5\n1 0.75 0.5',
    );
    // Mid input lerps each column: R 0.5, G 0.5, B constant 0.5.
    const [r, g, b] = sampleLut(lut, 0.5, 0.5, 0.5);
    expect([r, g, b].map((v) => Math.round(v * 1000))).toEqual([500, 500, 500]);
    expect(lutPixel(0, 0, 0, lut, 1)).toEqual([0, 63, 127]);
  });

  it('blends toward the original by intensity (upstream strength semantics)', () => {
    const lut = parseOrThrow(INVERT_3);
    expect(lutPixel(64, 128, 192, lut, 0)).toEqual([64, 128, 192]);
    // 0.25: trunc(64*0.75 + 191.0*0.25) = 95; the export blend graph
    // renders exactly (95,127,159) for this pixel (verified FFmpeg 8.1.2).
    expect(lutPixel(64, 128, 192, lut, 0.25)).toEqual([95, 127, 159]);
    expect(lutPixel(64, 128, 192, lut, 0.5)).toEqual([127, 127, 127]);
    expect(LUT_INTENSITY_LIMITS).toEqual({ min: 0, max: 1 });
  });
});

describe('filter emission', () => {
  it('emits lut3d tetrahedral / lut1d linear at full intensity', () => {
    expect(toFfmpegLutFilter({ path: 'C:\\luts\\warm.cube', intensity: 1, kind: '3d', size: 33 }))
      .toBe(`lut3d=file='C\\:\\\\luts\\\\warm.cube':interp=tetrahedral`);
    expect(toFfmpegLutFilter({ path: '/luts/flat.cube', intensity: 1, kind: '1d', size: 1024 }))
      .toBe(`lut1d=file='/luts/flat.cube':interp=linear`);
  });

  it('quotes spaces and single quotes for the filter parser', () => {
    expect(escapeLutFilterPath(`C:\\my luts\\it's.cube`)).toBe(`'C\\:\\\\my luts\\\\it\\'s.cube'`);
  });
});
