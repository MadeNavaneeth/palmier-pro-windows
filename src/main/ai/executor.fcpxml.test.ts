/**
 * End-to-end coverage for the FCPXML agent tools (#154 phase 2b): export
 * writes what the importer reads, import materializes tracks/clips/titles,
 * and offline assets degrade to a report instead of failing the run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import { ToolExecutor } from './executor';
import { EditorController } from '../../shared/editor/controller';
import type { Clip } from '../../shared/types/project';
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

/**
 * The agent's `import_fcpxml` inlines placement rather than delegating to
 * `applyFcpxmlPlan`, so it asks the shared module for the rate rule and for the
 * adjustment batch instead of re-deriving them. These pin that: a rate too slow
 * to map frames is refused and reported instead of placing invented positions, a
 * zero or unparseable rate never reaches a clip as Infinity/NaN, a linked A/V
 * group comes back on one source window with the twin carrying the group's speed
 * without costing an extra undo step, and every usable rate keeps the exact
 * numbers the unshared converter produced.
 */
describe('import_fcpxml per-clip reconstruction (#154)', () => {
  let tmpDir: string;
  let avPath: string;

  /** A 1 s A/V MP4, so ffprobe reports the audio stream a linked twin needs. */
  function makeAv(file: string): void {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
    ]);
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palmier-fcpxml-fps-'));
    avPath = path.join(tmpDir, 'av.mp4');
    makeAv(avPath);
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function at(fps: number): EditorController {
    const editor = new EditorController();
    editor.applyProjectSettings({ fps });
    return editor;
  }

  /**
   * One trimmed clip over the A/V asset, so `addClip` builds its linked twin.
   * `speed` defaults to 2x, which `setClipSpeed` writes onto BOTH halves;
   * pass `'none'` for a document that carries no recovered speed.
   */
  function avSourceProject(fps: number, speed: number | 'none' = 2): EditorController {
    const editor = at(fps);
    editor.addMedia({
      id: 'av',
      path: avPath,
      filename: 'av.mp4',
      type: 'video',
      duration: fps * 2,
      width: 64,
      height: 64,
      fileSize: 1,
      addedAt: new Date().toISOString(),
      audioCodec: 'aac',
      channels: 2,
      sampleRate: 48000,
    });
    const clipId = editor.addClip({ assetId: 'av', trackId: 'v1', startFrame: 20, durationFrames: 48 });
    editor.trimClip(clipId, 30, 78);
    if (speed !== 'none') editor.setClipSpeed(clipId, speed);
    return editor;
  }

  /** Write `source`'s export, optionally with only its declared rate replaced. */
  async function importInto(
    source: EditorController, projFps: number, frameDuration?: string,
  ): Promise<{ result: Awaited<ReturnType<ToolExecutor['execute']>>; editor: EditorController }> {
    let xml = exportFcpxml(source.getProject());
    if (frameDuration !== undefined) {
      xml = xml.replace(/frameDuration="[^"]*"/, `frameDuration="${frameDuration}"`);
    }
    const xmlPath = path.join(tmpDir, 'in.fcpxml');
    await fs.writeFile(xmlPath, xml, 'utf8');
    const editor = at(projFps);
    const result = await new ToolExecutor(editor).execute('import_fcpxml', { path: xmlPath });
    return { result, editor };
  }

  const framesOf = (editor: EditorController): number[] =>
    editor.getClips().flatMap((c) => [c.startFrame, c.durationFrames, c.inPoint, c.outPoint]);

  const pairOf = (editor: EditorController): { video: Clip; audio: Clip } => {
    const video = editor.getClips().find((c) => c.type === 'video')!;
    const audio = editor.getClips().find((c) => c.type === 'audio')!;
    return { video, audio };
  };

  const video = (editor: EditorController): Clip =>
    editor.getClips().find((c) => c.type === 'video')!;

  /** Command descriptions of every undo step, innermost first. */
  function undoArity(editor: EditorController): string[] {
    const descriptions: string[] = [];
    while (editor.canUndo() && descriptions.length < 20) {
      descriptions.push(editor.getLastCommandDescription() ?? '?');
      editor.undo();
    }
    return descriptions;
  }

  for (const { frameDuration, fps, label } of [
    { frameDuration: '2s', fps: 0.5, label: '0.5 fps' },
    { frameDuration: '100s', fps: 0.01, label: '0.01 fps' },
  ]) {
    it(`refuses a ${label} document instead of misplacing its clip`, async () => {
      const { result, editor } = await importInto(avSourceProject(30), 30, frameDuration);

      expect(result.success).toBe(false);
      // The shared wording, identical to the one the dialog path reports.
      expect(result.error).toBe(
        `<format frameDuration> declares ${fps} fps, too slow to map frames; nothing is imported.`,
      );
      expect(editor.getClips()).toEqual([]);
      // Refused before any asset is probed, so the library is untouched too.
      expect(editor.getMedia()).toEqual([]);
    }, REAL_PROCESS_TIMEOUT_MS);
  }

  it('puts no Infinity or NaN on a clip for a zero or unparseable rate', async () => {
    for (const frameDuration of ['1000s', 'garbage']) {
      const { result, editor } = await importInto(avSourceProject(30), 30, frameDuration);

      expect(result.success, frameDuration).toBe(false);
      expect(result.error, frameDuration)
        .toBe('The file has no usable <format frameDuration>; frame mapping is undefined.');
      expect(framesOf(editor).every(Number.isFinite), frameDuration).toBe(true);
      expect(editor.getClips(), frameDuration).toEqual([]);
    }
  }, REAL_PROCESS_TIMEOUT_MS);

  it('keeps a matched rate byte-identical', async () => {
    const { result, editor } = await importInto(avSourceProject(30), 30);

    expect(result.success).toBe(true);
    const data = result.data as { placedClips: number; assetsAdded: number; tracksCreated: number; unsupported: string[] };
    expect(data).toMatchObject({ placedClips: 1, titles: 0, assetsAdded: 1, tracksCreated: 1, offline: [] });
    expect(data.unsupported).toEqual([]);
    expect(video(editor)).toMatchObject({ startFrame: 20, durationFrames: 48, inPoint: 30, outPoint: 126, speed: 2 });
  }, REAL_PROCESS_TIMEOUT_MS);

  it('keeps a slower document rescaled up, and its linked twin beside it', async () => {
    const { result, editor } = await importInto(avSourceProject(24), 30);

    expect(result.success).toBe(true);
    const data = result.data as { placedClips: number; unsupported: string[] };
    expect(data.placedClips).toBe(1);
    expect(data.unsupported).toEqual([]);
    const { video: v, audio: a } = pairOf(editor);
    expect(v).toMatchObject({ startFrame: 25, durationFrames: 60, inPoint: 38, outPoint: 158, speed: 2 });
    expect(a).toMatchObject({ startFrame: 25, durationFrames: 60, inPoint: 38, linkGroupId: v.linkGroupId });
    // 2 s and 30 frames of source, in seconds, survive the 1.25x rescale.
    expect(v.startFrame / 30).toBeCloseTo(20 / 24, 6);
    expect(v.durationFrames / 30).toBeCloseTo(48 / 24, 6);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('keeps a faster document rescaled down', async () => {
    const { result, editor } = await importInto(avSourceProject(30), 24);

    expect(result.success).toBe(true);
    expect(video(editor)).toMatchObject({ startFrame: 16, durationFrames: 38, inPoint: 24, outPoint: 100, speed: 2 });
  }, REAL_PROCESS_TIMEOUT_MS);

  it('gives the linked twin the group speed and the same window, as the source had it', async () => {
    const source = avSourceProject(30, 2);
    const sourcePair = pairOf(source);
    // setClipSpeed writes speed and the scaled outPoint onto BOTH halves.
    expect(sourcePair.video).toMatchObject({ inPoint: 30, outPoint: 126, speed: 2 });
    expect(sourcePair.audio).toMatchObject({ inPoint: 30, outPoint: 126, speed: 2 });

    const { result, editor } = await importInto(source, 30);
    expect(result.success).toBe(true);
    const { video: v, audio: a } = pairOf(editor);

    // The twin must not be left on the unscaled window: that is a state
    // setClipSpeed never writes, and the exporter never emits.
    expect(a).toMatchObject({
      startFrame: 20, durationFrames: 48, inPoint: 30, outPoint: 126, speed: 2,
      linkGroupId: v.linkGroupId,
    });
    // Both halves come back exactly as the source held them. Ids are freshly
    // minted on import, so compare the edit state, not the identities.
    const windowOf = (c: Clip) => ({
      startFrame: c.startFrame, durationFrames: c.durationFrames,
      inPoint: c.inPoint, outPoint: c.outPoint, speed: c.speed,
    });
    expect(windowOf(v)).toEqual(windowOf(sourcePair.video));
    expect(windowOf(a)).toEqual(windowOf(sourcePair.audio));
    expect(a.outPoint - a.inPoint).toBe(Math.round(a.durationFrames * 2));
  }, REAL_PROCESS_TIMEOUT_MS);

  it('leaves an unspeeded linked pair alone and adds no undo step', async () => {
    const { result, editor } = await importInto(avSourceProject(30, 'none'), 30);

    expect(result.success).toBe(true);
    const { video: v, audio: a } = pairOf(editor);
    // No recovered speed in the document, so nothing about the pair moves.
    expect(v).toMatchObject({ startFrame: 20, durationFrames: 48, inPoint: 30, outPoint: 78 });
    expect(a).toMatchObject({ startFrame: 20, durationFrames: 48, inPoint: 30, outPoint: 78 });
    // `speed` must be absent, not merely equal to one: toMatchObject treats an
    // explicit undefined as "this key is present and undefined".
    expect(v.speed).toBeUndefined();
    expect(a.speed).toBeUndefined();
    expect(a.linkGroupId).toBe(v.linkGroupId);
    // The adjustment batch still runs once — the visual clip's own speed is
    // absent too, so this is the pre-existing single step, not an added one.
    expect(undoArity(editor)).toEqual([
      'setClipProperties', 'replaceClips', 'addMediaAndClips', 'addTrack',
    ]);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('costs the 2x pair the same undo arity as the unspeeded one', async () => {
    const sped = await importInto(avSourceProject(30, 2), 30);
    const plain = await importInto(avSourceProject(30, 'none'), 30);

    const data = sped.result.data as { note: string; placedClips: number };
    expect(data.note).toBe('Each placement is a separate undo step.');
    expect(data.placedClips).toBe(1);
    // The twin's speed rides the visual element's single batch, so it must not
    // add a step: the two imports push the same arity and the same commands.
    // Drain each editor once — undoArity consumes the history it walks.
    const spedArity = undoArity(sped.editor);
    expect(spedArity).toEqual([
      'setClipProperties', 'replaceClips', 'addMediaAndClips', 'addTrack',
    ]);
    expect(spedArity).toEqual(undoArity(plain.editor));
  }, REAL_PROCESS_TIMEOUT_MS);
});
