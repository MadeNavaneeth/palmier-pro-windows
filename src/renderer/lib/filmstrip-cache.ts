/**
 * Filmstrip cache for timeline video thumbnails (R1 lane states).
 *
 * One strip per source path+count, shared by every clip referencing the
 * asset; failures are cached so an unreadable file does not re-spawn
 * FFmpeg on every render pass.
 */

export interface FilmstripResult {
  paths: string[];
}

const pending = new Map<string, Promise<string[]>>();
const failed = new Set<string>();

export function getFilmstrip(
  path: string,
  count: number,
): Promise<string[]> | null {
  if (failed.has(path)) return null;
  const key = `${path}|${count}`;
  const existing = pending.get(key);
  if (existing) return existing;

  const promise = window.palmier.media
    .filmstrip(path, count)
    .then((res: { success: boolean; paths?: string[]; error?: string }) => {
      if (res.success && Array.isArray(res.paths) && res.paths.length > 0) {
        return res.paths;
      }
      failed.add(path);
      throw new Error(res.error ?? 'filmstrip unavailable');
    })
    .catch((err: unknown) => {
      failed.add(path);
      pending.delete(key);
      throw err;
    });
  pending.set(key, promise);
  return promise;
}
