/**
 * FCPXML import (#154) — parse Final Cut Pro XML into a structured plan.
 *
 * Phase 2a: pure parser, no Electron, no editor mutation. Callers (executor /
 * future dialog) receive assets by absolute path plus clips keyed to lane
 * numbers they can materialize onto real tracks.
 *
 * Supported: <format> timing, <asset> resources, spine asset-clips and
 * connected asset-clips (lane attr), titles with inline text-style refs,
 * decimal ("1.5s") and rational ("45/30s") times, opacity (`adjust-blend`),
 * geometry (`adjust-transform`), crop (`adjust-crop` trim-rect) and volume
 * (`adjust-volume`) as the exporter writes them — plus the same elements from
 * third-party files, narrowed on read. Gaps are implicit —
 * absolute clip offsets already encode spacing. Everything else — grades,
 * blend modes, keyframed parameters, groups, references — lands in
 * `unsupported` as readable notes so nothing disappears silently.
 */

import { secondsToTimecode } from '../media/timecode';

export interface ImportedAsset {
  /** Resource id as referenced by clips (e.g. "4"). */
  ref: string;
  /** Absolute filesystem path from the file:// src. */
  path: string;
  hasVideo: boolean;
  hasAudio: boolean;
  durationSec: number;
  /**
   * Source start timecode rebuilt from the asset's `<timecode>` child
   * (#154), in the project's frame rate. Absent when the XML carries none.
   */
  startTimecode?: string;
}

export interface ImportedVideoClip {
  kind: 'video';
  /** Lane 0 = spine, ≥1 = connected above in ascending order. */
  lane: number;
  startFrame: number;
  durationFrames: number;
  sourceInFrame: number;
  assetPath: string;
  label: string;
  /** Linear 0-1 opacity from <adjust-blend>; absent means opaque. */
  opacity?: number;
  /** Linear gain from <adjust-volume>; absent means unity. */
  volume?: number;
  /** Silence has no per-clip flag in FCPXML; ≤-90dB arrives muted. */
  muted?: boolean;
  /** Source fractions from <adjust-crop> trim-rect (see geometry). */
  cropTrim?: { left: number; top: number; right: number; bottom: number };
  /** FCPXML-native geometry (see geometry.placementFromTransform). */
  transform?: { positionX: number; positionY: number; scaleX: number; scaleY: number; rotation: number };
}

export interface ImportedAudioClip {
  kind: 'audio';
  /** Negative: -1 is the first lane below the spine. */
  lane: number;
  startFrame: number;
  durationFrames: number;
  sourceInFrame: number;
  assetPath: string;
  label: string;
  /** Linear gain from <adjust-volume>; absent means unity. */
  volume?: number;
  /** Silence has no per-clip flag in FCPXML; ≤-90dB arrives muted. */
  muted?: boolean;
}

export interface ImportedTitle {
  kind: 'title';
  lane: number;
  startFrame: number;
  durationFrames: number;
  text: string;
  fontFamily?: string;
  fontSizePx?: number;
  colorHex?: string;
  alignment?: 'left' | 'center' | 'right';
}

export type ImportedClip =
  | ImportedVideoClip
  | ImportedAudioClip
  | ImportedTitle;

export interface ParsedFcpxml {
  name: string;
  /** Rounded from <format frameDuration>; null when absent/non-integer. */
  fps: number | null;
  width: number;
  height: number;
  assets: ImportedAsset[];
  clips: ImportedClip[];
  /** Readable notes for constructs present but not representable here. */
  unsupported: string[];
}

/** Parse "1.500000s" or "45/30s" (or bare "1.5") into seconds. */
export function parseFcpxmlTime(value: string): number | null {
  const trimmed = value.trim();
  const rational = trimmed.match(/^(-?\d+)\/(\d+(?:\.\d+)?)s$/);
  if (rational) {
    const den = Number(rational[2]);
    return den > 0 ? Number(rational[1]) / den : null;
  }
  const decimal = trimmed.match(/^(-?\d+(?:\.\d+)?)s$/);
  if (decimal) return Number(decimal[1]);
  const bare = Number(trimmed);
  return Number.isFinite(bare) ? bare : null;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function numAttr(tag: string, name: string): number | null {
  const raw = attr(tag, name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function fileUrlToPath(src: string): string {
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch { /* keep raw */ }
  return decoded.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '/');
}

/** "sx sy" pair, e.g. adjust-transform scale/position. */
function parsePair(value: string | null): [number, number] | null {
  if (value === null) return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return Number.isFinite(first) && Number.isFinite(second) ? [first, second] : null;
}

/** "−6.0206dB" (suffix optional) to decibels. */
function parseDbAmount(value: string | null): number | null {
  if (value === null) return null;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(dB)?$/);
  if (!match) return null;
  const db = Number(match[1]);
  return Number.isFinite(db) ? db : null;
}

/** Linear 0-1 opacity from <adjust-blend>; undefined when absent/unusable. */
function blendOf(tag: string): number | undefined {
  const match = tag.match(/<adjust-blend\b[^>]*amount="([^"]*)"/);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function transformOf(tag: string): ImportedVideoClip['transform'] {
  const match = tag.match(/<adjust-transform\b[^>]*>/);
  if (!match) return undefined;
  const scale = parsePair(attr(match[0], 'scale')) ?? [1, 1];
  const rotation = numAttr(match[0], 'rotation') ?? 0;
  const position = parsePair(attr(match[0], 'position')) ?? [0, 0];
  if (scale[0] === 1 && scale[1] === 1 && rotation === 0 && position[0] === 0 && position[1] === 0) {
    return undefined;
  }
  return {
    positionX: position[0],
    positionY: position[1],
    scaleX: scale[0],
    scaleY: scale[1],
    rotation,
  };
}

