/**
 * Cross-frame-rate FCPXML import: the rescale, and the degenerate-rate refusal.
 *
 * A document's `<format frameDuration>` recovers one rate, and a plan may arrive
 * from a project at a different one, so every plan frame is rescaled by
 * `projectFps / sourceFps` on the way in. These tests pin that rescale at
 * matched and mismatched rates -- including the rates palmier's own exporter
 * cannot write exactly, where its 6-decimal `frameDuration` recovers slightly
 * off -- and pin the floor below which the rescale carries no information and
 * the import must be refused instead of placing invented positions.
 */
import { describe, expect, it } from 'vitest';
import { EditorController } from '../editor/controller';
import { exportFcpxml } from './exporter';
import { parseFcpxml, type ParsedFcpxml } from './importer';
import { applyFcpxmlPlan } from './apply';

const PATH = 'X:/media/fps.mp4';
const DIMS = new Map([[PATH, { width: 1920, height: 1080 }]]);

/** A 30 fps project with one clip whose frame numbers are easy to assert. */
function sourceAt(fps: number, withAudio = false): EditorController {
  const editor = new EditorController();
  editor.applyProjectSettings({ fps });
  editor.addMedia({
    id: 'source',
    path: PATH,
    filename: 'fps.mp4',
    type: 'video',
    duration: fps * 30,
    width: 1920,
    height: 1080,
    fileSize: 1,
    addedAt: '2026-08-26T00:00:00.000Z',
    ...(withAudio ? { audioCodec: 'aac', channels: 2, sampleRate: 48000 } : {}),
  } as never);
  const clipId = editor.addClip({
    assetId: 'source',
    trackId: 'v1',
    startFrame: 20,
    durationFrames: 48,
  });
  editor.trimClip(clipId, 30, 78);
  editor.setClipSpeed(clipId, 2);
  return editor;
}

function targetAt(fps: number, withAudio = false): EditorController {
  const editor = new EditorController();
  editor.applyProjectSettings({ fps });
  editor.addMedia({
    id: 'imported',
    path: PATH,
    filename: 'fps.mp4',
    type: 'video',
    duration: fps * 30,
    width: 1920,
    height: 1080,
    fileSize: 1,
    addedAt: '2026-08-26T00:00:00.000Z',
    ...(withAudio ? { audioCodec: 'aac', channels: 2, sampleRate: 48000 } : {}),
  } as never);
  return editor;
}

/** Every frame value on every clip, root and nested. */
function allFrames(editor: EditorController): number[] {
  const project = editor.getProject();
  return [
    ...project.timeline.clips,
    ...Object.values(project.timelines ?? {}).flatMap((timeline) => timeline.clips),
  ].flatMap((clip) => [clip.startFrame, clip.durationFrames, clip.inPoint, clip.outPoint]);
}

function video(editor: EditorController): Record<string, unknown> {
  return editor.getClips().find((clip) => clip.type === 'video') as never;
}

/** Swap only the document's declared rate, leaving every other byte alone. */
function withFrameDuration(xml: string, frameDuration: string): string {
  return xml.replace(/frameDuration="[^"]*"/, `frameDuration="${frameDuration}"`);
}

