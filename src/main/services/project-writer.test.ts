/**
 * Regression coverage for the serialized atomic project write contract
 * (upstream PR #337 / #403 / #422).
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  atomicWriteFile,
  drainWrites,
  enqueueWrite,
  pendingWriteCount,
  writeProjectFile,
} from './project-writer';

const scratchDirs: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-writer-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await drainWrites();
  while (scratchDirs.length > 0) {
    await fs.rm(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe('atomicWriteFile', () => {
  it('creates missing directories and writes the payload', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'nested', 'deeper', 'project.vproj');

    await atomicWriteFile(target, '{"name":"cut"}');

    expect(await fs.readFile(target, 'utf-8')).toBe('{"name":"cut"}');
  });

  it('leaves no temp residue on success', async () => {
    const dir = await scratchDir();
    await atomicWriteFile(path.join(dir, 'project.vproj'), 'a');
    await atomicWriteFile(path.join(dir, 'project.vproj'), 'b');

    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['project.vproj']);
  });

  it('keeps the previous file and removes the temp file when the write fails', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'project.vproj');
    await atomicWriteFile(target, 'good');

    // A directory in place of the destination makes the rename fail after the
    // temp file has already been written and flushed.
    const blocked = path.join(dir, 'blocked.vproj');
    await fs.mkdir(blocked);
    await expect(atomicWriteFile(blocked, 'payload')).rejects.toThrow();

    // The unrelated good file is untouched, and no temp file was orphaned.
    expect(await fs.readFile(target, 'utf-8')).toBe('good');
    const entries = (await fs.readdir(dir)).sort();
    expect(entries).toEqual(['blocked.vproj', 'project.vproj']);
  });

  it('does not truncate the destination when the payload cannot be staged', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'project.vproj');
    await atomicWriteFile(target, 'previous contents');

    // A non-string payload throws while writing the temp file. A plain
    // writeFile to the destination would already have truncated it.
    await expect(atomicWriteFile(target, undefined as unknown as string)).rejects.toThrow();

    expect(await fs.readFile(target, 'utf-8')).toBe('previous contents');
  });
});

describe('write serialization', () => {
  it('runs writes to one destination one at a time, in order', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'project.vproj');
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const task = (label: string) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end:${label}`);
      inFlight -= 1;
    };

    await Promise.all([
      enqueueWrite(target, task('a')),
      enqueueWrite(target, task('b')),
      enqueueWrite(target, task('c')),
    ]);

    expect(maxInFlight).toBe(1);
    expect(events).toEqual([
      'start:a', 'end:a',
      'start:b', 'end:b',
      'start:c', 'end:c',
    ]);
  });

  it('lets the last queued autosave win without interleaving bytes', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'autosave.json');

    // A debounced autosave burst: every snapshot is written, the newest last.
    await Promise.all([
      writeProjectFile(target, 'snapshot-1'),
      writeProjectFile(target, 'snapshot-2'),
      writeProjectFile(target, 'snapshot-3'),
    ]);

    expect(await fs.readFile(target, 'utf-8')).toBe('snapshot-3');
    expect(await fs.readdir(dir)).toEqual(['autosave.json']);
  });

  it('does not let a failed write stall the queue', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'project.vproj');
    const order: string[] = [];

    const failing = enqueueWrite(target, async () => {
      order.push('failing');
      throw new Error('disk full');
    });
    const following = enqueueWrite(target, async () => {
      order.push('following');
      await atomicWriteFile(target, 'written after failure');
    });

    await expect(failing).rejects.toThrow('disk full');
    await expect(following).resolves.toBeUndefined();
    expect(order).toEqual(['failing', 'following']);
    expect(await fs.readFile(target, 'utf-8')).toBe('written after failure');
  });

  it('serializes an explicit save against a concurrent autosave of the same file', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'project.vproj');
    let concurrent = 0;
    let observedConcurrency = 0;

    const write = (contents: string) =>
      enqueueWrite(target, async () => {
        concurrent += 1;
        observedConcurrency = Math.max(observedConcurrency, concurrent);
        await atomicWriteFile(target, contents);
        concurrent -= 1;
      });

    await Promise.all([write('explicit save'), write('autosave snapshot')]);

    expect(observedConcurrency).toBe(1);
    expect(await fs.readFile(target, 'utf-8')).toBe('autosave snapshot');
  });

  it('treats Windows paths that differ only in case as one destination', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'Project.vproj');
    const sameFile = path.join(dir.toUpperCase(), 'PROJECT.VPROJ');
    let concurrent = 0;
    let observedConcurrency = 0;

    const hold = (filePath: string) =>
      enqueueWrite(filePath, async () => {
        concurrent += 1;
        observedConcurrency = Math.max(observedConcurrency, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
      });

    await Promise.all([hold(target), hold(sameFile)]);

    // Case-insensitive keying is a Windows guarantee; elsewhere the two paths
    // really are different files and may proceed in parallel.
    expect(observedConcurrency).toBe(process.platform === 'win32' ? 1 : observedConcurrency);
  });

  it('keeps separate destinations independent', async () => {
    const dir = await scratchDir();
    const projectPath = path.join(dir, 'project.vproj');
    const recoveryPath = path.join(dir, 'recovery', 'autosave.json');
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    const blockedProjectWrite = enqueueWrite(projectPath, async () => {
      await gate;
      await atomicWriteFile(projectPath, 'project');
    });

    // The recovery write must not wait behind the stalled project write.
    await writeProjectFile(recoveryPath, 'recovery');
    expect(await fs.readFile(recoveryPath, 'utf-8')).toBe('recovery');

    released();
    await blockedProjectWrite;
    expect(await fs.readFile(projectPath, 'utf-8')).toBe('project');
  });

  it('reports and releases pending work per destination', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'project.vproj');

    const first = writeProjectFile(target, 'one');
    const second = writeProjectFile(target, 'two');
    expect(pendingWriteCount(target)).toBe(2);
    expect(pendingWriteCount()).toBe(2);

    await Promise.all([first, second]);
    expect(pendingWriteCount(target)).toBe(0);
    expect(pendingWriteCount()).toBe(0);
  });
});
