/**
 * Regression coverage for the export argument builder (upstream PR #546):
 * each unique source path becomes exactly one FFmpeg input, shared by every
 * clip referencing it, with filter-graph and audio-map indices remapped to
 * the consolidated inputs. Previously N clips from one source spawned N full
 * decodes.
 */

import { describe, it, expect } from 'vitest';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';
import { buildFfmpegArgs, videoCodecArgs } from './export-args';

function projectWithMedia(
  media: Array<{ id: string; path: string; type: 'video' | 'audio' | 'image'; duration: number; audioCodec?: string }>,
  clips: Partial<Clip>[],
): Project {
  const project = createEmptyProject();
  project.media = media.map((asset, index) => ({
    id: asset.id,
    path: asset.path,
    filename: `f${index}`,
    type: asset.type,
    duration: asset.duration,
    ...(asset.audioCodec ? { audioCodec: asset.audioCodec } : {}),
    fileSize: 1,
    addedAt: new Date().toISOString(),
  }));
  const base: Clip = {
    id: 'clip',
    assetId: 'a',
    type: 'video',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 100,
    inPoint: 0,
    outPoint: 100,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 0,
    anchorY: 0,
    volume: 1,
    muted: false,
  };
  project.timeline.clips = clips.map((overrides, index) => ({
    ...base,
    id: `clip-${index}`,
    ...overrides,
  }));
  return project;
}

const GEOMETRY = '(geometry)';

describe('videoCodecArgs (R2 hardware encoders)', () => {
  it('software x264 keeps the CRF quality tiers', () => {
    expect(videoCodecArgs('mp4', 'normal', 'x264')).toEqual([
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    ]);
  });

  it('maps hardware encoders to their own rate-control flags', () => {
    expect(videoCodecArgs('mp4', 'high', 'nvenc')).toContain('h264_nvenc');
    expect(videoCodecArgs('mp4', 'draft', 'qsv')).toContain('h264_qsv');
    expect(videoCodecArgs('mp4', 'normal', 'amf')).toContain('h264_amf');
  });

  it('ignores hardware for MOV/WebM and audio formats', () => {
    expect(videoCodecArgs('mov', 'high', 'nvenc')).toContain('prores_ks');
    expect(videoCodecArgs('webm', 'high', 'nvenc')).toContain('libvpx-vp9');
    expect(videoCodecArgs('audio', 'high', 'nvenc')).toEqual([]);
  });

  it('threads hw through buildFfmpegArgs into the video codec args', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v' }],
    );
    const args = buildFfmpegArgs(
      project,
      { outputPath: 'out.mp4', format: 'mp4', quality: 'normal', hw: 'nvenc' },
      1920, 1080, 30, 100, null,
    );
    expect(args).toContain('h264_nvenc');
  });

  // ─── Color grading (R4) ──────────────────────────────────────────────────

  it('emits eq filter for color-graded clips and omits it for ungraded ones', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [
        {
          type: 'video', assetId: 'v', startFrame: 0, durationFrames: 100,
          brightness: -0.15, contrast: 1.3, saturation: 0.6, hueRotation: 45,
        },
      ],
    );
    const graded = build(project).find((arg) => arg.includes('trim='))!;
    expect(graded).toContain('eq=brightness=-0.150000:contrast=1.300000:saturation=0.600000:hue=h=45.0');

    const plain = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v' }],
    );
    const plainArgs = build(plain).find((arg) => arg.includes('trim='))!;
    expect(plainArgs).not.toContain('eq=');
  });

  // ─── Title drawtext (R3) ──────────────────────────────────────────────────

  it('emits escaped, centered, time-gated drawtext for title clips', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [
        { type: 'video', assetId: 'v' },
        {
          type: 'title',
          assetId: '__title__',
          startFrame: 30,
          durationFrames: 60,
          text: "Episode: 'One' 100%\nTake two",
          titleSizeRatio: 0.1,
          titleColor: '#ffcc00',
        },
      ],
    );

    const graph = build(project).find((arg) => arg.includes('drawtext'))!;
    expect(graph).toContain("drawtext=text='Episode\\: \\'One\\' 100\\%\\nTake two'");
    expect(graph).toContain('fontsize=108'); // 0.1 × 1080
    expect(graph).toContain('fontcolor=#ffcc00');
    expect(graph).toContain(':x=(w-text_w)/2:y=(h-text_h)/2');
    expect(graph).toContain("between(t,1.0000,3.0000)");
    // Chain order: composed video feeds the title filter; the map takes the last.
    expect(graph).toContain('[vout]drawtext=');
    expect(graph.match(/\[vt0\]/g)).toHaveLength(1);
  });

  it('omits drawtext entirely when there are no titles (audio-only too)', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 }],
      [{ type: 'audio', assetId: 'a', trackId: 'a1' }],
    );
    const audioArgs = buildFfmpegArgs(
      project,
      { outputPath: 'out.m4a', format: 'audio', quality: 'normal' },
      1920, 1080, 30, 100, null,
    );
    expect(audioArgs.join(' ')).not.toContain('drawtext');
  });
});

