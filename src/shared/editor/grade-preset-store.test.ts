/**
 * Shared named-preset narrowing tests (upstream #157). The persisted store is
 * user-writable, so these cases pin the one contract used by main and renderer.
 */

import { describe, expect, it } from 'vitest';
import {
  GRADE_PRESET_ID_MAX,
  MAX_USER_GRADE_PRESETS,
  applyShotSettings,
  applyGradePresetTo,
  narrowProjectGradePresetLinks,
  normalizeGradePresetCandidate,
  normalizeGradePresetId,
  normalizeGradePresetLabel,
  normalizeShotSettings,
  normalizeUserGradePresets,
  parseGradePresetPropagateMode,
  resolveGradePresetPropagation,
  shotFromClip,
  type GradePresetPropagateMode,
  type ShotSettings,
} from './grade-preset-store';
import { createEmptyProject, type Clip } from '../types/project';
import { EditorController } from './controller';

const SOURCE_CANVAS = { width: 1920, height: 1080 };
const TARGET_CANVAS = { width: 1280, height: 720 };

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    type: 'video',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 30,
    inPoint: 0,
    outPoint: 30,
    x: 0,
    y: 0,
    width: 960,
    height: 540,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 0,
    anchorY: 0,
    volume: 1,
    muted: false,
    ...overrides,
  };
}

