/**
 * Caption sidecar cues across compound clips (upstream issue #155 territory,
 * caption-path slice).
 *
 * The defect: the video path resolves the render timeline, so a title inside a
 * compound clip is composited into the picture, but the `.vtt` sidecar was
 * built from the UNRESOLVED `project.timeline.clips`. A nested title therefore
 * burned into the video while its cue was missing from the file beside it —
 * and when the nested title was the project's only title, the export panel's
 * `hasTitles` gate (which read the same unresolved list) suppressed the
 * sidecar entirely. Both call sites now read `resolveRenderTimeline`, so one
 * timeline decides what is drawn and what is captioned.
 *
 * FFmpeg spawns are mocked — no encoder runs here. What this pins:
 *  - a nested title produces a cue at its parent-timeline frame,
 *  - a trimmed compound window shifts the cue by exactly the window offset,
 *  - a top-level title and a nested title both appear, once each,
 *  - two levels of nesting resolve, timing against the root timeline,
 *  - the FFmpeg argv is exactly what the pure argument builder produces, so
 *    the caption fix cannot have moved the picture.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project, Timeline, Track } from '../../shared/types/project';
import { selectExportClips } from '../../shared/media/export-eligibility';
import { resolveRenderTimeline, MAX_COMPOUND_DEPTH } from '../../shared/editor/compound';
import { parseVtt } from '../../shared/editor/vtt-parse';
import { buildFfmpegArgs } from './export-args';
import { Exporter } from './exporter';

const { spawned, spawn } = vi.hoisted(() => {
  const spawned: Array<{ args: string[]; proc: any }> = [];
  // Stand-in ChildProcess: registration only — `close` is emitted by the test.
  const spawn = (_bin: string, args: string[]) => {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const proc: any = {
      args,
      kill: () => {},
      stderr: { on: () => proc.stderr },
      on: (event: string, cb: (...args: any[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
      },
      emit: (event: string, ...args: any[]) => {
        for (const cb of handlers.get(event) ?? []) cb(...args);
      },
    };
    spawned.push({ args, proc });
    return proc;
  };
  return { spawned, spawn };
});

vi.mock('child_process', () => ({ spawn }));
vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  BrowserWindow: { fromWebContents: () => null },
  shell: { showItemInFolder: () => {} },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  app: undefined,
  default: {},
}));

const TMP = path.join(os.tmpdir(), `palmier-exporter-captions-${process.pid}`);
const SOURCE = path.join(TMP, 'src.mp4');
const FPS = 30;

/**
 * Cue times are compared in whole milliseconds: the sidecar is a text format
 * rounded to ms, so a cue is only defined to that precision.
 */
const ms = (frame: number): number => Math.round((frame / FPS) * 1000);

/** [startFrame, endFrame, text] in ROOT-timeline frames, as parsed cues. */
const cue = (startFrame: number, endFrame: number, text: string) =>
  ({ start: ms(startFrame), end: ms(endFrame), text });

const parsed = (cues: ReturnType<typeof parseVtt>) => cues.map((c) => ({
  start: Math.round(c.startSec * 1000),
  end: Math.round(c.endSec * 1000),
  text: c.text,
}));

function track(id: string, order: number): Track {
  return { id, name: id.toUpperCase(), type: 'video', locked: false, visible: true, syncLocked: true, order };
}

let clipSeq = 0;
function clip(overrides: Partial<Clip> = {}): Clip {
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
    ...overrides,
  };
}

function compound(overrides: Partial<Clip> & { timelineId: string }): Clip {
  const { timelineId, ...rest } = overrides;
  return clip({
    type: 'compound',
    assetId: '__compound__',
    inPoint: 0,
    durationFrames: 30,
    outPoint: 30,
    label: 'Nest',
    ...rest,
    compoundTimelineId: timelineId,
  });
}

function title(overrides: Partial<Clip> & { text: string }): Clip {
  return clip({ type: 'title', assetId: '__title__', trackId: 't1', ...overrides });
}

/** Main timeline with a 0–60 video bed plus a title track and a nest track. */
function baseProject(): Project {
  const project = createEmptyProject();
  project.media = [{
    id: 'v', path: SOURCE, filename: 'src.mp4', type: 'video', duration: 600,
    width: 1920, height: 1080, fileSize: 1, addedAt: new Date().toISOString(),
  }];
  project.timeline.tracks = [track('v1', 1), track('t1', 2), track('v2', 3)];
  project.timeline.clips = [clip({ id: 'bed', startFrame: 0, durationFrames: 60, inPoint: 0, outPoint: 60 })];
  return project;
}

function nested(clips: Clip[], name: string): Timeline {
  return { tracks: [track('v1', 1), track('t1', 2)], clips, playheadFrame: 0, name };
}

