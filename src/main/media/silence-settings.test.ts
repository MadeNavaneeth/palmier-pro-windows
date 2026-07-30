/**
 * Regression coverage for the saved silence controls (upstream PR #426).
 *
 * Runs outside Electron, so `app` is unavailable and the persistent store is
 * never constructed. That is the interesting case: the controls still have to
 * work for the session, because the alternative is a slider that appears to move
 * and then silently has no effect on the removal.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadSilenceSettings,
  saveSilenceSettings,
  resetSilenceSettingsCache,
} from './silence-settings';
import { DEFAULT_SILENCE_CONFIG, SILENCE_LIMITS } from '../../shared/audio/silence-detector';

describe('silence settings', () => {
  beforeEach(() => {
    resetSilenceSettingsCache();
  });

  it('starts from the built-in defaults when nothing is saved', () => {
    expect(loadSilenceSettings()).toEqual(DEFAULT_SILENCE_CONFIG);
  });

  it('applies a partial update without resetting the other controls', () => {
    saveSilenceSettings({ minSilenceSec: 1.5 });
    saveSilenceSettings({ edgePaddingSec: 0.3 });

    expect(loadSilenceSettings()).toEqual({
      thresholdDb: DEFAULT_SILENCE_CONFIG.thresholdDb,
      minSilenceSec: 1.5,
      edgePaddingSec: 0.3,
    });
  });

  it('returns the value it actually stored, so a clamped write is visible', () => {
    // The renderer adopts this result, which is how a slider that asked for an
    // out-of-range value corrects itself instead of disagreeing with the removal.
    const saved = saveSilenceSettings({ minSilenceSec: 99 });
    expect(saved.minSilenceSec).toBe(SILENCE_LIMITS.minSilenceSec.max);
    expect(loadSilenceSettings().minSilenceSec).toBe(SILENCE_LIMITS.minSilenceSec.max);
  });

  it('keeps the current value when handed an unusable one', () => {
    saveSilenceSettings({ thresholdDb: -48 });
    saveSilenceSettings({ thresholdDb: Number.NaN });

    expect(loadSilenceSettings().thresholdDb).toBe(-48);
  });
});
