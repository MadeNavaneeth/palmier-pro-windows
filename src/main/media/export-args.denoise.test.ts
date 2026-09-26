/**
 * Noise reduction export (#165): `afftdn` emission (value, position — first
 * filter after the trim's PTS reset, ahead of pan/EQ/compressor/volume so
 * the chain matches the preview's denoise-before-panner order), hostile
 * omission, the two mapping regressions this feature exposed (audio-only
 * exports must emit `-filter_complex`; mixed exports must map both
 * `[vout]` and the audio graph), and a real FFmpeg encode proof that skips
 * with a reported reason when the local FFmpeg has no `afftdn`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';
import { buildFfmpegArgs } from './export-args';

const execFileAsync = promisify(execFile);

// Real encodes are subprocess-bound; keep their timeout explicit so a loaded
// parallel run does not inherit the 5 s default used by fast unit tests.
const REAL_PROCESS_TIMEOUT_MS = 30_000;

/**
 * Probe once whether the local FFmpeg can deliver the afftdn slice: the
 * filter itself plus a real smoke encode. Non-null = why the real-encode
 * proof below is skipped (reported by the named skip test, HDR-style).
 */
const DENOISE_SKIP: string | null = (() => {
  let filters: string;
  try {
    filters = execFileSync('ffmpeg', ['-hide_banner', '-filters'], {
      encoding: 'utf8', windowsHide: true,
    });
  } catch {
    return 'ffmpeg is not on PATH';
  }
  if (!/\bafftdn\b/.test(filters)) return 'ffmpeg lacks the afftdn filter';
  try {
    execFileSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:r=48000:d=0.3',
      '-af', 'afftdn=nr=14.40',
      '-c:a', 'aac', '-b:a', '128k', '-f', 'null', os.devNull,
    ], { encoding: 'utf8', windowsHide: true });
  } catch {
    return 'afftdn=nr=14.40 failed a smoke encode on this build';
  }
  return null;
})();

function audioProject(clipOverrides: Partial<Clip> = {}, assetPath = 'C:/media/noise.wav'): Project {
  const project = createEmptyProject();
  project.media = [{
    id: 'a',
    path: assetPath,
    filename: 'noise.wav',
    type: 'audio',
    duration: 3,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  }];
  project.timeline.clips = [{
    id: 'clip-0',
    assetId: 'a',
    type: 'audio',
    trackId: 'a1',
    startFrame: 0,
    durationFrames: 60,
    inPoint: 0,
    outPoint: 60,
    x: 0, y: 0, width: 1, height: 1, rotation: 0,
    scaleX: 1, scaleY: 1, opacity: 1, anchorX: 0, anchorY: 0,
    volume: 1, muted: false,
    ...clipOverrides,
  }];
  return project;
}

function mixedProject(): Project {
  const project = createEmptyProject();
  project.media = [
    {
      id: 'v', path: 'C:/media/v.mp4', filename: 'v.mp4', type: 'video',
      duration: 900, width: 320, height: 240, fileSize: 1,
      addedAt: new Date().toISOString(),
    },
    {
      id: 'a', path: 'C:/media/a.mp3', filename: 'a.mp3', type: 'audio',
      duration: 900, fileSize: 1, addedAt: new Date().toISOString(),
    },
  ];
  project.timeline.clips = [
    {
      id: 'clip-v', assetId: 'v', type: 'video', trackId: 'v1',
      startFrame: 0, durationFrames: 60, inPoint: 0, outPoint: 60,
      x: 0, y: 0, width: 320, height: 240, rotation: 0,
      scaleX: 1, scaleY: 1, opacity: 1, anchorX: 0, anchorY: 0,
      volume: 1, muted: false,
    },
    {
      id: 'clip-a', assetId: 'a', type: 'audio', trackId: 'a1',
      startFrame: 0, durationFrames: 60, inPoint: 0, outPoint: 60,
      x: 0, y: 0, width: 1, height: 1, rotation: 0,
      scaleX: 1, scaleY: 1, opacity: 1, anchorX: 0, anchorY: 0,
      volume: 1, muted: false,
    },
  ];
  return project;
}

function buildAudio(project: Project, outputPath = 'out.m4a'): string[] {
  return buildFfmpegArgs(
    project,
    { outputPath, format: 'audio', quality: 'normal' },
    320, 240, 30, 60,
  );
}