function cropTrimOf(tag: string): ImportedVideoClip['cropTrim'] {
  const match = tag.match(/<adjust-crop\b[^>]*>[\s\S]*?<trim-rect\b[^>]*>/);
  if (!match) return undefined;
  const rect = match[0].slice(match[0].indexOf('<trim-rect'));
  const read = (name: string): number => numAttr(rect, name) ?? 0;
  const trim = { left: read('left'), top: read('top'), right: read('right'), bottom: read('bottom') };
  if (!(trim.left > 0 || trim.right > 0 || trim.top > 0 || trim.bottom > 0)) return undefined;
  return trim;
}

/**
 * Volume from <adjust-volume>: decibels to linear gain. At or below −90dB the
 * clip arrives muted — FCPXML has no per-clip mute flag, and that floor is
 * inaudible either way. Unity gain carries nothing, keeping plans clean.
 */
function volumeOf(tag: string): { volume: number; muted: boolean } | undefined {
  const match = tag.match(/<adjust-volume\b[^>]*amount="([^"]*)"/);
  if (!match) return undefined;
  const db = parseDbAmount(match[1]);
  if (db === null) return undefined;
  if (db <= -90) return { volume: 0, muted: true };
  const linear = Math.pow(10, db / 20);
  if (Math.abs(linear - 1) <= 0.0005) return undefined;
  return { volume: Math.min(1, Math.max(0, linear)), muted: false };
}

function extractTagBlock(xml: string, tagName: string): string[] {
  // Non-greedy up to the closing tag; our supported elements never nest
  // themselves, and <title>'s inner <text> tags don't collide with its name.
  const re = new RegExp(`<${tagName}\\b[^>]*(?:/>|>[\\s\\S]*?</${tagName}>)`, 'g');
  return xml.match(re) ?? [];
}

