/**
 * inspect_frame (#565): decode a frame from a real generated clip, encode it
 * to PNG on disk, and hand back path + dimensions + base64. Uses ffmpeg's
 * testsrc lavfi source as the fixture so no binary asset is committed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';

const execFileAsync = promisify(execFile);

let tmpDir = '';
let clipPath = '';

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-inspect-'));
  clipPath = path.join(tmpDir, 'testsrc.mp4');
  // 2s of color bars with timestamp burn-in; tiny, deterministic, offline.
  await execFileAsync('ffmpeg', [
    '-y', '-f', 'lavfi',
    '-i', 'testsrc=duration=2:size=320x240:rate=10',
    '-pix_fmt', 'yuv420p', clipPath,
  ]);
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function harness() {
  const editor = new EditorController();
  editor.addMedia({
    id: 'bars', path: clipPath, filename: 'testsrc.mp4', type: 'video',
    duration: 2, width: 320, height: 240, fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  return { editor, executor: new ToolExecutor(editor) };
}

describe('inspect_frame (#565)', () => {
  it('writes a PNG and returns path + dimensions + base64', async () => {
    const { executor } = harness();
    const result = await executor.execute('inspect_frame', {
      assetId: 'bars', atSeconds: 1.5,
    });
    expect(result.success).toBe(true);
    const data = result.data as { path: string; width: number; height: number; imageBase64?: string; timecode: string };
    expect(data.width).toBe(640);
    expect(data.height).toBe(480);
    expect(data.timecode).toContain('0:01');

    const stat = await fs.stat(data.path);
    expect(stat.size).toBeGreaterThan(0);
    // PNG magic bytes.
    const magic = Buffer.from(await fs.readFile(data.path)).subarray(0, 4);
    expect([...magic]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(data.imageBase64).toMatch(/^iVBOR/); // base64 of the same magic
  });

  it('refuses audio assets and missing assets without touching ffmpeg', async () => {
    const editor = new EditorController();
    editor.addMedia({
      id: 'song', path: 'X:/song.wav', filename: 'song.wav', type: 'audio',
      duration: 5, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const executor = new ToolExecutor(editor);

    expect((await executor.execute('inspect_frame', { assetId: 'song', atSeconds: 0 })).error)
      .toMatch(/no frames/i);
    expect((await executor.execute('inspect_frame', { assetId: 'ghost', atSeconds: 0 })).error)
      .toBe('Asset not found.');
  });

  it('reports an undecodable offset cleanly (past end of source)', async () => {
    const { executor } = harness();
    const result = await executor.execute('inspect_frame', {
      assetId: 'bars', atSeconds: 60,
    });
    expect(result.success).toBe(false);
    expect((result as { error?: string }).error).toMatch(/decode|offset/i);
  });
});



