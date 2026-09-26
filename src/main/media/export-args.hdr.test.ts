/**
 * HDR export (upstream #59): strict model validation, FFmpeg argument
 * emission and refusals, the grade-before-HDR rule (grade renders in the SDR
 * Rec.709 working space and is converted/tagged exactly once at the end),
 * SDR/HDR eligibility-timing parity, and real ffmpeg + ffprobe proofs for an
 * SDR-tagged baseline vs HDR-tagged HEVC Main10 encodes. The real-encode
 * proofs skip with a reported reason when the local FFmpeg cannot deliver
 * the slice (no zscale/libx265/10-bit build).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';
import {
  buildFfmpegArgs,
  parseHdrProfile,
  hdrVideoCodecArgs,
  hdrColorTagArgs,
} from './export-args';

const execFileAsync = promisify(execFile);

// Real encodes are subprocess-bound; keep their timeout explicit so a loaded
// parallel run does not inherit the 5 s default used by fast unit tests.
const REAL_PROCESS_TIMEOUT_MS = 30_000;

/**
 * Probe once whether the local FFmpeg can honestly deliver the HDR slice:
 * the zscale filter (libzimg), the libx265 encoder, and a real yuv420p10le
 * encode. Non-null = why the real-encode proofs below are skipped.
 */
const HDR_SKIP: string | null = (() => {
  let filters: string;
  try {
    filters = execFileSync('ffmpeg', ['-hide_banner', '-filters'], {
      encoding: 'utf8', windowsHide: true,
    });
  } catch {
    return 'ffmpeg is not on PATH';
  }
  if (!/\bzscale\b/.test(filters)) return 'ffmpeg lacks the zscale filter (libzimg)';
  let encoders: string;
  try {
    encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], {
      encoding: 'utf8', windowsHide: true,
    });
  } catch {
    return 'ffmpeg -encoders failed';
  }
  if (!/\blibx265\b/.test(encoders)) return 'ffmpeg lacks the libx265 encoder';
  try {
    execFileSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=0.2:r=30',
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le',
      '-x265-params', 'log-level=error', '-f', 'null', os.devNull,
    ], { encoding: 'utf8', windowsHide: true });
  } catch {
    return 'libx265 cannot encode yuv420p10le on this build (no 10-bit support)';
  }
  return null;
})();