const TITLE_STYLE_RE = /<text-style-def\b[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/text-style-def>/g;

function titleStyleOf(defBody: string): {
  fontFamily?: string;
  fontSizePx?: number;
  colorHex?: string;
  alignment?: 'left' | 'center' | 'right';
} {
  const styleTag = defBody.match(/<text-style\b[^>]*/)?.[0] ?? '';
  return {
    fontFamily: attr(styleTag, 'font') ?? undefined,
    fontSizePx: numAttr(styleTag, 'fontSize') ?? undefined,
    colorHex: attr(styleTag, 'fontColor')?.toUpperCase() ?? undefined,
    alignment: (attr(styleTag, 'alignment')?.toLowerCase() as 'left' | 'center' | 'right' | undefined)
      ?? undefined,
  };
}

export function parseFcpxml(xml: string): ParsedFcpxml {
  const unsupported: string[] = [];

  // â”€â”€ Project canvas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const formatTag = extractTagBlock(xml, 'format')[0] ?? '';
  const frameDuration = attr(formatTag, 'frameDuration');
  const frameDurationSec = frameDuration ? parseFcpxmlTime(frameDuration) : null;
  let fps: number | null = null;
  if (frameDurationSec && frameDurationSec > 0) {
    const exact = 1 / frameDurationSec;
    const rounded = Math.round(exact);
    fps = Math.abs(exact - rounded) < 0.01 ? rounded : Math.round(exact * 1000) / 1000;
  }
  const width = numAttr(formatTag, 'width') ?? 1920;
  const height = numAttr(formatTag, 'height') ?? 1080;

  const eventName = attr(extractTagBlock(xml, 'event')[0] ?? '', 'name');

  // â”€â”€ Assets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const assets: ImportedAsset[] = [];
  for (const tag of extractTagBlock(xml, 'asset')) {
    const ref = attr(tag, 'id');
    const src = attr(tag, 'src');
    if (!ref || !src) continue;
    // A <timecode> child carries the source start offset; rebuild the SMPTE
    // string at the project rate so the asset round-trips through export.
    const timecodeTag = tag.match(/<timecode\b[^>]*/)?.[0] ?? '';
    const startSeconds = timecodeTag
      ? parseFcpxmlTime(attr(timecodeTag, 'start') ?? '')
      : null;
    const startTimecode = startSeconds !== null && fps
      ? secondsToTimecode(startSeconds, fps) ?? undefined
      : undefined;
    assets.push({
      ref,
      path: fileUrlToPath(src),
      hasVideo: attr(tag, 'hasVideo') === '1',
      hasAudio: attr(tag, 'hasAudio') === '1',
      durationSec: parseFcpxmlTime(attr(tag, 'duration') ?? '') ?? 0,
      ...(startTimecode ? { startTimecode } : {}),
    });
  }
  const assetByRef = new Map(assets.map((a) => [a.ref, a]));

  // â”€â”€ Title styles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const stylesById = new Map<string, ReturnType<typeof titleStyleOf>>();
  for (const match of xml.matchAll(TITLE_STYLE_RE)) {
    stylesById.set(match[1], titleStyleOf(match[2]));
  }

  // â”€â”€ Spine children â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const spineXml = extractTagBlock(xml, 'spine')[0] ?? '';
  const clips: ImportedClip[] = [];
  const fpsForFrames = fps;

  // Titles carry a body (<text>â€¦), so scan opening tags and consume through
  // each element's closing tag rather than matching self-contained tokens.
  // Skip the outer spine's own opening tag so it is not mistaken for nested.
  const innerXml = spineXml.slice(spineXml.indexOf('>') + 1);
  const openRe = /<(asset-clip|title|gap|spine)\b([^>]*?)(\/?)>/g;
  // Explicit exec loop, not matchAll: matchAll clones the regex, so reading
  // lastIndex inside the loop would always see 0 and every non-self-closed
  // element after the first would consume from the document start instead of
  // from its own opening tag.
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(innerXml)) !== null) {
    const kind = match[1];
    const selfClosed = match[3] === '/';
    let tag = match[0];
    if (!selfClosed) {
      const closeTag = `</${kind}>`;
      const closeIdx = innerXml.indexOf(closeTag, openRe.lastIndex);
      if (closeIdx !== -1) {
        tag = innerXml.slice(match.index, closeIdx + closeTag.length);
        // Continue after the consumed element so a nested lookalike cannot
        // resync the scan into the middle of this element's children.
        openRe.lastIndex = closeIdx + closeTag.length;
      }
    }

    if (kind === 'gap') continue; // absolute clip offsets already encode spacing

    const offset = parseFcpxmlTime(attr(tag, 'offset') ?? '');
    const duration = parseFcpxmlTime(attr(tag, 'duration') ?? '');
    if (offset === null || duration === null || !fpsForFrames) continue;

    const lane = numAttr(tag, 'lane') ?? 0;
    const startSec = parseFcpxmlTime(attr(tag, 'start') ?? '') ?? 0;
    const label = attr(tag, 'name') ?? '';

    if (kind === 'asset-clip') {
      const ref = attr(tag, 'ref');
      const asset = ref ? assetByRef.get(ref) : undefined;
      if (!asset) {
        unsupported.push(`Asset-clip "${label}" references unknown resource ${ref ?? '(none)'}.`);
        continue;
      }
      const base = {
        lane,
        startFrame: Math.round(offset * fpsForFrames),
        durationFrames: Math.max(1, Math.round(duration * fpsForFrames)),
        sourceInFrame: Math.round(startSec * fpsForFrames),
      };
      if (asset.hasAudio && !asset.hasVideo) {
        clips.push({ kind: 'audio', ...base, assetPath: asset.path, label, ...volumeOf(tag) });
      } else {
        const opacity = blendOf(tag);
        const cropTrim = cropTrimOf(tag);
        const transform = transformOf(tag);
        clips.push({
          kind: 'video',
          ...base,
          assetPath: asset.path,
          label,
          ...(opacity !== undefined ? { opacity } : {}),
          ...volumeOf(tag),
          ...(cropTrim ? { cropTrim } : {}),
          ...(transform ? { transform } : {}),
        });
      }
      if (tag.includes('<keyframeAnimation')) {
        unsupported.push(`Asset-clip "${label}" animates a parameter; the base value is kept, keyframes are not.`);
      }
      continue;
    }

    if (kind === 'title') {
      const styleRef = attr(tag, 'ref') ?? '';
      const style = stylesById.get(styleRef);
      const text = tag.match(/<text-style[^>]*>([\s\S]*?)<\/text-style>/)?.[1]
        ?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        ?? '';
      clips.push({
        kind: 'title',
        lane,
        startFrame: Math.round(offset * fpsForFrames),
        durationFrames: Math.max(1, Math.round(duration * fpsForFrames)),
        text,
        ...style,
      });
      continue;
    }

    unsupported.push('Nested spines are flattened without their group transforms.');
  }

  // Nested <role>, <marker>, effect refs etc. anywhere in the doc.
  // <effect> children (color effects, third-party filters) have no
  // representation here; grades and blend modes land here too.
  for (const construct of ['<effect-ref', '<effect ', '<filter-video', '<filter-audio', '<note>', '<chapter-marker']) {
    if (xml.includes(construct)) {
      unsupported.push(`${construct.replace(/[<>=]/g, '')} elements are skipped.`);
    }
  }

  if (!fpsForFrames) {
    unsupported.push('No integer-capable <format frameDuration>; frame numbers are approximated.');
  }

  return {
    name: eventName ?? 'Imported Project',
    fps: fpsForFrames,
    width,
    height,
    assets,
    clips,
    unsupported,
  };
}




