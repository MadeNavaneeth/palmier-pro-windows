/**
 * Regression coverage for the remove_silence configuration contract
 * (upstream PR #426).
 *
 * The behaviour under test is which settings actually reach the detector:
 * omitted arguments must follow the user's saved controls, and supplied ones
 * must override for that call only. Getting this wrong is invisible in the UI —
 * the Inspector would show one thing while the Agent quietly cut with another.
 *
 * The envelope extractor is mocked because it spawns FFmpeg; the assertion is
 * the config it is handed, not the audio analysis, which is covered by
 * silence-detector.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ detectSilenceForFile: vi.fn() }));
vi.mock('../media/audio-envelope', () => ({
  detectSilenceForFile: mocks.detectSilenceForFile,
}));

import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import {
  loadSilenceSettings,
  saveSilenceSettings,
  resetSilenceSettingsCache,
} from '../media/silence-settings';
import { DEFAULT_SILENCE_CONFIG, SILENCE_LIMITS } from '../../shared/audio/silence-detector';

function harness() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'asset',
    path: 'C:\\media\\interview.mp4',
    filename: 'interview.mp4',
    type: 'video',
    duration: 30,
    fileSize: 100,
    addedAt: '2026-07-29T00:00:00.000Z',
  });
  const clipId = editor.addClip({
    assetId: 'asset',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 300,
  });
  return { editor, clipId: clipId as string, executor: new ToolExecutor(editor) };
}

/** The config the detector was called with. */
function configPassedToDetector() {
  expect(mocks.detectSilenceForFile).toHaveBeenCalledTimes(1);
  return mocks.detectSilenceForFile.mock.calls[0][1];
}

describe('remove_silence settings resolution', () => {
  beforeEach(() => {
    mocks.detectSilenceForFile.mockReset();
    mocks.detectSilenceForFile.mockResolvedValue([]);
    resetSilenceSettingsCache();
  });

  it('uses the saved controls when no settings are supplied', async () => {
    saveSilenceSettings({ thresholdDb: -48, minSilenceSec: 1.5, edgePaddingSec: 0.3 });
    const { executor, clipId } = harness();

    await executor.execute('remove_silence', { clipId });

    expect(configPassedToDetector()).toEqual({
      thresholdDb: -48,
      minSilenceSec: 1.5,
      edgePaddingSec: 0.3,
    });
  });

  it('overrides only the supplied field, for that call only', async () => {
    saveSilenceSettings({ thresholdDb: -48, minSilenceSec: 1.5, edgePaddingSec: 0.3 });
    const { executor, clipId } = harness();

    await executor.execute('remove_silence', { clipId, minSilenceSeconds: 0.5 });

    expect(configPassedToDetector()).toEqual({
      thresholdDb: -48,
      minSilenceSec: 0.5,
      edgePaddingSec: 0.3,
    });
    // The controls the user can see must not have moved.
    expect(loadSilenceSettings().minSilenceSec).toBe(1.5);
  });

  it('refuses an out-of-range override rather than quietly substituting one', async () => {
    const { executor, clipId } = harness();

    const result = await executor.execute('remove_silence', {
      clipId,
      minSilenceSeconds: SILENCE_LIMITS.minSilenceSec.min / 2,
    });

    // The tool schema carries the same bounds as SILENCE_LIMITS, so the refusal
    // happens before any audio is read. Telling the model its value was rejected
    // is more useful than performing a different edit than it asked for.
    expect(result.success).toBe(false);
    expect(mocks.detectSilenceForFile).not.toHaveBeenCalled();
  });

  it('falls back to the defaults when nothing has been saved', async () => {
    const { executor, clipId } = harness();

    await executor.execute('remove_silence', { clipId });

    expect(configPassedToDetector()).toEqual(DEFAULT_SILENCE_CONFIG);
  });

  it('reports a clean result rather than an error when nothing is silent', async () => {
    const { executor, clipId } = harness();

    const result = await executor.execute('remove_silence', { clipId });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ removed: 0 });
  });

  it('refuses a clip whose source media is missing', async () => {
    const { editor, executor } = harness();
    const orphan = editor.addClip({
      assetId: 'gone',
      trackId: 'v1',
      startFrame: 400,
      durationFrames: 60,
    });

    const result = await executor.execute('remove_silence', { clipId: orphan });

    expect(result.success).toBe(false);
    expect(mocks.detectSilenceForFile).not.toHaveBeenCalled();
  });
});
