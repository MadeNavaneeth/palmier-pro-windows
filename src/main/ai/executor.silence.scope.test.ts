/**
 * Behavioral coverage for the remove_silence scope modes (upstream PR #426's
 * `clipIds` contract): scoped edits cut through the ripple engine in one
 * undoable transaction, whole-timeline sweeps go track by track with partial
 * refusals surfaced as notes, and detection is cached per source path. The
 * envelope extractor is mocked (it spawns FFmpeg); the assertions are the
 * resulting project state and receipts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ detectSilenceForFile: vi.fn() }));
vi.mock('../media/audio-envelope', () => ({
  detectSilenceForFile: mocks.detectSilenceForFile,
}));

import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import { resetSilenceSettingsCache } from '../media/silence-settings';

function addMedia(
  editor: EditorController,
  id: string,
  path: string,
  type: 'audio' | 'video',
  audioCodec?: string,
) {
  editor.addMedia({
    id,
    path,
    filename: path.split(/[\\/]/).pop()!,
    type,
    ...(audioCodec ? { audioCodec } : {}),
    duration: 20,
    fileSize: 100,
    addedAt: '2026-08-25T00:00:00.000Z',
  });
}

/** Default silence map: 2-4s of A, 0-1s of B, 1-2s of C and P. */
function defaultSilence() {
  mocks.detectSilenceForFile.mockImplementation(async (path: string) => {
    if (path.endsWith('a.mp3')) return [{ startSec: 2, endSec: 4 }];
    if (path.endsWith('b.mp3')) return [{ startSec: 0, endSec: 1 }];
    if (path.endsWith('c.mp3')) return [{ startSec: 1, endSec: 2 }];
    if (path.endsWith('part.mp3')) return [{ startSec: 1, endSec: 2 }];
    return [];
  });
}

/** Two audio clips back to back on a1 at 30fps. */
function twoClipHarness(editor: EditorController = new EditorController()) {
  addMedia(editor, 'assetA', 'A:\\a.mp3', 'audio');
  addMedia(editor, 'assetB', 'B:\\b.mp3', 'audio');
  const c1 = editor.addClip({ assetId: 'assetA', trackId: 'a1', startFrame: 0, durationFrames: 300 }) as string;
  const c2 = editor.addClip({ assetId: 'assetB', trackId: 'a1', startFrame: 300, durationFrames: 300 }) as string;
  return { editor, executor: new ToolExecutor(editor), c1, c2 };
}

function clipsOnTrack(editor: EditorController, trackId: string) {
  return editor.getClips()
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.startFrame - b.startFrame);
}

beforeEach(() => {
  mocks.detectSilenceForFile.mockReset();
  defaultSilence();
  resetSilenceSettingsCache();
});

