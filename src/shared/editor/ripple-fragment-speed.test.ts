/**
 * Speed-aware source mapping for clips rebuilt from timeline frames.
 *
 * `rippleDeleteRanges` splits a clip into fragments and rebuilds each
 * fragment's trim from timeline frames. That rebuild used to drop the `speed`
 * term, so a fragment of a sped-up clip claimed a fraction of the source it
 * actually plays and mis-trims on preview and export -- while `setClipSpeed`,
 * which had written `speed` onto the same clip, scaled that window correctly.
 * The path and the mapping that produced the ranges (both directions of
 * `media/source-time`) must agree on where a timeline frame lands in the
 * source, and the sibling rebuilds -- overwrite/insert, split, compact take --
 * must not disagree either.
 *
 * Rounding contract under test: the start boundary rounds once and the span
 * rounds once, `outPoint = inPoint + round(durationFrames * speed)`. So
 * `outPoint - inPoint === round(durationFrames * speed)` holds exactly, and two
 * halves that meet at one cut boundary land on the same source frame.
 */

import { describe, it, expect } from 'vitest';
import { EditorController } from './controller';
import { createEmptyProject, type Clip, type Project } from '../types/project';
import { asValidFrame } from '../utils/safe-number';
import { mergeRippleRanges, type RippleRange } from './ripple';
import {
  secondsToProjectFrames,
  sourceSecondsForTimelineFrame,
  timelineFrameForSourceSeconds,
} from '../media/source-time';

const TRACK = 'v1';

interface ClipSpec {
  id?: string;
  startFrame?: number;
  durationFrames?: number;
  inPoint?: number;
  /** Omitted means "unspeeded", i.e. no `speed` key at all. */
  speed?: number;
  trackId?: string;
  type?: Clip['type'];
  linkGroupId?: string;
}

/**
 * A media clip whose window is the one `setClipSpeed` writes: the consumed
 * source span scales with speed, so a fixture built here is self-consistent
 * with what the speed command would have produced.
 */
function mediaClip(spec: ClipSpec): Clip {
  const durationFrames = spec.durationFrames ?? 300;
  const inPoint = spec.inPoint ?? 0;
  const speed = spec.speed ?? 1;
  return {
    id: spec.id ?? 'lead',
    assetId: 'asset',
    type: spec.type ?? 'video',
    trackId: spec.trackId ?? TRACK,
    ...(spec.linkGroupId === undefined ? {} : { linkGroupId: spec.linkGroupId }),
    startFrame: spec.startFrame ?? 0,
    durationFrames,
    inPoint,
    outPoint: inPoint + Math.round(durationFrames * speed),
    ...(spec.speed === undefined ? {} : { speed: spec.speed }),
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    anchorX: 960,
    anchorY: 540,
    fadeInFrames: 5,
    fadeOutFrames: 7,
    volume: 1,
    muted: false,
  };
}

function projectWith(clips: Clip[], fps = 30): Project {
  const value = createEmptyProject('Fragment speed');
  return {
    ...value,
    settings: { ...value.settings, fps },
    timeline: { ...value.timeline, clips },
  };
}

function onTrack(controller: EditorController, trackId = TRACK): Clip[] {
  return controller.getClips()
    .filter((clip) => clip.trackId === trackId)
    .sort((left, right) => left.startFrame - right.startFrame);
}

function windows(clips: Clip[]): [number, number][] {
  return clips.map((clip) => [clip.inPoint, clip.outPoint]);
}

function spans(clips: Clip[]): [number, number][] {
  return clips.map((clip) => [clip.startFrame, clip.startFrame + clip.durationFrames]);
}

/**
 * The pre-fix fragment rebuild, kept verbatim as the speed-1 oracle. The trim
 * is rebuilt from timeline frames with no `speed` term, which IS the whole
 * defect: at speed 1 the fixed path must agree with it frame for frame,
 * including which fragments survive.
 */
