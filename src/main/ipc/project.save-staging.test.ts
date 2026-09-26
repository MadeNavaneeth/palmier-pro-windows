/**
 * `project:save` and the staging residue it leaves beside the user's project.
 *
 * A hard kill between the writer's `fs.open` and `fs.rename` leaves a
 * full-size staging file in the user's project folder, and the writer's own
 * cleanup never runs because the process is gone. The recovery pipeline cannot
 * reach it — that sweep only ever visits the recovery directory — so the save
 * path prunes the residue in the one directory it is already about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PROCESS_START_MS } from '../services/project-writer';

type MockHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, MockHandler>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: MockHandler) => {
      electronState.handlers.set(channel, handler);
    },
  },
  dialog: { showSaveDialog: async () => ({ canceled: true, filePath: undefined }) },
  BrowserWindow: { getFocusedWindow: () => ({ id: 1 }) },
}));

const { registerProjectHandlers } = await import('./project');

const PROJECT_JSON = JSON.stringify({ name: 'cut', timeline: { clips: [] } });

const scratchDirs: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-save-'));
  scratchDirs.push(dir);
  return dir;
}

/** Exactly what the writer stages beside a project file, `offsetMs` old. */
async function writeStaged(dir: string, name: string, offsetMs: number): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, 'half-written project', 'utf-8');
  const when = new Date(PROCESS_START_MS + offsetMs);
  await fs.utimes(filePath, when, when);
  return filePath;
}

/** Backdate an entry so only the name convention could spare it. */
async function age(filePath: string, offsetMs: number): Promise<void> {
  const when = new Date(PROCESS_START_MS + offsetMs);
  await fs.utimes(filePath, when, when);
}

function save(projectJson: string, filePath: string): Promise<{ success: boolean; path?: string; error?: string }> {
  const handler = electronState.handlers.get('project:save');
  if (!handler) throw new Error('project:save was never registered');
  return handler(null, projectJson, filePath) as Promise<{ success: boolean; path?: string; error?: string }>;
}

beforeEach(() => {
  electronState.handlers.clear();
  registerProjectHandlers();
});

afterEach(async () => {
  while (scratchDirs.length > 0) {
    await fs.rm(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe('project:save staging sweep', () => {
  it('removes residue beside the project it just saved', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'project.vproj');
    const abandoned = await writeStaged(
      dir,
      `.project.vproj.${process.pid}.3.0badc0de.tmp`,
      -60_000,
    );
    const notes = path.join(dir, 'notes.txt');
    await fs.writeFile(notes, 'user data', 'utf-8');
    // Backdated, so the name convention is the only thing that can spare it.
    await age(notes, -120_000);

    expect(await save(PROJECT_JSON, target)).toEqual({ success: true, path: target });

    await expect(fs.access(abandoned)).rejects.toThrow();
    expect((await fs.readdir(dir)).sort()).toEqual(['notes.txt', 'project.vproj']);
    expect(await fs.readFile(notes, 'utf-8')).toBe('user data');
    expect(JSON.parse(await fs.readFile(target, 'utf-8')).name).toBe('cut');
  });

  it('leaves a staging file this process is still writing alone', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'project.vproj');
    // No backdating: this is the age an in-flight write has.
    const inFlight = path.join(dir, `.project.vproj.${process.pid}.9.0badc0de.tmp`);
    await fs.writeFile(inFlight, 'half-written project', 'utf-8');

    expect(await save(PROJECT_JSON, target)).toEqual({ success: true, path: target });

    await expect(fs.access(inFlight)).resolves.toBeUndefined();
  });

  it('reports a failed write without sweeping, and keeps the previous project', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'project.vproj');
    expect(await save(PROJECT_JSON, target)).toEqual({ success: true, path: target });
    const abandoned = await writeStaged(
      dir,
      `.project.vproj.${process.pid}.3.0badc0de.tmp`,
      -60_000,
    );
    // A directory in place of the destination makes the rename fail after the
    // staging file has been written and flushed.
    const blocked = path.join(dir, 'blocked.vproj');
    await fs.mkdir(blocked);

    const result = await save(PROJECT_JSON, blocked);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    // The sweep is downstream of the write, so a failed save prunes nothing.
    await expect(fs.access(abandoned)).resolves.toBeUndefined();
    // The last good project is still on disk.
    expect(JSON.parse(await fs.readFile(target, 'utf-8')).name).toBe('cut');
  });
});