/** Main-frame 100 compound over n1, holding one title at nested frame 10. */
function nestedTitleProject(): Project {
  const project = baseProject();
  project.timeline.clips.push(
    compound({ id: 'nest', timelineId: 'n1', trackId: 'v2', startFrame: 100, durationFrames: 30, outPoint: 30 }),
  );
  project.timelines = {
    n1: nested(
      [title({ id: 'inner-title', startFrame: 10, durationFrames: 20, inPoint: 0, outPoint: 20, text: 'Nested caption' })],
      'Nest',
    ),
  };
  return project;
}

/**
 * Run one export to completion and read the sidecar back. Returns the parsed
 * cues (empty when the file holds none) plus the argv FFmpeg was given.
 */
async function runExport(
  project: Project,
  name: string,
  exportCaptions: boolean,
): Promise<{ cues: ReturnType<typeof parseVtt>; argv: string[]; sidecarExists: boolean }> {
  const outputPath = path.join(TMP, `${name}.mp4`);
  const base = spawned.length;
  const run = new Exporter().export(
    project,
    { outputPath, format: 'mp4', quality: 'draft', exportCaptions },
    { send: vi.fn() },
    `owner-${name}`,
  );
  const entry = spawned[base]!;
  // The video lands first; the sidecar is written after the file is verified.
  await fsp.writeFile(outputPath, Buffer.from('rendered'));
  entry.proc.emit('close', 0);
  await run;

  const vttPath = path.join(TMP, `${name}.vtt`);
  const exists = await fsp.stat(vttPath).then(() => true, () => false);
  return {
    cues: exists ? parseVtt(await fsp.readFile(vttPath, 'utf8')) : [],
    argv: entry.args,
    sidecarExists: exists,
  };
}

beforeAll(async () => {
  await fsp.mkdir(TMP, { recursive: true });
  await fsp.writeFile(SOURCE, Buffer.from('fake-media'));
});

