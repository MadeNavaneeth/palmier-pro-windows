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
  });

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
  });

  it('exports the current timeline to an absolute path', async () => {
    const editor = sourceProject();
    const outPath = path.join(tmpDir, 'written.fcpxml');

    const result = await new ToolExecutor(editor).execute('export_fcpxml', { path: outPath });

    expect(result.success).toBe(true);
    const written = await fs.readFile(outPath, 'utf8');
    expect(written).toContain('<fcpxml version="1.11">');
    expect(written).toContain('<spine>');
  });
});
