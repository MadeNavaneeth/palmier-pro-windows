/**
 * Opt-in grade-preset propagation in the Inspector.
 *
 * The rule under test is the one the user decided: propagation is a per-apply
 * choice that must be ticked, never a silent overwrite. So the controls ship
 * unchecked, an unticked apply is exactly the old single-clip apply, a ticked
 * one writes the covered set in a single undo step, and a clip that cannot be
 * written refuses the whole apply instead of leaving the look half applied.
 *
 * Rendered to static markup because the contract is which controls exist and
 * their default state; the write path is exercised through the same exported
 * function the component's picker calls.
 */

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorController } from '../../shared/editor/controller';
import { normalizeUserGradePresets } from '../../shared/editor/grade-preset-store';

// The grade block reads the project canvas and the saved-look list from the
// stores. Stand-ins keep the test's input a clip and a controller.
vi.mock('../store/timeline', () => ({
  useTimelineStore: (selector: (state: unknown) => unknown) => selector({
    project: { settings: { width: 1920, height: 1080, fps: 30 } },
  }),
}));

vi.mock('../store/grade-presets', () => ({
  useGradePresetsStore: (selector: (state: unknown) => unknown) => selector({
    presets: [],
    save: async () => null,
    remove: async () => false,
  }),
}));

const { ColorGradeControls, applyPresetWithPropagation } = await import('./Inspector');

const PRESET = normalizeUserGradePresets([{
  id: 'user-propagated', label: 'Propagated', grade: { brightness: 0.4 },
}])[0];

function harness() {
  const controller = new EditorController();
  controller.addMedia({
    id: 'av', path: 'C:/media/av.mp4', filename: 'av.mp4', type: 'video',
    duration: 600, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z', audioCodec: 'aac',
  });
  controller.addMedia({
    id: 'still', path: 'C:/media/still.png', filename: 'still.png', type: 'image',
    duration: 0, fileSize: 1, addedAt: '2026-01-01T00:00:00.000Z',
  });
  // Audio in the asset places a real A/V link group; linking the still to the
  // visual half gives the group a second clip a grade can be written to.
  const videoId = controller.addClip({ assetId: 'av', trackId: 'v1', startFrame: 0, durationFrames: 60 });
  const audioId = controller.getClips().find((item) => item.id !== videoId)!.id;
  const imageId = controller.addClip({ assetId: 'still', trackId: 'v1', startFrame: 200, durationFrames: 60 });
  controller.linkClips([videoId, imageId]);
  return { controller, videoId, audioId, imageId };
}

const clipState = (controller: EditorController, clipId: string) => ({
  ...controller.getClips().find((item) => item.id === clipId),
});

describe('Inspector grade preset propagation', () => {
  it('ships both propagation controls unchecked', () => {
    const { controller, videoId } = harness();

    const html = renderToStaticMarkup(React.createElement(ColorGradeControls, {
      clipId: videoId,
      clip: controller.getClips().find((item) => item.id === videoId)!,
      controller,
    }));

    expect(html).toContain('data-grade-preset-propagate="linked"');
    expect(html).toContain('data-grade-preset-propagate="syncLock"');
    expect(html).toContain('Also linked clips');
    expect(html).toContain('Also sync-locked tracks');
    // React omits the attribute for an unchecked controlled input, so the
    // absence of `checked` is the default-off proof.
    expect(html).not.toContain('checked');
  });

  it('applies to the one clip when nothing is ticked', () => {
    const { controller, videoId, imageId } = harness();
    const imageBefore = clipState(controller, imageId);

    const result = applyPresetWithPropagation(controller, videoId, PRESET, true, []);

    expect(result).toEqual({ ok: true, clipIds: [videoId] });
    expect(clipState(controller, videoId)).toMatchObject({ brightness: 0.4, gradePresetId: 'user-propagated' });
    expect(clipState(controller, imageId)).toEqual(imageBefore);
  });

  it('pushes to the covered set as one undo step when a relation is ticked', () => {
    const { controller, videoId, imageId, audioId } = harness();
    const audioBefore = clipState(controller, audioId);
    const before = new Map([videoId, imageId, audioId].map((id) => [id, clipState(controller, id)]));

    const result = applyPresetWithPropagation(controller, videoId, PRESET, true, ['linked']);

    expect(result).toEqual({ ok: true, clipIds: [videoId, imageId] });
    for (const clipId of [videoId, imageId]) {
      expect(clipState(controller, clipId)).toMatchObject({ brightness: 0.4 });
    }
    // The audio half of the A/V unit takes no grade.
    expect(clipState(controller, audioId)).toEqual(audioBefore);

    // One undo restores both covered clips.
    expect(controller.undo()).toBe(true);
    for (const [clipId, state] of before) expect(clipState(controller, clipId)).toEqual(state);
  });

  it('refuses the whole apply when a covered clip cannot be written', () => {
    const { controller, videoId, imageId } = harness();
    const lockedTrack = controller.addTrack('video');
    controller.setTrackLocked(lockedTrack, true);
    const lockedId = controller.addClip({ assetId: 'still', trackId: lockedTrack, startFrame: 0, durationFrames: 60 });
    const lockedName = controller.getTracks().find((track) => track.id === lockedTrack)!.name;
    const before = new Map([videoId, imageId, lockedId].map((id) => [id, clipState(controller, id)]));
    const historyBefore = controller.getLastCommandDescription();

    const result = applyPresetWithPropagation(controller, videoId, PRESET, true, ['syncLock']);

    expect(result).toEqual({
      ok: false,
      error: `Cannot propagate to clip ${lockedId}: track "${lockedName}" is locked.`,
    });
    for (const [clipId, state] of before) expect(clipState(controller, clipId)).toEqual(state);
    expect(controller.getLastCommandDescription()).toBe(historyBefore);
  });
});