function legacySurvivors(clips: Clip[], ranges: RippleRange[]): Clip[] {
  const merged = mergeRippleRanges(ranges.flatMap((range) => {
    const start = asValidFrame(range.start);
    const end = asValidFrame(range.end);
    return start !== null && end !== null && end > start ? [{ start, end }] : [];
  }));

  return clips.flatMap((clip) => {
    if (clip.trackId !== TRACK) return [clip];
    const clipStart = clip.startFrame;
    const clipEnd = clip.startFrame + clip.durationFrames;
    const intersections = merged
      .map((range) => ({
        start: Math.max(clipStart, range.start),
        end: Math.min(clipEnd, range.end),
      }))
      .filter((range) => range.end > range.start);

    if (intersections.length === 0) {
      const shift = merged
        .filter((range) => range.end <= clip.startFrame)
        .reduce((total, range) => total + range.end - range.start, 0);
      return [{ ...clip, startFrame: clip.startFrame - shift }];
    }

    const kept: RippleRange[] = [];
    let cursor = clipStart;
    for (const intersection of intersections) {
      if (intersection.start > cursor) kept.push({ start: cursor, end: intersection.start });
      cursor = Math.max(cursor, intersection.end);
    }
    if (cursor < clipEnd) kept.push({ start: cursor, end: clipEnd });

    return kept.map((segment) => {
      const shift = merged
        .filter((range) => range.end <= segment.start)
        .reduce((total, range) => total + range.end - range.start, 0);
      return {
        ...clip,
        startFrame: segment.start - shift,
        durationFrames: segment.end - segment.start,
        inPoint: clip.inPoint + segment.start - clipStart,
        outPoint: clip.inPoint + segment.end - clipStart,
      };
    });
  });
}

/** What the two paths are compared on: geometry and trim, not generated ids. */
function shape(clips: Clip[]) {
  return clips.map((clip) => ({
    startFrame: clip.startFrame,
    durationFrames: clip.durationFrames,
    inPoint: clip.inPoint,
    outPoint: clip.outPoint,
  }));
}

describe('rippleDeleteRanges — a fragment claims the source it plays', () => {
  it('claims 584 source frames for a 292-frame fragment of a 2x clip', () => {
    const source = mediaClip({ startFrame: 0, durationFrames: 300, inPoint: 0, speed: 2 });
    expect(source.outPoint).toBe(600);
    const controller = new EditorController(projectWith([source]));

    // Cut the head off, so exactly one fragment of 292 timeline frames lives.
    const report = controller.rippleDeleteRanges(TRACK, [{ start: 0, end: 8 }]);
    const kept = onTrack(controller);

    expect(report?.removedFrames).toBe(8);
    expect(kept).toHaveLength(1);
    expect(kept[0].durationFrames).toBe(292);
    // 292 timeline frames at 2x consume 584 source frames, and the fragment
    // resumes 8 timeline frames in, i.e. 16 source frames in.
    expect(windows(kept)).toEqual([[16, 600]]);
    expect(kept[0].outPoint - kept[0].inPoint).toBe(584);

    // The pre-fix arithmetic handed the same fragment a 292-frame window: half
    // the source, so preview and export trimmed the wrong half of the take.
    const legacy = legacySurvivors([source], [{ start: 0, end: 8 }]);
    expect(legacy[0].outPoint - legacy[0].inPoint).toBe(292);
  });

  it('cuts a 2x clip at the silence and gives the tail the rest of the source', () => {
    // The reported symptom: removeSilence maps detected source seconds through
    // the shared model (timeline 30..38 at 2x), and the fragment it leaves has
    // to agree with the mapping that chose the range.
    const controller = new EditorController();
    controller.addMedia({
      id: 'av', path: '/av.mp4', filename: 'av.mp4', type: 'video',
      audioCodec: 'aac', duration: 1800, fileSize: 1, addedAt: new Date().toISOString(),
    });
    const videoId = controller.addClip({
      assetId: 'av', trackId: TRACK, startFrame: 0, durationFrames: 300,
    });
    expect(controller.setClipSpeed(videoId, 2)).toBe(true);

    expect(controller.removeSilence(videoId, [{ startSec: 2, endSec: 2.5 }])).toBe(1);

    const video = onTrack(controller);
    // Head keeps source [0,60); the tail resumes at source 76 -- 38 timeline
    // frames in at 2x -- and runs to the end of the original window.
    expect(spans(video)).toEqual([[0, 30], [30, 292]]);
    expect(windows(video)).toEqual([[0, 60], [76, 600]]);
    expect(windows(onTrack(controller, 'a1'))).toEqual(windows(video));
  });

  it('tiles the original source window with the fragments and the cut-outs', () => {
    const source = mediaClip({ startFrame: 10, durationFrames: 300, inPoint: 40, speed: 2 });
    expect(source.outPoint).toBe(640);
    const controller = new EditorController(projectWith([source]));

    controller.rippleDeleteRanges(TRACK, [
      { start: 30, end: 38 },
      { start: 100, end: 145 },
      { start: 290, end: 305 },
    ]);

    const kept = onTrack(controller);
    expect(spans(kept)).toEqual([[10, 30], [30, 92], [92, 237], [237, 242]]);
    expect(windows(kept)).toEqual([
      [40, 80],    // [10,30)   -- 20 timeline frames
      [96, 220],   // [38,100)  -- 62
      [310, 600],  // [145,290) -- 145
      [630, 640],  // [305,310) -- 5
    ]);

    // Consecutive boundaries run 40 -> 640 with no repeat and no reversal, and
    // the gaps between them are the cut-outs: 8, 45 and 15 timeline frames at
    // 2x, i.e. 16, 90 and 30 source frames. Surviving + removed = the window
    // the clip started with.
    const boundaries = kept.flatMap((clip) => [clip.inPoint, clip.outPoint]);
    expect(boundaries).toEqual([40, 80, 96, 220, 310, 600, 630, 640]);
    for (let index = 1; index < boundaries.length; index += 1) {
      expect(boundaries[index]).toBeGreaterThan(boundaries[index - 1]);
    }
    expect(boundaries[2] - boundaries[1]).toBe(16);
    expect(boundaries[4] - boundaries[3]).toBe(90);
    expect(boundaries[6] - boundaries[5]).toBe(30);
  });
});

