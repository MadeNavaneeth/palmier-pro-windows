/**
 * Adobe .cube LUT support (upstream #157 LUT slice).
 *
 * Upstream parses 3D .cube files in `Compositing/LUTLoader.swift` (TITLE
 * ignored, DOMAIN_MIN/MAX normalized with a 1e-4 span guard, dimension
 * 2..128, exact value count, 1D files refused) and samples them with
 * tetrahedral interpolation (`LUTTetraKernel`, intensity 0..1 default 1
 * blending the LUT output with the original frame). This port mirrors that,
 * with two documented differences:
 *
 * - 1D .cube files are accepted (per-channel linear lookup, exported via
 *   FFmpeg `lut1d`), while upstream refuses them. The task requires valid
 *   1D support, so the parser handles both sizes; every refusal stays
 *   precise about which size failed and why.
 * - Clips reference the user's file in place (a `LutRef` path) instead of
 *   upstream's copy into AppSupport project storage. This port keeps a
 *   single-file .vproj with no package storage, so there is nowhere to copy
 *   to; a path that later goes missing or unreadable degrades to ungraded
 *   for that stage (preview skips it, export strips it pre-flight) with a
 *   visible diagnostic, never a crash or silent wrong colors.
 *
 * Caps (memory guards, documented here rather than hidden):
 * - file text: at most MAX_CUBE_FILE_BYTES bytes (a 128^3 table is ~25MB of
 *   text; anything larger is refused before parsing).
 * - 3D size: 2..128 per axis (upstream's bounds verbatim).
 * - 1D size: 2..4096 entries (Adobe tools commonly emit 1024/4096).
 * - stored path: at most MAX_LUT_PATH_CHARS characters.
 *
 * This module is pure (no fs): the main-process loader
 * (`main/media/lut-loader.ts`) reads files and caches parsed tables, the
 * agent boundary validates through it, and the preview resolves tables once
 * per frame and hands them to the per-pixel core below.
 */

export interface CubeLut3D {
  kind: '3d';
  size: number;
  /** RGB triples, r fastest (`table[(r + size * (g + size * b)) * 3 + c]`), domain-normalized to [0, 1]. */
  table: Float32Array;
}

export interface CubeLut1D {
  kind: '1d';
  size: number;
  /** RGB triples in file order; each output channel interpolates its own column. */
  table: Float32Array;
}

export type CubeLut = CubeLut3D | CubeLut1D;

/**
 * The serializable per-clip LUT reference: where the file lives, how
 * strongly it applies, and the parsed shape (so the pure export builder can
 * pick `lut3d` vs `lut1d` without reading the file). File existence is
 * checked on use, never here, so a saved project with a moved file still
 * loads and then diagnoses instead of failing.
 */
export interface LutRef {
  path: string;
  /** Blend strength 0..1 (upstream's `intensity`, default 1). */
  intensity: number;
  kind: '1d' | '3d';
  size: number;
}

/** Upstream `color.lut` intensity range verbatim (EffectRegistry). */
export const LUT_INTENSITY_LIMITS = { min: 0, max: 1 } as const;

/** The strength a fresh LUT reference applies at (upstream default). */
export const DEFAULT_LUT_INTENSITY = 1;

/** Largest .cube text accepted before parsing (see module doc). */
export const MAX_CUBE_FILE_BYTES = 32 * 1024 * 1024;

/** 3D axis bounds (upstream `dimension > 1, dimension <= 128` verbatim). */
export const CUBE_3D_SIZE_LIMITS = { min: 2, max: 128 } as const;

/** 1D entry-count bounds (this port accepts 1D; upstream refuses it). */
export const CUBE_1D_SIZE_LIMITS = { min: 2, max: 4096 } as const;

/** Longest stored LUT path (a hostile project file cannot grow it). */
export const MAX_LUT_PATH_CHARS = 1024;

