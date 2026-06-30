/**
 * Frame-based time utilities.
 * All internal time representation is integer frames. These helpers
 * convert to/from display formats (timecode, seconds).
 */

import type { Frame } from '../types/project';

/**
 * Convert frame number to SMPTE timecode string (HH:MM:SS:FF).
 */
export function frameToTimecode(frame: Frame, fps: number): string {
  if (fps <= 0) return '00:00:00:00';

  const totalSeconds = Math.floor(frame / fps);
  const remainingFrames = frame % fps;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
    String(remainingFrames).padStart(2, '0'),
  ].join(':');
}

/**
 * Parse SMPTE timecode (HH:MM:SS:FF) to frame number.
 */
export function timecodeToFrame(timecode: string, fps: number): Frame {
  const parts = timecode.split(':').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return 0;

  const [hours, minutes, seconds, frames] = parts;
  return (hours * 3600 + minutes * 60 + seconds) * fps + frames;
}

/**
 * Convert seconds to frame number.
 */
export function secondsToFrame(seconds: number, fps: number): Frame {
  return Math.round(seconds * fps);
}

/**
 * Convert frame number to seconds.
 */
export function frameToSeconds(frame: Frame, fps: number): number {
  if (fps <= 0) return 0;
  return frame / fps;
}

/**
 * Snap a frame to the nearest grid interval.
 */
export function snapToGrid(frame: Frame, gridInterval: Frame): Frame {
  if (gridInterval <= 0) return frame;
  return Math.round(frame / gridInterval) * gridInterval;
}

/**
 * Clamp a frame within bounds.
 */
export function clampFrame(frame: Frame, min: Frame, max: Frame): Frame {
  return Math.max(min, Math.min(max, frame));
}

/**
 * Format duration as human-readable string (e.g., "1m 23s" or "2h 10m").
 */
export function formatDuration(frames: Frame, fps: number): string {
  const totalSeconds = Math.floor(frames / fps);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