describe('rippleDeleteRanges — speed 1 is frame-for-frame unchanged', () => {
  const clipCases: Clip[] = [
    mediaClip({ startFrame: 0, durationFrames: 300, inPoint: 0 }),
    mediaClip({ startFrame: 0, durationFrames: 300, inPoint: 0, speed: 1 }),
    mediaClip({ startFrame: 137, durationFrames: 300, inPoint: 151 }),
    mediaClip({ startFrame: 0, durationFrames: 300, inPoint: 900, speed: 1 }),
    mediaClip({ startFrame: 60, durationFrames: 250, inPoint: 30 }),
    mediaClip({ startFrame: 0, durationFrames: 600, inPoint: 0 }),
  ];

  const rangeCases: RippleRange[][] = [
    [{ start: 0, end: 8 }],                                       // head
    [{ start: 30, end: 38 }],                                     // middle
    [{ start: 290, end: 300 }],                                   // tail
    [{ start: 30, end: 38 }, { start: 100, end: 145 }],           // two middles
    [{ start: 30, end: 40 }, { start: 35, end: 45 }],             // overlapping
    [{ start: 7, end: 8 }],                                       // single frame
    [{ start: 0, end: 300 }],                                     // the whole clip
    [{ start: -5, end: 20 }],                                     // invalid start
    [{ start: 280, end: 400 }],                                   // overhangs the end
    [{ start: 50, end: 50 }],                                     // empty, dropped
    [{ start: 20, end: 30 }, { start: 30, end: 40 }],             // touching
  ];

  it('produces the legacy survivors and trims across clips, ranges and rates', () => {
    for (const clip of clipCases) {
      for (const fps of [24, 30, 60]) {
        for (const ranges of rangeCases) {
          const controller = new EditorController(projectWith([clip], fps));
          const report = controller.rippleDeleteRanges(
            TRACK,
            ranges.map((range) => ({ ...range })),
          );
          const expected = legacySurvivors([clip], ranges);

          // The whole survivor set, not just the first fragment, so "which
          // fragments survive" is covered as well as their trims.
          expect(shape(onTrack(controller))).toEqual(shape(expected));
          expect(report?.fragmentClipIds.length ?? 0)
            .toBe(Math.max(0, expected.length - 1));
        }
      }
    }
  });

  it('leaves the window of a clip the cut only shifts alone', () => {
    const after = mediaClip({ id: 'tail', startFrame: 300, durationFrames: 100, inPoint: 500 });
    const controller = new EditorController(projectWith([after]));

    controller.rippleDeleteRanges(TRACK, [{ start: 40, end: 50 }]);

    expect(shape(onTrack(controller))).toEqual([{
      startFrame: 290,
      durationFrames: 100,
      inPoint: 500,
      outPoint: 600,
    }]);
  });
});

