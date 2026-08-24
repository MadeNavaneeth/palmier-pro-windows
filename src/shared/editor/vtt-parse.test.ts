import { describe, it, expect } from 'vitest';
import { parseVtt } from './vtt-parse';

const SAMPLE = [
  'WEBVTT',
  '',
  'cue-1',
  '00:00:01.000 --> 00:00:03.500',
  'Hello there',
  '',
  '00:00:04.000 --> 00:00:06.250',
  'Second cue,',
  'two lines',
].join('\n');

describe('parseVtt', () => {
  it('parses cues with and without identifiers', () => {
    const cues = parseVtt(SAMPLE);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ startSec: 1, endSec: 3.5, text: 'Hello there' });
    expect(cues[1].text).toBe('Second cue,\ntwo lines');
  });

  it('skips WEBVTT header, NOTE blocks, and STYLE blocks', () => {
    const content = [
      'WEBVTT',
      '',
      'NOTE This is a comment',
      'spanning multiple lines',
      '',
      'STYLE\n::cue { color: red }',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Real cue',
    ].join('\n');
    const cues = parseVtt(content);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Real cue');
  });

  it('handles CRLF and BOM', () => {
    const content = '\uFEFFWEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHello\r\n';
    const cues = parseVtt(content);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Hello');
  });

  it('returns empty for empty or header-only input', () => {
    expect(parseVtt('')).toEqual([]);
    expect(parseVtt('WEBVTT')).toEqual([]);
    expect(parseVtt('\n\n')).toEqual([]);
  });

  it('sorts cues by start time', () => {
    const content = [
      'WEBVTT',
      '',
      '00:00:05.000 --> 00:00:06.000',
      'Later',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Earlier',
    ].join('\n');
    const cues = parseVtt(content);
    expect(cues[0].startSec).toBe(1);
    expect(cues[1].startSec).toBe(5);
  });
});
