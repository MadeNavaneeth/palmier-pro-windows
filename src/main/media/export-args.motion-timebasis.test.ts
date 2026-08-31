/**
 * Regression coverage for a motion-keyframe export time-basis bug found
 * while investigating title text-size animation.
 *
 * motionRot/motionScaleX/motionScaleY/motionX/motionY are keyed to ABSOLUTE
 * timeline frames (shared/media/motion.ts's own doc comment, and how the
 * Inspector/agent tool read/write them at the playhead). The rotate/scale
 * filter chain in buildFilterGraph runs on `[trimmedLabel]`, which resets
 * local `t` to 0 at the clip's own start via `setpts=PTS-STARTPTS` -- the
 * exact same shape of problem shared/audio/volume-keyframes.ts already
 * solved for the audio `volume` filter (see its `frameAtLocalZero` shift
 * and the comment there). The video-side call sites never applied the
 * equivalent shift: `motionExpression(clip.motionRot, rotSecPerFrame)` used
 * local `t` directly as if it were absolute timeline time.
 *
 * Every pre-existing rotation/scale keyframe test in export-args.test.ts
 * uses `startFrame: 0`, where local t and absolute t coincide, which is why
 * this was never caught. Overlay position (motionX/motionY) has a related
 * but distinct gap: it runs on the un-reset canvas timeline so clip.startFrame
 * is already correct, but a RANGED export rebases clip.startFrame by
 * -range.start without rebasing the stored (absolute, pre-rebase) keyframe
 * frames to match, so the position track would land range.start frames
 * early.
 */
import { describe, it, expect } from 'vitest';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';
import { buildFfmpegArgs } from './export-args';

function projectWithClip(clip: Partial<Clip>): Project {
  const project = createEmptyProject();
  project.media = [{
    id: 'v', path: 'C:/media/v.mp4', filename: 'v.mp4', type: 'video',
    duration: 900, fileSize: 1, addedAt: new Date().toISOString(),
  }];
  const base: Clip = {
    id: 'clip-0', assetId: 'v', type: 'video', trackId: 'v1',
    startFrame: 0, durationFrames: 90, inPoint: 0, outPoint: 90,
    x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
    opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
  };
  project.timeline.clips = [{ ...base, ...clip }];
  return project;
}

function build(project: Project, range?: { start: number; end: number }): string[] {
  return buildFfmpegArgs(
    project,
    { outputPath: 'out.mp4', format: 'mp4', quality: 'normal', ...(range ? { range } : {}) },
    1920, 1080, 30, range ? range.end - range.start : 300, null,
  );
}

describe('motion keyframe export time basis (clip not at frame 0)', () => {
  it('shifts a rotation track so a clip starting mid-timeline rotates on schedule, not delayed by its own start', () => {
    // Absolute frames [90, 120] = seconds [3, 4] on a 30fps timeline. The
    // clip itself starts at frame 90 (3s), so local t=0 in its own reset
    // chain corresponds to absolute t=3s -- the track's first keyframe.
    const project = projectWithClip({
      startFrame: 90,
      durationFrames: 60,
      motionRot: [{ frame: 90, value: 0 }, { frame: 120, value: 90 }],
    });

    const graph = build(project).find((arg) => arg.includes('rotate='))!;
    // Correct: the expression is shifted so local t=0 maps back to
    // absolute 3s, reproducing the stored segment boundaries (3s, 4s).
    expect(graph).toContain('(t)+(3.000000)');
  });

  it('shifts an animated scale track the same way', () => {
    const project = projectWithClip({
      startFrame: 90,
      durationFrames: 60,
      motionScaleX: [{ frame: 90, value: 1 }, { frame: 120, value: 2 }],
    });

    const graph = build(project).find((arg) => arg.includes('scale='))!;
    expect(graph).toContain('(t)+(3.000000)');
  });

  it('needs no shift for a clip already starting at frame 0', () => {
    const project = projectWithClip({
      startFrame: 0,
      durationFrames: 60,
      motionRot: [{ frame: 0, value: 0 }, { frame: 30, value: 90 }],
    });

    const graph = build(project).find((arg) => arg.includes('rotate='))!;
    expect(graph).not.toContain('(t)+(0.000000)');
    expect(graph).toContain('if(lte(t,1.000000)');
  });
});

describe('position motion keyframe export time basis (ranged export)', () => {
  it('shifts the overlay x/y track by the range start so absolute keyframes still land on schedule', () => {
    // Track keyed to absolute frames [300, 330] (10s/11s). Exporting the
    // range starting at frame 150 (5s) rebases clip.startFrame by -150, but
    // the stored keyframe frames are untouched -- the expression must add
    // the 5s range offset back in so local t (which now starts at the
    // range's own zero) still hits the track's true absolute schedule.
    const project = projectWithClip({
      startFrame: 300,
      durationFrames: 60,
      motionX: [{ frame: 300, value: 100 }, { frame: 330, value: 400 }],
    });

    const graph = build(project, { start: 150, end: 600 }).find((arg) => arg.includes('overlay='))!;
    expect(graph).toContain('(t)+(5.000000)');
  });

  it('needs no shift for an unranged export', () => {
    const project = projectWithClip({
      startFrame: 300,
      durationFrames: 60,
      motionX: [{ frame: 300, value: 100 }, { frame: 330, value: 400 }],
    });

    const graph = build(project).find((arg) => arg.includes('overlay='))!;
    expect(graph).not.toMatch(/\(t\)\+\(0\.000000\)/);
  });
});
