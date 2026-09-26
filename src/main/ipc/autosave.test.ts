/**
 * Recovery discovery coverage (#211) and per-session isolation (#137).
 *
 * The path rule remains pure and small; these cases exercise the filesystem
 * discovery contract that makes a crashed session discoverable after its UUID
 * is gone, while keeping live-session files and hostile directory contents out
 * of the pruning pass.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createEmptyProject } from '../../shared/types/project';
import {
  inspectRecoveryDirectory,
  MAX_ORPHAN_RECOVERY_FILES,
  parseRecoverySnapshot,
  recoveryFileForSession,
  recoverySessionIdFromFileName,
} from './autosave';
import type { RecoverySnapshot } from './autosave';
import { PROCESS_START_MS } from '../services/project-writer';

const DIR = path.join('userData', 'recovery');
const scratchDirs: string[] = [];

afterEach(async () => {
  while (scratchDirs.length > 0) {
    await fs.rm(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

async function scratchDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-recovery-'));
  scratchDirs.push(dir);
  return dir;
}

function snapshot(
  savedAt: string,
  projectName = 'Recovered project',
  projectFilePath: string | null = null,
): RecoverySnapshot {
  return {
    savedAt,
    projectFilePath,
    projectName,
    data: JSON.stringify(createEmptyProject(projectName)),
  };
}

async function writeSnapshot(
  dir: string,
  id: string,
  value: RecoverySnapshot | string,
): Promise<void> {
  await fs.writeFile(
    path.join(dir, `${id}.json`),
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf-8',
  );
}

describe('per-session recovery paths (#137 Slice 1)', () => {
  it('gives two sessions two files', () => {
    const a = recoveryFileForSession(DIR, 'session-aaaa');
    const b = recoveryFileForSession(DIR, 'session-bbbb');

    expect(a).not.toBe(b);
    expect(a).toBe(path.join(DIR, 'session-aaaa.json'));
    expect(b).toBe(path.join(DIR, 'session-bbbb.json'));
  });

  it('keeps one session on one stable file', () => {
    expect(recoveryFileForSession(DIR, 's1')).toBe(recoveryFileForSession(DIR, 's1'));
  });

  it('accepts the ids this process mints (crypto.randomUUID)', () => {
    const minted = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(recoveryFileForSession(DIR, minted)).toBe(path.join(DIR, `${minted}.json`));
    expect(() => recoveryFileForSession(DIR, minted)).not.toThrow();
  });

  it('refuses an id that could steer the path', () => {
    for (const bad of ['', '../evil', 'a/b', 'a\\b', 'a b', 'a..b', 'a.json/..']) {
      expect(() => recoveryFileForSession(DIR, bad)).toThrow(
        'Invalid session id for recovery path.',
      );
    }
  });

  it('recognizes only safe recovery filenames', () => {
    expect(recoverySessionIdFromFileName('session-a.json')).toBe('session-a');
    expect(recoverySessionIdFromFileName('session-a.JSON')).toBeNull();
    expect(recoverySessionIdFromFileName('../session-a.json')).toBeNull();
    expect(recoverySessionIdFromFileName('session-a.json.bak')).toBeNull();
  });
});

describe('orphaned recovery discovery', () => {
  it('finds a crashed session despite a different current UUID', async () => {
    const dir = await scratchDir();
    await writeSnapshot(dir, 'crashed-session', snapshot('2026-01-02T12:00:00.000Z'));

    const discovery = await inspectRecoveryDirectory(dir, ['new-session']);

    expect(discovery.candidate?.recoveryId).toBe('crashed-session');
    expect(discovery.candidate?.snapshot.projectName).toBe('Recovered project');
  });

  it('only offers a snapshot newer than its real project save', async () => {
    const dir = await scratchDir();
    const projectPath = path.join(dir, 'saved.vproj');
    await fs.writeFile(projectPath, '{}', 'utf-8');
    await fs.utimes(projectPath, new Date('2026-01-03T00:00:00.000Z'), new Date('2026-01-03T00:00:00.000Z'));

    await writeSnapshot(
      dir,
      'older-than-save',
      snapshot('2026-01-02T00:00:00.000Z', 'Recovered project', projectPath),
    );
    const stale = await inspectRecoveryDirectory(dir, []);
    expect(stale.candidate).toBeNull();
    await expect(fs.access(path.join(dir, 'older-than-save.json'))).rejects.toThrow();

    await writeSnapshot(
      dir,
      'newer-than-save',
      snapshot('2026-01-04T00:00:00.000Z', 'Recovered project', projectPath),
    );
    const fresh = await inspectRecoveryDirectory(dir, []);
    expect(fresh.candidate?.recoveryId).toBe('newer-than-save');
  });

  it('never prunes a live session while another window discovers recovery', async () => {
    const dir = await scratchDir();
    await writeSnapshot(dir, 'live-session', snapshot('2026-01-01T00:00:00.000Z'));
    await writeSnapshot(dir, 'orphaned-session', snapshot('2026-01-02T00:00:00.000Z'));
    await writeSnapshot(dir, 'corrupt-session', '{not json');

    const discovery = await inspectRecoveryDirectory(
      dir,
      ['live-session'],
      (id) => id === 'live-session',
    );

    expect(discovery.candidate?.recoveryId).toBe('orphaned-session');
    await expect(fs.access(path.join(dir, 'live-session.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, 'corrupt-session.json'))).rejects.toThrow();
  });

  it('offers only the newest orphan and bounds retained snapshots', async () => {
    const dir = await scratchDir();
    for (let index = 0; index < MAX_ORPHAN_RECOVERY_FILES + 3; index += 1) {
      await writeSnapshot(
        dir,
        `orphan-${index}`,
        snapshot(new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()),
      );
    }

    const discovery = await inspectRecoveryDirectory(dir, []);

    expect(discovery.candidate?.recoveryId).toBe(`orphan-${MAX_ORPHAN_RECOVERY_FILES + 2}`);
    expect(discovery.retained).toHaveLength(MAX_ORPHAN_RECOVERY_FILES);
    expect((await fs.readdir(dir)).sort()).toHaveLength(MAX_ORPHAN_RECOVERY_FILES);
  });

  it('ignores corrupt and non-project snapshots safely', () => {
    expect(parseRecoverySnapshot('{not json')).toBeNull();
    expect(parseRecoverySnapshot(JSON.stringify({
      savedAt: new Date().toISOString(),
      projectFilePath: null,
      projectName: 'Bad',
      data: JSON.stringify({ name: 'not a project' }),
    }))).toBeNull();
  });
});

describe('abandoned atomic-write staging residue', () => {
  /** Exactly what project-writer stages while writing the recovery `<id>.json`. */
  function stagedName(id: string): string {
    return `.${id}.json.${process.pid}.3.0badc0de.tmp`;
  }

  /** Place an entry's mtime `offsetMs` from the moment this process loaded. */
  async function ageEntry(filePath: string, offsetMs: number): Promise<void> {
    const when = new Date(PROCESS_START_MS + offsetMs);
    await fs.utimes(filePath, when, when);
  }

  async function writeStaged(dir: string, name: string, offsetMs: number): Promise<string> {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, 'half-written snapshot', 'utf-8');
    await ageEntry(filePath, offsetMs);
    return filePath;
  }

  it('removes staging residue abandoned before this process started', async () => {
    const dir = await scratchDir();
    const staged = await writeStaged(dir, stagedName('crashed-session'), -60_000);
    await writeSnapshot(dir, 'crashed-session', snapshot('2026-01-02T12:00:00.000Z'));

    const discovery = await inspectRecoveryDirectory(dir, []);

    // A hard kill between the writer's open and rename is all it takes to leave
    // that file behind, and nothing else in the pipeline would ever remove it.
    await expect(fs.access(staged)).rejects.toThrow();
    // The real snapshot beside the residue is untouched by the sweep.
    expect(discovery.candidate?.recoveryId).toBe('crashed-session');
    expect(await fs.readdir(dir)).toEqual(['crashed-session.json']);
  });

  it('never removes a staging file that a live write is still using', async () => {
    const dir = await scratchDir();
    // A write in this process created its staging file after this process
    // started. That is the whole reason the sweep is age-gated.
    const staged = await writeStaged(dir, stagedName('live-session'), 60_000);

    const discovery = await inspectRecoveryDirectory(dir, []);

    await expect(fs.access(staged)).resolves.toBeUndefined();
    expect(discovery.candidate).toBeNull();
  });

  it('leaves files that only resemble staging residue alone', async () => {
    const dir = await scratchDir();
    const nearMisses = [
      'crashed-session.json.1234.9.0badc0de.tmp',     // no leading dot
      '.crashed-session.json.1234.9.0badc0de.tmp.bak', // trailing suffix
      '.crashed-session.json.1234.9.0badc0de',        // no .tmp suffix
      '.crashed-session.json.1234.9.0badc0.tmp',       // 6 hex digits, not 8
      '.crashed-session.json.1234.9.0badc0de1.tmp',    // 9 hex digits, not 8
      '.crashed-session.json.1234.9.0BADC0DE.tmp',     // the writer emits lowercase
      '.crashed-session.json.pid.9.0badc0de.tmp',      // the pid is always numeric
      '.crashed-session.json.1234.0badc0de.tmp',       // counter segment missing
      '..1234.9.0badc0de.tmp',                         // nothing was staged against
      '.crashed-session.json',                         // an unrelated dotted name
    ];
    const paths: string[] = [];
    for (const name of nearMisses) {
      paths.push(await writeStaged(dir, name, -60_000));
    }
    // A directory that borrows the shape is not writer residue either.
    const stagedDirectory = path.join(dir, stagedName('borrowed-shape'));
    await fs.mkdir(stagedDirectory);
    await ageEntry(stagedDirectory, -60_000);

    await inspectRecoveryDirectory(dir, []);

    for (const filePath of [...paths, stagedDirectory]) {
      await expect(fs.access(filePath)).resolves.toBeUndefined();
    }
  });

  it('does not let staging residue take a slot in the orphan cap', async () => {
    const dir = await scratchDir();
    for (let index = 0; index < MAX_ORPHAN_RECOVERY_FILES + 3; index += 1) {
      await writeSnapshot(
        dir,
        `orphan-${index}`,
        snapshot(new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()),
      );
    }
    for (let index = 0; index < 5; index += 1) {
      await writeStaged(dir, stagedName(`orphan-${index}`), -60_000);
    }
    const inFlight = await writeStaged(dir, stagedName('recent-session'), 60_000);

    const discovery = await inspectRecoveryDirectory(dir, []);

    // The cap bounds recoverable snapshots. Residue is neither retained nor
    // retained *instead of* a snapshot: the newest orphan still wins, and the
    // sweep collected the abandoned staging files around it.
    expect(discovery.candidate?.recoveryId).toBe(`orphan-${MAX_ORPHAN_RECOVERY_FILES + 2}`);
    expect(discovery.retained).toHaveLength(MAX_ORPHAN_RECOVERY_FILES);
    const entries = (await fs.readdir(dir)).sort();
    expect(entries.filter((name) => name.endsWith('.json')))
      .toHaveLength(MAX_ORPHAN_RECOVERY_FILES);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([path.basename(inFlight)]);
  });
});
