import { describe, it, expect } from 'vitest';
import { buildVtt, toVttTimecode } from './vtt';
import { parseSrt } from './srt';

describe('toVttTimecode', () => {
  it('formats with dots and padded fields', () => {
    expect(toVttTimecode(0)).toBe('00:00:00.000');
    expect(toVttTimecode(3723.5)).toBe('01:02:03.500');
    expect(toVttTimecode(-5)).toBe('00:00:00.000'); // clamped
  });
});

describe('buildVtt', () => {
  it('emits a WEBVTT header and sorted cue blocks', () => {
    const vtt = buildVtt([
      { startSec: 4, endSec: 6, text: 'second' },
      { startSec: 1, endSec: 3, text: 'first' },
    ]);
    const lines = vtt.split('\n');
    expect(lines[0]).toBe('WEBVTT');
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.000\nfirst');
    // Sorted despite input order.
    expect(vtt.indexOf('first')).toBeLessThan(vtt.indexOf('second'));
  });

  it('drops blank-text and inverted cues', () => {
    const vtt = buildVtt([
      { startSec: 0, endSec: 1, text: '  ' },
      { startSec: 2, endSec: 1, text: 'inverted' },
      { startSec: 3, endSec: 4, text: 'kept' },
    ]);
    expect(vtt).toContain('kept');
    expect(vtt).not.toContain('inverted');
  });

  it('round-trips through the SRT parser minus header', () => {
    const original = [
      { startSec: 1.5, endSec: 3.25, text: 'hello world' },
      { startSec: 10, endSec: 12.5, text: 'two\nlines' },
    ];
    const vtt = buildVtt(original);
    // parseSrt skips the WEBVTT header line as a malformed cue block and
    // reads the rest.
    const cues = parseSrt(vtt);
    expect(cues).toHaveLength(original.length);
    expect(cues[0].startSec).toBeCloseTo(1.5);
    expect(cues[1].text).toContain('lines');
  });
});
