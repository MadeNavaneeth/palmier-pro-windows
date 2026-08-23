/**
 * SRT subtitle parsing (roadmap R3).
 *
 * Accepts the practical dialect: optional numeric cue ids, `HH:MM:SS,mmm`
 * or `HH:MM:SS.mmm` timecodes, CRLF or LF line endings, UTF-8 BOM, and
 * multi-line cue text joined with newlines. Anything malformed skips that
 * cue rather than failing the whole import.
 */

export interface SrtCue {
  startSec: number;
  endSec: number;
  /** Cue text, multi-line cues joined with '\n'. */
  text: string;
}

/** `HH:MM:SS,mmm` | `MM:SS.mmm` | `H:MM:SS.mmm` … → seconds. Null when malformed. */
export function parseSrtTimecode(raw: string): number | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  const [, h, min, sec, ms] = m;
  const hours = parseInt(h, 10);
  const minutes = parseInt(min, 10);
  const seconds = parseInt(sec, 10);
  const millis = parseInt(ms.padEnd(3, '0'), 10);
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/**
 * Parse an SRT document into cues, sorted by start time. Cues whose
 * timecode line or window is malformed are skipped silently -- partial
 * imports beat failed imports for subtitle files.
 */
export function parseSrt(content: string): SrtCue[] {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues: SrtCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    // Drop a leading numeric id line when present.
    if (/^\d+$/.test(lines[0].trim()) && lines.length > 1) lines.shift();

    const tcLine = lines.findIndex((l) => l.includes('-->'));
    if (tcLine === -1) continue;

    const [rawStart, rawEnd] = lines[tcLine].split('-->');
    if (!rawStart || !rawEnd) continue;
    const startSec = parseSrtTimecode(rawStart);
    let endSec = parseSrtTimecode(rawEnd);
    if (startSec === null || endSec === null || endSec <= startSec) continue;

    const body = lines
      .slice(tcLine + 1)
      .join('\n')
      // Strip basic HTML-ish tags some SRTs carry (<i>, <b>, <font ...>).
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
      .trim();
    if (body.length === 0) continue;

    cues.push({ startSec, endSec, text: body });
  }

  return cues.sort((a, b) => a.startSec - b.startSec);
}
