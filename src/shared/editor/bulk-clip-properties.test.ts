/**
 * Regression coverage for batched bulk clip property mutations
 * (upstream PR #419). One selection-wide property edit must resolve every clip
 * in one pass, land as one undo step, skip ids it cannot apply to, and leave
 * untouched clips alone.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';

function controllerWithClips(): {
  ctrl: EditorController;
  videoA: string;
  videoB: string;
  videoOnSecondTrack: string;
  audio: string;
} {
  const ctrl = new EditorController();
  ctrl.addMedia({
    id: 'v', path: '/v.mp4', filename: 'v.mp4', type: 'video',
    duration: 600, fileSize: 1, addedAt: new Date().toISOString(),
  });
  ctrl.addMedia({
    id: 'a', path: '/a.mp3', filename: 'a.mp3', type: 'audio',
    duration: 600, fileSize: 1, addedAt: new Date().toISOString(),
  });
  const secondVideoTrack = ctrl.addTrack('video', 'Video 2');

  const videoA = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 30 });
  const videoB = ctrl.addClip({ assetId: 'v', trackId: 'v1', startFrame: 30, durationFrames: 90 });
  const videoOnSecondTrack = ctrl.addClip({
    assetId: 'v', trackId: secondVideoTrack, startFrame: 0, durationFrames: 60,
  });
  const audio = ctrl.addClip({
    assetId: 'a', trackId: 'a1', startFrame: 0, durationFrames: 60, type: 'audio',
  });
  return { ctrl, videoA, videoB, videoOnSecondTrack, audio };
}

function clipById(ctrl: EditorController, id: string) {
  return ctrl.getClips().find((clip) => clip.id === id);
}

describe('bulk clip property mutations', () => {
  it('applies across tracks, skips unknown ids, and undoes as one step', () => {
    const { ctrl, videoA, videoB, videoOnSecondTrack } = controllerWithClips();

    const report = ctrl.setClipsOpacity([videoOnSecondTrack, 'missing', videoA], 0.25);

    expect(report.changedClipIds).toEqual([videoOnSecondTrack, videoA]);
    expect(report.skippedClipIds).toEqual(['missing']);
    expect(clipById(ctrl, videoA)!.opacity).toBe(0.25);
    expect(clipById(ctrl, videoOnSecondTrack)!.opacity).toBe(0.25);
    // A clip outside the request is untouched.
    expect(clipById(ctrl, videoB)!.opacity).toBe(1);

    // One user action is one undo operation, even across tracks.
    expect(ctrl.undo()).toBe(true);
    expect(clipById(ctrl, videoA)!.opacity).toBe(1);
    expect(clipById(ctrl, videoOnSecondTrack)!.opacity).toBe(1);

    // The edit occupied exactly one history entry: the next undo steps past it
    // into the clip that was added before it.
    const clipCount = ctrl.getClips().length;
    ctrl.undo();
    expect(ctrl.getClips().length).toBe(clipCount - 1);
    ctrl.redo();

    ctrl.redo();
    expect(clipById(ctrl, videoA)!.opacity).toBe(0.25);
    expect(clipById(ctrl, videoOnSecondTrack)!.opacity).toBe(0.25);
  });

  it('restores each clip to its own previous value on undo', () => {
    const { ctrl, videoA, videoB } = controllerWithClips();
    ctrl.setClipOpacity(videoA, 0.4);
    ctrl.setClipOpacity(videoB, 0.9);

    ctrl.setClipsOpacity([videoA, videoB], 0.1);
    expect(clipById(ctrl, videoA)!.opacity).toBe(0.1);
    expect(clipById(ctrl, videoB)!.opacity).toBe(0.1);

    ctrl.undo();
    expect(clipById(ctrl, videoA)!.opacity).toBe(0.4);
    expect(clipById(ctrl, videoB)!.opacity).toBe(0.9);
  });

  it('applies a blend mode to visual clips and reports audio clips as skipped', () => {
    const { ctrl, videoA, audio } = controllerWithClips();

    const report = ctrl.setClipsBlendMode([videoA, audio], 'multiply');

    expect(report.changedClipIds).toEqual([videoA]);
    expect(report.skippedClipIds).toEqual([audio]);
    expect(clipById(ctrl, videoA)!.blendMode).toBe('multiply');
    expect(clipById(ctrl, audio)!.blendMode).toBeUndefined();
  });

  it('clears the blend mode property when set to normal in bulk', () => {
    const { ctrl, videoA, videoB } = controllerWithClips();
    ctrl.setClipsBlendMode([videoA, videoB], 'screen');

    ctrl.setClipsBlendMode([videoA, videoB], 'normal');

    expect(clipById(ctrl, videoA)!.blendMode).toBeUndefined();
    expect(clipById(ctrl, videoB)!.blendMode).toBeUndefined();
    ctrl.undo();
    expect(clipById(ctrl, videoA)!.blendMode).toBe('screen');
    expect(clipById(ctrl, videoB)!.blendMode).toBe('screen');
  });

  it('clamps bulk fades to each clip own duration', () => {
    const { ctrl, videoA, videoB } = controllerWithClips();

    // 45 frames exceeds videoA (30 frames) but fits videoB (90 frames).
    ctrl.setClipsFade([videoA, videoB], 45, undefined);

    expect(clipById(ctrl, videoA)!.fadeInFrames).toBe(30);
    expect(clipById(ctrl, videoB)!.fadeInFrames).toBe(45);
    expect(clipById(ctrl, videoA)!.fadeOutFrames).toBeUndefined();

    ctrl.undo();
    expect(clipById(ctrl, videoA)!.fadeInFrames).toBeUndefined();
    expect(clipById(ctrl, videoB)!.fadeInFrames).toBeUndefined();
  });

  it('adds no undo entry when the edit changes nothing', () => {
    const { ctrl, videoA, videoB, audio } = controllerWithClips();
    ctrl.setClipsOpacity([videoA, videoB], 0.5);

    // Re-applying the value already on the clips writes nothing.
    const repeated = ctrl.setClipsOpacity([videoA, videoB], 0.5);
    expect(repeated.changedClipIds).toEqual([]);
    expect(repeated.skippedClipIds).toEqual([]);

    // An all-skipped request is inert too.
    const audioOnly = ctrl.setClipsBlendMode([audio], 'multiply');
    expect(audioOnly.changedClipIds).toEqual([]);
    expect(audioOnly.skippedClipIds).toEqual([audio]);

    // Neither redundant call queued an undo entry, so one undo reaches the
    // state from before the single real edit.
    expect(ctrl.undo()).toBe(true);
    expect(clipById(ctrl, videoA)!.opacity).toBe(1);
    expect(clipById(ctrl, videoB)!.opacity).toBe(1);
  });

  it('keeps clips outside the edit referentially identical', () => {
    const { ctrl, videoA, videoB } = controllerWithClips();
    const before = clipById(ctrl, videoB)!;

    ctrl.setClipsOpacity([videoA], 0.3);

    // Batched replacement passes untouched clips through by reference, so
    // consumers memoized on clip identity do not re-render the whole timeline.
    expect(clipById(ctrl, videoB)).toBe(before);
    expect(clipById(ctrl, videoA)).not.toBe(before);
  });

  it('keeps single-clip setters reporting resolution failures', () => {
    const { ctrl, videoA, audio } = controllerWithClips();

    expect(ctrl.setClipOpacity(videoA, 0.5)).toBe(true);
    expect(ctrl.setClipOpacity('missing', 0.5)).toBe(false);
    expect(ctrl.setClipBlendMode(videoA, 'multiply')).toBe(true);
    expect(ctrl.setClipBlendMode(audio, 'multiply')).toBe(false);
    expect(ctrl.setClipBlendMode('missing', 'multiply')).toBe(false);
    expect(ctrl.setClipFade(videoA, 5, 5)).toBe(true);
    expect(ctrl.setClipFade('missing', 5, 5)).toBe(false);
  });

  it('rejects a non-finite opacity instead of writing NaN', () => {
    const { ctrl, videoA } = controllerWithClips();

    ctrl.setClipsOpacity([videoA], Number.NaN);

    expect(clipById(ctrl, videoA)!.opacity).toBe(1);
  });

  it('supports an arbitrary batched mutator as one undoable edit', () => {
    const { ctrl, videoA, videoB } = controllerWithClips();

    const report = ctrl.applyClipProperties([videoA, videoB], 'Mute clips', (draft) => {
      draft.muted = true;
      draft.volume = 0;
      return true;
    });

    expect(report.changedClipIds).toEqual([videoA, videoB]);
    expect(clipById(ctrl, videoA)!.muted).toBe(true);
    expect(clipById(ctrl, videoB)!.volume).toBe(0);
    ctrl.undo();
    expect(clipById(ctrl, videoA)!.muted).toBe(false);
    expect(clipById(ctrl, videoB)!.volume).toBe(1);
  });
});
