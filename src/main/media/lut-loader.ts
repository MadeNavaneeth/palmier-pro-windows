/**
 * Main-process .cube LUT loader (upstream #157 LUT slice).
 *
 * Pure parsing and sampling live in `shared/editor/lut.ts`; this module owns
 * the filesystem side: validate a path (exists, .cube, parses), resolve a
 * parsed table for the preview compositor, and cache successes in memory so
 * a frame never re-reads its LUT (upstream's `cachedLUTs`, same idea).
 *
 * Only successes are cached: a missing file may appear (relink), and an
 * invalid file may be fixed, so failures re-read on the next use instead of
 * pinning a stale refusal. Reads are synchronous — the preview already runs
 * in the main process per frame and the cache makes repeat frames free.
 */

import fsSync from 'fs';
import { MAX_CUBE_FILE_BYTES, parseCubeText, sanitizeLutRef, type CubeLut, type LutRef } from '../../shared/editor/lut';

const cache = new Map<string, CubeLut>();

/** Clear the in-memory table cache (tests only). */
export function clearLutCache(): void {
  cache.clear();
}

export type LutValidation =
  | { ok: true; ref: LutRef }
  | { ok: false; error: string };

/**
 * Strict boundary validation for a user- or agent-supplied LUT path:
 * non-empty string, existing readable file, within the byte cap, and
 * parsing with a precise reason on failure. Returns the clip-ready
 * reference (kind + size recorded so the pure export builder can pick its
 * filter without reading the file).
 */
export function validateLutFile(rawPath: unknown, intensity: unknown = 1): LutValidation {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return { ok: false, error: 'LUT path must be a non-empty string.' };
  }
  const path = rawPath.trim();
  if (!path.toLowerCase().endsWith('.cube')) {
    return { ok: false, error: 'LUT file must have a .cube extension.' };
  }
  let stat: fsSync.Stats;
  try {
    stat = fsSync.statSync(path);
  } catch {
    return { ok: false, error: `No file at path: ${path}` };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `Not a file: ${path}` };
  }
  if (stat.size > MAX_CUBE_FILE_BYTES) {
    return { ok: false, error: `LUT file exceeds the ${MAX_CUBE_FILE_BYTES} byte cap.` };
  }
  let text: string;
  try {
    text = fsSync.readFileSync(path, 'utf8');
  } catch {
    return { ok: false, error: `Could not read LUT file: ${path}` };
  }
  const parsed = parseCubeText(text);
  if (!parsed.ok) {
    const name = path.split(/[\\/]/).pop() ?? path;
    return { ok: false, error: `Not a valid .cube LUT: ${name} (${parsed.error})` };
  }
  const strength = typeof intensity === 'number' && Number.isFinite(intensity) ? intensity : 1;
  if (strength < 0 || strength > 1) {
    return { ok: false, error: 'LUT intensity must be between 0 and 1.' };
  }
  const ref = sanitizeLutRef({
    path,
    intensity: strength,
    kind: parsed.lut.kind,
    size: parsed.lut.size,
  });
  if (!ref) return { ok: false, error: `Not a valid .cube LUT: ${path}` };
  cache.set(path, parsed.lut);
  return { ok: true, ref };
}

/**
 * Resolve a clip's LUT path to its parsed table for the preview pass, or
 * null when the file is missing/unreadable/invalid. Null degrades that
 * stage to ungraded (the caller skips it); the Inspector's validate IPC and
 * the export preflight surface the visible diagnostic, so this path only
 * logs.
 */
export function resolvePreviewLut(rawPath: string | undefined): CubeLut | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const cached = cache.get(rawPath);
  if (cached) return cached;
  const validation = validateLutFile(rawPath);
  if (!validation.ok) {
    console.warn(`[lut] ${validation.error} — rendering without the LUT.`);
    return null;
  }
  return cache.get(rawPath) ?? null;
}

/** Drop one path from the cache (a file the user replaced on disk). */
export function evictLut(path: string): void {
  cache.delete(path);
}
