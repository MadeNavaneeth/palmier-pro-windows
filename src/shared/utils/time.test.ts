import { describe, it, expect } from 'vitest';
import {
  frameToTimecode,
  timecodeToFrame,
  secondsToFrame,
  frameToSeconds,
  snapToGrid,
  clampFrame,
  formatDuration,
} from './time';

describe('time utilities', () => {
  it('converts frame to SMPTE timecode', () => {
    expect(frameToTimecode(0, 30)).toBe('00:00:00:00');
    expect(frameToTimecode(30, 30)).toBe('00:00:01:00');
    expect(frameToTimecode(90, 30)).toBe('00:00:03:00');
    expect(frameToTimecode(1815, 30)).toBe('00:01:00:15');
    expect(frameToTimecode(108000, 30)).toBe('01:00:00:00');
  });

  it('parses SMPTE timecode to frame', () => {
    expect(timecodeToFrame('00:00:00:00', 30)).toBe(0);
    expect(timecodeToFrame('00:00:01:00', 30)).toBe(30);
    expect(timecodeToFrame('00:01:00:15', 30)).toBe(1815);
    expect(timecodeToFrame('01:00:00:00', 30)).toBe(108000);
  });

  it('round-trips timecode conversion', () => {
    for (const frame of [0, 1, 29, 30, 59, 150, 900, 3600, 108000]) {
      expect(timecodeToFrame(frameToTimecode(frame, 30), 30)).toBe(frame);
    }
  });

  it('converts seconds ↔ frames', () => {
    expect(secondsToFrame(1, 30)).toBe(30);
    expect(secondsToFrame(0.5, 30)).toBe(15);
    expect(frameToSeconds(60, 30)).toBe(2);
    expect(frameToSeconds(0, 30)).toBe(0);
  });

  it('snaps to grid', () => {
    expect(snapToGrid(7, 10)).toBe(10);
    expect(snapToGrid(3, 10)).toBe(0);
    expect(snapToGrid(15, 10)).toBe(20);
    expect(snapToGrid(25, 30)).toBe(30);
  });

  it('clamps frame within bounds', () => {
    expect(clampFrame(5, 0, 100)).toBe(5);
    expect(clampFrame(-10, 0, 100)).toBe(0);
    expect(clampFrame(200, 0, 100)).toBe(100);
  });

  it('formats duration', () => {
    expect(formatDuration(30, 30)).toBe('1s');
    expect(formatDuration(150, 30)).toBe('5s');
    expect(formatDuration(1800, 30)).toBe('1m');
    expect(formatDuration(2700, 30)).toBe('1m 30s');
    expect(formatDuration(108000, 30)).toBe('1h');
  });
});
