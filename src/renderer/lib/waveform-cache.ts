/**
 * Waveform cache for timeline audio rendering (R1 lane states).
 *
 * Full-source peak curves are fetched once per path+buckets and shared by
 * every clip referencing the same audio; failures are cached briefly so an
 * unsupported file does not trigger a re-decode on every render pass.
 */

const pending = new Map<string, Promise<number[]>>();
const failed = new Set<string>();

export function getWaveformPeaks(
  path: string,
  buckets: number,
): Promise<number[]> | null {
  if (failed.has(path)) return null;
  const key = `${path}|${buckets}`;
  const existing = pending.get(key);
  if (existing) return existing;

  const promise = window.palmier.media
    .waveform(path, buckets)
    .then((res) => {
      if (res.success && Array.isArray(res.peaks) && res.peaks.length > 0) {
        return res.peaks as number[];
      }
      failed.add(path);
      throw new Error(res.error ?? 'waveform unavailable');
    })
    .catch((err: unknown) => {
      failed.add(path);
      pending.delete(key);
      throw err;
    });
  pending.set(key, promise);
  return promise;
}
