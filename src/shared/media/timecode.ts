/**
 * SMPTE source-timecode helpers (upstream #154's source-timecode columns).
 *
 * Sources carry their own start timecode in container tags (QuickTime/MXF),
 * which conform workflows need for sync and FCPXML interchange. The port
 * stores the tag verbatim on the asset and converts it for interchange.
 *
 * Colon-separated timecode (`01:00:00:00`) is converted with the nominal
 * frame rate. Semicolon-separated timecode (`01:00:00;00`) marks drop-frame
 * counting, whose conversion needs the 29.97/59.94 drop rules; rather than
 * write a wrong number, those strings are stored but refuse conversion and
 * are omitted from interchange.
 */

const SMPTE_PATTERN = /^\d{2,}:[0-5]\d:[0-5]\d[:;]\d{2,}$/;

/** True when the string is a syntactically valid SMPTE timecode. */
export function isValidSmpteTimecode(value: unknown): value is string {
  return typeof value === 'string' && SMPTE_PATTERN.test(value);
}

/**
 * Convert `HH:MM:SS:FF` to seconds at `fps`, or null when the value is not a
 * colon-separated timecode, the frame field exceeds the nominal rate, or the
 * rate itself is unusable.
 */
export function timecodeToSeconds(timecode: string, fps: number): number | null {
  if (!isValidSmpteTimecode(timecode)) return null;
  if (!Number.isFinite(fps) || fps <= 0) return null;
  const [hours, minutes, seconds, frames] = timecode.split(/[:;]/).map(Number);
  const rate = Math.round(fps);
  if (frames >= rate) return null;
  // Drop-frame strings are stored but not converted (see module note); the
  // separator check happens after the pattern guarantees four fields.
  if (timecode.includes(';')) return null;
  return hours * 3600 + minutes * 60 + seconds + frames / rate;
}

/**
 * First usable timecode among the probe's tag dictionaries: the video
 * stream's own tag wins over the container's, matching how ffprobe reports
 * QuickTime files where both are present.
 */
export function pickTimecodeFromTags(
  ...tagSets: Array<Record<string, string> | undefined>
): string | undefined {
  for (const tags of tagSets) {
    const value = tags?.['timecode'];
    if (isValidSmpteTimecode(value)) return value;
  }
  return undefined;
}

/**
 * Seconds to `HH:MM:SS:FF` at `fps`, rounding to the nearest frame. Used to
 * rebuild a source timecode when importing an FCPXML `<timecode>` element,
 * whose only representation is a time value.
 */
export function secondsToTimecode(seconds: number, fps: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (!Number.isFinite(fps) || fps <= 0) return null;
  const rate = Math.round(fps);
  const totalFrames = Math.round(seconds * rate);
  const frames = totalFrames % rate;
  const totalSeconds = Math.floor(totalFrames / rate);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}:${pad(frames)}`;
}