describe('remove_silence scoped mode', () => {
  it('cuts mapped timeline ranges on the anchor track and ripples the rest left', async () => {
    const { editor, executor, c1, c2 } = twoClipHarness();

    const result = await executor.execute('remove_silence', { clipIds: [c1, c2] });

    expect(result.success).toBe(true);
    // 60 frames of silence in clip 1 + 30 in clip 2.
    expect(result.data).toMatchObject({ sectionsRemoved: 2, removedFrames: 90, removed: 2 });
    const clips = clipsOnTrack(editor, 'a1');
    expect(clips).toHaveLength(3); // c1 split into its kept segments + c2's kept tail
    expect(clips[0]).toMatchObject({ id: c1, startFrame: 0, durationFrames: 60 });
    expect(clips[1]).toMatchObject({ startFrame: 60, durationFrames: 180 });
    expect(clips[2]).toMatchObject({ id: c2, startFrame: 240, durationFrames: 270 });
  });

  it('is one undoable step for the whole selection', async () => {
    const { editor, executor, c1, c2 } = twoClipHarness();
    await executor.execute('remove_silence', { clipIds: [c1, c2] });

    expect(editor.undo()).toBe(true);
    const clips = clipsOnTrack(editor, 'a1');
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ id: c1, startFrame: 0, durationFrames: 300 });
  });

  it('detects once per distinct source path, not per clip', async () => {
    const { editor, executor } = twoClipHarness();
    editor.addClip({ assetId: 'assetA', trackId: 'a1', startFrame: 600, durationFrames: 120 });

    await executor.execute('remove_silence', { clipIds: clipsOnTrack(editor, 'a1').map((c) => c.id) });

    // Three clips share two assets; only two files are analyzed.
    expect(mocks.detectSilenceForFile).toHaveBeenCalledTimes(2);
  });

  it('lets a linked video partner ride the cut on its own track', async () => {
    const editor = new EditorController();
    addMedia(editor, 'vid', 'C:\\v.mp4', 'video');
    addMedia(editor, 'aud', 'D:\\part.mp3', 'audio');
    const v = editor.addClip({ assetId: 'vid', trackId: 'v1', startFrame: 0, durationFrames: 300 }) as string;
    const a = editor.addClip({ assetId: 'aud', trackId: 'a1', startFrame: 0, durationFrames: 300 }) as string;
    editor.linkClips([v, a]);
    const executor = new ToolExecutor(editor);

    const result = await executor.execute('remove_silence', { clipIds: [v, a] });

    expect(result.success).toBe(true);
    // Detection came from the audio side only (frames 30..60); the linked
    // video was cut identically and rippled left with it.
    const video = clipsOnTrack(editor, 'v1');
    expect(video).toHaveLength(2);
    expect(video[0]).toMatchObject({ id: v, startFrame: 0, durationFrames: 30 });
    expect(video[1]).toMatchObject({ startFrame: 30, durationFrames: 240 });
  });

  it('routes the legacy clipId form through the linked ripple transaction', async () => {
    const editor = new EditorController();
    addMedia(editor, 'linked', 'G:\\linked.mp4', 'video', 'aac');
    const video = editor.addClip({
      assetId: 'linked', trackId: 'v1', startFrame: 0, durationFrames: 300,
    }) as string;
    mocks.detectSilenceForFile.mockResolvedValue([{ startSec: 1, endSec: 2 }]);

    const result = await new ToolExecutor(editor).execute('remove_silence', { clipId: video });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ removed: 1 });
    expect(clipsOnTrack(editor, 'v1').map((clip) => [
      clip.startFrame, clip.startFrame + clip.durationFrames,
    ])).toEqual([[0, 30], [30, 270]]);
    expect(clipsOnTrack(editor, 'a1').map((clip) => [
      clip.startFrame, clip.startFrame + clip.durationFrames,
    ])).toEqual([[0, 30], [30, 270]]);
  });

  it('refuses before editing when an audio target source is missing', async () => {
    // Model a file that vanished after import: the clip persists but the
    // media entry is gone from the index the executor resolves against.
    class VanishedMediaEditor extends EditorController {
      override getMedia() {
        return super.getMedia().filter((asset) => asset.id !== 'assetB');
      }
    }
    const { c1, c2, editor: vanished } = twoClipHarness(new VanishedMediaEditor());
    const executor = new ToolExecutor(vanished);
    const before = JSON.stringify(vanished.getProject());

    const result = await executor.execute('remove_silence', { clipIds: [c1, c2] });

    expect(result.success).toBe(false);
    expect(result.error).toContain(c2);
    expect(JSON.stringify(vanished.getProject())).toBe(before);
  });

  it('surfaces upstream refusals verbatim and rejects ambiguous arguments', async () => {
    const { executor, c1 } = twoClipHarness();

    expect((await executor.execute('remove_silence', { clipId: c1, clipIds: [c1] })).error)
      .toBe('Pass either clipId or clipIds, not both.');
    expect((await executor.execute('remove_silence', { clipIds: ['ghost'] })).error)
      .toBe('remove_silence: Clip not found: ghost');

    const imageOnly = new EditorController();
    addMedia(imageOnly, 'img', 'E:\\i.png', 'video');
    const img = imageOnly.addClip({ assetId: 'img', trackId: 'v1', startFrame: 0, durationFrames: 60 }) as string;
    expect((await new ToolExecutor(imageOnly).execute('remove_silence', { clipIds: [img] })).error)
      .toBe('remove_silence: Selected clips must include at least one audio clip.');
  });

  it('reports cleanly when the selection holds no dead air', async () => {
    const { executor, c1, c2 } = twoClipHarness();
    mocks.detectSilenceForFile.mockResolvedValue([]);

    const result = await executor.execute('remove_silence', { clipIds: [c1, c2] });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ removed: 0, message: expect.stringContaining('No dead air in the selected clips') });
  });
});