describe('cross-rate FCPXML import rescale', () => {
  it('leaves a matched rate byte-identical and reports nothing', () => {
    const plan = parseFcpxml(exportFcpxml(sourceAt(30).getProject()));
    const target = targetAt(30);

    expect(plan.fps).toBe(30);
    const result = applyFcpxmlPlan(target, plan, new Map([[PATH, 'imported']]), DIMS);

    expect(result).toEqual({ placedClips: 1, titles: 0, tracksCreated: 1, skippedOffline: 0 });
    expect(plan.unsupported).toEqual([]);
    expect(video(target)).toMatchObject({
      startFrame: 20, durationFrames: 48, inPoint: 30, outPoint: 126, speed: 2,
    });
  });

  it('rescales a slower document up, keeping wall clock and source fraction', () => {
    // 24 -> 30: every rate, 1.25x. 48 frames becomes 60 exactly; the 30-frame
    // in-point lands on 37.5 and rounds to 38, half a 30 fps frame.
    const plan = parseFcpxml(exportFcpxml(sourceAt(24).getProject()));
    const target = targetAt(30);

    expect(plan.fps).toBe(24);
    applyFcpxmlPlan(target, plan, new Map([[PATH, 'imported']]), DIMS);

    expect(plan.unsupported).toEqual([]);
    const clip = video(target);
    expect(clip).toMatchObject({
      startFrame: 25, durationFrames: 60, inPoint: 38, outPoint: 158, speed: 2,
    });
    // Same wall clock, and the consumed source is still exactly speed x length.
    expect((clip.startFrame as number) / 30).toBeCloseTo(20 / 24, 6);
    expect((clip.durationFrames as number) / 30).toBeCloseTo(48 / 24, 6);
    expect((clip.outPoint as number) - (clip.inPoint as number))
      .toBe(Math.round((clip.durationFrames as number) * 2));
  });

  it('rescales a faster document down', () => {
    // 30 -> 24: 48 frames becomes 38.4 and rounds to 38.
    const plan = parseFcpxml(exportFcpxml(sourceAt(30).getProject()));
    const target = targetAt(24);

    applyFcpxmlPlan(target, plan, new Map([[PATH, 'imported']]), DIMS);

    expect(plan.unsupported).toEqual([]);
    expect(video(target)).toMatchObject({
      startFrame: 16, durationFrames: 38, inPoint: 24, outPoint: 100, speed: 2,
    });
    expect((video(target).outPoint as number) - (video(target).inPoint as number))
      .toBe(Math.round((video(target).durationFrames as number) * 2));
  });

  it('rescales exactly when the ratio is a whole number', () => {
    // 24 -> 60: ratio 2.5, so no rounding at all.
    const plan = parseFcpxml(exportFcpxml(sourceAt(24).getProject()));
    const target = targetAt(60);

    applyFcpxmlPlan(target, plan, new Map([[PATH, 'imported']]), DIMS);

    expect(plan.unsupported).toEqual([]);
    expect(video(target)).toMatchObject({
      startFrame: 50, durationFrames: 120, inPoint: 75, outPoint: 315, speed: 2,
    });
    for (const [frames, fps] of [[50, 60], [120, 60], [75, 60], [315, 60]] as const) {
      expect(frames / fps).toBeCloseTo(
        ({ 50: 20 / 24, 120: 48 / 24, 75: 30 / 24, 315: 126 / 24 } as Record<number, number>)[frames],
        9,
      );
    }
  });

  it('keeps the linked audio twin on the same window as its visual sibling', () => {
    const plan = parseFcpxml(exportFcpxml(sourceAt(24, true).getProject()));
    const target = targetAt(30, true);

    applyFcpxmlPlan(target, plan, new Map([[PATH, 'imported']]), DIMS);

    const [v, a] = target.getClips();
    expect(v).toMatchObject({ startFrame: 25, durationFrames: 60, inPoint: 38, outPoint: 158, speed: 2 });
    expect(a).toMatchObject({ startFrame: 25, durationFrames: 60, inPoint: 38, outPoint: 158, speed: 2 });
  });

  it('round-trips the exporter\'s own inexact high-rate recovery unchanged', () => {
    // At 240 fps the 6-decimal frameDuration recovers as 239.981, so this is a
    // palmier-authored document whose rescale is not the identity. It still
    // lands exactly on the source frames, and the rate clears the floor.
    const xml = exportFcpxml(sourceAt(240).getProject());
    const plan = parseFcpxml(xml);
    const target = targetAt(240);

    expect(xml).toContain('frameDuration="0.004167s"');
    expect(plan.fps).toBe(239.981);
    applyFcpxmlPlan(target, plan, new Map([[PATH, 'imported']]), DIMS);

    expect(plan.unsupported).toEqual([]);
    expect(video(target)).toMatchObject({
      startFrame: 20, durationFrames: 48, inPoint: 30, outPoint: 126, speed: 2,
    });
  });

  it('accepts an absurdly fast document without refusing it', () => {
    // The floor is one-sided: a 10,000,000 fps document rescales to the right
    // frames, so the guard must not reject large rates.
    const plan = parseFcpxml(withFrameDuration(exportFcpxml(sourceAt(30).getProject()), '0.0000001s'));
    const target = targetAt(30);

    expect(plan.fps).toBe(10000000);
    const result = applyFcpxmlPlan(target, plan, new Map([[PATH, 'imported']]), DIMS);

    expect(plan.unsupported).toEqual([]);
    expect(result.placedClips).toBe(1);
    expect(video(target)).toMatchObject({
      startFrame: 20, durationFrames: 48, inPoint: 30, outPoint: 126, speed: 2,
    });
  });
});

/**
 * The other end of the range. There is no upper bound, and that is measured
 * rather than assumed: the importer rounds each offset to `round(seconds *
 * rate)` document frames and the applier multiplies back by `projectFps /
 * rate`, so the two cancel and the rescale is scale-invariant. These tests are
 * the pin that keeps a future reader from adding a ceiling — one mirroring
 * `MAX_PROJECT_FPS` would refuse documents that import exactly right today.
 */
