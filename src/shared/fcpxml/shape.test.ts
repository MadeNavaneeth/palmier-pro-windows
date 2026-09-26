/**
 * Shape-clip interchange: explicit skip-reporting, not silent drops.
 *
 * Upstream has no shapes and no FCPXML shape transport, so there is nothing
 * to mirror. The contract (like grades, effects, crop keyframes and keyframed
 * audio) is: export skips shape clips with an id+reason note, import reports
 * shape-ish constructs (generators/shapes/graphics) and any unknown spine
 * element, titles and static clips are untouched, and export->import->export
 * is stable apart from the report entries. Generated clips with missing
 * media get the same per-clip treatment in the same list.
 */
import { describe, expect, it } from 'vitest';
import { EditorController } from '../editor/controller';
import type { Project } from '../types/project';
import { exportFcpxml, exportFcpxmlWithReport } from './exporter';
import { parseFcpxml } from './importer';
import { applyFcpxmlPlan } from './apply';

const MEDIA_PATH = 'X:/media/clip.mp4';

function editorWithVideoAndShape(): { editor: EditorController; shapeId: string } {
  const editor = new EditorController();
  editor.addMedia({
    id: 'v',
    path: MEDIA_PATH,
    filename: 'clip.mp4',
    type: 'video',
    duration: 300,
    width: 1920,
    height: 1080,
    fileSize: 1,
    addedAt: '2026-08-26T00:00:00.000Z',
  });
  editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 30 });
  const shapeId = editor.addShapeClip({
    trackId: 'v1',
    shapeKind: 'rect',
    startFrame: 30,
    durationFrames: 30,
  });
  return { editor, shapeId };
}

function framesDoc(clipBody: string, spineExtra = ''): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
    '<fcpxml version="1.11"><resources>',
    '<format id="r1" frameDuration="0.033333s" width="1920" height="1080"/>',
    '<asset id="2" name="clip.mp4" src="file:///X:/media/clip.mp4" start="0s" duration="10s" hasVideo="1" hasAudio="1" format="r1"/>',
    '</resources><library><event name="E"><project name="E"><spine>',
    `<asset-clip name="Clip" offset="0s" duration="2s" start="0s" ref="2">${clipBody}</asset-clip>`,
    spineExtra,
    '</spine></project></event></library></fcpxml>',
  ].join('');
}

describe('shape export reporting', () => {
  it('skips every shape clip with its id and a one-line reason', () => {
    const { editor, shapeId } = editorWithVideoAndShape();
    expect(shapeId).not.toBe('');

    const report = exportFcpxmlWithReport(editor.getProject());

    expect(report.unsupported).toHaveLength(1);
    expect(report.unsupported[0]).toContain(shapeId);
    expect(report.unsupported[0]).toMatch(/shape/i);
    expect(report.unsupported[0]).toMatch(/no FCPXML form/);
    expect(report.unsupported[0].split('\n')).toHaveLength(1);
  });

  it('keeps the XML byte-identical to the string export and omits shapes', () => {
    const { editor } = editorWithVideoAndShape();
    const project = editor.getProject();
    const report = exportFcpxmlWithReport(project);

    expect(exportFcpxml(project)).toBe(report.xml);
    expect(report.xml.match(/<asset-clip/g)).toHaveLength(1);
    expect(report.xml).not.toContain('__shape__');
  });

  it('reports each shape clip and leaves video-only exports empty', () => {
    const editor = new EditorController();
    editor.addMedia({
      id: 'v',
      path: MEDIA_PATH,
      filename: 'clip.mp4',
      type: 'video',
      duration: 300,
      width: 1920,
      height: 1080,
      fileSize: 1,
      addedAt: '2026-08-26T00:00:00.000Z',
    });
    editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 30 });
    const first = editor.addShapeClip({ trackId: 'v1', shapeKind: 'rect', startFrame: 30, durationFrames: 30 });
    const second = editor.addShapeClip({ trackId: 'v1', shapeKind: 'arrow', startFrame: 60, durationFrames: 30 });

    const report = exportFcpxmlWithReport(editor.getProject());
    expect(report.unsupported).toHaveLength(2);
    expect(report.unsupported[0]).toContain(first);
    expect(report.unsupported[1]).toContain(second);

    const videoOnly = new EditorController();
    videoOnly.addMedia({
      id: 'v',
      path: MEDIA_PATH,
      filename: 'clip.mp4',
      type: 'video',
      duration: 300,
      width: 1920,
      height: 1080,
      fileSize: 1,
      addedAt: '2026-08-26T00:00:00.000Z',
    });
    videoOnly.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 30 });
    expect(exportFcpxmlWithReport(videoOnly.getProject()).unsupported).toEqual([]);
  });
});

