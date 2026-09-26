/**
 * Regression coverage for the serialized atomic project write contract
 * (upstream PR #337 / #403 / #422).
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import { watch } from 'fs';
import os from 'os';
import path from 'path';
import {
  PROCESS_START_MS,
  atomicWriteFile,
  drainWrites,
  enqueueWrite,
  isAtomicWriteTempName,
  pendingWriteCount,
  pruneAbandonedWriteTemps,
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

describe('staging name recognizer', () => {
  it('recognizes the name a real atomicWriteFile stages under', async () => {
    const dir = await scratchDir();
    // The staging file is renamed over the destination before the write
    // resolves, so the only way to see the name the writer really used is to
    // watch the directory while it runs.
    const observed = new Promise<string>((resolve, reject) => {
      const watcher = watch(dir, (_event, name) => {
        const entry = name?.toString() ?? '';
        if (!entry.endsWith('.tmp')) return;
        clearTimeout(timer);
        watcher.close();
        resolve(entry);
      });
      const timer = setTimeout(() => {
        watcher.close();
        reject(new Error('no staging file was observed'));
      }, 10_000);
    });

    await atomicWriteFile(path.join(dir, 'session.json'), '{"savedAt":"now"}');
    const staged = await observed;

    expect(isAtomicWriteTempName(staged)).toBe(true);
    expect(staged).toMatch(/^\.session\.json\.\d+\.\d+\.[0-9a-f]{8}\.tmp$/);
  }, 20_000);

  it('rejects names the writer never produces', () => {
    for (const name of [
      'session.json.4321.7.deadbeef.tmp',       // missing the leading dot
      '.session.json.4321.7.deadbeef',          // missing the .tmp suffix
      '.session.json.4321.7.deadbeef.tmp.bak',  // a suffix the writer never adds
      '.session.json.4321.7.dead.tmp',          // 4 hex digits, not 8
      '.session.json.4321.7.deadbeef1.tmp',     // 9 hex digits, not 8
      '.session.json.4321.7.DEADBEEF.tmp',      // the writer emits lowercase hex
      '.session.json.pid.7.deadbeef.tmp',       // the pid is always numeric
      '.session.json.4321.deadbeef.tmp',        // the counter segment is missing
      '..4321.7.deadbeef.tmp',                  // nothing was staged against
    ]) {
      expect(isAtomicWriteTempName(name)).toBe(false);
    }
  });

  it('matches a dotted destination basename, as a recovery snapshot stages', () => {
    expect(isAtomicWriteTempName('.0f8fad5b-d9cb-469f-a165-70867728950e.json.4321.7.deadbeef.tmp'))
      .toBe(true);
  });
});

describe('pruneAbandonedWriteTemps', () => {
  /** Exactly what the writer stages beside a project file. */
  function stagedName(basename = 'project.vproj'): string {
    return `.${basename}.${process.pid}.3.0badc0de.tmp`;
  }

  /** Write a staging entry and place its mtime `offsetMs` from this process's start. */
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

  it('removes residue a hard kill left beside a project file', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'project.vproj');
    await atomicWriteFile(target, '{"name":"cut"}');
    // A kill between the writer's `fs.open` and `fs.rename` is all it takes to
    // leave a full-size file here, and the writer's own `catch` never runs.
    const abandoned = await writeStaged(dir, stagedName(), -60_000);

    await pruneAbandonedWriteTemps(dir);

    await expect(fs.access(abandoned)).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual(['project.vproj']);
    expect(await fs.readFile(target, 'utf-8')).toBe('{"name":"cut"}');
  });

  it('keeps a staging file this process created', async () => {
    const dir = await scratchDir();
    // No `utimes`: this is the mtime a real in-flight write gets, and it is the
    // whole reason the sweep is age-gated. This is the premise every
    // in-flight safety claim below rests on.
    const staged = path.join(dir, stagedName('live.vproj'));
    await fs.writeFile(staged, 'half-written project', 'utf-8');

    await pruneAbandonedWriteTemps(dir);

    await expect(fs.access(staged)).resolves.toBeUndefined();
  });

  it('never removes a staging file a live write is still using', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'project.vproj');
    // An old residue file in the same directory, so the sweep provably ran
    // rather than being skipped: if it deleted the in-flight staging file the
    // rename below would fail and the write would reject.
    const abandoned = await writeStaged(dir, stagedName(), -60_000);
    // A payload big enough that the write is still staging while the sweep runs.
    const payload = 'x'.repeat(8 * 1024 * 1024);

    await Promise.all([atomicWriteFile(target, payload), pruneAbandonedWriteTemps(dir)]);

    await expect(fs.access(abandoned)).rejects.toThrow();
    expect(await fs.readFile(target, 'utf-8')).toHaveLength(payload.length);
    expect(await fs.readdir(dir)).toEqual(['project.vproj']);
  });

  it('never touches the project file or anything else in the directory', async () => {
    const dir = await scratchDir();
    const target = path.join(dir, 'project.vproj');
    await atomicWriteFile(target, '{"name":"cut"}');
    const userFiles = [
      path.join(dir, 'notes.txt'),
      path.join(dir, 'cut.mp4'),
      path.join(dir, 'project.vproj.bak'),
      path.join(dir, 'old.vproj'),
    ];
    for (const filePath of userFiles) {
      await fs.writeFile(filePath, 'user data', 'utf-8');
      // Every user file is backdated, so the NAME convention is the only thing
      // that can spare it: an age gate alone would not be enough.
      await age(filePath, -120_000);
    }
    await age(target, -120_000);
    const nested = path.join(dir, 'assets', 'clip.png');
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, 'pixels', 'utf-8');
    await age(nested, -120_000);
    // Residue inside the subdirectory is out of scope: one directory, no walk.
    const nestedResidue = await writeStaged(path.join(dir, 'assets'), stagedName('clip.png'), -60_000);
    await writeStaged(dir, stagedName(), -60_000);

    await pruneAbandonedWriteTemps(dir);

    expect(await fs.readFile(target, 'utf-8')).toBe('{"name":"cut"}');
    for (const filePath of [...userFiles, nested]) {
      expect(await fs.readFile(filePath, 'utf-8')).toBe(filePath === nested ? 'pixels' : 'user data');
    }
    await expect(fs.access(nestedResidue)).resolves.toBeUndefined();
    expect((await fs.readdir(dir)).sort()).toEqual([
      'assets', 'cut.mp4', 'notes.txt', 'old.vproj', 'project.vproj', 'project.vproj.bak',
    ]);
  });

  it('leaves files that only resemble the staging shape alone', async () => {
    const dir = await scratchDir();
    const nearMisses = [
      'project.vproj.1234.9.0badc0de.tmp',       // no leading dot
      '.project.vproj.1234.9.0badc0de.tmp.bak',   // trailing suffix
      '.project.vproj.1234.9.0badc0de',           // no .tmp suffix
      '.project.vproj.1234.9.0badc0.tmp',         // 6 hex digits, not 8
      '.project.vproj.1234.9.0badc0de1.tmp',      // 9 hex digits, not 8
      '.project.vproj.1234.9.0BADC0DE.tmp',       // the writer emits lowercase
      '.project.vproj.pid.9.0badc0de.tmp',        // the pid is always numeric
      '.project.vproj.1234.0badc0de.tmp',         // counter segment missing
      '..1234.9.0badc0de.tmp',                    // nothing was staged against
      '.project.vproj',                           // an unrelated dotted name
    ];
    const paths: string[] = [];
    for (const name of nearMisses) paths.push(await writeStaged(dir, name, -60_000));
    // A directory that borrows the shape is not writer residue either.
    const borrowed = path.join(dir, stagedName('borrowed'));
    await fs.mkdir(borrowed);
    const when = new Date(PROCESS_START_MS - 60_000);
    await fs.utimes(borrowed, when, when);

    await pruneAbandonedWriteTemps(dir);

    for (const filePath of [...paths, borrowed]) {
      await expect(fs.access(filePath)).resolves.toBeUndefined();
    }
  });

  it('is best effort when the directory is missing or is not a directory', async () => {
    const dir = await scratchDir();
    const filePath = path.join(dir, 'not-a-directory.vproj');
    await fs.writeFile(filePath, 'user data', 'utf-8');

    // A save must never fail because pruning could not run.
    await expect(pruneAbandonedWriteTemps(path.join(dir, 'absent'))).resolves.toBeUndefined();
    await expect(pruneAbandonedWriteTemps(filePath)).resolves.toBeUndefined();
    expect(await fs.readFile(filePath, 'utf-8')).toBe('user data');
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
