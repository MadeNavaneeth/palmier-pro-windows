/**
 * Regression coverage for the trim_clips agent tool — the Windows port of
 * upstream `upstream/trim-clips` 46b297e ("Add trim_clips tool for edge
 * trims with ripple support"). One call trims or extends the edges of one
 * or many clips by absolute project frames as a single undoable action,
 * reusing the shared trimClipEdge domain operation the UI drag uses.
 */

import { describe, expect, it } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { ToolExecutor } from './executor';

function controllerWithAsset(duration = 5000) {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'asset',
    path: 'C:\\media\\clip.mp4',
    filename: 'clip.mp4',
    type: 'video',
    duration,
    fileSize: 100,
    audioCodec: 'aac',
    addedAt: '2026-09-01T00:00:00.000Z',
  });
  return ctrl;
}

function controllerWithLinkedPair() {
  const ctrl = controllerWithAsset();
  ctrl.placeMediaAssets(['asset'], 'v1', 100);
  return ctrl;
}

/** Two independent 30-frame clips back to back on v1, covering [0,60). */
async function executorOnTwoClips(assetDuration = 5000) {
  const ctrl = controllerWithAsset(assetDuration);
  const a = ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 30 });
  const b = ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 30, durationFrames: 30 });
  return { ctrl, executor: new ToolExecutor(ctrl), a, b };
}

