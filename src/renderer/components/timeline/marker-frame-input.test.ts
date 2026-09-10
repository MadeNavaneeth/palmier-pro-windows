import { describe, expect, it } from 'vitest';
import { parseMarkerFrameInput } from './marker-frame-input';

describe('parseMarkerFrameInput', () => {
  it('accepts plain frames', () => {
    expect(parseMarkerFrameInput('250', 30)).toBe(250);
    expect(parseMarkerFrameInput('  0  ', 30)).toBe(0);
  });

  it('accepts SMPTE timecode at the project rate', () => {
    expect(parseMarkerFrameInput('00:00:08:10', 30)).toBe(250);
    expect(parseMarkerFrameInput('01:00:00:00', 30)).toBe(108000);
  });

  it('refuses out-of-range timecode parts', () => {
    expect(parseMarkerFrameInput('00:61:00:00', 30)).toBeNull();
    expect(parseMarkerFrameInput('00:00:61:00', 30)).toBeNull();
    // Frame digits must fit inside one project-rate second.
    expect(parseMarkerFrameInput('00:00:08:30', 30)).toBeNull();
    expect(parseMarkerFrameInput('00:00:08:29', 30)).toBe(269);
  });

  it('refuses anything that is neither frames nor timecode', () => {
    expect(parseMarkerFrameInput('', 30)).toBeNull();
    expect(parseMarkerFrameInput('abc', 30)).toBeNull();
    expect(parseMarkerFrameInput('00:01:00', 30)).toBeNull();
    expect(parseMarkerFrameInput('-5', 30)).toBeNull();
    expect(parseMarkerFrameInput('1.5', 30)).toBeNull();
  });
});
