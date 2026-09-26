/**
 * Agent/MCP named-preset coverage (upstream #157). The executor receives an
 * injected repository so these tests exercise the real tool path without
 * Electron persistence; production defaults to the app-wide main repository.
 */

import { describe, expect, it } from 'vitest';
import { EditorController } from '../../shared/editor/controller';
import { gradeFromClip } from '../../shared/editor/grade-preset-store';
import type { GradeCurve, GradeWheels, HueCurves } from '../../shared/editor/color-grade';
import { GradePresetRepository, InMemoryGradePresetBackend } from '../grade-preset-repository';
import { ToolExecutor } from './executor';
import { isReadOnlyTool, toolsToJsonSchema } from './tools';

const CURVE: GradeCurve = {
  master: [{ x: 0, y: 0.05 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }],
  red: [],
  green: [{ x: 0, y: 0 }, { x: 0.4, y: 0.5 }, { x: 1, y: 1 }],
  blue: [],
};
const WHEELS: GradeWheels = {
  lift: { x: 0.5, y: -0.5, m: 0.1 },
  gamma: { x: 0, y: 0, m: 1 },
  gain: { x: 0, y: 0, m: 1.2 },
};
const HUE_CURVES: HueCurves = {
  hueVsHue: [],
  hueVsSat: [{ x: 0, y: 0.8 }, { x: 0.15, y: 0.5 }],
  hueVsLum: [{ x: 0.3, y: 0.8 }, { x: 0.8, y: 0.3 }],
};
const LUT = { path: 'C:\\luts\\saved.cube', intensity: 0.5, kind: '3d' as const, size: 33 };
const SOURCE_SHOT = {
  x: 960,
  y: 540,
  scaleX: 1.25,
  scaleY: 0.75,
  rotation: 20,
  anchorX: 480,
  anchorY: 270,
  opacity: 0.65,
  crop: { left: 0.1, right: 0.05, top: 0.08, bottom: 0.03 },
};
const DIFFERENT_SHOT = {
  x: 120,
  y: 180,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  anchorX: 0,
  anchorY: 0,
  opacity: 1,
  crop: { left: 0.2, right: 0.2, top: 0.2, bottom: 0.2 },
};
const FULL_GRADE = {
  brightness: 0.31,
  contrast: 1.42,
  saturation: 1.17,
  hueRotation: 37,
  exposure: 1.2,
  temperature: 7200,
  tint: -18,
  vibrance: 0.22,
  highlights: 0.18,
  shadows: -0.24,
  blacks: 0.12,
  whites: -0.16,
  invertColors: true,
  curves: CURVE,
  wheels: WHEELS,
  hueCurves: HUE_CURVES,
  lut: LUT,
  blurRadius: 8,
  vignette: { amount: -0.5, midpoint: 0.5, roundness: 0, feather: 0.5 },
  grain: { amount: 0.5, size: 2 },
  glow: { intensity: 0.5, radius: 6, threshold: 0.3, warmth: 0.25 },
};
const DIFFERENT_GRADE = {
  brightness: -0.64,
  contrast: 2.2,
  saturation: 0.45,
  hueRotation: -120,
  exposure: -2.25,
  temperature: 3100,
  tint: 72,
  vibrance: -0.55,
  highlights: -0.7,
  shadows: 0.65,
  blacks: -0.35,
  whites: 0.58,
  invertColors: false,
  curves: {
    master: [{ x: 0, y: 0.8 }, { x: 1, y: 0.2 }],
    red: [],
    green: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }],
    blue: [],
  },
  wheels: {
    lift: { x: -0.4, y: 0.2, m: -0.2 },
    gamma: { x: 0.3, y: -0.1, m: 1.3 },
    gain: { x: 0.2, y: 0.4, m: 0.8 },
  },
  hueCurves: {
    hueVsHue: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }],
    hueVsSat: [{ x: 0, y: 0.2 }, { x: 1, y: 0.8 }],
    hueVsLum: [{ x: 0, y: 0.9 }, { x: 1, y: 0.1 }],
  },
  lut: { path: 'C:\\luts\\different.cube', intensity: 0.9, kind: '3d' as const, size: 17 },
  blurRadius: 2,
  vignette: { amount: 0.6, midpoint: 0.7, roundness: 0.4, feather: 0.2 },
  grain: { amount: 0.2, size: 3.5 },
  glow: { intensity: 0.3, radius: 4, threshold: 0.8, warmth: 0.1 },
};