export type CubeParseResult =
  | { ok: true; lut: CubeLut }
  | { ok: false; error: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Parse Adobe .cube text into a domain-normalized table.
 *
 * Mirrors `LUTLoader.parse`: TITLE lines ignored, DOMAIN_MIN/MAX (default
 * 0/1 per channel) normalize each value with a 1e-4 span guard and a
 * [0, 1] clamp, data lines are whitespace-separated RGB triples in r-fastest
 * order. Refusals name the reason: bad size declaration, value-count
 * mismatch, bad domain, or a non-finite value with its line number.
 */
export function parseCubeText(text: string): CubeParseResult {
  if (text.length > MAX_CUBE_FILE_BYTES) {
    return { ok: false, error: `LUT file exceeds the ${MAX_CUBE_FILE_BYTES} byte cap.` };
  }
  let size1D = 0;
  let size3D = 0;
  let domainMin: number[] = [0, 0, 0];
  let domainMax: number[] = [1, 1, 1];
  const values: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const keyword = parts[0].toUpperCase();
    if (keyword === 'TITLE') continue;
    if (keyword === 'LUT_1D_SIZE' || keyword === 'LUT_3D_SIZE') {
      const size = Number(parts[parts.length - 1]);
      if (!Number.isInteger(size)) {
        return { ok: false, error: `${parts[0]} must declare an integer size (line ${lineIndex + 1}).` };
      }
      if (keyword === 'LUT_1D_SIZE') size1D = size;
      else size3D = size;
      continue;
    }
    if (keyword === 'DOMAIN_MIN' || keyword === 'DOMAIN_MAX') {
      const domain = parts.slice(1).map(Number);
      if (domain.length !== 3 || !domain.every(isFiniteNumber)) {
        return { ok: false, error: `${parts[0]} needs exactly 3 finite numbers (line ${lineIndex + 1}).` };
      }
      if (keyword === 'DOMAIN_MIN') domainMin = domain;
      else domainMax = domain;
      continue;
    }
    if (parts.length < 3) continue;
    const rgb = [Number(parts[0]), Number(parts[1]), Number(parts[2])];
    if (!rgb.every(isFiniteNumber)) {
      return { ok: false, error: `Non-finite LUT value (line ${lineIndex + 1}).` };
    }
    values.push(rgb[0], rgb[1], rgb[2]);
  }

  if (size1D > 0 && size3D > 0) {
    return { ok: false, error: 'Cannot mix LUT_1D_SIZE and LUT_3D_SIZE in one file.' };
  }
  if (size3D > 0) {
    if (!Number.isInteger(size3D) || size3D < CUBE_3D_SIZE_LIMITS.min || size3D > CUBE_3D_SIZE_LIMITS.max) {
      return {
        ok: false,
        error: `LUT_3D_SIZE must be an integer between ${CUBE_3D_SIZE_LIMITS.min} and ${CUBE_3D_SIZE_LIMITS.max}.`,
      };
    }
    const expected = size3D * size3D * size3D * 3;
    if (values.length !== expected) {
      return {
        ok: false,
        error: `Expected ${expected / 3} LUT entries for LUT_3D_SIZE ${size3D}, found ${values.length / 3}.`,
      };
    }
    return { ok: true, lut: { kind: '3d', size: size3D, table: normalizeDomain(values, domainMin, domainMax) } };
  }
  if (size1D > 0) {
    if (!Number.isInteger(size1D) || size1D < CUBE_1D_SIZE_LIMITS.min || size1D > CUBE_1D_SIZE_LIMITS.max) {
      return {
        ok: false,
        error: `LUT_1D_SIZE must be an integer between ${CUBE_1D_SIZE_LIMITS.min} and ${CUBE_1D_SIZE_LIMITS.max}.`,
      };
    }
    const expected = size1D * 3;
    if (values.length !== expected) {
      return {
        ok: false,
        error: `Expected ${expected / 3} LUT entries for LUT_1D_SIZE ${size1D}, found ${values.length / 3}.`,
      };
    }
    return { ok: true, lut: { kind: '1d', size: size1D, table: normalizeDomain(values, domainMin, domainMax) } };
  }
  return { ok: false, error: 'Missing LUT_1D_SIZE or LUT_3D_SIZE declaration.' };
}

/** Upstream's domain normalization verbatim: per-channel rescale with a 1e-4 span guard, clamped to [0, 1]. */
function normalizeDomain(values: number[], domainMin: number[], domainMax: number[]): Float32Array {
  const table = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const channel = i % 3;
    const span = Math.max(0.0001, domainMax[channel] - domainMin[channel]);
    const normalized = (values[i] - domainMin[channel]) / span;
    table[i] = Math.min(1, Math.max(0, normalized));
  }
  return table;
}

/**
 * Narrow an untrusted LUT reference (project file, preset file, agent arg).
 * Drops the whole reference when the path is empty/not a .cube, the kind is
 * unknown, or the size is outside the parser's bounds; a bad intensity falls
 * back to the default instead of refusing the file. Never touches the
 * filesystem: existence is validated on use so moved files diagnose rather
 * than fail the load.
 */
