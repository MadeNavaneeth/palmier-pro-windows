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
  /** Max words per caption. Default unlimited (unset). */
  maxWordsPerCue?: number;
  /** Inter-word silence (sec) that forces a caption break. Default 0.6. */
  pauseBreakSec?: number;
}

const DEFAULTS = {
  maxCharsPerLine: 42,
  maxLines: 2,
  pauseBreakSec: 0.6,
} as const;

/**
 * Accepted ranges for the user-facing caption controls (#91: "no
 * words-per-caption control"). The Inspector/Agent boundary narrows against
 * these exactly, and the defaults equal broadcast convention (42 chars/line,
 * 2 lines) so an untouched control set produces what the planner always did.
 */
export const CAPTION_PLAN_LIMITS = {
  maxCharsPerLine: { min: 10, max: 80 },
  maxLines: { min: 1, max: 4 },
  maxWordsPerCue: { min: 1, max: 20 },
  pauseBreakSec: { min: 0.1, max: 3 },
} as const;

export type CaptionPlanField = keyof typeof CAPTION_PLAN_LIMITS;

/**
 * Narrow a partial plan request to finite, in-range values.
 *
 * Fields are dropped rather than clamped when unusable, matching the color
 * grade and EQ patches: "present but absurd" must not silently become a
 * boundary value. `planCaptions` then mixes whatever survives over its
 * defaults.
 */
export function normalizeCaptionPlanOptions(
  input: Partial<CaptionPlanOptions> | undefined,
): Partial<CaptionPlanOptions> {
  if (!input) return {};
  const out: Partial<CaptionPlanOptions> = {};
  for (const field of Object.keys(CAPTION_PLAN_LIMITS) as CaptionPlanField[]) {
    const value = input[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const { min, max } = CAPTION_PLAN_LIMITS[field];
    if (value < min || value > max) continue;
    // Character/line/word budgets are counts; a fractional count would make
    // the packing math read "2.5 lines", so round to the nearest integer.
    out[field] = field === 'pauseBreakSec' ? value : Math.round(value);
  }
  return out;
}

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
  const { maxCharsPerLine, maxLines, maxWordsPerCue, pauseBreakSec } = { ...DEFAULTS, ...options };

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

    // Words-per-caption budget (upstream #91: "no words-per-caption control").
    if (maxWordsPerCue !== undefined && Number.isFinite(maxWordsPerCue) && maxWordsPerCue > 0 && bucket.length >= maxWordsPerCue) flush();

    // Budget break decided by simulating the real line packing — a flat char
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