describe('trim_clips tool', () => {
  it('trims both edges of one clip to absolute frames and reports success', async () => {
    const { ctrl, executor, a } = await executorOnTwoClips();

    const result = await executor.execute('trim_clips', {
      edits: [{ clipId: a, startFrame: 10, endFrame: 25 }],
    });

    expect(result.success).toBe(true);
    const clip = ctrl.getClips().find((c) => c.id === a)!;
    expect(clip.startFrame).toBe(10);
    expect(clip.startFrame + clip.durationFrames).toBe(25);
  });

  it('extends into source headroom when the media allows it', async () => {
    const { ctrl, executor, a } = await executorOnTwoClips();

    const result = await executor.execute('trim_clips', {
      edits: [{ clipId: a, startFrame: 0, endFrame: 40 }],
    });

    expect(result.success).toBe(true);
    const clip = ctrl.getClips().find((c) => c.id === a)!;
    expect(clip.durationFrames).toBe(40);
    // inPoint moves with the leading edge; outPoint with the trailing edge.
    expect(clip.inPoint).toBe(0);
    expect(clip.outPoint).toBe(40);
  });

  it('clamps an extend past source headroom and notes it in the receipt', async () => {
    // Asset is 35 frames; the clip consumes 30, so exactly 5 frames of
    // headroom exist past the current out-point.
    const { ctrl, executor, a } = await executorOnTwoClips(35);

    const result = await executor.execute('trim_clips', {
      edits: [{ clipId: a, endFrame: 45 }],
    });

    expect(result.success).toBe(true);
    const clip = ctrl.getClips().find((c) => c.id === a)!;
    expect(clip.startFrame + clip.durationFrames).toBe(35);
    const data = result.data as { notes: string[] };
    expect(data.notes.join('\n')).toMatch(/clamped to 5 of the requested 15/);
  });

  it('applies two edits to different clips as ONE undo step', async () => {
    const { ctrl, executor, a, b } = await executorOnTwoClips();
    const aBefore = ctrl.getClips().find((c) => c.id === a)!;

    const result = await executor.execute('trim_clips', {
      edits: [
        { clipId: a, endFrame: 20 },
        { clipId: b, startFrame: 40 },
      ],
    });

    expect(result.success).toBe(true);
    expect(ctrl.getClips().find((c) => c.id === b)!.startFrame).toBe(40);

    // One undo restores BOTH edits.
    await executor.execute('undo', {});
    const aAfter = ctrl.getClips().find((c) => c.id === a)!;
    const bAfter = ctrl.getClips().find((c) => c.id === b)!;
    expect(aAfter.startFrame).toBe(aBefore.startFrame);
    expect(aAfter.durationFrames).toBe(aBefore.durationFrames);
    expect(bAfter.startFrame).toBe(30);
  });

  it('keeps the multi-edit receipt shape unchanged while grouping into one step', async () => {
    const { ctrl, executor, a, b } = await executorOnTwoClips();

    const result = await executor.execute('trim_clips', {
      edits: [
        { clipId: a, endFrame: 20 },
        { clipId: b, startFrame: 40 },
      ],
    });

    expect(result.success).toBe(true);
    expect(Object.keys(result.data as object).sort()).toEqual([
      'notes',
      'removedMarkerIds',
      'shiftedMarkers',
      'touched',
    ]);
    const data = result.data as {
      touched: string[];
      notes: string[];
      shiftedMarkers: unknown[];
      removedMarkerIds: unknown[];
    };
    expect(data.touched).toEqual([a, b]);
    expect(data.notes).toEqual([]);
    expect(data.shiftedMarkers).toEqual([]);
    expect(data.removedMarkerIds).toEqual([]);

    // Two commands, one transaction label — the composite the batch squash
    // used to build.
    expect(ctrl.getLastCommandDescription()).toBe('composite');
  });

  it('keeps a single-edit trim on its own undo entry and label', async () => {
    const { ctrl, executor, a } = await executorOnTwoClips();

    await executor.execute('trim_clips', { edits: [{ clipId: a, endFrame: 20 }] });

    // A transaction must not relabel a single domain operation.
    expect(ctrl.getLastCommandDescription()).toBe('replaceClips');
    expect(ctrl.getClips().find((c) => c.id === a)!.durationFrames).toBe(20);
  });

  it('reports a multi-edit that only lands one command as that command alone', async () => {
    const { ctrl, executor, a, b } = await executorOnTwoClips(35);
    // The asset has only 5 frames of headroom past b's out-point, so a's
    // extend to 45 is a real edit while b's already-satisfied edge is not.
    const result = await executor.execute('trim_clips', {
      edits: [
        { clipId: a, endFrame: 20 },
        { clipId: b, startFrame: 30 },
      ],
    });

    expect(result.success).toBe(true);
    expect(ctrl.getLastCommandDescription()).toBe('replaceClips');
    await executor.execute('undo', {});
    expect(ctrl.getClips().find((c) => c.id === a)!.durationFrames).toBe(30);
  });

  it('refuses the whole call when one edit targets an unknown clip', async () => {
    const { ctrl, executor, a } = await executorOnTwoClips();
    const before = ctrl.getClips();

    const result = await executor.execute('trim_clips', {
      edits: [
        { clipId: a, endFrame: 10 },
        { clipId: 'missing', startFrame: 5 },
      ],
    });

    expect(result.success).toBe(false);
    expect(ctrl.getClips()).toEqual(before);
  });

  it('refuses a resulting duration below one frame without mutating', async () => {
    const { ctrl, executor, a } = await executorOnTwoClips();
    const before = ctrl.getClips();

    const result = await executor.execute('trim_clips', {
      edits: [{ clipId: a, startFrame: 0, endFrame: 0 }],
    });

    expect(result.success).toBe(false);
    expect(ctrl.getClips()).toEqual(before);
  });

  it('rejects an edit with neither frame present (schema + runtime)', async () => {
    const { executor } = await executorOnTwoClips();

    const bad = await executor.execute('trim_clips', { edits: [{ clipId: 'x', typoFrame: 3 }] });
    expect(bad.success).toBe(false); // strict schema rejects unknown keys

    const empty = await executor.execute('trim_clips', { edits: [{ clipId: 'x' }] });
    expect(empty.success).toBe(false);
  });

  it('reports a no-op when every edge already matches and adds no history', async () => {
    const { ctrl, executor, a } = await executorOnTwoClips();
    const undoCountBefore = ctrl.canUndo();

    const result = await executor.execute('trim_clips', {
      edits: [{ clipId: a, startFrame: 0, endFrame: 30 }],
    });

    expect(result.success).toBe(true);
    const data = result.data as { notes: string[] };
    expect(data.notes.join('\n')).toMatch(/no change/i);
    expect(ctrl.canUndo()).toBe(undoCountBefore);
  });

  it('trims a linked pair together', async () => {
    const ctrl = controllerWithLinkedPair();
    const video = ctrl.getClips().find((c) => c.type === 'video')!;
    const audio = ctrl.getClips().find((c) => c.type === 'audio')!;
    const executor = new ToolExecutor(ctrl);

    const result = await executor.execute('trim_clips', {
      edits: [{ clipId: video.id, endFrame: video.startFrame + 25 }],
    });

    expect(result.success).toBe(true);
    const v = ctrl.getClips().find((c) => c.id === video.id)!;
    const a = ctrl.getClips().find((c) => c.id === audio.id)!;
    expect(v.startFrame + v.durationFrames).toBe(video.startFrame + 25);
    expect(a.startFrame + a.durationFrames).toBe(audio.startFrame + 25);

    // Listing the partner in the SAME call is refused (claimed by the first
    // edit); a later call is free to edit it again.
    const clash = await executor.execute('trim_clips', {
      edits: [
        { clipId: video.id, endFrame: video.startFrame + 25 },
        { clipId: audio.id, startFrame: audio.startFrame + 5 },
      ],
    });
    expect(clash.success).toBe(false);
  });

  it('ripples: trimming one edge shifts downstream clips to keep the timeline closed', async () => {
    const { ctrl, executor, a, b } = await executorOnTwoClips();

    const result = await executor.execute('trim_clips', {
      edits: [{ clipId: a, endFrame: 20 }],
      ripple: true,
    });

    expect(result.success).toBe(true);
    const bAfter = ctrl.getClips().find((c) => c.id === b)!;
    expect(bAfter.startFrame).toBe(20); // pulled left by 10

    await executor.execute('undo', {});
    expect(ctrl.getClips().find((c) => c.id === b)!.startFrame).toBe(30);
  });

  it('overwrites a fully covered neighbor when an edit extends over it', async () => {
    const { ctrl, executor, a, b } = await executorOnTwoClips();

    const result = await executor.execute('trim_clips', {
      edits: [{ clipId: a, endFrame: 60 }], // swallows b entirely ([30,60))
    });

    expect(result.success).toBe(true);
    const bAfter = ctrl.getClips().find((c) => c.id === b);
    // b was fully covered by the extend, matching the upstream ripple=false
    // contract ("extending overwrites whatever the new span overlaps")
    // through the same span-clearing overwrite placement uses.
    expect(bAfter).toBeUndefined();
    const data = result.data as { notes: string[] };
    expect(data.notes.join('\n')).toMatch(/overwrote/);
  });

  it('splits a partially overlapped neighbor, keeping the tail with source mapping', async () => {
    const { ctrl, executor, a, b } = await executorOnTwoClips();

    const result = await executor.execute('trim_clips', {
      edits: [{ clipId: a, endFrame: 40 }], // reaches 10 frames into b
    });

    expect(result.success).toBe(true);
    // b spans timeline [30,60) over source [0,30); clearing [30,40) leaves a
    // tail fragment at [40,60) mapping to source [10,30). b's linked audio
    // partner on a1 is cleared over the same span.
    const vTail = ctrl
      .getClips()
      .filter((c) => c.trackId === 'v1' && c.id !== a)
      .find((c) => c.startFrame === 40)!;
    expect(vTail.startFrame).toBe(40);
    expect(vTail.durationFrames).toBe(20);
    expect(vTail.inPoint).toBe(10);
    expect(vTail.outPoint).toBe(30);
    const audioTail = ctrl
      .getClips()
      .filter((c) => c.trackId === 'a1')
      .find((c) => c.startFrame === 40)!;
    expect(audioTail.startFrame).toBe(40);
    expect(audioTail.durationFrames).toBe(20);
    const data = result.data as { notes: string[] };
    expect(data.notes.join('\n')).toMatch(/trimmed covered parts/);
    void b;
  });

  it('skips an edit whose clip was overwritten by an earlier extend and says so', async () => {
    const { executor, a, b } = await executorOnTwoClips();

    const result = await executor.execute('trim_clips', {
      edits: [
        { clipId: a, endFrame: 60 }, // overwrites b entirely
        { clipId: b, endFrame: 45 },
      ],
    });

    expect(result.success).toBe(true);
    const data = result.data as { notes: string[] };
    expect(data.notes.join('\n')).toMatch(/removed when an earlier edit extended over it/);
  });
});
