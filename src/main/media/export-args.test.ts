/**
 * Regression coverage for the export argument builder (upstream PR #546):
 * each unique source path becomes exactly one FFmpeg input, shared by every
 * clip referencing it, with filter-graph and audio-map indices remapped to
 * the consolidated inputs. Previously N clips from one source spawned N full
 * decodes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createEmptyProject } from '../../shared/types/project';
import { motionExpression } from '../../shared/media/motion';
import { volumeFilterExpression } from '../../shared/audio/volume-keyframes';
import {
  clipTrimSeconds,
  effectiveSpeed,
  projectFramesToSeconds,
} from '../../shared/media/source-time';
import type { Clip, Project } from '../../shared/types/project';
import { BLEND_MODES, FFMPEG_BLEND_MODES, type BlendMode } from '../../shared/types/blend-mode';
import { buildFfmpegArgs, videoCodecArgs } from './export-args';

const execFileAsync = promisify(execFile);

// Real encodes are subprocess-bound; keep their timeout explicit so a loaded
// parallel run does not inherit the 5 s default used by fast unit tests.
const REAL_PROCESS_TIMEOUT_MS = 30_000;

function projectWithMedia(
  media: Array<{ id: string; path: string; type: 'video' | 'audio' | 'image'; duration: number; audioCodec?: string; width?: number; height?: number }>,
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
    ...(asset.width ? { width: asset.width } : {}),
    ...(asset.height ? { height: asset.height } : {}),
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
      1920, 1080, 30, 100,
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
    // eq carries only eq options; hue rotation and invert ride their own
    // filters, because FFmpeg rejects unknown eq options outright.
    expect(graded).toContain('eq=brightness=-0.150000:contrast=1.300000:saturation=0.600000,hue=h=45.0');

    const plain = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v' }],
    );
    const plainArgs = build(plain).find((arg) => arg.includes('trim='))!;
    expect(plainArgs).not.toContain('eq=');
  });

  it('emits tone-curve filters for curved clips and omits them for identity ones', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [
        {
          type: 'video', assetId: 'v', startFrame: 0, durationFrames: 100,
          contrast: 1.2,
          curves: {
            master: [{ x: 0, y: 0.06 }, { x: 1, y: 0.95 }],
            red: [],
            green: [],
            blue: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }],
          },
        },
      ],
    );
    const graded = build(project).find((arg) => arg.includes('trim='))!;
    // Master geq first (it needs all three channels), then the channel LUT,
    // both after eq and before any hue/negate segment.
    expect(graded).toContain("eq=contrast=1.200000,geq=r='");
    expect(graded).toContain(",lutrgb=b='255*(");
    expect(graded).toContain(":a='alpha(X,Y)'");

    const identity = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{
        type: 'video', assetId: 'v',
        curves: { master: [{ x: 0, y: 0 }, { x: 1, y: 1 }], red: [], green: [], blue: [] },
      }],
    );
    const identityArgs = build(identity).find((arg) => arg.includes('trim='))!;
    expect(identityArgs).not.toContain('lutrgb=');
    expect(identityArgs).not.toContain('geq=');
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

  it('applies font case to the drawtext text and emits line spacing (#330)', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{
        type: 'title',
        assetId: '__title__',
        startFrame: 0,
        durationFrames: 30,
        text: 'Mixed Case',
        titleFontCase: 'upper',
        titleLineSpacing: 12,
      }],
    );

    const graph = build(project).find((arg) => arg.includes('drawtext'))!;
    // Case is applied to the string before escaping, so both render paths
    // see identical glyphs; spacing rides drawtext's native parameter.
    expect(graph).toContain("text='MIXED CASE'");
    expect(graph).toContain('line_spacing=12');
  });

  it('composites a baked footage band instead of drawtext (#525)', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{
        type: 'title',
        assetId: '__title__',
        id: 'clip-1',
        startFrame: 30,
        durationFrames: 60,
        text: 'Knockout',
        titleFillMode: 'footage',
      }],
    );
    const bakedTitles = [{ clipId: 'clip-1', path: 'C:/baked/clip-1.png' }];

    const args = build(project, { bakedTitles });
    const graph = args.find((arg) => arg.includes('overlay=eof_action=pass'))!;
    expect(graph).toContain('[bk0]');
    expect(graph).toContain("enable='between(t,1.0000,3.0000)'");
    expect(graph).not.toContain('drawtext');

    // The still streams as a loop so the node never starves mid-export.
    const inputPos = args.indexOf('C:/baked/clip-1.png');
    expect(args[inputPos - 1]).toBe('-i');
    expect(args[inputPos - 2]).toBe('1');
  });

  it('difference-blends an inverted silhouette (#525)', () => {
    const project = projectWithMedia(
      [],
      [{
        type: 'title',
        assetId: '__title__',
        id: 'clip-0',
        startFrame: 0,
        durationFrames: 30,
        text: 'Inverse',
        titleFillMode: 'inverted',
      }],
    );

    const graph = build(project, {
      bakedTitles: [{ clipId: 'clip-0', path: 'C:/baked/inv.png' }],
    }).find((arg) => arg.includes('blend'))!;
    expect(graph).toContain('blend=all_mode=difference');
    expect(graph).not.toContain('drawtext');
  });

  it('degrades an advanced title to solid drawtext when no bake exists, and says so', () => {
    const project = projectWithMedia(
      [],
      [{
        type: 'title',
        assetId: '__title__',
        id: 'clip-1',
        startFrame: 0,
        durationFrames: 30,
        text: 'Fallback',
        label: 'Opening card',
        titleFillMode: 'footage',
      }],
    );

    const warnings: string[] = [];
    const args = build(project, undefined, warnings);
    expect(args.some((arg) => arg.includes('drawtext'))).toBe(true);
    expect(args.some((arg) => arg.includes('overlay=eof_action=pass'))).toBe(false);
    // The degradation is reported, naming the clip and what it lost — an
    // agent export has no renderer to bake with, so this is its only signal.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Opening card/);
    expect(warnings[0]).toMatch(/fill mode/);
    expect(warnings[0]).toMatch(/plain solid text/);
  });

  it('leaves an advanced title\'s graph byte-identical, baked or degraded', () => {
    // The bake gate moved into shared/editor/title so this process and the
    // renderer read one predicate. These two argument lists are the contract
    // that move must not disturb: the gate only decides whether a warning is
    // emitted, never the filter graph.
    const advanced = {
      type: 'title' as const,
      assetId: '__title__',
      id: 'clip-0',
      startFrame: 30,
      durationFrames: 60,
      text: 'Angled',
      label: 'Angled card',
      titleFillMode: 'footage' as const,
      titleBlurRadius: 3,
      titleTiltXDeg: 6,
      titleVariationWght: 700,
    };
    const media = [{ id: 'v', path: 'C:/media/v.mp4', type: 'video' as const, duration: 900 }];

    // No bake: drawtext carries what it can, the rest is reported.
    const degradedWarnings: string[] = [];
    expect(build(projectWithMedia(media, [advanced]), undefined, degradedWarnings)).toEqual([
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:d=10:r=30',
      '-filter_complex',
      "[0:v]drawtext=text='Angled':fontsize=97:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2"
        + ":enable='between(t,1.0000,3.0000)'[vt0]",
      '-map', '[vt0]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-c:a', 'aac', '-b:a', '192k',
      '-t', '10.0000', 'out.mp4',
    ]);
    expect(degradedWarnings).toEqual([
      'Title clip "Angled card" rendered as plain solid text: its fill mode, blur, '
        + 'perspective tilt, and variable-font axes need a baked layer, which this export '
        + 'did not have. Export it from the delivery panel to keep the styling.',
    ]);

    // Baked: the still composites instead, and nothing is reported.
    const bakedWarnings: string[] = [];
    expect(build(
      projectWithMedia(media, [advanced]),
      { bakedTitles: [{ clipId: 'clip-0', path: 'C:/baked/clip-0.png' }] },
      bakedWarnings,
    )).toEqual([
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:d=10:r=30',
      '-loop', '1', '-i', 'C:/baked/clip-0.png',
      '-filter_complex',
      "[1:v]format=rgba[bk0];[0:v][bk0]overlay=eof_action=pass"
        + ":enable='between(t,1.0000,3.0000)'[vt0]",
      '-map', '[vt0]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-c:a', 'aac', '-b:a', '192k',
      '-t', '10.0000', 'out.mp4',
    ]);
    expect(bakedWarnings).toEqual([]);
  });

  it('routes a variable-font title through the baked overlay, never drawtext (#50)', () => {
    // Bake whenever variations are non-default: drawtext cannot express
    // axes, while the canvas bake carries them via font-variation-settings.
    const project = projectWithMedia(
      [],
      [{
        type: 'title',
        assetId: '__title__',
        id: 'clip-0',
        startFrame: 0,
        durationFrames: 30,
        text: 'Heavy',
        titleVariationWght: 800,
        titleVariationWdth: 75,
      }],
    );

    const args = build(project, { bakedTitles: [{ clipId: 'clip-0', path: 'C:/baked/var.png' }] });
    const graph = args.find((arg) => arg.includes('overlay=eof_action=pass'))!;
    expect(graph).toContain('[bk0]');
    expect(graph).toContain("enable='between(t,0.0000,1.0000)'");
    expect(args.some((arg) => arg.includes('drawtext'))).toBe(false);
  });

  it('degrades a variable-font title to solid drawtext when no bake exists (#50)', () => {
    const project = projectWithMedia(
      [],
      [{
        type: 'title',
        assetId: '__title__',
        startFrame: 0,
        durationFrames: 30,
        text: 'Heavy',
        titleVariationWght: 800,
      }],
    );

    const warnings: string[] = [];
    const args = build(project, undefined, warnings);
    expect(args.some((arg) => arg.includes('drawtext'))).toBe(true);
    expect(args.some((arg) => arg.includes('overlay=eof_action=pass'))).toBe(false);
    // Losing the axes is exactly the case drawtext cannot express, so it is
    // named in the report.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/variable-font axes/);
  });

  it('says nothing for a plain title the drawtext fallback renders faithfully', () => {
    const project = projectWithMedia(
      [],
      [{
        type: 'title',
        assetId: '__title__',
        startFrame: 0,
        durationFrames: 30,
        text: 'Plain',
        titleColor: '#ffcc00',
      }],
    );

    const warnings: string[] = [];
    const args = build(project, undefined, warnings);
    expect(args.some((arg) => arg.includes('drawtext'))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('omits drawtext entirely when there are no titles (audio-only too)', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 }],
      [{ type: 'audio', assetId: 'a', trackId: 'a1' }],
    );
    const audioArgs = buildFfmpegArgs(
      project,
      { outputPath: 'out.m4a', format: 'audio', quality: 'normal' },
      1920, 1080, 30, 100,
    );
    expect(audioArgs.join(' ')).not.toContain('drawtext');
  });
});

describe('variable-font title export end to end (real ffmpeg, #50)', { timeout: REAL_PROCESS_TIMEOUT_MS }, () => {
  let tmpDir = '';
  let bakePath = '';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-vartitle-export-'));
    bakePath = path.join(tmpDir, 'var-0.png');
    // Stand-in bake: a real full-canvas PNG like ExportDialog's title baker emits.
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=white:s=320x240:d=1',
      '-frames:v', '1', bakePath,
    ]);
  }, REAL_PROCESS_TIMEOUT_MS);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('encodes a baked variable-font overlay with no drawtext node', async () => {
    const project = projectWithMedia(
      [],
      [{
        type: 'title',
        assetId: '__title__',
        id: 'clip-0',
        startFrame: 0,
        durationFrames: 30,
        text: 'Heavy',
        titleVariationWght: 800,
      }],
    );
    project.settings.width = 320;
    project.settings.height = 240;
    const outputPath = path.join(tmpDir, 'var.mp4');
    const args = buildFfmpegArgs(
      project,
      {
        outputPath,
        format: 'mp4',
        quality: 'draft',
        bakedTitles: [{ clipId: 'clip-0', path: bakePath }],
      },
      320,
      240,
      30,
      60,
    );
    const graph = args.join(' ');
    expect(graph).toContain('overlay=eof_action=pass');
    expect(graph).not.toContain('drawtext');
    await execFileAsync('ffmpeg', args);
    const stat = await fs.stat(outputPath);
    expect(stat.size).toBeGreaterThan(0);
  });
});

describe('opacityTrack export end to end (real ffmpeg)', { timeout: REAL_PROCESS_TIMEOUT_MS }, () => {
  let tmpDir = '';
  let sourcePath = '';
  let outputPath = '';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-opacity-track-export-'));
    sourcePath = path.join(tmpDir, 'source.mp4');
    outputPath = path.join(tmpDir, 'opacity.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=white:s=32x32:d=2:r=30',
      '-pix_fmt', 'yuv420p', sourcePath,
    ]);
  }, REAL_PROCESS_TIMEOUT_MS);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('encodes a time-varying alpha track', async () => {
    const project = projectWithMedia(
      [{ id: 'v', path: sourcePath, type: 'video', duration: 60, width: 32, height: 32 }],
      [{
        id: 'opacity-clip', type: 'video', assetId: 'v', startFrame: 0, durationFrames: 30,
        opacity: 1,
        opacityTrack: [{ frame: 0, value: 0.2 }, { frame: 30, value: 0.8 }],
      }],
    );
    project.settings.width = 32;
    project.settings.height = 32;
    const args = buildFfmpegArgs(
      project,
      { outputPath, format: 'mp4', quality: 'draft' },
      32, 32, 30, 60,
    );
    expect(args.join(' ')).toContain("geq=r='r(X,Y)'");
    await execFileAsync('ffmpeg', args);
    const stat = await fs.stat(outputPath);
    expect(stat.size).toBeGreaterThan(0);
  }, REAL_PROCESS_TIMEOUT_MS);
});

function build(
  project: Project,
  options?: { bakedTitles?: Array<{ clipId: string; path: string }> },
  warnings?: string[],
): string[] {
  return buildFfmpegArgs(
    project,
    {
      outputPath: 'out.mp4',
      format: 'mp4',
      quality: 'normal',
      ...(options?.bakedTitles ? { bakedTitles: options.bakedTitles } : {}),
    },
    1920,
    1080,
    30,
    300,
    warnings,
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

  it('emits the three-band EQ filters for set bands (#158)', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 }],
      [{
        type: 'audio', assetId: 'a', startFrame: 0, durationFrames: 60,
        eqLowDb: 6, eqMidDb: -2, eqHighDb: 3,
      }],
    );

    const graph = build(project).find((arg) => arg.includes('atrim'))!;
    expect(graph).toContain(
      'bass=g=+6,equalizer=f=1000:t=q:w=1:g=-2,treble=g=+3',
    );
  });

  it('emits no EQ filters for a neutral clip', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 }],
      [{ type: 'audio', assetId: 'a', startFrame: 0, durationFrames: 60 }],
    );

    const graph = build(project).find((arg) => arg.includes('atrim'))!;
    expect(graph).not.toContain('bass=');
    expect(graph).not.toContain('equalizer=');
    expect(graph).not.toContain('treble=');
  });

  it('emits an acompressor filter when the clip is compressed (#158)', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 }],
      [{
        type: 'audio', assetId: 'a', startFrame: 0, durationFrames: 60,
        compressor: { thresholdDb: -18, ratio: 4, attackMs: 20, releaseMs: 250, makeupDb: 6 },
      }],
    );

    const graph = build(project).find((arg) => arg.includes('atrim'))!;
    expect(graph).toContain('acompressor=');
    expect(graph).toContain('ratio=4.00');
    expect(graph).toContain('attack=20.00');
    expect(graph).toContain('release=250.00');
  });

  it('emits no compressor for a ratio-1 clip', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 }],
      [{
        type: 'audio', assetId: 'a', startFrame: 0, durationFrames: 60,
        compressor: { thresholdDb: -18, ratio: 1, attackMs: 20, releaseMs: 250, makeupDb: 0 },
      }],
    );

    const graph = build(project).find((arg) => arg.includes('atrim'))!;
    expect(graph).not.toContain('acompressor=');
  });

  it('emits a time-varying volume expression when volumeDb is set, overriding the static field', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 }],
      [{
        type: 'audio', assetId: 'a', startFrame: 0, durationFrames: 60,
        volume: 0.5, // must be ignored in favor of the active track
        volumeDb: [{ frame: 0, value: 0 }, { frame: 30, value: -60 }],
      }],
    );

    const graph = build(project).find((arg) => arg.includes('atrim'))!;
    expect(graph).toContain("volume='pow(10,(");
    expect(graph).toContain("':eval=frame");
    expect(graph).not.toContain('volume=0.5000');
  });

  it('shifts the volumeDb expression by the clip start so absolute keyframes align with local t', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 1800 }],
      [{
        type: 'audio', assetId: 'a', startFrame: 300, durationFrames: 60, // 10s in at 30fps
        volumeDb: [{ frame: 300, value: -6 }, { frame: 330, value: -60 }],
      }],
    );

    const graph = build(project).find((arg) => arg.includes('atrim'))!;
    // Local t=0 in this chain is absolute frame 300; the shift folds the
    // 10s offset back in so the stored keyframe times line up.
    expect(graph).toContain('(t)+(10.000000)');
  });

  it('makes the volumeDb shift relative to the range start during a ranged export', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 1800 }],
      [{
        type: 'audio', assetId: 'a', startFrame: 300, durationFrames: 60,
        volumeDb: [{ frame: 300, value: -6 }, { frame: 330, value: -60 }],
      }],
    );

    const graph = buildWithRange(project, 150, 600).find((arg) => arg.includes('atrim'))!;
    // Absolute shift would be 10s; a range starting at frame 150 (5s)
    // rebases clip.startFrame to 150, so the un-rebase must recover 10s,
    // not 5s.
    expect(graph).toContain('(t)+(10.000000)');
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

  it('uses the pure scale+overlay graph after removing the dead native callback', () => {
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
    );
    const graph = args.find((arg) => arg.includes('trim='))!;
    expect(graph).toContain("scale='1920':'1080'");
  });

  it('upscales sources with bicubic, not bilinear (upstream #573 blur)', () => {
    // Export composites from the ORIGINALS, but a scaled clip (image source,
    // moved/reframed footage) still magnifies through this filter. Bilinear
    // leaves the same staircase texture the preview decoder had.
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
    );
    const graph = args.find((arg) => arg.includes('scale='))!;
    expect(graph).toContain('flags=bicubic');
    expect(args.join(' ')).not.toContain('bilinear');
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
        1920, 1080, 30, 10,
      ),
    ).toThrow(/No audio to export/i);
  });
});

describe('static crop (#568)', () => {
  it('emits a source-space crop filter ahead of scale', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900, width: 1920, height: 1080 }],
      [{
        type: 'video',
        assetId: 'v',
        startFrame: 0,
        durationFrames: 60,
        crop: { left: 0.1, right: 0.1, top: 0, bottom: 0 },
      }],
    );

    const graph = build(project).find((arg) => arg.includes('crop='))!;
    expect(graph).toMatch(/format=rgba,crop=\d+:\d+:\d+:0,scale=/);
    expect(graph).not.toContain('drawtext');
  });

  it('omits the crop filter when the clip is not cropped', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60 }],
    );
    const graph = build(project).find((arg) => arg.includes('scale='))!;
    expect(graph).not.toContain('crop=');
  });
});





describe('position motion keyframes (keyframes v1)', () => {
  it('emits piecewise-linear overlay x/y expressions', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{
        type: 'video',
        assetId: 'v',
        startFrame: 0,
        durationFrames: 90,
        motionX: [
          { frame: 0, value: 100 },
          { frame: 30, value: 400 },
          { frame: 60, value: 200 },
        ],
      }],
    );

    const graph = build(project).find((arg) => arg.includes('overlay='))!;
    // Nested ifs with normalized-time segments: seg1 slope +300/s, seg2 -200/s.
    expect(graph).toContain('overlay=x=');
    expect(graph).toContain('+300.000000*((t)-(0.000000))/((1.000000)-(0.000000))');
    expect(graph).toContain('400.0000+-200.000000*((t)-(1.000000))/((2.000000)-(1.000000))');
    expect(graph).toContain(',200.0000)');
    expect(graph).not.toContain('overlay=x=0');
  });

  it('keeps static x/y when no motion track exists', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60, x: 42, y: 17 }],
    );
    const graph = build(project).find((arg) => arg.includes('overlay='))!;
    expect(graph).toContain("overlay=x='42':y='17'");
  });
});


describe('rotation export (static + keyframes v1)', () => {
  it('emits a rotate filter for statically rotated clips', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60, rotation: 45 }],
    );
    const graph = build(project).find((arg) => arg.includes('rotate='))!;
    expect(graph).toContain("rotate='(45.000000)*PI/180':c=black@0");
  });

  it('keeps an animated custom-anchor rotation box stable across frames', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60,
        anchorX: 40, anchorY: 20,
        motionRot: [{ frame: 0, value: 0 }, { frame: 30, value: 90 }],
      }],
    );
    const graph = build(project).find((arg) => arg.includes('rotate='))!;
    // rotw/roth are init-evaluated by FFmpeg; the custom path therefore uses
    // a conservative fixed box for an animated angle and compensates overlay_w/h.
    expect(graph).toContain("ow='3840':oh='3840'");
    expect(graph).not.toContain('rotw(');
  });

  it('emits a piecewise rotation expression from motionRot', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60,
        motionRot: [{ frame: 0, value: 0 }, { frame: 30, value: 90 }],
      }],
    );
    const graph = build(project).find((arg) => arg.includes('rotate='))!;
    expect(graph).toContain('PI/180');
    expect(graph).toContain('if(lte(t,1.000000)');
    expect(graph).not.toMatch(/rotate='\(0\.000000\)\*PI\/180'/); // zero static stays absent
  });

  it('omits rotate for unrotated clips without motion', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60 }],
    );
    const graph = build(project).find((arg) => arg.includes('scale='))!;
    expect(graph).not.toContain('rotate=');
  });
});

describe('media anchor, opacity, and pipeline order', () => {
  it('keeps the default-anchor graph byte-identical and falls back for absent fields', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v', startFrame: 0, x: 42, y: 17 }],
    );
    const graph = build(project).find((arg) => arg.includes('trim='))!;
    // This is the pre-anchor default-anchor graph, including its old filter
    // spelling. A zero anchor must not acquire a pivot expression.
    expect(graph).toBe(
      "[1:v]trim=start=0.0000:end=3.3333,setpts=PTS-STARTPTS[v0trimmed];"
      + "[v0trimmed]fps=30,format=rgba,scale='1920':'1080':flags=bicubic[v0scaled];"
      + "[0:v][v0scaled]overlay=x='42':y='17':enable='between(t,0.0000,3.3333)'[vout]",
    );

    const explicitZero = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v', startFrame: 0, x: 42, y: 17, anchorX: 0, anchorY: 0 }],
    );
    const oldProject = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0, x: 42, y: 17,
        anchorX: undefined as never, anchorY: undefined as never,
        opacity: undefined as never,
      }],
    );
    const malformedProject = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0, x: 42, y: 17,
        anchorX: Number.NaN as never, anchorY: 'legacy' as never,
        opacity: 'legacy' as never,
      }],
    );
    expect(build(explicitZero)).toEqual(build(project));
    expect(build(oldProject)).toEqual(build(project));
    expect(build(malformedProject)).toEqual(build(project));
  });

  it('uses the native affine translation for a non-zero scale anchor', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0,
        x: 100, y: 50, scaleX: 2, scaleY: 1, anchorX: 40, anchorY: 20,
      }],
    );
    const graph = build(project).find((arg) => arg.includes('trim='))!;
    // T(position + anchor) · S · T(-anchor) gives
    // x + ax - ax*sx and y + ay - ay*sy.
    expect(graph).toContain(
      "overlay=x='(100)+(40.000000)-((40.000000)*(2.000000))'",
    );
    expect(graph).toContain(
      ":y='(50)+(20.000000)-((20.000000)*(1.000000))'",
    );
  });

  it('expands custom-anchor rotation around the requested pivot', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0,
        x: 100, y: 50, rotation: 45, scaleX: 1.25, scaleY: 0.75,
        anchorX: 40, anchorY: 20,
      }],
    );
    const graph = build(project).find((arg) => arg.includes('trim='))!;
    expect(graph).toContain("ow='rotw((45.000000)*PI/180)'");
    expect(graph).toContain("oh='roth((45.000000)*PI/180)'");
    expect(graph).toContain('overlay_w/2');
    expect(graph).toContain('overlay_h/2');
    expect(graph).toContain('40.000000');
    expect(graph).toContain('20.000000');
    expect(graph).toContain('cos(');
    expect(graph).toContain('sin(');
  });

  it('multiplies media alpha at non-unit opacity and leaves audio eligibility unchanged', () => {
    const make = (opacity: number) => projectWithMedia(
      [
        { id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 },
        { id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 },
      ],
      [
        { type: 'video', assetId: 'v', startFrame: 0, opacity },
        { type: 'audio', assetId: 'a', trackId: 'a1', startFrame: 0 },
        { type: 'audio', assetId: 'a', trackId: 'a1', startFrame: 0, muted: true },
      ],
    );
    const half = build(make(0.5));
    const unity = build(make(1));
    const halfGraph = half.find((arg) => arg.includes('trim='))!;
    expect(halfGraph).toContain('colorchannelmixer=aa=0.5000');
    expect(halfGraph).not.toContain('[0:v]colorchannelmixer');
    expect(unity.find((arg) => arg.includes('trim='))!).not.toContain('colorchannelmixer=aa=');
    const maps = (args: string[]) => args.flatMap((arg, index) => (
      arg === '-map' ? [args[index + 1]!] : []
    ));
    expect(maps(half)).toEqual(maps(unity));
    expect(maps(half)).toEqual(['[vout]', '[a0]']);
  });

  it('emits a time-based alpha expression when opacityTrack is set, overriding static opacity', () => {
    const opacityTrack = [
      { frame: 0, value: 0, easing: 'easeInOut' as const },
      { frame: 30, value: 1 },
    ];
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0, opacity: 1, fadeInFrames: 10,
        opacityTrack,
      }],
    );

    const graph = build(project).find((arg) => arg.includes('trim='))!;
    expect(graph).toContain("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(");
    expect(graph).toContain('pow(');
    expect(graph).toContain(motionExpression(opacityTrack, 1 / 30, 'T')!);
    expect(graph).toContain('if(lte(T,1.000000)');
    expect(graph).toContain('fade=t=in');
    expect(graph).not.toContain('colorchannelmixer=aa=1.0000');
  });

  it('uses the absolute timeline clock for opacityTrack after a clip start shift', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 1800 }],
      [{
        type: 'video', assetId: 'v', startFrame: 300, durationFrames: 60,
        opacityTrack: [{ frame: 300, value: 0.2 }, { frame: 330, value: 0.8 }],
      }],
    );

    const graph = build(project).find((arg) => arg.includes('trim='))!;
    expect(graph).toContain('(T)+(10.000000)');
  });

  it('runs crop → chroma → grade/effects → edge mask → scale/rotate', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900, width: 1920, height: 1080 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0,
        crop: { left: 0.1, right: 0.1, top: 0, bottom: 0 },
        chromaKey: { keyColor: '#00ff00', tolerance: 0.2 },
        brightness: -0.15,
        blurRadius: 2,
        edgeRounding: 0.25,
        rotation: 45,
      }],
    );
    const media = build(project).find((arg) => arg.includes('trim=') && arg.includes('eq='))!;
    const cropAt = media.indexOf('crop=');
    const chromaAt = media.indexOf('colorkey=');
    const gradeAt = media.indexOf('eq=');
    const effectsAt = media.indexOf('gblur=');
    const edgeAt = media.indexOf("a=alpha(X,Y)");
    const scaleAt = media.indexOf('scale=');
    const rotateAt = media.indexOf('rotate=');
    // Deliberate order pin: this changed from the old scale → grade/effects →
    // rotate graph to match the active preview and upstream FrameRenderer.
    expect(cropAt).toBeLessThan(chromaAt);
    expect(chromaAt).toBeLessThan(gradeAt);
    expect(gradeAt).toBeLessThan(effectsAt);
    expect(effectsAt).toBeLessThan(edgeAt);
    expect(edgeAt).toBeLessThan(scaleAt);
    expect(scaleAt).toBeLessThan(rotateAt);
  });

  it('keeps a combined anchor/opacity/rotation/grade graph single and connected', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0,
        x: 80, y: 60, scaleX: 1.2, scaleY: 0.9,
        anchorX: 30, anchorY: 15, rotation: 30, opacity: 0.6,
        brightness: 0.1, blurRadius: 1, edgeSoftness: 0.2,
      }],
    );
    const graph = build(project).find((arg) => arg.includes('trim='))!;
    expect(graph).toContain('colorchannelmixer=aa=0.6000');
    expect(graph).toContain('rotw(');
    expect(graph).toContain('[v0scaled]');
    expect(graph).toContain("[0:v][v0scaled]overlay=");
    expect(graph.match(/\[v0scaled\]/g)).toHaveLength(2); // definition + one consumer
    expect(graph.match(/\[vout\]/g)).toHaveLength(1);
  });
});

describe('media geometry/order end to end (real ffmpeg)', { timeout: REAL_PROCESS_TIMEOUT_MS }, () => {
  let tmpDir = '';
  let srcPath = '';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-media-geometry-export-'));
    srcPath = path.join(tmpDir, 'src.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=30',
      '-pix_fmt', 'yuv420p', srcPath,
    ]);
  }, REAL_PROCESS_TIMEOUT_MS);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function realProject(overrides: Partial<Clip>): Project {
    const project = projectWithMedia(
      [{ id: 'v', path: srcPath, type: 'video', duration: 30, width: 320, height: 240 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0, durationFrames: 30,
        inPoint: 0, outPoint: 30, width: 320, height: 240, ...overrides,
      }],
    );
    project.settings.width = 320;
    project.settings.height = 240;
    return project;
  }

  it('encodes a grade-only crop clip without changing the stream attachment', async () => {
    const outputPath = path.join(tmpDir, 'grade-only.mp4');
    const args = buildFfmpegArgs(
      realProject({ crop: { left: 0.1, right: 0.1, top: 0, bottom: 0 }, brightness: -0.15 }),
      { outputPath, format: 'mp4', quality: 'draft' },
      320, 240, 30, 30,
    );
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph.indexOf('crop=')).toBeLessThan(graph.indexOf('eq='));
    await execFileAsync('ffmpeg', args);
    expect((await fs.stat(outputPath)).size).toBeGreaterThan(0);
  });

  it('encodes the combined custom-pivot/opacity/grade graph', async () => {
    const outputPath = path.join(tmpDir, 'combined.mp4');
    const args = buildFfmpegArgs(
      realProject({
        x: 40, y: 30, scaleX: 1.1, scaleY: 0.9,
        anchorX: 25, anchorY: 20, rotation: 30, opacity: 0.6,
        brightness: 0.1, blurRadius: 1, edgeRounding: 0.1,
      }),
      { outputPath, format: 'mp4', quality: 'draft' },
      320, 240, 30, 30,
    );
    await execFileAsync('ffmpeg', args);
    expect((await fs.stat(outputPath)).size).toBeGreaterThan(0);
  });

  it('encodes an animated custom pivot without freezing the rotate box', async () => {
    const outputPath = path.join(tmpDir, 'animated-combined.mp4');
    const args = buildFfmpegArgs(
      realProject({
        x: 40, y: 30, anchorX: 25, anchorY: 20, opacity: 0.7,
        motionScaleX: [{ frame: 0, value: 1 }, { frame: 15, value: 1.1 }],
        motionRot: [{ frame: 0, value: 0 }, { frame: 15, value: 60 }],
      }),
      { outputPath, format: 'mp4', quality: 'draft' },
      320, 240, 30, 30,
    );
    await execFileAsync('ffmpeg', args);
    expect((await fs.stat(outputPath)).size).toBeGreaterThan(0);
  });
});

describe('LUT export (#157 LUTs)', () => {
  const LUT_3D = { path: 'C:\\luts\\warm.cube', intensity: 1, kind: '3d' as const, size: 33 };
  const LUT_1D = { path: 'C:\\luts\\flat.cube', intensity: 1, kind: '1d' as const, size: 1024 };

  function graphFor(clip: Partial<Clip>): string {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60, ...clip }],
    );
    return build(project).find((arg) => arg.includes('trim='))!;
  }

  it('emits lut3d/lut1d in the linear chain at full intensity', () => {
    const graph = graphFor({ lut: LUT_3D });
    expect(graph).toContain(`lut3d=file='C\\:\\\\luts\\\\warm.cube':interp=tetrahedral`);
    expect(graphFor({ lut: LUT_1D })).toContain(`lut1d=file='C\\:\\\\luts\\\\flat.cube':interp=linear`);
  });

  it('places the LUT after hue curves and before hue/invert', () => {
    const graph = graphFor({
      contrast: 1.2,
      hueCurves: { hueVsHue: [], hueVsSat: [{ x: 0, y: 0.8 }, { x: 0.15, y: 0.5 }], hueVsLum: [] },
      lut: LUT_3D,
      hueRotation: 20,
      invertColors: true,
    });
    const lutAt = graph.indexOf('lut3d=');
    expect(lutAt).toBeGreaterThan(-1);
    expect(graph.indexOf('lutrgb=')).toBe(-1);
    expect(graph.slice(lutAt)).toContain('hue=h=20.0');
    expect(graph.slice(lutAt)).toContain('negate');
    expect(graph.slice(0, lutAt)).toContain('eq=contrast=1.200000');
  });

  it('expands a partial intensity into a split/lut/blend graph at the same slot', () => {
    const graph = graphFor({ contrast: 1.2, lut: { ...LUT_3D, intensity: 0.5 }, hueRotation: 20 });
    // Pre-LUT filters run ahead of the split, hue rides the blended tail.
    expect(graph).toContain('eq=contrast=1.200000');
    expect(graph).toContain('[v0prelut]split[v0preA][v0preB]');
    expect(graph).toContain(`[v0preA]lut3d=file='C\\:\\\\luts\\\\warm.cube':interp=tetrahedral[v0lut]`);
    expect(graph).toContain(`[v0lut][v0preB]blend=all_mode='normal':all_opacity=0.5[v0blended]`);
    // Grade/effects now finish before the transform; the transform is the
    // final stage in the rejoined LUT branch (preview/upstream pipeline order).
    expect(graph).toContain("[v0blended]hue=h=20.0,scale='1920':'1080':flags=bicubic[v0scaled]");
    // No linear LUT filter leaks into the pre segment.
    expect(graph.split('[v0prelut]')[0]).not.toContain('lut3d=');
  });

  it('skips the LUT stage at zero intensity', () => {
    expect(graphFor({ lut: { ...LUT_3D, intensity: 0 } })).not.toContain('lut3d=');
  });
});

describe('Effects export (#157 subgroups)', () => {
  function fxGraph(clip: Partial<Clip>): string {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60, ...clip }],
    );
    return build(project).find((arg) => arg.includes('trim='))!;
  }

  it('emits blur, grain and vignette linearly after invert', () => {
    const graph = fxGraph({
      invertColors: true,
      blurRadius: 8,
      grain: { amount: 0.5, size: 1.5 },
      vignette: { amount: -0.5, midpoint: 0.5, roundness: 0, feather: 0.5 },
    });
    const negateAt = graph.indexOf('negate');
    const blurAt = graph.indexOf('gblur=sigma=8:planes=7');
    const grainAt = graph.indexOf('0.1031');
    const vigAt = graph.indexOf('(X-W/2)/max(W/2,1)');
    expect(blurAt).toBeGreaterThan(-1);
    expect(grainAt).toBeGreaterThan(-1);
    expect(vigAt).toBeGreaterThan(-1);
    // Canonical order: blur, then grain, then vignette — all behind invert.
    expect(negateAt).toBeLessThan(blurAt);
    expect(blurAt).toBeLessThan(grainAt);
    expect(grainAt).toBeLessThan(vigAt);
  });

  it('omits identity effects and keeps ungraded clips clean', () => {
    const graph = fxGraph({ blurRadius: 0, vignette: { amount: 0, midpoint: 0.5, roundness: 0, feather: 0.5 } });
    expect(graph).not.toContain('gblur=');
    expect(graph).not.toContain('0.1031');
    expect(graph).not.toContain('W/2');
  });

  it('expands glow into a threshold/blur/scale/screen graph at its slot', () => {
    const graph = fxGraph({
      vignette: { amount: -0.5, midpoint: 0.5, roundness: 0, feather: 0.5 },
      glow: { intensity: 0.5, radius: 6, threshold: 0.3, warmth: 0 },
    });
    const vigAt = graph.indexOf('(X-W/2)/max(W/2,1)');
    expect(vigAt).toBeGreaterThan(-1);
    expect(graph).toContain('[v0mid]split[v0glowA][v0glowB]');
    expect(graph).toContain('gblur=sigma=6:planes=7');
    expect(graph).toContain("[v0glow][v0glowB]blend=all_mode='screen':c3_mode='normal':c3_opacity=0[v0glowed]");
    // The glow graph sits after the vignette stage.
    expect(graph.indexOf('[v0mid]split')).toBeGreaterThan(vigAt);
  });

  it('skips the glow blur step at radius 0, like the preview', () => {
    const graph = fxGraph({ glow: { intensity: 0.5, radius: 0, threshold: 0.3, warmth: 0 } });
    expect(graph).not.toContain('gblur=');
    expect(graph).toContain("blend=all_mode='screen'");
  });

  it('chains a partial LUT blend into the glow graph in slot order', () => {
    const graph = fxGraph({
      lut: { path: 'C:\\luts\\warm.cube', intensity: 0.5, kind: '3d', size: 2 },
      glow: { intensity: 0.5, radius: 6, threshold: 0.3, warmth: 0 },
    });
    const lutAt = graph.indexOf('lut3d=');
    const glowAt = graph.indexOf('[v0glowA]');
    expect(lutAt).toBeGreaterThan(-1);
    expect(glowAt).toBeGreaterThan(lutAt);
  });
});

describe('clip blend mode export (#98 / #203 / #213)', () => {
  function graphForBlendMode(mode: unknown): string {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60, blendMode: mode as BlendMode }],
    );
    const graph = build(project).find((arg) => arg.includes('trim='));
    expect(graph).toBeDefined();
    return graph!;
  }

  it('keeps absent and normal modes byte-identical and on the legacy overlay path', () => {
    const absent = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60 }],
    );
    const normal = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 900 }],
      [{ type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60, blendMode: 'normal' }],
    );

    expect(build(normal)).toEqual(build(absent));
    const graph = build(normal).find((arg) => arg.includes('trim='))!;
    expect(graph).toContain("[0:v][v0scaled]overlay=x='0':y='0'");
    expect(graph).not.toContain('blend=all_mode');
    expect(graph).not.toContain('split');
  });

  for (const mode of BLEND_MODES) {
    if (mode === 'normal') continue;
    it(`emits the shared FFmpeg mapping for ${mode}`, () => {
      const graph = graphForBlendMode(mode);
      expect(graph).toContain(`blend=all_mode='${FFMPEG_BLEND_MODES[mode]}'`);
      expect(graph).toContain('[0:v]split[v0blendBase][v0blendCanvas]');
      expect(graph).toContain('[v0blendBaseRgba][v0blendLayer]blend=');
      expect(graph).toContain('[v0blendTransparent][v0scaled]overlay=');
    });
  }

  it('does not put a muted audio clip or its blend mode in the video graph', () => {
    const project = projectWithMedia(
      [{ id: 'a', path: 'C:/media/a.mp3', type: 'audio', duration: 900 }],
      [{ type: 'audio', assetId: 'a', startFrame: 0, muted: true, blendMode: 'multiply' as BlendMode }],
    );
    const args = build(project);
    expect(args.some((arg) => arg.includes('blend=all_mode'))).toBe(false);
    expect(args.some((arg) => arg.includes('atrim'))).toBe(false);
  });

  it('blends layer B against A while keeping canvas input 0 first', () => {
    const project = projectWithMedia(
      [
        { id: 'a', path: 'C:/media/a.mp4', type: 'video', duration: 900 },
        { id: 'b', path: 'C:/media/b.mp4', type: 'video', duration: 900 },
      ],
      [
        { type: 'video', assetId: 'a', trackId: 'v1', startFrame: 0 },
        { type: 'video', assetId: 'b', trackId: 'v2', startFrame: 0, blendMode: 'multiply' },
      ],
    );
    project.timeline.tracks.push({
      id: 'v2', name: 'Video 2', type: 'video', locked: false,
      visible: true, syncLocked: false, order: 2,
    });

    const args = build(project);
    const graph = args.find((arg) => arg.includes('trim='))!;
    const inputs = args.filter((arg, index) => args[index - 1] === '-i');
    expect(inputs[0]).toContain('color=c=black');
    expect(inputs.slice(1)).toEqual(['C:/media/a.mp4', 'C:/media/b.mp4']);
    // B blends with A's accumulated v0out, not the blank 0:v canvas.
    expect(graph).toContain('[v0out]split[v1blendBase][v1blendCanvas]');
    expect(graph).toContain('[v1blendBaseRgba][v1blendLayer]blend=all_mode=\'multiply\'');
    expect(graph).toContain('[v1blendTransparent][v1scaled]overlay=');
  });

  it('falls back to the ordinary overlay for an unknown persisted mode', () => {
    expect(() => graphForBlendMode('legacy-unknown-mode')).not.toThrow();
    const graph = graphForBlendMode('legacy-unknown-mode');
    expect(graph).toContain("[0:v][v0scaled]overlay=x='0':y='0'");
    expect(graph).not.toContain('blend=all_mode');
    expect(graph).not.toContain('split');
  });
});

describe('constant clip speed export', () => {
  const FPS = 30;

  function buildSpeed(
    project: Project,
    totalFrames = 60,
    range?: { start: number; end: number },
  ): string[] {
    return buildFfmpegArgs(
      project,
      {
        outputPath: 'out.mp4',
        format: 'mp4',
        quality: 'normal',
        ...(range ? { range } : {}),
      },
      1920,
      1080,
      FPS,
      totalFrames,
    );
  }

  function graphOf(args: string[]): string {
    const index = args.indexOf('-filter_complex');
    expect(index).toBeGreaterThanOrEqual(0);
    return args[index + 1] ?? '';
  }

  it('emits a video setpts speed filter and scales the source window for 2x', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 300 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60,
        inPoint: 15, outPoint: 135, speed: 2,
      }],
    );
    const clip = project.timeline.clips[0]!;
    const expectedWindow = clipTrimSeconds(clip, FPS);
    const args = buildSpeed(project);
    const graph = graphOf(args);

    expect(graph).toContain(
      `trim=start=${expectedWindow.start.toFixed(4)}:end=${expectedWindow.end.toFixed(4)}`,
    );
    expect(graph).toContain('setpts=(PTS-STARTPTS)/2.000000');
    expect(graph).toContain("enable='between(t,0.0000,2.0000)'");
    expect(args[args.indexOf('-t') + 1]).toBe('2.0000');
  });

  it('keeps absent and unit speed byte-identical to the pre-speed args', () => {
    const absent = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 300 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60,
        inPoint: 15, outPoint: 75,
      }],
    );
    const unit = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 300 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60,
        inPoint: 15, outPoint: 75, speed: 1,
      }],
    );

    const absentArgs = buildSpeed(absent);
    const unitArgs = buildSpeed(unit);
    expect(unitArgs).toEqual(absentArgs);
    expect(graphOf(unitArgs)).not.toContain('setpts=(PTS-STARTPTS)/');
    expect(graphOf(unitArgs)).not.toContain('atempo=');
  });

  it('emits the 0.5x filter without exhausting the source window', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 300 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60,
        inPoint: 30, outPoint: 60, speed: 0.5,
      }],
    );
    const clip = project.timeline.clips[0]!;
    const sourceWindow = clipTrimSeconds(clip, FPS);
    const sourceDuration = sourceWindow.end - sourceWindow.start;
    const timelineDuration = projectFramesToSeconds(clip.durationFrames, FPS);
    expect(sourceDuration / effectiveSpeed(clip.speed)).toBeCloseTo(timelineDuration, 6);
    expect(sourceWindow.end).toBeLessThan(10);

    const args = buildSpeed(project);
    const graph = graphOf(args);
    expect(graph).toContain(
      `trim=start=${sourceWindow.start.toFixed(4)}:end=${sourceWindow.end.toFixed(4)}`,
    );
    expect(graph).toContain('setpts=(PTS-STARTPTS)/0.500000');
    expect(args[args.indexOf('-t') + 1]).toBe('2.0000');
  });

  it('applies the same speed to linked video and audio partners', () => {
    const project = projectWithMedia(
      [
        { id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 300 },
        { id: 'a', path: 'C:/media/a.wav', type: 'audio', duration: 300 },
      ],
      [
        {
          type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60,
          inPoint: 0, outPoint: 120, speed: 2, linkGroupId: 'av',
        },
        {
          type: 'audio', assetId: 'a', trackId: 'a1', startFrame: 0,
          durationFrames: 60, inPoint: 0, outPoint: 120, speed: 2, linkGroupId: 'av',
        },
      ],
    );

    const graph = graphOf(buildSpeed(project));
    expect(graph).toContain('setpts=(PTS-STARTPTS)/2.000000');
    expect(graph).toContain('asetpts=PTS-STARTPTS,atempo=2.000000');
  });

  it('keeps absolute motion and volume keyframes on the post-speed timeline clock', () => {
    const motionRot = [{ frame: 90, value: 0 }, { frame: 120, value: 90 }];
    const volumeDb = [{ frame: 90, value: 0 }, { frame: 120, value: -60 }];
    const project = projectWithMedia(
      [
        { id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 300 },
        { id: 'a', path: 'C:/media/a.wav', type: 'audio', duration: 300 },
      ],
      [
        {
          type: 'video', assetId: 'v', startFrame: 90, durationFrames: 60,
          inPoint: 0, outPoint: 120, speed: 2, motionRot,
        },
        {
          type: 'audio', assetId: 'a', trackId: 'a1', startFrame: 90,
          durationFrames: 60, inPoint: 0, outPoint: 120, speed: 2, volumeDb,
        },
      ],
    );

    const graph = graphOf(buildSpeed(project, 150));
    expect(graph).toContain(motionExpression(motionRot, 1 / FPS, '(t)+(3.000000)')!);
    expect(graph).toContain(volumeFilterExpression(volumeDb, FPS, 90)!);
  });

  it('shifts a ranged speed clip source window by the effective speed', () => {
    const project = projectWithMedia(
      [{ id: 'v', path: 'C:/media/v.mp4', type: 'video', duration: 300 }],
      [{
        type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60,
        inPoint: 0, outPoint: 120, speed: 2,
      }],
    );

    const graph = graphOf(buildSpeed(project, 30, { start: 15, end: 45 }));
    expect(graph).toContain('trim=start=1.0000:end=3.0000');
    expect(graph).toContain('setpts=(PTS-STARTPTS)/2.000000');
  });

  it.each([0.5, 2])('round-trips a %sx clip to the timeline duration', async (speed) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-speed-export-'));
    const sourcePath = path.join(tmpDir, 'source.mp4');
    const outputPath = path.join(tmpDir, 'speed.mp4');
    const sourceFrames = Math.round(60 * speed);
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', `testsrc=duration=${2 * speed}:size=64x64:rate=30`,
        '-pix_fmt', 'yuv420p', sourcePath,
      ]);
      const project = projectWithMedia(
        [{ id: 'v', path: sourcePath, type: 'video', duration: sourceFrames, width: 64, height: 64 }],
        [{
          type: 'video', assetId: 'v', startFrame: 0, durationFrames: 60,
          inPoint: 0, outPoint: sourceFrames, speed, width: 64, height: 64,
        }],
      );
      project.settings.width = 64;
      project.settings.height = 64;
      const args = buildFfmpegArgs(
        project,
        { outputPath, format: 'mp4', quality: 'draft' },
        64, 64, FPS, 60,
      );
      await execFileAsync('ffmpeg', args);
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', outputPath,
      ]);
      expect(Number(stdout.trim())).toBeCloseTo(2, 1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, REAL_PROCESS_TIMEOUT_MS);
});
