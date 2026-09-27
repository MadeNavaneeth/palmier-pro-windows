/**
 * Apply-plan coverage: exporter → parser → applyFcpxmlPlan onto a real
 * controller, asserting track synthesis, frame mapping, title styling, and
 * the offline-skip counter.
 */
import { describe, it, expect } from 'vitest';
import { EditorController } from '../editor/controller';
import { resolveRenderTimeline } from '../editor/compound';
import type { Clip, Track } from '../types/project';
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

/**
 * Present only when a test needs the asset to read as picture-plus-sound, which
 * is what makes `addClip` create the linked audio twin and the compound
 * materializer rebuild one. Absent otherwise, so the existing tests keep
 * single-clip semantics.
 */
const EMBEDDED_AUDIO = { audioCodec: 'aac', channels: 2, sampleRate: 48000 } as const;

function addCompoundSourceMedia(
  editor: EditorController,
  id = 'compound-source',
  embeddedAudio = false,
): void {
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
    ...(embeddedAudio ? EMBEDDED_AUDIO : {}),
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

function importTarget(sourceId = 'imported-compound-source', embeddedAudio = false): EditorController {
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
    ...(embeddedAudio ? EMBEDDED_AUDIO : {}),
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

/**
 * A linked A/V group is two model clips over one media asset, and the exporter
 * writes both halves as separate elements (the visual one on a visual lane, the
 * audio one on a negative lane with `audioRole`). `kind` in the importer
 * describes the ASSET, not the lane, so the audio half of a video-bearing asset
 * arrives as `kind: 'video'` on a negative lane -- indistinguishable from a
 * second visual clip unless the lane is read. The flat path drops it and lets
 * the visual element rebuild the pair; the compound materializer must agree,
 * or every linked group imports twice.
 *
 * Clip ids are fresh on import by contract (an import is additive and never
 * reuses a resource id), so these tests compare the comparable shape -- clip
 * count, per-clip type, track type, source window, speed and link pairing --
 * rather than literal ids.
 */
function comparableClips(clips: readonly Clip[], tracks: readonly Track[]): unknown[] {
  // Link group ids are fresh on import, so compare the pairing as an ordinal:
  // two clips share one group iff they carry the same ordinal.
  const groupOrdinal = new Map<string, number>();
  for (const clip of clips) {
    if (clip.linkGroupId && !groupOrdinal.has(clip.linkGroupId)) {
      groupOrdinal.set(clip.linkGroupId, groupOrdinal.size);
    }
  }
  return clips.map((clip) => ({
    type: clip.type,
    track: tracks.find((track) => track.id === clip.trackId)?.type,
    startFrame: clip.startFrame,
    durationFrames: clip.durationFrames,
    inPoint: clip.inPoint,
    outPoint: clip.outPoint,
    speed: clip.speed,
    linkGroup: clip.linkGroupId === undefined ? undefined : groupOrdinal.get(clip.linkGroupId),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function linkedSourceNest(speed?: number): { source: EditorController; nestId: string } {
  const source = new EditorController();
  addCompoundSourceMedia(source, 'compound-source', true);
  const first = addCompoundSourceClip(source, { startFrame: 0, durationFrames: 30, inPoint: 15 });
  const second = addCompoundSourceClip(source, { startFrame: 60, durationFrames: 30, inPoint: 90 });
  if (speed !== undefined) {
    source.setClipSpeed(first, speed);
    source.setClipSpeed(second, speed);
  }
  source.nestClips([first, second], { name: 'Linked Nest' });
  const timelines = source.getProject().timelines ?? {};
  return { source, nestId: Object.keys(timelines)[0]! };
}

describe('linked A/V groups through a compound round trip', () => {
  it('imports a nest of linked pairs once, with the source clip count and windows', () => {
    const { source, nestId } = linkedSourceNest();
    const sourceNest = source.getProject().timelines![nestId]!;
    // Two placed video clips, each with the twin addClip created for it.
    expect(sourceNest.clips).toHaveLength(4);
    expect(sourceNest.tracks.map((track) => track.type).sort()).toEqual(['audio', 'video']);

    const plan = parseFcpxml(exportFcpxml(source.getProject()));
    // The exporter really does write both halves: two negative-lane elements.
    expect(plan.sequences?.[0]?.clips.map((clip) => clip.lane)).toEqual([-1, 1, -1, 1]);

    const target = importTarget('imported-compound-source', true);
    const result = applyFcpxmlPlan(target, plan, assetMap('imported-compound-source'), sourceDims());
    // One placed clip per visual element; the redundant audio elements place nothing.
    expect(result.placedClips).toBe(2);

    const carrier = target.getProject().timeline.clips.find((clip) => clip.type === 'compound')!;
    const imported = target.getProject().timelines![carrier.compoundTimelineId!]!;
    // Count preserved: the group is imported once, not once per written element.
    expect(imported.clips).toHaveLength(4);
    expect(imported.tracks.map((track) => track.type).sort()).toEqual(['audio', 'video']);
    expect(comparableClips(imported.clips, imported.tracks))
      .toEqual(comparableClips(sourceNest.clips, sourceNest.tracks));
  });

  it('gives the linked audio twin the sibling speed and the scaled outPoint', () => {
    const { source, nestId } = linkedSourceNest(2);
    const sourceNest = source.getProject().timelines![nestId]!;
    const sourceTwin = sourceNest.clips.find((clip) => clip.type === 'audio')!;
    // What setClipSpeed wrote on BOTH halves of the group.
    expect(sourceTwin).toMatchObject({ inPoint: 15, outPoint: 75, speed: 2, durationFrames: 30 });

    const plan = parseFcpxml(exportFcpxml(source.getProject()));
    const target = importTarget('imported-compound-source', true);
    applyFcpxmlPlan(target, plan, assetMap('imported-compound-source'), sourceDims());

    const carrier = target.getProject().timeline.clips.find((clip) => clip.type === 'compound')!;
    const imported = target.getProject().timelines![carrier.compoundTimelineId!]!;
    const video = imported.clips.find((clip) => clip.type === 'video')!;
    const twin = imported.clips.find((clip) => clip.type === 'audio')!;

    expect(imported.tracks.find((track) => track.id === twin.trackId)?.type).toBe('audio');
    expect(twin.linkGroupId).toBe(video.linkGroupId);
    // The speed lands on the twin, not just on the sibling it was written beside.
    expect(twin).toMatchObject({ speed: 2, inPoint: 15, outPoint: 75, durationFrames: 30 });
    expect(twin.outPoint).toBe(twin.inPoint + Math.round(twin.durationFrames * 2));
  });

  it('keeps an unspeeded import window unscaled', () => {
    const { source, nestId } = linkedSourceNest();
    const plan = parseFcpxml(exportFcpxml(source.getProject()));
    // A linear timeMap at exactly 1x is not emitted, so absent speed is the
    // only unspeeded form: no element may be rescaled on the way in.
    expect(plan.sequences?.[0]?.clips.every((clip) => clip.kind === 'video'
      && (clip as { speed?: number }).speed === undefined)).toBe(true);

    const target = importTarget('imported-compound-source', true);
    applyFcpxmlPlan(target, plan, assetMap('imported-compound-source'), sourceDims());

    const carrier = target.getProject().timeline.clips.find((clip) => clip.type === 'compound')!;
    const imported = target.getProject().timelines![carrier.compoundTimelineId!]!;
    for (const clip of imported.clips) {
      expect(clip.speed).toBeUndefined();
      expect(clip.inPoint).toBe(clip.startFrame === 0 ? 15 : 90);
      expect(clip.outPoint).toBe(clip.inPoint + clip.durationFrames);
      expect(clip.durationFrames).toBe(30);
    }
    expect(comparableClips(imported.clips, imported.tracks))
      .toEqual(comparableClips(
        source.getProject().timelines![nestId]!.clips,
        source.getProject().timelines![nestId]!.tracks,
      ));
  });

  it('imports a linked pair on the root of a compound document once', () => {
    const source = new EditorController();
    addCompoundSourceMedia(source, 'compound-source', true);
    const rootPair = addCompoundSourceClip(source, { startFrame: 0, durationFrames: 30, inPoint: 15 });
    source.setClipSpeed(rootPair, 2);
    const nested = addCompoundSourceClip(source, { startFrame: 200, durationFrames: 30, inPoint: 0 });
    source.nestClips([nested], { name: 'Root Nest' });
    const sourceRoot = source.getProject().timeline;
    // The pair plus the nest carrier.
    expect(sourceRoot.clips).toHaveLength(3);

    const plan = parseFcpxml(exportFcpxml(source.getProject()));
    const target = importTarget('imported-compound-source', true);
    const result = applyFcpxmlPlan(target, plan, assetMap('imported-compound-source'), sourceDims());
    // The pair's visual element plus the nest's own leaf; the carrier and the
    // redundant audio element place nothing.
    expect(result.placedClips).toBe(2);

    const importedRoot = target.getProject().timeline;
    expect(importedRoot.clips).toHaveLength(3);
    const video = importedRoot.clips.find((clip) => clip.type === 'video')!;
    const twin = importedRoot.clips.find((clip) => clip.type === 'audio')!;
    expect(target.getTracks().find((track) => track.id === twin.trackId)?.type).toBe('audio');
    expect(twin.linkGroupId).toBe(video.linkGroupId);
    expect(twin).toMatchObject({ speed: 2, inPoint: 15, outPoint: 75, durationFrames: 30 });
    // No second video clip for the audio element's lane: the group is placed once.
    expect(importedRoot.clips.filter((clip) => clip.type === 'video')).toHaveLength(1);
    expect(importedRoot.clips.filter((clip) => clip.type === 'audio')).toHaveLength(1);
  });
});

/**
 * The flat path is the one a plain project round trips through, and it drops the
 * exporter's redundant audio element and lets `addClip` re-derive the pair — so
 * it already preserves the clip count. What it lacked is the twin's half of the
 * speed: the same one window, on both halves, that `setClipSpeed` writes.
 */
function linkedSourceProject(speed?: number): EditorController {
  const source = new EditorController();
  addCompoundSourceMedia(source, 'compound-source', true);
  const clipId = addCompoundSourceClip(source, { startFrame: 0, durationFrames: 30, inPoint: 15 });
  if (speed !== undefined) source.setClipSpeed(clipId, speed);
  return source;
}

function importFlatProject(source: EditorController): {
  target: EditorController;
  placedClips: number;
  clips: Clip[];
  tracks: Track[];
} {
  const plan = parseFcpxml(exportFcpxml(source.getProject()));
  // No sequence resources, so this takes the legacy per-lane path.
  expect(plan.sequences ?? []).toEqual([]);
  const target = importTarget('imported-compound-source', true);
  const result = applyFcpxmlPlan(target, plan, assetMap('imported-compound-source'), sourceDims());
  const imported = target.getProject().timeline;
  return { target, placedClips: result.placedClips, clips: imported.clips, tracks: imported.tracks };
}

describe('flat linked A/V round trip', () => {
  it('gives the audio twin the sibling speed and the scaled outPoint', () => {
    const source = linkedSourceProject(2);
    const sourceTwin = source.getClips().find((clip) => clip.type === 'audio')!;
    // What setClipSpeed wrote on BOTH halves of the group.
    expect(sourceTwin).toMatchObject({ inPoint: 15, outPoint: 75, speed: 2, durationFrames: 30 });

    const { target, placedClips, clips, tracks } = importFlatProject(source);
    // Count behaviour is unchanged and already correct here.
    expect(placedClips).toBe(1);
    expect(clips).toHaveLength(2);

    const video = clips.find((clip) => clip.type === 'video')!;
    const twin = clips.find((clip) => clip.type === 'audio')!;
    expect(tracks.find((track) => track.id === twin.trackId)?.type).toBe('audio');
    expect(twin.linkGroupId).toBe(video.linkGroupId);
    // The twin no longer keeps the unscaled window its sibling was corrected from.
    expect(twin).toMatchObject({ speed: 2, inPoint: 15, outPoint: 75, durationFrames: 30 });
    expect(twin.outPoint).toBe(twin.inPoint + Math.round(twin.durationFrames * 2));
    // Speed only: the twin is an audio clip and inherits no visual adjustment.
    expect(twin.opacity).toBe(1);
    expect(twin.width).toBe(source.getProject().settings.width);

    // Both halves moved in the one adjustment batch, so undo arity is unchanged.
    expect(target.getLastCommandDescription()).toBe('setClipProperties');
    expect(target.undo()).toBe(true);
    // The state one undo back is the TRIM's own, and it changed with the span the
    // trim is handed. It used to read `out: 45` — the unscaled 15 + 30 — which was
    // a source out-point computed from a timeline length, and only self-consistent
    // because the clip's speed was still 1 at that moment. The trim now receives the
    // source window the plan actually names (15 + round(30 * 2) = 75), so the
    // intermediate satisfies the model's own invariant at 1x too:
    // `out - in === round(durationFrames * speed)` is 60 === 60.
    //
    // The FINAL state is untouched by this and is asserted above: in 15, out 75,
    // duration 30, speed 2, on both halves.
    const afterUndo = target.getClips();
    expect(afterUndo.map((clip) => ({ in: clip.inPoint, out: clip.outPoint, speed: clip.speed })))
      .toEqual([
        { in: 15, out: 75, speed: undefined },
        { in: 15, out: 75, speed: undefined },
      ]);
    // And the length the trim derived at 1x is the source span, which the batch
    // then converts back to the timeline length the plan placed.
    expect(afterUndo.map((clip) => clip.durationFrames)).toEqual([60, 60]);
  });

  it('keeps an unspeeded flat pair byte-identical to the pre-fix import', () => {
    const source = linkedSourceProject();
    const { target, placedClips, clips } = importFlatProject(source);

    // Measured before the twin speed patch existed, and unchanged by it: the
    // element carries no speed, so no twin entry joins the batch at all.
    expect(placedClips).toBe(1);
    expect(clips).toHaveLength(2);
    for (const clip of clips) {
      expect(clip).toMatchObject({ inPoint: 15, outPoint: 45, durationFrames: 30 });
      expect(clip.speed).toBeUndefined();
    }
    // Last command is the trim, so the unspeeded element still adds no
    // adjustment command and no undo entry.
    expect(target.getLastCommandDescription()).toBe('replaceClips');
  });

  it('matches the source project clip-for-clip after a flat round trip', () => {
    const source = linkedSourceProject(2);
    const { clips, tracks } = importFlatProject(source);
    const sourceProject = source.getProject();

    expect(comparableClips(clips, tracks))
      .toEqual(comparableClips(sourceProject.timeline.clips, sourceProject.timeline.tracks));
  });
});

/**
 * The twin's own LEVEL, which is the one thing a linked group does NOT share.
 *
 * Nothing in the editor propagates `volume`/`muted` across a link — only the
 * source window is shared, which is why `setClipSpeed` reaches every partner and
 * a level change does not. So a group whose twin's level differs from its visual
 * sibling's is an ordinary reachable state, and the exporter writes it as TWO
 * `adjust-volume` elements: the sibling's on the visual element and the twin's
 * on the negative-lane one that both materializers drop. The dropped element is
 * load-bearing (it is what stops a two-clip source nest importing as four), so
 * the level has to be read off it and discarded WITH it, never turned into a
 * clip — and never replaced by the sibling's, which would be no more correct.
 */
function twinOf(clips: readonly Clip[], video: Clip): Clip {
  return clips.find((clip) => clip.type === 'audio' && clip.linkGroupId === video.linkGroupId)!;
}

/**
 * One linked A/V pair at 2x whose TWIN owns `twin` (its level and/or its own
 * name) while its visual sibling stays at unity under the asset filename — the
 * state whose `adjust-volume` and `name` the dropped element owns. Both are
 * written to the twin alone because `applyClipProperties` writes exactly the ids
 * it is handed, which is the editor behaviour that makes the two halves
 * disagreeable in the first place.
 */
function linkedPairWithTwin(
  twin: { volume?: number; muted?: boolean; label?: string },
): { source: EditorController; videoId: string } {
  const source = new EditorController();
  addCompoundSourceMedia(source, 'compound-source', true);
  const videoId = addCompoundSourceClip(source, { startFrame: 0, durationFrames: 30, inPoint: 15 });
  source.setClipSpeed(videoId, 2);
  const clips = source.getClips();
  const audio = twinOf(clips, clips.find((clip) => clip.id === videoId)!);
  source.applyClipProperties([audio.id], 'Twin own fields', (draft) => {
    if (twin.volume !== undefined) draft.volume = twin.volume;
    if (twin.muted !== undefined) draft.muted = twin.muted;
    if (twin.label !== undefined) draft.label = twin.label;
    return true;
  });
  return { source, videoId };
}

/** Command descriptions of every undo step, innermost first. */
function undoArity(editor: EditorController): string[] {
  const descriptions: string[] = [];
  while (editor.canUndo()) {
    descriptions.push(editor.getLastCommandDescription() ?? '?');
    editor.undo();
  }
  return descriptions;
}

describe('a linked twin keeps its OWN level, not its visual sibling\'s', () => {
  it('reads the level off the dropped audio element and never materializes it (flat)', () => {
    const { source, videoId } = linkedPairWithTwin({ volume: 0.25 });
    const sourceClips = source.getClips();
    const sourceVideo = sourceClips.find((clip) => clip.id === videoId)!;
    const sourceTwin = twinOf(sourceClips, sourceVideo);
    expect(sourceVideo).toMatchObject({ volume: 1, muted: false });
    expect(sourceTwin).toMatchObject({ volume: 0.25, muted: false });

    const xml = exportFcpxml(source.getProject());
    // The premise, pinned: the group is written as two elements and only the
    // negative-lane one carries a level. Unity is elided, so there is exactly one.
    expect(xml.match(/<adjust-volume/g)).toHaveLength(1);
    const plan = parseFcpxml(xml);
    // The audio half carries `lane="-1"`; the visual one sits on the spine, whose
    // lane attribute the exporter elides, so it reads back as 0.
    const halves = plan.clips.map((clip) => clip.lane);
    expect(halves).toEqual([-1, 0]);
    const [half, visual] = plan.clips;
    expect(half).toMatchObject({ kind: 'video', lane: -1, volume: expect.closeTo(0.25, 4), muted: false });
    expect(visual).toMatchObject({ lane: 0, speed: 2 });
    // The visual element carries no level at all, so nothing could be inherited.
    expect(Object.keys(visual)).not.toContain('volume');
    // Why the OTHER fields the half is parsed with are not worth reading off it:
    // the exporter's audio branch writes ONLY `adjust-volume`, so a half our own
    // documents produce carries no picture field to lose. A `timeMap` is excluded
    // on purpose — the twin takes the group's speed from the visual element,
    // which is what `setClipSpeed` propagates.
    for (const key of ['speed', 'opacity', 'opacityTrack', 'cropTrim', 'transform', 'transformKeyframes']) {
      expect(Object.keys(half), key).not.toContain(key);
    }

    const { target, placedClips, clips } = importFlatProject(source);
    // The duplication fix: the dropped element still places nothing.
    expect(placedClips).toBe(1);
    expect(clips).toHaveLength(2);

    const video = clips.find((clip) => clip.type === 'video')!;
    const twin = twinOf(clips, video);
    // The twin's OWN level, and the sibling's unity untouched.
    expect(twin.volume).toBeCloseTo(0.25, 4);
    expect(twin.muted).toBe(false);
    expect(video.volume).toBe(1);
    expect(video.muted).toBe(false);
    // And it still shares the group's one window, as setClipSpeed writes it.
    expect(twin).toMatchObject({ speed: 2, inPoint: 15, outPoint: 75, durationFrames: 30 });
    expect(twin.linkGroupId).toBe(video.linkGroupId);

    // No second undo step: the level rode the batch the speed already needed.
    expect(undoArity(target)).toEqual([
      'setClipProperties', 'replaceClips', 'addMediaAndClips', 'addTrack',
    ]);
  });

  it('restores a differing twin level on the compound root and inside a nest', () => {
    const { source } = linkedPairWithTwin({ volume: 0.25 });
    // A second group in the SAME document, leveled differently, to be nested: one
    // spine, one nested sequence, and 0.5 is far enough from the root's 0.25 that
    // a crossed pairing could not pass.
    const nestedVideoId = addCompoundSourceClip(source, { startFrame: 200, durationFrames: 30, inPoint: 0 });
    source.setClipSpeed(nestedVideoId, 2);
    const clips = source.getClips();
    const nestedTwin = twinOf(clips, clips.find((clip) => clip.id === nestedVideoId)!);
    source.applyClipProperties([nestedTwin.id], 'Twin level', (draft) => {
      draft.volume = 0.5;
      return true;
    });
    source.nestClips([nestedVideoId], { name: 'Leveled Nest' });

    const plan = parseFcpxml(exportFcpxml(source.getProject()));
    const target = importTarget('imported-compound-source', true);
    const result = applyFcpxmlPlan(target, plan, assetMap('imported-compound-source'), sourceDims());

    // The duplication fix on BOTH compound sites: 2 visual elements, 2 pairs.
    // The root holds that pair plus the nest carrier, so 3 clips, and the dropped
    // audio elements place nothing — `placedClips: 2`, never 4.
    expect(result.placedClips).toBe(2);
    const imported = target.getProject();
    expect(imported.timeline.clips.filter((clip) => clip.type === 'video')).toHaveLength(1);
    expect(imported.timeline.clips.filter((clip) => clip.type === 'audio')).toHaveLength(1);
    const rootVideo = imported.timeline.clips.find((clip) => clip.type === 'video')!;
    const rootTwin = twinOf(imported.timeline.clips, rootVideo);
    expect(rootTwin.volume).toBeCloseTo(0.25, 4);
    expect(rootVideo.volume).toBe(1);
    expect(rootTwin).toMatchObject({ speed: 2, inPoint: 15, outPoint: 75 });

    const carrier = imported.timeline.clips.find((clip) => clip.type === 'compound')!;
    const nestedTimeline = imported.timelines![carrier.compoundTimelineId!]!;
    expect(nestedTimeline.clips).toHaveLength(2);
    const leafVideo = nestedTimeline.clips.find((clip) => clip.type === 'video')!;
    const leafTwin = twinOf(nestedTimeline.clips, leafVideo);
    expect(leafTwin.volume).toBeCloseTo(0.5, 4);
    expect(leafVideo.volume).toBe(1);
    expect(leafTwin).toMatchObject({ speed: 2, inPoint: 0, outPoint: 60 });
  });

  it('keeps a muted twin muted rather than unity', () => {
    const { source } = linkedPairWithTwin({ volume: 0, muted: true });
    const { clips } = importFlatProject(source);
    const video = clips.find((clip) => clip.type === 'video')!;
    const twin = twinOf(clips, video);
    expect(twin.muted).toBe(true);
    expect(twin.volume).toBe(0);
    // A muted twin is not a silent one: its sibling keeps playing.
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(1);
  });

  it('leaves an unleveled group byte-identical and costs a leveled one no extra step', () => {
    const leveled = importFlatProject(linkedPairWithTwin({ volume: 0.25 }).source);
    const unleveled = importFlatProject(linkedSourceProject(2));
    const unspeeded = importFlatProject(linkedSourceProject());
    for (const clip of unleveled.clips) {
      // A group whose twin never diverged: what the common case looks like, and
      // what the pre-fix import produced.
      expect(clip.volume).toBe(1);
      expect(clip.muted).toBe(false);
    }

    // The unleveled 2x pair is byte-identical: the level never reaches the twin,
    // so it joins no batch entry and the arity is exactly the speed fix's.
    // `undoArity` walks the history it reads, so each editor is drained once.
    const unleveledArity = undoArity(unleveled.target);
    expect(unleveledArity).toEqual([
      'setClipProperties', 'replaceClips', 'addMediaAndClips', 'addTrack',
    ]);
    // The leveled pair pushes the SAME arity: one batch, covering both halves, so
    // the agent's "Each placement is a separate undo step." receipt stays true.
    expect(undoArity(leveled.target)).toEqual(unleveledArity);
    // The common case — two elements, no level, no speed — adds no command at
    // all: the last command is still the trim's.
    for (const clip of unspeeded.clips) {
      expect(clip.volume).toBe(1);
      expect(clip.muted).toBe(false);
    }
    expect(unspeeded.target.getLastCommandDescription()).toBe('replaceClips');
  });
});

/**
 * The twin's own NAME, which is not a decision either: `label` is declared on
 * both plan types, the exporter writes each half's own `name` into its own
 * element, and the model holds two clips with two names. The twin therefore takes
 * the name from the element written for it, exactly as it now takes its own level.
 * Both halves normally carry the SAME name, which is the case that has to stay
 * inert.
 *
 * The two mechanisms differ and are both covered: the flat path, the compound
 * root and the agent PATCH a twin `addClip` created, while the nested
 * materializer BUILDS the twin and so has to be given the name as a literal.
 */
describe('a linked twin keeps its OWN name, not its visual sibling\'s', () => {
  it('takes the name off the dropped audio element (flat, the patched surface)', () => {
    const { source, videoId } = linkedPairWithTwin({ label: 'Dialogue' });
    const sourceClips = source.getClips();
    const sourceVideo = sourceClips.find((clip) => clip.id === videoId)!;
    expect(sourceVideo.label).toBe('compound-source.mp4');
    expect(twinOf(sourceClips, sourceVideo).label).toBe('Dialogue');

    const plan = parseFcpxml(exportFcpxml(source.getProject()));
    const [half, visual] = plan.clips;
    expect(half).toMatchObject({ kind: 'video', lane: -1, label: 'Dialogue' });
    expect(visual).toMatchObject({ lane: 0, label: 'compound-source.mp4' });

    const { target, placedClips, clips } = importFlatProject(source);
    // The duplication fix: the dropped element still places nothing.
    expect(placedClips).toBe(1);
    expect(clips).toHaveLength(2);

    const video = clips.find((clip) => clip.type === 'video')!;
    const twin = twinOf(clips, video);
    // The twin's own name, and the rename must not leak onto the visual half.
    expect(twin.label).toBe('Dialogue');
    expect(video.label).toBe('compound-source.mp4');
    // The level and window fixes are untouched by the rename.
    expect(twin).toMatchObject({ speed: 2, inPoint: 15, outPoint: 75, durationFrames: 30 });
    expect(twin.volume).toBe(1);
    // One command for the element, exactly as the unrenamed pair pushes.
    expect(undoArity(target)).toEqual([
      'setClipProperties', 'replaceClips', 'addMediaAndClips', 'addTrack',
    ]);
  });

  it('gives the twin its own name at the compound root AND inside a nest', () => {
    // The root group is renamed, the nested one is not: each half is renamed by
    // the mechanism its own surface uses, so a shared-code accident in one cannot
    // make this pass.
    const { source } = linkedPairWithTwin({ volume: 0.25, label: 'Root Dialogue' });
    const nestedVideoId = addCompoundSourceClip(source, { startFrame: 200, durationFrames: 30, inPoint: 0 });
    source.setClipSpeed(nestedVideoId, 2);
    const clips = source.getClips();
    const nestedTwin = twinOf(clips, clips.find((clip) => clip.id === nestedVideoId)!);
    source.applyClipProperties([nestedTwin.id], 'Nested twin own fields', (draft) => {
      draft.volume = 0.5;
      draft.label = 'Nested Dialogue';
      return true;
    });
    source.nestClips([nestedVideoId], { name: 'Renamed Nest' });

    const plan = parseFcpxml(exportFcpxml(source.getProject()));
    const target = importTarget('imported-compound-source', true);
    const result = applyFcpxmlPlan(target, plan, assetMap('imported-compound-source'), sourceDims());

    // The duplication fix on BOTH compound sites: 2 visual elements, 2 pairs, so
    // `placedClips: 2` and never 4 — the dropped elements place nothing.
    expect(result.placedClips).toBe(2);
    const imported = target.getProject();
    expect(imported.timeline.clips.filter((clip) => clip.type === 'video')).toHaveLength(1);
    expect(imported.timeline.clips.filter((clip) => clip.type === 'audio')).toHaveLength(1);

    // Compound ROOT, patched through addLinkedTwinPatch.
    const rootVideo = imported.timeline.clips.find((clip) => clip.type === 'video')!;
    const rootTwin = twinOf(imported.timeline.clips, rootVideo);
    expect(rootTwin.label).toBe('Root Dialogue');
    expect(rootVideo.label).toBe('compound-source.mp4');
    // The level fix and the twin speed/outPoint fix still hold beside the rename.
    expect(rootTwin.volume).toBeCloseTo(0.25, 4);
    expect(rootVideo.volume).toBe(1);
    expect(rootTwin).toMatchObject({ speed: 2, inPoint: 15, outPoint: 75 });

    // NESTED sequence, built by the materializer rather than patched.
    const carrier = imported.timeline.clips.find((clip) => clip.type === 'compound')!;
    const nestedTimeline = imported.timelines![carrier.compoundTimelineId!]!;
    expect(nestedTimeline.clips).toHaveLength(2);
    const leafVideo = nestedTimeline.clips.find((clip) => clip.type === 'video')!;
    const leafTwin = twinOf(nestedTimeline.clips, leafVideo);
    expect(leafTwin.label).toBe('Nested Dialogue');
    expect(leafVideo.label).toBe('compound-source.mp4');
    expect(leafTwin.volume).toBeCloseTo(0.5, 4);
    expect(leafTwin).toMatchObject({ speed: 2, inPoint: 0, outPoint: 60 });
  });

  it('leaves a group whose halves share a name byte-identical, with no extra step', () => {
    // Nothing diverged: both halves are named after the asset, which is the case
    // that must not turn into a new command on every import.
    const matching = importFlatProject(linkedSourceProject(2));
    const renamed = importFlatProject(linkedPairWithTwin({ label: 'Dialogue' }).source);
    const unspeeded = importFlatProject(linkedSourceProject());

    for (const clip of matching.clips) {
      expect(clip.label).toBe('compound-source.mp4');
    }
    // The literal command list: the name contributes nothing, so the arity is
    // exactly what the speed fix left behind. `undoArity` drains the history it
    // reads, so each editor is walked once.
    const matchingArity = undoArity(matching.target);
    expect(matchingArity).toEqual([
      'setClipProperties', 'replaceClips', 'addMediaAndClips', 'addTrack',
    ]);
    expect(undoArity(renamed.target)).toEqual(matchingArity);
    // The purest common case — no speed, no level, no rename — still ends on the
    // trim's, so the twin registers no entry and no history at all.
    for (const clip of unspeeded.clips) {
      expect(clip.label).toBe('compound-source.mp4');
    }
    expect(unspeeded.target.getLastCommandDescription()).toBe('replaceClips');
  });
});

/**
 * Both halves renamed to the SAME custom name — the sub-case that used to read as
 * "the halves agree" and so was mistaken for "the twin is already right".
 *
 * Those are different questions, and the old rule answered the second by asking
 * the first. It worked by accident: `addClip` names a placed clip after its asset
 * (EditorController.createPlacedClip), so an untouched group's audio half already
 * carries the asset filename the twin was given. It failed the moment the user
 * renamed BOTH halves, because then the halves agree AND the twin is still on the
 * asset filename. The rule now states the name and leaves the decision to the
 * caller, which compares against what the twin actually holds.
 *
 * All three of this module's twin sites are covered, each by the mechanism it
 * really uses — two PATCH an `addClip` twin, one BUILDS it — so a regression in
 * one cannot be covered for by the other two.
 */
describe('both halves renamed to the same custom name', () => {
  /** One 2x pair whose VISUAL half and TWIN both carry `name`. */
  function sameNamePair(name: string, startFrame: number, inPoint: number): EditorController {
    const source = new EditorController();
    addCompoundSourceMedia(source, 'compound-source', true);
    const videoId = addCompoundSourceClip(source, { startFrame, durationFrames: 30, inPoint });
    source.setClipSpeed(videoId, 2);
    const clips = source.getClips();
    const twin = twinOf(clips, clips.find((clip) => clip.id === videoId)!);
    for (const id of [videoId, twin.id]) {
      source.applyClipProperties([id], 'Rename both halves', (draft) => {
        draft.label = name;
        return true;
      });
    }
    return source;
  }

  it('gives the twin that name on the flat path, the compound root and inside a nest', () => {
    const NAME = 'Take 2';

    // (1) FLAT — the patched surface through `applyImportedAdjustments`.
    const flat = sameNamePair(NAME, 0, 15);
    const flatPair = twinOf(flat.getClips(), flat.getClips().find((c) => c.type === 'video')!);
    expect(flatPair.label).toBe(NAME);
    // Both elements really do carry the same name in the file, which is the
    // premise the old gate got wrong.
    const flatPlan = parseFcpxml(exportFcpxml(flat.getProject()));
    expect(flatPlan.clips.map((clip) => (clip.kind === 'title' ? '' : clip.label)))
      .toEqual([NAME, NAME]);

    const flatTarget = importTarget('imported-compound-source', true);
    const flatResult = applyFcpxmlPlan(
      flatTarget, flatPlan, assetMap('imported-compound-source'), sourceDims(),
    );
    expect(flatResult.placedClips).toBe(1);
    const flatClips = flatTarget.getClips();
    expect(flatClips).toHaveLength(2);
    const flatVideo = flatClips.find((clip) => clip.type === 'video')!;
    expect(twinOf(flatClips, flatVideo).label).toBe(NAME);
    // The visual half still comes back under `addClip`'s asset filename, as it
    // does for every other document; the name is the twin's own, not inherited.
    expect(flatVideo.label).toBe('compound-source.mp4');
    // The level and window fixes are untouched by the rename.
    expect(twinOf(flatClips, flatVideo)).toMatchObject({
      speed: 2, inPoint: 15, outPoint: 75, volume: 1,
    });

    // (2) COMPOUND ROOT and (3) NESTED — a root pair and a nested pair, each
    // renamed on BOTH halves, in one document. The root half is patched through
    // `addLinkedTwinPatch`; the nested half is BUILT by the materializer, so the
    // two really are different mechanisms.
    const nest = sameNamePair(NAME, 0, 15);
    const nestedVideoId = addCompoundSourceClip(nest, { startFrame: 200, durationFrames: 30, inPoint: 0 });
    nest.setClipSpeed(nestedVideoId, 2);
    const nestedClips = nest.getClips();
    const nestedTwin = twinOf(nestedClips, nestedClips.find((clip) => clip.id === nestedVideoId)!);
    for (const id of [nestedVideoId, nestedTwin.id]) {
      nest.applyClipProperties([id], 'Rename both halves', (draft) => {
        draft.label = 'Take 3';
        return true;
      });
    }
    nest.nestClips([nestedVideoId], { name: 'Same Name Nest' });

    const nestPlan = parseFcpxml(exportFcpxml(nest.getProject()));
    const nestTarget = importTarget('imported-compound-source', true);
    const nestResult = applyFcpxmlPlan(
      nestTarget, nestPlan, assetMap('imported-compound-source'), sourceDims(),
    );
    // The duplication fix on both compound sites: 2 visual elements, 2 pairs.
    expect(nestResult.placedClips).toBe(2);
    const imported = nestTarget.getProject();
    expect(imported.timeline.clips.filter((clip) => clip.type === 'video')).toHaveLength(1);
    expect(imported.timeline.clips.filter((clip) => clip.type === 'audio')).toHaveLength(1);

    const rootVideo = imported.timeline.clips.find((clip) => clip.type === 'video')!;
    const rootTwin = twinOf(imported.timeline.clips, rootVideo);
    expect(rootTwin.label).toBe(NAME);
    expect(rootVideo.label).toBe('compound-source.mp4');
    expect(rootTwin).toMatchObject({ speed: 2, inPoint: 15, outPoint: 75 });

    const carrier = imported.timeline.clips.find((clip) => clip.type === 'compound')!;
    const nestedTimeline = imported.timelines![carrier.compoundTimelineId!]!;
    expect(nestedTimeline.clips).toHaveLength(2);
    const leafVideo = nestedTimeline.clips.find((clip) => clip.type === 'video')!;
    const leafTwin = twinOf(nestedTimeline.clips, leafVideo);
    expect(leafTwin.label).toBe('Take 3');
    // The nested surface BUILDS both halves, so the visual one carries the
    // document's own name for it too — which is why this site was already right
    // and the two patched ones were not.
    expect(leafVideo.label).toBe('Take 3');
    expect(leafTwin).toMatchObject({ speed: 2, inPoint: 0, outPoint: 60 });
  });

  it('costs the same-name pair no undo step beyond the differently-renamed one', () => {
    // The inertness decision moved from "the halves agree" to "the twin already
    // holds this name", so the arity is what has to prove it is still inert: an
    // unrenamed group must keep pushing nothing at all.
    const sameName = importFlatProject(sameNamePair('Take 2', 0, 15));
    const renamed = importFlatProject(linkedPairWithTwin({ label: 'Dialogue' }).source);
    const matching = importFlatProject(linkedSourceProject(2));
    const unspeeded = importFlatProject(linkedSourceProject());

    const renamedArity = undoArity(renamed.target);
    expect(renamedArity).toEqual([
      'setClipProperties', 'replaceClips', 'addMediaAndClips', 'addTrack',
    ]);
    expect(undoArity(sameName.target)).toEqual(renamedArity);
    expect(undoArity(matching.target)).toEqual(renamedArity);
    // No speed, no level, no rename at all: the last command is still the trim's,
    // so an ordinary import adds no adjustment command and no history.
    expect(unspeeded.target.getLastCommandDescription()).toBe('replaceClips');
  });
});