describe('rippleDeleteRanges — fractional speeds', () => {
  it('keeps outPoint - inPoint equal to the rounded duration times speed', () => {
    for (const speed of [0.5, 1.25, 1.5, 3]) {
      const source = mediaClip({ startFrame: 0, durationFrames: 300, inPoint: 0, speed });
      const controller = new EditorController(projectWith([source]));

      controller.rippleDeleteRanges(TRACK, [{ start: 31, end: 37 }, { start: 200, end: 233 }]);

      const kept = onTrack(controller);
      expect(kept.length).toBeGreaterThan(1);
      for (const fragment of kept) {
        expect(fragment.speed).toBe(speed);
        expect(fragment.outPoint - fragment.inPoint)
          .toBe(Math.round(fragment.durationFrames * speed));
      }
    }
  });

  it('rounds the 1.5x boundary the model rounds, then derives the span', () => {
    // 31 timeline frames into a 1.5x clip is 46.5 source frames and 37 is
    // 55.5; both round up, exactly as the inverse mapping rounds the boundary
    // that produced the range.
    const source = mediaClip({ startFrame: 0, durationFrames: 300, inPoint: 0, speed: 1.5 });
    const controller = new EditorController(projectWith([source]));

    controller.rippleDeleteRanges(TRACK, [{ start: 31, end: 37 }]);

    const kept = onTrack(controller);
    expect(spans(kept)).toEqual([[0, 31], [31, 294]]);
    // The tail lands on 451, one frame past the clip's own 450: its start
    // boundary is 55.5 and its span is 394.5, and 56 + 395 is the pair of
    // integers that describes the 263 frames it plays. The alternative --
    // pinning the end to 450 -- describes 394 source frames for a 263-frame
    // fragment, and reads back through the model's inverse as timeline frame
    // 293 instead of 294.
    expect(windows(kept)).toEqual([
      [0, 47],    // 31 frames  -> round(46.5)
      [56, 451],  // resumes at round(55.5); 263 frames -> round(394.5)
    ]);
    // One rounding per end, so the span is what the duration says instead of a
    // difference between two independently rounded ends (450 - 56 = 394).
    expect(kept[0].outPoint - kept[0].inPoint).toBe(Math.round(31 * 1.5));
    expect(kept[1].outPoint - kept[1].inPoint).toBe(Math.round(263 * 1.5));
  });

  it('narrows the source window of a 0.5x clip instead of widening it', () => {
    // 300 timeline frames at 0.5x consume 150 source frames: the source window
    // is NARROWER than the timeline span, so a formula that only ever scales up
    // -- or that ignores speed -- would point past the end of the take.
    const source = mediaClip({ startFrame: 0, durationFrames: 300, inPoint: 0, speed: 0.5 });
    expect(source.outPoint).toBe(150);
    const controller = new EditorController(projectWith([source]));

    controller.rippleDeleteRanges(TRACK, [{ start: 100, end: 120 }]);

    const kept = onTrack(controller);
    expect(spans(kept)).toEqual([[0, 100], [100, 280]]);
    expect(windows(kept)).toEqual([
      [0, 50],    // 100 frames -> 50 source frames
      [60, 150],  // resumes at 120 -> 60, and still ends on the original window
    ]);
    expect(kept[1].outPoint).toBe(source.outPoint);
    // The pre-fix arithmetic pointed the tail at source 120..300, i.e. twice
    // past the end of the source this clip owns.
    expect(legacySurvivors([source], [{ start: 100, end: 120 }])[1].outPoint).toBe(300);
  });
});

