/**
 * What the Inspector's silence removal reports back (upstream PR #426).
 *
 * The detector reports the whole asset while a clip shows a trimmed part of it,
 * so a detected span can be found and still produce no cut. That gap used to be
 * reported as "No silence found" — a false statement about the user's own
 * media. The store is where the mapping report is available, so these tests
 * pin the numbers the Inspector turns into a notice: how many spans became a
 * cut, and how many were found and left in place (by reason).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTimelineStore } from './timeline';
import { createEmptyProject, type Clip } from '../../shared/types/project';

const detectSilence = vi.hoisted(() => vi.fn());

function audioClip(overrides: Partial<Clip>): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    type: 'audio',
    trackId: 'a1',
    startFrame: 0,
    durationFrames: 150,
    inPoint: 150,
    outPoint: 300,
    ...overrides,
  } as Clip;
}

/**
 * One audio clip showing source 5..10s of a 30s asset (trimmed at 5s in).
 * A detected span inside 5..10s maps to a cut; anything else does not.
 */
function seed(clip: Clip = audioClip({})) {
  const project = createEmptyProject();
  project.media = [{
    id: 'asset-1',
    path: 'C:/media/interview.mp3',
    filename: 'interview.mp3',
    type: 'audio',
    duration: 900,
    fileSize: 100,
    addedAt: '2026-08-25T00:00:00.000Z',
  }];
  project.timeline.clips = [clip];
  const controller = useTimelineStore.getState().controller;
  controller.loadProject(project);
  return useTimelineStore;
}

/** Frames left on the anchor track; a cut splits the clip in two. */
function framesOnTrackA1() {
  return useTimelineStore.getState().getClips()
    .filter((clip) => clip.trackId === 'a1')
    .reduce((total, clip) => total + clip.durationFrames, 0);
}

beforeEach(() => {
  detectSilence.mockReset();
  detectSilence.mockResolvedValue({ success: true, ranges: [] });
  vi.stubGlobal('window', { palmier: { media: { detectSilence } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('removeSilenceForClip reporting', () => {
  it('counts spans that became a cut and nothing else', async () => {
    detectSilence.mockResolvedValue({ success: true, ranges: [{ startSec: 6, endSec: 7 }] });
    const store = seed();

    const outcome = await store.getState().removeSilenceForClip('clip-1');

    expect(outcome).toEqual({ removed: 1 });
    // 30 frames cut from a 150-frame clip.
    expect(framesOnTrackA1()).toBe(120);
  });

  it('reports detected silence that lies outside the trim window, not an absence', async () => {
    // Source 1..3s is before this clip's 5s in point.
    detectSilence.mockResolvedValue({ success: true, ranges: [{ startSec: 1, endSec: 3 }] });
    const store = seed();

    const outcome = await store.getState().removeSilenceForClip('clip-1');

    expect(outcome.removed).toBe(0);
    expect(outcome.omitted).toEqual({ 'outside-clip': 1, 'invalid-range': 0 });
    // Non-fatal: an omission is a notice, so it must not ride the error channel
    // the Inspector shows as a failure.
    expect(outcome.error).toBeUndefined();
    // Nothing cut, nothing moved.
    expect(framesOnTrackA1()).toBe(150);
  });

  it('reports a non-finite span as an invalid range, distinctly from out-of-window', async () => {
    detectSilence.mockResolvedValue({
      success: true,
      ranges: [{ startSec: Number.NaN, endSec: 2 }, { startSec: 20, endSec: 21 }],
    });
    seed();

    const outcome = await useTimelineStore.getState().removeSilenceForClip('clip-1');

    expect(outcome.omitted).toEqual({ 'outside-clip': 1, 'invalid-range': 1 });
  });

  it('reports both numbers when some spans were cut and others were not', async () => {
    detectSilence.mockResolvedValue({
      success: true,
      ranges: [{ startSec: 6, endSec: 7 }, { startSec: 20, endSec: 21 }],
    });
    const store = seed();

    const outcome = await store.getState().removeSilenceForClip('clip-1');

    expect(outcome.removed).toBe(1);
    expect(outcome.omitted).toEqual({ 'outside-clip': 1, 'invalid-range': 0 });
    expect(framesOnTrackA1()).toBe(120);
  });

  it('keeps the plain no-silence result when the detector found nothing', async () => {
    detectSilence.mockResolvedValue({ success: true, ranges: [] });
    seed();

    const outcome = await useTimelineStore.getState().removeSilenceForClip('clip-1');

    expect(outcome).toEqual({ removed: 0, error: 'No silence detected' });
  });

  it('keeps a detector failure on the error channel with no omission claim', async () => {
    detectSilence.mockResolvedValue({ success: false, error: 'FFmpeg exited with 1' });
    seed();

    const outcome = await useTimelineStore.getState().removeSilenceForClip('clip-1');

    expect(outcome).toEqual({ removed: 0, error: 'FFmpeg exited with 1' });
  });
});