export function sanitizeLutRef(input: unknown): LutRef | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const candidate = input as { path?: unknown; intensity?: unknown; kind?: unknown; size?: unknown };
  if (typeof candidate.path !== 'string') return undefined;
  const path = candidate.path.trim();
  if (path.length === 0 || path.length > MAX_LUT_PATH_CHARS) return undefined;
  if (!path.toLowerCase().endsWith('.cube')) return undefined;
  if (candidate.kind !== '1d' && candidate.kind !== '3d') return undefined;
  const limits = candidate.kind === '3d' ? CUBE_3D_SIZE_LIMITS : CUBE_1D_SIZE_LIMITS;
  if (!Number.isInteger(candidate.size) || (candidate.size as number) < limits.min || (candidate.size as number) > limits.max) {
    return undefined;
  }
  const intensity = isFiniteNumber(candidate.intensity)
    && candidate.intensity >= LUT_INTENSITY_LIMITS.min
    && candidate.intensity <= LUT_INTENSITY_LIMITS.max
    ? candidate.intensity
    : DEFAULT_LUT_INTENSITY;
  return { path, intensity, kind: candidate.kind, size: candidate.size as number };
}

/** Structural equality on sanitized references (undefined = no LUT). */
export function lutRefsEqual(a: LutRef | undefined, b: LutRef | undefined): boolean {
  const left = sanitizeLutRef(a);
  const right = sanitizeLutRef(b);
  if (left === undefined || right === undefined) return left === right;
  return left.path === right.path
    && left.intensity === right.intensity
    && left.kind === right.kind
    && left.size === right.size;
}

// ─── Sampling (upstream LUTTetraKernel: tetrahedral 3D + intensity blend) ────

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Truncate toward zero and clamp to a byte, mirroring the export store path. */
function truncByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.trunc(value);
}

/**
 * Tetrahedral interpolation of a 3D table at normalized (r, g, b).
 *
 * Upstream samples with a tetrahedron, not the 8-corner trilinear blend, so
 * this port does the same: the unit cube around the pixel splits into six
 * tetrahedra by the ordering of the fractional parts, and the output is the
 * barycentric blend of the four vertices. r is the fastest table axis,
 * matching the parse order FFmpeg's `lut3d` (interp=tetrahedral, its
 * default) reads, which is what keeps preview and export on the same math.
 */
export function sampleLut3DTetra(lut: CubeLut3D, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size;
  const span = n - 1;
  const x = clamp01(r) * span;
  const y = clamp01(g) * span;
  const z = clamp01(b) * span;
  const x0 = Math.min(n - 2, Math.floor(x));
  const y0 = Math.min(n - 2, Math.floor(y));
  const z0 = Math.min(n - 2, Math.floor(z));
  const rx = x - x0;
  const ry = y - y0;
  const rz = z - z0;
  const at = (dr: number, dg: number, db: number, channel: 0 | 1 | 2): number =>
    lut.table[((x0 + dr) + n * ((y0 + dg) + n * (z0 + db))) * 3 + channel];
  // Six tetrahedra by fractional ordering; weights are the barycentric
  // differences along the sorted axis order.
  let v0: [number, number, number];
  let v1: [number, number, number];
  let v2: [number, number, number];
  let v3: [number, number, number];
  let w1: number;
  let w2: number;
  let w3: number;
  if (rx >= ry && ry >= rz) {
    v0 = [0, 0, 0]; v1 = [1, 0, 0]; v2 = [1, 1, 0]; v3 = [1, 1, 1];
    w1 = rx - ry; w2 = ry - rz; w3 = rz;
  } else if (rx >= rz && rz >= ry) {
    v0 = [0, 0, 0]; v1 = [1, 0, 0]; v2 = [1, 0, 1]; v3 = [1, 1, 1];
    w1 = rx - rz; w2 = rz - ry; w3 = ry;
  } else if (rz >= rx && rx >= ry) {
    v0 = [0, 0, 0]; v1 = [0, 0, 1]; v2 = [1, 0, 1]; v3 = [1, 1, 1];
    w1 = rz - rx; w2 = rx - ry; w3 = ry;
  } else if (ry >= rx && rx >= rz) {
    v0 = [0, 0, 0]; v1 = [0, 1, 0]; v2 = [1, 1, 0]; v3 = [1, 1, 1];
    w1 = ry - rx; w2 = rx - rz; w3 = rz;
  } else if (ry >= rz && rz >= rx) {
    v0 = [0, 0, 0]; v1 = [0, 1, 0]; v2 = [0, 1, 1]; v3 = [1, 1, 1];
    w1 = ry - rz; w2 = rz - rx; w3 = rx;
  } else {
    v0 = [0, 0, 0]; v1 = [0, 0, 1]; v2 = [0, 1, 1]; v3 = [1, 1, 1];
    w1 = rz - ry; w2 = ry - rx; w3 = rx;
  }
  const w0 = 1 - w1 - w2 - w3;
  const out = (channel: 0 | 1 | 2): number =>
    w0 * at(v0[0], v0[1], v0[2], channel)
    + w1 * at(v1[0], v1[1], v1[2], channel)
    + w2 * at(v2[0], v2[1], v2[2], channel)
    + w3 * at(v3[0], v3[1], v3[2], channel);
  return [out(0), out(1), out(2)];
}

