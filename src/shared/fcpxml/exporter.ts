/**
 * FCPXML export (upstream #154) — project → Final Cut Pro XML 1.11.
 *
 * Scope is deliberately minimal and honest about it: the goal is opening a
 * Palmier timeline in Resolve / FCP / Premiere with picture, audio, title
 * TEXT, opacity, geometry, crop and volume intact. Grades, blend modes and
 * keyframed parameters are NOT represented — matching upstream, whose exporter
 * covers opacity (`adjust-blend`) and geometry (`adjust-transform`) and
 * likewise stops there. Importers treat absence as plain clips rather than
 * failing.
 *
 * Mapping contract (mirrored by the importer):
 *   - lowest visible video track  → spine asset-clips
 *   - higher video tracks         → connected asset-clips, lane = track index
 *   - audio clips                 → connected asset-clips, audioRole=dialogue,
 *                                   negative lanes below the spine
 *   - title clips                 → <title> with per-clip <text-style-def>
 *   - opacity < 1                 → <adjust-blend amount>
 *   - non-identity geometry       → <adjust-transform scale/rotation/position>
 *   - crop                        → <adjust-crop mode="trim"><trim-rect>
 *   - non-unity volume (or mute)  → <adjust-volume amount="…dB">
 *
 * Timing uses decimal seconds ("12.345678s") rather than rationals: project
 * fps can be fractional (29.97), and rational timebases would silently
 * resync every clip. Microsecond precision matches FCP's internal tick.
 */

import type { Project, Clip, MediaAsset } from '../types/project';
import { timecodeToSeconds } from '../media/timecode';
import { aspectFit } from './geometry';

const SEC_PRECISION = 6;

function sec(frames: number, fps: number): string {
  return `${(frames / fps).toFixed(SEC_PRECISION)}s`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeXml(value).replace(/"/g, '&quot;');
}

/** file:// URL for an absolute Windows/POSIX path. */
function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return encodeURI(`file:///${normalized.replace(/^\/+/, '')}`).replace(/#/g, '%23');
}

function assetHasAudio(asset: MediaAsset): boolean {
  if (asset.type === 'audio') return true;
  if (asset.type === 'image') return false;
  return Boolean(asset.audioCodec);
}

function assetHasVideo(asset: MediaAsset): boolean {
  return asset.type === 'video' || asset.type === 'image';
}

/**
 * Upstream's number format (FCPXMLExporter.formatNumber): four decimals with
 * trailing zeros trimmed, integers bare. One shared spelling so exported
 * numbers never drift between elements.
 */
function formatNumber(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  if (rounded === 0) return '0';
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded.toFixed(4)).replace(/0+$/, '').replace(/\.$/, '');
}

/** Linear gain to decibels; silence floors at -96 like upstream. */
function linearToDb(linear: number): number {
  return linear > 0 ? 20 * Math.log10(linear) : -96;
}

/**
 * `<adjust-blend amount>`: linear 0-1 opacity, upstream's 0.9995 threshold.
 * No `mode`: our blend modes have no verified FCPXML integer mapping, and a
 * wrong composite in Resolve is worse than a plain one.
 */
function blendElement(clip: Clip): string {
  if (!(clip.opacity < 0.9995)) return '';
  return `<adjust-blend amount="${formatNumber(Math.max(0, clip.opacity))}"/>`;
}

/**
 * `<adjust-transform>`: FCPXML geometry is center-based — `position` is the
 * anchor point relative to the canvas center in percent of canvas height
 * (+x right, +y up), `scale` a multiplier with 1 = native, `rotation`
 * counter-clockwise degrees, `anchor` a center offset (so "0 0" is centered).
 *
 * Our clips are top-left boxes with clockwise-positive rotation about a pixel
 * anchor, so the mapping folds the anchor in: the position written is where
 * our transformed box center lands. The decode is assumed box-sized (it is
 * requested that way); rotation and scale transfer directly, rotation negated.
 * Anything within upstream's identity epsilons is omitted.
 */
