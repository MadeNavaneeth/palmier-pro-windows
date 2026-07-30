/**
 * Playback rate model.
 *
 * Upstream issue #212 asked for playback slower than the shipped floor. Slow
 * review speeds are how editors check a cut frame by frame, so the preset list
 * reaches down to a quarter speed and the transport shares one validated rate
 * type with the keyboard shuttle and the preview toolbar.
 *
 * Every rate flows through `normalizePlaybackRate`. The playback loop
 * accumulates `elapsed * |rate|`, so a non-finite rate would poison the
 * accumulator with NaN and freeze playback permanently — a state no later valid
 * rate could recover from.
 */

/** Rates offered in the preview toolbar, slowest first. */
export const PLAYBACK_RATE_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4, 10] as const;

/** Slowest usable rate. Below this the playhead barely advances. */
export const MIN_PLAYBACK_RATE = 0.25;
/** Fastest usable rate. */
export const MAX_PLAYBACK_RATE = 10;

/** Shuttle rates stepped through by the J and L keys. */
export const SHUTTLE_RATES = [1, 2, 4, 8] as const;

/**
 * Clamp a requested rate into the usable range, preserving direction.
 *
 * A rate of zero means "stopped", which the transport expresses with
 * `isPlaying`, not with a zero rate; it is normalized to the slowest forward
 * rate so playback cannot silently stall. A non-finite rate falls back to 1.
 */
export function normalizePlaybackRate(rate: number): number {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return 1;
  if (rate === 0) return MIN_PLAYBACK_RATE;
  const direction = rate < 0 ? -1 : 1;
  const magnitude = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, Math.abs(rate)));
  return direction * magnitude;
}

/** Next shuttle rate for the L key: forward, then faster. */
export function shuttleForward(rate: number): number {
  const current = normalizePlaybackRate(rate);
  if (current < 0) return 1;
  const next = SHUTTLE_RATES.find((candidate) => candidate > current);
  return normalizePlaybackRate(next ?? SHUTTLE_RATES[SHUTTLE_RATES.length - 1]);
}

/** Next shuttle rate for the J key: reverse, then faster in reverse. */
export function shuttleReverse(rate: number): number {
  const current = normalizePlaybackRate(rate);
  if (current > 0) return -1;
  const magnitude = Math.abs(current);
  const next = SHUTTLE_RATES.find((candidate) => candidate > magnitude);
  return normalizePlaybackRate(-(next ?? SHUTTLE_RATES[SHUTTLE_RATES.length - 1]));
}

/** Label for a rate in the transport UI. */
export function playbackRateLabel(rate: number): string {
  const normalized = normalizePlaybackRate(rate);
  const magnitude = Math.abs(normalized);
  return `${magnitude}x`;
}