/**
 * Per-channel linear lookup of a 1D table at normalized (r, g, b): each
 * output channel interpolates its own column between the bracketing entries.
 */
export function sampleLut1D(lut: CubeLut1D, r: number, g: number, b: number): [number, number, number] {
  const span = lut.size - 1;
  const channel = (c: number, column: 0 | 1 | 2): number => {
    const x = clamp01(c) * span;
    const i0 = Math.min(lut.size - 2, Math.floor(x));
    const f = x - i0;
    return (1 - f) * lut.table[i0 * 3 + column] + f * lut.table[(i0 + 1) * 3 + column];
  };
  return [channel(r, 0), channel(g, 1), channel(b, 2)];
}

/** Sample either LUT kind at normalized (r, g, b). */
export function sampleLut(lut: CubeLut, r: number, g: number, b: number): [number, number, number] {
  return lut.kind === '3d'
    ? sampleLut3DTetra(lut, r, g, b)
    : sampleLut1D(lut, r, g, b);
}

/**
 * LUT on one RGB pixel (integers in, integers out): sample the table, blend
 * toward the original by intensity (`mix(original, lut, intensity)` —
 * upstream's `intensity` semantics), truncate like the export store.
 */
export function lutPixel(
  r: number,
  g: number,
  b: number,
  lut: CubeLut,
  intensity: number,
): [number, number, number] {
  const strength = Number.isFinite(intensity)
    ? Math.min(LUT_INTENSITY_LIMITS.max, Math.max(LUT_INTENSITY_LIMITS.min, intensity))
    : DEFAULT_LUT_INTENSITY;
  if (strength <= 0) return [r, g, b];
  const [lr, lg, lb] = sampleLut(lut, r / 255, g / 255, b / 255);
  if (strength >= 1) return [truncByte(lr * 255), truncByte(lg * 255), truncByte(lb * 255)];
  return [
    truncByte(r * (1 - strength) + lr * 255 * strength),
    truncByte(g * (1 - strength) + lg * 255 * strength),
    truncByte(b * (1 - strength) + lb * 255 * strength),
  ];
}

// ─── Export filter emission ──────────────────────────────────────────────────

/**
 * Quote a LUT path for `lut3d=file='…'` / `lut1d=file='…'`.
 *
 * Single quotes protect `;`, `,` and brackets from the filter parser, but
 * the drive-colon still splits options inside quotes (verified against
 * FFmpeg 8.1.2: `file='C:/…'` fails to parse) and the backslash stays an
 * escape even inside quotes, so Windows separators are doubled, a literal
 * quote is backslash-escaped, and every `:` is backslash-escaped.
 */
export function escapeLutFilterPath(path: string): string {
  return `'${path.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:')}'`;
}

/**
 * The single-filter LUT stage for intensity 1 (no blend needed): 3D tables
 * ride `lut3d` with tetrahedral interpolation (FFmpeg's default, matching
 * the preview sampler above), 1D tables ride `lut1d` with linear
 * interpolation (matching `sampleLut1D`).
 */
export function toFfmpegLutFilter(ref: LutRef): string {
  const file = escapeLutFilterPath(ref.path);
  return ref.kind === '3d' ? `lut3d=file=${file}:interp=tetrahedral` : `lut1d=file=${file}:interp=linear`;
}
