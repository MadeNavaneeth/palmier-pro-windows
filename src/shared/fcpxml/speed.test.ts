/**
 * Constant clip speed through FCPXML (upstream #154/#289).
 *
 * The upstream map is a whole-media linear time map: output time advances
 * slower/faster while the source value advances at the model-defined speed.
 * These tests pin the XML shape, the effectiveSpeed-backed timebase, import
 * rejection of non-constant maps, and the single adjustment batch.
 */
import { describe, expect, it } from 'vitest';
import { EditorController } from '../editor/controller';
import { effectiveSpeed, projectFramesToSeconds } from '../media/source-time';
import { exportFcpxml, exportFcpxmlWithReport } from './exporter';
import { parseFcpxml, parseFcpxmlTime, type ImportedVideoClip } from './importer';
import { applyFcpxmlPlan } from './apply';

const MEDIA_PATH = 'X:/media/speed.mp4';
const MEDIA_FRAMES = 300;
const FPS = 30;
const DIMS = new Map([[MEDIA_PATH, { width: 1920, height: 1080 }]]);

function sourceEditor(options: {
  speed?: number;
  startFrame?: number;
  inPoint?: number;
  durationFrames?: number;
  mediaFrames?: number;
} = {}): { editor: EditorController; clipId: string } {
  const editor = new EditorController();
  editor.addMedia({
    id: 'source',
    path: MEDIA_PATH,
    filename: 'speed.mp4',
    type: 'video',
    duration: options.mediaFrames ?? MEDIA_FRAMES,
    width: 1920,
    height: 1080,
    fileSize: 1,
    addedAt: '2026-08-26T00:00:00.000Z',
  });
  const durationFrames = options.durationFrames ?? 90;
  const inPoint = options.inPoint ?? 15;
  const clipId = editor.addClip({
    assetId: 'source',
    trackId: 'v1',
    startFrame: options.startFrame ?? 0,
    durationFrames,
  });
  if (inPoint !== 0) editor.trimClip(clipId, inPoint, inPoint + durationFrames);
  if (options.speed !== undefined) editor.setClipSpeed(clipId, options.speed);
  return { editor, clipId };
}

function targetEditor(): EditorController {
  const editor = new EditorController();
  editor.addMedia({
    id: 'imported',
    path: MEDIA_PATH,
    filename: 'speed.mp4',
    type: 'video',
    duration: MEDIA_FRAMES,
    width: 1920,
    height: 1080,
    fileSize: 1,
    addedAt: '2026-08-26T00:00:00.000Z',
  });
  return editor;
}

function bodyDoc(body: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
    '<fcpxml version="1.11"><resources>',
    '<format id="r1" frameDuration="0.033333s" width="1920" height="1080"/>',
    '<asset id="2" name="speed.mp4" src="file:///X:/media/speed.mp4" start="0s" duration="10s" hasVideo="1" format="r1"/>',
    '<asset id="3" name="audio.wav" src="file:///X:/media/audio.wav" start="0s" duration="10s" hasAudio="1"/>',
    '</resources><library><event name="E"><project name="E"><spine>',
    `<asset-clip name="Clip" offset="0s" duration="2s" start="0s" ref="2">${body}</asset-clip>`,
    '</spine></project></event></library></fcpxml>',
  ].join('');
}

function importedVideo(plan: ReturnType<typeof parseFcpxml>): ImportedVideoClip {
  const clip = plan.clips.find((candidate): candidate is ImportedVideoClip => candidate.kind === 'video');
  if (!clip) throw new Error('expected an imported video clip');
  return clip;
}

describe('constant speed FCPXML export (#154/#289)', () => {
  it('emits the upstream whole-media timeMap shape for a 2x visual clip', () => {
    const { editor } = sourceEditor({ speed: 2, inPoint: 10, durationFrames: 60, mediaFrames: 150 });
    const xml = exportFcpxml(editor.getProject());

    expect(xml).toContain(
      '<asset-clip name="speed.mp4" offset="0.000000s" duration="2.000000s" start="1/6s" ref="2">'
      + '<timeMap frameSampling="floor">'
      + '<timept time="0s" value="0s" interp="linear"/>'
      + '<timept time="5/2s" value="5s" interp="linear"/>'
      + '</timeMap><adjust-conform type="fit"/></asset-clip>',
    );
    expect(xml.match(/<timept\b/g)).toHaveLength(2);
  });

  it('keeps absent and unit speed byte-identical to the unspeeded export', () => {
    const unspeeded = sourceEditor();
    const unit = sourceEditor({ speed: 1 });
    const before = exportFcpxml(unspeeded.editor.getProject());
    const after = exportFcpxml(unit.editor.getProject());

    expect(after).toBe(before);
    expect(after).not.toContain('<timeMap');
    expect(after).not.toContain('<timept');
  });

  it('derives both timeMap endpoints from effectiveSpeed and the project timebase', () => {
    const speed = 2;
    const effective = effectiveSpeed(speed);
    const { editor } = sourceEditor({ speed, inPoint: 15 });
    const xml = exportFcpxml(editor.getProject());
    const timePoints = [...xml.matchAll(/<timept\b([^>]*)\/>/g)].map((match) => match[1]!);
    const first = timePoints[0]!;
    const second = timePoints[1]!;
    const attr = (tag: string, name: string): string => tag.match(new RegExp(`${name}="([^"]*)"`))![1]!;

    const sourceEnd = projectFramesToSeconds(MEDIA_FRAMES, FPS);
    const outputEnd = sourceEnd / effective;
    expect(parseFcpxmlTime(attr(first, 'time'))).toBe(0);
    expect(parseFcpxmlTime(attr(first, 'value'))).toBe(0);
    expect(parseFcpxmlTime(attr(second, 'time'))).toBeCloseTo(outputEnd, 6);
    expect(parseFcpxmlTime(attr(second, 'value'))).toBeCloseTo(sourceEnd, 6);
  });
});