describe('large document rate is not degenerate', () => {
  /** A document declaring `frameDuration`, clip at 0.5 s / 2 s / source-in 0.5 s. */
  function rateDoc(frameDuration: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE fcpxml>',
      '<fcpxml version="1.11"><resources>',
      `<format id="r1" frameDuration="${frameDuration}" width="1920" height="1080"/>`,
      `<asset id="r2" name="fps.mp4" src="file:///X:/media/${PATH.split('/').pop()}" start="0s" duration="600s" hasVideo="1" hasAudio="1"/>`,
      '</resources><library><event name="E"><project name="E"><spine>',
      '<asset-clip name="A" offset="0.5s" duration="2s" start="0.5s" ref="r2"/>',
      '</spine></project></event></library></fcpxml>',
    ].join('');
  }

  const place = (frameDuration: string): { plan: ReturnType<typeof parseFcpxml>; clip: Record<string, unknown> | undefined } => {
    const plan = parseFcpxml(rateDoc(frameDuration));
    const target = targetAt(30);
    applyFcpxmlPlan(target, plan, new Map([[PATH, 'imported']]), DIMS);
    return { plan, clip: video(target) as never };
  };

  // 0.5 s and 2 s in a 30 fps project are 15, 60 and 15 frames whatever the
  // document rate, because the rescale cancels. The rational forms are what
  // upstream actually writes (FCPXMLExporter.swift:863-870 at b4b1333); the
  // decimal ones are this repo's own exporter, and the two tiny ones past 151
  // fps are that writer's quantization showing up.
  it.each([
    ['1/24s', 24],
    ['1/30s', 30],
    ['1/60s', 60],
    ['1/240s', 240],
    ['1001/24000s', 23.976],
    ['1001/30000s', 29.97],
    ['1001/60000s', 59.94],
    ['0.004167s', 239.981],
    ['0.004166s', 240.038],
    ['0.004149s', 241.022],
    ['0.003333s', 300.03],
    ['0.000001s', 1000000],
  ])('places a %s document (recovers %s fps) exactly', (frameDuration, expectedFps) => {
    const { plan, clip } = place(frameDuration as string);

    expect(plan.fps).toBeCloseTo(expectedFps as number, 6);
    expect(plan.unsupported).toEqual([]);
    expect(clip).toMatchObject({ startFrame: 15, durationFrames: 60, inPoint: 15, outPoint: 75 });
  });

  it.each([
    ['0.000000000000000000000000000001s', 1e29],
    ['0.0000000000000000000001s', 1e22],
  ])('places a %s document (recovers ~%s fps) exactly, refusing nothing', (frameDuration, magnitude) => {
    // A 1e-33 s frameDuration is the very document an earlier note here claimed
    // collapsed every clip to frame 0. It does not: the small fpsScale is what
    // makes the two roundings cancel.
    const { plan, clip } = place(frameDuration as string);

    expect(plan.fps).toBeGreaterThanOrEqual(magnitude as number);
    expect(plan.unsupported).toEqual([]);
    expect(clip).toMatchObject({ startFrame: 15, durationFrames: 60, inPoint: 15, outPoint: 75 });
  });

  it('refuses only a non-finite rate, which is the one large value that fails', () => {
    // 1e-320 s is denormal enough that 1/frameDuration is Infinity. That is the
    // only measured large-rate failure, and the finiteness clause catches it.
    const plan = parseFcpxml(rateDoc(`0.${'0'.repeat(319)}1s`));
    expect(plan.fps).toBe(Infinity);

    const target = targetAt(30);
    const result = applyFcpxmlPlan(target, plan, new Map([[PATH, 'imported']]), DIMS);

    expect(result).toEqual({ placedClips: 0, titles: 0, tracksCreated: 0, skippedOffline: 0 });
    expect(target.getClips()).toEqual([]);
    expect(plan.unsupported.some((note) => /unusable frame rate/.test(note))).toBe(true);
  });
});