function projectWithVideo(): Project {
  const project = createEmptyProject();
  project.media = [{
    id: 'v',
    path: 'C:/media/v.mp4',
    filename: 'v',
    type: 'video',
    duration: 900,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  }];
  const clip: Clip = {
    id: 'clip-0',
    assetId: 'v',
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
  project.timeline.clips = [clip];
  return project;
}

type BuildOpts = Parameters<typeof buildFfmpegArgs>[1];

function build(options: BuildOpts): string[] {
  return buildFfmpegArgs(projectWithVideo(), options, 1920, 1080, 30, 300);
}

function filterComplexOf(args: string[]): string {
  const idx = args.indexOf('-filter_complex');
  expect(idx).toBeGreaterThanOrEqual(0);
  return args[idx + 1];
}

describe('HDR model: parseHdrProfile (#59)', () => {
  it('treats an absent profile as the SDR default', () => {
    expect(parseHdrProfile(undefined)).toBe('sdr');
  });

  it('accepts the three known profiles', () => {
    expect(parseHdrProfile('sdr')).toBe('sdr');
    expect(parseHdrProfile('hlg')).toBe('hlg');
    expect(parseHdrProfile('pq')).toBe('pq');
  });

  it('refuses present-but-invalid values instead of downgrading', () => {
    expect(() => parseHdrProfile('HLG')).toThrow(/Invalid HDR profile/);
    expect(() => parseHdrProfile('blue')).toThrow(/Invalid HDR profile/);
    expect(() => parseHdrProfile(42)).toThrow(/Invalid HDR profile/);
    expect(() => parseHdrProfile(null)).toThrow(/Invalid HDR profile/);
    expect(() => parseHdrProfile('')).toThrow(/Invalid HDR profile/);
  });
});

describe('SDR passthrough (absent or sdr profile)', () => {
  it('produces byte-identical args with and without an explicit sdr', () => {
    const omitted = build({ outputPath: 'out.mp4', format: 'mp4', quality: 'normal' });
    const explicit = build({ outputPath: 'out.mp4', format: 'mp4', quality: 'normal', hdr: 'sdr' });
    expect(explicit).toEqual(omitted);
  });

  it('emits no HDR conversion, tags, or 10-bit pixel format', () => {
    const full = build({ outputPath: 'out.mp4', format: 'mp4', quality: 'normal' }).join(' ');
    expect(full).not.toContain('zscale');
    expect(full).not.toContain('-color_primaries');
    expect(full).not.toContain('yuv420p10le');
    expect(full).toContain('libx264');
  });
});

describe('HDR argument emission (#59)', () => {
  it('maps MP4+HLG to HEVC Main10 with 10-bit, hvc1, BT.2020 tags, and a zscale tail', () => {
    const args = build({ outputPath: 'out.mp4', format: 'mp4', quality: 'draft', hdr: 'hlg' });
    // Codec slot: HEVC Main10, quality-tier CRF, 10-bit 4:2:0, QuickTime tag.
    expect(args).toContain('libx265');
    expect(args).toEqual(expect.arrayContaining(['-preset', 'ultrafast', '-crf', '28']));
    expect(args).toEqual(expect.arrayContaining(['-pix_fmt', 'yuv420p10le']));
    expect(args).toEqual(expect.arrayContaining(['-tag:v', 'hvc1']));
    // Container/stream color tags.
    expect(args).toEqual(expect.arrayContaining([
      '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
    ]));
    // The graph converts exactly once, at the end, and is what gets mapped.
    const graph = filterComplexOf(args);
    expect(graph).toContain('zscale=');
    expect(graph).toContain('transfer=arib-std-b67');
    expect(graph).toContain('primaries=bt2020:transfer=arib-std-b67:matrix=bt2020nc');
    expect(graph.split(';').pop()).toContain('zscale=');
    const maps = args.map((a, i) => (a === '-map' ? args[i + 1] : null)).filter(Boolean);
    expect(maps[maps.length - 1]).toBe('[vhdr]');
  });

  it('maps PQ to smpte2084 in both the filter and the tags', () => {
    const args = build({ outputPath: 'out.mp4', format: 'mp4', quality: 'normal', hdr: 'pq' });
    expect(args).toEqual(expect.arrayContaining(['-color_trc', 'smpte2084']));
    expect(filterComplexOf(args)).toContain('transfer=smpte2084');
  });

  it('uses the software HEVC path for MOV too (no ProRes under HDR)', () => {
    const args = build({ outputPath: 'out.mov', format: 'mov', quality: 'high', hdr: 'hlg' });
    expect(args).toContain('libx265');
    expect(args).not.toContain('prores_ks');
    expect(args).toEqual(expect.arrayContaining(['-crf', '16', '-preset', 'slow']));
  });

  it('exposes the codec and tag arg builders for direct assertion', () => {
    expect(hdrVideoCodecArgs('normal')).toEqual([
      '-c:v', 'libx265', '-preset', 'medium', '-crf', '20',
      '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',
    ]);
    expect(hdrColorTagArgs('pq')).toEqual([
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
    ]);
  });
});

describe('HDR refusals (loud, never a silent downgrade)', () => {
  it('refuses WebM', () => {
    expect(() => build({ outputPath: 'out.webm', format: 'webm', quality: 'normal', hdr: 'hlg' }))
      .toThrow(/WebM/);
  });

  it('refuses audio-only', () => {
    expect(() => build({ outputPath: 'out.m4a', format: 'audio', quality: 'normal', hdr: 'pq' }))
      .toThrow(/audio-only/);
  });

  it.each(['nvenc', 'qsv', 'amf'] as const)(
    'refuses MP4 + %s because the wired H.264 path is 8-bit',
    (hw) => {
      expect(() => build({ outputPath: 'out.mp4', format: 'mp4', quality: 'normal', hw, hdr: 'hlg' }))
        .toThrow(/8-bit only/);
    },
  );

  it('accepts the software encoder and MOV regardless of hw (mirrors SDR)', () => {
    expect(() => build({ outputPath: 'out.mp4', format: 'mp4', quality: 'normal', hw: 'x264', hdr: 'hlg' }))
      .not.toThrow();
    expect(() => build({ outputPath: 'out.mov', format: 'mov', quality: 'normal', hw: 'nvenc', hdr: 'hlg' }))
      .not.toThrow();
  });
});

describe('grade-before-HDR rule (grade in Rec.709, convert once at the end)', () => {
  it('keeps the SDR grade chain ahead of a single terminal zscale stage', () => {
    const project = projectWithVideo();
    Object.assign(project.timeline.clips[0]!, {
      brightness: -0.15,
      contrast: 1.3,
      saturation: 0.6,
      hueRotation: 45,
    });
    const args = buildFfmpegArgs(project, {
      outputPath: 'out.mp4', format: 'mp4', quality: 'normal', hdr: 'hlg',
    }, 1920, 1080, 30, 300);

    const segments = filterComplexOf(args).split(';');
    const gradeIdx = segments.findIndex((s) => s.includes('eq=brightness='));
    const zscaleIdx = segments.lastIndexOf(segments.find((s) => s.includes('zscale=')) ?? '');
    // The grade exists, runs inside the clip's own SDR chain, and the HDR
    // conversion is the final segment after it — never interleaved.
    expect(gradeIdx).toBeGreaterThanOrEqual(0);
    expect(zscaleIdx).toBeGreaterThan(gradeIdx);
    expect(zscaleIdx).toBe(segments.length - 1);
    expect(segments[gradeIdx]).not.toContain('zscale=');
    expect(segments[zscaleIdx]).not.toContain('eq=brightness=');
  });
});

describe('SDR/HDR eligibility and timing parity', () => {
  it('selects the same inputs and trim windows under both profiles', () => {
    const project = projectWithVideo();
    const opts = { outputPath: 'out.mp4', format: 'mp4', quality: 'normal' } as const;
    const sdr = buildFfmpegArgs(project, opts, 1920, 1080, 30, 300);
    const hdr = buildFfmpegArgs(project, { ...opts, hdr: 'hlg' }, 1920, 1080, 30, 300);

    const inputs = (args: string[]) =>
      args.filter((arg, index) => args[index - 1] === '-i');
    expect(inputs(hdr)).toEqual(inputs(sdr));

    const trims = (args: string[]) =>
      (filterComplexOf(args).match(/trim=start=[\d.]+:end=[\d.]+/g) ?? []);
    expect(trims(hdr)).toEqual(trims(sdr));
    expect(trims(hdr).length).toBeGreaterThan(0);
  });
});

describe('HDR export end to end (real ffmpeg + ffprobe, #59)', { timeout: REAL_PROCESS_TIMEOUT_MS }, () => {
  let tmpDir = '';
  let srcPath = '';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-hdr-export-'));
    srcPath = path.join(tmpDir, 'src.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=1:r=30',
      '-c:v', 'libx264', '-preset', 'ultrafast', srcPath,
    ]);
  }, REAL_PROCESS_TIMEOUT_MS);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function project(): Project {
    const p = createEmptyProject();
    p.settings.width = 320;
    p.settings.height = 180;
    p.settings.fps = 30;
    p.media = [{
      id: 'v', path: srcPath, filename: 'src', type: 'video',
      duration: 1, fileSize: 1, addedAt: new Date().toISOString(),
    }];
    p.timeline.clips = [{
      id: 'clip-0', assetId: 'v', type: 'video', trackId: 'v1',
      startFrame: 0, durationFrames: 30, inPoint: 0, outPoint: 30,
      x: 0, y: 0, width: 320, height: 180, rotation: 0,
      scaleX: 1, scaleY: 1, opacity: 1, anchorX: 0, anchorY: 0,
      volume: 1, muted: false,
    }];
    return p;
  }

  function encodeOptions(outputPath: string, hdr?: 'hlg' | 'pq') {
    return {
      outputPath,
      format: 'mp4' as const,
      quality: 'draft' as const,
      ...(hdr ? { hdr } : {}),
    };
  }

  async function probeStream(file: string): Promise<Record<string, string>> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries',
      'stream=codec_name,codec_tag_string,pix_fmt,color_primaries,color_transfer,color_space',
      '-of', 'json', file,
    ]);
    const parsed = JSON.parse(stdout) as { streams?: Array<Record<string, string>> };
    return parsed.streams?.[0] ?? {};
  }

  // Registered only when the local FFmpeg cannot do 10-bit HDR: the proofs
  // below are then absent, and this passing test names the exact reason.
  if (HDR_SKIP !== null) {
    it(`HDR encodes skipped: ${HDR_SKIP}`, () => {
      expect(HDR_SKIP).toBeTruthy();
    });
  }

  it.runIf(HDR_SKIP === null)('SDR baseline: 8-bit output with no HDR tags', async () => {
    const outputPath = path.join(tmpDir, 'sdr.mp4');
    await execFileAsync('ffmpeg', buildFfmpegArgs(
      project(), encodeOptions(outputPath), 320, 180, 30, 30,
    ));
    expect((await fs.stat(outputPath)).size).toBeGreaterThan(0);

    const stream = await probeStream(outputPath);
    expect(stream.pix_fmt).toBe('yuv420p');
    expect(stream.color_primaries).not.toBe('bt2020');
    expect(stream.color_transfer).not.toBe('arib-std-b67');
    expect(stream.color_transfer).not.toBe('smpte2084');
    expect(stream.color_space).not.toBe('bt2020nc');
  });

  it.runIf(HDR_SKIP === null)('HLG encode: HEVC Main10 tagged bt2020/arib-std-b67/bt2020nc', async () => {
    const outputPath = path.join(tmpDir, 'hlg.mp4');
    await execFileAsync('ffmpeg', buildFfmpegArgs(
      project(), encodeOptions(outputPath, 'hlg'), 320, 180, 30, 30,
    ));
    expect((await fs.stat(outputPath)).size).toBeGreaterThan(0);

    const stream = await probeStream(outputPath);
    expect(stream.codec_name).toBe('hevc');
    expect(stream.codec_tag_string).toBe('hvc1');
    expect(stream.pix_fmt).toBe('yuv420p10le');
    expect(stream.color_primaries).toBe('bt2020');
    expect(stream.color_transfer).toBe('arib-std-b67');
    expect(stream.color_space).toBe('bt2020nc');
  });

  it.runIf(HDR_SKIP === null)('PQ encode: smpte2084 transfer on the same tags', async () => {
    const outputPath = path.join(tmpDir, 'pq.mp4');
    await execFileAsync('ffmpeg', buildFfmpegArgs(
      project(), encodeOptions(outputPath, 'pq'), 320, 180, 30, 30,
    ));
    expect((await fs.stat(outputPath)).size).toBeGreaterThan(0);

    const stream = await probeStream(outputPath);
    expect(stream.pix_fmt).toBe('yuv420p10le');
    expect(stream.color_primaries).toBe('bt2020');
    expect(stream.color_transfer).toBe('smpte2084');
    expect(stream.color_space).toBe('bt2020nc');
  });
});
