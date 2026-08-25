/**
 * Silence-removal scoping (upstream PR #426's `clipIds` contract).
 *
 * Upstream's remove_silence accepts an optional clip selection: the selected
 * audio clips are the detection sources, every target must resolve, and the
 * selection must share one track or belong to one linked A/V unit — otherwise
 * a ripple on one track would silently desync material on another. Omitted,
 * removal sweeps the whole timeline one audio track at a time. The refusal
 * wordings are upstream's.
 */

import type { Clip } from '../types/project';
import type { SilentRange } from '../audio/silence-detector';
import type { RippleRange } from './ripple';

export interface SilenceTrackScope {
  /** The anchor track the ranges are cut and rippled on. */
  trackId: string;
  /** Audio-type clips on that track whose silence feeds the pass. */
  clipIds: string[];
}

export interface SilenceScopeResolution {
  mode: 'selection' | 'timeline';
  scopes: SilenceTrackScope[];
}

/**
 * Resolve the requested ids into per-track detection scopes. With no ids,
 * every audio-type clip grouped by its track (track order preserved).
 *
 * Throws, in upstream's words:
 * - "Clip not found: <id>" for any unresolvable id;
 * - "Selected clips must include at least one audio clip.";
 * - "Selected clips must share one track or belong to one linked A/V unit."
 *   when targets span tracks without one shared link group;
 * - "Selected audio clips must come from one track." when the audio
 *   detection sources themselves span tracks.
 */
export function resolveSilenceScope(
  clips: readonly Clip[],
  requestedIds?: readonly string[],
): SilenceScopeResolution {
  if (!requestedIds) {
    const byTrack = new Map<string, string[]>();
    for (const clip of clips) {
      if (clip.type !== 'audio') continue;
      const list = byTrack.get(clip.trackId);
      if (list) list.push(clip.id);
      else byTrack.set(clip.trackId, [clip.id]);
    }
    return { mode: 'timeline', scopes: [...byTrack].map(([trackId, clipIds]) => ({ trackId, clipIds })) };
  }

  // Dedupe preserving first occurrence, naming the first unknown id.
  const seen = new Set<string>();
  const targets: Clip[] = [];
  for (const id of requestedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const clip = clips.find((c) => c.id === id);
    if (!clip) throw new Error(`Clip not found: ${id}`);
    targets.push(clip);
  }

  if (!targets.some((clip) => clip.type === 'audio')) {
    throw new Error('Selected clips must include at least one audio clip.');
  }

  const trackIds = new Set(targets.map((clip) => clip.trackId));
  if (trackIds.size > 1) {
    const linkGroups = new Set(
      targets.map((clip) => clip.linkGroupId).filter((id): id is string => id !== undefined),
    );
    if (linkGroups.size !== 1 || targets.some((clip) => clip.linkGroupId === undefined)) {
      throw new Error('Selected clips must share one track or belong to one linked A/V unit.');
    }
  }

  const audioTargets = targets.filter((clip) => clip.type === 'audio');
  const audioTrackIds = new Set(audioTargets.map((clip) => clip.trackId));
  if (audioTrackIds.size !== 1) {
    throw new Error('Selected audio clips must come from one track.');
  }

  return {
    mode: 'selection',
    scopes: [{
      trackId: audioTargets[0]!.trackId,
      clipIds: audioTargets.map((clip) => clip.id),
    }],
  };
}

/**
 * Map source-second silence ranges onto TIMELINE frames for one clip, so
 * ranges detected per asset can be cut together on the anchor track. Ranges
 * outside the clip's trimmed window are clamped or dropped. Assumes speed 1,
 * like the existing single-clip removal path.
 */
export function timelineSilenceRanges(
  clip: Clip,
  fps: number,
  rangesSec: readonly SilentRange[],
): RippleRange[] {
  const clipStart = clip.startFrame;
  const clipEnd = clip.startFrame + clip.durationFrames;
  const out: RippleRange[] = [];
  for (const range of rangesSec) {
    const t0 = Math.max(clipStart, clip.startFrame + Math.round(range.startSec * fps) - clip.inPoint);
    const t1 = Math.min(clipEnd, clip.startFrame + Math.round(range.endSec * fps) - clip.inPoint);
    if (t1 > t0) out.push({ start: t0, end: t1 });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** A detected span drawn inside one clip's body, in body-local pixels. */
export interface SilenceSpanRect {
  left: number;
  width: number;
  /** The timeline frame range the rectangle stands for; removing cuts this. */
  range: RippleRange;
}

/**
 * Pixel rectangles for the shaded dead-air overlay (#426's "Mark Silence").
 * Spans outside the clip's trimmed window are clamped or dropped by the same
 * mapping the removal uses, so what the user sees is exactly what a click
 * would cut.
 */
export function silenceSpanRects(
  clip: Clip,
  fps: number,
  pixelsPerFrame: number,
  rangesSec: readonly SilentRange[],
): SilenceSpanRect[] {
  return timelineSilenceRanges(clip, fps, rangesSec).map((range) => ({
    left: (range.start - clip.startFrame) * pixelsPerFrame,
    width: (range.end - range.start) * pixelsPerFrame,
    range,
  }));
}