describe('shape import reporting', () => {
  it('reports shape-ish constructs without dropping titles or static clips', () => {
    const plan = parseFcpxml(framesDoc('', '<generator name="Arrow" offset="2s" duration="1s"/>'));

    expect(plan.unsupported.some((note) => /generator/i.test(note))).toBe(true);
    expect(plan.unsupported.some((note) => /Spine element/i.test(note))).toBe(true);
    expect(plan.clips).toHaveLength(1);
    expect(plan.clips[0]?.kind).toBe('video');
  });

  it('reports shape/graphic children anywhere in the doc', () => {
    const plan = parseFcpxml(framesDoc('<shape name="Box"/><graphic name="Overlay"/>'));

    expect(plan.unsupported.some((note) => /shape/i.test(note))).toBe(true);
    expect(plan.unsupported.some((note) => /graphic/i.test(note))).toBe(true);
    const clip = plan.clips[0];
    if (clip?.kind !== 'video') throw new Error('expected video clip');
    expect(clip.label).toBe('Clip');
  });

  it('leaves previously-reported categories unaffected', () => {
    const plan = parseFcpxml(framesDoc(
      '<adjust-blend amount="0.4"><param name="amount" value="0.4"><keyframeAnimation>'
      + '<keyframe time="0s" curve="linear" value="0"/>'
      + '</keyframeAnimation></param></adjust-blend>'
      + '<adjust-volume amount="-6.0206dB"><param name="amount" value="-6.0206"><keyframeAnimation>'
      + '<keyframe time="0s" curve="linear" value="0"/>'
      + '</keyframeAnimation></param></adjust-volume>'
      + '<adjust-crop mode="trim"><trim-rect top="0" right="0" bottom="0" left="0"/>'
      + '<param name="left" value="0"><keyframeAnimation>'
      + '<keyframe time="0s" value="0"/>'
      + '</keyframeAnimation></param></adjust-crop>'
      + '<effect name="Vignette" uid="FFVignette"/>'
      + '<filter-video ref="r5" name="Color Correction"/>',
    ));

    expect(plan.unsupported.some((note) => /opacity/i.test(note))).toBe(true);
    expect(plan.unsupported.some((note) => /volume/i.test(note))).toBe(true);
    expect(plan.unsupported.some((note) => /crop/i.test(note))).toBe(true);
    expect(plan.unsupported.some((note) => /effect/i.test(note))).toBe(true);
    expect(plan.unsupported.some((note) => /filter-video/i.test(note))).toBe(true);
    const clip = plan.clips[0];
    if (clip?.kind !== 'video') throw new Error('expected video clip');
    expect(clip.opacity).toBe(0.4);
    expect(clip.volume).toBeCloseTo(0.5, 4);
  });

  it('keeps titles static and unreported when they carry no keyframes', () => {
    const doc = framesDoc('').replace(
      '<asset-clip name="Clip" offset="0s" duration="2s" start="0s" ref="2"></asset-clip>',
      '<title name="T" offset="0s" duration="2s" ref="ts1"><text><text-style ref="ts1">Hi</text-style></text></title>',
    );
    const plan = parseFcpxml(doc);
    const title = plan.clips.find((c) => c.kind === 'title');
    expect(title).toMatchObject({ kind: 'title', text: 'Hi' });
    expect(plan.unsupported.some((note) => /title/i.test(note))).toBe(false);
  });
});

