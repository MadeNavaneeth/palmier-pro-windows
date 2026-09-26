/**
 * Unit coverage for the remove_silence scoping rules (upstream PR #426's
 * `clipIds` contract) and the source-seconds -> timeline-frame mapping the
 * executor feeds to the ripple engine. Refusal wordings are upstream's and
 * are asserted exactly, because they reach the model verbatim.
 *
 * Clips are synthetic literals: the rules under test read only
 * id/type/trackId/linkGroupId/in/out/start/duration.
 */
import { describe, it, expect } from 'vitest';
import type { Clip } from '../types/project';
import {
  resolveSilenceScope,
  mapSilenceRangesToTimeline,
  timelineSilenceRanges,
  silenceSpanRects,
} from './silence-scoping';
import { sourceSecondsForTimelineFrame } from '../media/source-time';


let seq = 0;
function mkClip(overrides: Partial<Clip> & Pick<Clip, 'trackId' | 'type'>): Clip {
  return {
    id: `c${++seq}`,
    assetId: 'asset',
    label: 'clip',
    startFrame: 0,
    durationFrames: 300,
    inPoint: 0,
    outPoint: 300,
    ...overrides,
  } as Clip;
}

describe('resolveSilenceScope — timeline mode', () => {
  it('groups every audio-type clip by track, ignoring other types', () => {
    const a1 = mkClip({ trackId: 'a1', type: 'audio' });
    const v1 = mkClip({ trackId: 'v1', type: 'video' });
    const a1b = mkClip({ trackId: 'a1', type: 'audio', startFrame: 400 });
    const a2 = mkClip({ trackId: 'a2', type: 'audio' });
    const img = mkClip({ trackId: 'v2', type: 'image' });

    const resolution = resolveSilenceScope([v1, img, a1, a1b, a2]);

    expect(resolution.mode).toBe('timeline');
    expect(resolution.scopes).toEqual([
      { trackId: 'a1', clipIds: [a1.id, a1b.id] },
      { trackId: 'a2', clipIds: [a2.id] },
    ]);
  });
});

describe('resolveSilenceScope — selection mode', () => {
  it('dedupes repeated ids and anchors on the audio track', () => {
    const a = mkClip({ trackId: 'a1', type: 'audio' });

    expect(resolveSilenceScope([a], [a.id, a.id])).toEqual({
      mode: 'selection',
      scopes: [{ trackId: 'a1', clipIds: [a.id] }],
    });
  });

  it('names an unknown id', () => {
    const a = mkClip({ trackId: 'a1', type: 'audio' });

    expect(() => resolveSilenceScope([a], [a.id, 'ghost']))
      .toThrow('Clip not found: ghost');
  });

  it('refuses a selection without an audio clip', () => {
    const v = mkClip({ trackId: 'v1', type: 'video' });

    expect(() => resolveSilenceScope([v], [v.id]))
      .toThrow('Selected clips must include at least one audio clip.');
  });

  it('refuses multi-track selections that are not one link group', () => {
    const v = mkClip({ trackId: 'v1', type: 'video' });
    const a = mkClip({ trackId: 'a1', type: 'audio' });
    const unlinkedElsewhere = mkClip({ trackId: 'a2', type: 'audio' });

    expect(() => resolveSilenceScope([v, a, unlinkedElsewhere], [v.id, a.id, unlinkedElsewhere.id]))
      .toThrow('Selected clips must share one track or belong to one linked A/V unit.');
    expect(() => resolveSilenceScope([a, unlinkedElsewhere], [a.id, unlinkedElsewhere.id]))
      .toThrow('Selected clips must share one track or belong to one linked A/V unit.');
  });

  it('refuses when some member of a spanning selection is unlinked', () => {
    const group = 'g1';
    const v = mkClip({ trackId: 'v1', type: 'video', linkGroupId: group });
    const a = mkClip({ trackId: 'a1', type: 'audio', linkGroupId: group });
    const stray = mkClip({ trackId: 'v2', type: 'video' });

    // Mixed groups: two distinct group ids once undefined counts as its own.
    expect(() => resolveSilenceScope([v, a, stray], [v.id, a.id, stray.id]))
      .toThrow('Selected clips must share one track or belong to one linked A/V unit.');
  });

  it('accepts a linked A/V pair spanning two tracks and anchors on the audio side', () => {
    const group = 'g1';
    const v = mkClip({ trackId: 'v1', type: 'video', linkGroupId: group });
    const a = mkClip({ trackId: 'a1', type: 'audio', linkGroupId: group });

    expect(resolveSilenceScope([v, a], [v.id, a.id])).toEqual({
      mode: 'selection',
      scopes: [{ trackId: 'a1', clipIds: [a.id] }],
    });
  });

  it('refuses audio detection sources spanning tracks even inside one group', () => {
    // Unreachable through linkClips (it requires differing media types), but
    // the guard exists upstream, so the rule must hold for any input.
    const group = 'g2';
    const a = mkClip({ trackId: 'a1', type: 'audio', linkGroupId: group });
    const b = mkClip({ trackId: 'a2', type: 'audio', linkGroupId: group });

    expect(() => resolveSilenceScope([a, b], [a.id, b.id]))
      .toThrow('Selected audio clips must come from one track.');
  });
});

