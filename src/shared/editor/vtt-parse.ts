/**
 * WebVTT subtitle parsing (roadmap R3).
 *
 * Complements the SRT parser: VTT has a `WEBVTT` header line, dot-millisecond
 * timecodes, optional cue identifiers before the timecode line, and optional
 * styling/settings lines after it. Cues with malformed windows are skipped.
 */

export interface VttCue {
  startSec: number;
  endSec: number;
  text: string;
}

/** `HH:MM:SS.mmm` → seconds. Returns null when malformed. */
function parseVttTimecode(raw: string): number | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})\.(\d{3})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
}

/**
 * Parse a WebVTT document into cues, sorted by start time.
 * Skips the header, NOTE blocks, and STYLE/REGION definitions.
 */
export function parseVtt(content: string): VttCue[] {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues: VttCue[] = [];

  for (const block of blocks) {
    if (block.startsWith('WEBVTT') || block.startsWith('NOTE') || block.startsWith('STYLE') || block.startsWith('REGION')) {
      continue;
    }

    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    // Find the timecode line (contains ' --> ')
    const tcLine = lines.findIndex((l) => l.includes('-->'));
    if (tcLine === -1) continue;

    // Timecode line may be preceded by an optional cue identifier
    const [rawStart, rawEnd] = lines[tcLine].split('-->').map((s) => s.trim());
    if (!rawStart || !rawEnd) continue;
    const startSec = parseVttTimecode(rawStart);
    const endSec = parseVttTimecode(rawEnd);
    if (startSec === null || endSec === null || endSec <= startSec) continue;

    const body = lines.slice(tcLine + 1).join('\n').trim();
    if (!body) continue;

    cues.push({ startSec, endSec, text: body });
  }
  return cues.sort((a, b) => a.startSec - b.startSec);
}
