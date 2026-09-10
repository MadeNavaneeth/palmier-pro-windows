/**
 * Editing evals (Track 2, L1 — see docs/AGENTIC_ROADMAP.md).
 *
 * Scenario evals with objective assertions, run through the real
 * `ToolExecutor` against a real `EditorController`. No model, no network:
 * the point is to pin what a correct edit run looks like so every agentic
 * layer added on top (verification, plans, compaction) has a baseline that
 * fails when behaviour regresses.
 *
 * Assertions read domain state after the run, never the tool receipt alone —
 * a receipt that says "changed" while the project disagrees is exactly the
 * class of bug these evals exist to catch.
 *
 * Run with `npm run evals` (or `npm test`, which includes this folder).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ToolExecutor } from '../executor';
import { EditorController } from '../../../shared/editor/controller';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-evals-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function harness() {
  const editor = new EditorController();
  const executor = new ToolExecutor(editor);
  return { editor, executor };
}

function addMedia(editor: EditorController, id: string, type: 'video' | 'audio') {
  editor.addMedia({
    id,
    path: id === 'audio' ? `C:/media/${id}.wav` : `C:/media/${id}.mp4`,
    filename: `${id}.${type === 'audio' ? 'wav' : 'mp4'}`,
    type,
    duration: 300,
    width: type === 'video' ? 1920 : undefined,
    height: type === 'video' ? 1080 : undefined,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
}

/** Two back-to-back 30-frame video clips covering [0, 60). */
function twoClipScene() {
  const { editor, executor } = harness();
  addMedia(editor, 'v', 'video');
  const a = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 30 });
  const b = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 30, durationFrames: 30 });
  return { editor, executor, a, b };
}

/**
 * Project JSON with the wall-clock field removed. Undo restores content but
 * stamps `updatedAt` fresh, so exact-state comparisons must ignore it and
 * compare everything else.
 */
function contentJson(editor: EditorController): string {
  return JSON.stringify(editor.getProject()).replace(/"updatedAt":"[^"]*"/, '"updatedAt":"x"');
}

/**
 * Count the undo entries without disturbing state: drain the stack, then
 * redo it back. (A plain drain would leave the project at its oldest state
 * and make later assertions meaningless.)
 */
function undoDepth(editor: EditorController): number {
  let depth = 0;
  while (editor.undo()) depth += 1;
  for (let i = 0; i < depth; i++) editor.redo();
  return depth;
}