describe('shared grade-preset store contract', () => {
  it('narrows hostile grade fields to the valid subset', () => {
    const hostile = {
      brightness: 0.2,
      contrast: 99,
      invertColors: 'yes',
      curves: 'not-a-curve',
      wheels: 42,
      hueCurves: false,
      lut: { path: 123, intensity: 99, kind: '3d', size: 999 },
      blurRadius: 999,
      clarity: { clarity: 99, dehaze: 'hazy' },
      vignette: 'not-an-effect',
      grain: { amount: 99, size: 'tiny' },
      glow: { intensity: 'bright', radius: 999, threshold: 99, warmth: -1 },
    };

    const [preset] = normalizeUserGradePresets([
      { id: 'user-hostile', label: 'Hostile', grade: hostile },
    ]);

    expect(preset).toEqual({ id: 'user-hostile', label: 'Hostile', grade: { brightness: 0.2 } });
  });

  it('rejects invalid labels and normalizes valid ones through the shared path', () => {
    expect(normalizeGradePresetLabel('   ')).toBeNull();
    expect(normalizeGradePresetLabel('x'.repeat(41))).toBeNull();
    expect(normalizeGradePresetLabel('  Golden Hour  ')).toBe('Golden Hour');
    expect(normalizeGradePresetCandidate({ id: 'user-empty', label: 'Empty', grade: {} })).toBeNull();
  });

  it('narrows malformed clip links and keeps unknown valid links inert', () => {
    expect(normalizeGradePresetId('user-safe')).toBe('user-safe');
    expect(normalizeGradePresetId('')).toBeUndefined();
    expect(normalizeGradePresetId(42)).toBeUndefined();
    expect(normalizeGradePresetId('x'.repeat(GRADE_PRESET_ID_MAX + 1))).toBeUndefined();

    const project = createEmptyProject();
    project.timeline.clips = [
      clip({ id: 'bad-number', gradePresetId: 42 as never, brightness: 0.2, x: 12 }),
      clip({ id: 'empty', gradePresetId: '', rotation: 4 }),
      clip({ id: 'too-long', gradePresetId: 'x'.repeat(GRADE_PRESET_ID_MAX + 1), scaleX: 1.4 }),
      clip({ id: 'unknown', gradePresetId: 'user-missing', opacity: 0.6 }),
    ];
    project.timelines = {
      nested: {
        ...project.timeline,
        clips: [clip({ id: 'nested', gradePresetId: 'user-nested' })],
      },
    };

    const narrowed = narrowProjectGradePresetLinks(project);
    expect(narrowed.timeline.clips.map((item) => [item.id, item.gradePresetId])).toEqual([
      ['bad-number', undefined],
      ['empty', undefined],
      ['too-long', undefined],
      ['unknown', 'user-missing'],
    ]);
    expect(narrowed.timelines?.nested.clips[0]?.gradePresetId).toBe('user-nested');
    expect(narrowed.timeline.clips[0]).toMatchObject({ brightness: 0.2, x: 12 });

    const restored = EditorController.deserialize(JSON.stringify(project)).getProject();
    expect(restored.timeline.clips.map((item) => item.gradePresetId)).toEqual([
      undefined,
      undefined,
      undefined,
      'user-missing',
    ]);
    expect(restored.timelines?.nested.clips[0]?.gradePresetId).toBe('user-nested');
  });

  it('applies and clears a preset link in the same controller batch', () => {
    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'asset', path: '/asset.mp4', filename: 'asset.mp4', type: 'video',
      duration: 600, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const clipId = ctrl.addClip({ assetId: 'asset', trackId: 'v1', startFrame: 0, durationFrames: 30 });
    const preset = normalizeUserGradePresets([{
      id: 'user-linked', label: 'Linked', grade: { brightness: 0.2 },
    }])[0];

    applyGradePresetTo(ctrl, [clipId], preset, true);
    expect(ctrl.getClips()[0].gradePresetId).toBe('user-linked');
    const historyAfterLink = ctrl.getLastCommandDescription();
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getLastCommandDescription()).not.toBe(historyAfterLink);

    applyGradePresetTo(ctrl, [clipId], preset, true);
    expect(ctrl.getClips()[0].gradePresetId).toBe('user-linked');
    const linked = { ...ctrl.getClips()[0] };
    applyGradePresetTo(ctrl, [clipId], preset, false);
    expect(ctrl.getClips()[0].gradePresetId).toBeUndefined();
    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getClips()[0]).toEqual(linked);
  });

  it('round-trips normalized static shot fields onto a different canvas', () => {
    const source = clip({
      x: 384,
      y: 216,
      scaleX: 1.5,
      scaleY: 0.75,
      rotation: 30,
      anchorX: 240,
      anchorY: 135,
      opacity: 0.6,
      crop: { left: 0.1, right: 0.05, top: 0.08, bottom: 0.03 },
    });
    const target = clip({
      x: 11,
      y: 22,
      width: 640,
      height: 360,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0,
      anchorY: 0,
      opacity: 1,
      crop: { left: 0.2, right: 0.2, top: 0.2, bottom: 0.2 },
      motionX: [{ frame: 0, value: 7 }],
      motionRot: [{ frame: 0, value: 3 }],
    });

    const shot = shotFromClip(source, SOURCE_CANVAS)!;
    expect(shot).toEqual({
      x: 0.2,
      y: 0.2,
      scaleX: 1.5,
      scaleY: 0.75,
      rotation: 30,
      anchorX: 0.25,
      anchorY: 0.25,
      opacity: 0.6,
      crop: { left: 0.1, right: 0.05, top: 0.08, bottom: 0.03 },
    });

    applyShotSettings(target, shot, TARGET_CANVAS);
    expect(target).toMatchObject({
      x: 256,
      y: 144,
      scaleX: 1.5,
      scaleY: 0.75,
      rotation: 30,
      anchorX: 160,
      anchorY: 90,
      opacity: 0.6,
      crop: { left: 0.1, right: 0.05, top: 0.08, bottom: 0.03 },
    });
    // Motion tracks are intentionally outside the static shot payload.
    expect(target.motionX).toEqual([{ frame: 0, value: 7 }]);
    expect(target.motionRot).toEqual([{ frame: 0, value: 3 }]);
  });

  it('applies only the fields carried by a partial shot payload', () => {
    const target = clip({
      x: 11,
      y: 22,
      scaleX: 2,
      scaleY: 0.5,
      rotation: 0,
      anchorX: 33,
      anchorY: 44,
      opacity: 0.7,
      crop: { left: 0.1, right: 0, top: 0, bottom: 0 },
    });
    const before = { ...target, crop: { ...target.crop! } };

    applyShotSettings(target, { rotation: 45 }, TARGET_CANVAS);

    expect(target.rotation).toBe(45);
    expect(target).toMatchObject({
      x: before.x,
      y: before.y,
      scaleX: before.scaleX,
      scaleY: before.scaleY,
      anchorX: before.anchorX,
      anchorY: before.anchorY,
      opacity: before.opacity,
      crop: before.crop,
    });
  });

  it('drops non-object shots and neutralizes hostile present fields', () => {
    const target = clip({ x: 11, y: 22, scaleX: 2, rotation: 30, opacity: 0.7 });
    const hostile = normalizeShotSettings({
      x: 2,
      y: 'bad',
      scaleX: Number.POSITIVE_INFINITY,
      scaleY: -999,
      rotation: Number.NaN,
      anchorX: {},
      anchorY: null,
      opacity: 2,
      crop: 'not-an-object',
    }) as ShotSettings;

    expect(hostile).toEqual({
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0,
      anchorY: 0,
      opacity: 1,
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
    });
    applyShotSettings(target, hostile, TARGET_CANVAS);
    expect(target).toMatchObject({
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0,
      anchorY: 0,
      opacity: 1,
    });
    expect(target.crop).toBeUndefined();

    const untouched = clip({ x: 7, y: 8, scaleX: 3, rotation: 9 });
    const untouchedBefore = { ...untouched };
    applyShotSettings(untouched, 'not-an-object', TARGET_CANVAS);
    expect(untouched).toEqual(untouchedBefore);
  });

  it('preserves a partial shot sibling while narrowing a stored preset', () => {
    const [preset] = normalizeUserGradePresets([
      { id: 'user-shot', label: 'Shot', grade: { brightness: 0.1 }, shot: { rotation: 15 } },
    ]);
    expect(preset.shot).toEqual({ rotation: 15 });
  });

  it('caps a hand-edited stored list at 50 entries', () => {
    const raw = Array.from({ length: MAX_USER_GRADE_PRESETS + 7 }, (_, index) => ({
      id: `user-${index}`,
      label: `Look ${index}`,
      grade: { brightness: 0.1 },
    }));

    expect(normalizeUserGradePresets(raw)).toHaveLength(MAX_USER_GRADE_PRESETS);
  });
});

