/**
 * FCPXML import (#154) â€” parse Final Cut Pro XML into a structured plan.
 *
 * Phase 2a: pure parser, no Electron, no editor mutation. Callers (executor /
 * future dialog) receive assets by absolute path plus clips keyed to lane
 * numbers they can materialize onto real tracks.
 *
 * Supported: <format> timing, <asset> resources, spine asset-clips and
 * connected asset-clips (lane attr), titles with inline text-style refs,
 * decimal ("1.5s") and rational ("45/30s") times. Gaps are implicit —
 * absolute clip offsets already encode spacing. Everything else — effects,
 * groups, references — lands in `unsupported` as readable notes so
 * nothing disappears silently.
 */

export interface ImportedAsset {
  /** Resource id as referenced by clips (e.g. "4"). */
  ref: string;
  /** Absolute filesystem path from the file:// src. */
  path: string;
  hasVideo: boolean;
  hasAudio: boolean;
  durationSec: number;
}

export interface ImportedVideoClip {
  kind: 'video';
  /** Lane 0 = spine, â‰¥1 = connected above in ascending order. */
  lane: number;
  startFrame: number;
  durationFrames: number;
  sourceInFrame: number;
  assetPath: string;
  label: string;
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

/**
 * Turn a `file://` src back into a filesystem path.
 *
 * `file:///C:/media/a.mp4` puts a Windows drive letter where the authority
 * would be, so the slash after the empty host is not part of the path and has
 * to go. `file:///media/a.mp4` is a POSIX root, where that same slash is the
 * root itself and has to stay — dropping it turns an absolute path into a
 * relative one, which reads as "media is missing" on import.
 */
export function fileUrlToPath(src: string): string {
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch { /* keep raw */ }
  if (!decoded.startsWith('file://')) return decoded;

  const rest = decoded.slice('file://'.length);
  if (/^\/[A-Za-z]:[\\/]/.test(rest)) return rest.slice(1);
  // `file://host/share` names a network share; keep the host as the root.
  return rest.startsWith('/') ? rest : `/${rest}`;
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
    assets.push({
      ref,
      path: fileUrlToPath(src),
      hasVideo: attr(tag, 'hasVideo') === '1',
      hasAudio: attr(tag, 'hasAudio') === '1',
      durationSec: parseFcpxmlTime(attr(tag, 'duration') ?? '') ?? 0,
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
  for (const match of innerXml.matchAll(openRe)) {
    const kind = match[1];
    const selfClosed = match[3] === '/';
    let tag = match[0];
    if (!selfClosed) {
      const closeTag = `</${kind}>`;
      const closeIdx = innerXml.indexOf(closeTag, openRe.lastIndex);
      if (closeIdx !== -1) tag = innerXml.slice(match.index, closeIdx + closeTag.length);
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
        clips.push({ kind: 'audio', ...base, assetPath: asset.path, label });
      } else {
        clips.push({ kind: 'video', ...base, assetPath: asset.path, label });
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
  for (const construct of ['<effect-ref', '<filter-video', '<filter-audio', '<note>', '<chapter-marker']) {
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