describe('evals: editing outcomes', () => {
  it('ripple trim keeps downstream clips closed and is one undo entry', async () => {
    const { editor, executor, a, b } = twoClipScene();
    // Scene setup (addClip) is itself undoable; measure it rather than
    // assuming a zero baseline.
    const baseline = undoDepth(editor);
    const before = JSON.stringify(editor.getProject());

    const result = await executor.execute('trim_clips', {
      edits: [{ clipId: a, endFrame: 40 }],
      ripple: true,
    });

    expect(result.success).toBe(true);
    const clips = editor.getClips();
    expect(clips.find((c) => c.id === b)?.startFrame).toBe(40);
    expect(undoDepth(editor)).toBe(baseline + 1);
    expect(JSON.stringify(editor.getProject())).not.toBe(before);
  });

  it('agent can patch a marker from the ripple receipt without re-reading the timeline', async () => {
    const { executor, a } = twoClipScene();
    await executor.execute('manage_markers', {
      action: 'create',
      name: 'Review',
      startFrame: 50,
      status: 'review',
    });

    const ripple = await executor.execute('ripple_delete_clips', { clipIds: [a] });
    expect(ripple.success).toBe(true);
    const shifted = (ripple.data as { shiftedMarkers: Array<{ id: string; startFrame: number }> })
      .shiftedMarkers;
    expect(shifted).toHaveLength(1);

    // The receipt is enough to address the marker precisely.
    const patched = await executor.execute('manage_markers', {
      action: 'update',
      markerId: shifted[0].id,
      comment: `moved to ${shifted[0].startFrame}`,
    });
    expect(patched.success).toBe(true);

    const timeline = await executor.execute('get_timeline', {});
    const markers = (timeline.data as { markers: Array<{ startFrame: number; comment: string }> }).markers;
    expect(markers[0]).toMatchObject({ startFrame: 20, comment: 'moved to 20' });
  });

  it('grade, EQ, and compressor survive a settings copy to a sibling clip', async () => {
    const { editor, executor, a, b } = twoClipScene();
    addMedia(editor, 'audio', 'audio');
    const audioClip = editor.addClip({ assetId: 'audio', trackId: 'a1', startFrame: 0, durationFrames: 60 });

    await executor.execute('set_clip_color_grade', {
      clipId: a,
      brightness: -0.2,
      saturation: 1.4,
      invertColors: true,
    });
    await executor.execute('copy_clip_settings', { sourceClipId: a, targetClipIds: [b] });
    await executor.execute('set_clip_eq', { clipId: audioClip, lowDb: 6, highDb: -3 });
    await executor.execute('set_clip_compressor', {
      clipId: audioClip,
      thresholdDb: -20,
      ratio: 4,
    });

    expect(editor.getClips().find((c) => c.id === b)).toMatchObject({
      brightness: -0.2,
      saturation: 1.4,
      invertColors: true,
    });
    expect(editor.getClips().find((c) => c.id === audioClip)).toMatchObject({
      eqLowDb: 6,
      eqHighDb: -3,
      compressor: { thresholdDb: -20, ratio: 4 },
    });
  });

  it('a graded, equalized, marked project round-trips through save/open unchanged', async () => {
    const { editor, executor, a } = twoClipScene();
    addMedia(editor, 'audio', 'audio');
    const audioClip = editor.addClip({ assetId: 'audio', trackId: 'a1', startFrame: 0, durationFrames: 60 });
    await executor.execute('set_clip_color_grade', { clipId: a, contrast: 1.3 });
    await executor.execute('set_clip_eq', { clipId: audioClip, midDb: -2 });
    await executor.execute('set_clip_compressor', { clipId: audioClip, ratio: 3 });
    await executor.execute('manage_markers', {
      action: 'create', name: 'Pickup', startFrame: 12, durationFrames: 6, comment: 'retake',
    });
    await executor.execute('set_clip_volume_keyframes', {
      clipId: audioClip,
      points: [{ frame: 0, value: -6 }, { frame: 30, value: -60 }],
    });

    const file = path.join(tmpDir, 'eval.vproj');
    expect((await executor.execute('save_project', { path: file })).success).toBe(true);
    const before = JSON.stringify(editor.getProject());

    const reopened = harness();
    expect((await reopened.executor.execute('open_project', { path: file })).success).toBe(true);
    expect(JSON.stringify(reopened.editor.getProject())).toBe(before);
  });

  it('refused calls leave the project and the undo stack untouched', async () => {
    const { editor, executor, a } = twoClipScene();
    await executor.execute('set_clip_color_grade', { clipId: a, brightness: 0.1 });
    const snapshot = contentJson(editor);
    const depthBefore = undoDepth(editor);

    const refusals = [
      await executor.execute('set_clip_color_grade', { clipId: 'ghost', brightness: 0.1 }),
      await executor.execute('trim_clips', { edits: [{ clipId: a, endFrame: 0 }] }),
      await executor.execute('set_clip_color_grade', { clipId: a, contrast: 99 }),
      await executor.execute('set_clip_eq', { clipId: a, lowDb: 3 }),
      await executor.execute('ripple_delete_clips', { clipIds: [] }),
    ];
    for (const refusal of refusals) expect(refusal.success).toBe(false);

    expect(contentJson(editor)).toBe(snapshot);
    expect(undoDepth(editor)).toBe(depthBefore);
  });

  it('grid layout fills the canvas exactly once per clip', async () => {
    const { editor, executor } = harness();
    addMedia(editor, 'v', 'video');
    const ids = [0, 1, 2, 3].map((index) =>
      editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: index * 100, durationFrames: 60 }));
    const baseline = undoDepth(editor);

    const result = await executor.execute('apply_layout', { clipIds: ids, preset: 'grid_2x2' });
    expect(result.success).toBe(true);

    const cells = editor.getClips().map((clip) => ({
      x: clip.x, y: clip.y, width: clip.width, height: clip.height,
    }));
    expect(cells).toEqual([
      { x: 0, y: 0, width: 960, height: 540 },
      { x: 960, y: 0, width: 960, height: 540 },
      { x: 0, y: 540, width: 960, height: 540 },
      { x: 960, y: 540, width: 960, height: 540 },
    ]);
    // The four placements are one user action.
    expect(undoDepth(editor)).toBe(baseline + 1);
  });

  it('three separate edits undo in reverse to the exact starting state', async () => {
    const { editor, executor, a, b } = twoClipScene();
    const baseline = undoDepth(editor);
    const before = contentJson(editor);

    await executor.execute('trim_clips', { edits: [{ clipId: a, endFrame: 25 }] });
    await executor.execute('set_clip_color_grade', { clipId: b, saturation: 0 });
    await executor.execute('manage_markers', { action: 'create', name: 'M', startFrame: 5 });

    expect(undoDepth(editor)).toBe(baseline + 3);
    for (let i = 0; i < 3; i++) editor.undo();
    expect(contentJson(editor)).toBe(before);
  });
});
