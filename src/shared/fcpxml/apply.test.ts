/**
 * Apply-plan coverage: exporter → parser → applyFcpxmlPlan onto a real
 * controller, asserting track synthesis, frame mapping, title styling, and
 * the offline-skip counter.
 */
import { describe, it, expect } from 'vitest';
import { EditorController } from '../editor/controller';
import { resolveRenderTimeline } from '../editor/compound';
import { exportFcpxml } from './exporter';
import { parseFcpxml } from './importer';
import { applyFcpxmlPlan } from './apply';

function sourceProject(): EditorController {
  const editor = new EditorController();
  editor.addMedia({
    id: 'm',
    path: 'X:/media/music.wav',
    filename: 'music.wav',
    type: 'audio',
    duration: 90,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  const id = editor.addClip({ assetId: 'm', trackId: 'a1', startFrame: 30, durationFrames: 30 });
  editor.trimClip(id, 0, 30);
  return editor;
}

describe('applyFcpxmlPlan (#154 wiring core)', () => {
  it('synthesizes lanes and places clips with mapped frames', () => {
    const source = sourceProject();
    const plan = parseFcpxml(exportFcpxml(source.getProject()));

    // The importer needs a media asset to exist for the path; simulate the
    // caller having added it by handing over the same id the source used.
    const target = new EditorController();
    target.addMedia({
      id: 'imported-music',
      path: 'X:/media/music.wav',
      filename: 'music.wav',
      type: 'audio',
      duration: 90,
      fileSize: 1,
      addedAt: new Date().toISOString(),
    });

    const result = applyFcpxmlPlan(target, plan, new Map([
      ['X:/media/music.wav', 'imported-music'],
    ]));

    expect(result.tracksCreated).toBeGreaterThanOrEqual(2); // spine video + audio lane
    expect(result.placedClips).toBe(1);

    // Imported clip lives on a synthesized audio track at the exported spot.
    const synthAudio = target.getTracks().filter((t) => t.type === 'audio').slice(-1)[0]!;
    const clip = target.getClips().find((c) => c.trackId === synthAudio.id)!;
    expect(clip.startFrame).toBe(30);
    expect(clip.inPoint).toBe(0);
  });

  it('counts skips when an asset is offline', () => {
    const source = sourceProject();
    let xml = exportFcpxml(source.getProject()).replace(
      /src="file:\/\/\/[^"]*"/,
      'src="file:///Z:/gone.wav"',
    );
    const plan = parseFcpxml(xml);

    const target = new EditorController();
    const result = applyFcpxmlPlan(target, plan, new Map()); // nothing added

    expect(result.placedClips).toBe(0);
    expect(result.skippedOffline).toBe(1);
    expect(target.getTracks().some((t) => t.type === 'audio')).toBe(true); // lanes still synthesized
  });

  it('restores title styling through the shared pass', () => {
    const source = new EditorController();
    source.addTitleClip({
      trackId: 'v1', text: 'Styled', startFrame: 0, durationFrames: 45,
    });
    source.applyClipProperties([source.getClips()[0].id], 'Style', (draft) => {
      draft.titleColor = '#ffcc00';
      draft.titleSizeRatio = 0.08;
      draft.titleFontFamily = 'Georgia';
      draft.titleAlign = 'left';
      return true;
    });

    const plan = parseFcpxml(exportFcpxml(source.getProject()));
    const target = new EditorController();
    const result = applyFcpxmlPlan(target, plan, new Map());

    expect(result.titles).toBe(1);
    const imported = target.getClips()[0];
    expect(imported.text).toBe('Styled');
    expect(imported.titleColor).toBe('#FFCC00');
    // FCPXML fontSize is integer-px, so ratio↔px is ±1px lossy by design.
    expect(imported.titleSizeRatio).toBeCloseTo(0.08, 2);
    expect(imported.titleFontFamily).toBe('Georgia');
    expect(imported.titleAlign).toBe('left');
  });
});

const COMPOUND_MEDIA_PATH = 'X:/media/compound-source.mp4';

function addCompoundSourceMedia(editor: EditorController, id = 'compound-source'): void {
  editor.addMedia({
    id,
    path: COMPOUND_MEDIA_PATH,
    filename: 'compound-source.mp4',
    type: 'video',
    duration: 300,
    width: 1920,
    height: 1080,
    fileSize: 1,
    addedAt: '2026-08-26T00:00:00.000Z',
  });
}

function addCompoundSourceClip(
  editor: EditorController,
  options: {
    startFrame?: number;
    durationFrames?: number;
    inPoint?: number;
  } = {},
): string {
  const startFrame = options.startFrame ?? 15;
  const durationFrames = options.durationFrames ?? 90;
  const inPoint = options.inPoint ?? 12;
  const id = editor.addClip({
    assetId: 'compound-source',
    trackId: 'v1',
    startFrame,
    durationFrames,
  });
  editor.trimClip(id, inPoint, inPoint + durationFrames);
  return id;
}

function importTarget(sourceId = 'imported-compound-source'): EditorController {
  const target = new EditorController();
  target.addMedia({
    id: sourceId,
    path: COMPOUND_MEDIA_PATH,
    filename: 'compound-source.mp4',
    type: 'video',
    duration: 300,
    width: 1920,
    height: 1080,
    fileSize: 1,
    addedAt: new Date().toISOString(),
  });
  return target;
}

function assetMap(sourceId = 'imported-compound-source'): Map<string, string> {
  return new Map([[COMPOUND_MEDIA_PATH, sourceId]]);
}

function sourceDims(): Map<string, { width: number; height: number }> {
  return new Map([[COMPOUND_MEDIA_PATH, { width: 1920, height: 1080 }]]);
}

describe('compound FCPXML import/apply round trip', () => {
  it('reconstructs more than one nesting level with the same clips and timing', () => {
    const source = new EditorController();
    addCompoundSourceMedia(source);
    const leafId = addCompoundSourceClip(source);
    const inner = source.nestClips([leafId], { name: 'Inner Sequence' });
    const outer = source.nestClips([inner.compoundClipId], { name: 'Outer Sequence' });

    const plan = parseFcpxml(exportFcpxml(source.getProject()));
    expect(plan.sequences?.map((sequence) => sequence.ref)).toEqual(['nest1', 'nest2']);
    expect(plan.clips).toHaveLength(1);
    expect(plan.sequences?.[0]?.clips[0]).toMatchObject({
      kind: 'video',
      startFrame: 0,
      durationFrames: 90,
      sourceInFrame: 0,
      compoundSequenceRef: 'nest2',
    });
    expect(plan.sequences?.[1]?.clips[0]).toMatchObject({
      kind: 'video',
      startFrame: 0,
      durationFrames: 90,
      sourceInFrame: 12,
    });

    const target = importTarget();
    const result = applyFcpxmlPlan(target, plan, assetMap(), sourceDims());
    const imported = target.getProject();
    const importedCarrier = imported.timeline.clips[0]!;
    const outerId = importedCarrier.compoundTimelineId!;
    const outerTimeline = imported.timelines?.[outerId]!;
    const innerCarrier = outerTimeline.clips[0]!;
    const innerId = innerCarrier.compoundTimelineId!;
    const leaf = imported.timelines?.[innerId]?.clips[0]!;

    expect(result.placedClips).toBe(1);
    expect(importedCarrier).toMatchObject({
      type: 'compound',
      startFrame: 15,
      durationFrames: 90,
      inPoint: 0,
      outPoint: 90,
    });
    expect(innerCarrier).toMatchObject({
      type: 'compound',
      startFrame: 0,
      durationFrames: 90,
      inPoint: 0,
      outPoint: 90,
    });
    expect(leaf).toMatchObject({
      type: 'video',
      startFrame: 0,
      durationFrames: 90,
      inPoint: 12,
      outPoint: 102,
      label: 'compound-source.mp4',
    });
    expect(outer.compoundClipId).not.toBe('');
    expect(resolveRenderTimeline(imported).clips[0]).toMatchObject({
      startFrame: 15,
      durationFrames: 90,
      inPoint: 12,
    });
  });

  it('preserves nested opacity, transform keyframes, crop, volume, and speed', () => {
    const source = new EditorController();
    addCompoundSourceMedia(source);
    const leafId = addCompoundSourceClip(source, { startFrame: 10, durationFrames: 60, inPoint: 15 });
    source.applyClipProperties([leafId], 'Nested adjustments', (draft) => {
      draft.opacity = 0.4;
      draft.opacityTrack = [
        { frame: 10, value: 0.2 },
        { frame: 40, value: 0.8 },
      ];
      draft.motionX = [
        { frame: 10, value: 100 },
        { frame: 40, value: 220 },
      ];
      draft.crop = { left: 0.1, right: 0, top: 0.05, bottom: 0 };
      draft.volume = 0.25;
      draft.speed = 1.5;
      draft.outPoint = draft.inPoint + Math.round(draft.durationFrames * 1.5);
      return true;
    });
    source.nestClips([leafId], { name: 'Adjusted Nest' });

    const plan = parseFcpxml(exportFcpxml(source.getProject()));
    const parsedLeaf = plan.sequences?.[0]?.clips[0];
    expect(parsedLeaf).toMatchObject({
      opacity: 0.4,
      cropTrim: expect.objectContaining({ left: expect.any(Number), top: expect.any(Number) }),
      speed: 1.5,
    });
    expect(parsedLeaf?.kind).toBe('video');
    if (parsedLeaf?.kind === 'video') expect(parsedLeaf.volume).toBeCloseTo(0.25, 4);

    const target = importTarget();
    applyFcpxmlPlan(target, plan, assetMap(), sourceDims());
    const carrier = target.getClips().find((clip) => clip.type === 'compound')!;
    const nested = target.getProject().timelines?.[carrier.compoundTimelineId!]!.clips[0]!;

    expect(nested.opacity).toBeCloseTo(0.4, 4);
    expect(nested.opacityTrack?.map((point) => point.value)).toEqual([0.2, 0.8]);
    expect(nested.motionX).toHaveLength(2);
    expect(nested.crop).toMatchObject({ left: expect.any(Number), top: expect.any(Number) });
    expect(nested.volume).toBeCloseTo(0.25, 4);
    expect(nested.speed).toBe(1.5);
    expect(nested.outPoint).toBe(nested.inPoint + Math.round(nested.durationFrames * 1.5));
  });

  it('allocates collision-free ids and leaves existing project content untouched', () => {
    const source = new EditorController();
    addCompoundSourceMedia(source);
    const leafId = addCompoundSourceClip(source, { durationFrames: 60, inPoint: 0 });
    source.nestClips([leafId], { name: 'Imported Nest' });
    const plan = parseFcpxml(exportFcpxml(source.getProject()));

    const base = importTarget();
    const target = new EditorController({
      ...base.getProject(),
      timelines: {
        'fcpxml-nested-1': {
          tracks: [],
          clips: [],
          playheadFrame: 0,
          name: 'Existing Nest',
        },
      },
    });
    target.addTitleClip({ trackId: 'v1', text: 'Existing', startFrame: 0, durationFrames: 30 });
    const existingTimeline = target.getProject().timelines?.['fcpxml-nested-1'];
    const existingRootClip = target.getClips()[0];

    applyFcpxmlPlan(target, plan, assetMap(), sourceDims());
    const imported = target.getProject();

    expect(Object.keys(imported.timelines ?? {})).toEqual([
      'fcpxml-nested-1',
      'fcpxml-nested-2',
    ]);
    expect(imported.timelines?.['fcpxml-nested-1']).toBe(existingTimeline);
    expect(imported.timeline.clips).toContain(existingRootClip);
    expect(imported.timeline.clips.some((clip) => clip.type === 'compound')).toBe(true);
  });

  it('does not materialize a ref-clip whose resource is not a sequence', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      '<format id="r1" frameDuration="1/30s" width="1920" height="1080"/>',
      '</resources><library><event name="Bad"><project name="Bad"><spine>',
      '<ref-clip ref="missing" name="Carrier" lane="1" offset="0s" start="0s" duration="1s"/>',
      '</spine></project></event></library></fcpxml>',
    ].join('');
    const plan = parseFcpxml(xml);
    const target = new EditorController();

    applyFcpxmlPlan(target, plan, new Map());

    expect(plan.unsupported.some((note) => /unknown sequence resource "missing"/.test(note))).toBe(true);
    expect(target.getClips()).toEqual([]);
    expect(target.getProject().timelines).toBeUndefined();
  });

  it('commits a compound import as exactly one undo step', () => {
    const source = new EditorController();
    addCompoundSourceMedia(source);
    const leafId = addCompoundSourceClip(source, { durationFrames: 60, inPoint: 0 });
    source.nestClips([leafId], { name: 'Undo Nest' });
    const plan = parseFcpxml(exportFcpxml(source.getProject()));
    const target = importTarget();
    const before = target.getProject();

    expect(target.canUndo()).toBe(false);
    applyFcpxmlPlan(target, plan, assetMap(), sourceDims());
    expect(target.canUndo()).toBe(true);
    const afterImport = target.getProject();

    expect(target.undo()).toBe(true);
    expect(target.canUndo()).toBe(false);
    const afterUndo = target.getProject();
    expect(afterUndo.timelines).toBeUndefined();
    expect(afterUndo.timeline.clips).toEqual(before.timeline.clips);
    expect(afterUndo.timeline.tracks).toEqual(before.timeline.tracks);

    // One redo replays the whole compound import as the same single step.
    expect(target.redo()).toBe(true);
    expect(target.getProject().timelines).toEqual(afterImport.timelines);
    expect(target.getProject().timeline.clips).toEqual(afterImport.timeline.clips);
  });
});