describe('rippleDeleteRanges — no gap and no overlap between fragments', () => {
  for (const speed of [1, 2]) {
    it(`tiles the source exactly at ${speed}x, whatever the cut shape`, () => {
      const cases: { cut: RippleRange; expected: [number, number][] }[] = [
        { cut: { start: 0, end: 1 }, expected: [[1 * speed, 300 * speed]] },
        { cut: { start: 7, end: 8 }, expected: [[0, 7 * speed], [8 * speed, 300 * speed]] },
        { cut: { start: 30, end: 38 }, expected: [[0, 30 * speed], [38 * speed, 300 * speed]] },
        { cut: { start: 1, end: 299 }, expected: [[0, 1 * speed], [299 * speed, 300 * speed]] },
        { cut: { start: 0, end: 300 }, expected: [] },
      ];

      for (const { cut, expected } of cases) {
        const source = mediaClip({ startFrame: 0, durationFrames: 300, inPoint: 0, speed });
        const controller = new EditorController(projectWith([source]));

        controller.rippleDeleteRanges(TRACK, [cut]);
        const kept = onTrack(controller);

        expect(windows(kept)).toEqual(expected);
        if (kept.length === 0) continue;

        // Read off the result, not the table: no fragment window may start
        // where an earlier one ended, and the surviving windows plus the spans
        // between them must account for the whole original window -- the
        // surviving material and the cut-out material, nothing else.
        const boundaries = kept.flatMap((clip) => [clip.inPoint, clip.outPoint]);
        for (let index = 1; index < boundaries.length; index += 1) {
          expect(boundaries[index]).toBeGreaterThan(boundaries[index - 1]);
        }
        const accounted = kept.reduce(
          (total, clip) => total + clip.outPoint - clip.inPoint,
          0,
        )
          + kept[0].inPoint - source.inPoint
          + source.outPoint - kept[kept.length - 1].outPoint
          + kept.slice(1).reduce(
            (total, clip, index) => total + clip.inPoint - kept[index].outPoint,
            0,
          );
        expect(accounted).toBe(source.outPoint - source.inPoint);
      }
    });
  }

  it('keeps fragments ordered when the cut boundary lands mid-frame at 1.25x', () => {
    // Every boundary lands on a quarter source frame, so each cut ends on a
    // half-frame: fragments must still be ordered in the source, the cut-out
    // span within one source frame of the exact one, and each fragment's own
    // window exactly its rounded duration.
    const speed = 1.25;
    const source = mediaClip({ startFrame: 0, durationFrames: 300, inPoint: 0, speed });
    const controller = new EditorController(projectWith([source]));

    controller.rippleDeleteRanges(TRACK, [{ start: 1, end: 9 }, { start: 33, end: 47 }]);

    const kept = onTrack(controller);
    expect(spans(kept)).toEqual([[0, 1], [1, 25], [25, 278]]);
    expect(kept.map((clip) => clip.inPoint)).toEqual([0, 11, 59]);
    expect(kept[kept.length - 1].outPoint).toBe(source.outPoint);

    // 8 cut frames -> 10 source frames; 14 cut frames -> 17.5 -> 18.
    expect(kept[1].inPoint - kept[0].outPoint).toBe(Math.round(8 * speed));
    expect(kept[2].inPoint - kept[1].outPoint).toBe(Math.round(14 * speed));
    for (const fragment of kept) {
      expect(fragment.outPoint - fragment.inPoint)
        .toBe(Math.round(fragment.durationFrames * speed));
    }
  });

  it('meets exactly at the boundary when the cut removes nothing between halves', () => {
    // A split is the degenerate case of the same boundary: the halves share
    // one source frame, so no material is dropped or doubled.
    for (const speed of [0.5, 1.5, 2]) {
      const source = mediaClip({ startFrame: 0, durationFrames: 300, inPoint: 0, speed });
      const controller = new EditorController(projectWith([source]));

      expect(controller.splitClip('lead', 100)).not.toBeNull();
      const halves = onTrack(controller);

      expect(halves).toHaveLength(2);
      expect(halves[0].outPoint).toBe(halves[1].inPoint);
      expect(halves[0].outPoint - halves[0].inPoint).toBe(Math.round(100 * speed));
      expect(halves[1].outPoint).toBe(source.outPoint);
    }
  });
});