describe('remove_silence timeline mode', () => {
  function secondAudioHarness() {
    const h = twoClipHarness();
    const secondAudioId = h.editor.addTrack('audio') as string;
    addMedia(h.editor, 'assetC', 'F:\\c.mp3', 'audio');
    h.editor.addClip({ assetId: 'assetC', trackId: secondAudioId, startFrame: 0, durationFrames: 150 });
    return { ...h, secondAudioId };
  }

  function laterAudioHarness(startFrame = 360) {
    const h = twoClipHarness();
    const secondAudioId = h.editor.addTrack('audio') as string;
    addMedia(h.editor, 'assetC', 'F:\\c.mp3', 'audio');
    const secondClip = h.editor.addClip({
      assetId: 'assetC', trackId: secondAudioId, startFrame, durationFrames: 150,
    }) as string;
    return { ...h, secondAudioId, secondClip };
  }

  it('sweeps every audio track in order with no arguments', async () => {
    const { executor } = secondAudioHarness();

    const result = await executor.execute('remove_silence', {});

    expect(result.success).toBe(true);
    // a1 contributes 90 frames across two merged sections; track 2 adds 30.
    expect(result.data).toMatchObject({ sectionsRemoved: 3, removedFrames: 120 });
    expect(mocks.detectSilenceForFile).toHaveBeenCalledTimes(3); // one per distinct source path
  });

  it('analyzes one source once when it is used on multiple tracks', async () => {
    const h = twoClipHarness();
    const secondAudioId = h.editor.addTrack('audio') as string;
    h.editor.addClip({ assetId: 'assetA', trackId: secondAudioId, startFrame: 600, durationFrames: 120 });

    const result = await h.executor.execute('remove_silence', {});

    expect(result.success).toBe(true);
    expect(mocks.detectSilenceForFile).toHaveBeenCalledTimes(2); // A and B
  });

  it('preflights a later missing source before applying any track', async () => {
    class VanishedMediaEditor extends EditorController {
      override getMedia() {
        return super.getMedia().filter((asset) => asset.id !== 'assetC');
      }
    }
    const vanished = new VanishedMediaEditor();
    twoClipHarness(vanished);
    const secondAudioId = vanished.addTrack('audio') as string;
    addMedia(vanished, 'assetC', 'F:\\c.mp3', 'audio');
    const secondClip = vanished.addClip({
      assetId: 'assetC', trackId: secondAudioId, startFrame: 360, durationFrames: 150,
    }) as string;
    const before = JSON.stringify(vanished.getProject());

    const result = await new ToolExecutor(vanished).execute('remove_silence', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain(secondClip);
    expect(JSON.stringify(vanished.getProject())).toBe(before);
  });

  it('uses post-ripple positions for a later sync-locked track', async () => {
    const h = laterAudioHarness();

    const result = await h.executor.execute('remove_silence', {});

    expect(result.success).toBe(true);
    // The first pass removes 30 + 30 frames before the second clip, so its
    // current span is [270, 420). C's 1–2s silence therefore maps to
    // [300, 330), not the stale pre-ripple [390, 420).
    expect(clipsOnTrack(h.editor, h.secondAudioId).map((clip) => [
      clip.startFrame,
      clip.startFrame + clip.durationFrames,
    ])).toEqual([[270, 300], [300, 390]]);
  });

  it('notes a partial sweep when a later anchor track is locked', async () => {
    const { editor, executor, secondAudioId } = secondAudioHarness();
    // A locked track still participating in sync lock would refuse the whole
    // ripple, so decouple it first — the manual lock-then-sweep scenario.
    editor.setTrackSyncLocked(secondAudioId, false);
    editor.setTrackLocked(secondAudioId, true);

    const result = await executor.execute('remove_silence', {});

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      sectionsRemoved: 2,
      removedFrames: 90,
      notes: [expect.stringContaining('Earlier tracks were already edited')],
    });
    // The unlocked first pass really did edit; the locked one did not.
    expect(clipsOnTrack(editor, 'a1')).toHaveLength(3);
  });

  it('refuses outright when the only candidate track is locked', async () => {
    const { editor, executor } = twoClipHarness();
    editor.setTrackLocked('a1', true);

    const result = await executor.execute('remove_silence', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('locked');
  });

  it('reports no dead air when the timeline is clean', async () => {
    const { executor } = twoClipHarness();
    mocks.detectSilenceForFile.mockResolvedValue([]);

    const result = await executor.execute('remove_silence', {});

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ removed: 0, message: expect.stringContaining('No dead air on the timeline') });
  });
});