describe('degenerate document rate refusal', () => {
  // Below one frame per second the importer has already rounded every offset
  // and duration to whole multi-second units, so the plan cannot be rescaled
  // back into anything the document said. Both materializers refuse it whole.
  // At 0.01 fps the nested <media> resource's own duration also rounds to zero,
  // so the importer drops the sequence and the document arrives flat; the
  // compound materializer is exercised by the 0.5 fps case below, which stays
  // compound.
  const cases = [
    { frameDuration: '2s', fps: 0.5 },
    { frameDuration: '100s', fps: 0.01 },
  ] as const;

  for (const { frameDuration, fps } of cases) {
    it(`refuses a ${frameDuration} document (${fps} fps) instead of misplacing it`, () => {
      const plan = parseFcpxml(withFrameDuration(exportFcpxml(sourceAt(30).getProject()), frameDuration));
      const target = targetAt(30);

      expect(plan.fps).toBe(fps);
      // The plan does carry clips, so the applier is the thing that must stop.
      expect(plan.clips.length).toBeGreaterThan(0);

      const result = applyFcpxmlPlan(target, plan, new Map([[PATH, 'imported']]), DIMS);

      expect(result).toEqual({ placedClips: 0, titles: 0, tracksCreated: 0, skippedOffline: 0 });
      expect(target.getClips()).toEqual([]);
      expect(plan.unsupported.some((note) => /frameDuration/.test(note) && /nothing is imported/.test(note)))
        .toBe(true);
    });
  }

  it('refuses a 2s document on the compound path too', () => {
    // 0.5 fps is degenerate AND still leaves a resolvable nested sequence, so
    // this really does enter the compound materializer.
    const source = sourceAt(30);
    const leaf = source.addClip({ assetId: 'source', trackId: 'v1', startFrame: 0, durationFrames: 48 });
    source.trimClip(leaf, 30, 78);
    source.setClipSpeed(leaf, 2);
    source.nestClips([leaf], { name: 'Inner' });
    const plan = parseFcpxml(withFrameDuration(exportFcpxml(source.getProject()), '2s'));
    const target = targetAt(30, true);

    expect(plan.fps).toBe(0.5);
    expect(plan.sequences?.length).toBeGreaterThan(0);

    const result = applyFcpxmlPlan(target, plan, new Map([[PATH, 'imported']]), DIMS);

    expect(result).toEqual({ placedClips: 0, titles: 0, tracksCreated: 0, skippedOffline: 0 });
    expect(allFrames(target)).toEqual([]);
    expect(target.getProject().timelines).toBeUndefined();
    expect(plan.unsupported.some((note) => /nothing is imported/.test(note))).toBe(true);
  });

  it('refuses a zero rate without letting Infinity or NaN reach a clip', () => {
    // A 1000s frameDuration recovers as 0, and `0 ?? projectFps` is 0, not the
    // project rate: the unguarded flat rescale divided by it. parseFcpxml drops
    // the spine here, so the applier is exercised through a hand-built plan,
    // which is the IPC-crossing shape its own contract allows.
    const plan = parseFcpxml(withFrameDuration(exportFcpxml(sourceAt(30).getProject()), '1000s'));
    expect(plan.fps).toBe(0);

    const handBuilt: ParsedFcpxml = {
      ...plan,
      fps: 0,
      clips: [{
        kind: 'video', lane: 0, startFrame: 10, durationFrames: 60, sourceInFrame: 15,
        assetPath: PATH, label: 'Clip', speed: 2,
      }],
    };
    const target = targetAt(30);

    const result = applyFcpxmlPlan(target, handBuilt, new Map([[PATH, 'imported']]), DIMS);

    expect(result).toEqual({ placedClips: 0, titles: 0, tracksCreated: 0, skippedOffline: 0 });
    expect(allFrames(target).every(Number.isFinite)).toBe(true);
    expect(allFrames(target)).toEqual([]);
    expect(handBuilt.unsupported.some((note) => /declares 0 fps/.test(note))).toBe(true);
  });

  it('refuses a non-finite or negative rate carried across IPC', () => {
    for (const fps of [Number.NaN, Number.POSITIVE_INFINITY, -30]) {
      const base = parseFcpxml(exportFcpxml(sourceAt(30).getProject()));
      const plan: ParsedFcpxml = {
        ...base,
        fps,
        clips: [{
          kind: 'video', lane: 0, startFrame: 10, durationFrames: 60, sourceInFrame: 15,
          assetPath: PATH, label: 'Clip',
        }],
      };
      const target = targetAt(30);

      const result = applyFcpxmlPlan(target, plan, new Map([[PATH, 'imported']]), DIMS);

      expect(result.placedClips, `fps=${fps}`).toBe(0);
      expect(allFrames(target).every(Number.isFinite), `fps=${fps}`).toBe(true);
      expect(plan.unsupported.some((note) => /nothing is imported/.test(note)), `fps=${fps}`).toBe(true);
    }
  });

  it('keeps the absent-rate document on the identity rescale it already had', () => {
    // plan.fps === null means "use the project rate", which is the identity and
    // is not a degenerate rate: nothing changes, and the importer's own note is
    // the only one.
    const plan = parseFcpxml(withFrameDuration(exportFcpxml(sourceAt(30).getProject()), 'nonsense'));
    const target = targetAt(30);

    expect(plan.fps).toBeNull();
    expect(plan.clips).toEqual([]);

    const result = applyFcpxmlPlan(target, plan, new Map([[PATH, 'imported']]), DIMS);

    expect(result.placedClips).toBe(0);
    expect(plan.unsupported).toEqual([
      'No usable <format frameDuration>; spine timing cannot be mapped to frames, so no clip is imported.',
    ]);
  });
});
