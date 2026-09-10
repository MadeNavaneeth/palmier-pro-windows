/**
 * Parse a marker editor time field: plain frames (`250`) or SMPTE timecode
 * (`HH:MM:SS:FF`). Returns null when the text is unusable, so the editor can
 * refuse it with a message instead of writing frame 0.
 *
 * Plain frames exist because a four-part timecode is a clumsy way to type a
 * small nudge; the timecode form matches the ruler labels. Range checks
 * mirror SMPTE: minutes and seconds below 60, frames below the project rate.
 */

export function parseMarkerFrameInput(text: string, fps: number): number | null {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) {
    const frames = Number(trimmed);
    return Number.isSafeInteger(frames) ? frames : null;
  }
  const parts = trimmed.split(':');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const [hours, minutes, seconds, frames] = parts.map(Number);
  if (minutes >= 60 || seconds >= 60) return null;
  if (fps <= 0 || frames >= Math.max(1, Math.round(fps))) return null;
  return (hours * 3600 + minutes * 60 + seconds) * Math.round(fps) + frames;
}