afterAll(async () => {
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe('caption cues from nested timelines', () => {
  it('captions a title whose only home is inside a compound', async () => {
    const { cues, argv } = await runExport(nestedTitleProject(), 'nested-only', true);

    // Offset by the compound's position on the parent timeline: 100 + 10.
    expect(parsed(cues)).toEqual([cue(110, 130, 'Nested caption')]);
    // The very same cue is burned into the picture — this is the disagreement
    // the sidecar used to have with its own video.
    expect(argv.join(' ')).toContain('Nested caption');
    expect(argv.join(' ')).toContain(`between(t,${(110 / FPS).toFixed(4)},${(130 / FPS).toFixed(4)})`);
  });

  it('offsets a nested cue by the compound’s trimmed window', async () => {
    const project = baseProject();
    // A 60-frame window over nested frames [30, 90), landing 40 frames into the
    // parent timeline: nested frame f renders at f - 30 + 40 = f + 10.
    project.timeline.clips.push(compound({
      id: 'nest', timelineId: 'n1', trackId: 'v2',
      startFrame: 40, inPoint: 30, outPoint: 90, durationFrames: 60,
    }));
    project.timelines = {
      n1: nested(
        [title({ id: 'inner-title', startFrame: 40, durationFrames: 30, inPoint: 0, outPoint: 30, text: 'Trimmed window' })],
        'Nest',
      ),
    };

    const { cues } = await runExport(project, 'trimmed', true);

    expect(parsed(cues)).toEqual([cue(50, 80, 'Trimmed window')]);
  });

  it('captions a top-level title and a nested title once each', async () => {
    const project = baseProject();
    project.timeline.clips.push(
      title({ id: 'top-title', startFrame: 10, durationFrames: 20, inPoint: 0, outPoint: 20, text: 'Top caption' }),
      compound({ id: 'nest', timelineId: 'n1', trackId: 'v2', startFrame: 100, durationFrames: 30, outPoint: 30 }),
    );
    project.timelines = {
      n1: nested(
        [title({ id: 'inner-title', startFrame: 10, durationFrames: 20, inPoint: 0, outPoint: 20, text: 'Nested caption' })],
        'Nest',
      ),
    };

    const { cues } = await runExport(project, 'both', true);

    expect(parsed(cues)).toEqual([cue(10, 30, 'Top caption'), cue(110, 130, 'Nested caption')]);
  });

  it('resolves two levels of nesting, timing the cue against the root timeline', async () => {
    const project = baseProject();
    // main frame 100 → n1 frame 0 → n2 frame 5.
    project.timeline.clips.push(
      compound({ id: 'outer', timelineId: 'n1', trackId: 'v2', startFrame: 100, durationFrames: 30, outPoint: 30 }),
    );
    project.timelines = {
      n1: nested(
        [compound({
          id: 'inner', timelineId: 'n2', trackId: 'v1',
          startFrame: 0, inPoint: 0, outPoint: 20, durationFrames: 20,
        })],
        'Outer',
      ),
      n2: nested(
        [title({ id: 'deep-title', startFrame: 5, durationFrames: 10, inPoint: 0, outPoint: 10, text: 'Deep caption' })],
        'Inner',
      ),
    };

    const { cues } = await runExport(project, 'deep', true);

    expect(parsed(cues)).toEqual([cue(105, 115, 'Deep caption')]);
  });

  it('caps depth exactly where the render does, not on its own limit', async () => {
    // A hand-edited project nested past MAX_COMPOUND_DEPTH: the render skips
    // the over-deep branch, so the sidecar must skip its cues too. Both read
    // one resolver, so the two answers cannot drift apart.
    const project = baseProject();
    let timelineId = 'n0';
    project.timeline.clips.push(
      compound({ id: 'root-nest', timelineId, trackId: 'v2', startFrame: 0, durationFrames: 30, outPoint: 30 }),
    );
    project.timelines = {};
    for (let depth = 0; depth < MAX_COMPOUND_DEPTH + 1; depth += 1) {
      const nextId = `n${depth + 1}`;
      project.timelines[timelineId] = nested(
        [compound({
          id: `nest-${depth}`, timelineId: nextId, trackId: 'v1',
          startFrame: 0, inPoint: 0, outPoint: 30, durationFrames: 30,
        })],
        `Depth ${depth}`,
      );
      timelineId = nextId;
    }
    project.timelines[timelineId] = nested(
      [title({ id: 'too-deep', startFrame: 0, durationFrames: 30, inPoint: 0, outPoint: 30, text: 'Too deep' })],
      'Too deep',
    );

    const resolved = resolveRenderTimeline(project).clips;
    const { cues } = await runExport(project, 'too-deep', true);

    expect(resolved.some((c) => c.type === 'title')).toBe(false);
    expect(parsed(cues)).toEqual([]);
  });

  it('drops a cue the render cannot reach, and leaves the rest intact', async () => {
    const project = baseProject();
    // The compound's window excludes the nested title, so nothing of it is on
    // screen and the sidecar must not claim a caption that never appears.
    project.timeline.clips.push(
      title({ id: 'top-title', startFrame: 10, durationFrames: 20, inPoint: 0, outPoint: 20, text: 'Top caption' }),
      compound({ id: 'nest', timelineId: 'n1', trackId: 'v2', startFrame: 100, inPoint: 0, outPoint: 10, durationFrames: 10 }),
    );
    project.timelines = {
      n1: nested(
        [title({ id: 'inner-title', startFrame: 20, durationFrames: 20, inPoint: 0, outPoint: 20, text: 'Offscreen caption' })],
        'Nest',
      ),
    };

    const { cues } = await runExport(project, 'trimmed-out', true);

    expect(parsed(cues)).toEqual([cue(10, 30, 'Top caption')]);
  });

  it('leaves a project with no titles as it was: no cues, no sidecar', async () => {
    const project = baseProject();
    project.timeline.clips.push(
      compound({ id: 'nest', timelineId: 'n1', trackId: 'v2', startFrame: 100, durationFrames: 30, outPoint: 30 }),
    );
    project.timelines = {
      n1: nested([clip({ id: 'inner-video', startFrame: 0, durationFrames: 30, trackId: 'v1' })], 'Nest'),
    };

    // Captions not requested (what the panel's gate sends for this project).
    const off = await runExport(project, 'no-titles-off', false);
    expect(off.cues).toEqual([]);
    expect(off.sidecarExists).toBe(false);
    expect(off.argv.length).toBeGreaterThan(0);

    // Requested anyway: a sidecar with no cues, exactly as before the fix.
    const on = await runExport(project, 'no-titles-on', true);
    expect(on.cues).toEqual([]);
  });

  it('leaves the FFmpeg graph exactly as the argument builder produces it', async () => {
    // The caption fix reads one more (already computed) timeline; it must not
    // reach the picture. Pinned against the pure builder for the project whose
    // only title is nested, where video and sidecar used to disagree.
    const project = nestedTitleProject();
    const { argv } = await runExport(project, 'graph', true);

    const view = { ...project, timeline: resolveRenderTimeline(project) };
    const totalFrames = Math.max(...selectExportClips(view).map((c) => c.startFrame + c.durationFrames));
    expect(argv).toEqual(buildFfmpegArgs(
      project,
      { outputPath: path.join(TMP, 'graph.mp4'), format: 'mp4', quality: 'draft' },
      project.settings.width,
      project.settings.height,
      project.settings.fps,
      totalFrames,
    ));
  });
});
