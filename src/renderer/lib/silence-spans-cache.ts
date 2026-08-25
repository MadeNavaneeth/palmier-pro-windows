/**
 * Silence-span cache for the timeline overlay (#426's "Mark Silence").
 *
 * Detected spans are fetched once per path + saved-controls combination and
 * shared by every clip referencing the same audio, exactly like the waveform
 * cache beside it. The saved settings are part of the key because they decide
 * what counts as silent: moving a slider must re-detect, not keep showing
 * spans the next removal would not cut. Changing the controls busts the cache
 * through `resetSilenceSpansCache`, which the settings hook calls after a
 * confirmed write.
 */

import { DEFAULT_SILENCE_CONFIG, type SilenceConfig, type SilentRange } from '../../shared/audio/silence-detector';

const pending = new Map<string, Promise<SilentRange[]>>();

let configPromise: Promise<SilenceConfig> | null = null;

function getSavedConfig(): Promise<SilenceConfig> {
  if (!configPromise) {
    configPromise = window.palmier.media
      .getSilenceSettings()
      .then((result) => result?.settings ?? { ...DEFAULT_SILENCE_CONFIG })
      .catch(() => ({ ...DEFAULT_SILENCE_CONFIG }));
  }
  return configPromise;
}

/**
 * Spans for `path` under the saved controls, or null until the saved config
 * has resolved (the caller just skips drawing this pass).
 */
export function getSilenceSpans(path: string): Promise<SilentRange[]> | null {
  if (!configPromise) void getSavedConfig();
  const configPromiseRef = configPromise;
  if (!configPromiseRef) return null;

  // The key is resolved through the same promise, so a call made before the
  // settings read finishes lands under the key its detection actually used.
  const promise = configPromiseRef.then((config) => {
    const key = `${path}|${config.thresholdDb}|${config.minSilenceSec}|${config.edgePaddingSec}`;
    const existing = pending.get(key);
    if (existing) return existing;

    const detected = window.palmier.media
      .detectSilence(path)
      .then((res) => (res.success && Array.isArray(res.ranges) ? (res.ranges as SilentRange[]) : []))
      .catch((err: unknown) => {
        // A transient detection failure resolves empty for this caller but is
        // not cached, so a later draw retries instead of hiding spans forever.
        pending.delete(key);
        return [] as SilentRange[];
      });
    pending.set(key, detected);
    return detected;
  });

  return promise;
}

/** Drop every cached span set; the next draw re-detects under current keys. */
export function resetSilenceSpansCache(): void {
  pending.clear();
  // Settings may have changed: force the next getSavedConfig to re-read.
  configPromise = null;
}
