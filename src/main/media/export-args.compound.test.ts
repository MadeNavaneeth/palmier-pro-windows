/**
 * Compound-clip export agreement (upstream issue #155, slice 1).
 *
 * Preview and export share `resolveRenderTimeline`, so a nested timeline
 * must produce byte-identical FFmpeg arguments to its flattened twin — the
 * graph cannot disagree about what is in the render. The suite then proves
 * the nested graph actually encodes with a real FFmpeg 8.1.2 run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';
import { selectExportClips } from '../../shared/media/export-eligibility';
import { planFlatten, planNest, resolveRenderTimeline } from '../../shared/editor/compound';
import { EditorController } from '../../shared/editor/controller';
import { buildFfmpegArgs } from './export-args';

const execFileAsync = promisify(execFile);

// Real encodes are subprocess-bound; keep their timeout explicit so a loaded
// parallel run does not inherit the 5 s default used by fast unit tests.
const REAL_PROCESS_TIMEOUT_MS = 30_000;

let clipSeq = 0;

function videoClip(overrides: Partial<Clip> = {}): Clip {
  clipSeq += 1;
  return {
    id: `clip-${clipSeq}`,
    assetId: 'v',
    type: 'video',
    trackId: 'v1',
    startFrame: 0,
    durationFrames: 30,
    inPoint: 0,
    outPoint: 30,
    x: 0,
    y: 0,
    width: 320,
    height: 240,
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

describe('compound export agreement', () => {
  let tmpDir = '';
  let srcPath = '';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-compound-export-'));
    srcPath = path.join(tmpDir, 'src.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=30',
      '-pix_fmt', 'yuv420p', srcPath,
    ]);
  }, REAL_PROCESS_TIMEOUT_MS);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function nestedProject(): Project {
    const project = createEmptyProject();
    project.settings.width = 320;
    project.settings.height = 240;
    project.media = [{
      id: 'v', path: srcPath, filename: 'src.mp4', type: 'video',
      duration: 90, width: 320, height: 240, fileSize: 1,
      addedAt: new Date().toISOString(),
    }];
    project.timeline.clips = [
      videoClip({ id: 'a', startFrame: 0, durationFrames: 30, inPoint: 0, outPoint: 30 }),
      videoClip({ id: 'b', startFrame: 30, durationFrames: 30, inPoint: 10, outPoint: 40, x: 20 }),
    ];
    return planNest(project, ['a', 'b'], { name: 'Nest' }).project;
  }

  function graphFor(project: Project): string[] {
    return buildFfmpegArgs(
      project,
      { outputPath: path.join(tmpDir, 'out.mp4'), format: 'mp4', quality: 'draft' },
      320, 240, 30, 60,
    );
  }

  it('selects the same export clips nested as flattened', () => {
    const nested = nestedProject();
    const flat = planFlatten(nested, nested.timeline.clips[0].id).project;
    const shape = (project: Project) =>
      selectExportClips({ ...project, timeline: resolveRenderTimeline(project) })
        .map((clip) => [clip.startFrame, clip.durationFrames, clip.inPoint, clip.assetId].join(':'))
        .sort();
    expect(shape(nested)).toEqual(shape(flat));
  });

  it('emits identical FFmpeg arguments nested as flattened', () => {
    const nested = nestedProject();
    const flat = planFlatten(nested, nested.timeline.clips[0].id).project;
    const nestedArgs = graphFor(nested);
    const flatArgs = graphFor(flat);
    // Output paths are per-call; everything else — inputs, filter graph,
    // maps, codec flags — must agree exactly.
    const scrub = (args: string[]) => args.map((arg) => (arg.endsWith('.mp4') ? '<out>' : arg));
    expect(scrub(nestedArgs)).toEqual(scrub(flatArgs));
  });

  it('encodes the nested graph end to end (real ffmpeg)', async () => {
    const outputPath = path.join(tmpDir, 'nested.mp4');
    const args = buildFfmpegArgs(
      nestedProject(),
      { outputPath, format: 'mp4', quality: 'draft' },
      320, 240, 30, 60,
    );
    await execFileAsync('ffmpeg', args);
    const stat = await fs.stat(outputPath);
    expect(stat.size).toBeGreaterThan(0);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('encodes the flattened twin end to end (real ffmpeg)', async () => {
    const nested = nestedProject();
    const flat = planFlatten(nested, nested.timeline.clips[0].id).project;
    const outputPath = path.join(tmpDir, 'flat.mp4');
    const args = buildFfmpegArgs(
      flat,
      { outputPath, format: 'mp4', quality: 'draft' },
      320, 240, 30, 60,
    );
    await execFileAsync('ffmpeg', args);
    const stat = await fs.stat(outputPath);
    expect(stat.size).toBeGreaterThan(0);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('ignores the open editing scope: args with a nest open equal args at root', () => {
    // Slice 2 pin on the delivery rule: the editing scope lives beside the
    // project (never inside it), so opening a nest cannot move the export.
    const ctrl = new EditorController(nestedProject());
    const closed = graphFor(ctrl.getProject());
    ctrl.openCompoundClip(ctrl.getClips()[0].id);
    expect(ctrl.getActiveTimelineId()).not.toBeNull();
    const opened = graphFor(ctrl.getProject());
    expect(opened).toEqual(closed);
  });
});