/**
 * Opt-in grade-preset propagation.
 *
 * The covered set is the model's own notion of "related", not a new one: the
 * clip's link group (the A/V unit `expandLinkedClipIds` auto-includes) and the
 * tracks that follow sync lock. These cases pin that set, the refusal that
 * keeps a partial apply from ever happening, and the single undo step.
 */
describe('grade preset propagation', () => {
  const gradeable = (candidate: Clip) => candidate.type === 'video' || candidate.type === 'image';

  function harness() {
    const ctrl = new EditorController();
    ctrl.addMedia({
      id: 'av', path: '/av.mp4', filename: 'av.mp4', type: 'video',
      duration: 600, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z', audioCodec: 'aac',
    });
    ctrl.addMedia({
      id: 'still', path: '/still.png', filename: 'still.png', type: 'image',
      duration: 0, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
    });
    // A video asset that carries audio places a real A/V link group: the
    // visual clip and its audio partner share one linkGroupId.
    const videoId = ctrl.addClip({ assetId: 'av', trackId: 'v1', startFrame: 0, durationFrames: 60 });
    const audioId = ctrl.getClips().find((item) => item.id !== videoId)!.id;
    const imageId = ctrl.addClip({ assetId: 'still', trackId: 'v1', startFrame: 200, durationFrames: 60 });
    // Linking the visual clip to a second gradeable clip merges the groups, so
    // the group holds two clips a grade can be written to plus the audio half.
    ctrl.linkClips([videoId, imageId]);
    const stackedId = ctrl.addClip({ assetId: 'still', trackId: ctrl.addTrack('video'), startFrame: 0, durationFrames: 60 });
    const optedOutTrack = ctrl.addTrack('video');
    ctrl.setTrackSyncLocked(optedOutTrack, false);
    const optedOutId = ctrl.addClip({ assetId: 'still', trackId: optedOutTrack, startFrame: 0, durationFrames: 60 });
    return { ctrl, videoId, audioId, imageId, stackedId, optedOutId };
  }

  const cover = (ctrl: EditorController, clipId: string, modes: GradePresetPropagateMode[]) =>
    resolveGradePresetPropagation(ctrl, [clipId], modes, gradeable);

  it('accepts only the two known modes and refuses everything else', () => {
    expect(parseGradePresetPropagateMode('linked')).toEqual({ ok: true, mode: 'linked' });
    expect(parseGradePresetPropagateMode('syncLock')).toEqual({ ok: true, mode: 'syncLock' });

    for (const hostile of ['siblings', 'LinkGroup', '', true, 3, null, undefined]) {
      const parsed = parseGradePresetPropagateMode(hostile);
      expect(parsed.ok).toBe(false);
      // Never "off": the refusal names both modes so the caller can retry.
      expect((parsed as { error: string }).error).toContain("Use 'linked' or 'syncLock'");
    }
  });

  it('resolves to the requested clips alone when no mode is passed', () => {
    const { ctrl, videoId, imageId } = harness();
    const resolved = cover(ctrl, videoId, []);

    expect(resolved).toEqual({ ok: true, cover: { clipIds: [videoId], relatedClipIds: [] } });
    expect(imageId).toBeTruthy();
  });

  it('covers the link group and leaves the audio half of the A/V unit out', () => {
    const { ctrl, videoId, audioId, imageId, stackedId } = harness();
    const resolved = cover(ctrl, videoId, ['linked']);

    expect(resolved).toEqual({
      ok: true,
      // Requested clip first, then the covered relative in timeline order.
      cover: { clipIds: [videoId, imageId], relatedClipIds: [imageId] },
    });
    // The audio partner shares the link group but takes no grade, and the
    // clip on the other track is not linked at all.
    expect(audioId).toBeTruthy();
    expect(stackedId).toBeTruthy();
  });

  it('covers the anchor track and every track that never opted out of sync lock', () => {
    const { ctrl, videoId, audioId, imageId, stackedId, optedOutId } = harness();
    const resolved = cover(ctrl, videoId, ['syncLock']);

    expect(resolved).toEqual({
      ok: true,
      cover: {
        clipIds: [videoId, imageId, stackedId],
        relatedClipIds: [imageId, stackedId],
      },
    });
    // A track that opted out is not related, and audio takes no grade.
    expect(audioId).toBeTruthy();
    expect(optedOutId).toBeTruthy();
  });

  it('refuses the whole call when a covered clip sits on a locked track', () => {
    const { ctrl, videoId, stackedId, optedOutId } = harness();
    const lockedTrack = ctrl.addTrack('video');
    ctrl.setTrackLocked(lockedTrack, true);
    const lockedId = ctrl.addClip({ assetId: 'av', trackId: lockedTrack, startFrame: 0, durationFrames: 60 });
    const before = JSON.stringify(ctrl.getProject());
    const historyBefore = ctrl.getLastCommandDescription();

    const resolved = cover(ctrl, videoId, ['syncLock']);

    expect(resolved).toMatchObject({ ok: false });
    const lockedName = ctrl.getTracks().find((track) => track.id === lockedTrack)!.name;
    expect((resolved as { error: string }).error)
      .toBe(`Cannot propagate to clip ${lockedId}: track "${lockedName}" is locked.`);
    // Nothing was written: the refusal happens before any mutation.
    expect(JSON.stringify(ctrl.getProject())).toBe(before);
    expect(ctrl.getLastCommandDescription()).toBe(historyBefore);
    expect(optedOutId).toBeTruthy();
    expect(stackedId).toBeTruthy();
  });

  it('writes a propagated cover as one undo step and restores every covered clip', () => {
    const { ctrl, videoId, imageId, stackedId } = harness();
    const preset = normalizeUserGradePresets([{ id: 'user-pushed', label: 'Pushed', grade: { brightness: 0.4 } }])[0];
    const before = new Map(ctrl.getClips().map((item) => [item.id, { ...item }]));
    const resolved = cover(ctrl, videoId, ['syncLock']);
    if (!resolved.ok) throw new Error(resolved.error);

    const report = applyGradePresetTo(ctrl, resolved.cover.clipIds, preset, true);

    expect(report.changedClipIds).toEqual([videoId, imageId, stackedId]);
    for (const clipId of resolved.cover.clipIds) {
      expect(ctrl.getClips().find((item) => item.id === clipId)).toMatchObject({
        brightness: 0.4,
        gradePresetId: 'user-pushed',
      });
    }

    // One undo restores every covered clip, not just the first.
    expect(ctrl.undo()).toBe(true);
    for (const item of ctrl.getClips()) {
      expect(item).toEqual(before.get(item.id));
    }
    expect(ctrl.canUndo()).toBe(true); // the setup edits are still on the stack
  });
});
