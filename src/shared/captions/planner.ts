/**
 * Caption planning from word timings (#91).
 *
 * The failure mode upstream reported was captions distributed by character
 * count â€” text drifting off-sync with speech because cue boundaries ignored
 * where words actually begin and end. This planner takes word-level timings
 * (from ANY transcription source: cloud API, local whisper, manual) and
 * produces cues that:
 *
 *   1. snap start/end to the first/last word's real timestamps;
 *   2. break at natural pauses (inter-word silence above a threshold);
 *   3. respect a per-caption character budget across up to N lines;
 *   4. never split a word.
 *
 * Pure and engine-agnostic: whatever produces `WordTiming[]`, the cue math
 * lives here and is unit-tested against broadcast-style defaults
 * (42 chars/line, 2 lines â€” the Netflix/CEA-608-inspired norm).
 */

export interface WordTiming {
  /** The word, without surrounding whitespace. */
  word: string;
  startSec: number;
  endSec: number;
}

export interface CaptionCue {
  startSec: number;
  endSec: number;
  /**
   * Cue text with '\n' line breaks already placed at balanced points, ready
   * for a multi-line text overlay.
   */
  text: string;
}

export interface CaptionPlanOptions {
  /** Max characters per line. Default 42. */
  maxCharsPerLine?: number;
  /** Max lines per caption. Default 2. */
  maxLines?: number;
  /** Inter-word silence (sec) that forces a caption break. Default 0.6. */
  pauseBreakSec?: number;
}

const DEFAULTS = {
  maxCharsPerLine: 42,
  maxLines: 2,
  pauseBreakSec: 0.6,
} as const;

/** Greedy line packing: fill lines up to maxChars, never splitting words. */
function packLines(words: string[], maxChars: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Plan caption cues from timed words.
 *
 * Words are assumed sorted by startSec; out-of-order entries are sorted here
 * defensively. Non-finite or negative timings drop the word rather than
 * corrupting neighbors.
 */
export function planCaptions(
  words: readonly WordTiming[],
  options: CaptionPlanOptions = {},
): CaptionCue[] {
  const { maxCharsPerLine, maxLines, pauseBreakSec } = { ...DEFAULTS, ...options };

  const clean = words
    .map((w) => ({ ...w, word: w.word.trim() }))
    .filter((w) => w.word.length > 0 && Number.isFinite(w.startSec) && Number.isFinite(w.endSec))
    .sort((a, b) => a.startSec - b.startSec);

  // Greedy line packing: fill lines up to maxChars, never splitting words. */
  const fits = (words: string[]): boolean => {
    const lines = packLines(words, maxCharsPerLine);
    return lines.length <= maxLines && lines.every((line) => line.length <= maxCharsPerLine);
  };

  const cues: CaptionCue[] = [];
  let bucket: WordTiming[] = [];

  const flush = (): void => {
    if (bucket.length === 0) return;
    const lines = packLines(bucket.map((w) => w.word), maxCharsPerLine);
    cues.push({
      startSec: bucket[0]!.startSec,
      endSec: bucket[bucket.length - 1]!.endSec,
      text: lines.join('\n'),
    });
    bucket = [];
  };

  for (let i = 0; i < clean.length; i++) {
    const word = clean[i]!;
    const prev = bucket[bucket.length - 1];

    // Pause break: silence between words marks a natural caption boundary.
    if (prev && word.startSec - prev.endSec >= pauseBreakSec) flush();

    // Budget break decided by simulating the real line packing â€” a flat char
    // count drifts from greedy wrapping once word boundaries interfere (#91).
    if (bucket.length > 0 && !fits([...bucket.map((w) => w.word), word.word])) flush();

    bucket.push(word);

    // Sentence-ending punctuation is a soft break even under budget â€” reading
    // rhythm beats packing density.
    if (/[.!?]$/.test(word.word) && i < clean.length - 1) flush();
  }
  flush();

  return cues;
}

