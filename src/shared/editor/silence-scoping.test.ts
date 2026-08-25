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
  timelineSilenceRanges,
} from './silence-scoping';

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