describe('constant speed FCPXML import and apply (#154/#289)', () => {
  it('round-trips a non-zero timeline start and source trim through apply', () => {
    const source = sourceEditor({ speed: 2, startFrame: 45, inPoint: 15 });
    const sourceClip = source.editor.getClips().find((clip) => clip.id === source.clipId)!;
    const plan = parseFcpxml(exportFcpxml(source.editor.getProject()));

    expect(plan.unsupported).toEqual([]);
    expect(importedVideo(plan)).toMatchObject({
      speed: 2,
      startFrame: 45,
      durationFrames: 90,
      sourceInFrame: 15,
    });

    const target = targetEditor();
    const result = applyFcpxmlPlan(target, plan, new Map([[MEDIA_PATH, 'imported']]), DIMS);
    expect(result.placedClips).toBe(1);
    const restored = target.getClips().find((clip) => clip.assetId === 'imported')!;
    expect(restored.speed).toBe(sourceClip.speed);
    expect(restored.startFrame).toBe(sourceClip.startFrame);
    expect(restored.durationFrames).toBe(sourceClip.durationFrames);
    expect(restored.inPoint).toBe(sourceClip.inPoint);
    expect(restored.outPoint).toBe(sourceClip.outPoint);
    expect(restored.outPoint).toBe(restored.inPoint + restored.durationFrames * effectiveSpeed(2));
  });

  it('reports malformed, unparseable, and non-constant timeMaps instead of dropping them silently', () => {
    const cases = [
      [
        'malformed',
        '<timeMap frameSampling="floor"><timept time="0s" value="0s" interp="linear"/>',
      ],
      [
        'unparseable',
        '<timeMap frameSampling="floor"><timept time="bad" value="0s" interp="linear"/>'
        + '<timept time="1s" value="2s" interp="linear"/></timeMap>',
      ],
      [
        'non-constant',
        '<timeMap frameSampling="floor"><timept time="0s" value="0s" interp="linear"/>'
        + '<timept time="1s" value="1s" interp="linear"/>'
        + '<timept time="2s" value="4s" interp="linear"/></timeMap>',
      ],
    ] as const;

    for (const [name, body] of cases) {
      const plan = parseFcpxml(bodyDoc(body));
      expect(plan.unsupported.some((note) => /timeMap/i.test(note)), name).toBe(true);
      expect(importedVideo(plan).speed, name).toBeUndefined();
    }
  });

  it('applies speed and the scaled source window in one adjustment undo step', () => {
    const source = sourceEditor({ speed: 2, inPoint: 15 });
    const plan = parseFcpxml(exportFcpxml(source.editor.getProject()));
    const target = targetEditor();

    applyFcpxmlPlan(target, plan, new Map([[MEDIA_PATH, 'imported']]), DIMS);
    const imported = target.getClips().find((clip) => clip.assetId === 'imported')!;
    expect(target.getLastCommandDescription()).toBe('setClipProperties');
    expect(imported.speed).toBe(2);
    expect(imported.outPoint).toBe(imported.inPoint + imported.durationFrames * 2);

    expect(target.undo()).toBe(true);
    const afterUndo = target.getClips().find((clip) => clip.assetId === 'imported')!;
    expect(afterUndo.speed).toBeUndefined();
    expect(afterUndo.outPoint).toBe(afterUndo.inPoint + afterUndo.durationFrames);
  });

  it('reports a timeMap on an audio-only clip because speed is visual-only', () => {
    const plan = parseFcpxml(bodyDoc('').replace(
      '<asset-clip name="Clip" offset="0s" duration="2s" start="0s" ref="2"></asset-clip>',
      '<asset-clip name="Music" offset="0s" duration="2s" start="0s" ref="3">'
      + '<timeMap frameSampling="floor"><timept time="0s" value="0s" interp="linear"/>'
      + '<timept time="1s" value="2s" interp="linear"/></timeMap></asset-clip>',
    ));
    expect(plan.clips[0]?.kind).toBe('audio');
    expect(plan.unsupported.some((note) => /timeMap/i.test(note))).toBe(true);
  });
});

describe('FCPXML speed omission reporting', () => {
  it('reports a non-unit speed when the visual source has no usable duration', () => {
    const editor = new EditorController();
    editor.addMedia({
      id: 'still',
      path: 'X:/media/still.png',
      filename: 'still.png',
      type: 'image',
      duration: 0,
      width: 1920,
      height: 1080,
      fileSize: 1,
      addedAt: '2026-08-26T00:00:00.000Z',
    });
    const clipId = editor.addClip({ assetId: 'still', trackId: 'v1', startFrame: 0, durationFrames: 30 });
    editor.applyClipProperties([clipId], 'speed', (draft) => {
      draft.speed = 2;
      return true;
    });

    const report = exportFcpxmlWithReport(editor.getProject());
    expect(report.xml).not.toContain('<timeMap');
    expect(report.unsupported.some((note) => /speed|timeMap/i.test(note))).toBe(true);
  });
});