describe('generated export reporting', () => {
  function generatedProject(): Project {
    const project = {
      version: 2,
      name: 'Generated',
      settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000, backgroundColor: '#000000' },
      media: [
        {
          id: 'a', path: 'X:/media/real.mp4', filename: 'real.mp4', type: 'video',
          duration: 60, width: 1920, height: 1080, fileSize: 1, addedAt: '2026-08-26T00:00:00.000Z',
        },
      ],
      timeline: {
        tracks: [
          { id: 'v1', name: 'Video 1', type: 'video', locked: false, visible: true, syncLocked: true, order: 0 },
        ],
        clips: [],
        playheadFrame: 0,
      },
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    } as unknown as Project;
    const base = {
      label: '', trackId: 'v1', startFrame: 0, durationFrames: 30, inPoint: 0, outPoint: 30,
      x: 0, y: 0, width: 1920, height: 1080, rotation: 0, scaleX: 1, scaleY: 1,
      opacity: 1, anchorX: 0, anchorY: 0, volume: 1, muted: false,
    };
    project.timeline.clips.push(
      { ...base, id: 'v-ok', assetId: 'a', type: 'video' },
      { ...base, id: 'g-missing', assetId: 'gone', type: 'generated', startFrame: 30 },
      { ...base, id: 'v-missing', assetId: 'gone-too', type: 'video', startFrame: 60 },
    );
    return project;
  }

  it('reports generated clips with missing media by id in the same list', () => {
    const report = exportFcpxmlWithReport(generatedProject());

    expect(report.unsupported).toHaveLength(2);
    expect(report.unsupported[0]).toContain('g-missing');
    expect(report.unsupported[0]).toMatch(/generated/i);
    expect(report.unsupported[0]).toMatch(/missing/);
    expect(report.unsupported[0].split('\n')).toHaveLength(1);
    expect(report.unsupported[1]).toContain('v-missing');
    expect(report.skippedClips).toBe(report.unsupported.length);
    expect(report.exportedClips).toBe(1);
    expect(report.xml.match(/<asset-clip/g)).toHaveLength(1);
    expect(exportFcpxml(generatedProject())).toBe(report.xml);
  });

  it('exports a generated clip with resolvable media and reports nothing', () => {
    const editor = new EditorController();
    editor.addMedia({
      id: 'v',
      path: MEDIA_PATH,
      filename: 'clip.mp4',
      type: 'video',
      duration: 300,
      width: 1920,
      height: 1080,
      fileSize: 1,
      addedAt: '2026-08-26T00:00:00.000Z',
    });
    const clipId = editor.addClip({ assetId: 'v', trackId: 'v1', startFrame: 0, durationFrames: 30 });
    editor.applyClipProperties([clipId], 'make generated', (draft) => {
      draft.type = 'generated';
      return true;
    });

    const report = exportFcpxmlWithReport(editor.getProject());
    expect(report.unsupported).toEqual([]);
    expect(report.exportedClips).toBe(1);
    expect(report.skippedClips).toBe(0);
    expect(report.xml.match(/<asset-clip/g)).toHaveLength(1);
  });
});

describe('shape round trip', () => {
  it('is stable across export -> import -> export apart from the report entries', () => {
    const { editor } = editorWithVideoAndShape();
    const first = exportFcpxmlWithReport(editor.getProject());
    expect(first.unsupported).toHaveLength(1);

    const plan = parseFcpxml(first.xml);
    expect(plan.unsupported).toEqual([]);
    expect(plan.clips.filter((c) => c.kind === 'video')).toHaveLength(1);

    const target = new EditorController();
    target.addMedia({
      id: 'imported',
      path: MEDIA_PATH,
      filename: 'clip.mp4',
      type: 'video',
      duration: 300,
      width: 1920,
      height: 1080,
      fileSize: 1,
      addedAt: '2026-08-26T00:00:00.000Z',
    });
    const result = applyFcpxmlPlan(
      target,
      plan,
      new Map([[MEDIA_PATH, 'imported']]),
      new Map([[MEDIA_PATH, { width: 1920, height: 1080 }]]),
    );
    expect(result.placedClips).toBe(1);
    expect(result.skippedOffline).toBe(0);

    const second = exportFcpxmlWithReport(target.getProject());
    // Lanes are track-layout dependent: apply synthesizes fresh tracks, so the
    // reimported video lands on a connected lane instead of the spine. The
    // interchange contract pins the transportable output, like the adjust and
    // keyframe round trips do, not the lane assignment. Shapes contribute
    // nothing to either document.
    const withoutLanes = (xml: string): string => xml.replace(/ lane="[^"]*"/g, '');
    expect(withoutLanes(second.xml)).toBe(withoutLanes(first.xml));
    expect(second.xml.match(/<asset-clip/g)).toHaveLength(1);
    expect(second.unsupported).toEqual([]);
  });
});
