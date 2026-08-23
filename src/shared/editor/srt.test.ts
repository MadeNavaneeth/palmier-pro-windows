import { describe, it, expect } from 'vitest';
import { parseSrt, parseSrtTimecode } from './srt';

const SAMPLE = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  'Hello there',
  '',
  '2',
  '00:00:04,000 --> 00:00:06,250',
  'Second cue,',
  'two lines',
].join('\n');

describe('parseSrtTimecode', () => {
  it('parses comma and dot milliseconds', () => {
    expect(parseSrtTimecode('01:02:03,500')).toBe(3723.5);
    expect(parseSrtTimecode('01:02:03.5')).toBe(3723.5);
    expect(parseSrtTimecode('00:00:00,000')).toBe(0);
  });

  it('rejects malformed timecodes', () => {
    expect(parseSrtTimecode('nope')).toBeNull();
    expect(parseSrtTimecode('99:99:99,000')).toBeNull();
  });
});

describe('parseSrt', () => {
  it('parses ids, timecodes and multi-line text', () => {
    const cues = parseSrt(SAMPLE);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ startSec: 1, endSec: 3.5, text: 'Hello there' });
    expect(cues[1].text).toBe('Second cue,\ntwo lines');
    expect(cues[1].endSec).toBeCloseTo(6.25);
  });

  it('handles BOM and CRLF', () => {
    const cues = parseSrt('\uFEFF' + SAMPLE.replace(/\n/g, '\r\n'));
    expect(cues).toHaveLength(2);
  });

  it('strips simple markup tags from cue text', () => {
    const cues = parseSrt(
      '1\n00:00:00,000 --> 00:00:01,000\n<i>italic</i> and <b>bold</b>',
    );
    expect(cues[0].text).toBe('italic and bold');
  });

  it('skips malformed cues without failing the import', () => {
    const messy = [
      'not an id',
      'garbage line',
      '',
      '1',
      '00:00:05,000 --> 00:00:04,000', // inverted window
      'skipped',
      '',
      '2',
      '00:00:05,000 --> 00:00:07,000',
      'kept',
    ].join('\n');
    const cues = parseSrt(messy);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('kept');
  });

  it('returns an empty list for empty input', () => {
    expect(parseSrt('')).toEqual([]);
    expect(parseSrt('\n\n\n')).toEqual([]);
  });
});
