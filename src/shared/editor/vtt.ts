/**
 * WebVTT sidecar serialization (roadmap R3).
 *
 * Captions live as title clips; this renders them back out as a `.vtt`
 * sidecar next to an exported video. VTT differs from SRT in the header
 * line, dot-millisecond timecodes, and no numeric cue ids -- everything
 * else matches closely enough that parseSrt can re-read our output minus
 * the header.
 */

export interface VttCue {
  startSec: number;
  endSec: number;
  text: string;
}

/** Seconds → `HH:MM:SS.mmm`. */
export function toVttTimecode(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const totalMs = Math.round(clamped * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return (
    `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:`
    + `${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
  );
}

/**
 * Serialize cues into a complete WebVTT document, sorted by start time.
 * Cues are sanitized minimally here: blank text is dropped and control
 * characters other than newlines/tabs are removed, matching what the title
 * sanitizer would have allowed onto the clip in the first place.
 */
export function buildVtt(cues: readonly VttCue[]): string {
  const usable = cues
    .filter((cue) => cue.endSec > cue.startSec && cue.text.trim().length > 0)
    .sort((a, b) => a.startSec - b.startSec || (a.text < b.text ? -1 : 1));

  const blocks = usable.map((cue) => {
    const body = cue.text
      .split('\n')
      .map((line) =>
        [...line]
          .filter((ch) => {
            const code = ch.codePointAt(0) ?? 0;
            return code === 0x09 || code >= 0x20;
          })
          .join(''),
      )
      .join('\n');
    return `${toVttTimecode(cue.startSec)} --> ${toVttTimecode(cue.endSec)}\n${body}`;
  });

  return ['WEBVTT', '', ...blocks.join('\n\n').split('\n')].join('\n') + '\n';
}