function build(project: Project): string[] {
  return buildFfmpegArgs(
    project,
    { outputPath: 'out.mp4', format: 'mp4', quality: 'normal' },
    1920,
    1080,
    30,
    300,
    () => GEOMETRY,
  );
}

describe('buildFfmpegArgs input consolidation (#546)', () => {
  it('uses one input per unique source across video and audio clips', () => {
    const project = projectWithMedia(
      [
        { id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 },
        { id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 },
      ],
      [
        { type: 'video', assetId: 'v', startFrame: 0 },
        { type: 'video', assetId: 'v', startFrame: 150 }, // same source again
        { type: 'audio', assetId: 'a', startFrame: 0 },
      ],
    );

    const args = build(project);
    const inputs = args.filter((arg, index) => args[index - 1] === '-i' && !arg.startsWith('color='));
    expect(inputs).toEqual(['C:/media/v.mp4', 'C:/media/a.mp3']);
  });

  it('keeps the canvas as input 0 and sources from 1 in first-use order', () => {
    const project = projectWithMedia(
      [
        { id: 'v1', path: 'C:/m/one.mp4', type: 'video', duration: 900 },
        { id: 'v2', path: 'C:/m/two.mp4', type: 'video', duration: 900 },
      ],
      [
        { type: 'video', assetId: 'v2', startFrame: 0 },
        { type: 'video', assetId: 'v1', startFrame: 50 },
      ],
    );

    const args = build(project);
    const inputs = args.filter((arg, index) => args[index - 1] === '-i');
    expect(inputs[0]).toContain('color=c=black');
    expect(inputs).toEqual([
      expect.stringContaining('color=c=black'),
      'C:/m/two.mp4', // first-use order follows the sorted clip list
      'C:/m/one.mp4',
    ]);
  });

  it('remaps every filter chain to the consolidated input index', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [
        { type: 'video', assetId: 'v', startFrame: 0 },
        { type: 'video', assetId: 'v', startFrame: 150 },
      ],
    );

    const graph = build(project).find((arg) => arg.includes('trim='))!;
    // Both chains read [1:v] — the single consolidated input.
    expect(graph.match(/\[1:v\]trim=/g)).toHaveLength(2);
    expect(graph).not.toContain('[2:');
  });

  it('builds a timed audio graph: shared input, per-clip trim, delay, volume, amix', () => {
    const project = projectWithMedia(
      [
        { id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 },
        { id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 1800 },
      ],
      [
        { type: 'video', assetId: 'v', startFrame: 0 },
        // Same source twice at different times and levels.
        { type: 'audio', assetId: 'a', startFrame: 90, inPoint: 30, outPoint: 130, volume: 0.5 },
        { type: 'audio', assetId: 'a', startFrame: 300 },
      ],
    );

    const args = build(project);
    const graph = args.find((arg) => arg.includes('atrim'))!;
    // One mixed output instead of raw duplicate stream maps (#546 follow-up).
    expect(args.filter((arg) => arg.endsWith(':a?'))).toEqual([]);
    expect(args).toContain('-map');
    expect(graph).toContain('[aout]');

    // Clip A: source window [1s, 4.3333s) via the shared #68 mapping,
    // delayed to its timeline position (90 frames / 30 fps = 3s), half volume.
    expect(graph).toContain(
      '[2:a]atrim=start=1.0000:end=4.3333,asetpts=PTS-STARTPTS,volume=0.5000,adelay=3000:all=1[a0]',
    );
    // Clip B: default 100-frame source window starting at frame 300 → 10s
    // delay, unity gain.
    expect(graph).toContain('[2:a]atrim=start=0.0000:end=3.3333,asetpts=PTS-STARTPTS,adelay=10000:all=1[a1]');
    expect(graph).toContain('[a0][a1]amix=inputs=2:normalize=0[aout]');
  });

  it('maps a single eligible audio clip directly without amix', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 }],
      [{ type: 'audio', assetId: 'a', startFrame: 60 }],
    );

    const graph = build(project).find((arg) => arg.includes('atrim'))!;
    expect(graph).toContain('adelay=2000:all=1[a0]');
    expect(graph).not.toContain('amix');
    expect(graph).not.toContain('[vout]');
  });

  it('emits no audio graph when every audio clip is muted (#544)', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 }],
      [{ type: 'audio', assetId: 'a', startFrame: 0, muted: true }],
    );

    const args = build(project);
    expect(args.some((arg) => arg.includes('atrim'))).toBe(false);
    expect(args.filter((arg) => arg === '-map')).toHaveLength(1); // video/canvas only
  });

  it('excludes muted audio from inputs and maps (#544)', () => {
    const project = projectWithMedia(
      [
        { id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 },
        { id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 },
      ],
      [
        { type: 'video', assetId: 'v', startFrame: 0 },
        { type: 'audio', assetId: 'a', startFrame: 0, muted: true },
      ],
    );

    const args = build(project);
    expect(args.some((arg) => arg.endsWith(':a?'))).toBe(false);
    const inputs = args.filter((arg, index) => args[index - 1] === '-i');
    expect(inputs).toEqual([expect.stringContaining('color'), 'C:/media/v.mp4']);
  });

  it('falls back to scale+overlay geometry without the native addon', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v', startFrame: 0 }],
    );

    const args = buildFfmpegArgs(
      project,
      { outputPath: 'out.mp4', format: 'mp4', quality: 'normal' },
      1920,
      1080,
      30,
      100,
      null,
    );
    const graph = args.find((arg) => arg.includes('trim='))!;
    expect(graph).toContain('scale=1920:1080');
    expect(graph).not.toContain(GEOMETRY);
  });

  it('terminates with codec settings, duration limit, and output path', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v', startFrame: 0 }],
    );

    const args = build(project);
    expect(args[0]).toBe('-y');
    expect(args[args.length - 1]).toBe('out.mp4');
    const audioCodecAt = args.indexOf('-c:a');
    expect(args.slice(audioCodecAt, audioCodecAt + 4)).toEqual(['-c:a', 'aac', '-b:a', '192k']);
    expect(args).toContain('-t');
  });

  // ─── Range export (R2) ─────────────────────────────────────────────────────

  function buildWithRange(project: Project, start: number, end: number): string[] {
    return buildFfmpegArgs(
      project,
      {
        outputPath: 'out.mp4',
        format: 'mp4',
        quality: 'normal',
        range: { start, end },
      },
      1920,
      1080,
      30,
      end - start,
      () => GEOMETRY,
    );
  }

  it('projects clips into the range: rebased starts and shifted source trims', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 5000 }],
      // Clip spans [100, 300); range [150, 250) trims 50 off each side.
      [
        {
          type: 'video',
          assetId: 'v',
          startFrame: 100,
          durationFrames: 200,
          inPoint: 10,
          outPoint: 210,
        },
      ],
    );

    const graph = buildWithRange(project, 150, 250).find((arg) => arg.includes('trim='))!;
    // Source window shifts by the 50-frame head offset.
    expect(graph).toContain('trim=start=2.0000'); // (10+50)/30fps
    // Overlay enable window is rebased to zero.
    expect(graph).toContain("enable='between(t,0.0000,3.3333)'");
  });

  it('drops clips entirely outside the range', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 5000 }],
      [
        { type: 'video', assetId: 'v', startFrame: 0, durationFrames: 50 },
        { type: 'video', assetId: 'v', startFrame: 450, durationFrames: 50 },
        { type: 'video', assetId: 'v', startFrame: 900, durationFrames: 50 },
      ],
    );

    const args = buildWithRange(project, 400, 600);
    const graph = args.find((arg) => arg.includes('trim='))!;
    // Only the middle clip survives; the canvas is mapped as the base.
    expect(graph.match(/\[1:v\]trim=/g)).toHaveLength(1);
  });

  it('makes audio delays relative to the range start', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 1800 }],
      [{ type: 'audio', assetId: 'a', startFrame: 300 }], // 10s absolute
    );

    const graph = buildWithRange(project, 150, 600).find((arg) => arg.includes('atrim'))!;
    // Absolute delay would be 10s; inside a range starting at 5s → 5s.
    expect(graph).toContain('adelay=5000:all=1');
  });

  it('audio-only exports omit the canvas and every video map', () => {
    const project = projectWithMedia(
      [
        { id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 },
        { id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 },
      ],
      [
        { type: 'video', assetId: 'v', trackId: 'v1' },
        { type: 'audio', assetId: 'a', trackId: 'a1' },
      ],
    );

    const args = buildFfmpegArgs(
      project,
      { outputPath: 'out.m4a', format: 'audio', quality: 'normal' },
      1920,
      1080,
      30,
      100,
      null,
    );
        expect(args.some((arg) => arg.startsWith('color='))).toBe(false);
    expect(args).not.toContain('[vout]');
    expect(args).not.toContain('libx264');
    expect(args.join(' ')).toContain('aac');
    const maps = args.filter((arg, i) => args[i - 1] === '-map');
    expect(maps).toEqual(['[a0]']);
  });

  it('throws for audio-only with no eligible audio (#544 interplay)', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 }],
      [{ type: 'audio', assetId: 'a', trackId: 'a1', muted: true }],
    );
    expect(() =>
      buildFfmpegArgs(
        project,
        { outputPath: 'out.m4a', format: 'audio', quality: 'normal' },
        1920, 1080, 30, 10, null,
      ),
    ).toThrow(/No audio to export/i);
  });
});
