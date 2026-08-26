/**
 * Caption planner coverage (#91): word-timestamp snapping, pause-aware
 * breaks, char budgets across lines, sentence-punctuation soft breaks, and
 * defensive input handling. These rules are the #91 lesson â€” cue boundaries
 * come from real word times, never character-count distribution.
 */
import { describe, it, expect } from 'vitest';
import { planCaptions, type WordTiming } from './planner';

function words(...entries: Array<[string, number, number]>): WordTiming[] {
  return entries.map(([word, startSec, endSec]) => ({ word, startSec, endSec }));
}

describe('planCaptions (#91)', () => {
  it('snaps cue boundaries to real word timestamps', () => {
    const cues = planCaptions(words(
      ['Hello', 0.0, 0.4],
      ['world', 0.5, 1.0],
    ), { maxCharsPerLine: 42, maxLines: 2 });

    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual({ startSec: 0.0, endSec: 1.0, text: 'Hello world' });
  });

  it('breaks at natural pauses above the threshold', () => {
    const cues = planCaptions(words(
      ['Welcome', 0.0, 0.5],
      ['back', 0.6, 1.0],
      ['Anyway', 5.0, 5.5], // 4s pause before this word
      ['again', 5.6, 6.0],
    ));

    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe('Welcome back');
    expect(cues[0]!.endSec).toBe(1.0);
    expect(cues[1]!.startSec).toBe(5.0);
  });

  it('enforces the per-caption char budget across lines', () => {
    const cues = planCaptions(words(
      ['one', 0.0, 0.2],
      ['two', 0.3, 0.5],
      ['three', 0.6, 0.8],
      ['four', 0.9, 1.1],
      ['five', 1.2, 1.4],
      ['six', 1.5, 1.7],
      ['seven', 1.8, 2.0],
      ['eight', 2.1, 2.3],
    ), { maxCharsPerLine: 10, maxLines: 2 }); // budget: 20 chars per caption

    for (const cue of cues) {
      const withoutBreaks = cue.text.replace('\n', ' ');
      expect(withoutBreaks.length).toBeLessThanOrEqual(20);
      expect(cue.text.split('\n').length).toBeLessThanOrEqual(2);
      for (const line of cue.text.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(10);
      }
    }
    // All eight words survive somewhere.
    const allText = cues.map((c) => c.text.replace('\n', ' ')).join(' ');
    for (const w of ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']) {
      expect(allText).toContain(w);
    }
  });

  it('soft-breaks after sentence punctuation even under budget', () => {
    const cues = planCaptions(words(
      ['Stop.', 0.0, 0.4],
      ['Look.', 0.5, 0.9],
      ['Listen.', 1.0, 1.4],
    ));

    expect(cues).toHaveLength(3);
    expect(cues[0]!.text).toBe('Stop.');
  });

  it('never splits a word across captions', () => {
    const cues = planCaptions(words(
      ['extraordinarily', 0.0, 1.0],
      ['big', 1.1, 1.4],
    ), { maxCharsPerLine: 10, maxLines: 2 });

    expect(cues[0]!.text).toContain('extraordinarily');
    expect(cues.map((c) => c.text).join('|')).not.toMatch(/extraord\n|extraordinar\ny/);
  });

  it('handles empty and hostile input defensively', () => {
    expect(planCaptions([])).toEqual([]);
    expect(planCaptions([
      { word: '', startSec: 0, endSec: 1 },
      { word: 'ok', startSec: Number.NaN, endSec: 1 },
      { word: 'fine', startSec: 1, endSec: 2 },
    ])).toHaveLength(1);
  });
});