/**
 * The detector reports the whole asset while a clip shows a trimmed part of it,
 * so a detected span can be found and still meet no part of the clip. It is
 * then omitted rather than clamped (clamping would cut audio the detector
 * never called silent) — but "no dead air" over found silence is a false
 * statement about the user's audio, so the omission is reported in the receipt.
 */
describe('remove_silence omission reporting', () => {
  /** One audio clip whose 10s window is the head of its source. */
  function trimmedHarness() {
    const editor = new EditorController();
    addMedia(editor, 'assetA', 'A:\\long.mp3', 'audio');
    const c1 = editor.addClip({
      assetId: 'assetA', trackId: 'a1', startFrame: 0, durationFrames: 300,
    }) as string;
    return { editor, executor: new ToolExecutor(editor), c1 };
  }

  interface Receipt {
    removed: number;
    ranges?: number;
    sectionsRemoved?: number;
    removedFrames?: number;
    message?: string;
    notes?: string[];
  }

  async function remove(
    executor: ToolExecutor,
    args: Record<string, unknown>,
  ): Promise<Receipt> {
    const result = await executor.execute('remove_silence', args);
    expect(result.success).toBe(true);
    return result.data as Receipt;
  }

  it('notes found silence that lies outside the clip instead of claiming none', async () => {
    const { editor, executor, c1 } = trimmedHarness();
    // Source 20..40s: the detector found two gaps, both past the clip's 10s.
    mocks.detectSilenceForFile.mockResolvedValue([
      { startSec: 20, endSec: 21 },
      { startSec: 30, endSec: 31 },
    ]);

    const data = await remove(executor, { clipIds: [c1] });

    // The "no dead air" line would be false here, so it is replaced by a note.
    expect(data.message).toBeUndefined();
    expect(data.notes?.join(' ')).toMatch(/found 2 silent spans/i);
    expect(data.notes?.join(' ')).toMatch(/outside any clip's trimmed window/);
    // The removed-count fields still parse for a caller that reads numbers.
    expect(data).toMatchObject({ removed: 0, ranges: 0, sectionsRemoved: 0, removedFrames: 0 });
    // And nothing on the timeline moved.
    expect(clipsOnTrack(editor, 'a1')).toHaveLength(1);
  });

  it('reports both numbers when some spans became a cut and others did not', async () => {
    const { executor, c1 } = trimmedHarness();
    mocks.detectSilenceForFile.mockResolvedValue([
      { startSec: 1, endSec: 2 },    // inside -> 30..60
      { startSec: 20, endSec: 21 },   // past the clip
    ]);

    const data = await remove(executor, { clipIds: [c1] });

    expect(data.removed).toBe(1);
    expect(data.notes?.join(' ')).toMatch(/1 detected silent span produced no cut/);
    expect(data.notes?.join(' ')).toMatch(/outside any clip's trimmed window/);
  });

  it('names an invalid timing differently from a span outside the clip', async () => {
    const { executor, c1 } = trimmedHarness();
    mocks.detectSilenceForFile.mockResolvedValue([
      { startSec: Number.NaN, endSec: 2 },
      { startSec: 1, endSec: 2 },
    ]);

    const data = await remove(executor, { clipIds: [c1] });

    expect(data.removed).toBe(1);
    expect(data.notes?.join(' ')).toMatch(/1 detected silent span produced no cut: 1 with invalid timings/);
    expect(data.notes?.join(' ')).not.toMatch(/trimmed window/);
  });

  it('keeps the plain no-dead-air receipt when the detector found nothing', async () => {
    const { executor, c1 } = trimmedHarness();
    mocks.detectSilenceForFile.mockResolvedValue([]);

    const data = await remove(executor, { clipIds: [c1] });

    expect(data.message).toContain('No dead air in the selected clips');
    expect(data.notes).toBeUndefined();
  });

  it('notes the omission on the legacy single-clip form too', async () => {
    const { executor, c1 } = trimmedHarness();
    mocks.detectSilenceForFile.mockResolvedValue([{ startSec: 20, endSec: 21 }]);

    const data = await remove(executor, { clipId: c1 });

    expect(data.removed).toBe(0);
    expect(data.notes?.join(' ')).toMatch(/found 1 silent span/i);
    expect(data.notes?.join(' ')).toMatch(/nothing was removed/);
  });
});
