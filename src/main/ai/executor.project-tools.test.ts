/**
 * Regression coverage for the project file tools (open_project /
 * save_project / new_project) that let external MCP clients work on real
 * .vproj files: round-trip a project through the filesystem, refuse bad
 * input, and prove a save is atomic (no partial file on failure).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import { drainWrites, pendingWriteCount } from '../services/project-writer';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-project-tools-'));
});

afterEach(async () => {
  await drainWrites();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function harness() {
  const editor = new EditorController();
  return { editor, executor: new ToolExecutor(editor) };
}

describe('project file tools (MCP batch workflows)', () => {
  it('new_project resets to an empty project with the requested name', async () => {
    const { editor, executor } = harness();
    editor.addMedia({
      id: 'a', path: '/x/a.mp4', filename: 'a.mp4', type: 'video',
      duration: 10, fileSize: 1, addedAt: new Date().toISOString(),
    });

    const result = await executor.execute('new_project', { name: 'Batch Reel' });

    expect(result.success).toBe(true);
    expect(editor.getProject().name).toBe('Batch Reel');
    expect(editor.getMedia()).toHaveLength(0);
    expect(editor.getClips()).toHaveLength(0);
  });

  it('saves and re-opens a project with its clips intact', async () => {
    const { editor, executor } = harness();
    editor.addMedia({
      id: 'a', path: '/x/a.mp4', filename: 'a.mp4', type: 'video',
      duration: 10, fileSize: 1, addedAt: new Date().toISOString(),
    });
    editor.addClip({ assetId: 'a', trackId: 'v1', startFrame: 30, durationFrames: 60 });
    const file = path.join(tmpDir, 'reel.vproj');

    const saved = await executor.execute('save_project', { path: file });
    expect(saved.success).toBe(true);
    expect((saved.data as { bytes: number }).bytes).toBeGreaterThan(0);
    expect(await fs.readFile(file, 'utf8')).toContain('"version"');

    const reopened = harness();
    const opened = await reopened.executor.execute('open_project', { path: file });
    expect(opened.success).toBe(true);
    expect((opened.data as { clips: number }).clips).toBe(1);
    expect(reopened.editor.getClips()[0].startFrame).toBe(30);
  });

  it('serializes concurrent MCP saves to the same destination', async () => {
    const { editor, executor } = harness();
    const file = path.join(tmpDir, 'concurrent.vproj');

    const first = executor.execute('save_project', { path: file });
    editor.addMedia({
      id: 'newer', path: '/x/newer.mp4', filename: 'newer.mp4', type: 'video',
      duration: 10, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const second = executor.execute('save_project', { path: file });

    expect(pendingWriteCount(file)).toBe(2);
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.success)).toEqual([true, true]);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).media).toHaveLength(1);
    expect((await fs.readdir(tmpDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a missing file, malformed JSON, and empty paths', async () => {
    const { executor } = harness();
    const missing = await executor.execute('open_project', { path: path.join(tmpDir, 'nope.vproj') });
    expect(missing.success).toBe(false);
    expect((missing as { error?: string }).error).toMatch(/could not open/i);

    const malformed = path.join(tmpDir, 'bad.vproj');
    await fs.writeFile(malformed, '{not json');
    const bad = await executor.execute('open_project', { path: malformed });
    expect(bad.success).toBe(false);

    // Schema refuses empty paths before the handler runs.
    expect((await executor.execute('open_project', { path: '' })).success).toBe(false);
    expect((await executor.execute('save_project', { path: '' })).success).toBe(false);
    expect((await executor.execute('open_project', {})).success).toBe(false);
  });

  it('surfaces a failed write without leaving a temp file', async () => {
    const { executor } = harness();
    // A directory in place of the destination makes the atomic rename fail
    // after the unique temp file has already been written.
    const blocked = path.join(tmpDir, 'blocked.vproj');
    await fs.mkdir(blocked);

    const result = await executor.execute('save_project', { path: blocked });

    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/could not save/i);
    // The atomic-write contract: no stray temp sibling on failure.
    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
