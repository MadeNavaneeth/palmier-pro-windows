/**
 * Per-session export job isolation (#137 Slice 3).
 *
 * FFmpeg spawns are mocked — no encoder runs here; each fake process's
 * `close` is driven by the test. What this pins:
 *  - two sessions export concurrently (one process per export, parallel —
 *    not serialized),
 *  - `cancel(owner)` kills only that owner's process and flips only that
 *    owner's cancelled flag: the other session's export still completes,
 *  - `export:cancel` resolves the session from its own sender and touches
 *    nothing when the sender belongs to no session.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';
import { createEmptyProject } from '../../shared/types/project';
import type { Clip, Project } from '../../shared/types/project';
import { Exporter, registerExportHandlers } from './exporter';

const { spawned, ipcHandlers, fromWebContents, spawn } = vi.hoisted(() => {
  const spawned: any[] = [];
  const ipcHandlers = new Map<string, (...args: any[]) => any>();
  const fromWebContents = vi.fn();
  // Stand-in ChildProcess: registration only — close is emitted by tests.
  const spawn = () => {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const proc: any = {
      killed: 0,
      kill: () => {
        proc.killed += 1;
      },
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
  return { spawned, ipcHandlers, fromWebContents, spawn };
});

vi.mock('child_process', () => ({ spawn }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: any[]) => any) => {
      ipcHandlers.set(channel, listener);
    },
  },
  BrowserWindow: { fromWebContents },
  shell: { showItemInFolder: () => {} },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  app: undefined,
  default: {},
}));

const TMP = path.join(os.tmpdir(), `palmier-exporter-session-${process.pid}`);
const SOURCE = path.join(TMP, 'src.mp4');

/** One eligible video clip on a real (pre-written) source file. */
function projectWithClip(): Project {
  const project = createEmptyProject();
  project.media = [{
    id: 'm1',
    path: SOURCE,
    filename: 'src.mp4',
    type: 'video',
    duration: 300,
    fps: 30,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  }];
  project.timeline.clips = [{
    id: 'c1',
    assetId: 'm1',
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
  } as Clip];
  return project;
}

function optionsFor(outputPath: string) {
  return { outputPath, format: 'mp4', quality: 'normal' } as const;
}

beforeAll(async () => {
  await fsp.mkdir(TMP, { recursive: true });
  await fsp.writeFile(SOURCE, Buffer.from('fake-media'));
});

afterAll(async () => {
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe('Exporter per-owner jobs (#137 Slice 3)', () => {
  it('runs parallel exports and cancels only the requesting owner’s job', async () => {
    const exporter = new Exporter();
    const project = projectWithClip();
    const outA = path.join(TMP, 'parallel-a.mp4');
    const outB = path.join(TMP, 'parallel-b.mp4');
    const sinkA = { send: vi.fn() };
    const sinkB = { send: vi.fn() };
    const base = spawned.length;

    const runA = exporter.export(project, optionsFor(outA), sinkA, 'own-a');
    const runB = exporter.export(project, optionsFor(outB), sinkB, 'own-b');
    // Preferred concurrency: one FFmpeg process per export, both in flight.
    expect(spawned.length - base).toBe(2);

    exporter.cancel('ghost-owner'); // unknown owner: nobody's job is touched
    exporter.cancel('own-a');
    expect(spawned[base]!.killed).toBe(1);
    expect(spawned[base + 1]!.killed).toBe(0);
    expect(sinkB.send).not.toHaveBeenCalledWith('export:error', expect.anything());

    spawned[base]!.emit('close', null);
    await runA;
    expect(sinkA.send).toHaveBeenCalledWith('export:error', 'Export cancelled');

    // A's cancel never flipped B's flag: exit 0 completes B normally.
    await fsp.writeFile(outB, Buffer.from('rendered'));
    spawned[base + 1]!.emit('close', 0);
    await runB;
    expect(sinkB.send).toHaveBeenCalledWith(
      'export:complete',
      expect.objectContaining({ outputPath: outB }),
    );
  });

  it('resolves export:cancel from the sender’s session only', async () => {
    const project = projectWithClip();
    registerExportHandlers((sender) => {
      if (sender.id === 10) return { sessionId: 'exp-a', project };
      if (sender.id === 20) return { sessionId: 'exp-b', project };
      return null;
    });
    const winA = { webContents: { id: 10, send: vi.fn() } };
    const winB = { webContents: { id: 20, send: vi.fn() } };
    fromWebContents.mockImplementation((wc: { id: number }) => (wc.id === 10 ? winA : winB));
    const start = ipcHandlers.get('export:start')!;
    const cancel = ipcHandlers.get('export:cancel')!;
    const outA = path.join(TMP, 'ipc-a.mp4');
    const outB = path.join(TMP, 'ipc-b.mp4');
    const base = spawned.length;

    const runA = start({ sender: { id: 10 } }, optionsFor(outA));
    const runB = start({ sender: { id: 20 } }, optionsFor(outB));
    expect(spawned.length - base).toBe(2);

    // Session A cancels: only A's process dies.
    expect(cancel({ sender: { id: 10 } })).toEqual({ success: true });
    expect(spawned[base]!.killed).toBe(1);
    expect(spawned[base + 1]!.killed).toBe(0);

    // A sender with no session cancels nothing.
    expect(cancel({ sender: { id: 999 } })).toEqual({ success: true });
    expect(spawned[base + 1]!.killed).toBe(0);

    spawned[base]!.emit('close', null);
    const resA = await runA;
    expect(resA).toEqual({ success: true, outputPath: outA });
    expect(winA.webContents.send).toHaveBeenCalledWith('export:error', 'Export cancelled');
    expect(winB.webContents.send).not.toHaveBeenCalledWith('export:error', 'Export cancelled');

    await fsp.writeFile(outB, Buffer.from('rendered'));
    spawned[base + 1]!.emit('close', 0);
    const resB = await runB;
    expect(resB).toEqual({ success: true, outputPath: outB });
    expect(winB.webContents.send).toHaveBeenCalledWith(
      'export:complete',
      expect.objectContaining({ outputPath: outB }),
    );
  });
});