function transformElement(
  clip: Clip,
  canvasW: number,
  canvasH: number,
  fittedW: number,
  fittedH: number,
): string {
  const scaleX = (clip.width * clip.scaleX) / fittedW;
  const scaleY = (clip.height * clip.scaleY) / fittedH;
  const cx = clip.width / 2;
  const cy = clip.height / 2;
  const rad = (clip.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ox = cx - clip.anchorX;
  const oy = cy - clip.anchorY;
  const px = clip.x + clip.anchorX + (ox * cos - oy * sin);
  const py = clip.y + clip.anchorY + (ox * sin + oy * cos);
  const unit = canvasH / 100;
  const posX = (px - canvasW / 2) / unit;
  const posY = (canvasH / 2 - py) / unit;
  const moved = Math.abs(posX) > 0.0005 || Math.abs(posY) > 0.0005;
  const scaled = Math.abs(scaleX - 1) > 0.0005 || Math.abs(scaleY - 1) > 0.0005;
  const rotated = Math.abs(clip.rotation) > 0.005;
  if (!moved && !scaled && !rotated) return '';
  return `<adjust-transform scale="${formatNumber(scaleX)} ${formatNumber(scaleY)}"`
    + (rotated ? ` rotation="${formatNumber(-clip.rotation)}"` : '')
    + ` anchor="0 0" position="${formatNumber(posX)} ${formatNumber(posY)}"/>`;
}

/**
 * `<adjust-crop mode="trim">`: trim-rect units are percent of *frame* height
 * for every edge, so width fractions are aspect-corrected. The crop applies
 * to the source frame, hence source — not canvas — dimensions.
 */
function cropElement(
  clip: Clip,
  frameW: number,
  frameH: number,
): string {
  const crop = clip.crop;
  if (!crop) return '';
  const { left = 0, right = 0, top = 0, bottom = 0 } = crop;
  if (!(left > 0 || right > 0 || top > 0 || bottom > 0)) return '';
  const aspect = frameW > 0 && frameH > 0 ? frameW / frameH : 16 / 9;
  const widthEdge = (frac: number): string => formatNumber((frac * aspect * 100));
  const heightEdge = (frac: number): string => formatNumber(frac * 100);
  return '<adjust-crop mode="trim">'
    + `<trim-rect top="${heightEdge(top)}" right="${widthEdge(right)}"`
    + ` bottom="${heightEdge(bottom)}" left="${widthEdge(left)}"/>`
    + '</adjust-crop>';
}

/**
 * `<adjust-volume amount="…dB">`: upstream's threshold and floor. A muted clip
 * is silence, so it exports at the floor rather than at full volume — there is
 * no per-clip mute flag in FCPXML 1.11.
 */
function volumeElement(clip: Clip): string {
  const effective = clip.muted ? 0 : clip.volume;
  if (!clip.muted && Math.abs(effective - 1) <= 0.0005) return '';
  return `<adjust-volume amount="${formatNumber(linearToDb(effective))}dB"/>`;
}

interface TrackInfo {
  id: string;
  kind: 'video' | 'audio';
  /** Track order for layering (video) or stacking (audio). */
  order: number;
  index: number;
}

function describeTracks(project: Project): TrackInfo[] {
  return project.timeline.tracks.map((track, index) => ({
    id: track.id,
    kind: track.type,
    order: track.order,
    index,
  }));
}

/**
 * Export the supported subset of a project as FCPXML 1.11 text.
 * Throws only when there is nothing representable at all (no clips).
 */
export function exportFcpxml(project: Project): string {
  const fps = project.settings.fps;
  const { width, height } = project.settings;
  const tracks = describeTracks(project);

  const sortedClips = [...project.timeline.clips].sort((a, b) => {
    const ta = tracks.find((t) => t.id === a.trackId);
    const tb = tracks.find((t) => t.id === b.trackId);
    return (ta?.order || 0) - (tb?.order || 0);
  });

  // One <asset> resource per unique file (slash-normalized), first-use order.
  const assetsByPath = new Map<string, { id: number; asset: MediaAsset }>();
  let nextResourceId = 2; // 1 is reserved for the project format

  const resourceIdFor = (clip: Clip): number | null => {
    const asset = project.media.find((m) => m.id === clip.assetId);
    if (!asset) return null;
    const key = asset.path.replace(/\\/g, '/').toLowerCase();
    const existing = assetsByPath.get(key);
    if (existing) return existing.id;
    const id = nextResourceId++;
    assetsByPath.set(key, { id, asset });
    return id;
  };
  for (const clip of sortedClips) void resourceIdFor(clip);

  const assetFor = (clip: Clip): MediaAsset | null =>
    project.media.find((m) => m.id === clip.assetId) ?? null;

  if (sortedClips.length === 0) {
    throw new Error('No clips to export â€” the timeline is empty.');
  }

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE fcpxml>');
  lines.push(
    `<fcpxml version="1.11"><resources><format id="r1" frameDuration="${(1 / fps).toFixed(SEC_PRECISION)}s" width="${width}" height="${height}"/>`,
  );

  // Formats for non-project-sized sources would matter to conforming apps'
  // scaling UI; Palmier composites everything at the project canvas, so a
  // single format is truthful here.
  for (const { id, asset } of assetsByPath.values()) {
    const flags = [
      assetHasVideo(asset) ? 'hasVideo="1"' : null,
      assetHasAudio(asset) ? 'hasAudio="1"' : null,
    ].filter(Boolean).join(' ');
    const durSec = asset.duration > 0 ? `${asset.duration.toFixed(SEC_PRECISION)}s` : '0s';
    const assetAttrs =
      `<asset id="${id}" name="${escapeAttr(asset.filename)}" src="${escapeAttr(fileUrl(asset.path))}"`
      + ` start="0s" duration="${durSec}" ${flags} format="r1"`;
    // A source start timecode (#154) rides a standard <timecode> child, so
    // conforming apps keep the source offset; drop-frame strings cannot be
    // converted exactly and are omitted rather than written wrong.
    const startSeconds = asset.startTimecode
      ? timecodeToSeconds(asset.startTimecode, asset.fps ?? fps)
      : null;
    if (startSeconds === null) {
      lines.push(`${assetAttrs}/>`);
    } else {
      lines.push(`${assetAttrs}>`);
      lines.push(
        `<timecode start="${startSeconds.toFixed(SEC_PRECISION)}s" duration="${durSec}" format="r1"/>`,
      );
      lines.push('</asset>');
    }
  }

  // â”€â”€ Library / event / spine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push(
    `</resources><library><event name="${escapeAttr(project.name || 'Palmier Project')}"><project name="${escapeAttr(project.name || 'Palmier Project')}">`,
  );

  const bodyLines: string[] = [];
  const videoTrackIds = tracks.filter((t) => t.kind === 'video');
  const spineTrackId = videoTrackIds.length > 0
    ? videoTrackIds.reduce((low, t) => (t.order < low.order ? t : low)).id
    : null;
  const audioTracks = tracks.filter((t) => t.kind === 'audio');

  let styleSeq = 0;
  const styleDefs: string[] = [];

  for (const clip of sortedClips) {
    const track = tracks.find((t) => t.id === clip.trackId);
    const offset = sec(clip.startFrame, fps);
    const duration = sec(clip.durationFrames, fps);
    const sourceIn = sec(clip.inPoint, fps);

    // Titles are Palmier-native and carry no media resource; they must be
    // handled before the resource lookup, which would otherwise skip them.
    if (clip.type === 'title') {
      styleSeq += 1;
      const styleId = `ts${styleSeq}`;
      const sizePx = Math.round((clip.titleSizeRatio ?? 0.09) * height);
      const fontColor = (clip.titleColor ?? '#ffffff').toUpperCase();
      const fontFamily = clip.titleFontFamily ?? 'sans-serif';
      const align = clip.titleAlign ?? 'center';
      const text = applyCase(clip.text ?? '', clip.titleFontCase);

      styleDefs.push(
        `<text-style-def id="${styleId}"><text-style font="${escapeAttr(fontFamily)}"`
        + ` fontSize="${sizePx}" fontColor="${fontColor}" alignment="${align.toUpperCase()}"/>`
        + `</text-style-def>`,
      );
      bodyLines.push(
        `<title name="${escapeAttr(text.slice(0, 60))}" lane="0" offset="${offset}"`
        + ` duration="${duration}" ref="${styleId}" start="${sourceIn}">`
        + `<text><text-style ref="${styleId}">${escapeXml(text)}</text-style></text>`
        + `</title>`,
      );
      continue;
    }

    const resourceId = resourceIdFor(clip);
    if (!resourceId) continue;

    if (clip.type === 'audio' || track?.kind === 'audio') {
      const audioLane = -(1 + Math.max(0, audioTracks.findIndex((t) => t.id === clip.trackId)));
      const adjust = volumeElement(clip);
      const open =
        `<asset-clip name="${escapeAttr(clip.label || 'Audio')}" lane="${audioLane}"`
        + ` offset="${offset}" duration="${duration}" start="${sourceIn}"`
        + ` ref="${resourceId}" audioRole="dialogue"`;
      bodyLines.push(adjust.length > 0 ? `${open}>${adjust}</asset-clip>` : `${open}/>`);
      continue;
    }

    // Visual clip on the spine track vs a connected upper track. Lanes are
    // dense among upper tracks (1..N) so FCP stacks them in track order.
    // Opacity, geometry, crop and volume ride adjust children; identity values
    // are omitted so a plain clip stays a one-line element.
    const onSpine = clip.trackId === spineTrackId;
    let laneAttr = '';
    if (!onSpine) {
      const upperRank = videoTrackIds
        .filter((t) => t.id !== spineTrackId)
        .sort((a, b) => a.order - b.order)
        .findIndex((t) => t.id === clip.trackId);
      laneAttr = ` lane="${Math.max(0, upperRank) + 1}"`;
    }
    const asset = assetFor(clip);
    const fitted = aspectFit(asset?.width ?? 0, asset?.height ?? 0, width, height);
    const adjust =
      blendElement(clip)
      + transformElement(clip, width, height, fitted.w, fitted.h)
      + cropElement(clip, asset?.width ?? width, asset?.height ?? height)
      + volumeElement(clip);
    const open =
      `<asset-clip name="${escapeAttr(clip.label || 'Clip')}"${laneAttr}`
      + ` offset="${offset}" duration="${duration}" start="${sourceIn}"`
      + ` ref="${resourceId}"`;
    bodyLines.push(adjust.length > 0 ? `${open}>${adjust}</asset-clip>` : `${open}/>`);
  }

  lines.push(`<spine>${bodyLines.join('')}</spine></project></event></library>`);
  for (const def of styleDefs.reverse()) lines.push(def);
  lines.push('</fcpxml>');

  return lines.join('');
}

/** Case transform mirroring the render paths (#330). */
function applyCase(text: string, mode?: 'original' | 'upper' | 'lower'): string {
  if (mode === 'upper') return text.toUpperCase();
  if (mode === 'lower') return text.toLowerCase();
  return text;
}