describe('timelineSilenceRanges', () => {
  it('offsets by the trim window and clamps to the clip bounds', () => {
    const clip = mkClip({ trackId: 'a1', type: 'audio', startFrame: 300 });

    const ranges = timelineSilenceRanges(clip, 30, [
      { startSec: 1, endSec: 2 },   // inside -> 330..360
      { startSec: -5, endSec: 12 }, // clamped to the whole clip -> 300..600
      { startSec: 11, endSec: 20 }, // entirely past the window -> dropped
    ]);

    expect(ranges).toEqual([
      { start: 300, end: 600 },
      { start: 330, end: 360 },
    ]);
  });

  it('respects the clip in-point when mapping source time', () => {
    const clip = mkClip({
      trackId: 'a1',
      type: 'audio',
      startFrame: 0,
      inPoint: 150,
      outPoint: 450,
    });

    // Source 6s is frame 180; minus in-point 150 -> timeline frame 30.
    expect(timelineSilenceRanges(clip, 30, [{ startSec: 6, endSec: 7 }]))
      .toEqual([{ start: 30, end: 60 }]);
  });
});

/**
 * The pre-fix mapping, kept verbatim as the speed-1 reference. `speed` is
 * absent from it, which is the whole defect: at speed 1 the two must agree on
 * every input, including which spans are dropped.
 */
function legacySpeed1Ranges(
  clip: Clip,
  fps: number,
  rangesSec: readonly { startSec: number; endSec: number }[],
) {
  const clipStart = clip.startFrame;
  const clipEnd = clip.startFrame + clip.durationFrames;
  const out: { start: number; end: number }[] = [];
  for (const range of rangesSec) {
    const t0 = Math.max(clipStart, clip.startFrame + Math.round(range.startSec * fps) - clip.inPoint);
    const t1 = Math.min(clipEnd, clip.startFrame + Math.round(range.endSec * fps) - clip.inPoint);
    if (t1 > t0) out.push({ start: t0, end: t1 });
  }
  return out.sort((a, b) => a.start - b.start);
}

describe('timelineSilenceRanges — speed 1 is unchanged', () => {
  const clipCases: Clip[] = [
    mkClip({ trackId: 'a1', type: 'audio' }),
    mkClip({ trackId: 'a1', type: 'audio', startFrame: 300, inPoint: 0, outPoint: 300 }),
    mkClip({ trackId: 'a1', type: 'audio', startFrame: 137, inPoint: 151, outPoint: 451, durationFrames: 300 }),
    mkClip({ trackId: 'a1', type: 'audio', startFrame: 0, inPoint: 900, outPoint: 1200, durationFrames: 300 }),
  ];

  const rangeCases = [
    { startSec: 1, endSec: 2 },
    { startSec: 0, endSec: 0.5 },
    { startSec: -5, endSec: 12 },
    { startSec: 11, endSec: 20 },
    { startSec: 20, endSec: 30 },
    { startSec: 9.9, endSec: 10.1 },
    { startSec: 10, endSec: 12 },
    { startSec: 3, endSec: 3 },
    { startSec: 4, endSec: 2 },
    { startSec: 0, endSec: 40 },
    { startSec: 2.5, endSec: 7.25 },
  ];

  it('produces the legacy frames frame-for-frame, drops included', () => {
    for (const clip of clipCases) {
      for (const fps of [24, 30, 60]) {
        for (const range of rangeCases) {
          // One clip at a time so a failure names the input, and the pair
          // together so ordering and clamping stay covered.
          expect(timelineSilenceRanges(clip, fps, [range]))
            .toEqual(legacySpeed1Ranges(clip, fps, [range]));
        }
        expect(timelineSilenceRanges(clip, fps, rangeCases))
          .toEqual(legacySpeed1Ranges(clip, fps, rangeCases));
      }
    }
  });

  it('is unaffected by an explicit speed of 1', () => {
    const clip = mkClip({ trackId: 'a1', type: 'audio', speed: 1 });
    expect(timelineSilenceRanges(clip, 30, rangeCases))
      .toEqual(legacySpeed1Ranges(clip, 30, rangeCases));
  });
});