describe('fragment trims agree with the shared source-time model', () => {
  it('reads back at the frame the model maps a boundary from', () => {
    // A head cut moves its survivor left to close the gap, so the fragment's
    // `startFrame` is its rippled position and NOT the boundary the mapping
    // started from. The window is anchored to the boundary, so that is what the
    // model is asked about. Speeds whose products are exact in binary, so the
    // frames-level image and the model's seconds round trip agree to the frame.
    for (const speed of [0.25, 0.5, 1, 2, 4]) {
      for (const fps of [24, 30, 60]) {
        for (const cutLength of [1, 7, 20, 63]) {
          const source = mediaClip({ startFrame: 20, durationFrames: 300, inPoint: 90, speed });
          const controller = new EditorController(projectWith([source], fps));
          const boundary = 20 + cutLength;

          controller.rippleDeleteRanges(TRACK, [{ start: 20, end: boundary }]);
          const kept = onTrack(controller);

          expect(kept).toHaveLength(1);
          expect(kept[0].inPoint).toBe(
            secondsToProjectFrames(
              sourceSecondsForTimelineFrame(source, boundary, fps),
              fps,
            ),
          );
        }
      }
    }
  });

  it('maps a derived outPoint back onto the fragment\'s own timeline end', () => {
    // For every speed of 1 or more, rounding the span once and deriving the
    // outPoint from it keeps the window inside the fragment: reading
    // `outPoint` back through the model's inverse lands on the last frame the
    // fragment plays, so the window and the timeline it drives cannot drift
    // apart by even a frame.
    for (const speed of [1, 1.25, 1.5, 2, 3, 4]) {
      for (const durationFrames of [1, 2, 7, 31, 100, 263]) {
        const source = mediaClip({ startFrame: 0, durationFrames: 300, inPoint: 0, speed });
        const controller = new EditorController(projectWith([source], 30));

        controller.rippleDeleteRanges(TRACK, [
          { start: 0, end: 300 - durationFrames },
        ]);
        const tail = onTrack(controller).at(-1)!;

        expect(tail.durationFrames).toBe(durationFrames);
        expect(timelineFrameForSourceSeconds(tail, tail.outPoint / 30, 30))
          .toBe(tail.startFrame + durationFrames);
      }
    }
  });
});

describe('sibling fragment rebuilds carry the same speed term', () => {
  function controllerWithMedia() {
    const controller = new EditorController();
    controller.addMedia({
      id: 'asset-video', path: '/test/v.mp4', filename: 'v.mp4', type: 'video',
      duration: 2000, fileSize: 1, addedAt: new Date().toISOString(),
    });
    return controller;
  }

  it('overwrite placement re-maps the victim fragments it leaves behind', () => {
    const controller = controllerWithMedia();
    const victim = controller.addClip({
      assetId: 'asset-video', trackId: TRACK, startFrame: 200, durationFrames: 200,
    });
    expect(controller.setClipSpeed(victim, 2)).toBe(true);

    controller.placeClipWithMode({
      assetId: 'asset-video', trackId: TRACK, mode: 'overwrite',
      startFrame: 250, durationFrames: 60,
    });

    const kept = onTrack(controller).filter((item) => item.id === victim);
    expect(spans(kept)).toEqual([[200, 250], [310, 400]]);
    expect(windows(kept)).toEqual([[0, 100], [220, 400]]);
  });

  it('splitting a 2x clip hands the right half the source the left half ends on', () => {
    const source = mediaClip({ startFrame: 0, durationFrames: 300, inPoint: 0, speed: 2 });
    const controller = new EditorController(projectWith([source]));

    controller.splitClip('lead', 38);

    const halves = onTrack(controller);
    expect(halves).toHaveLength(2);
    expect(windows(halves)).toEqual([[0, 76], [76, 600]]);
    expect(halves[1].outPoint - halves[1].inPoint).toBe(524);
  });

  it('compact take maps the marked range through the source-time boundary', () => {
    const controller = controllerWithMedia();
    const source = controller.addClip({
      assetId: 'asset-video', trackId: TRACK, startFrame: 0, durationFrames: 300,
    });
    expect(controller.setClipSpeed(source, 2)).toBe(true);

    controller.setMarkedRange(100, 200);
    expect(controller.compactTake(source)).toBe(true);

    const compTrack = controller.getTracks().find((track) => track.name === 'Comp')!;
    const comp = controller.getClips().find((clip) => clip.trackId === compTrack.id)!;
    expect(comp.durationFrames).toBe(100);
    expect(windows([comp])).toEqual([[200, 400]]);
  });
});
