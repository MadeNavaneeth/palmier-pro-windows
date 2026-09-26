/**
 * Shape clip export coverage: baked-box compositing, motion expressions,
 * fades/opacity, missing-bake skip, label sequencing with titles, and a
 * real-ffmpeg run proving the emitted graph encodes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
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

function projectWithShapes(clips: Partial<Clip>[]): Project {
  const project = createEmptyProject();
  project.settings.width = 320;
  project.settings.height = 240;
  const base: Clip = {
    id: 'shape-0',
    assetId: '__shape__',
    type: 'shape',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 60,
    inPoint: 0,
    outPoint: 60,
    x: 10,
    y: 20,
    width: 200,
    height: 120,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 0,
    anchorY: 0,
    volume: 1,
    muted: false,
    shapeKind: 'arrow',
    shapeStrokeColor: '#ff0000',
    shapeStrokeWidth: 6,
  };
  project.timeline.clips = clips.map((overrides, index) => ({
    ...base,
    id: `shape-${index}`,
    ...overrides,
  }));
  return project;
}

function build(
  project: Project,
  options?: { bakedTitles?: Array<{ clipId: string; path: string }>; outputPath?: string },
  warnings?: string[],
): string[] {
  return buildFfmpegArgs(
    project,
    {
      outputPath: options?.outputPath ?? 'out.mp4',
      format: 'mp4',
      quality: 'draft',
      ...(options?.bakedTitles ? { bakedTitles: options.bakedTitles } : {}),
    },
    320,
    240,
    30,
    60,
    warnings,
  );
}

describe('shape export emission', () => {
  it('composites a baked box still at the clip box with a time gate', () => {
    const project = projectWithShapes([{}]);
    const args = build(project, {
      bakedTitles: [{ clipId: 'shape-0', path: 'C:/baked/shape-0.png' }],
    });
    const graph = args.find((arg) => arg.includes('[sh0]'))!;
    expect(graph).toContain("[1:v]format=rgba,scale='200':'120':flags=bicubic[sh0]");
    expect(graph).toContain("[0:v][sh0]overlay=x='10':y='20':eof_action=pass");
    expect(graph).toContain("enable='between(t,0.0000,2.0000)'");
    expect(graph).not.toContain('drawtext');

    // The still streams as a loop so the node never starves mid-export.
    const inputPos = args.indexOf('C:/baked/shape-0.png');
    expect(args[inputPos - 1]).toBe('-i');
    expect(args[inputPos - 2]).toBe('1');
  });

  it('drives position, scale, and rotation from motion tracks', () => {
    const project = projectWithShapes([{
      motionX: [{ frame: 0, value: 10 }, { frame: 30, value: 110 }],
      motionScaleX: [{ frame: 0, value: 1 }, { frame: 30, value: 2 }],
      motionRot: [{ frame: 0, value: 0 }, { frame: 30, value: 90 }],
    }]);
    const graph = build(project, {
      bakedTitles: [{ clipId: 'shape-0', path: 'C:/baked/shape-0.png' }],
    }).find((arg) => arg.includes('[sh0]'))!;
    expect(graph).toContain("overlay=x='if(lte(t,1.000000)");
    expect(graph).toContain("scale='(200.0)*(if(lte(t,1.000000)");
    expect(graph).toContain("rotate='(if(lte(t,1.000000)");
    expect(graph).toContain('PI/180');
  });

  it('rides opacity and absolute-time alpha fades on the bake', () => {
    const project = projectWithShapes([{
      opacity: 0.5, fadeInFrames: 15, fadeOutFrames: 15,
    }]);
    const graph = build(project, {
      bakedTitles: [{ clipId: 'shape-0', path: 'C:/baked/shape-0.png' }],
    }).find((arg) => arg.includes('[sh0]'))!;
    expect(graph).toContain('colorchannelmixer=aa=0.5000');
    expect(graph).toContain('fade=t=in:st=0.0000:d=0.5000:alpha=1');
    expect(graph).toContain('fade=t=out:st=1.5000:d=0.5000:alpha=1');
  });

  it('emits a static rotate filter for statically rotated shapes', () => {
    const project = projectWithShapes([{ rotation: 45 }]);
    const graph = build(project, {
      bakedTitles: [{ clipId: 'shape-0', path: 'C:/baked/shape-0.png' }],
    }).find((arg) => arg.includes('[sh0]'))!;
    expect(graph).toContain("rotate='(45.000000)*PI/180':c=black@0");
  });

  it('skips a shape with no bake without failing the export, and reports it', () => {
    const project = projectWithShapes([{ label: 'Callout arrow' }]);
    const warnings: string[] = [];
    const args = build(project, undefined, warnings);
    expect(args.join(' ')).not.toContain('[sh0]');
    expect(args).toContain('out.mp4');
    // A vector shape has no filter fallback, so the skip is a lost layer —
    // it must be named, not dropped in silence.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Shape clip "Callout arrow" \(arrow\)/);
    expect(warnings[0]).toMatch(/left out of the render/);
  });

  it('reports nothing for a shape that has its bake', () => {
    const project = projectWithShapes([{ label: 'Callout arrow' }]);
    const warnings: string[] = [];
    build(project, { bakedTitles: [{ clipId: 'shape-0', path: 'C:/baked/shape-0.png' }] }, warnings);
    expect(warnings).toEqual([]);
  });

  it('sequences shape and title overlays through one label chain', () => {
    const project = projectWithShapes([
      { id: 'shape-0', type: 'shape', startFrame: 0, durationFrames: 30 },
    ]);
    project.timeline.clips.push({
      ...(project.timeline.clips[0] as Clip),
      id: 'title-0',
      type: 'title',
      assetId: '__title__',
      startFrame: 30,
      durationFrames: 30,
      text: 'Card',
    });
    const args = build(project, {
      bakedTitles: [{ clipId: 'shape-0', path: 'C:/baked/shape-0.png' }],
    });
    const full = args.join(' ');
    expect(full).toContain('[sh0]');
    expect(full).toContain('[vt0]');
    expect(full).toContain('drawtext');
    expect(full).toContain('[vt1]');
    expect(full).toContain('-map');
  });
});

describe('shape export end to end (real ffmpeg)', { timeout: REAL_PROCESS_TIMEOUT_MS }, () => {
  let tmpDir = '';
  let bakePath = '';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-shape-export-'));
    bakePath = path.join(tmpDir, 'shape-0.png');
    // Stand-in bake: a real PNG of the clip's box size.
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=red:s=200x120:d=1',
      '-frames:v', '1', bakePath,
    ]);
  }, REAL_PROCESS_TIMEOUT_MS);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('encodes a shape overlay with motion, opacity, and fades', async () => {
    const project = projectWithShapes([{
      motionX: [{ frame: 0, value: 10 }, { frame: 30, value: 60 }],
      opacity: 0.8,
      fadeInFrames: 10,
      fadeOutFrames: 10,
    }]);
    const outputPath = path.join(tmpDir, 'shape.mp4');
    const args = build(project, {
      outputPath,
      bakedTitles: [{ clipId: 'shape-0', path: bakePath }],
    });
    await execFileAsync('ffmpeg', args);
    const stat = await fs.stat(outputPath);
    expect(stat.size).toBeGreaterThan(0);
  });
});