function harness() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'asset',
    path: 'C:\\media\\clip.mp4',
    filename: 'clip.mp4',
    type: 'video',
    duration: 5000,
    fileSize: 100,
    addedAt: '2026-09-01T00:00:00.000Z',
  });
  const sourceId = editor.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 100 });
  const targetOne = editor.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 120, durationFrames: 100 });
  const targetTwo = editor.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 240, durationFrames: 100 });
  const backend = new InMemoryGradePresetBackend();
  let nextId = 0;
  const repository = new GradePresetRepository(backend, () => `user-${nextId++}`);
  return {
    editor,
    executor: new ToolExecutor(editor, { gradePresets: repository }),
    repository,
    sourceId,
    targetOne,
    targetTwo,
  };
}

function setGrade(editor: EditorController, clipId: string, grade: Record<string, unknown>): void {
  editor.applyClipProperties([clipId], 'Set test grade', (draft) => {
    Object.assign(draft, grade);
    return true;
  });
}

describe('named grade preset Agent tools (#157)', () => {
  it('lists, saves, renames, and deletes through the shared repository', async () => {
    const { editor, executor, sourceId } = harness();
    setGrade(editor, sourceId, { brightness: 0.2, invertColors: true });

    const saved = await executor.execute('save_grade_preset', { clipId: sourceId, name: '  Saved Look  ' });
    expect(saved.success).toBe(true);
    expect((saved.data as { preset: { shot?: unknown } }).preset.shot).toBeDefined();
    const presetId = (saved.data as { preset: { id: string } }).preset.id;

    const listed = await executor.execute('list_grade_presets', {});
    expect(listed.success).toBe(true);
    expect((listed.data as { presets: Array<{ id: string; label: string }> }).presets).toEqual([
      expect.objectContaining({ id: presetId, label: 'Saved Look' }),
    ]);

    const renamed = await executor.execute('rename_grade_preset', { presetId, name: 'Renamed Look' });
    expect(renamed.success).toBe(true);
    expect((renamed.data as { preset: { label: string } }).preset.label).toBe('Renamed Look');

    const removed = await executor.execute('delete_grade_preset', { presetId });
    expect(removed).toMatchObject({ success: true, data: { changed: true, presets: [] } });
    expect((await executor.execute('list_grade_presets', {})).data).toEqual({ presets: [] });
  });

  it('applies a saved inverted look as one multi-clip undo step and reproduces its snapshot', async () => {
    const { editor, executor, sourceId, targetOne, targetTwo } = harness();
    setGrade(editor, sourceId, FULL_GRADE);
    setGrade(editor, targetOne, DIFFERENT_GRADE);
    setGrade(editor, targetTwo, DIFFERENT_GRADE);
    const sourceBefore = gradeFromClip(editor.getClips().find((clip) => clip.id === sourceId)!);
    const targetOneBefore = gradeFromClip(editor.getClips().find((clip) => clip.id === targetOne)!);
    const targetTwoBefore = gradeFromClip(editor.getClips().find((clip) => clip.id === targetTwo)!);

    const saved = await executor.execute('save_grade_preset', { clipId: sourceId, name: 'Full Look' });
    const presetId = (saved.data as { preset: { id: string } }).preset.id;
    const applied = await executor.execute('apply_grade_preset', {
      presetId,
      clipIds: [targetOne, targetTwo],
    });

    expect(applied).toMatchObject({
      success: true,
      data: { presetId, changedClipIds: [targetOne, targetTwo], skippedClipIds: [] },
    });
    expect(gradeFromClip(editor.getClips().find((clip) => clip.id === targetOne)!)).toEqual(sourceBefore);
    expect(gradeFromClip(editor.getClips().find((clip) => clip.id === targetTwo)!)).toEqual(sourceBefore);
    expect(editor.getClips().find((clip) => clip.id === targetOne)!.invertColors).toBe(true);

    expect(editor.undo()).toBe(true);
    expect(gradeFromClip(editor.getClips().find((clip) => clip.id === targetOne)!)).toEqual(targetOneBefore);
    expect(gradeFromClip(editor.getClips().find((clip) => clip.id === targetTwo)!)).toEqual(targetTwoBefore);
    expect(gradeFromClip(editor.getClips().find((clip) => clip.id === sourceId)!)).toEqual(sourceBefore);
  });

  it('keeps the single-clip target path explicit and undoable', async () => {
    const { editor, executor, sourceId, targetOne } = harness();
    setGrade(editor, sourceId, FULL_GRADE);
    setGrade(editor, targetOne, DIFFERENT_GRADE);
    const targetBefore = { ...editor.getClips().find((clip) => clip.id === targetOne)! };
    const sourceBefore = { ...editor.getClips().find((clip) => clip.id === sourceId)! };

    const saved = await executor.execute('save_grade_preset', { clipId: sourceId, name: 'Single Look' });
    const presetId = (saved.data as { preset: { id: string } }).preset.id;
    const applied = await executor.execute('apply_grade_preset', { presetId, clipId: targetOne });

    expect(applied).toMatchObject({ success: true, data: { clipIds: [targetOne], changedClipIds: [targetOne] } });
    expect(gradeFromClip(editor.getClips().find((clip) => clip.id === targetOne)!)).toEqual(gradeFromClip(sourceBefore));
    expect(editor.getClips().find((clip) => clip.id === sourceId)).toEqual(sourceBefore);

    expect(editor.undo()).toBe(true);
    expect(editor.getClips().find((clip) => clip.id === targetOne)).toEqual(targetBefore);
  });

  it('links by default in the same undo step and supports explicit clearing', async () => {
    const { editor, executor, sourceId, targetOne } = harness();
    setGrade(editor, sourceId, FULL_GRADE);
    const targetBefore = { ...editor.getClips().find((clip) => clip.id === targetOne)! };
    const saved = await executor.execute('save_grade_preset', { clipId: sourceId, name: 'Linked Look' });
    const presetId = (saved.data as { preset: { id: string } }).preset.id;

    const applied = await executor.execute('apply_grade_preset', { presetId, clipId: targetOne });
    expect(applied).toMatchObject({ success: true, data: { linkPreset: true } });
    expect(editor.getClips().find((clip) => clip.id === targetOne)?.gradePresetId).toBe(presetId);
    // One undo must restore both the grade and the link, proving they shared
    // the same controller batch rather than creating two history entries.
    expect(editor.undo()).toBe(true);
    expect(editor.getClips().find((clip) => clip.id === targetOne)).toEqual(targetBefore);

    await executor.execute('apply_grade_preset', { presetId, clipId: targetOne });
    const linkedTarget = { ...editor.getClips().find((clip) => clip.id === targetOne)! };
    const cleared = await executor.execute('apply_grade_preset', {
      presetId,
      clipId: targetOne,
      linkPreset: false,
    });
    expect(cleared).toMatchObject({ success: true, data: { linkPreset: false } });
    expect(editor.getClips().find((clip) => clip.id === targetOne)?.gradePresetId).toBeUndefined();
    expect(editor.undo()).toBe(true);
    expect(editor.getClips().find((clip) => clip.id === targetOne)).toEqual(linkedTarget);
  });

  it('leaves a link stale after a manual grade edit without trying to repair it', async () => {
    const { editor, executor, sourceId, targetOne } = harness();
    setGrade(editor, sourceId, FULL_GRADE);
    const saved = await executor.execute('save_grade_preset', { clipId: sourceId, name: 'Stale Link' });
    const presetId = (saved.data as { preset: { id: string } }).preset.id;
    await executor.execute('apply_grade_preset', { presetId, clipId: targetOne });

    await executor.execute('set_clip_color_grade', { clipId: targetOne, brightness: 0.55 });

    expect(editor.getClips().find((clip) => clip.id === targetOne)?.gradePresetId).toBe(presetId);
  });

  it('replaces an existing clip link when a different preset is applied', async () => {
    const { editor, executor, repository, sourceId, targetOne } = harness();
    setGrade(editor, sourceId, FULL_GRADE);
    const first = await executor.execute('save_grade_preset', { clipId: sourceId, name: 'First Link' });
    const firstId = (first.data as { preset: { id: string } }).preset.id;
    const second = repository.save('Second Link', { contrast: 1.4 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondId = second.preset.id;

    await executor.execute('apply_grade_preset', { presetId: firstId, clipId: targetOne });
    await executor.execute('apply_grade_preset', { presetId: secondId, clipId: targetOne });
    expect(editor.getClips().find((clip) => clip.id === targetOne)?.gradePresetId).toBe(secondId);
  });

  it('leaves links inert and reports references when a preset is deleted', async () => {
    const { editor, executor, sourceId, targetOne } = harness();
    setGrade(editor, sourceId, FULL_GRADE);
    const saved = await executor.execute('save_grade_preset', { clipId: sourceId, name: 'Delete Link' });
    const presetId = (saved.data as { preset: { id: string } }).preset.id;
    await executor.execute('apply_grade_preset', { presetId, clipId: targetOne });
    const projectBeforeDelete = JSON.stringify(editor.getProject());
    const clipBeforeDelete = { ...editor.getClips().find((clip) => clip.id === targetOne)! };

    const deleted = await executor.execute('delete_grade_preset', { presetId });

    expect(deleted).toMatchObject({
      success: true,
      data: { changed: true, referencingClipIds: [targetOne] },
    });
    expect(JSON.stringify(editor.getProject())).toBe(projectBeforeDelete);
    expect(editor.getClips().find((clip) => clip.id === targetOne)).toEqual(clipBeforeDelete);
    const restored = EditorController.deserialize(editor.serialize()).getProject();
    expect(restored.timeline.clips.find((clip) => clip.id === targetOne)?.gradePresetId).toBe(presetId);
  });

  it('saves and applies static shot fields to many clips as one undo step', async () => {
    const { editor, executor, sourceId, targetOne, targetTwo } = harness();
    setGrade(editor, sourceId, { ...FULL_GRADE, ...SOURCE_SHOT });
    setGrade(editor, targetOne, { ...DIFFERENT_SHOT, motionRot: [{ frame: 0, value: 4 }] });
    setGrade(editor, targetTwo, DIFFERENT_SHOT);
    const targetOneBefore = { ...editor.getClips().find((clip) => clip.id === targetOne)! };
    const targetTwoBefore = { ...editor.getClips().find((clip) => clip.id === targetTwo)! };

    const saved = await executor.execute('save_grade_preset', { clipId: sourceId, name: 'Framed Look' });
    expect(saved.success).toBe(true);
    const preset = (saved.data as { preset: { id: string; shot: Record<string, unknown> } }).preset;
    expect(preset.shot).toMatchObject({ x: 0.5, y: 0.5, scaleX: 1.25, scaleY: 0.75, rotation: 20 });

    const applied = await executor.execute('apply_grade_preset', {
      presetId: preset.id,
      clipIds: [targetOne, targetTwo],
    });
    expect(applied).toMatchObject({ success: true, data: { changedClipIds: [targetOne, targetTwo] } });

    const appliedOne = editor.getClips().find((clip) => clip.id === targetOne)!;
    const appliedTwo = editor.getClips().find((clip) => clip.id === targetTwo)!;
    expect(appliedOne).toMatchObject({
      x: 960, y: 540, scaleX: 1.25, scaleY: 0.75, rotation: 20, opacity: 0.65,
    });
    expect(appliedTwo).toMatchObject({
      x: 960, y: 540, scaleX: 1.25, scaleY: 0.75, rotation: 20, opacity: 0.65,
    });
    expect(appliedOne.motionRot).toEqual([{ frame: 0, value: 4 }]);

    expect(editor.undo()).toBe(true);
    expect(editor.getClips().find((clip) => clip.id === targetOne)).toEqual(targetOneBefore);
    expect(editor.getClips().find((clip) => clip.id === targetTwo)).toEqual(targetTwoBefore);
  });

  it('applies a preset to every eligible project clip with one undo step', async () => {
    const { editor, executor, sourceId, targetOne, targetTwo } = harness();
    setGrade(editor, sourceId, { ...FULL_GRADE, ...SOURCE_SHOT });
    setGrade(editor, targetOne, DIFFERENT_SHOT);
    setGrade(editor, targetTwo, DIFFERENT_SHOT);
    const targetOneBefore = { ...editor.getClips().find((clip) => clip.id === targetOne)! };
    const targetTwoBefore = { ...editor.getClips().find((clip) => clip.id === targetTwo)! };

    const saved = await executor.execute('save_grade_preset', { clipId: sourceId, name: 'Project Look' });
    const presetId = (saved.data as { preset: { id: string } }).preset.id;
    const applied = await executor.execute('apply_grade_preset', { presetId, allProjectClips: true });

    expect(applied).toMatchObject({
      success: true,
      data: {
        allProjectClips: true,
        clipIds: [sourceId, targetOne, targetTwo],
        changedClipIds: expect.arrayContaining([sourceId, targetOne, targetTwo]),
        skippedClipIds: [],
      },
    });
    expect(editor.getClips().find((clip) => clip.id === targetOne)).toMatchObject({
      x: 960, y: 540, scaleX: 1.25, scaleY: 0.75, rotation: 20, opacity: 0.65,
    });
    expect(editor.getClips().find((clip) => clip.id === targetTwo)).toMatchObject({
      x: 960, y: 540, scaleX: 1.25, scaleY: 0.75, rotation: 20, opacity: 0.65,
    });

    expect(editor.undo()).toBe(true);
    expect(editor.getClips().find((clip) => clip.id === targetOne)).toEqual(targetOneBefore);
    expect(editor.getClips().find((clip) => clip.id === targetTwo)).toEqual(targetTwoBefore);
  });

  it('refuses an omitted target instead of treating it as all project clips', async () => {
    const { editor, executor, sourceId } = harness();
    setGrade(editor, sourceId, FULL_GRADE);
    const saved = await executor.execute('save_grade_preset', { clipId: sourceId, name: 'Explicit Scope' });
    const presetId = (saved.data as { preset: { id: string } }).preset.id;
    const before = JSON.stringify(editor.getProject());
    const historyBefore = editor.getLastCommandDescription();

    const result = await executor.execute('apply_grade_preset', { presetId });

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain('exactly one of clipId, clipIds, or allProjectClips:true');
    expect(JSON.stringify(editor.getProject())).toBe(before);
    expect(editor.getLastCommandDescription()).toBe(historyBefore);
  });

  it('refuses an all-project call when any project clip is ineligible', async () => {
    const { editor, executor, sourceId } = harness();
    setGrade(editor, sourceId, FULL_GRADE);
    const saved = await executor.execute('save_grade_preset', { clipId: sourceId, name: 'Strict Project Look' });
    const presetId = (saved.data as { preset: { id: string } }).preset.id;
    const audioId = editor.addClip({
      assetId: 'asset', trackId: 'a1', startFrame: 500, durationFrames: 30, type: 'audio',
    });
    const titleId = editor.addClip({
      assetId: 'asset', trackId: 'v1', startFrame: 540, durationFrames: 30, type: 'title',
    });
    const before = JSON.stringify(editor.getProject());
    const historyBefore = editor.getLastCommandDescription();

    const result = await executor.execute('apply_grade_preset', { presetId, allProjectClips: true });

    expect(result).toMatchObject({
      success: false,
      error: 'Color grading applies to video and image clips only.',
    });
    expect(result).not.toHaveProperty('data');
    expect(JSON.stringify(editor.getProject())).toBe(before);
    expect(editor.getLastCommandDescription()).toBe(historyBefore);
    expect(editor.getClips().map((clip) => clip.id)).toEqual(expect.arrayContaining([audioId, titleId]));
  });

  it('refuses an ineligible batch before mutation and adds no history entry', async () => {
    const { editor, executor, sourceId, targetOne } = harness();
    setGrade(editor, sourceId, { ...FULL_GRADE, ...SOURCE_SHOT });
    const saved = await executor.execute('save_grade_preset', { clipId: sourceId, name: 'Eligible Only' });
    const presetId = (saved.data as { preset: { id: string } }).preset.id;
    const audioId = editor.addClip({
      assetId: 'asset', trackId: 'a1', startFrame: 500, durationFrames: 30, type: 'audio',
    });
    const titleId = editor.addClip({
      assetId: 'asset', trackId: 'v1', startFrame: 540, durationFrames: 30, type: 'title',
    });
    setGrade(editor, targetOne, DIFFERENT_GRADE);
    const before = JSON.stringify(editor.getProject());
    const historyBefore = editor.getLastCommandDescription();

    for (const clipId of [audioId, titleId]) {
      const refused = await executor.execute('apply_grade_preset', { presetId, clipIds: [targetOne, clipId] });
      expect(refused).toMatchObject({ success: false });
    }
    expect(JSON.stringify(editor.getProject())).toBe(before);
    expect(editor.getLastCommandDescription()).toBe(historyBefore);
  });

  it('classifies only list_grade_presets as read-only and publishes all five schemas', () => {
    const schemas = toolsToJsonSchema();
    const names = schemas.map((tool) => tool.name);
    for (const name of [
      'list_grade_presets',
      'save_grade_preset',
      'rename_grade_preset',
      'delete_grade_preset',
      'apply_grade_preset',
    ]) expect(names).toContain(name);
    expect(isReadOnlyTool('list_grade_presets')).toBe(true);
    expect(schemas.find((tool) => tool.name === 'apply_grade_preset')?.inputSchema).toMatchObject({
      properties: { linkPreset: { type: 'boolean', optional: true } },
    });
    for (const name of [
      'save_grade_preset',
      'rename_grade_preset',
      'delete_grade_preset',
      'apply_grade_preset',
    ]) expect(isReadOnlyTool(name)).toBe(false);
  });
});

/**
 * Opt-in propagation for `apply_grade_preset`.
 *
 * The covered set is the model's own linkage: the anchor's link group
 * (`expandLinkedClipIds`) and the tracks that follow sync lock. Every case here
 * is about the opt-in being explicit, the apply being one undo step, and a
 * refusal leaving the project exactly as it was.
 */
describe('apply_grade_preset propagation', () => {
  function propagationHarness() {
    const editor = new EditorController();
    editor.addMedia({
      id: 'av', path: 'C:\\media\\av.mp4', filename: 'av.mp4', type: 'video',
      duration: 5000, fileSize: 100, addedAt: '2026-09-01T00:00:00.000Z', audioCodec: 'aac',
    });
    editor.addMedia({
      id: 'still', path: 'C:\\media\\still.png', filename: 'still.png', type: 'image',
      duration: 0, fileSize: 10, addedAt: '2026-09-01T00:00:00.000Z',
    });
    // Audio in the asset makes this a real A/V link group.
    const videoId = editor.addClip({ assetId: 'av', trackId: 'v1', startFrame: 0, durationFrames: 100 });
    const audioId = editor.getClips().find((item) => item.id !== videoId)!.id;
    const imageId = editor.addClip({ assetId: 'still', trackId: 'v1', startFrame: 200, durationFrames: 100 });
    // Two gradeable clips in one group: the visible half of the A/V unit plus
    // a still the user linked to it.
    editor.linkClips([videoId, imageId]);
    const stackedId = editor.addClip({
      assetId: 'still', trackId: editor.addTrack('video'), startFrame: 0, durationFrames: 100,
    });
    const optedOutTrack = editor.addTrack('video');
    editor.setTrackSyncLocked(optedOutTrack, false);
    const optedOutId = editor.addClip({ assetId: 'still', trackId: optedOutTrack, startFrame: 0, durationFrames: 100 });
    const backend = new InMemoryGradePresetBackend();
    const repository = new GradePresetRepository(backend, () => 'user-propagated');
    return {
      editor,
      executor: new ToolExecutor(editor, { gradePresets: repository }),
      presetId: repository.save('Propagated', { brightness: 0.4, invertColors: true }).ok
        ? repository.list()[0]!.id
        : '',
      videoId,
      audioId,
      imageId,
      stackedId,
      optedOutId,
    };
  }

  function snapshot(editor: EditorController, clipIds: string[]): Record<string, unknown> {
    return Object.fromEntries(
      clipIds.map((clipId) => [clipId, { ...editor.getClips().find((item) => item.id === clipId) }]),
    );
  }

  it('touches only the requested clip when the flag is omitted', async () => {
    const { editor, executor, presetId, videoId, imageId, stackedId, audioId } = propagationHarness();
    const before = snapshot(editor, [videoId, imageId, stackedId, audioId]);
    const projectBefore = JSON.stringify(editor.getProject());

    const applied = await executor.execute('apply_grade_preset', { presetId, clipId: videoId });

    expect(applied).toMatchObject({
      success: true,
      data: { clipIds: [videoId], changedClipIds: [videoId], linkPreset: true },
    });
    // No propagate key in the receipt at all, and no other clip moved.
    expect((applied.data as Record<string, unknown>).propagate).toBeUndefined();
    expect(snapshot(editor, [imageId, stackedId, audioId])).toEqual({
      [imageId]: before[imageId],
      [stackedId]: before[stackedId],
      [audioId]: before[audioId],
    });
    expect(editor.getClips().find((item) => item.id === videoId)).not.toEqual(before[videoId]);
    const afterSingle = JSON.stringify(editor.getProject());

    // Byte-identical to the un-propagated apply: re-applying the same preset to
    // the same clip changes nothing and adds no history entry.
    const repeated = await executor.execute('apply_grade_preset', { presetId, clipId: videoId });
    expect(repeated).toMatchObject({ success: true, data: { changed: false, changedClipIds: [] } });
    expect(JSON.stringify(editor.getProject())).toBe(afterSingle);
    expect(projectBefore).not.toBe(afterSingle);
  });

  it('pushes to the whole link group as one undo step', async () => {
    const { editor, executor, presetId, videoId, imageId, audioId } = propagationHarness();
    const before = snapshot(editor, [videoId, imageId, audioId]);

    const applied = await executor.execute('apply_grade_preset', {
      presetId,
      clipId: videoId,
      propagate: 'linked',
    });

    expect(applied).toMatchObject({
      success: true,
      data: {
        propagate: 'linked',
        clipIds: [videoId, imageId],
        relatedClipIds: [imageId],
        changedClipIds: [videoId, imageId],
        skippedClipIds: [],
      },
    });
    for (const clipId of [videoId, imageId]) {
      expect(editor.getClips().find((item) => item.id === clipId)).toMatchObject({
        brightness: 0.4,
        invertColors: true,
        gradePresetId: presetId,
      });
    }
    // The audio half of the A/V unit shares the link group but takes no grade.
    expect(editor.getClips().find((item) => item.id === audioId)).toEqual(before[audioId]);

    expect(editor.undo()).toBe(true);
    expect(snapshot(editor, [videoId, imageId, audioId])).toEqual(before);
  });

  it('pushes across sync-locked tracks as one undo step and leaves opted-out tracks alone', async () => {
    const { editor, executor, presetId, videoId, imageId, stackedId, optedOutId, audioId } = propagationHarness();
    const before = snapshot(editor, [videoId, imageId, stackedId, optedOutId, audioId]);

    const applied = await executor.execute('apply_grade_preset', {
      presetId,
      clipId: videoId,
      propagate: 'syncLock',
    });

    expect(applied).toMatchObject({
      success: true,
      data: {
        propagate: 'syncLock',
        clipIds: [videoId, imageId, stackedId],
        relatedClipIds: [imageId, stackedId],
        changedClipIds: [videoId, imageId, stackedId],
      },
    });
    for (const clipId of [videoId, imageId, stackedId]) {
      expect(editor.getClips().find((item) => item.id === clipId)).toMatchObject({ brightness: 0.4 });
    }
    expect(snapshot(editor, [optedOutId, audioId])).toEqual({
      [optedOutId]: before[optedOutId],
      [audioId]: before[audioId],
    });

    // One undo restores every covered clip, not just the first.
    expect(editor.undo()).toBe(true);
    expect(snapshot(editor, [videoId, imageId, stackedId, optedOutId, audioId])).toEqual(before);
  });

  it('refuses the whole call when a covered clip cannot be written', async () => {
    const { editor, executor, presetId, videoId, imageId, stackedId } = propagationHarness();
    const lockedTrack = editor.addTrack('video');
    editor.setTrackLocked(lockedTrack, true);
    const lockedId = editor.addClip({ assetId: 'still', trackId: lockedTrack, startFrame: 0, durationFrames: 100 });
    const lockedName = editor.getTracks().find((track) => track.id === lockedTrack)!.name;
    const all = [videoId, imageId, stackedId, lockedId];
    const before = snapshot(editor, all);
    const projectBefore = JSON.stringify(editor.getProject());
    const historyBefore = editor.getLastCommandDescription();

    const applied = await executor.execute('apply_grade_preset', {
      presetId,
      clipId: videoId,
      propagate: 'syncLock',
    });

    expect(applied).toMatchObject({
      success: false,
      error: `Cannot propagate to clip ${lockedId}: track "${lockedName}" is locked.`,
    });
    expect(applied).not.toHaveProperty('data');
    // Zero clips modified, no history entry: no half-applied look.
    expect(snapshot(editor, all)).toEqual(before);
    expect(JSON.stringify(editor.getProject())).toBe(projectBefore);
    expect(editor.getLastCommandDescription()).toBe(historyBefore);
  });

  it('refuses an unknown propagate mode instead of treating it as off', async () => {
    const { editor, executor, presetId, videoId, imageId } = propagationHarness();
    const before = snapshot(editor, [videoId, imageId]);
    const projectBefore = JSON.stringify(editor.getProject());

    for (const propagate of ['siblings', 'LinkGroup', '', true, 3]) {
      const refused = await executor.execute('apply_grade_preset', { presetId, clipId: videoId, propagate });
      expect(refused).toMatchObject({ success: false });
      expect(refused).not.toHaveProperty('data');
      // Precise: the refusal names both accepted modes instead of quietly
      // degrading to a single-clip apply.
      const error = (refused as { error: string }).error;
      expect(error).toContain('linked');
      expect(error).toContain('syncLock');
      expect(snapshot(editor, [videoId, imageId])).toEqual(before);
      expect(JSON.stringify(editor.getProject())).toBe(projectBefore);
    }
  });

  it('still refuses an ineligible requested clip before anything is written', async () => {
    const { editor, executor, presetId, videoId, audioId, imageId } = propagationHarness();
    const before = snapshot(editor, [videoId, imageId, audioId]);

    // The opt-in does not soften the existing eligibility rule for the clips
    // the caller asked for by name.
    const refused = await executor.execute('apply_grade_preset', {
      presetId,
      clipId: audioId,
      propagate: 'linked',
    });

    expect(refused).toMatchObject({
      success: false,
      error: 'Color grading applies to video and image clips only.',
    });
    expect(snapshot(editor, [videoId, imageId, audioId])).toEqual(before);
  });

  it('publishes the propagate enum in the tool schema', () => {
    const schema = toolsToJsonSchema().find((tool) => tool.name === 'apply_grade_preset');
    expect(schema?.inputSchema).toMatchObject({
      properties: { propagate: { type: 'string', optional: true, enum: ['linked', 'syncLock'] } },
    });
  });
});
