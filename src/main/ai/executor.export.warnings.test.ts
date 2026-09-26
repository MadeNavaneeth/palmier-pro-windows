/**
 * The agent export path has no renderer, so it cannot bake the delivery
 * panel's shape boxes and advanced-title layers. What it must never do is
 * drop them in silence: FFmpeg exits 0, the receipt says success, and the
 * file is missing the rectangle.
 *
 * These tests run the REAL exporter (graph builder + event channel) with a
 * mocked `spawn`, so no encoder starts, and assert every layer the graph
 * could not render is named in the tool receipt.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';

const { spawned, spawn } = vi.hoisted(() => {
  const spawned: any[] = [];
  // Stand-in ChildProcess: registration only — `close` is emitted by the test.
  const spawn = () => {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const proc: any = {
      killed: 0,
      kill: () => { proc.killed += 1; },
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
    spawned.push(proc);
    return proc;
  };
  return { spawned, spawn };
});

vi.mock('child_process', () => ({ spawn, execFile: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  BrowserWindow: { fromWebContents: () => null },
  shell: { showItemInFolder: () => {} },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  app: undefined,
  default: {},
}));

import { Exporter, type ExportEventSink, type ExportOptions } from '../media/exporter';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

const TMP = path.join(os.tmpdir(), `palmier-export-warnings-${process.pid}`);
const SOURCE = path.join(TMP, 'src.mp4');
const OUT = path.join(TMP, 'reel.mp4');

const baseClip: Clip = {
  id: 'clip',
  assetId: '',
  type: 'video',
  trackId: 'v1',
  startFrame: 0,
  durationFrames: 150,
  inPoint: 0,
  outPoint: 150,
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

/** A red rect on V2, frames 30–120, exactly the repro's shape. */
const shapeClip: Clip = {
  ...baseClip,
  id: 'shape-0',
  type: 'shape',
  trackId: 'v2',
  startFrame: 30,
  durationFrames: 90,
  x: 200,
  y: 300,
  width: 400,
  height: 200,
  label: 'Callout rect',
  shapeKind: 'rect',
  shapeFillColor: '#ff0000',
};

/** A title whose inverted fill only exists on the bake path. */
const advancedTitleClip: Clip = {
  ...baseClip,
  id: 'title-0',
  type: 'title',
  durationFrames: 150,
  text: 'Sting',
  label: 'Sting',
  titleFillMode: 'inverted',
};

function projectWith(clips: Clip[]): Project {
  const project = createEmptyProject();
  project.timeline.tracks.push({
    id: 'v2', name: 'Video 2', type: 'video', locked: false, visible: true, syncLocked: true, order: 2,
  });
  project.timeline.clips = clips;
  return project;
}

/** The real exporter behind the tool's injectable seam. */
function executorFor(project: Project) {
  const exporter = new Exporter();
  const runExport = (p: Project, options: ExportOptions, sink: ExportEventSink) =>
    exporter.export(p, options, sink);
  const executor = new ToolExecutor(new EditorController(project), { runExport: runExport as never });
  return executor;
}

/** Run export_project to a real completion (exit 0 + a written file). */
async function exportTo(executor: ToolExecutor) {
  const pending = executor.execute('export_project', { outputPath: OUT, format: 'mp4' });
  const proc = spawned[spawned.length - 1]!;
  expect(proc).toBeDefined();
  await fsp.writeFile(OUT, Buffer.from('rendered'));
  proc.emit('close', 0);
  const result = await pending;
  return result as { success: boolean; data?: { warnings?: string[] }; error?: string };
}

beforeAll(async () => {
  await fsp.mkdir(TMP, { recursive: true });
});

afterAll(async () => {
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

afterEach(() => {
  spawned.length = 0;
});

describe('export_project reports what the render dropped', () => {
  it('names a shape clip the graph had to skip', async () => {
    const result = await exportTo(executorFor(projectWith([shapeClip])));

    expect(result.success).toBe(true);
    // The graph really did drop it (a shape has no filter fallback) …
    const warnings = result.data?.warnings ?? [];
    expect(warnings).toHaveLength(1);
    // … and the receipt says so, naming the clip and the loss.
    expect(warnings[0]).toMatch(/Shape clip "Callout rect" \(rect\)/);
    expect(warnings[0]).toMatch(/left out of the render/);
    expect(warnings[0]).toMatch(/delivery panel/);
  });

  it('names an advanced title the graph degraded to plain drawtext', async () => {
    const result = await exportTo(executorFor(projectWith([advancedTitleClip])));

    expect(result.success).toBe(true);
    const warnings = result.data?.warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Title clip "Sting"/);
    expect(warnings[0]).toMatch(/plain solid text/);
    expect(warnings[0]).toMatch(/fill mode/);
  });

  it('reports every dropped layer in one receipt, not just the first', async () => {
    const result = await exportTo(executorFor(projectWith([shapeClip, advancedTitleClip])));

    expect(result.success).toBe(true);
    const warnings = result.data?.warnings ?? [];
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes('Callout rect'))).toBe(true);
    expect(warnings.some((w) => w.includes('Sting'))).toBe(true);
  });

  it('carries a LUT preflight warning through the same channel', async () => {
    await fsp.writeFile(SOURCE, Buffer.from('fake-media'));
    const gradedClip: Clip = {
      ...baseClip,
      id: 'video-0',
      assetId: 'm1',
      type: 'video',
      durationFrames: 60,
      label: 'Interview',
      lut: { path: path.join(TMP, 'gone.cube'), intensity: 1, kind: '3d', size: 33 },
    };
    const project = projectWith([gradedClip]);
    project.media = [{
      id: 'm1', path: SOURCE, filename: 'src.mp4', type: 'video',
      duration: 60, fps: 30, fileSize: 1, addedAt: new Date().toISOString(),
    }];

    const result = await exportTo(executorFor(project));

    expect(result.success).toBe(true);
    const warnings = result.data?.warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Interview/);
    expect(warnings[0]).toMatch(/without its LUT/);
  });

  it('leaves the receipt alone when nothing was dropped', async () => {
    const plainTitle: Clip = { ...baseClip, id: 'title-1', type: 'title', text: 'Plain', label: 'Plain' };
    const result = await exportTo(executorFor(projectWith([plainTitle])));

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('warnings');
  });
});
