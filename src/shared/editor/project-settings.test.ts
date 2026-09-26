/**
 * Regression coverage for undoable project-settings changes (upstream PR #417,
 * translating `applyTimelineSettings` and `Timeline.rescaleFrames`).
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { assetDurationSeconds } from '../media/source-time';
import type { Clip, Project } from '../types/project';
import { createEmptyProject } from '../types/project';

function projectWithClips(): Project {
  const project = createEmptyProject('Settings');
  project.media = [
    {
      id: 'v', path: '/v.mp4', filename: 'v.mp4', type: 'video',
      duration: 600, fileSize: 1, addedAt: new Date().toISOString(),
    },
  ];
  project.timeline.clips = [
    {
      id: 'c1', assetId: 'v', type: 'video', trackId: 'v1',
      startFrame: 0, durationFrames: 30, inPoint: 0, outPoint: 30,
      x: 0, y: 0, width: 1920, height: 1080,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, anchorX: 0, anchorY: 0,
      volume: 1, muted: false, fadeInFrames: 10,
    },
    {
      id: 'c2', assetId: 'v', type: 'video', trackId: 'v1',
      startFrame: 30, durationFrames: 30, inPoint: 30, outPoint: 60,
      x: 0, y: 0, width: 1920, height: 1080,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, anchorX: 0, anchorY: 0,
      volume: 1, muted: false,
    },
    // A user-positioned picture-in-picture clip on a second video track.
    {
      id: 'pip', assetId: 'v', type: 'video', trackId: 'v2',
      startFrame: 0, durationFrames: 60, inPoint: 0, outPoint: 60,
      x: 960, y: 540, width: 480, height: 270,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, anchorX: 0, anchorY: 0,
      volume: 1, muted: false,
    },
  ];
  project.timeline.tracks.push({
    id: 'v2', name: 'Video 2', type: 'video', locked: false, visible: true, syncLocked: true, order: 2,
  });
  project.timeline.playheadFrame = 30;
  project.timeline.inFrame = 10;
  project.timeline.outFrame = 50;
  return project;
}

function clip(ctrl: EditorController, id: string) {
  return ctrl.getClips().find((item) => item.id === id)!;
}

describe('project settings', () => {
  it('reports a no-op when nothing changes and adds no undo entry', () => {
    const ctrl = new EditorController(projectWithClips());

    const report = ctrl.applyProjectSettings({ fps: 30, width: 1920, height: 1080 });

    expect(report).toEqual({ fps: 30, width: 1920, height: 1080, changed: [] });
    expect(ctrl.canUndo()).toBe(false);
  });

  it('changes the canvas as one undoable edit', () => {
    const ctrl = new EditorController(projectWithClips());

    const report = ctrl.applyProjectSettings({ width: 1080, height: 1920 });

    expect(report).toEqual({ fps: 30, width: 1080, height: 1920, changed: ['resolution'] });
    expect(ctrl.getProject().settings.width).toBe(1080);
    expect(ctrl.getProject().settings.height).toBe(1920);

    expect(ctrl.undo()).toBe(true);
    expect(ctrl.getProject().settings.width).toBe(1920);
    expect(ctrl.getProject().settings.height).toBe(1080);
    expect(ctrl.canUndo()).toBe(false);

    ctrl.redo();
    expect(ctrl.getProject().settings.height).toBe(1920);
  });

  it('re-fits full-frame clips to the new canvas and keeps placed clips relative', () => {
    const ctrl = new EditorController(projectWithClips());

    ctrl.applyProjectSettings({ width: 1080, height: 1920 });

    // Full-frame clips follow the canvas.
    expect(clip(ctrl, 'c1').width).toBe(1080);
    expect(clip(ctrl, 'c1').height).toBe(1920);
    // The placed clip keeps its relative box: half width, quarter height.
    const pip = clip(ctrl, 'pip');
    expect(pip.width).toBe(270);
    expect(pip.height).toBe(480);
    expect(pip.x).toBe(540);
    expect(pip.y).toBe(960);

    ctrl.undo();
    expect(clip(ctrl, 'pip').x).toBe(960);
    expect(clip(ctrl, 'pip').width).toBe(480);
    expect(clip(ctrl, 'c1').width).toBe(1920);
  });

  it('rescales every frame-valued field when the frame rate changes', () => {
    const ctrl = new EditorController(projectWithClips());

    const report = ctrl.applyProjectSettings({ fps: 60 });

    expect(report).toEqual({ fps: 60, width: 1920, height: 1080, changed: ['fps'] });
    expect(clip(ctrl, 'c1').startFrame).toBe(0);
    expect(clip(ctrl, 'c1').durationFrames).toBe(60);
    expect(clip(ctrl, 'c1').outPoint).toBe(60);
    expect(clip(ctrl, 'c1').fadeInFrames).toBe(20);
    expect(clip(ctrl, 'c2').startFrame).toBe(60);
    expect(clip(ctrl, 'c2').durationFrames).toBe(60);
    expect(ctrl.getPlayhead()).toBe(60);
    expect(ctrl.getTimeline().inFrame).toBe(20);
    expect(ctrl.getTimeline().outFrame).toBe(100);

    ctrl.undo();
    expect(clip(ctrl, 'c1').durationFrames).toBe(30);
    expect(ctrl.getPlayhead()).toBe(30);
    expect(ctrl.getTimeline().inFrame).toBe(10);
  });

  it('rescales media durations in project frames and preserves source length across undo/redo', () => {
    const project = createEmptyProject('Media rescale');
    project.media = [{
      id: 'asset', path: '/asset.mp4', filename: 'asset.mp4', type: 'video',
      duration: 900, fileSize: 1, addedAt: new Date().toISOString(),
    }];
    const ctrl = new EditorController(project);

    ctrl.applyProjectSettings({ fps: 60 });
    const rescaled = ctrl.getMedia()[0]!;
    expect(rescaled.duration).toBe(1800);
    expect(assetDurationSeconds(rescaled, ctrl.getProject().settings.fps)).toBe(30);

    expect(ctrl.undo()).toBe(true);
    const original = ctrl.getMedia()[0]!;
    expect(original.duration).toBe(900);
    expect(assetDurationSeconds(original, ctrl.getProject().settings.fps)).toBe(30);

    ctrl.redo();
    expect(ctrl.getMedia()[0]!.duration).toBe(1800);
    expect(assetDurationSeconds(ctrl.getMedia()[0]!, ctrl.getProject().settings.fps)).toBe(30);
  });

  it('rescales every keyframe track with the project frame-rate ratio', () => {
    const project = createEmptyProject('Keyframe rescale');
    project.media = [{
      id: 'asset', path: '/asset.mp4', filename: 'asset.mp4', type: 'video',
      duration: 900, fileSize: 1, addedAt: new Date().toISOString(),
    }];
    const clip: Clip = {
      id: 'keyframes', assetId: 'asset', type: 'video', trackId: 'v1',
      startFrame: 0, durationFrames: 30, inPoint: 0, outPoint: 30,
      x: 0, y: 0, width: 1920, height: 1080,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, anchorX: 0, anchorY: 0,
      volume: 1, muted: false,
      motionX: [{ frame: 0, value: 0 }, { frame: 15, value: 15 }, { frame: 30, value: 30 }],
      motionY: [{ frame: 0, value: 1 }, { frame: 15, value: 2 }, { frame: 30, value: 3 }],
      motionRot: [{ frame: 0, value: 10 }, { frame: 15, value: 20 }, { frame: 30, value: 30 }],
      motionScaleX: [{ frame: 0, value: 1 }, { frame: 15, value: 1.5 }, { frame: 30, value: 2 }],
      motionScaleY: [{ frame: 0, value: 2 }, { frame: 15, value: 1.5 }, { frame: 30, value: 1 }],
      opacityTrack: [{ frame: 0, value: 0.25 }, { frame: 15, value: 0.5 }, { frame: 30, value: 1 }],
      volumeDb: [{ frame: 0, value: -6 }, { frame: 15, value: 0 }, { frame: 30, value: 6 }],
    };
    project.timeline.clips = [clip];
    const ctrl = new EditorController(project);

    ctrl.applyProjectSettings({ fps: 60 });
    const rescaled = ctrl.getClips()[0]!;
    const frames = (track: readonly { frame: number }[] | undefined): number[] | undefined =>
      track?.map((point) => point.frame);

    expect(frames(rescaled.motionX)).toEqual([0, 30, 60]);
    expect(frames(rescaled.motionY)).toEqual([0, 30, 60]);
    expect(frames(rescaled.motionRot)).toEqual([0, 30, 60]);
    expect(frames(rescaled.motionScaleX)).toEqual([0, 30, 60]);
    expect(frames(rescaled.motionScaleY)).toEqual([0, 30, 60]);
    expect(frames(rescaled.opacityTrack)).toEqual([0, 30, 60]);
    expect(frames(rescaled.volumeDb)).toEqual([0, 30, 60]);
  });

  it('rescales nested timelines and their keyframes too', () => {
    const project = createEmptyProject('Nested keyframe rescale');
    const nestedClip: Clip = {
      id: 'nested-keyframes', assetId: 'asset', type: 'video', trackId: 'v1',
      startFrame: 10, durationFrames: 30, inPoint: 0, outPoint: 30,
      x: 0, y: 0, width: 1920, height: 1080,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, anchorX: 0, anchorY: 0,
      volume: 1, muted: false,
      motionX: [{ frame: 0, value: 0 }, { frame: 15, value: 15 }, { frame: 30, value: 30 }],
      opacityTrack: [{ frame: 0, value: 0 }, { frame: 15, value: 0.5 }, { frame: 30, value: 1 }],
      volumeDb: [{ frame: 0, value: -12 }, { frame: 15, value: 0 }, { frame: 30, value: 12 }],
    };
    project.media = [{
      id: 'asset', path: '/asset.mp4', filename: 'asset.mp4', type: 'video',
      duration: 900, fileSize: 1, addedAt: new Date().toISOString(),
    }];
    project.timelines = {
      nested: {
        tracks: [...project.timeline.tracks],
        clips: [nestedClip],
        playheadFrame: 7,
      },
    };
    const ctrl = new EditorController(project);

    ctrl.applyProjectSettings({ fps: 60 });
    const rescaled = ctrl.getProject().timelines!.nested;
    const rescaledClip = rescaled.clips[0]!;
    const frames = (track: readonly { frame: number }[] | undefined): number[] | undefined =>
      track?.map((point) => point.frame);

    expect(rescaledClip.startFrame).toBe(20);
    expect(rescaledClip.durationFrames).toBe(60);
    expect(rescaled.playheadFrame).toBe(14);
    expect(frames(rescaledClip.motionX)).toEqual([0, 30, 60]);
    expect(frames(rescaledClip.opacityTrack)).toEqual([0, 30, 60]);
    expect(frames(rescaledClip.volumeDb)).toEqual([0, 30, 60]);
  });

  it('keeps clips from overlapping when the rescale rounds', () => {
    const project = createEmptyProject('Rounding');
    project.media = [
      {
        id: 'v', path: '/v.mp4', filename: 'v.mp4', type: 'video',
        duration: 600, fileSize: 1, addedAt: new Date().toISOString(),
      },
    ];
    // Odd boundaries so a 2/3 rescale rounds ambiguously.
    project.timeline.clips = [1, 4, 7].map((start, index) => ({
      id: `c${index}`, assetId: 'v', type: 'video' as const, trackId: 'v1',
      startFrame: start, durationFrames: 3, inPoint: 0, outPoint: 3,
      x: 0, y: 0, width: 1920, height: 1080,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, anchorX: 0, anchorY: 0,
      volume: 1, muted: false,
    }));
    const ctrl = new EditorController(project);

    ctrl.applyProjectSettings({ fps: 20 });

    const ordered = ctrl.getClips().slice().sort((a, b) => a.startFrame - b.startFrame);
    for (let i = 1; i < ordered.length; i += 1) {
      const previousEnd = ordered[i - 1].startFrame + ordered[i - 1].durationFrames;
      expect(ordered[i].startFrame).toBeGreaterThanOrEqual(previousEnd);
      expect(ordered[i].durationFrames).toBeGreaterThanOrEqual(1);
    }
  });

  it('changes frame rate and canvas together in one undo step', () => {
    const ctrl = new EditorController(projectWithClips());

    const report = ctrl.applyProjectSettings({ fps: 60, width: 3840, height: 2160 });

    expect(report!.changed).toEqual(['fps', 'resolution']);
    expect(clip(ctrl, 'c1').durationFrames).toBe(60);
    expect(clip(ctrl, 'c1').width).toBe(3840);

    ctrl.undo();
    expect(ctrl.getProject().settings).toMatchObject({ fps: 30, width: 1920, height: 1080 });
    expect(clip(ctrl, 'c1').durationFrames).toBe(30);
    expect(clip(ctrl, 'c1').width).toBe(1920);
  });

  it('refuses unusable values without touching the project', () => {
    const ctrl = new EditorController(projectWithClips());
    const before = ctrl.getProject();

    expect(ctrl.applyProjectSettings({ fps: 0 })).toBeNull();
    expect(ctrl.applyProjectSettings({ fps: Number.NaN })).toBeNull();
    expect(ctrl.applyProjectSettings({ fps: 100000 })).toBeNull();
    expect(ctrl.applyProjectSettings({ width: 0, height: 1080 })).toBeNull();
    expect(ctrl.applyProjectSettings({ width: 9000, height: 4500 })).toBeNull();

    expect(ctrl.getProject()).toBe(before);
    expect(ctrl.canUndo()).toBe(false);
  });

  it('preserves an oversized legacy canvas across an fps-only change', () => {
    const project = projectWithClips();
    project.settings.width = 9000;
    project.settings.height = 4500;
    const ctrl = new EditorController(project);

    const report = ctrl.applyProjectSettings({ fps: 60 });

    expect(report).toEqual({ fps: 60, width: 9000, height: 4500, changed: ['fps'] });
    expect(ctrl.getProject().settings.width).toBe(9000);
    expect(ctrl.getProject().settings.height).toBe(4500);
  });

  it('survives a serialization round trip', () => {
    const ctrl = new EditorController(projectWithClips());
    ctrl.applyProjectSettings({ width: 2592, height: 1080 });

    const restored = EditorController.deserialize(ctrl.serialize());

    expect(restored.getProject().settings).toMatchObject({ width: 2592, height: 1080 });
  });
});
