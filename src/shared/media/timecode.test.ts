import { describe, expect, it } from 'vitest';
import {
  isValidSmpteTimecode,
  pickTimecodeFromTags,
  secondsToTimecode,
  timecodeToSeconds,
} from './timecode';

describe('isValidSmpteTimecode (#154)', () => {
  it('accepts colon and semicolon timecodes', () => {
    expect(isValidSmpteTimecode('01:00:00:00')).toBe(true);
    expect(isValidSmpteTimecode('01:00:00;00')).toBe(true);
    expect(isValidSmpteTimecode('100:59:59:29')).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isValidSmpteTimecode('1:00:00:00')).toBe(false);
    expect(isValidSmpteTimecode('01:60:00:00')).toBe(false);
    expect(isValidSmpteTimecode('01:00:60:00')).toBe(false);
    expect(isValidSmpteTimecode('01:00:00')).toBe(false);
    expect(isValidSmpteTimecode('timecode')).toBe(false);
    expect(isValidSmpteTimecode(undefined)).toBe(false);
  });
});

describe('timecodeToSeconds (#154)', () => {
  it('converts at the nominal rate', () => {
    expect(timecodeToSeconds('01:00:00:00', 30)).toBe(3600);
    expect(timecodeToSeconds('00:00:08:15', 30)).toBeCloseTo(8.5, 6);
    expect(timecodeToSeconds('00:01:00:00', 24)).toBe(60);
  });

  it('refuses drop-frame strings rather than guessing', () => {
    expect(timecodeToSeconds('01:00:00;00', 30)).toBeNull();
  });

  it('refuses a frame field beyond the nominal rate and unusable rates', () => {
    expect(timecodeToSeconds('00:00:00:30', 30)).toBeNull();
    expect(timecodeToSeconds('00:00:00:00', 0)).toBeNull();
    expect(timecodeToSeconds('nope', 30)).toBeNull();
  });
});

describe('secondsToTimecode (#154)', () => {
  it('round-trips with timecodeToSeconds', () => {
    for (const tc of ['00:00:00:00', '00:00:08:15', '01:00:00:00', '10:30:07:01']) {
      const seconds = timecodeToSeconds(tc, 30)!;
      expect(secondsToTimecode(seconds, 30)).toBe(tc);
    }
  });

  it('returns null for unusable input', () => {
    expect(secondsToTimecode(-1, 30)).toBeNull();
    expect(secondsToTimecode(Number.NaN, 30)).toBeNull();
    expect(secondsToTimecode(10, 0)).toBeNull();
  });
});

describe('pickTimecodeFromTags (#154)', () => {
  it('prefers the stream tag over the container tag', () => {
    expect(pickTimecodeFromTags({ timecode: '00:00:01:00' }, { timecode: '01:00:00:00' }))
      .toBe('00:00:01:00');
    expect(pickTimecodeFromTags(undefined, { timecode: '01:00:00:00' })).toBe('01:00:00:00');
  });

  it('ignores unusable tag values', () => {
    expect(pickTimecodeFromTags({ timecode: 'x' }, {})).toBeUndefined();
    expect(pickTimecodeFromTags(undefined, undefined)).toBeUndefined();
  });
});
