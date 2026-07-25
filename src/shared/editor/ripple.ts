import type { Clip, Frame } from '../types/project';

export interface RippleRange {
  start: Frame;
  end: Frame;
}

export interface RippleShift {
  clipId: string;
  startFrame: Frame;
}

export function mergeRippleRanges(ranges: RippleRange[]): RippleRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const merged: RippleRange[] = [];

  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

export function computeRippleShifts(
  clips: Clip[],
  removedRanges: RippleRange[],
): RippleShift[] {
  const merged = mergeRippleRanges(removedRanges);
  if (merged.length === 0) return [];

  return clips
    .map((clip) => {
      const shift = merged
        .filter((range) => range.end <= clip.startFrame)
        .reduce((total, range) => total + range.end - range.start, 0);
      return shift > 0
        ? { clipId: clip.id, startFrame: clip.startFrame - shift }
        : null;
    })
    .filter((shift): shift is RippleShift => shift !== null);
}
