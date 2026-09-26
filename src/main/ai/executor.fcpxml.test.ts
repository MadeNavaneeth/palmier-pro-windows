/**
 * End-to-end coverage for the FCPXML agent tools (#154 phase 2b): export
 * writes what the importer reads, import materializes tracks/clips/titles,
 * and offline assets degrade to a report instead of failing the run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import { exportFcpxml } from '../../shared/fcpxml/exporter';

// Real ffprobe calls are subprocess-bound; keep their timeout explicit so a
// loaded parallel run does not inherit the 5 s default used by fast unit tests.
const REAL_PROCESS_TIMEOUT_MS = 30_000;

/** Minimal valid mono WAV so ffprobe accepts the fixture asset. */
function makeWav(): Buffer {
  const sampleRate = 8000;
  const dataSize = sampleRate * 2; // 1s mono 16-bit
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

describe('import_fcpxml / export_fcpxml (#154 phase 2b)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-fcpxml-'));
    await fs.writeFile(path.join(tmpDir, 'audio.wav'), makeWav());
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function sourceProject(): EditorController {
    const editor = new EditorController();
    const wavPath = path.join(tmpDir, 'audio.wav');
    // addClip derives type from the registered asset.
    editor.addMedia({
      id: 'music',
      path: wavPath,
      filename: 'audio.wav',
      type: 'audio',
      duration: 1,
      fileSize: 8200,
      addedAt: new Date().toISOString(),
    });
    const clipId = editor.addClip({ assetId: 'music', trackId: 'a1', startFrame: 30, durationFrames: 30 });
    editor.trimClip(clipId, 0, 30);
    return editor;
  }

  it('round-trips through disk into a fresh editor', async () => {
    const source = sourceProject();
    const xmlPath = path.join(tmpDir, 'out.fcpxml');
    await fs.writeFile(xmlPath, exportFcpxml(source.getProject()), 'utf8');

    const fresh = new EditorController();
    const result = await new ToolExecutor(fresh).execute('import_fcpxml', { path: xmlPath });

    expect(result.success).toBe(true);
    const data = result.data as { placedClips: number; assetsAdded: number; tracksCreated: number };
    expect(data.placedClips).toBe(1);
    expect(data.assetsAdded).toBe(1);
    expect(data.tracksCreated).toBeGreaterThanOrEqual(2); // spine video + audio lane

    // The imported clip lands on the synthesized audio lane at the right spot.
    const audioTrack = fresh.getTracks().find((t) => t.type === 'audio' && t.name !== 'Audio 1');
    expect(audioTrack).toBeDefined();
    const imported = fresh.getClips().find((c) => c.trackId === audioTrack!.id)!;
    expect(imported.startFrame).toBe(30);
    expect(imported.durationFrames).toBe(30);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('reports offline assets and skips their clips without failing', async () => {
    const source = sourceProject();
    let xml = exportFcpxml(source.getProject());
    // Point the resource at a path that does not exist on this machine.
    xml = xml.replace(/src="file:\/\/\/[^"]*"/, 'src="file:///Z:/missing/audio.wav"');
    const xmlPath = path.join(tmpDir, 'offline.fcpxml');
    await fs.writeFile(xmlPath, xml, 'utf8');

    const fresh = new EditorController();
    const result = await new ToolExecutor(fresh).execute('import_fcpxml', { path: xmlPath });

    expect(result.success).toBe(true);
    const data = result.data as { placedClips: number; offline: string[] };
    expect(data.placedClips).toBe(0);
    expect(data.offline[0]).toContain('missing');
    expect(fresh.getMedia()).toHaveLength(0);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('exports the current timeline to an absolute path', async () => {
    const editor = sourceProject();
    const outPath = path.join(tmpDir, 'written.fcpxml');

    const result = await new ToolExecutor(editor).execute('export_fcpxml', { path: outPath });

    expect(result.success).toBe(true);
    const written = await fs.readFile(outPath, 'utf8');
    expect(written).toContain('<fcpxml version="1.11">');
    expect(written).toContain('<spine>');
    const data = result.data as {
      path: string;
      exportedClips: number;
      skippedClips: number;
      unsupported: string[];
      unsupportedTotal: number;
      unsupportedTruncated: boolean;
    };
    expect(data.path).toBe(outPath);
    expect(data.exportedClips).toBe(1);
    expect(data.skippedClips).toBe(0);
    expect(data.unsupported).toEqual([]);
    expect(data.unsupportedTotal).toBe(0);
    expect(data.unsupportedTruncated).toBe(false);
  });

  it('surfaces skipped shape clips in the export receipt without changing the XML', async () => {
    const editor = sourceProject();
    const shapeId = editor.addShapeClip({ trackId: 'v1', shapeKind: 'rect', startFrame: 60, durationFrames: 30 });
    expect(shapeId).not.toBe('');
    const outPath = path.join(tmpDir, 'shape.fcpxml');

    const result = await new ToolExecutor(editor).execute('export_fcpxml', { path: outPath });

    expect(result.success).toBe(true);
    const data = result.data as {
      exportedClips: number;
      skippedClips: number;
      unsupported: string[];
      unsupportedTotal: number;
      unsupportedTruncated: boolean;
    };
    expect(data.exportedClips).toBe(1);
    expect(data.skippedClips).toBe(1);
    expect(data.unsupported).toHaveLength(1);
    expect(data.unsupported[0]).toContain(shapeId);
    expect(data.unsupportedTotal).toBe(1);
    expect(data.unsupportedTruncated).toBe(false);

    const written = await fs.readFile(outPath, 'utf8');
    expect(written).toBe(exportFcpxml(editor.getProject()));
    expect(written).not.toContain('__shape__');
  });

  it('truncates long export unsupported lists but keeps accurate totals', async () => {
    const editor = new EditorController();
    for (let i = 0; i < 25; i += 1) {
      editor.addShapeClip({ trackId: 'v1', shapeKind: 'rect', startFrame: i * 10, durationFrames: 10 });
    }
    const outPath = path.join(tmpDir, 'many.fcpxml');

    const result = await new ToolExecutor(editor).execute('export_fcpxml', { path: outPath });

    expect(result.success).toBe(true);
    const data = result.data as {
      exportedClips: number;
      skippedClips: number;
      unsupported: string[];
      unsupportedTotal: number;
      unsupportedTruncated: boolean;
    };
    expect(data.skippedClips).toBe(25);
    expect(data.unsupportedTotal).toBe(25);
    expect(data.unsupported).toHaveLength(20);
    expect(data.unsupportedTruncated).toBe(true);
    expect(data.exportedClips).toBe(0);
  });
});