describe('noise reduction argument emission (#165)', () => {
  it('emits afftdn first: right after the PTS reset, ahead of pan/EQ/compressor/volume', () => {
    const project = audioProject({
      noiseReduction: 60,
      pan: 0.5,
      eqLowDb: 3,
      volume: 0.5,
      compressor: { thresholdDb: -18, ratio: 4, attackMs: 20, releaseMs: 250, makeupDb: 0 },
    });
    const args = buildAudio(project);
    const graph = args[args.indexOf('-filter_complex') + 1];

    // Pin the preview-mirroring order: denoise runs on the trimmed signal
    // before any routing/level stage, exactly like the preview's biquads
    // sit ahead of the panner.
    expect(graph).toContain('asetpts=PTS-STARTPTS,afftdn=nr=14.40,');
    expect(graph).toContain('pan=stereo');
    expect(graph).toContain('bass=g=+3');
    expect(graph).toContain('acompressor=');
    expect(graph).toContain('volume=0.5000');
    const denoiseAt = graph.indexOf('afftdn=nr=14.40');
    expect(denoiseAt).toBeLessThan(graph.indexOf('pan=stereo'));
    expect(denoiseAt).toBeLessThan(graph.indexOf('bass=g=+3'));
    expect(denoiseAt).toBeLessThan(graph.indexOf('acompressor='));
    expect(denoiseAt).toBeLessThan(graph.indexOf('volume=0.5000'));
  });

  it('omits afftdn when the field is absent (off is exact parity)', () => {
    const args = buildAudio(audioProject());
    expect(args.join(' ')).not.toContain('afftdn');
  });

  it.each([0, Number.NaN, 150, '60', -5])(
    'omits afftdn for hostile/off value %p',
    (value) => {
      const args = buildAudio(audioProject({ noiseReduction: value as never }));
      expect(args.join(' ')).not.toContain('afftdn');
    },
  );
});

describe('export mapping regressions (pre-existing, exposed by #165)', () => {
  it('audio-only exports emit -filter_complex alongside the [a0] map', () => {
    // Regression: the filter_complex push lived inside the !audioOnly
    // branch, so FFmpeg saw -map [a0] with no graph and failed with
    // "Output with label 'a0' does not exist in any defined filter graph".
    const args = buildAudio(audioProject({ noiseReduction: 60 }));
    const fcAt = args.indexOf('-filter_complex');
    expect(fcAt).toBeGreaterThan(0);
    // Audio-only sources start at input 0 (no canvas), so the chain must
    // reference [0:a] — a 1-based index would dangle ("Invalid file index").
    expect(args[fcAt + 1]).toContain('[0:a]atrim');
    expect(args[fcAt + 1]).toContain('afftdn=nr=14.40');
    const maps = args.filter((arg, i) => args[i - 1] === '-map');
    expect(maps).toEqual(['[a0]']);
    expect(args.indexOf('-map')).toBeGreaterThan(fcAt);
  });

  it('mixed video+audio exports map both [vout] and the audio graph', () => {
    // Regression: only [vout] was mapped, leaving the [a0] chain
    // unconnected — FFmpeg failed with "Filter 'asetpts:default' has
    // output 1 (a0) unconnected".
    const args = buildFfmpegArgs(
      mixedProject(),
      { outputPath: 'out.mp4', format: 'mp4', quality: 'normal' },
      320, 240, 30, 60,
    );
    expect(args).toContain('-filter_complex');
    const maps = args.filter((arg, i) => args[i - 1] === '-map');
    expect(maps).toEqual(['[vout]', '[a0]']);
  });
});

describe('noise reduction end to end (real ffmpeg, #165)', { timeout: REAL_PROCESS_TIMEOUT_MS }, () => {
  let tmpDir = '';
  let noisePath = '';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-denoise-export-'));
    noisePath = path.join(tmpDir, 'noise.wav');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:r=48000:d=3',
      '-ac', '2', noisePath,
    ]);
  }, REAL_PROCESS_TIMEOUT_MS);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Registered only when the local FFmpeg cannot run afftdn: the proof
  // below is then absent, and this passing test names the exact reason.
  if (DENOISE_SKIP !== null) {
    it(`noise reduction encode skipped: ${DENOISE_SKIP}`, () => {
      expect(DENOISE_SKIP).toBeTruthy();
    });
  }

  it.runIf(DENOISE_SKIP === null)(
    'encodes a denoised audio-only export through afftdn',
    async () => {
      const outputPath = path.join(tmpDir, 'denoised.m4a');
      const args = buildAudio(audioProject({ noiseReduction: 60 }, noisePath), outputPath);
      await execFileAsync('ffmpeg', args);
      expect((await fs.stat(outputPath)).size).toBeGreaterThan(0);
    },
  );

  it.runIf(DENOISE_SKIP === null)(
    'encodes an off audio-only export without any denoise filter',
    async () => {
      const outputPath = path.join(tmpDir, 'clean.m4a');
      const args = buildAudio(audioProject({}, noisePath), outputPath);
      expect(args.join(' ')).not.toContain('afftdn');
      await execFileAsync('ffmpeg', args);
      expect((await fs.stat(outputPath)).size).toBeGreaterThan(0);
    },
  );
});
