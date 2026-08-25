/**
 * Coverage for the silence-span cache behind the #426 overlay: one detection
 * per path under the saved controls, a confirmed settings change forcing
 * re-detection, and transient failures not being cached.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSilenceSettings: vi.fn(),
  detectSilence: vi.fn(),
}));

import {
  getSilenceSpans,
  resetSilenceSpansCache,
} from './silence-spans-cache';

beforeEach(() => {
  mocks.getSilenceSettings.mockReset();
  mocks.detectSilence.mockReset();
  mocks.detectSilence.mockResolvedValue({ success: true, ranges: [{ startSec: 1, endSec: 2 }] });
  vi.stubGlobal('window', {
    palmier: { media: { getSilenceSettings: mocks.getSilenceSettings, detectSilence: mocks.detectSilence } },
  });
  resetSilenceSpansCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('silence spans cache (#426)', () => {
  it('detects once per path while the saved settings are unchanged', async () => {
    mocks.getSilenceSettings.mockResolvedValue({
      success: true,
      settings: { thresholdDb: -35, minSilenceSec: 0.5, edgePaddingSec: 0.15 },
    });

    const a = getSilenceSpans('/a.mp3');
    const b = getSilenceSpans('/a.mp3');
    expect(a).not.toBeNull();
    await Promise.all([a, b]);

    expect(mocks.detectSilence).toHaveBeenCalledTimes(1);
  });

  it('re-detects under the new controls after the cache is reset', async () => {
    mocks.getSilenceSettings
      .mockResolvedValueOnce({
        success: true,
        settings: { thresholdDb: -35, minSilenceSec: 0.5, edgePaddingSec: 0.15 },
      })
      .mockResolvedValue({
        success: true,
        settings: { thresholdDb: -60, minSilenceSec: 0.5, edgePaddingSec: 0.15 },
      });

    await getSilenceSpans('/a.mp3');
    resetSilenceSpansCache(); // the settings hook calls this on a saved change
    await getSilenceSpans('/a.mp3');

    expect(mocks.detectSilence).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed detection, so a later draw retries', async () => {
    mocks.getSilenceSettings.mockResolvedValue({
      success: true,
      settings: { thresholdDb: -35, minSilenceSec: 0.5, edgePaddingSec: 0.15 },
    });
    mocks.detectSilence
      .mockRejectedValueOnce(new Error('ffmpeg hiccup'))
      .mockResolvedValue({ success: true, ranges: [] });

    await expect(getSilenceSpans('/a.mp3')).resolves.toEqual([]);
    await expect(getSilenceSpans('/a.mp3')).resolves.toEqual([]);

    expect(mocks.detectSilence).toHaveBeenCalledTimes(2);
  });
});
