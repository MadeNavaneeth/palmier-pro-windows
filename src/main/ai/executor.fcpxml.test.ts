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
import { parseFcpxml } from '../../shared/fcpxml/importer';
import { applyFcpxmlPlan } from '../../shared/fcpxml/apply';

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
   * pass `'none'` for a document that carries no recovered speed. `twinOwn` writes
   * a level and/or a name onto the TWIN alone — `applyClipProperties` writes
   * exactly the ids it is handed and nothing propagates either across a link,
   * which is what makes a group whose two halves disagree a reachable state.
   */
  function avSourceProject(
    fps: number,
    speed: number | 'none' = 2,
    twinOwn?: { volume?: number; muted?: boolean; label?: string },
  ): EditorController {
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
    if (twinOwn) {
      const { audio } = pairOf(editor);
      editor.applyClipProperties([audio.id], 'Twin own fields', (draft) => {
        if (twinOwn.volume !== undefined) draft.volume = twinOwn.volume;
        if (twinOwn.muted !== undefined) draft.muted = twinOwn.muted;
        if (twinOwn.label !== undefined) draft.label = twinOwn.label;
        return true;
      });
    }
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

  /**
   * The twin's LEVEL is the one thing a linked group does not share: nothing
   * propagates `volume`/`muted` across a link, so the exporter writes the twin's
   * `adjust-volume` on the negative-lane element that the materializer drops in
   * order to let the visual element re-derive the pair. The level has to come off
   * that element, and the sibling's unity is not a substitute.
   */
  it('gives the linked twin its OWN level, not its visual sibling\'s', async () => {
    const source = avSourceProject(30, 2, { volume: 0.25 });
    const sourcePair = pairOf(source);
    expect(sourcePair.video).toMatchObject({ volume: 1, muted: false });
    expect(sourcePair.audio).toMatchObject({ volume: 0.25, muted: false });

    const { result, editor } = await importInto(source, 30);
    expect(result.success).toBe(true);
    const { video: v, audio: a } = pairOf(editor);

    expect(a.volume).toBeCloseTo(0.25, 4);
    expect(a.muted).toBe(false);
    expect(v.volume).toBe(1);
    expect(v.muted).toBe(false);
    // The level does not disturb the group's one shared window.
    expect(a).toMatchObject({ inPoint: 30, outPoint: 126, speed: 2, linkGroupId: v.linkGroupId });
    // And the dropped element placed nothing: still one pair, not two.
    expect(editor.getClips().filter((c) => c.type === 'video')).toHaveLength(1);
    expect(editor.getClips().filter((c) => c.type === 'audio')).toHaveLength(1);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('keeps a muted twin muted through the agent too', async () => {
    const { result, editor } = await importInto(avSourceProject(30, 2, { volume: 0, muted: true }), 30);

    expect(result.success).toBe(true);
    const { video: v, audio: a } = pairOf(editor);
    expect(a.muted).toBe(true);
    expect(a.volume).toBe(0);
    expect(v.muted).toBe(false);
    expect(v.volume).toBe(1);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('costs a leveled pair the same undo arity as an unleveled one', async () => {
    const leveled = await importInto(avSourceProject(30, 2, { volume: 0.25 }), 30);
    const unleveled = await importInto(avSourceProject(30, 2), 30);

    // The level rides the element's ONE batch, so it must not add a step: the
    // literal command lists are identical, which is what keeps the tool's
    // "Each placement is a separate undo step." receipt true.
    const leveledArity = undoArity(leveled.editor);
    expect(leveledArity).toEqual([
      'setClipProperties', 'replaceClips', 'addMediaAndClips', 'addTrack',
    ]);
    expect(leveledArity).toEqual(undoArity(unleveled.editor));
  }, REAL_PROCESS_TIMEOUT_MS);

  /**
   * The twin's NAME, which is not a judgement call either: `label` is declared on
   * both plan types, the exporter writes each half's own `name` into its own
   * element, and the model holds two clips with two names. The twin takes the name
   * from the element written for it — the one the materializer drops — and the
   * sibling's name is not a substitute.
   */
  it('gives the linked twin its OWN name through the agent too', async () => {
    const source = avSourceProject(30, 2, { label: 'Dialogue' });
    const sourcePair = pairOf(source);
    expect(sourcePair.video.label).toBe('av.mp4');
    expect(sourcePair.audio.label).toBe('Dialogue');

    const { result, editor } = await importInto(source, 30);
    expect(result.success).toBe(true);
    const { video: v, audio: a } = pairOf(editor);

    expect(a.label).toBe('Dialogue');
    // The rename must not leak onto the visual half, and the window and level
    // fixes are untouched beside it.
    expect(v.label).toBe('av.mp4');
    expect(a).toMatchObject({ inPoint: 30, outPoint: 126, speed: 2, linkGroupId: v.linkGroupId });
    expect(a.volume).toBe(1);
    // The dropped element placed nothing: still one pair, not two.
    expect(editor.getClips().filter((c) => c.type === 'video')).toHaveLength(1);
    expect(editor.getClips().filter((c) => c.type === 'audio')).toHaveLength(1);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('costs a renamed pair the same undo arity, and a matching name no step at all', async () => {
    const renamed = await importInto(avSourceProject(30, 2, { label: 'Dialogue' }), 30);
    const matching = await importInto(avSourceProject(30, 2), 30);

    // The literal command list for the renamed pair: one batch, exactly what the
    // unrenamed pair pushes, so the name adds no undo step of its own.
    const renamedArity = undoArity(renamed.editor);
    expect(renamedArity).toEqual([
      'setClipProperties', 'replaceClips', 'addMediaAndClips', 'addTrack',
    ]);
    expect(renamedArity).toEqual(undoArity(matching.editor));
  }, REAL_PROCESS_TIMEOUT_MS);

  /**
   * The fourth twin site. BOTH halves renamed to the same custom string used to
   * read as "the halves agree" and so be mistaken for "the twin is already right",
   * leaving the twin on `addClip`'s asset filename. The rule now states the name
   * and the patch compares it against the draft, so all four sites behave alike.
   */
  it('gives the twin the shared name when BOTH halves were renamed to it', async () => {
    const source = avSourceProject(30, 2);
    const { video: sourceVideo, audio: sourceAudio } = pairOf(source);
    for (const id of [sourceVideo.id, sourceAudio.id]) {
      source.applyClipProperties([id], 'Rename both halves', (draft) => {
        draft.label = 'Take 2';
        return true;
      });
    }
    // The premise: the file really does give both elements the same name.
    const xml = exportFcpxml(source.getProject());
    expect(xml.match(/name="Take 2"/g)).toHaveLength(2);

    const { result, editor } = await importInto(source, 30);
    expect(result.success).toBe(true);
    const { video: v, audio: a } = pairOf(editor);

    expect(a.label).toBe('Take 2');
    // The visual half is untouched by the twin's rename, and the window/speed and
    // duplication behaviour are the same as every other pair.
    expect(v.label).toBe('av.mp4');
    expect(a).toMatchObject({ inPoint: 30, outPoint: 126, speed: 2, linkGroupId: v.linkGroupId });
    expect(editor.getClips()).toHaveLength(2);
    expect(undoArity(editor)).toEqual(undoArity((await importInto(avSourceProject(30, 2), 30)).editor));
  }, REAL_PROCESS_TIMEOUT_MS);

  /**
   * A title, in the same style as `avSourceProject` above: on the track, with
   * `styled` deciding whether the adjustment pass writes anything at all.
   */
  function titleSourceProject(styled: boolean): EditorController {
    const editor = at(30);
    const titleId = editor.addTitleClip({
      trackId: 'v1', text: styled ? 'Styled' : 'Plain', startFrame: 10, durationFrames: 45,
    });
    if (styled) {
      editor.applyClipProperties([titleId], 'Title', (draft) => {
        draft.titleColor = '#ffcc00';
        draft.titleSizeRatio = 0.08;
        draft.titleFontFamily = 'Georgia';
        draft.titleAlign = 'left';
        draft.opacity = 0.4;
        draft.x = 100;
        draft.y = 50;
        draft.width = 640;
        draft.height = 360;
        draft.rotation = 0.05;
        return true;
      });
    }
    return editor;
  }

  const titleOf = (editor: EditorController): Clip =>
    editor.getClips().find((c) => c.type === 'title')!;

  const titleState = (editor: EditorController): Record<string, unknown> => {
    const t = titleOf(editor);
    return {
      text: t.text, opacity: t.opacity, x: t.x, y: t.y, width: t.width, height: t.height,
      rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY,
      titleColor: t.titleColor, titleSizeRatio: t.titleSizeRatio,
      titleFontFamily: t.titleFontFamily, titleAlign: t.titleAlign,
      startFrame: t.startFrame, durationFrames: t.durationFrames,
    };
  };

  it('keeps a styled title opacity and geometry instead of resetting them', async () => {
    const source = titleSourceProject(true);
    expect(titleOf(source)).toMatchObject({ opacity: 0.4, rotation: 0.05 });

    const { result, editor } = await importInto(source, 30);
    expect(result.success).toBe(true);
    const data = result.data as { titles: number; placedClips: number; note: string };
    expect(data).toMatchObject({ titles: 1, placedClips: 0, note: 'Each placement is a separate undo step.' });

    const t = titleOf(editor);
    // Opacity and the whole transform box survive; before the fix every one of
    // these was the addTitleClip default (1, 0, 0, 1920, 1080, 0).
    expect(t.opacity).toBe(0.4);
    expect(t.rotation).toBeCloseTo(0.05, 6);
    expect(t.width).not.toBe(1920);
    expect(t.height).not.toBe(1080);
    expect(t.x).not.toBe(0);
    // The title's own style still lands, including the lossy px->ratio step.
    expect(t).toMatchObject({ text: 'Styled', titleColor: '#FFCC00', titleFontFamily: 'Georgia', titleAlign: 'left' });
    expect(t.titleSizeRatio).toBeCloseTo(0.08, 2);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('leaves a plain title byte-identical and adds no undo step', async () => {
    const { result, editor } = await importInto(titleSourceProject(false), 30);

    expect(result.success).toBe(true);
    // The pre-fix values for a title carrying no adjustments at all.
    expect(titleState(editor)).toEqual({
      text: 'Plain',
      opacity: 1,
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      titleColor: '#FFFFFF',
      titleSizeRatio: 0.08981481481481482,
      titleFontFamily: 'sans-serif',
      titleAlign: 'center',
      startFrame: 10,
      durationFrames: 45,
    });
    // Still one style command: the shared patch rides the title's own batch.
    expect(undoArity(editor)).toEqual(['setClipProperties', 'replaceClips', 'addTrack']);
  }, REAL_PROCESS_TIMEOUT_MS);

  it('costs a title import the same undo arity as before', async () => {
    const styled = await importInto(titleSourceProject(true), 30);
    const plain = await importInto(titleSourceProject(false), 30);

    // A title is one track, one clip, one batch — three steps, whatever it
    // carries. Folding the patch in must not add a fourth.
    const styledArity = undoArity(styled.editor);
    expect(styledArity).toEqual(['setClipProperties', 'replaceClips', 'addTrack']);
    expect(styledArity).toEqual(undoArity(plain.editor));
  }, REAL_PROCESS_TIMEOUT_MS);

  it('agrees with the dialog path on a title, field for field', async () => {
    const source = titleSourceProject(true);
    const xmlPath = path.join(tmpDir, 'title-agree.fcpxml');
    await fs.writeFile(xmlPath, exportFcpxml(source.getProject()), 'utf8');
    const xml = await fs.readFile(xmlPath, 'utf8');

    const agent = at(30);
    await new ToolExecutor(agent).execute('import_fcpxml', { path: xmlPath });
    const shared = at(30);
    applyFcpxmlPlan(shared, parseFcpxml(xml), new Map(), new Map());

    // The two surfaces now share one title entry point, so they cannot disagree
    // on which value survives a field both write — the composition order lives in
    // apply.ts once, not in two matching copies.
    expect(titleState(agent)).toEqual(titleState(shared));
    // Sanity that the comparison is not vacuous: the styled title really does
    // differ from a default one, so an all-default match would mean nothing.
    expect(titleOf(agent).opacity).toBe(0.4);
    expect(titleOf(agent).width).not.toBe(1920);
  }, REAL_PROCESS_TIMEOUT_MS);
});