describe('timelineSilenceRanges — speed', () => {
  /** 30fps, 300 frames (10s) on the timeline, `speed` consuming 10x that. */
  function spedClip(speed: number): Clip {
    return mkClip({
      trackId: 'a1',
      type: 'audio',
      startFrame: 0,
      inPoint: 0,
      outPoint: Math.round(300 * speed),
      durationFrames: 300,
      speed,
    });
  }

  it('cuts a 2x clip at the silence, not twice past it', () => {
    const clip = spedClip(2);
    const ranges = [{ startSec: 2, endSec: 2.5 }];

    // Before the fix this was 60..75, i.e. source 4.0-5.0s: half a second of
    // real speech deleted while the silence at 30..38 survived.
    expect(timelineSilenceRanges(clip, 30, ranges)).toEqual([{ start: 30, end: 38 }]);
    expect(legacySpeed1Ranges(clip, 30, ranges)).toEqual([{ start: 60, end: 75 }]);

    // And the cut frames convert back to the source span they came from.
    expect(sourceSecondsForTimelineFrame(clip, 30, 30)).toBeCloseTo(2, 6);
    expect(sourceSecondsForTimelineFrame(clip, 38, 30)).toBeCloseTo(2.5, 1);
  });

  it('keeps a 2x range the legacy mapping dropped as out of window', () => {
    const clip = spedClip(2);
    const ranges = [{ startSec: 12, endSec: 13.5 }];

    // Before the fix 360 and 405 both clamped to the clip end of 300, so the
    // range vanished and the caller reported "no silence" for detected audio.
    expect(timelineSilenceRanges(clip, 30, ranges)).toEqual([{ start: 180, end: 203 }]);
    expect(legacySpeed1Ranges(clip, 30, ranges)).toEqual([]);
  });

  it('scales with fractional speeds', () => {
    // 0.5x consumes 5 source seconds across the 300 timeline frames.
    const half = spedClip(0.5);
    expect(timelineSilenceRanges(half, 30, [{ startSec: 1, endSec: 2 }]))
      .toEqual([{ start: 60, end: 120 }]);
    expect(sourceSecondsForTimelineFrame(half, 60, 30)).toBeCloseTo(1, 6);

    // 1.5x consumes 15 source seconds; 3s in is 60 timeline frames in.
    const oneAndAHalf = spedClip(1.5);
    expect(timelineSilenceRanges(oneAndAHalf, 30, [{ startSec: 3, endSec: 4 }]))
      .toEqual([{ start: 60, end: 80 }]);
    expect(sourceSecondsForTimelineFrame(oneAndAHalf, 80, 30)).toBeCloseTo(4, 6);
  });

  it('keeps a straddling range clipped to the part inside the clip', () => {
    const clip = spedClip(2);
    // Source 9..25s is 135..375 on the timeline, and the clip ends at 300.
    const mapping = mapSilenceRangesToTimeline(clip, 30, [{ startSec: 9, endSec: 25 }]);

    expect(mapping.ranges).toEqual([{ start: 135, end: 300 }]);
    expect(mapping.omitted).toEqual([]);
  });

  it('reports a range that overlaps no part of the clip instead of dropping it', () => {
    const clip = spedClip(2);
    // Source 25..26s is timeline 375..390, past the clip end of 300.
    const mapping = mapSilenceRangesToTimeline(clip, 30, [{ startSec: 25, endSec: 26 }]);

    expect(mapping.ranges).toEqual([]);
    expect(mapping.omitted).toEqual([
      { startSec: 25, endSec: 26, reason: 'outside-clip' },
    ]);
  });

  it('reports non-finite ranges rather than cutting the head of the clip', () => {
    const clip = spedClip(2);
    const mapping = mapSilenceRangesToTimeline(clip, 30, [
      { startSec: Number.NaN, endSec: 2 },
    ]);

    expect(mapping.ranges).toEqual([]);
    expect(mapping.omitted).toHaveLength(1);
    expect(mapping.omitted[0].reason).toBe('invalid-range');
  });

  it('separates the cut ranges from the reported omissions in one pass', () => {
    const clip = spedClip(2);
    const mapping = mapSilenceRangesToTimeline(clip, 30, [
      { startSec: 8, endSec: 8.5 },   // inside  -> 120..128
      { startSec: 25, endSec: 26 },   // past    -> omitted
      { startSec: 1, endSec: 1.5 },   // inside  -> 15..23
    ]);

    expect(mapping.ranges).toEqual([
      { start: 15, end: 23 },
      { start: 120, end: 128 },
    ]);
    expect(mapping.omitted).toHaveLength(1);
    expect(mapping.omitted[0].startSec).toBe(25);
  });
});


describe('silenceSpanRects (#426 overlay)', () => {
  const clip = mkClip({
    trackId: 'a1',
    type: 'audio',
    startFrame: 300,
    durationFrames: 300,
    inPoint: 0,
    outPoint: 300,
  });

  it('maps source seconds to body-local pixels through the timeline mapping', () => {
    // 1-2s -> frames 330..360 on the timeline -> 30..60 within the clip body;
    // at 2 px/frame that is left 60, width 60.
    expect(silenceSpanRects(clip, 30, 2, [{ startSec: 1, endSec: 2 }])).toEqual([
      { left: 60, width: 60, range: { start: 330, end: 360 } },
    ]);
  });

  it('clamps spans to the trimmed window and drops the empty remainder', () => {
    const rects = silenceSpanRects(clip, 30, 2, [
      { startSec: -3, endSec: 20 }, // covers the whole clip -> one full-body band
      { startSec: 11, endSec: 12 }, // entirely past the window -> dropped
    ]);

    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ left: 0, width: 600 });
    expect(rects[0].range).toEqual({ start: 300, end: 600 });
  });
});
